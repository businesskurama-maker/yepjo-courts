-- Time-based prices and closed dates. Runs in one transaction and rolls back.
-- Local run:  psql -d <db> -f supabase/tests/rates_closures.sql
\set ON_ERROR_STOP 1
begin;
-- Known starting point: the Nov 16, 2026 Yepjo rates, open 7 AM–1 AM.
update public.court_hours set opens = '07:00', closes = '01:00', is_closed = false;
delete from public.closures;
update public.settings set max_active_bookings = 50 where id;
create schema t;

-- Runs p_sql as the given user (NULL = signed-out guest) with RLS in force.
create function t.run(p_uid uuid, p_sql text, p_expect text default null) returns text
language plpgsql as $$
declare v_err text := null; v_res text;
begin
  perform set_config('request.jwt.claims',
    case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true);
  perform set_config('role', case when p_uid is null then 'anon' else 'authenticated' end, true);
  begin
    execute p_sql into v_res;
  exception when others then v_err := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  if p_expect is null and v_err is not null then
    raise exception 'UNEXPECTED ERROR [%]: %', p_sql, v_err;
  end if;
  if p_expect is not null and (v_err is null or v_err not like '%' || p_expect || '%') then
    raise exception 'EXPECTED "%" but got "%" [%]', p_expect, coalesce(v_err, 'success → ' || coalesce(v_res, 'null')), p_sql;
  end if;
  raise notice 'ok  %  %', rpad(coalesce(p_expect, 'success'), 20), left(regexp_replace(p_sql, '\s+', ' ', 'g'), 95);
  return v_res;
end $$;

create function t.eq(p_got text, p_want text, p_label text) returns void language plpgsql as $$
begin
  if p_got is distinct from p_want then raise exception 'FAILED %: got "%", wanted "%"', p_label, p_got, p_want; end if;
  raise notice 'ok  %  %', rpad('= ' || coalesce(p_want, 'null'), 20), p_label;
end $$;

-- Manila wall-clock time N days from today, as a quoted timestamptz literal.
create function t.slot(p_days int, p_time time) returns text language sql as $$
  select quote_literal((((now() at time zone 'Asia/Manila')::date + p_days + p_time) at time zone 'Asia/Manila')::text)
$$;


-- Manila date of the next given weekday (0 = Sunday), at least 2 days ahead.
create function t.next_dow(p_dow int) returns int language sql as $$
  select min(d) from generate_series(2, 9) d
   where extract(dow from (now() at time zone 'Asia/Manila')::date + d) = p_dow
$$;

do $$
declare
  a uuid := gen_random_uuid(); adm uuid := gen_random_uuid();
  c1 int; c5 int; b1 int; wed int := t.next_dow(3); fri int := t.next_dow(5); sat int := t.next_dow(6);
  v text; k uuid; wed_date date := (now() at time zone 'Asia/Manila')::date + t.next_dow(3);
begin
  select id into c1 from courts where sport = 'pickleball' and name = 'Court 1';
  select id into c5 from courts where sport = 'pickleball' and name = 'Court 5';
  select id into b1 from courts where sport = 'badminton' and name = 'Court 1';
  delete from court_rates;
  insert into court_rates (court_id, day_type, starts, ends, rate)
  select c.id, x.d, x.s::time, x.e::time,
         case when x.r = 0 then (case when c.id = c5 then 400 else 350 end) else x.r end
    from courts c, (values ('weekday', '07:00', '15:00', 250), ('weekday', '15:00', '01:00', 0),
                           ('weekend', '07:00', '01:00', 0)) x(d, s, e, r);

  insert into auth.users (id, email, raw_user_meta_data) values
    (a, 'ana@example.com', '{"full_name":"Ana Cruz"}'), (adm, 'owner@example.com', '{}');
  perform t.run(a, $q$select (save_profile('Ana Cruz', '09171234567')).phone$q$);
  insert into admins (user_id) values (adm);

  raise notice '--- prices from time sets';
  perform t.eq(t.run(a, format('select (book_court(%s, %s, 120)).amount', c1, t.slot(wed, '14:00'))), '600.00',
               'weekday 2–4 PM = 250 + 350');
  perform t.eq(t.run(a, format('select (book_court(%s, %s, 120)).amount', c5, t.slot(wed, '15:00'))), '800.00',
               'Court 5 weekday after 3 PM = 400/hr');
  perform t.eq(t.run(a, format('select (book_court(%s, %s, 120)).amount', c1, t.slot(sat, '09:00'))), '700.00',
               'weekend morning = 350/hr');
  perform t.eq(t.run(a, format('select (book_court(%s, %s, 120)).amount', b1, t.slot(fri, '23:00'))), '700.00',
               'Friday 11 PM–1 AM uses Friday (weekday) price');
  perform t.eq(t.run(adm, format($q$select (admin_create_reservations(array[%s], %s, %s, 'walk_in', 'Walk In')).amount$q$,
               c1, t.slot(wed, '08:00'), t.slot(wed, '09:30'))), '375.00', 'walk-in priced by time set (1.5 h × 250)');

  raise notice '--- editing time sets';
  perform t.run(a, format($q$select admin_set_rates(array[%s], '[]')$q$, c1), 'FORBIDDEN');
  perform t.run(adm, format($q$select admin_set_rates(array[%s], '[{"day_type":"weekday","starts":"07:00","ends":"16:00","rate":200},
                                                              {"day_type":"weekday","starts":"15:00","ends":"01:00","rate":300}]')$q$, c1),
                'overlap');
  perform t.run(adm, format($q$select admin_set_rates(array[%s], '[{"day_type":"weekday","starts":"07:00","ends":"09:00","rate":1},
     {"day_type":"weekday","starts":"09:00","ends":"11:00","rate":1},{"day_type":"weekday","starts":"11:00","ends":"13:00","rate":1},
     {"day_type":"weekday","starts":"13:00","ends":"15:00","rate":1}]')$q$, c1), 'Up to 3');
  perform t.run(adm, format($q$select admin_set_rates(array[%s], '[{"day_type":"weekday","starts":"07:15","ends":"09:00","rate":1}]')$q$, c1),
                'half hour');
  perform t.eq(t.run(adm, format($q$select admin_set_rates(array[%s,%s], '[{"day_type":"weekday","starts":"07:00","ends":"12:00","rate":200},
     {"day_type":"weekday","starts":"12:00","ends":"01:00","rate":320},{"day_type":"weekend","starts":"07:00","ends":"01:00","rate":380}]')$q$, c1, b1)),
     '2', 'admin saves 3 time sets on two courts at once');
  perform t.eq((select string_agg(day_type || ' ' || to_char(starts, 'HH24:MI') || '-' || to_char(ends, 'HH24:MI') || ' ' || rate, '; ' order by day_type, starts)
                  from court_rates where court_id = b1),
               'weekday 07:00-12:00 200.00; weekday 12:00-01:00 320.00; weekend 07:00-01:00 380.00', 'time sets replaced');
  perform t.eq(t.run(a, format('select (book_court(%s, %s, 60)).amount', b1, t.slot(wed, '11:00'))), '200.00', 'new weekday price used');
  perform t.run(adm, format($q$select admin_set_rates(array[%s], '[{"day_type":"weekday","starts":"07:00","ends":"12:00","rate":200}]')$q$, c5));
  perform t.eq(t.run(a, format('select (book_court(%s, %s, 60)).amount', c5, t.slot(wed, '20:00'))),
               (select hourly_rate::text from courts where id = c5), 'uncovered hours fall back to the court''s hourly rate');
  perform t.eq((select count(*)::text from activity_logs where action = 'court_rates.update'), '2', 'price changes are logged');

  raise notice '--- closed dates';
  perform t.run(null, format($q$insert into closures (starts_on, ends_on, kind, title) values (%L, %L, 'holiday', 'x') returning 1$q$, wed_date, wed_date), 'permission denied');
  perform t.run(a, format($q$insert into closures (starts_on, ends_on, kind, title) values (%L, %L, 'holiday', 'x') returning 1$q$, wed_date, wed_date), 'row-level security');
  perform t.run(adm, format($q$insert into closures (starts_on, ends_on, kind, title) values (%L, %L, 'bogus', 'x') returning 1$q$, wed_date, wed_date), 'check');
  k := t.run(adm, format($q$insert into closures (starts_on, ends_on, kind, title) values (%L, %L, 'holiday', 'Town fiesta') returning id$q$, wed_date, wed_date))::uuid;
  perform t.run(a, format('select book_court(%s, %s, 60)', c1, t.slot(wed, '18:00')), 'CLOSED');
  perform t.run(a, format('select book_court(%s, %s, 60)', c1, t.slot(wed + 1, '00:00')), 'CLOSED');   -- 12 AM belongs to the closed night
  perform t.run(a, format('select book_court(%s, %s, 60)', c1, t.slot(wed + 1, '18:00')));              -- next day is open
  perform t.eq(t.run(null, format('select title from closures where id = %L', k)), 'Town fiesta', 'guests can see closed dates');
  perform t.eq(t.run(adm, format('select count(*) from admin_closure_bookings(%L, %L)', wed_date, wed_date)), '5',
               'admin sees bookings already made for that day');
  perform t.run(a, format('select count(*) from admin_closure_bookings(%L, %L)', wed_date, wed_date), 'FORBIDDEN');
  perform t.run(adm, format($q$select count(*) from admin_create_reservations(array[%s], %s, %s, 'walk_in', 'Event Guest')$q$,
                c1, t.slot(wed, '19:00'), t.slot(wed, '20:00')));                                        -- admins can still add walk-ins

  perform t.run(adm, format('delete from closures where id = %L returning 1', k));
  perform t.run(adm, format($q$insert into closures (starts_on, ends_on, court_ids, kind, title) values (%L, %L, array[%s], 'event', 'Tournament') returning 1$q$,
                wed_date + 7, wed_date + 8, c5));
  perform t.run(a, format('select book_court(%s, %s, 60)', c5, t.slot(wed + 8, '10:00')), 'CLOSED');
  perform t.run(a, format('select book_court(%s, %s, 60)', b1, t.slot(wed + 8, '10:00')));              -- other courts stay open
  perform t.run(adm, format($q$insert into closures (starts_on, ends_on, kind, title) values (%L, %L, 'closed', 'Too long') returning 1$q$,
                wed_date, wed_date + 100), 'check');
  perform t.eq((select string_agg(distinct action, ', ') from activity_logs where action like 'closures.%'), 'closures.delete, closures.insert',
               'closures are logged');
  raise notice '=== RATE AND CLOSURE CHECKS PASSED ===';
end $$;
rollback;
