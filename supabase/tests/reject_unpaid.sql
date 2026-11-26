-- Unpaid holds: staff reject or delete them, also after the payment time ran out.
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
declare a uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); c1 int; r uuid; r2 uuid; r3 uuid;
begin
  select id into c1 from courts where sport = 'pickleball' and name = 'Court 1';
  insert into auth.users (id, email, raw_user_meta_data) values (a, 'ana@example.com', '{}'), (adm, 'owner@example.com', '{}');
  perform t.run(a, $q$select (save_profile('Ana Cruz', '09171234567')).phone$q$);
  perform t.run(adm, $q$select (save_profile('Staff Mia', '09191234567')).phone$q$);
  insert into admins (user_id) values (adm);

  r := t.run(a, format('select (book_court(%s, %s, 60, true)).id', c1, t.slot(2, '10:00')))::uuid;
  update reservations set hold_expires_at = now() - interval '5 minutes' where id = r;     -- time ran out, still listed
  perform t.run(a, format('select admin_reject_reservation(%L)', r), 'FORBIDDEN');
  perform t.eq(t.run(adm, format($q$select status || '/' || cancel_reason from admin_reject_reservation(%L)$q$, r)), 'cancelled/Payment not received in time', 'expired hold rejected, kept as cancelled');
  perform t.eq((select details->>'label' like '% · Ana Cruz · Court 1 · % · not paid · rejected by Staff Mia' from activity_logs where action = 'reservation.reject' and entity_id = r::text)::text, 'true', 'rejection logged');
  perform t.run(adm, format('select admin_reject_reservation(%L)', r), 'INVALID_REQUEST');
  perform t.run(a, format('select (book_court(%s, %s, 60, true)).id', c1, t.slot(2, '10:00')));   -- court is open again

  r2 := t.run(a, format('select (book_court(%s, %s, 60, true)).id', c1, t.slot(3, '10:00')))::uuid;
  perform t.eq(t.run(adm, format($q$select cancel_reason from admin_reject_reservation(%L, 'Customer changed plans')$q$, r2)), 'Customer changed plans', 'reject with a reason, before the time is up');

  r3 := t.run(a, format('select (book_court(%s, %s, 60, true)).id', c1, t.slot(4, '10:00')))::uuid;
  update reservations set hold_expires_at = now() - interval '2 days', starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours' where id = r3;
  perform t.run(adm, format($q$select admin_delete_reservation(%L, 'Never paid')$q$, r3));
  perform t.eq((select count(*)::text from reservations where id = r3), '0', 'expired unpaid hold deleted even after its time slot passed');
  perform t.eq((select (details->>'reason') || '/' || (details->>'status') from activity_logs where action = 'reservation.delete' and entity_id = r3::text), 'Never paid/pending', 'deletion logged');

  r := t.run(a, format('select (book_court(%s, %s, 60)).id', c1, t.slot(5, '10:00')))::uuid;   -- confirmed, pay at court
  perform t.run(adm, format('select admin_reject_reservation(%L)', r), 'INVALID_REQUEST');
  update reservations set starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours' where id = r;
  perform t.run(adm, format('select admin_delete_reservation(%L)', r), 'already done');
  raise notice '=== REJECT UNPAID CHECKS PASSED ===';
end $$;
rollback;
