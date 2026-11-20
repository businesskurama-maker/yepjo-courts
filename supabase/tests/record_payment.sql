-- Recording payments received at the court.
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
declare
  a uuid := gen_random_uuid(); adm uuid := gen_random_uuid();
  c1 int; c2 int; r uuid; w uuid; b uuid; m text := to_char((now() at time zone 'Asia/Manila')::date + 2, 'YYYY-MM-01'); v text;
begin
  select id into c1 from courts where sport = 'pickleball' and name = 'Court 1';
  select id into c2 from courts where sport = 'pickleball' and name = 'Court 2';
  insert into auth.users (id, email, raw_user_meta_data) values (a, 'ana@example.com', '{}'), (adm, 'owner@example.com', '{}');
  perform t.run(a, $q$select (save_profile('Ana Cruz', '09171234567')).phone$q$);
  perform t.run(adm, $q$select (save_profile('Staff Mia', '09181234567')).phone$q$);
  insert into admins (user_id) values (adm);

  raise notice '--- walk-in, collect later';
  w := t.run(adm, format($q$select id from admin_create_reservations(array[%s], %s, %s, 'walk_in', 'Juan Cruz', null, null)$q$, c1, t.slot(2, '10:00'), t.slot(2, '12:00')))::uuid;
  perform t.eq((select amount || '/' || payment_status from reservations where id = w), '600.00/not_required', 'walk-in saved, not paid yet');
  perform t.eq(t.run(adm, 'select count(*) || $x$/$x$ || sum(due) from admin_payments_due(4)'), '1/600.00', 'on the to-collect list');
  perform t.run(a, format('select admin_record_payment(%L)', w), 'FORBIDDEN');
  perform t.run(adm, format('select admin_record_payment(%L, null, $x$bitcoin$x$)', w), 'INVALID_REQUEST');
  perform t.eq(t.run(adm, format($q$select amount || '/' || payment_status || '/' || paid_via || '/' || paid_by_name from admin_record_payment(%L, null, 'gcash', 'ref 1234')$q$, w)),
               '600.00/verified/gcash/Staff Mia', 'payment recorded with staff name');
  perform t.run(adm, format('select admin_record_payment(%L)', w), 'ALREADY_PAID');
  perform t.eq((select actor_email || ' | ' || (details->>'label') from activity_logs where action = 'payment.received' and entity_id = w::text),
               'owner@example.com | ' || (select reference from reservations where id = w) || ' · Juan Cruz · 600.00 GCash · received by Staff Mia', 'activity log says who received it');
  perform t.eq(t.run(adm, 'select count(*) from admin_payments_due(4)'), '0', 'no longer to collect');

  raise notice '--- walk-in paid on the spot';
  r := t.run(adm, format($q$select id from admin_create_reservations(array[%s], %s, %s, 'walk_in', 'Lia', null, null, 'cash')$q$, c2, t.slot(2, '10:00'), t.slot(2, '11:00')))::uuid;
  perform t.eq((select payment_status || '/' || paid_via || '/' || paid_amount from reservations where id = r), 'verified/cash/300.00', 'paid at once');
  perform t.eq((select count(*)::text from activity_logs where action = 'payment.received' and entity_id = r::text), '1', 'logged');

  raise notice '--- pay-at-the-court online booking, different amount received';
  r := t.run(a, format('select (book_court(%s, %s, 60)).id', c1, t.slot(2, '14:00')))::uuid;
  perform t.eq(t.run(adm, 'select count(*) || $x$/$x$ || sum(due) from admin_payments_due(4)'), '1/300.00', 'venue booking is to collect');
  perform t.eq(t.run(adm, format($q$select amount || '/' || paid_amount from admin_record_payment(%L, 250, 'cash')$q$, r)), '250.00/250.00', 'sale follows the amount received');
  perform t.eq(t.run(a, format($q$select cancel_fee || '/' || refund_amount from cancel_reservation(%L)$q$, r)), '125.00/125.00', 'paid at court then cancelled: fee and refund');

  raise notice '--- extension interplay';
  r := t.run(adm, format($q$select id from admin_create_reservations(array[%s], %s, %s, 'walk_in', 'Paolo', null, null)$q$, c1, t.slot(2, '16:00'), t.slot(2, '17:00')))::uuid;
  perform t.run(adm, format('select (admin_extend_reservation(%L, 60, true)).id', r));      -- extra hour paid already
  perform t.eq(t.run(adm, 'select sum(due) from admin_payments_due(4)'), '300.00', 'only the first hour is still due');
  perform t.run(adm, format('select (admin_extend_reservation(%L, 60, false)).id', r));     -- another hour, unpaid
  perform t.eq(t.run(adm, 'select sum(due) from admin_payments_due(4)'), '600.00', 'base + unpaid extension due');
  perform t.eq(t.run(adm, format($q$select amount || '/' || paid_amount || '/' || extra_unpaid from admin_record_payment(%L)$q$, r)), '900.00/600.00/0.00', 'collects what is due, clears the unpaid extension');
  perform t.run(adm, format('select (admin_extend_reservation(%L, 60, false)).id', r));
  perform t.run(adm, format('select (admin_mark_extension_paid(%L)).id', r));
  perform t.eq((select details->>'label' from activity_logs where action = 'reservation.extension_paid' and entity_id = r::text),
               (select reference from reservations where id = r) || ' · Paolo · 300.00 for extra time · received by Staff Mia', 'extension payment log');

  raise notice '--- block made for a customer';
  b := t.run(adm, format($q$select id from admin_create_reservations(array[%s], %s, %s, 'block', null, null, 'Reserved for Mr. Santos')$q$, c2, t.slot(2, '18:00'), t.slot(2, '20:00')))::uuid;
  perform t.eq(t.run(adm, 'select count(*) from admin_payments_due(4)'), '0', 'a block is never on the to-collect list');
  perform t.run(adm, format('select admin_record_payment(%L)', b), 'INVALID_REQUEST');
  perform t.eq(t.run(adm, format($q$select kind || '/' || customer_name || '/' || amount || '/' || payment_status from admin_record_payment(%L, null, 'cash', null, 'Mr. Santos', '0917')$q$, b)),
               'walk_in/Mr. Santos/600.00/verified', 'block becomes a paid walk-in at the court price');
  b := t.run(adm, format($q$select id from admin_create_reservations(array[%s], %s, %s, 'block', null, null, 'Tournament')$q$, c2, t.slot(5, '08:00'), t.slot(7, '08:00')))::uuid;
  perform t.run(adm, format($q$select admin_record_payment(%L, 5000, 'cash', null, 'Club')$q$, b), 'INVALID_DURATION');
  r := t.run(a, format('select (book_court(%s, %s, 60, true)).id', c1, t.slot(3, '10:00')))::uuid;
  perform t.run(adm, format('select admin_record_payment(%L)', r), 'INVALID_REQUEST');

  raise notice '--- sales report';
  v := t.run(adm, format($q$select (t->>'revenue') || '/' || (t->>'collected') || '/' || (t->>'to_collect') || '/' || (t->>'to_collect_count') from (select admin_sales_report(%L)->'totals' as t) q$q$, m));
  perform t.eq(v, '2700.00/2700.00/0/0', 'everything collected: 600 + 300 + 1200 + 600');
  r := t.run(a, format('select (book_court(%s, %s, 60)).id', c1, t.slot(2, '21:00')))::uuid;
  v := t.run(adm, format($q$select (t->>'revenue') || '/' || (t->>'collected') || '/' || (t->>'to_collect') || '/' || (t->>'to_collect_count') from (select admin_sales_report(%L)->'totals' as t) q$q$, m));
  perform t.eq(v, '3000.00/2700.00/300.00/1', 'unpaid venue booking shows as to collect');
  perform t.eq(t.run(adm, format($q$select (x->>'paid_via') || '/' || (x->>'received_by') || '/' || (x->>'due') from jsonb_array_elements(admin_sales_report(%L)->'rows') x where x->>'reference' = %L$q$, m, (select reference from reservations where id = w))),
               'gcash/Staff Mia/0', 'report row shows how it was paid and who received it');
  raise notice '=== RECORD PAYMENT CHECKS PASSED ===';
end $$;
rollback;
