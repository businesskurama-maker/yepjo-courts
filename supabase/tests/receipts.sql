-- Paying online with a receipt screenshot; 30-day retention.
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
declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); adm uuid := gen_random_uuid();
  c1 int; r uuid; r2 uuid; o uuid; tapa uuid; pa text; pb text; v text;
begin
  select id into c1 from courts where sport = 'pickleball' and name = 'Court 1';
  insert into auth.users (id, email, raw_user_meta_data) values (a, 'ana@example.com', '{}'), (b, 'ben@example.com', '{}'), (adm, 'owner@example.com', '{}');
  perform t.run(a, $q$select (save_profile('Ana Cruz', '09171234567')).phone$q$);
  perform t.run(b, $q$select (save_profile('Ben Reyes', '09181234567')).phone$q$);
  perform t.run(adm, $q$select (save_profile('Staff Mia', '09191234567')).phone$q$);
  insert into admins (user_id) values (adm);
  update settings set online_payment_enabled = true, payment_qr_path = 'payments/qr.webp', cafe_opens = '00:00', cafe_closes = '00:00' where id;
  pa := a::text || '/booking-1.jpg'; pb := b::text || '/x.jpg';

  raise notice '--- storage rules';
  perform t.run(a, format($q$insert into storage.objects (bucket_id, name) values ('receipts', %L) returning name$q$, b::text || '/steal.jpg'), 'row-level security');
  perform t.run(a, format($q$insert into storage.objects (bucket_id, name) values ('receipts', %L) returning name$q$, pa));
  perform t.run(b, format($q$insert into storage.objects (bucket_id, name) values ('receipts', %L) returning name$q$, pb));
  perform t.eq(t.run(b, $q$select count(*) from storage.objects where bucket_id = 'receipts'$q$), '1', 'a customer sees only their own receipts');
  perform t.eq(t.run(adm, $q$select count(*) from storage.objects where bucket_id = 'receipts'$q$), '2', 'admin sees all receipts');

  raise notice '--- court booking';
  r := t.run(a, format('select (book_court(%s, %s, 60, true)).id', c1, t.slot(2, '10:00')))::uuid;
  perform t.run(a, format('select submit_payment(%L, %L)', r, '123456'), 'permission denied');
  perform t.run(a, format($q$select submit_payment_receipt('booking', %L, null)$q$, r), 'INVALID_RECEIPT');
  perform t.run(a, format($q$select submit_payment_receipt('booking', %L, %L)$q$, r, a::text || '/missing.jpg'), 'INVALID_RECEIPT');
  perform t.run(a, format($q$select submit_payment_receipt('booking', %L, %L)$q$, r, pb), 'INVALID_RECEIPT');
  perform t.run(b, format($q$select submit_payment_receipt('booking', %L, %L)$q$, r, pb), 'NOT_FOUND');
  perform t.eq(t.run(a, format($q$select (x->>'payment_status') || '/' || (x->>'payment_proof_path') from submit_payment_receipt('booking', %L, %L) x$q$, r, pa)),
               'submitted/' || pa, 'receipt sent, waiting for staff');
  perform t.run(a, format($q$select submit_payment_receipt('booking', %L, %L)$q$, r, pa), 'ALREADY_SUBMITTED');
  perform t.run(adm, format('select admin_review_payment(%L, false, %L)', r, 'Screenshot is blurry'));
  perform t.run(a, format($q$insert into storage.objects (bucket_id, name) values ('receipts', %L) returning name$q$, a::text || '/booking-2.jpg'));
  perform t.run(a, format($q$select submit_payment_receipt('booking', %L, %L)$q$, r, a::text || '/booking-2.jpg'));
  perform t.eq(t.run(adm, format('select (admin_review_payment(%L, true)).status', r)), 'confirmed', 'staff approve after viewing the screenshot');

  raise notice '--- cafe order and sign-up';
  select id into tapa from cafe_items where name = 'Tapsilog'; update cafe_items set price = 180 where id = tapa;
  o := t.run(a, format($q$select (place_cafe_order('[{"id":"%s","qty":1}]')).id$q$, tapa))::uuid;
  perform t.run(a, format($q$insert into storage.objects (bucket_id, name) values ('receipts', %L) returning name$q$, a::text || '/order-1.jpg'));
  perform t.eq(t.run(a, format($q$select x->>'payment_status' from submit_payment_receipt('order', %L, %L) x$q$, o, a::text || '/order-1.jpg')), 'submitted', 'cafe order receipt sent');
  perform t.run(a, format($q$select submit_payment_receipt('nonsense', %L, %L)$q$, o, a::text || '/order-1.jpg'), 'INVALID_REQUEST');

  raise notice '--- late receipt releases the court';
  r2 := t.run(a, format('select (book_court(%s, %s, 60, true)).id', c1, t.slot(3, '10:00')))::uuid;
  update reservations set hold_expires_at = now() - interval '1 minute' where id = r2;
  perform t.eq(t.run(a, format($q$select x->>'status' from submit_payment_receipt('booking', %L, %L) x$q$, r2, pa)), 'cancelled', 'late receipt is refused');

  raise notice '--- kept 30 days';
  perform t.run(a, 'select count(*) from admin_receipts_to_purge()', 'FORBIDDEN');
  perform t.eq(t.run(adm, 'select count(*) from admin_receipts_to_purge()'), '0', 'nothing to remove yet');
  update reservations set payment_verified_at = now() - interval '29 days' where id = r;
  perform t.eq(t.run(adm, 'select count(*) from admin_receipts_to_purge()'), '0', 'still kept on day 29');
  update reservations set payment_verified_at = now() - interval '31 days' where id = r;
  perform t.eq(t.run(adm, 'select string_agg(path, $x$,$x$) from admin_receipts_to_purge()'), a::text || '/booking-2.jpg', 'approved receipt is due on day 31');
  update storage.objects set created_at = now() - interval '40 days' where name in (pa, pb);   -- replaced / never used
  update cafe_orders set payment_proof_at = now() - interval '31 days' where id = o;           -- never approved
  perform t.eq(t.run(adm, 'select count(*) from admin_receipts_to_purge()'), '4', 'old unused files and unapproved receipts are due too');
  perform t.run(a, format('select admin_clear_receipts(array[%L])', pa), 'FORBIDDEN');
  perform t.eq(t.run(adm, format('select admin_clear_receipts(array[%L, %L])', a::text || '/booking-2.jpg', a::text || '/order-1.jpg')), '2', 'paths forgotten');
  perform t.eq((select coalesce(payment_proof_path, 'none') || '/' || status from reservations where id = r), 'none/confirmed', 'booking stays confirmed without the screenshot');
  perform t.eq((select details->>'label' from activity_logs where action = 'receipts.purge'), '2 payment screenshot(s) removed after 30 days', 'purge is logged');
  raise notice '=== RECEIPT CHECKS PASSED ===';
end $$;
rollback;
