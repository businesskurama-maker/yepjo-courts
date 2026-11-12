-- Sales report checks (run against a test database; everything is rolled back).
-- Expected Nov 2026: revenue 1500 (R2 900 venue + R7 600 online), 2 bookings, 5 hours,
-- 1 cancelled (600), 1 payment to check (300), prev month 900 (R1 600 + R3 300, R3 is Oct 31's night).
begin;
insert into auth.users(id,email) values ('00000000-0000-0000-0000-0000000000a1','adm@x.com'),('00000000-0000-0000-0000-0000000000c1','cus@x.com');
insert into admins(user_id) values ('00000000-0000-0000-0000-0000000000a1');
insert into reservations(reference,court_id,kind,status,starts_at,ends_at,customer_name,user_id,amount,payment_method,payment_status,hold_expires_at) values
 ('R1',1,'online','confirmed','2026-10-15 18:00+08','2026-10-15 20:00+08','Ana','00000000-0000-0000-0000-0000000000c1',600,'online','verified',null),
 ('R2',1,'online','confirmed','2026-11-03 18:00+08','2026-11-03 21:00+08','Ana','00000000-0000-0000-0000-0000000000c1',900,'venue','not_required',null),
 ('R3',2,'walk_in','confirmed','2026-11-01 00:00+08','2026-11-01 01:00+08','Ben',null,300,'venue','not_required',null),
 ('R4',2,'online','cancelled','2026-11-05 18:00+08','2026-11-05 20:00+08','Cy',null,600,'venue','not_required',null),
 ('R5',3,'online','pending','2026-11-06 18:00+08','2026-11-06 19:00+08','Di',null,300,'online','submitted',now()+interval '1 hour'),
 ('R6',3,'block','confirmed','2026-11-07 12:00+08','2026-11-07 18:00+08',null,null,null,'venue','not_required',null),
 ('R7',6,'online','confirmed','2026-11-30 23:00+08','2026-12-01 01:00+08','Ed',null,600,'online','verified',null);
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}',true);
savepoint s;
\set ON_ERROR_STOP 0
select admin_sales_report('2026-11-01');
rollback to s;
\set ON_ERROR_STOP 1
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
select jsonb_pretty(r->'totals') from (select admin_sales_report('2026-11-15') r) q;
select 'daily>0: ' || (select string_agg((x->>'date') || '=' || (x->>'revenue'), ', ') from jsonb_array_elements(admin_sales_report('2026-11-01')->'daily') x where (x->>'revenue')::numeric > 0);
select 'sports: ' || (admin_sales_report('2026-11-01')->'sports')::text;
select 'nov rows: ' || (select string_agg((x->>'reference')||':'||(x->>'date')||':'||(x->>'status'), ' ') from jsonb_array_elements(admin_sales_report('2026-11-01')->'rows') x);
select 'oct rows: ' || (select string_agg((x->>'reference')||':'||(x->>'date'), ' ') from jsonb_array_elements(admin_sales_report('2026-10-01')->'rows') x);
select 'days in nov: ' || jsonb_array_length(admin_sales_report('2026-11-01')->'daily');
rollback;
