-- =====================================================================
-- Online QR payments.
--  * A customer may pay online: the booking is created as PENDING and holds
--    the court for `payment_hold_minutes`. They scan the QR, pay, and submit
--    the last 6 digits of the payment reference.
--  * An administrator verifies the payment → the booking becomes CONFIRMED,
--    or rejects it → the customer can correct and resubmit within a new hold.
--  * Unpaid holds expire automatically (cleaned up lazily on the next booking
--    attempt and ignored by availability), so abandoned bookings free the court.
--  * Paying at the court keeps the original behaviour (confirmed at once),
--    and can be switched off so online payment becomes required.
-- =====================================================================
set search_path = public, extensions;

-- ---------------------------------------------------------------- settings
alter table public.settings
  add column if not exists online_payment_enabled boolean not null default false,
  add column if not exists allow_pay_at_venue     boolean not null default true,
  add column if not exists payment_qr_path        text,
  add column if not exists payment_instructions   text not null default '' check (char_length(payment_instructions) <= 600),
  add column if not exists payment_hold_minutes   int  not null default 30 check (payment_hold_minutes between 5 and 1440);

-- At least one way to pay must stay available.
alter table public.settings drop constraint if exists settings_payment_option_chk;
alter table public.settings add constraint settings_payment_option_chk
  check (allow_pay_at_venue or (online_payment_enabled and payment_qr_path is not null));

-- ------------------------------------------------------------ reservations
alter table public.reservations drop constraint if exists reservations_status_check;
alter table public.reservations add constraint reservations_status_check
  check (status in ('pending', 'confirmed', 'cancelled'));

alter table public.reservations
  add column if not exists payment_method       text not null default 'venue' check (payment_method in ('venue', 'online')),
  add column if not exists payment_status       text not null default 'not_required'
        check (payment_status in ('not_required', 'unpaid', 'submitted', 'verified', 'rejected')),
  add column if not exists payment_ref          text check (payment_ref is null or payment_ref ~ '^[0-9]{6}$'),
  add column if not exists payment_submitted_at timestamptz,
  add column if not exists payment_verified_at  timestamptz,
  add column if not exists payment_verified_by  uuid,
  add column if not exists payment_note         text,
  add column if not exists hold_expires_at      timestamptz;

-- Pending bookings hold the court too: no overlap with pending or confirmed.
alter table public.reservations drop constraint if exists reservations_no_overlap;
alter table public.reservations add constraint reservations_no_overlap exclude using gist (
  court_id with =,
  tstzrange(starts_at, ends_at, '[)') with &&
) where (status in ('pending', 'confirmed'));

create index if not exists reservations_payment_idx on public.reservations (payment_status) where status = 'pending';

-- Holds that are still waiting for (or need a corrected) payment and ran out of time.
create or replace function public._expire_payment_holds(p_court int default null, p_from timestamptz default null, p_to timestamptz default null)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.reservations
     set status = 'cancelled', cancelled_at = now(),
         cancel_reason = 'Payment not received in time'
   where status = 'pending'
     and payment_status in ('unpaid', 'rejected')
     and hold_expires_at < now()
     and (p_court is null or court_id = p_court)
     and (p_from is null or (starts_at < p_to and ends_at > p_from));
  get diagnostics n = row_count;
  return n;
end $$;

-- Public availability: confirmed bookings, blocks, and live holds.
create or replace function public.get_availability(p_from timestamptz, p_to timestamptz)
returns table (court_id int, starts_at timestamptz, ends_at timestamptz, state text)
language sql stable security definer set search_path = public as $$
  select r.court_id, r.starts_at, r.ends_at,
         case when r.kind = 'block' then 'blocked' else 'booked' end
  from public.reservations r
  where (r.status = 'confirmed'
         or (r.status = 'pending' and (r.payment_status in ('submitted', 'verified') or r.hold_expires_at > now())))
    and p_to > p_from
    and p_to - p_from <= interval '45 days'
    and r.starts_at < p_to and r.ends_at > p_from
  order by r.starts_at;
$$;

-- ------------------------------------------------------------ book_court
drop function if exists public.book_court(int, timestamptz, int);
create or replace function public.book_court(p_court_id int, p_starts_at timestamptz, p_minutes int, p_pay_online boolean default false)
returns public.reservations language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid      uuid := auth.uid();
  v_profile  public.profiles;
  v_settings public.settings;
  v_court    public.courts;
  v_bdate    date;
  v_today    date := (now() at time zone 'Asia/Manila')::date;
  v_active   int;
  v_row      public.reservations;
  v_try      int := 0;
  v_online   boolean := coalesce(p_pay_online, false);
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED: Please sign in with Google to book a court.';
  end if;
  select * into v_profile from public.profiles where id = v_uid;
  if not found or v_profile.completed_at is null then
    raise exception 'PROFILE_INCOMPLETE: Please complete your profile before booking.';
  end if;
  if p_starts_at is null or p_minutes is null then
    raise exception 'INVALID_REQUEST: A start time and duration are required.';
  end if;
  select * into v_settings from public.settings where id;
  if v_online and not (v_settings.online_payment_enabled and v_settings.payment_qr_path is not null) then
    raise exception 'PAYMENT_UNAVAILABLE: Online payment is not available right now. Please choose pay at the court.';
  end if;
  if not v_online and not v_settings.allow_pay_at_venue then
    raise exception 'PAYMENT_REQUIRED: Please pay online to book this court.';
  end if;
  select * into v_court from public.courts where id = p_court_id;
  if not found or not v_court.is_active then
    raise exception 'COURT_UNAVAILABLE: This court is not available for booking.';
  end if;
  if p_minutes <= 0 or p_minutes % v_settings.slot_minutes <> 0
     or p_minutes < v_settings.min_slots * v_settings.slot_minutes
     or p_minutes > v_settings.max_slots * v_settings.slot_minutes then
    raise exception 'INVALID_DURATION: That duration is not allowed.';
  end if;
  if p_starts_at <= now() then
    raise exception 'PAST_TIME: That start time has already passed.';
  end if;
  v_bdate := public._business_date(p_court_id, p_starts_at, p_minutes, v_settings.slot_minutes);
  if v_bdate is null then
    raise exception 'OUTSIDE_HOURS: That time is outside the court''s operating hours.';
  end if;
  if v_bdate > (v_today + interval '1 month')::date then
    raise exception 'OUTSIDE_WINDOW: Bookings open up to one month ahead only.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  -- Free any abandoned payment holds on this court/time before trying.
  perform public._expire_payment_holds(p_court_id, p_starts_at, p_starts_at + make_interval(mins => p_minutes));
  select count(*) into v_active from public.reservations
   where user_id = v_uid and status in ('pending', 'confirmed') and ends_at > now()
     and not (status = 'pending' and payment_status in ('unpaid', 'rejected') and hold_expires_at < now());
  if v_active >= v_settings.max_active_bookings then
    raise exception 'LIMIT_REACHED: You have reached the limit of % upcoming bookings.', v_settings.max_active_bookings;
  end if;

  loop
    v_try := v_try + 1;
    begin
      insert into public.reservations
        (reference, court_id, user_id, kind, status, starts_at, ends_at,
         customer_name, customer_phone, customer_email, amount, created_by,
         payment_method, payment_status, hold_expires_at)
      values
        (public._new_reference(), p_court_id, v_uid, 'online',
         case when v_online then 'pending' else 'confirmed' end,
         p_starts_at, p_starts_at + make_interval(mins => p_minutes),
         v_profile.full_name, v_profile.phone, v_profile.email,
         case when v_court.hourly_rate is null then null
              else round(v_court.hourly_rate * p_minutes / 60.0, 2) end,
         v_uid,
         case when v_online then 'online' else 'venue' end,
         case when v_online then 'unpaid' else 'not_required' end,
         case when v_online then now() + make_interval(mins => v_settings.payment_hold_minutes) end)
      returning * into v_row;
      exit;
    exception
      when exclusion_violation then
        raise exception 'SLOT_TAKEN: Sorry, that time has just been taken. Please choose another slot.';
      when unique_violation then
        if v_try >= 5 then raise; end if;
    end;
  end loop;
  return v_row;
end $$;

-- Walk-ins / blocks: clear abandoned holds first, then the same overlap rule.
create or replace function public.admin_create_reservations(
  p_court_ids int[], p_starts_at timestamptz, p_ends_at timestamptz, p_kind text,
  p_customer_name text default null, p_customer_phone text default null, p_note text default null)
returns setof public.reservations language plpgsql security definer set search_path = public, extensions as $$
declare
  v_court public.courts; v_id int; v_row public.reservations; v_try int;
  v_name text := nullif(trim(coalesce(p_customer_name, '')), '');
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  if p_kind not in ('walk_in', 'block') then raise exception 'INVALID_REQUEST: Unknown reservation type.'; end if;
  if p_court_ids is null or cardinality(p_court_ids) = 0 then raise exception 'INVALID_REQUEST: Choose at least one court.'; end if;
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'INVALID_REQUEST: The end must be after the start.';
  end if;
  if p_ends_at <= now() then raise exception 'PAST_TIME: That period has already ended.'; end if;
  if p_kind = 'walk_in' and p_ends_at - p_starts_at > interval '24 hours' then
    raise exception 'INVALID_DURATION: A walk-in booking cannot be longer than 24 hours.';
  end if;
  if p_kind = 'block' and p_ends_at - p_starts_at > interval '62 days' then
    raise exception 'INVALID_DURATION: A block cannot be longer than 62 days.';
  end if;
  if p_kind = 'walk_in' and v_name is null then
    raise exception 'INVALID_REQUEST: Enter the customer''s name for a walk-in.';
  end if;

  foreach v_id in array p_court_ids loop
    select * into v_court from public.courts where id = v_id;
    if not found then raise exception 'COURT_UNAVAILABLE: Court not found.'; end if;
    perform public._expire_payment_holds(v_id, p_starts_at, p_ends_at);
    v_try := 0;
    loop
      v_try := v_try + 1;
      begin
        insert into public.reservations
          (reference, court_id, kind, starts_at, ends_at, customer_name, customer_phone, note, amount, created_by)
        values
          (public._new_reference(), v_id, p_kind, p_starts_at, p_ends_at, v_name,
           nullif(trim(coalesce(p_customer_phone, '')), ''), nullif(trim(coalesce(p_note, '')), ''),
           case when p_kind = 'walk_in' and v_court.hourly_rate is not null
                then round(v_court.hourly_rate * extract(epoch from (p_ends_at - p_starts_at)) / 3600.0, 2) end,
           auth.uid())
        returning * into v_row;
        exit;
      exception
        when exclusion_violation then
          raise exception 'SLOT_TAKEN: % already has a booking, payment hold or block in that period. Nothing was saved.', v_court.name;
        when unique_violation then
          if v_try >= 5 then raise; end if;
      end;
    end loop;
    perform public._log('reservation.' || p_kind, 'reservations', v_row.id::text,
      jsonb_build_object('reference', v_row.reference, 'court', v_court.name,
                         'starts_at', p_starts_at, 'ends_at', p_ends_at, 'label', coalesce(v_name, p_note)));
    return next v_row;
  end loop;
end $$;

-- Customers may cancel a pending (unpaid) booking at any time; confirmed ones follow the policy.
create or replace function public.cancel_reservation(p_id uuid, p_reason text default null)
returns public.reservations language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_admin boolean := public.is_admin();
  v_row public.reservations; v_settings public.settings;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Please sign in first.'; end if;
  select * into v_row from public.reservations where id = p_id for update;
  if not found or (not v_admin and v_row.user_id is distinct from v_uid) then
    raise exception 'NOT_FOUND: Booking not found.';
  end if;
  if v_row.status = 'cancelled' then return v_row; end if;
  if not v_admin then
    select * into v_settings from public.settings where id;
    if v_row.kind <> 'online' then raise exception 'NOT_FOUND: Booking not found.'; end if;
    if v_row.status = 'confirmed' then
      if not v_settings.allow_cancellation then
        raise exception 'CANCEL_NOT_ALLOWED: Online cancellation is turned off. Please message Yepjo.';
      end if;
      if now() > v_row.starts_at - make_interval(hours => v_settings.cancel_cutoff_hours) then
        raise exception 'CANCEL_NOT_ALLOWED: Bookings can be cancelled up to % hour(s) before the start time. Please message Yepjo.', v_settings.cancel_cutoff_hours;
      end if;
    elsif v_row.payment_status = 'submitted' then
      raise exception 'CANCEL_NOT_ALLOWED: Your payment is being checked. Please message Yepjo to cancel.';
    end if;
  end if;
  update public.reservations
     set status = 'cancelled', cancelled_at = now(), cancelled_by = v_uid,
         cancel_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = p_id
  returning * into v_row;
  if v_admin then
    perform public._log('reservation.cancel', 'reservations', v_row.id::text,
      jsonb_build_object('reference', v_row.reference, 'kind', v_row.kind, 'label', v_row.customer_name, 'reason', v_row.cancel_reason));
  end if;
  return v_row;
end $$;

-- ------------------------------------------------------------ customer: submit reference
create or replace function public.submit_payment(p_id uuid, p_ref text)
returns public.reservations language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_ref text := regexp_replace(coalesce(p_ref, ''), '\D', '', 'g');
  v_row public.reservations;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Please sign in first.'; end if;
  if v_ref !~ '^[0-9]{6}$' then
    raise exception 'INVALID_REFERENCE: Enter exactly the last 6 digits of your payment reference number.';
  end if;
  select * into v_row from public.reservations where id = p_id for update;
  if not found or v_row.user_id is distinct from v_uid then raise exception 'NOT_FOUND: Booking not found.'; end if;
  if v_row.status <> 'pending' or v_row.payment_method <> 'online' then
    raise exception 'INVALID_REQUEST: This booking is not waiting for an online payment.';
  end if;
  if v_row.payment_status = 'submitted' then
    raise exception 'ALREADY_SUBMITTED: Your reference was already sent. Yepjo will confirm it soon.';
  end if;
  if v_row.payment_status not in ('unpaid', 'rejected') then
    raise exception 'INVALID_REQUEST: This payment cannot be changed.';
  end if;
  if v_row.hold_expires_at is not null and v_row.hold_expires_at < now() then
    -- Release the court and report it in the returned row (an exception would undo the release).
    update public.reservations set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Payment not received in time'
     where id = p_id returning * into v_row;
    return v_row;
  end if;
  update public.reservations
     set payment_ref = v_ref, payment_status = 'submitted', payment_submitted_at = now(), payment_note = null
   where id = p_id
  returning * into v_row;
  return v_row;
end $$;

-- ------------------------------------------------------------ admin: verify / reject
create or replace function public.admin_review_payment(p_id uuid, p_approve boolean, p_note text default null)
returns public.reservations language plpgsql security definer set search_path = public as $$
declare
  v_row public.reservations; v_settings public.settings;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  select * into v_row from public.reservations where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Booking not found.'; end if;
  if v_row.status <> 'pending' then
    raise exception 'INVALID_REQUEST: Only bookings waiting for payment can be reviewed (this one is %).', v_row.status;
  end if;
  if p_approve then
    update public.reservations
       set status = 'confirmed', payment_status = 'verified', payment_verified_at = now(),
           payment_verified_by = auth.uid(), payment_note = v_note, hold_expires_at = null
     where id = p_id returning * into v_row;
  else
    select * into v_settings from public.settings where id;
    update public.reservations
       set payment_status = 'rejected', payment_note = coalesce(v_note, 'We could not find this payment. Please check the reference number.'),
           hold_expires_at = now() + make_interval(mins => v_settings.payment_hold_minutes)
     where id = p_id returning * into v_row;
  end if;
  perform public._log(case when p_approve then 'payment.verify' else 'payment.reject' end, 'reservations', v_row.id::text,
    jsonb_build_object('reference', v_row.reference, 'payment_ref', v_row.payment_ref, 'label', v_row.customer_name, 'note', v_note));
  return v_row;
end $$;

-- ------------------------------------------------------------ privileges
revoke execute on function public._expire_payment_holds(int, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.book_court(int, timestamptz, int, boolean),
                           public.submit_payment(uuid, text),
                           public.admin_review_payment(uuid, boolean, text) from public, anon;
grant execute on function public.book_court(int, timestamptz, int, boolean) to authenticated;
grant execute on function public.submit_payment(uuid, text) to authenticated;
grant execute on function public.admin_review_payment(uuid, boolean, text) to authenticated;
grant execute on function public.get_availability(timestamptz, timestamptz) to anon, authenticated;
