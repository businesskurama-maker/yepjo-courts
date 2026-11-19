-- Discount voucher codes for court bookings.
-- Staff generate codes (percent off, or a fixed amount off); a customer types one in at "Review your booking".

create table if not exists public.vouchers (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code = upper(code) and code ~ '^[A-Z0-9-]{4,24}$'),
  kind        text not null check (kind in ('percent', 'amount')),
  value       numeric(10, 2) not null check (value > 0),
  note        text check (char_length(note) <= 200),        -- who it is for
  max_uses    int check (max_uses is null or max_uses > 0), -- null = unlimited
  once_per_customer boolean not null default true,
  expires_on  date,
  is_active   boolean not null default true,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  check (kind <> 'percent' or value <= 100)
);
alter table public.vouchers enable row level security;
drop policy if exists vouchers_admin on public.vouchers;
create policy vouchers_admin on public.vouchers for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, update, delete on public.vouchers to authenticated;

alter table public.reservations
  add column if not exists voucher_code text,
  add column if not exists discount     numeric(10, 2) not null default 0;
create index if not exists reservations_voucher_idx on public.reservations (voucher_code) where voucher_code is not null;

-- How many live bookings used a code (cancelled bookings and expired holds give the use back).
create or replace function public._voucher_uses(p_code text, p_user uuid default null)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.reservations r
   where r.voucher_code = p_code and r.status in ('pending', 'confirmed')
     and (p_user is null or r.user_id = p_user)
     and not (r.status = 'pending' and r.payment_status in ('unpaid', 'rejected') and r.hold_expires_at < now());
$$;

-- Validates a code for a customer and returns the voucher row (locked). Raises VOUCHER_INVALID otherwise.
create or replace function public._voucher_for(p_code text, p_user uuid, p_skip uuid default null)
returns public.vouchers language plpgsql security definer set search_path = public as $$
declare v public.vouchers; v_code text := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
begin
  select * into v from public.vouchers where code = v_code for update;
  if not found or not v.is_active then raise exception 'VOUCHER_INVALID: That voucher code is not valid.'; end if;
  if v.expires_on is not null and v.expires_on < (now() at time zone 'Asia/Manila')::date then
    raise exception 'VOUCHER_INVALID: That voucher code has expired.';
  end if;
  if v.max_uses is not null and (select count(*) from public.reservations r where r.voucher_code = v.code and r.id is distinct from p_skip
        and r.status in ('pending', 'confirmed') and not (r.status = 'pending' and r.payment_status in ('unpaid', 'rejected') and r.hold_expires_at < now())) >= v.max_uses then
    raise exception 'VOUCHER_INVALID: That voucher code has already been used.';
  end if;
  if v.once_per_customer and exists (select 1 from public.reservations r where r.voucher_code = v.code and r.user_id = p_user and r.id is distinct from p_skip
        and r.status in ('pending', 'confirmed') and not (r.status = 'pending' and r.payment_status in ('unpaid', 'rejected') and r.hold_expires_at < now())) then
    raise exception 'VOUCHER_INVALID: You have already used that voucher code.';
  end if;
  return v;
end $$;

create or replace function public._voucher_discount(v public.vouchers, p_price numeric)
returns numeric language sql immutable as $$
  select least(coalesce(p_price, 0), case when v.kind = 'percent' then round(coalesce(p_price, 0) * v.value / 100, 2) else v.value end);
$$;

-- Customer: preview what a code takes off this booking.
create or replace function public.check_voucher(p_code text, p_court_id int, p_starts_at timestamptz, p_minutes int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.vouchers; v_price numeric; v_disc numeric;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED: Please sign in first.'; end if;
  v := public._voucher_for(p_code, auth.uid());
  v_price := public._price(p_court_id, p_starts_at, p_starts_at + make_interval(mins => p_minutes));
  if v_price is null then raise exception 'VOUCHER_INVALID: This court has no set price, so a voucher cannot be used.'; end if;
  v_disc := public._voucher_discount(v, v_price);
  return jsonb_build_object('code', v.code, 'kind', v.kind, 'value', v.value, 'price', v_price, 'discount', v_disc, 'total', v_price - v_disc);
end $$;

-- Customer: book with a voucher. Everything is one transaction: a bad code books nothing.
create or replace function public.book_court_with_voucher(p_court_id int, p_starts_at timestamptz, p_minutes int, p_pay_online boolean, p_voucher text)
returns public.reservations language plpgsql security definer set search_path = public, extensions as $$
declare v_row public.reservations; v public.vouchers; v_disc numeric;
begin
  v_row := public.book_court(p_court_id, p_starts_at, p_minutes, p_pay_online);
  if coalesce(btrim(p_voucher), '') = '' then return v_row; end if;
  v := public._voucher_for(p_voucher, v_row.user_id, v_row.id);
  if v_row.amount is null then raise exception 'VOUCHER_INVALID: This court has no set price, so a voucher cannot be used.'; end if;
  v_disc := public._voucher_discount(v, v_row.amount);
  update public.reservations
     set voucher_code = v.code, discount = v_disc, amount = amount - v_disc,
         -- nothing left to pay: no need to hold the court for a payment
         status = case when status = 'pending' and amount - v_disc <= 0 then 'confirmed' else status end,
         payment_status = case when status = 'pending' and amount - v_disc <= 0 then 'not_required' else payment_status end,
         hold_expires_at = case when status = 'pending' and amount - v_disc <= 0 then null else hold_expires_at end
   where id = v_row.id returning * into v_row;
  perform public._log('voucher.use', 'reservation', v_row.id::text, jsonb_build_object('reference', v_row.reference, 'code', v.code, 'discount', v_disc));
  return v_row;
end $$;

-- Staff: generate one or many codes.
create or replace function public.admin_create_vouchers(
  p_kind text, p_value numeric, p_count int default 1, p_note text default null,
  p_max_uses int default 1, p_expires_on date default null, p_code text default null, p_once_per_customer boolean default true)
returns setof public.vouchers language plpgsql security definer set search_path = public, extensions as $$
declare v_code text; v_row public.vouchers; i int; v_try int; v_abc text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  if p_kind not in ('percent', 'amount') or p_value is null or p_value <= 0 or (p_kind = 'percent' and p_value > 100) then
    raise exception 'INVALID_REQUEST: Enter a discount above zero (and not more than 100%%).';
  end if;
  if p_count is null or p_count < 1 or p_count > 100 then raise exception 'INVALID_REQUEST: Create between 1 and 100 codes at a time.'; end if;
  if p_max_uses is not null and p_max_uses < 1 then raise exception 'INVALID_REQUEST: Uses per code must be 1 or more.'; end if;
  v_code := nullif(upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g')), '');
  if v_code is not null then
    if p_count <> 1 then raise exception 'INVALID_REQUEST: A custom code can only be made one at a time.'; end if;
    if v_code !~ '^[A-Z0-9-]{4,24}$' then raise exception 'INVALID_REQUEST: Use 4 to 24 letters, numbers or dashes for the code.'; end if;
    if exists (select 1 from public.vouchers where code = v_code) then raise exception 'INVALID_REQUEST: That code already exists.'; end if;
  end if;
  for i in 1..p_count loop
    v_try := 0;
    loop
      v_try := v_try + 1;
      if v_code is null or i > 1 or v_try > 1 then
        v_code := 'YPJ-' || (select string_agg(substr(v_abc, 1 + floor(random() * length(v_abc))::int, 1), '') from generate_series(1, 6));
      end if;
      begin
        insert into public.vouchers (code, kind, value, note, max_uses, expires_on, once_per_customer, created_by)
        values (v_code, p_kind, p_value, nullif(btrim(p_note), ''), p_max_uses, p_expires_on, coalesce(p_once_per_customer, true), auth.uid())
        returning * into v_row;
        exit;
      exception when unique_violation then
        if v_try >= 8 then raise; end if;
      end;
    end loop;
    v_code := null;
    return next v_row;
  end loop;
  perform public._log('voucher.create', 'voucher', v_row.id::text, jsonb_build_object('count', p_count, 'kind', p_kind, 'value', p_value, 'note', p_note));
end $$;

-- Staff: the list, with how many times each code was used and how much it took off.
create or replace function public.admin_vouchers()
returns table (id uuid, code text, kind text, value numeric, note text, max_uses int, once_per_customer boolean, expires_on date,
               is_active boolean, created_at timestamptz, uses int, discount_given numeric)
language sql stable security definer set search_path = public as $$
  select v.id, v.code, v.kind, v.value, v.note, v.max_uses, v.once_per_customer, v.expires_on, v.is_active, v.created_at,
         public._voucher_uses(v.code),
         coalesce((select sum(r.discount) from public.reservations r where r.voucher_code = v.code and r.status = 'confirmed'), 0)
    from public.vouchers v where public.is_admin() order by v.created_at desc, v.code;
$$;

-- Extending a booking must keep its voucher discount: add only the price of the extra time.
create or replace function public.admin_extend_reservation(p_id uuid, p_minutes int, p_paid boolean default true)
returns public.reservations language plpgsql security definer set search_path = public as $$
declare v_row public.reservations; v_new timestamptz; v_diff numeric; v_set public.settings; v_pts numeric;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  select * into v_row from public.reservations where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Booking not found.'; end if;
  v_new := public._extension_end(v_row, p_minutes);
  v_diff := greatest(0, coalesce(public._price(v_row.court_id, v_row.starts_at, v_new), 0)
                      - coalesce(public._price(v_row.court_id, v_row.starts_at, v_row.ends_at), 0));
  update public.reservations
     set ends_at = v_new, amount = case when amount is null and v_diff = 0 then null else coalesce(amount, 0) + v_diff end,
         extra_minutes = extra_minutes + p_minutes, extra_amount = extra_amount + v_diff,
         extra_unpaid = extra_unpaid + case when p_paid then 0 else v_diff end,
         extend_request_minutes = null, extend_requested_at = null
   where id = p_id returning * into v_row;
  select * into v_set from public.settings where id;
  if v_row.user_id is not null and v_row.kind = 'online' and v_set.rewards_enabled and v_set.points_court_hours > 0 then
    v_pts := round((extract(epoch from (v_row.ends_at - v_row.starts_at)) / 3600.0) / v_set.points_court_hours, 2);
    update public.points_ledger set points = v_pts where source = 'court' and ref = v_row.id::text;
  end if;
  perform public._log('reservation.extend', 'reservation', v_row.id::text,
    jsonb_build_object('reference', v_row.reference, 'minutes', p_minutes, 'extra', v_diff, 'paid', p_paid));
  return v_row;
end $$;

revoke all on function public._voucher_uses(text, uuid) from public, anon, authenticated;
revoke all on function public._voucher_for(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public._voucher_discount(public.vouchers, numeric) from public, anon, authenticated;
revoke all on function public.check_voucher(text, int, timestamptz, int) from public, anon;
revoke all on function public.book_court_with_voucher(int, timestamptz, int, boolean, text) from public, anon;
revoke all on function public.admin_create_vouchers(text, numeric, int, text, int, date, text, boolean) from public, anon;
revoke all on function public.admin_vouchers() from public, anon;
grant execute on function public.check_voucher(text, int, timestamptz, int) to authenticated;
grant execute on function public.book_court_with_voucher(int, timestamptz, int, boolean, text) to authenticated;
grant execute on function public.admin_create_vouchers(text, numeric, int, text, int, date, text, boolean) to authenticated;
grant execute on function public.admin_vouchers() to authenticated;
