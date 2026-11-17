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
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); adm uuid := gen_random_uuid();
  c1 int; r uuid; o uuid; o2 uuid; tapa uuid; latte uuid; cookie uuid; v text;
begin
  select id into c1 from courts where sport = 'pickleball' and name = 'Court 1';
  insert into auth.users (id, email, raw_user_meta_data) values (a, 'ana@example.com', '{}'), (b, 'ben@example.com', '{}'), (adm, 'owner@example.com', '{}');
  perform t.run(a, $q$select (save_profile('Ana Cruz', '09171234567')).phone$q$);
  perform t.run(b, $q$select (save_profile('Ben Reyes', '09181234567')).phone$q$);
  insert into admins (user_id) values (adm);

  raise notice '--- cancellation fee';
  r := t.run(a, format('select (book_court(%s, %s, 120, true)).id', c1, t.slot(3, '18:00')))::uuid;
  perform t.run(a, format('select submit_payment(%L, %L)', r, '111111'));
  perform t.run(adm, format('select admin_review_payment(%L, true)', r));
  perform t.eq(t.run(a, format($q$select cancel_fee || '/' || refund_amount || '/' || refund_status from cancel_reservation(%L)$q$, r)),
               '300.00/300.00/to_claim', 'paid ₱600 booking: ₱300 fee kept, ₱300 to claim at Yepjo');
  r := t.run(a, format('select (book_court(%s, %s, 60)).id', c1, t.slot(3, '10:00')))::uuid;
  perform t.eq(t.run(a, format($q$select coalesce(cancel_fee::text, 'none') || '/' || refund_status from cancel_reservation(%L)$q$, r)),
               'none/none', 'pay-at-venue booking (nothing paid): no fee, no refund');
  r := t.run(a, format('select (book_court(%s, %s, 60, true)).id', c1, t.slot(4, '10:00')))::uuid;
  perform t.run(a, format('select submit_payment(%L, %L)', r, '222222'));
  perform t.run(adm, format('select admin_review_payment(%L, true)', r));
  perform t.eq(t.run(adm, format($q$select cancel_fee || '/' || refund_amount from cancel_reservation(%L, 'Yepjo closed', true)$q$, r)),
               '0.00/300.00', 'Yepjo cancels with full refund');
  insert into reservations (reference, court_id, user_id, kind, status, starts_at, ends_at, customer_name)
  values (_new_reference(), c1, a, 'online', 'confirmed', date_trunc('hour', now()) + interval '3 hours', date_trunc('hour', now()) + interval '4 hours', 'Ana Cruz')
  returning id into r;                                                                                      -- starts in 3 hours
  perform t.run(a, format('select cancel_reservation(%L)', r), 'CANCEL_NOT_ALLOWED');
  perform t.eq(t.run(adm, 'select count(*) from admin_refunds_to_claim()'), '2', 'refunds waiting at the counter');
  perform t.run(a, 'select count(*) from admin_refunds_to_claim()', 'FORBIDDEN');
  r := (select id from reservations where refund_status = 'to_claim' order by created_at limit 1);
  perform t.run(a, format($q$select admin_mark_refund_claimed('reservation', %L)$q$, r), 'FORBIDDEN');
  perform t.run(adm, format($q$select admin_mark_refund_claimed('reservation', %L)$q$, r));
  perform t.run(adm, format($q$select admin_mark_refund_claimed('reservation', %L)$q$, r), 'NOT_FOUND');
  perform t.eq(t.run(adm, 'select count(*) from admin_refunds_to_claim()'), '1', 'claimed refund leaves the list');

  raise notice '--- cafe orders';
  select id into tapa from cafe_items where name = 'Tapsilog';
  select id into latte from cafe_items where name = 'Iced Caramel Macchiato';
  select id into cookie from cafe_items where name = 'Chocolate Chip Cookies';
  perform t.run(a, format($q$select place_cafe_order('[{"id":"%s","qty":1}]')$q$, tapa), 'not available to order');   -- no price yet
  update cafe_items set price = 180 where id = tapa; update cafe_items set price = 140 where id = latte;
  update cafe_items set price = 60, is_available = false where id = cookie;
  perform t.run(a, format($q$select place_cafe_order('[{"id":"%s","qty":2}]')$q$, cookie), 'not available');
  perform t.run(a, format($q$select place_cafe_order('[{"id":"%s","qty":0}]')$q$, tapa), 'Quantities');
  perform t.run(a, $q$select place_cafe_order('[]')$q$, 'empty');
  perform t.run(null, format($q$select place_cafe_order('[{"id":"%s","qty":1}]')$q$, tapa), 'permission denied');
  o := t.run(a, format($q$select (place_cafe_order('[{"id":"%s","qty":2,"price":1},{"id":"%s","qty":1}]', null, 'Less rice')).id$q$, tapa, latte))::uuid;
  perform t.eq((select status || '/' || payment_status || '/' || total from cafe_orders where id = o), 'pending/unpaid/500.00',
               'order total priced on the server (2×180 + 140), waiting for payment');
  perform t.run(a, format($q$select place_cafe_order('[{"id":"%s","qty":1}]', now() + interval '5 minutes')$q$, tapa), 'INVALID_PICKUP');
  perform t.run(a, format($q$select place_cafe_order('[{"id":"%s","qty":1}]', now() + interval '8 days')$q$, tapa), 'INVALID_PICKUP');
  o2 := t.run(a, format($q$select (place_cafe_order('[{"id":"%s","qty":1}]', now() + interval '2 hours')).id$q$, latte))::uuid;
  perform t.run(a, format('select cancel_cafe_order(%L)', o2));
  perform t.eq((select status from cafe_orders where id = o2), 'cancelled', 'unpaid order can be cancelled by the customer');
  update settings set cafe_opens = '07:00', cafe_closes = '08:00' where id;
  perform t.run(a, format($q$select place_cafe_order('[{"id":"%s","qty":1}]', %L)$q$, tapa,
                ((now() at time zone 'Asia/Manila')::date + 2 + time '12:00') at time zone 'Asia/Manila'), 'opening hours');
  update settings set cafe_opens = '00:00', cafe_closes = '00:00' where id;
  perform t.run(adm, format($q$select admin_set_order_status(%L, 'preparing')$q$, o), 'NOT_PAID');
  perform t.run(a, format('select submit_order_payment(%L, %L)', o, '765432'));
  perform t.run(a, format('select cancel_cafe_order(%L)', o), 'CANCEL_NOT_ALLOWED');
  perform t.eq(t.run(b, format('select count(*) from cafe_orders where id = %L', o)), '0', 'other members cannot see the order');
  perform t.run(b, format('select admin_review_order(%L, true)', o), 'FORBIDDEN');
  perform t.eq(t.run(adm, format('select (admin_review_order(%L, true)).status', o)), 'paid', 'admin approves payment: order goes to the kitchen');
  perform t.eq(t.run(a, $q$select (my_rewards()->>'balance')::numeric::text$q$), '2.33', '₱500 order = 2 points (on top of 0.33 from a 1-hour booking)');
  perform t.eq(t.run(adm, format($q$select (admin_set_order_status(%L, 'preparing')).status$q$, o)), 'preparing', 'preparing');
  perform t.eq(t.run(adm, format($q$select (admin_set_order_status(%L, 'ready')).status$q$, o)), 'ready', 'ready for pickup');
  perform t.eq(t.run(adm, format($q$select refund_amount || '/' || refund_status from admin_set_order_status(%L, 'cancelled', 'Out of stock')$q$, o)),
               '500.00/to_claim', 'paid order cancelled by Yepjo: full refund at the counter');
  perform t.eq(t.run(a, $q$select (my_rewards()->>'balance')::numeric::text$q$), '0.33', 'points from a cancelled order are taken back');
  perform t.run(adm, format($q$select admin_set_order_status(%L, 'ready')$q$, o), 'already');
  perform t.eq(t.run(adm, 'select count(*) from admin_refunds_to_claim()'), '2', 'cafe refund listed too');
  perform t.eq(t.run(adm, format($q$select (admin_report_extras(current_date)->>'cancel_fees')::numeric::text$q$)), '300.00', 'report: cancellation fees kept');
  update settings set payment_qr_path = null where id;
  perform t.run(a, format($q$select place_cafe_order('[{"id":"%s","qty":1}]')$q$, tapa), 'ORDERING_CLOSED');
  raise notice '=== CANCEL FEE AND CAFE ORDER CHECKS PASSED ===';
end $$;
rollback;
