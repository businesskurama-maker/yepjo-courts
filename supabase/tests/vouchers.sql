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
declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); c1 int; r uuid; code text; r2 uuid;
begin
  select id into c1 from courts where sport = 'pickleball' and name = 'Court 1';
  insert into auth.users (id, email, raw_user_meta_data) values (a, 'ana@example.com', '{}'), (b, 'ben@example.com', '{}'), (adm, 'owner@example.com', '{}');
  perform t.run(a, $q$select (save_profile('Ana Cruz', '09171234567')).phone$q$);
  perform t.run(b, $q$select (save_profile('Ben Reyes', '09181234567')).phone$q$);
  insert into admins (user_id) values (adm);
  update settings set online_payment_enabled = true, payment_qr_path = 'payments/x.webp';
  perform t.run(a, $q$select admin_create_vouchers('percent', 20)$q$, 'FORBIDDEN');
  perform t.run(adm, $q$select admin_create_vouchers('percent', 120)$q$, 'INVALID_REQUEST');
  perform t.eq(t.run(adm, $q$select count(*)::text from admin_create_vouchers('amount', 100, 5, 'Partners')$q$), '5', 'five codes generated');
  perform t.eq(t.run(adm, $q$select code from admin_create_vouchers('percent', 20, 1, 'For Ana', 1, null, 'ana-20')$q$), 'ANA-20', 'custom code upper-cased');
  perform t.run(adm, $q$select admin_create_vouchers('percent', 20, 1, null, 1, null, 'ANA-20')$q$, 'INVALID_REQUEST');
  perform t.eq(t.run(a, $q$select count(*)::text from vouchers$q$), '0', 'customers cannot list vouchers');
  perform t.run(a, format('select check_voucher(%L, %s, %s, 120)', 'NOPE', c1, t.slot(3, '18:00')), 'VOUCHER_INVALID');
  perform t.eq(t.run(a, format($q$select (j->>'price') || '/' || (j->>'discount') || '/' || (j->>'total') from check_voucher(' ana-20 ', %s, %s, 120) j$q$, c1, t.slot(3, '18:00'))), '600.00/120.00/480.00', '20%% off 2 peak hours');
  perform t.run(a, format('select book_court_with_voucher(%s, %s, 120, true, %L)', c1, t.slot(3, '18:00'), 'NOPE'), 'VOUCHER_INVALID');
  perform t.eq((select count(*)::text from reservations), '0', 'bad code books nothing');
  r := t.run(a, format('select (book_court_with_voucher(%s, %s, 120, true, %L)).id', c1, t.slot(3, '18:00'), 'ana-20'))::uuid;
  perform t.eq((select amount || '/' || discount || '/' || voucher_code || '/' || status from reservations where id = r), '480.00/120.00/ANA-20/pending', 'booking holds the discounted amount');
  perform t.run(b, format('select check_voucher(%L, %s, %s, 60)', 'ANA-20', c1, t.slot(4, '18:00')), 'VOUCHER_INVALID');   -- single use, taken
  perform t.run(a, format('select cancel_reservation(%L)', r));
  perform t.eq(t.run(b, format($q$select check_voucher(%L, %s, %s, 60)->>'discount'$q$, 'ANA-20', c1, t.slot(4, '18:00'))), '60.00', 'cancelling gives the use back');
  -- fixed amount bigger than the price: free booking is confirmed straight away
  code := t.run(adm, $q$select code from admin_create_vouchers('amount', 1000, 1, 'VIP', null, null, 'VIP-FREE', true)$q$);
  r := t.run(a, format('select (book_court_with_voucher(%s, %s, 60, true, %L)).id', c1, t.slot(5, '10:00'), code))::uuid;
  perform t.eq((select amount || '/' || discount || '/' || status || '/' || payment_status from reservations where id = r), '0.00/300.00/confirmed/not_required', 'fully covered: confirmed, nothing to pay');
  perform t.run(a, format('select check_voucher(%L, %s, %s, 60)', code, c1, t.slot(6, '10:00')), 'VOUCHER_INVALID');         -- once per customer
  perform t.eq(t.run(b, format($q$select check_voucher(%L, %s, %s, 60)->>'total'$q$, code, c1, t.slot(6, '10:00'))), '0.00', 'unlimited code works for another customer');
  -- expiry and switch-off
  update vouchers set expires_on = (now() at time zone 'Asia/Manila')::date - 1 where vouchers.code = 'VIP-FREE';
  perform t.run(b, format('select check_voucher(%L, %s, %s, 60)', 'VIP-FREE', c1, t.slot(6, '10:00')), 'VOUCHER_INVALID');
  perform t.run(adm, $q$update vouchers set is_active = false where code = 'ANA-20' returning code$q$);
  perform t.run(b, format('select check_voucher(%L, %s, %s, 60)', 'ANA-20', c1, t.slot(4, '18:00')), 'VOUCHER_INVALID');
  -- extension keeps the discount
  perform t.run(adm, $q$select admin_create_vouchers('percent', 50, 1, null, 1, null, 'HALF')$q$);
  r2 := t.run(b, format('select (book_court_with_voucher(%s, %s, 60, false, %L)).id', c1, t.slot(7, '18:00'), 'HALF'))::uuid;
  perform t.eq(t.run(adm, format('select amount || %L || extra_amount || %L || discount from admin_extend_reservation(%L, 60, true)', '/', '/', r2)), '450.00/300.00/150.00', 'extension adds full price of the extra hour, discount kept');
  perform t.eq(t.run(adm, $q$select uses || '/' || discount_given from admin_vouchers() where code = 'HALF'$q$), '1/150.00', 'voucher list shows use and amount');
  perform t.eq(t.run(a, format('select (book_court_with_voucher(%s, %s, 60, false, null)).discount::text', c1, t.slot(8, '10:00'))), '0.00', 'no code = normal booking');
end $$;
rollback;
