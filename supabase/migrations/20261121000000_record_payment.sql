-- Recording payments received at the court.
-- A walk-in, a pay-at-the-court booking or a block made for a customer can be marked paid by staff:
-- it is counted as collected in the sales report and the activity log shows who received it.

alter table public.reservations
  add column if not exists paid_via     text check (paid_via in ('cash', 'gcash', 'maya', 'bank', 'other')),
  add column if not exists paid_amount  numeric(10, 2),
  add column if not exists paid_by_name text,
  add column if not exists paid_note    text;

-- What is still to be collected at the court for a booking (0 for blocks, cancelled and paid bookings).
-- Extra time that was already paid is not asked for again.
create or replace function public._amount_due(r public.reservations)
returns numeric language sql immutable as $$
  select case
    when r.kind = 'block' or r.status <> 'confirmed' or r.payment_status = 'verified' then 0
    else greatest(0, coalesce(r.amount, 0) - greatest(0, coalesce(r.extra_amount, 0) - coalesce(r.extra_unpaid, 0)))
  end
$$;

create or replace function public._via_label(p_via text)
returns text language sql immutable as $$
  select case p_via when 'cash' then 'Cash' when 'gcash' then 'GCash' when 'maya' then 'Maya'
                    when 'bank' then 'Bank transfer' else 'Other' end
$$;

create or replace function public._staff_name()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(full_name), ''), email) from public.profiles where id = auth.uid()
$$;

-- Staff: the customer paid at the court.
-- For a block, the customer's name is required and the block becomes a walk-in booking with a price.
create or replace function public.admin_record_payment(
  p_id uuid, p_amount numeric default null, p_via text default 'cash', p_note text default null,
  p_customer_name text default null, p_customer_phone text default null)
returns public.reservations language plpgsql security definer set search_path = public as $$
declare
  v_row public.reservations; v_due numeric; v_amt numeric; v_block boolean; v_court text;
  v_name text := nullif(trim(coalesce(p_customer_name, '')), '');
  v_phone text := nullif(trim(coalesce(p_customer_phone, '')), '');
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_who text := public._staff_name();
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  if p_via is null or p_via not in ('cash', 'gcash', 'maya', 'bank', 'other') then
    raise exception 'INVALID_REQUEST: Choose how the customer paid.';
  end if;
  select * into v_row from public.reservations where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Booking not found.'; end if;
  if v_row.status = 'pending' then
    raise exception 'INVALID_REQUEST: This booking is waiting for an online payment. Check it under Payments.';
  end if;
  if v_row.status <> 'confirmed' then raise exception 'INVALID_REQUEST: This booking was cancelled.'; end if;
  v_block := v_row.kind = 'block';
  if v_block then
    if v_name is null then raise exception 'INVALID_REQUEST: Enter the customer''s name.'; end if;
    if v_row.ends_at - v_row.starts_at > interval '24 hours' then
      raise exception 'INVALID_DURATION: Only a block of 24 hours or less can be turned into a booking.';
    end if;
    v_due := coalesce(public._price(v_row.court_id, v_row.starts_at, v_row.ends_at), 0);
  else
    if v_row.payment_status = 'verified' then
      raise exception 'ALREADY_PAID: Payment for this booking was already recorded.';
    end if;
    v_due := public._amount_due(v_row);
  end if;
  v_amt := round(coalesce(p_amount, v_due), 2);
  if v_amt < 0 or v_amt > 1000000 then raise exception 'INVALID_REQUEST: Enter the amount received.'; end if;

  update public.reservations
     set kind = case when v_block then 'walk_in' else kind end,
         customer_name = case when v_block then v_name else customer_name end,
         customer_phone = case when v_block then coalesce(v_phone, customer_phone) else customer_phone end,
         amount = case when v_block then v_amt else coalesce(amount, 0) - v_due + v_amt end,
         extra_unpaid = 0,
         payment_status = 'verified', payment_verified_at = now(), payment_verified_by = auth.uid(),
         paid_via = p_via, paid_amount = v_amt, paid_by_name = v_who, paid_note = v_note
   where id = p_id returning * into v_row;
  select name into v_court from public.courts where id = v_row.court_id;
  perform public._log('payment.received', 'reservations', v_row.id::text,
    jsonb_build_object('reference', v_row.reference, 'court', v_court, 'customer', v_row.customer_name,
                       'amount', v_amt, 'expected', v_due, 'via', p_via, 'note', v_note,
                       'received_by', v_who, 'from_block', v_block,
                       'label', v_row.reference || ' · ' || coalesce(v_row.customer_name, 'Customer') || ' · '
                                || to_char(v_amt, 'FM999,999,990.00') || ' ' || public._via_label(p_via)
                                || ' · received by ' || coalesce(v_who, 'staff')));
  return v_row;
end $$;

-- Extra time paid later: say who received it and how much.
create or replace function public.admin_mark_extension_paid(p_id uuid)
returns public.reservations language plpgsql security definer set search_path = public as $$
declare v_row public.reservations; v_amt numeric; v_who text := public._staff_name();
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  select extra_unpaid into v_amt from public.reservations where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Booking not found.'; end if;
  update public.reservations set extra_unpaid = 0 where id = p_id returning * into v_row;
  perform public._log('reservation.extension_paid', 'reservation', v_row.id::text,
    jsonb_build_object('reference', v_row.reference, 'amount', v_amt, 'received_by', v_who,
                       'label', v_row.reference || ' · ' || coalesce(v_row.customer_name, 'Customer') || ' · '
                                || to_char(coalesce(v_amt, 0), 'FM999,999,990.00') || ' for extra time · received by ' || coalesce(v_who, 'staff')));
  return v_row;
end $$;

-- Walk-in / block. A walk-in can be saved as already paid (p_paid_via) or to be collected later.
drop function if exists public.admin_create_reservations(int[], timestamptz, timestamptz, text, text, text, text);
create or replace function public.admin_create_reservations(
  p_court_ids int[], p_starts_at timestamptz, p_ends_at timestamptz, p_kind text,
  p_customer_name text default null, p_customer_phone text default null, p_note text default null,
  p_paid_via text default null)
returns setof public.reservations language plpgsql security definer set search_path = public, extensions as $$
declare
  v_court public.courts; v_id int; v_row public.reservations; v_try int; v_amt numeric;
  v_name text := nullif(trim(coalesce(p_customer_name, '')), '');
  v_paid boolean := p_kind = 'walk_in' and p_paid_via is not null;
  v_who text := public._staff_name();
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  if p_kind not in ('walk_in', 'block') then raise exception 'INVALID_REQUEST: Unknown reservation type.'; end if;
  if p_paid_via is not null and p_paid_via not in ('cash', 'gcash', 'maya', 'bank', 'other') then
    raise exception 'INVALID_REQUEST: Choose how the customer paid.';
  end if;
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
    v_amt := case when p_kind = 'walk_in' then public._price(v_id, p_starts_at, p_ends_at) end;
    v_try := 0;
    loop
      v_try := v_try + 1;
      begin
        insert into public.reservations
          (reference, court_id, kind, starts_at, ends_at, customer_name, customer_phone, note, amount, created_by,
           payment_status, payment_verified_at, payment_verified_by, paid_via, paid_amount, paid_by_name)
        values
          (public._new_reference(), v_id, p_kind, p_starts_at, p_ends_at, v_name,
           nullif(trim(coalesce(p_customer_phone, '')), ''), nullif(trim(coalesce(p_note, '')), ''), v_amt, auth.uid(),
           case when v_paid then 'verified' else 'not_required' end,
           case when v_paid then now() end, case when v_paid then auth.uid() end,
           case when v_paid then p_paid_via end, case when v_paid then coalesce(v_amt, 0) end,
           case when v_paid then v_who end)
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
    if v_paid then
      perform public._log('payment.received', 'reservations', v_row.id::text,
        jsonb_build_object('reference', v_row.reference, 'court', v_court.name, 'customer', v_name,
                           'amount', coalesce(v_amt, 0), 'expected', coalesce(v_amt, 0), 'via', p_paid_via,
                           'received_by', v_who, 'from_block', false,
                           'label', v_row.reference || ' · ' || v_name || ' · '
                                    || to_char(coalesce(v_amt, 0), 'FM999,999,990.00') || ' ' || public._via_label(p_paid_via)
                                    || ' · received by ' || coalesce(v_who, 'staff')));
    end if;
    return next v_row;
  end loop;
end $$;

-- Bookings still to be paid at the court (most recent first), for the staff list.
drop function if exists public.admin_payments_due();
create or replace function public.admin_payments_due(p_days_ahead int default 1)
returns table (id uuid, due numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  return query
    select r.id, public._amount_due(r) from public.reservations r
     where r.status = 'confirmed' and r.kind in ('online', 'walk_in') and r.payment_status <> 'verified'
       and r.starts_at > now() - interval '60 days' and r.starts_at < now() + make_interval(days => least(greatest(coalesce(p_days_ahead, 1), 0), 90))
       and public._amount_due(r) > 0
     order by r.starts_at desc limit 100;
end $$;

-- Sales report: also shows what was collected and what is still to be collected at the court.
create or replace function public.admin_sales_report(p_month date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_from date := date_trunc('month', p_month)::date;
  v_to   date := (date_trunc('month', p_month) + interval '1 month')::date;   -- exclusive
  v_prev date := (date_trunc('month', p_month) - interval '1 month')::date;
  v_out  jsonb;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  if p_month is null then raise exception 'INVALID_REQUEST: Choose a month.'; end if;

  with base as (
    select r.*, public._report_bdate(r) as bdate,
           extract(epoch from (r.ends_at - r.starts_at)) / 3600.0 as hrs,
           public._amount_due(r) as due,
           c.name as court_name, c.sport
      from public.reservations r
      join public.courts c on c.id = r.court_id
     where r.kind in ('online', 'walk_in')
       -- wide window first, exact business-day filter below
       and r.starts_at >= (v_prev::timestamp at time zone 'Asia/Manila')
       and r.starts_at <  ((v_to + 2)::timestamp at time zone 'Asia/Manila')
  ),
  cur  as (select * from base where bdate >= v_from and bdate < v_to),
  prev as (select * from base where bdate >= v_prev and bdate < v_from),
  sold as (select * from cur where status = 'confirmed'),
  -- open hours per active court for each day of the month
  days as (select d::date as d from generate_series(v_from, v_to - 1, interval '1 day') d),
  open_hours as (
    select coalesce(sum(
             extract(epoch from (h.closes - h.opens)) / 3600.0
             + case when h.closes <= h.opens then 24 else 0 end), 0) as hrs
      from days
      join public.court_hours h on h.dow = extract(dow from days.d)::int and not h.is_closed
      join public.courts c on c.id = h.court_id and c.is_active
  )
  select jsonb_build_object(
    'month', to_char(v_from, 'YYYY-MM'),
    'from', v_from, 'to', v_to - 1,
    'totals', jsonb_build_object(
      'revenue',          coalesce((select sum(amount) from sold), 0),
      'bookings',         (select count(*) from sold),
      'hours',            coalesce(round((select sum(hrs) from sold)::numeric, 1), 0),
      'customers',        (select count(distinct coalesce(user_id::text, lower(customer_name))) from sold),
      'online_revenue',   coalesce((select sum(amount) from sold where kind = 'online' and payment_method = 'online'), 0),
      'venue_revenue',    coalesce((select sum(amount) from sold where kind = 'online' and payment_method = 'venue'), 0),
      'walk_in_revenue',  coalesce((select sum(amount) from sold where kind = 'walk_in'), 0),
      'walk_ins',         (select count(*) from sold where kind = 'walk_in'),
      'collected',        coalesce((select sum(amount - due) from sold), 0),
      'to_collect',       coalesce((select sum(due) from sold), 0),
      'to_collect_count', (select count(*) from sold where due > 0),
      'cancelled',        (select count(*) from cur where status = 'cancelled'),
      'cancelled_value',  coalesce((select sum(amount) from cur where status = 'cancelled'), 0),
      'pending',          (select count(*) from cur where status = 'pending' and payment_status = 'submitted'),
      'pending_value',    coalesce((select sum(amount) from cur where status = 'pending' and payment_status = 'submitted'), 0),
      'open_hours',       round((select hrs from open_hours)::numeric, 1),
      'prev_revenue',     coalesce((select sum(amount) from prev where status = 'confirmed'), 0),
      'prev_bookings',    (select count(*) from prev where status = 'confirmed')
    ),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object(
                 'date', days.d,
                 'revenue', coalesce((select sum(amount) from sold where bdate = days.d), 0),
                 'bookings', (select count(*) from sold where bdate = days.d),
                 'hours', coalesce(round((select sum(hrs) from sold where bdate = days.d)::numeric, 1), 0)
               ) order by days.d), '[]') from days),
    'courts', (select coalesce(jsonb_agg(x order by x->>'sport', (x->>'sort')::int), '[]') from (
                 select jsonb_build_object(
                   'court', c.name, 'sport', c.sport, 'sort', c.sort_order,
                   'revenue', coalesce(sum(s.amount), 0), 'bookings', count(s.id),
                   'hours', coalesce(round(sum(s.hrs)::numeric, 1), 0)) as x
                   from public.courts c left join sold s on s.court_id = c.id
                  where c.is_active or s.id is not null
                  group by c.id) q),
    'sports', (select coalesce(jsonb_agg(jsonb_build_object(
                 'sport', sport, 'revenue', rev, 'bookings', n, 'hours', h) order by sport), '[]')
                 from (select sport, sum(amount) as rev, count(*) as n, round(sum(hrs)::numeric, 1) as h
                         from sold group by sport) q),
    'hours_of_day', (select coalesce(jsonb_agg(jsonb_build_object('hour', hr, 'bookings', n) order by hr), '[]')
                 from (select extract(hour from starts_at at time zone 'Asia/Manila')::int as hr, count(*) as n
                         from sold group by 1) q),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
               'date', bdate, 'reference', reference, 'court', court_name, 'sport', sport,
               'starts_at', starts_at, 'ends_at', ends_at, 'hours', round(hrs::numeric, 2),
               'customer', customer_name, 'phone', customer_phone,
               'kind', kind, 'payment', case when kind = 'walk_in' then 'walk_in' else payment_method end,
               'payment_ref', payment_ref, 'status', status, 'amount', amount,
               'due', due, 'paid_via', paid_via, 'received_by', paid_by_name, 'received_at',
               case when payment_method = 'venue' and payment_status = 'verified' then payment_verified_at end
             ) order by starts_at), '[]')
               from cur where status in ('confirmed', 'cancelled')
                          or (status = 'pending' and payment_status = 'submitted'))
  ) into v_out;

  return v_out;
end $$;


revoke all on function public._amount_due(public.reservations) from public, anon, authenticated;
revoke all on function public._via_label(text) from public, anon, authenticated;
revoke all on function public._staff_name() from public, anon, authenticated;
revoke all on function public.admin_record_payment(uuid, numeric, text, text, text, text) from public, anon;
revoke all on function public.admin_create_reservations(int[], timestamptz, timestamptz, text, text, text, text, text) from public, anon;
revoke all on function public.admin_payments_due(int) from public, anon;
revoke all on function public.admin_sales_report(date) from public, anon;
grant execute on function public.admin_record_payment(uuid, numeric, text, text, text, text) to authenticated;
grant execute on function public.admin_create_reservations(int[], timestamptz, timestamptz, text, text, text, text, text) to authenticated;
grant execute on function public.admin_payments_due(int) to authenticated;
grant execute on function public.admin_sales_report(date) to authenticated;
