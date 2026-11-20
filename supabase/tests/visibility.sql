-- Hiding the cafe page stops customer cafe orders.
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
declare a uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); tapa uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data) values (a, 'ana@example.com', '{}'), (adm, 'owner@example.com', '{}');
  perform t.run(a, $q$select (save_profile('Ana Cruz', '09171234567')).phone$q$);
  perform t.run(adm, $q$select (save_profile('Staff Mia', '09181234567')).phone$q$);
  insert into admins (user_id) values (adm);
  select id into tapa from cafe_items where name = 'Tapsilog';
  update cafe_items set price = 180 where id = tapa;
  update settings set cafe_opens = '00:00', cafe_closes = '00:00' where id;
  perform t.eq((select cafe_visible::text || '/' || rewards_visible::text from settings), 'true/true', 'both pages are public by default');
  perform t.run(a, format($q$select (place_cafe_order('[{"id":"%s","qty":1}]')).id$q$, tapa));
  perform t.run(a, 'update settings set cafe_visible = false, rewards_visible = false where id returning id');
  perform t.eq((select cafe_visible::text from settings), 'true', 'a customer cannot hide the page');
  perform t.eq(t.run(adm, 'update settings set cafe_visible = false, rewards_visible = false where id returning cafe_visible::text || rewards_visible::text'), 'falsefalse', 'admin hides both pages');
  perform t.run(a, format($q$select (place_cafe_order('[{"id":"%s","qty":1}]')).id$q$, tapa), 'CAFE_CLOSED');
  perform t.run(adm, format($q$select (place_cafe_order('[{"id":"%s","qty":1}]')).id$q$, tapa));
  perform t.run(adm, 'update settings set cafe_visible = true where id returning id');
  perform t.run(a, format($q$select (place_cafe_order('[{"id":"%s","qty":1}]')).id$q$, tapa));
  raise notice '=== VISIBILITY CHECKS PASSED ===';
end $$;
rollback;
