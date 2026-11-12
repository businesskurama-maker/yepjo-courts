-- Monthly sales report for admins.
-- Every figure is grouped by business day (a session that runs past midnight
-- belongs to the evening it started), Asia/Manila time.

create or replace function public._report_bdate(r public.reservations)
returns date language sql stable set search_path = public as $$
  select coalesce(
    public._business_date(r.court_id, r.starts_at,
                          greatest(1, (extract(epoch from (r.ends_at - r.starts_at)) / 60)::int), 1),
    (r.starts_at at time zone 'Asia/Manila')::date)
$$;

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
               'payment_ref', payment_ref, 'status', status, 'amount', amount
             ) order by starts_at), '[]')
               from cur where status in ('confirmed', 'cancelled')
                          or (status = 'pending' and payment_status = 'submitted'))
  ) into v_out;

  return v_out;
end $$;

revoke all on function public._report_bdate(public.reservations) from public, anon, authenticated;
revoke all on function public.admin_sales_report(date) from public, anon;
grant execute on function public.admin_sales_report(date) to authenticated;
