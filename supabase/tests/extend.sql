-- Cancellation fee + refunds at the venue, and Yepjo Cafe orders.
\set ON_ERROR_STOP 1
begin;
update public.court_hours set opens = '07:00', closes = '01:00', is_closed = false;
delete from public.closures; delete from public.court_rates; update public.courts set hourly_rate = 300;
update public.settings set max_active_bookings = 50, online_payment_enabled = true, payment_qr_path = 'payments/qr.webp', allow_pay_at_venue = true,
  cancel_cutoff_hours = 6, cancel_fee_percent = 50, cafe_opens = '00:00', cafe_closes = '00:00', cafe_prep_minutes = 15,
  points_purchase_amount = 200, rewards_enabled = true where id;
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

do $$
declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); c1 int; r uuid; r2 uuid;
begin
  select id into c1 from courts where sport = 'pickleball' and name = 'Court 1';
  insert into auth.users (id, email, raw_user_meta_data) values (a, 'ana@example.com', '{}'), (b, 'ben@example.com', '{}'), (adm, 'owner@example.com', '{}');
  perform t.run(a, $q$select (save_profile('Ana Cruz', '09171234567')).phone$q$);
  perform t.run(b, $q$select (save_profile('Ben Reyes', '09181234567')).phone$q$);
  insert into admins (user_id) values (adm);
  r := t.run(a, format('select (book_court(%s, %s, 60)).id', c1, t.slot(3, '18:00')))::uuid;      -- 6-7 PM
  r2 := t.run(b, format('select (book_court(%s, %s, 60)).id', c1, t.slot(3, '21:00')))::uuid;    -- 9-10 PM
  perform t.run(b, format('select request_extension(%L, 60)', r), 'NOT_FOUND');
  perform t.run(a, format('select admin_extend_reservation(%L, 60, true)', r), 'FORBIDDEN');
  perform t.run(a, format('select request_extension(%L, 30)', r), 'INVALID_DURATION');
  perform t.eq(t.run(a, format('select extend_request_minutes::text from request_extension(%L, 60)', r)), '60', 'customer asks for 1 more hour');
  perform t.eq(t.run(adm, format($q$select to_char(ends_at at time zone 'Asia/Manila','HH24:MI') || '/' || amount || '/' || extra_amount || '/' || extra_unpaid || '/' || coalesce(extend_request_minutes::text,'none') from admin_extend_reservation(%L, 60, false)$q$, r)),
               '20:00/600.00/300.00/300.00/none', 'staff approve, not paid yet: ends 8 PM, ₱300 owed, request cleared');
  perform t.eq(t.run(adm, format('select extra_unpaid::text from admin_mark_extension_paid(%L)', r)), '0.00', 'marked paid');
  perform t.eq(t.run(adm, format($q$select to_char(ends_at at time zone 'Asia/Manila','HH24:MI') || '/' || extra_unpaid from admin_extend_reservation(%L, 60, true)$q$, r)), '21:00/0.00', 'extend again, paid');
  perform t.run(adm, format('select admin_extend_reservation(%L, 60, true)', r), 'SLOT_TAKEN');
  perform t.run(a, format('select request_extension(%L, 60)', r), 'SLOT_TAKEN');
  perform t.run(adm, format('select admin_extend_reservation(%L, 240, true)', r2), 'OUTSIDE_HOURS');            -- 10 PM + 4h passes 1 AM
  perform t.eq(t.run(adm, format($q$select to_char(ends_at at time zone 'Asia/Manila','HH24:MI') from admin_extend_reservation(%L, 180, true)$q$, r2)), '01:00', 'extend to closing time');
  perform t.eq((select points::text from points_ledger where ref = r::text and source = 'court'), '1.00', 'points follow the 3-hour length');
  perform t.run(a, format('select cancel_reservation(%L)', r));
  perform t.run(adm, format('select admin_extend_reservation(%L, 60, true)', r), 'NOT_ALLOWED');
  r := t.run(a, format('select (book_court(%s, %s, 60)).id', c1, t.slot(4, '10:00')))::uuid;
  perform t.run(a, format('select request_extension(%L, 120)', r));
  perform t.eq(t.run(a, format($q$select coalesce(extend_request_minutes::text,'none') from clear_extension_request(%L)$q$, r)), 'none', 'customer withdraws request');
  perform t.eq((select count(*)::text from storage.buckets where id = 'photos' and 'image/jpeg' = any (allowed_mime_types)), '1', 'bucket accepts JPEG');
end $$;
rollback;
