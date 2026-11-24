-- Portals: open-play hour blocks, events, Step Up Dance, sign-up payments, loyalty points.
\set ON_ERROR_STOP 1
begin;
update public.court_hours set opens = '07:00', closes = '01:00', is_closed = false;
delete from public.closures;
update public.settings set max_active_bookings = 50, online_payment_enabled = true, payment_qr_path = 'payments/qr.webp',
  allow_pay_at_venue = true, points_court_hours = 3, points_purchase_amount = 200, points_dance_booking = 1, points_event = 0 where id;
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


create function t.next_dow(p_dow int) returns int language sql as $$
  select min(d) from generate_series(2, 9) d where extract(dow from (now() at time zone 'Asia/Manila')::date + d) = p_dow
$$;

-- these older checks still use the typed-reference functions, which customers can no longer call
grant execute on function public.submit_payment(uuid, text), public.submit_registration_payment(uuid, text), public.submit_order_payment(uuid, text) to authenticated;
do $$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); adm uuid := gen_random_uuid();
  c1 int; c2 int; wed int := t.next_dow(3); wd date := (now() at time zone 'Asia/Manila')::date + t.next_dow(3);
  ev uuid; ev_paid uuid; ev_small uuid; dc uuid; r uuid; rv uuid; code_a text; code_b text; v text;
begin
  select id into c1 from courts where sport = 'pickleball' and name = 'Court 1';
  select id into c2 from courts where sport = 'pickleball' and name = 'Court 2';
  insert into auth.users (id, email, raw_user_meta_data) values
    (a, 'ana@example.com', '{"full_name":"Ana Cruz"}'), (b, 'ben@example.com', '{"full_name":"Ben Reyes"}'), (adm, 'owner@example.com', '{}');
  perform t.run(a, $q$select (save_profile('Ana Cruz', '09171234567')).phone$q$);
  perform t.run(b, $q$select (save_profile('Ben Reyes', '09181234567')).phone$q$);
  insert into admins (user_id) values (adm);

  raise notice '--- member codes';
  select member_code into code_a from profiles where id = a;
  select member_code into code_b from profiles where id = b;
  perform t.eq((code_a ~ '^YJ[A-Z2-9]{8}$')::text, 'true', 'every member gets a code like YJ7K3Q9X2M');
  perform t.eq((code_a <> code_b)::text, 'true', 'codes are unique');
  perform t.eq(t.run(a, $q$select my_rewards()->>'member_code'$q$), code_a, 'members see their own code');

  raise notice '--- open play: blocking some hours';
  perform t.run(adm, format($q$insert into closures (starts_on, ends_on, court_ids, kind, title, start_time, end_time)
                   values (%L, %L, array[%s], 'open_play', 'Open play', '18:00', '21:00') returning 1$q$, wd, wd, c1));
  perform t.run(a, format('select book_court(%s, %s, 60)', c1, t.slot(wed, '19:00')), 'reserved for Open play');
  perform t.run(a, format('select book_court(%s, %s, 120)', c1, t.slot(wed, '17:00')), 'reserved for Open play');   -- overlaps 18:00
  perform t.run(a, format('select book_court(%s, %s, 60)', c1, t.slot(wed, '21:00')));                            -- right after: fine
  perform t.run(a, format('select book_court(%s, %s, 60)', c2, t.slot(wed, '19:00')));                            -- other court: fine
  perform t.run(adm, format($q$insert into closures (starts_on, ends_on, kind, title, start_time, end_time)
                   values (%L, %L, 'open_play', 'Late open play', '23:00', '01:00') returning 1$q$, wd, wd));
  perform t.run(b, format('select book_court(%s, %s, 60)', c2, t.slot(wed + 1, '00:00')), 'Late open play');       -- 12 AM belongs to that night
  perform t.run(b, format('select book_court(%s, %s, 60)', c2, t.slot(wed + 1, '07:00')));                        -- next morning is open
  perform t.run(adm, $q$insert into closures (starts_on, ends_on, kind, title, start_time) values (current_date, current_date, 'open_play', 'x', '10:00') returning 1$q$, 'check');

  raise notice '--- points for court bookings';
  perform t.eq(t.run(a, $q$select (my_rewards()->>'balance')::numeric::text$q$), '0.66', 'two 1-hour bookings at 1 point per 3 hours');
  r := t.run(a, format('select (book_court(%s, %s, 180)).id', c2, t.slot(wed, '08:00')))::uuid;
  perform t.eq(t.run(a, $q$select (my_rewards()->>'balance')::numeric::text$q$), '1.66', 'a 3-hour booking adds 1 point');
  perform t.run(a, format('select cancel_reservation(%L)', r));
  perform t.eq(t.run(a, $q$select (my_rewards()->>'balance')::numeric::text$q$), '0.66', 'cancelling takes the points back');
  r := t.run(a, format('select (book_court(%s, %s, 180, true)).id', c2, t.slot(wed, '12:00')))::uuid;
  perform t.eq(t.run(a, $q$select (my_rewards()->>'balance')::numeric::text$q$), '0.66', 'unpaid online booking earns nothing yet');
  perform t.run(a, format('select submit_payment(%L, %L)', r, '123456'));
  perform t.run(adm, format('select admin_review_payment(%L, true)', r));
  perform t.eq(t.run(a, $q$select (my_rewards()->>'balance')::numeric::text$q$), '1.66', 'points arrive once payment is approved');

  raise notice '--- events';
  ev := t.run(adm, format($q$insert into events (kind, title, starts_on, ends_on, start_time, end_time, price, capacity, is_published)
               values ('open_play', 'Free open play', %L, %L, '18:00', '21:00', 0, 1, true) returning id$q$, wd, wd))::uuid;
  ev_paid := t.run(adm, format($q$insert into events (kind, title, starts_on, ends_on, start_time, end_time, price, capacity, is_published)
               values ('tournament', 'Yepjo Open', %L, %L, '08:00', '18:00', 500, 16, true) returning id$q$, wd, wd + 1))::uuid;
  ev_small := t.run(adm, format($q$insert into events (kind, title, starts_on, ends_on, start_time, end_time, is_published)
               values ('training', 'Hidden draft', %L, %L, '08:00', '10:00', false) returning id$q$, wd, wd))::uuid;
  perform t.eq(t.run(null, 'select count(*) from events'), '2', 'guests see published events only');
  perform t.run(a, format($q$insert into events (title, starts_on, ends_on, start_time, end_time) values ('x', %L, %L, '08:00', '09:00') returning 1$q$, wd, wd), 'row-level security');
  perform t.eq(t.run(a, format($q$select (register('event', %L)).status$q$, ev)), 'confirmed', 'free event: confirmed at once');
  perform t.run(a, format($q$select register('event', %L)$q$, ev), 'ALREADY_REGISTERED');
  perform t.run(b, format($q$select register('event', %L)$q$, ev), 'FULL');
  perform t.run(b, format($q$select register('event', %L)$q$, ev_small), 'NOT_FOUND');
  rv := t.run(b, format($q$select (register('event', %L, true)).id$q$, ev_paid))::uuid;
  perform t.eq(t.run(b, format('select status || %L || payment_status || %L || amount from registrations where id = %L', '/', '/', rv)),
               'pending/unpaid/500.00', 'paid event with QR: waits for payment');
  perform t.run(b, format('select submit_registration_payment(%L, %L)', rv, '12345'), 'INVALID_REFERENCE');
  perform t.run(b, format('select submit_registration_payment(%L, %L)', rv, '654321'));
  perform t.run(b, format('select admin_review_registration(%L, true)', rv), 'FORBIDDEN');
  perform t.eq(t.run(adm, format('select (admin_review_registration(%L, true)).status', rv)), 'confirmed', 'admin approves the payment');
  perform t.eq(t.run(b, format($q$select cancel_fee || '/' || refund_amount || '/' || refund_status from cancel_registration(%L)$q$, rv)),
               '250.00/250.00/to_claim', 'paid sign-up cancelled: 50%% fee kept, 50%% to claim at the venue');
  perform t.eq(t.run(a, 'select count(*) from registrations'), '1', 'members see only their own sign-ups');
  perform t.eq(t.run(null, format($q$select taken from signup_counts() where target = %L$q$, ev_paid)), '0', 'public place count, no names (cancelled frees the place)');

  raise notice '--- step up dance';
  dc := t.run(adm, format($q$insert into dance_sessions (dance_type, instructor, starts_at, ends_at, capacity, price)
               values ('Zumba Step', 'Coach Mia', %L, %L, 2, 0) returning id$q$,
               (wd + time '18:00') at time zone 'Asia/Manila', (wd + time '19:00') at time zone 'Asia/Manila'))::uuid;
  perform t.eq(t.run(a, format($q$select (register('dance', %L)).status$q$, dc)), 'confirmed', 'member books a dance class');
  perform t.eq(t.run(a, $q$select (my_rewards()->>'balance')::numeric::text$q$), '2.66', 'a dance class adds 1 point');
  r := t.run(b, format($q$select (register('dance', %L)).id$q$, dc))::uuid;
  perform t.run(a, format($q$select register('dance', %L)$q$, dc), 'ALREADY_REGISTERED');
  perform t.run(adm, format('update dance_sessions set capacity = 3 where id = %L returning 1', dc));
  perform t.eq(t.run(null, format($q$select taken from signup_counts() where target = %L$q$, dc)), '2', 'slots taken shown publicly');
  perform t.run(b, format('select cancel_registration(%L)', r));
  perform t.eq(t.run(b, $q$select (my_rewards()->>'balance')::numeric::text$q$), '0.33', 'cancelling a class removes its point (0.33 left from a 1-hour booking)');

  raise notice '--- counter: purchases and rewards';
  perform t.run(a, format($q$select admin_award_points(%L, 450)$q$, code_a), 'FORBIDDEN');
  perform t.eq(t.run(adm, format($q$select (admin_award_points(%L, 450))->>'points'$q$, code_a)), '2', '₱450 purchase = 2 points (1 per ₱200)');
  perform t.run(adm, format($q$select admin_award_points(%L, 150)$q$, code_a), 'TOO_SMALL');
  perform t.eq(t.run(adm, format($q$select admin_member_lookup(%L)->>'name'$q$, 'YEPJO-MEMBER:' || code_a)), 'Ana Cruz', 'scanned QR text finds the member');
  perform t.run(adm, $q$select admin_member_lookup('YJZZZZZZZZ')$q$, 'NOT_FOUND');
  perform t.eq(t.run(adm, format($q$select (admin_redeem_reward(%L, (select id from rewards where title = 'Free coffee')))->>'balance'$q$, code_a)),
               '1.66', 'redeeming a 3-point reward deducts it');
  perform t.run(adm, format($q$select admin_redeem_reward(%L, (select id from rewards where title = 'Free 1 hour court'))$q$, code_a), 'NOT_ENOUGH_POINTS');
  perform t.run(a, $q$select admin_redeem_reward('x', gen_random_uuid())$q$, 'FORBIDDEN');
  perform t.run(a, $q$insert into points_ledger (user_id, points, source) values (auth.uid(), 100, 'manual') returning 1$q$, 'permission denied');
  perform t.run(adm, format($q$select admin_award_points(%L, null, -50)$q$, code_a), 'NOT_ENOUGH_POINTS');
  perform t.eq((select count(*)::text from activity_logs where action in ('points.award', 'points.redeem')), '2', 'counter actions are logged');
  raise notice '=== PORTAL CHECKS PASSED ===';
end $$;
rollback;
