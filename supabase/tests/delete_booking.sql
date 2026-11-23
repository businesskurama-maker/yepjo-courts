-- Staff delete an active booking; the activity log keeps the record.
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
declare a uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); c1 int; r uuid; w uuid; b uuid; ref text;
begin
  select id into c1 from courts where sport = 'pickleball' and name = 'Court 1';
  insert into auth.users (id, email, raw_user_meta_data) values (a, 'ana@example.com', '{}'), (adm, 'owner@example.com', '{}');
  perform t.run(a, $q$select (save_profile('Ana Cruz', '09171234567')).phone$q$);
  perform t.run(adm, $q$select (save_profile('Staff Mia', '09181234567')).phone$q$);
  insert into admins (user_id) values (adm);
  update settings set rewards_enabled = true, points_court_hours = 1 where id;

  r := t.run(a, format('select (book_court(%s, %s, 120)).id', c1, t.slot(2, '10:00')))::uuid;
  select reference into ref from reservations where id = r;
  perform t.eq((select sum(points)::text from points_ledger where user_id = a), '2.00', 'points earned for the booking');
  perform t.run(a, format('select admin_delete_reservation(%L)', r), 'FORBIDDEN');
  perform t.run(a, format('delete from reservations where id = %L returning id', r), 'permission denied');
  perform t.eq((select count(*)::text from reservations where id = r), '1', 'a customer cannot delete rows directly');
  perform t.eq(t.run(adm, format($q$select admin_delete_reservation(%L, 'Double booking')->>'reference'$q$, r)), ref, 'admin deletes an active booking');
  perform t.eq((select count(*)::text from reservations where id = r), '0', 'row is gone');
  perform t.eq((select sum(points)::text from points_ledger where user_id = a), '0.00', 'points taken back');
  perform t.eq((select actor_email || ' | ' || (details->>'customer') || ' | ' || (details->>'reason') || ' | ' || (details->>'deleted_by') || ' | ' || (details->>'amount')
                  from activity_logs where action = 'reservation.delete' and entity_id = r::text),
               'owner@example.com | Ana Cruz | Double booking | Staff Mia | 600.00', 'activity log keeps who, what and why');
  perform t.eq((select (details->>'label') like ref || ' · Ana Cruz · Court 1 · % · 600.00 · deleted by Staff Mia · Double booking' from activity_logs where action = 'reservation.delete' and entity_id = r::text)::text, 'true', 'readable log line');
  perform t.run(adm, format('select admin_delete_reservation(%L)', r), 'NOT_FOUND');
  perform t.run(a, format('select (book_court(%s, %s, 120)).id', c1, t.slot(2, '10:00')));   -- slot is open again

  w := t.run(adm, format($q$select id from admin_create_reservations(array[%s], %s, %s, 'walk_in', 'Juan', null, null, 'cash')$q$, c1, t.slot(2, '14:00'), t.slot(2, '15:00')))::uuid;
  perform t.eq(t.run(adm, format($q$select admin_delete_reservation(%L)->>'was_paid'$q$, w)), 'true', 'paid walk-in can be deleted, flagged as paid');
  perform t.eq((select (details->>'label') like '%300.00 (paid) · deleted by Staff Mia' from activity_logs where action = 'reservation.delete' and entity_id = w::text)::text, 'true', 'log notes it was paid');
  b := t.run(adm, format($q$select id from admin_create_reservations(array[%s], %s, %s, 'block', null, null, 'Net repair')$q$, c1, t.slot(3, '14:00'), t.slot(3, '15:00')))::uuid;
  perform t.run(adm, format('select admin_delete_reservation(%L)', b));
  perform t.eq((select details->>'label' like '% · Net repair · Court 1 · %' from activity_logs where action = 'reservation.delete' and entity_id = b::text)::text, 'true', 'block delete logged');

  -- done and cancelled bookings stay
  w := t.run(adm, format($q$select id from admin_create_reservations(array[%s], %s, %s, 'walk_in', 'Old', null, null, 'cash')$q$, c1, t.slot(4, '14:00'), t.slot(4, '15:00')))::uuid;
  update reservations set starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours' where id = w;
  perform t.run(adm, format('select admin_delete_reservation(%L)', w), 'already done');
  r := t.run(a, format('select (book_court(%s, %s, 60)).id', c1, t.slot(5, '10:00')))::uuid;
  perform t.run(a, format('select cancel_reservation(%L)', r));
  perform t.run(adm, format('select admin_delete_reservation(%L)', r), 'already cancelled');
  perform t.eq((select count(*)::text from activity_logs where action = 'reservation.delete'), '3', 'three deletions logged');
  raise notice '=== DELETE BOOKING CHECKS PASSED ===';
end $$;
rollback;
