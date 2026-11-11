-- Online QR payment rules. Runs in one transaction and rolls back.
-- Requires verify.sql's helper style; self-contained here.
\set ON_ERROR_STOP 1
begin;
create schema tp;

create function tp.run(p_uid uuid, p_sql text, p_expect text default null) returns text
language plpgsql as $$
declare v_err text := null; v_res text;
begin
  perform set_config('request.jwt.claims',
    case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true);
  perform set_config('role', case when p_uid is null then 'anon' else 'authenticated' end, true);
  begin execute p_sql into v_res; exception when others then v_err := sqlerrm; end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  if p_expect is null and v_err is not null then raise exception 'UNEXPECTED ERROR [%]: %', p_sql, v_err; end if;
  if p_expect is not null and (v_err is null or v_err not like '%' || p_expect || '%') then
    raise exception 'EXPECTED "%" but got "%" [%]', p_expect, coalesce(v_err, 'success → ' || coalesce(v_res, 'null')), p_sql;
  end if;
  raise notice 'ok  %  %', rpad(coalesce(p_expect, 'success'), 20), left(regexp_replace(p_sql, '\s+', ' ', 'g'), 90);
  return v_res;
end $$;
create function tp.eq(p_got text, p_want text, p_label text) returns void language plpgsql as $$
begin
  if p_got is distinct from p_want then raise exception 'FAILED %: got "%", wanted "%"', p_label, p_got, p_want; end if;
  raise notice 'ok  %  %', rpad('= ' || coalesce(p_want, 'null'), 20), p_label;
end $$;
create function tp.slot(p_days int, p_time time) returns text language sql as $$
  select quote_literal((((now() at time zone 'Asia/Manila')::date + p_days + p_time) at time zone 'Asia/Manila')::text)
$$;

do $$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); adm uuid := gen_random_uuid();
  c1 int; c2 int; rid text; rid2 text; v text;
begin
  select id into c1 from courts where sport = 'pickleball' and name = 'Court 1';
  select id into c2 from courts where sport = 'pickleball' and name = 'Court 2';
  insert into auth.users (id, email) values (a, 'pa@example.com'), (b, 'pb@example.com'), (adm, 'padmin@example.com');
  update profiles set full_name = 'Payer', phone = '+639170000001', completed_at = now() where id in (a, b, adm);
  insert into admins (user_id) values (adm);

  raise notice '--- online payment is off until a QR is uploaded';
  perform tp.run(a, format('select book_court(%s, %s, 60, true)', c1, tp.slot(2, '14:00')), 'PAYMENT_UNAVAILABLE');
  perform tp.run(a, $q$update settings set online_payment_enabled = true returning 1$q$);  -- RLS: silently 0 rows for non-admin
  perform tp.eq((select online_payment_enabled::text from settings), 'false', 'non-admin cannot enable payments');
  perform tp.run(adm, $q$with x as (update settings set allow_pay_at_venue = false returning 1) select count(*) from x$q$, 'settings_payment_option_chk');
  perform tp.run(adm, $q$with x as (update settings set online_payment_enabled = true, payment_qr_path = 'payments/qr.webp',
                         payment_instructions = 'GCash 0917 000 0000 (Yepjo)', payment_hold_minutes = 30 returning 1) select count(*) from x$q$);

  raise notice '--- pending hold';
  rid := tp.run(a, format('select (book_court(%s, %s, 60, true)).id', c1, tp.slot(2, '14:00')));
  perform tp.eq((select status || '|' || payment_method || '|' || payment_status || '|' || (hold_expires_at > now() + interval '29 minutes')::text
                 from reservations where id = rid::uuid), 'pending|online|unpaid|true', 'online booking starts pending with a 30-min hold');
  perform tp.run(b, format('select book_court(%s, %s, 60)', c1, tp.slot(2, '14:00')), 'SLOT_TAKEN');
  perform tp.eq((select count(*)::text from get_availability(now(), now() + interval '5 days') where court_id = c1), '1', 'a live hold shows as busy');

  raise notice '--- submitting the reference';
  perform tp.run(b, format('select submit_payment(%L, %L)', rid, '123456'), 'NOT_FOUND');
  perform tp.run(a, format('select submit_payment(%L, %L)', rid, '12345'), 'INVALID_REFERENCE');
  perform tp.run(a, format('select submit_payment(%L, %L)', rid, 'abc123'), 'INVALID_REFERENCE');
  perform tp.run(a, format('select (submit_payment(%L, %L)).payment_status', rid, ' 9876-54 '));
  perform tp.eq((select payment_ref || '|' || payment_status from reservations where id = rid::uuid), '987654|submitted', 'reference normalised and stored');
  perform tp.run(a, format('select submit_payment(%L, %L)', rid, '111111'), 'ALREADY_SUBMITTED');
  perform tp.run(a, format('select cancel_reservation(%L)', rid), 'CANCEL_NOT_ALLOWED');
  -- even past the hold time, a submitted payment keeps the court
  update reservations set hold_expires_at = now() - interval '1 minute' where id = rid::uuid;
  perform tp.eq((select count(*)::text from get_availability(now(), now() + interval '5 days') where court_id = c1), '1', 'submitted payment keeps the court held');

  raise notice '--- admin review';
  perform tp.run(a, format('select admin_review_payment(%L, true)', rid), 'FORBIDDEN');
  perform tp.run(adm, format('select (admin_review_payment(%L, false, %L)).payment_status', rid, 'Amount did not match'));
  perform tp.eq((select status || '|' || payment_status || '|' || payment_note || '|' || (hold_expires_at > now())::text from reservations where id = rid::uuid),
                'pending|rejected|Amount did not match|true', 'rejected → still pending, new hold, note for customer');
  perform tp.run(a, format('select (submit_payment(%L, %L)).payment_status', rid, '555777'));
  perform tp.run(adm, format('select (admin_review_payment(%L, true)).status', rid));
  perform tp.eq((select status || '|' || payment_status || '|' || (hold_expires_at is null)::text from reservations where id = rid::uuid),
                'confirmed|verified|true', 'approved → confirmed');
  perform tp.run(adm, format('select admin_review_payment(%L, true)', rid), 'INVALID_REQUEST');
  perform tp.eq((select count(*)::text from activity_logs where action in ('payment.verify', 'payment.reject')), '2', 'reviews are logged');

  raise notice '--- abandoned holds expire and free the court';
  rid2 := tp.run(a, format('select (book_court(%s, %s, 120, true)).id', c2, tp.slot(3, '16:00')));
  update reservations set hold_expires_at = now() - interval '1 minute' where id = rid2::uuid;
  perform tp.eq((select count(*)::text from get_availability(now(), now() + interval '6 days') where court_id = c2), '0', 'expired hold no longer shown as busy');
  perform tp.eq(tp.run(a, format('select (submit_payment(%L, %L)).status', rid2, '123456')), 'cancelled', 'late reference is refused');
  perform tp.eq((select status from reservations where id = rid2::uuid), 'cancelled', 'late reference → booking released');
  -- another expired hold is cleared when someone else books the same time
  rid2 := tp.run(a, format('select (book_court(%s, %s, 60, true)).id', c2, tp.slot(4, '16:00')));
  update reservations set hold_expires_at = now() - interval '1 minute' where id = rid2::uuid;
  perform tp.run(b, format('select (book_court(%s, %s, 60)).status', c2, tp.slot(4, '16:00')));
  perform tp.eq((select status || '|' || cancel_reason from reservations where id = rid2::uuid), 'cancelled|Payment not received in time', 'stale hold cancelled, slot rebooked');
  -- walk-in over an expired hold works too
  rid2 := tp.run(a, format('select (book_court(%s, %s, 60, true)).id', c2, tp.slot(5, '18:00')));
  update reservations set hold_expires_at = now() - interval '1 minute' where id = rid2::uuid;
  perform tp.run(adm, format('select count(*) from admin_create_reservations(array[%s], %s, %s, %L, %L)', c2, tp.slot(5, '18:00'), tp.slot(5, '19:00'), 'walk_in', 'Walk-in'));

  raise notice '--- customer can cancel an unpaid hold any time';
  rid2 := tp.run(a, format('select (book_court(%s, %s, 60, true)).id', c2, tp.slot(6, '13:00')));
  perform tp.run(a, format('select (cancel_reservation(%L)).status', rid2));

  raise notice '--- pay at the court can be turned off';
  perform tp.run(adm, $q$with x as (update settings set allow_pay_at_venue = false returning 1) select count(*) from x$q$);
  perform tp.run(b, format('select book_court(%s, %s, 60)', c1, tp.slot(7, '13:00')), 'PAYMENT_REQUIRED');
  perform tp.run(b, format('select (book_court(%s, %s, 60, true)).status', c1, tp.slot(7, '13:00')));
  perform tp.run(adm, $q$with x as (update settings set payment_qr_path = null returning 1) select count(*) from x$q$, 'settings_payment_option_chk');

  raise notice '--- privacy';
  perform tp.eq(tp.run(b, format('select count(*) from reservations where id = %L', rid)), '0', 'other customers cannot see payment references');
  raise notice '=== PAYMENT CHECKS PASSED ===';
end $$;
rollback;
