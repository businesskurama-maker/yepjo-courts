-- Rule checks for the YEPJO schema. Runs inside one transaction and rolls back,
-- so it leaves no data behind. Each line prints "ok" or aborts with the reason.
-- Local run:  psql -d <db> -f supabase/tests/verify.sql
\set ON_ERROR_STOP 1
begin;
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
  c1 int; c2 int; c3 int; c4 int; bad1 int;
  v text; rid uuid; soon text; m1 uuid := gen_random_uuid(); ann uuid;
  today date := (now() at time zone 'Asia/Manila')::date;
  month_days int := ((today + interval '1 month')::date - today);
begin
  select id into c1 from courts where sport = 'pickleball' and name = 'Court 1';
  select id into c2 from courts where sport = 'pickleball' and name = 'Court 2';
  select id into c3 from courts where sport = 'pickleball' and name = 'Court 3';
  select id into c4 from courts where sport = 'pickleball' and name = 'Court 4';
  select id into bad1 from courts where sport = 'badminton' and name = 'Court 1';

  raise notice '--- seed data';
  perform t.eq((select count(*)::text from courts where sport = 'pickleball'), '5', 'pickleball courts seeded');
  perform t.eq((select count(*)::text from courts where sport = 'badminton'), '2', 'badminton courts seeded');
  perform t.eq((select count(*)::text from court_hours), '49', '7 weekday rows per court');

  raise notice '--- first Google login and profile completion';
  insert into auth.users (id, email, raw_user_meta_data) values
    (a, 'ana@example.com', '{"full_name":"Ana Cruz","avatar_url":"https://x/y.png"}'),
    (b, 'ben@example.com', '{"name":"Ben Reyes"}'),
    (adm, 'owner@example.com', '{}');
  perform t.eq((select full_name || '|' || email || '|' || (completed_at is null)::text from profiles where id = a),
               'Ana Cruz|ana@example.com|true', 'profile prefilled from Google, not yet complete');
  perform t.run(a, format('select book_court(%s, %s, 60)', c1, t.slot(1, '14:00')), 'PROFILE_INCOMPLETE');
  perform t.run(a, format('select send_message(%L, %L, %L)', gen_random_uuid(), a, 'hello'), 'PROFILE_INCOMPLETE');
  perform t.run(a, $q$select save_profile('Ana Cruz', '12345')$q$, 'INVALID_PHONE');
  perform t.run(a, $q$select save_profile('A', '09171234567')$q$, 'INVALID_NAME');
  perform t.run(a, $q$select (save_profile('  Ana   Cruz ', '0917 123-4567')).phone$q$);
  perform t.eq((select phone || '|' || full_name || '|' || (completed_at is not null)::text from profiles where id = a),
               '+639171234567|Ana Cruz|true', 'phone normalised, profile complete');
  perform t.run(a, $q$update profiles set email = 'evil@example.com' where id = auth.uid() returning 1$q$, 'permission denied');
  perform t.run(b, $q$select save_profile('Ben Reyes', '+63 918 555 0000')$q$);
  perform t.run(adm, $q$select save_profile('Yepjo Owner', '09170000000')$q$);
  perform t.run(null, $q$select save_profile('Guest', '09170000000')$q$, 'permission denied');

  raise notice '--- booking rules';
  v := t.run(a, format('select (book_court(%s, %s, 60)).reference', c1, t.slot(1, '14:00')));
  perform t.eq((v ~ '^YPJ-[A-Z2-9]{6}$')::text, 'true', 'booking reference format ' || v);
  perform t.run(b, format('select book_court(%s, %s, 60)', c1, t.slot(1, '14:00')), 'SLOT_TAKEN');
  perform t.run(b, format('select book_court(%s, %s, 120)', c1, t.slot(1, '13:00')), 'SLOT_TAKEN');
  perform t.run(b, format('select book_court(%s, %s, 60)', c1, t.slot(1, '15:00')));
  perform t.run(b, format('select book_court(%s, %s, 60)', c1, t.slot(-1, '14:00')), 'PAST_TIME');
  perform t.run(b, format('select book_court(%s, %s, 60)', c1, t.slot(1, '09:00')), 'OUTSIDE_HOURS');
  perform t.run(b, format('select book_court(%s, %s, 60)', c1, t.slot(1, '14:30')), 'OUTSIDE_HOURS');
  perform t.run(b, format('select book_court(%s, %s, 45)', c1, t.slot(1, '16:00')), 'INVALID_DURATION');
  perform t.run(b, format('select book_court(%s, %s, 240)', c1, t.slot(1, '16:00')), 'INVALID_DURATION');
  perform t.run(null, format('select book_court(%s, %s, 60)', c1, t.slot(1, '16:00')), 'permission denied');
  perform t.run(b, format($q$insert into reservations (reference, court_id, kind, starts_at, ends_at)
                            values ('YPJ-HACKED', %s, 'online', now() + interval '1 day', now() + interval '2 days') returning 1$q$, c1),
                'permission denied');

  raise notice '--- one-calendar-month window (Asia/Manila)';
  perform t.run(b, format('select book_court(%s, %s, 60)', c2, t.slot(month_days, '14:00')));
  perform t.run(b, format('select book_court(%s, %s, 60)', c2, t.slot(month_days + 1, '14:00')), 'OUTSIDE_WINDOW');
  perform t.eq(((date '2026-11-11' + interval '1 month')::date)::text, '2026-12-11', 'Nov 11 → Dec 11');
  perform t.eq(((date '2027-01-31' + interval '1 month')::date)::text, '2027-02-28', 'Jan 31 → Feb 28 (shorter month)');
  perform t.eq(((date '2028-01-30' + interval '1 month')::date)::text, '2028-02-29', 'Jan 30 2028 → Feb 29 (leap year)');

  raise notice '--- sessions crossing midnight';
  v := t.run(a, format($q$select to_char(r.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI') || ' → ' ||
                                 to_char(r.ends_at at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI')
                          from book_court(%s, %s, 120) r$q$, c3, t.slot(1, '23:00')));
  perform t.eq(v, to_char(today + 1, 'YYYY-MM-DD') || ' 23:00 → ' || to_char(today + 2, 'YYYY-MM-DD') || ' 01:00',
               'ends 1:00 AM on the following calendar day');
  perform t.run(b, format('select book_court(%s, %s, 60)', c3, t.slot(2, '00:00')), 'SLOT_TAKEN');
  perform t.run(b, format('select book_court(%s, %s, 60)', c2, t.slot(2, '00:00')));
  perform t.run(b, format('select book_court(%s, %s, 60)', c2, t.slot(2, '01:00')), 'OUTSIDE_HOURS');
  perform t.run(b, format('select book_court(%s, %s, 120)', c2, t.slot(2, '00:00')), 'OUTSIDE_HOURS');

  raise notice '--- public availability hides customers';
  v := t.run(null, format($q$select string_agg(distinct state, ',') || '|' || count(*) from get_availability(%s, %s)$q$,
                          t.slot(0, '00:00'), t.slot(3, '00:00')));
  perform t.eq(v, 'booked|4', 'guest sees busy periods only (court, start, end, state)');
  perform t.run(null, 'select count(*) from reservations', 'permission denied');
  perform t.eq(t.run(b, format('select count(*) from reservations where user_id is distinct from %L', b)), '0',
               'a customer cannot read other customers'' bookings');
  perform t.eq(t.run(b, 'select count(*) from profiles'), '1', 'a customer reads only their own profile');

  raise notice '--- cancellation';
  select id into rid from reservations where user_id = a and court_id = c1;
  perform t.run(b, format('select cancel_reservation(%L)', rid), 'NOT_FOUND');
  perform t.run(a, format('select (cancel_reservation(%L)).status', rid));
  perform t.run(b, format('select book_court(%s, %s, 60)', c1, t.slot(1, '14:00')));          -- slot is free again
  update court_hours set opens = '00:00', closes = '00:00' where court_id = bad1;             -- open 24h for this check
  soon := quote_literal((date_trunc('hour', now()) + interval '1 hour')::text);
  perform t.run(a, format('select book_court(%s, %s, 60)', bad1, soon));
  select id into rid from reservations where user_id = a and court_id = bad1;
  perform t.run(a, format('select cancel_reservation(%L)', rid), 'CANCEL_NOT_ALLOWED');       -- inside the 2-hour cutoff
  update settings set allow_cancellation = false;
  perform t.run(b, format('select cancel_reservation((select id from reservations where user_id = %L and court_id = %s limit 1))', b, c2),
                'CANCEL_NOT_ALLOWED');
  update settings set allow_cancellation = true;

  raise notice '--- administrator protection';
  perform t.run(a, format('insert into admins (user_id) values (%L) returning 1', a), 'permission denied');
  perform t.eq(t.run(a, 'select is_admin()'), 'false', 'regular user is not an admin');
  perform t.eq(t.run(a, $q$with x as (update settings set tagline = 'hacked' returning 1) select count(*) from x$q$), '0',
               'non-admin cannot change settings');
  perform t.eq(t.run(a, $q$with x as (update courts set name = 'hacked' returning 1) select count(*) from x$q$), '0',
               'non-admin cannot change courts');
  perform t.run(a, $q$insert into announcements (title, is_published) values ('hacked', true) returning 1$q$, 'row-level security');
  perform t.run(a, $q$insert into carousel_photos (image_path) values ('x.webp') returning 1$q$, 'row-level security');
  perform t.run(a, format($q$select admin_create_reservations(array[%s], %s, %s, 'block')$q$, c4, t.slot(3, '12:00'), t.slot(3, '18:00')), 'FORBIDDEN');
  perform t.run(a, format('select admin_grant(%L)', 'ana@example.com'), 'FORBIDDEN');
  perform t.run(a, 'select count(*) from admin_list()', 'FORBIDDEN');
  perform t.eq(t.run(a, 'select count(*) from activity_logs'), '0', 'non-admin cannot read activity logs');

  insert into admins (user_id) values (adm);    -- the documented "initial administrator" step (SQL editor)
  perform t.eq(t.run(adm, 'select is_admin()'), 'true', 'assigned admin is recognised');
  perform t.run(adm, format('select (cancel_reservation(%L, %L)).status', rid, 'Court flooded'));  -- admin overrides the cutoff
  perform t.run(b, format('select book_court(%s, %s, 60)', bad1, soon));                           -- released again
  perform t.run(adm, format($q$select count(*) from admin_create_reservations(array[%s], %s, %s, 'walk_in', 'Walk-in Juan', '09171112222')$q$,
                            c1, t.slot(1, '14:00'), t.slot(1, '15:00')), 'SLOT_TAKEN');
  perform t.run(adm, format($q$select count(*) from admin_create_reservations(array[%s], %s, %s, 'walk_in', 'Walk-in Juan', '09171112222')$q$,
                            c4, t.slot(1, '14:00'), t.slot(1, '15:00')));
  -- multi-court block is all-or-nothing: c4 is free 13:00–16:00? no (walk-in at 14:00) → nothing saved for c5 either
  perform t.run(adm, format($q$select count(*) from admin_create_reservations(array[(select id from courts where sport = 'pickleball' and name = 'Court 5'), %s], %s, %s, 'block', null, null, 'Maintenance')$q$,
                            c4, t.slot(1, '13:00'), t.slot(1, '16:00')), 'SLOT_TAKEN');
  perform t.eq((select count(*)::text from reservations where kind = 'block'), '0', 'failed multi-court block saved nothing');
  perform t.run(adm, format($q$select count(*) from admin_create_reservations(array[%s], %s, %s, 'block', null, null, 'Tournament')$q$,
                            c4, t.slot(5, '12:00'), t.slot(6, '01:00')));
  perform t.run(a, format('select book_court(%s, %s, 60)', c4, t.slot(5, '18:00')), 'SLOT_TAKEN');
  v := t.run(null, format($q$select string_agg(distinct state, ',') from get_availability(%s, %s) where court_id = %s$q$,
                          t.slot(5, '00:00'), t.slot(6, '00:00'), c4));
  perform t.eq(v, 'blocked', 'guests see the block as "blocked"');
  perform t.eq(t.run(adm, $q$with x as (update settings set tagline = 'New tagline', hours_confirmed = true returning 1) select count(*) from x$q$), '1',
               'admin can change settings');
  perform t.run(adm, format('select admin_grant(%L)', 'ben@example.com'));
  perform t.eq(t.run(b, 'select is_admin()'), 'true', 'granted admin is recognised');
  perform t.run(adm, format('select admin_revoke(%L)', b));
  perform t.run(adm, format('select admin_revoke(%L)', adm), 'INVALID_REQUEST');

  raise notice '--- announcements and carousel';
  ann := t.run(adm, $q$insert into announcements (title, body) values ('Holiday hours', 'Open until 1 AM.') returning id$q$)::uuid;
  perform t.eq(t.run(null, 'select count(*) from announcements'), '0', 'draft is hidden from the public');
  perform t.run(adm, format('update announcements set is_published = true where id = %L returning 1', ann));
  perform t.eq(t.run(null, 'select count(*) from announcements where published_at is not null'), '1', 'published announcement is public');
  perform t.run(adm, format('update announcements set is_published = false where id = %L returning 1', ann));
  perform t.eq(t.run(null, 'select count(*) from announcements'), '0', 'unpublished again → hidden');
  perform t.run(adm, $q$insert into carousel_photos (image_path, caption, alt_text, sort_order) values ('carousel/a.webp', 'Courts', 'Five pickleball courts', 1) returning 1$q$);
  perform t.run(adm, $q$insert into carousel_photos (image_path, is_active) values ('carousel/b.webp', false) returning 1$q$);
  perform t.eq(t.run(null, 'select count(*) from carousel_photos'), '1', 'only active carousel photos are public');

  raise notice '--- private chat';
  perform t.run(a, format('select (send_message(%L, %L, %L)).body', m1, a, '  Is Court 1 free on Sunday?  '));
  perform t.eq(t.run(a, format('select count(*) from (select send_message(%L, %L, %L)) s', m1, a, 'Is Court 1 free on Sunday?')), '1', 'retry with the same id is accepted');
  perform t.eq((select count(*)::text from messages where conversation_id = a), '1', '…and does not create a duplicate');
  perform t.run(a, format('select send_message(%L, %L, %L)', gen_random_uuid(), a, 'second message right away'), 'RATE_LIMIT');
  perform t.run(a, format('select send_message(%L, %L, %L)', gen_random_uuid(), a, repeat('x', 1001)), 'INVALID_MESSAGE');
  perform t.run(a, format('select send_message(%L, %L, %L)', gen_random_uuid(), a, '   '), 'INVALID_MESSAGE');
  perform t.eq(t.run(b, 'select count(*) from messages'), '0', 'another user cannot read the conversation');
  perform t.eq(t.run(b, 'select count(*) from conversations'), '0', 'another user cannot see the conversation exists');
  perform t.run(b, format('select send_message(%L, %L, %L)', gen_random_uuid(), a, 'intruding'), 'FORBIDDEN');
  perform t.run(b, format($q$insert into messages (id, conversation_id, sender_id, body) values (%L, %L, %L, 'forged') returning 1$q$, gen_random_uuid(), a, b), 'permission denied');
  perform t.run(null, 'select count(*) from messages', 'permission denied');
  perform t.eq(t.run(adm, 'select admin_unread from conversations'), '1', 'admin inbox shows 1 unread');
  perform t.run(adm, format('select mark_conversation_read(%L)', a));
  perform t.run(adm, format('select (send_message(%L, %L, %L)).from_admin', gen_random_uuid(), a, 'Yes, 2 PM is open.'));
  perform t.eq((select user_unread || '|' || admin_unread || '|' || last_preview from conversations where user_id = a),
               '1|0|Yes, 2 PM is open.', 'unread counters and preview updated');
  perform t.eq(t.run(a, 'select count(*) from messages'), '2', 'customer sees both sides of their own thread');

  raise notice '--- activity log and storage safeguards';
  perform t.eq((select string_agg(distinct action, ', ' order by action) from activity_logs),
    'admin.grant, admin.revoke, announcements.insert, announcements.update, carousel_photos.insert, reservation.block, reservation.cancel, reservation.walk_in, settings.update',
    'admin actions were logged');
  perform t.eq((select file_size_limit || '|' || allowed_mime_types::text || '|' || public from storage.buckets where id = 'photos'),
    '300000|{image/webp}|true', 'bucket only accepts WebP up to 300,000 bytes');
  perform t.eq((select count(*)::text from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd in ('INSERT', 'UPDATE', 'ALL')),
    '0', 'no client role can upload directly (Edge Function only)');
  perform t.eq((select count(*)::text from pg_tables where schemaname = 'public' and not rowsecurity), '0', 'RLS is enabled on every public table');
  raise notice '=== ALL CHECKS PASSED ===';
end $$;

rollback;
