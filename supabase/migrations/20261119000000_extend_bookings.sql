-- Extend a court booking by one or more hours.
--  * Staff (admins) can extend any confirmed booking when the next hours are free,
--    marking the extra time as paid or "not paid yet".
--  * A customer can ask for an extension from My Bookings; staff approve or decline it.
--  * Safari cannot create WebP, so the photos bucket also accepts JPEG.

update storage.buckets set allowed_mime_types = array['image/webp', 'image/jpeg'] where id = 'photos';

alter table public.reservations
  add column if not exists extra_minutes          int not null default 0,
  add column if not exists extra_amount           numeric(10, 2) not null default 0,
  add column if not exists extra_unpaid           numeric(10, 2) not null default 0,
  add column if not exists extend_request_minutes int,
  add column if not exists extend_requested_at    timestamptz;
create index if not exists reservations_extend_req_idx on public.reservations (extend_requested_at) where extend_request_minutes is not null;

-- Validates an extension and returns the new end time. Raises a "CODE: message" error when it cannot be done.
create or replace function public._extension_end(v_row public.reservations, p_minutes int)
returns timestamptz language plpgsql stable security definer set search_path = public as $$
declare
  v_set public.settings; v_new timestamptz; v_total int; v_bdate date; v_k public.closures; v_win tstzrange; v_court public.courts;
begin
  select * into v_set from public.settings where id;
  if v_row.kind = 'block' or v_row.status <> 'confirmed' then
    raise exception 'NOT_ALLOWED: Only a confirmed booking can be extended.';
  end if;
  if p_minutes is null or p_minutes < v_set.slot_minutes or p_minutes > 240 or p_minutes % v_set.slot_minutes <> 0 then
    raise exception 'INVALID_DURATION: Extend by whole hours, up to 4 hours at a time.';
  end if;
  v_new := v_row.ends_at + make_interval(mins => p_minutes);
  if v_new <= now() then raise exception 'NOT_ALLOWED: This booking has already finished.'; end if;
  v_total := (extract(epoch from (v_new - v_row.starts_at)) / 60)::int;
  v_bdate := public._business_date(v_row.court_id, v_row.starts_at, v_total, v_set.slot_minutes);
  if v_bdate is null then raise exception 'OUTSIDE_HOURS: The court closes before the extra time ends.'; end if;
  perform public._expire_payment_holds(v_row.court_id, v_row.ends_at, v_new);
  if exists (select 1 from public.reservations r
              where r.court_id = v_row.court_id and r.id <> v_row.id and r.status in ('pending', 'confirmed')
                and r.starts_at < v_new and r.ends_at > v_row.ends_at) then
    raise exception 'SLOT_TAKEN: The next hour is already booked on this court.';
  end if;
  for v_k in select * from public.closures k
              where v_bdate between k.starts_on and k.ends_on and k.start_time is not null
                and (k.court_ids is null or v_row.court_id = any (k.court_ids)) loop
    v_win := public._closure_window(v_k, v_row.court_id, v_bdate);
    if v_win && tstzrange(v_row.ends_at, v_new) then
      select * into v_court from public.courts where id = v_row.court_id;
      raise exception 'CLOSED: % is reserved for % at that time.', v_court.name, v_k.title;
    end if;
  end loop;
  return v_new;
end $$;

-- Staff: extend now. p_paid = false records the extra amount as still to be collected.
create or replace function public.admin_extend_reservation(p_id uuid, p_minutes int, p_paid boolean default true)
returns public.reservations language plpgsql security definer set search_path = public as $$
declare v_row public.reservations; v_new timestamptz; v_price numeric; v_diff numeric; v_set public.settings; v_pts numeric;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  select * into v_row from public.reservations where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Booking not found.'; end if;
  v_new := public._extension_end(v_row, p_minutes);
  v_price := public._price(v_row.court_id, v_row.starts_at, v_new);
  v_diff := greatest(0, coalesce(v_price, v_row.amount, 0) - coalesce(v_row.amount, 0));
  update public.reservations
     set ends_at = v_new, amount = coalesce(v_price, amount),
         extra_minutes = extra_minutes + p_minutes, extra_amount = extra_amount + v_diff,
         extra_unpaid = extra_unpaid + case when p_paid then 0 else v_diff end,
         extend_request_minutes = null, extend_requested_at = null
   where id = p_id returning * into v_row;
  -- loyalty points follow the new length
  select * into v_set from public.settings where id;
  if v_row.user_id is not null and v_row.kind = 'online' and v_set.rewards_enabled and v_set.points_court_hours > 0 then
    v_pts := round((extract(epoch from (v_row.ends_at - v_row.starts_at)) / 3600.0) / v_set.points_court_hours, 2);
    update public.points_ledger set points = v_pts where source = 'court' and ref = v_row.id::text;
  end if;
  perform public._log('reservation.extend', 'reservation', v_row.id::text,
    jsonb_build_object('reference', v_row.reference, 'minutes', p_minutes, 'extra', v_diff, 'paid', p_paid));
  return v_row;
end $$;

create or replace function public.admin_mark_extension_paid(p_id uuid)
returns public.reservations language plpgsql security definer set search_path = public as $$
declare v_row public.reservations;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  update public.reservations set extra_unpaid = 0 where id = p_id returning * into v_row;
  if not found then raise exception 'NOT_FOUND: Booking not found.'; end if;
  perform public._log('reservation.extension_paid', 'reservation', v_row.id::text, jsonb_build_object('reference', v_row.reference));
  return v_row;
end $$;

-- Customer: ask staff for more time (only possible while the next hours are free).
create or replace function public.request_extension(p_id uuid, p_minutes int)
returns public.reservations language plpgsql security definer set search_path = public as $$
declare v_row public.reservations; v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Please sign in first.'; end if;
  select * into v_row from public.reservations where id = p_id for update;
  if not found or v_row.user_id is distinct from v_uid then raise exception 'NOT_FOUND: Booking not found.'; end if;
  perform public._extension_end(v_row, p_minutes);
  update public.reservations set extend_request_minutes = p_minutes, extend_requested_at = now()
   where id = p_id returning * into v_row;
  perform public._log('reservation.extend_request', 'reservation', v_row.id::text,
    jsonb_build_object('reference', v_row.reference, 'minutes', p_minutes));
  return v_row;
end $$;

-- Customer withdraws the request, or staff decline it.
create or replace function public.clear_extension_request(p_id uuid)
returns public.reservations language plpgsql security definer set search_path = public as $$
declare v_row public.reservations; v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Please sign in first.'; end if;
  select * into v_row from public.reservations where id = p_id for update;
  if not found or (not public.is_admin() and v_row.user_id is distinct from v_uid) then raise exception 'NOT_FOUND: Booking not found.'; end if;
  update public.reservations set extend_request_minutes = null, extend_requested_at = null where id = p_id returning * into v_row;
  return v_row;
end $$;

revoke all on function public._extension_end(public.reservations, int) from public, anon, authenticated;
revoke all on function public.admin_extend_reservation(uuid, int, boolean) from public, anon;
revoke all on function public.admin_mark_extension_paid(uuid) from public, anon;
revoke all on function public.request_extension(uuid, int) from public, anon;
revoke all on function public.clear_extension_request(uuid) from public, anon;
grant execute on function public.admin_extend_reservation(uuid, int, boolean) to authenticated;
grant execute on function public.admin_mark_extension_paid(uuid) to authenticated;
grant execute on function public.request_extension(uuid, int) to authenticated;
grant execute on function public.clear_extension_request(uuid) to authenticated;
