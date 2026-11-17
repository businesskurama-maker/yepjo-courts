-- Yepjo portals: open-play hour blocks, carousel timing, Cafe menu, Events,
-- Step Up Dance classes, sign-ups with QR payment, and loyalty Rewards.

-- ====================================================================== closures: hour windows + open play
alter table public.closures add column if not exists start_time time;
alter table public.closures add column if not exists end_time time;
alter table public.closures drop constraint if exists closures_kind_check;
alter table public.closures add constraint closures_kind_check check (kind in ('closed', 'holiday', 'event', 'open_play'));
alter table public.closures drop constraint if exists closures_window_chk;
alter table public.closures add constraint closures_window_chk
  check ((start_time is null and end_time is null) or (start_time is not null and end_time is not null and start_time <> end_time));

-- Instants covered by a closure window on business day d (times before the court opens are after midnight).
create or replace function public._closure_window(k public.closures, p_court int, d date)
returns tstzrange language sql stable set search_path = public as $$
  with h as (select opens from public.court_hours where court_id = p_court and dow = extract(dow from d)::int),
  s as (select (d + k.start_time + case when k.start_time < coalesce((select opens from h), time '06:00') then interval '1 day' else interval '0' end) as ts),
  e as (select (d + k.end_time + case when k.end_time <= coalesce((select opens from h), time '06:00') then interval '1 day' else interval '0' end) as ts)
  select tstzrange((select ts from s) at time zone 'Asia/Manila',
                   (case when (select ts from e) <= (select ts from s) then (select ts from e) + interval '1 day' else (select ts from e) end) at time zone 'Asia/Manila')
$$;

create or replace function public._reservation_rules()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_bdate date; v_closure public.closures; v_court public.courts; v_price numeric; v_win tstzrange;
begin
  if new.kind not in ('online', 'walk_in') then return new; end if;

  v_price := public._price(new.court_id, new.starts_at, new.ends_at);
  if v_price is not null then new.amount := v_price; end if;

  if new.kind = 'online' then
    v_bdate := coalesce(
      public._business_date(new.court_id, new.starts_at,
        greatest(1, (extract(epoch from (new.ends_at - new.starts_at)) / 60)::int), 1),
      (new.starts_at at time zone 'Asia/Manila')::date);
    for v_closure in
      select * from public.closures k
       where (v_bdate between k.starts_on and k.ends_on or v_bdate - 1 between k.starts_on and k.ends_on)
         and (k.court_ids is null or new.court_id = any (k.court_ids))
       order by k.created_at
    loop
      select * into v_court from public.courts where id = new.court_id;
      if v_closure.start_time is null then
        if v_bdate between v_closure.starts_on and v_closure.ends_on then
          raise exception 'CLOSED: % is not open for booking on % (%).',
            v_court.name, to_char(v_bdate, 'FMMonth FMDD'), v_closure.title;
        end if;
      else
        if v_bdate between v_closure.starts_on and v_closure.ends_on then
          v_win := public._closure_window(v_closure, new.court_id, v_bdate);
          if v_win && tstzrange(new.starts_at, new.ends_at) then
            raise exception 'CLOSED: % is reserved for % from % to % on %.',
              v_court.name, v_closure.title, to_char(lower(v_win) at time zone 'Asia/Manila', 'FMHH12:MI AM'),
              to_char(upper(v_win) at time zone 'Asia/Manila', 'FMHH12:MI AM'), to_char(v_bdate, 'FMMonth FMDD');
          end if;
        end if;
      end if;
    end loop;
  end if;
  return new;
end $$;

-- ====================================================================== settings: carousel + points rules
alter table public.settings add column if not exists carousel_seconds int not null default 6;
alter table public.settings drop constraint if exists settings_carousel_seconds_chk;
alter table public.settings add constraint settings_carousel_seconds_chk check (carousel_seconds between 2 and 60);
alter table public.settings add column if not exists rewards_enabled boolean not null default true;
alter table public.settings add column if not exists points_court_hours numeric(6, 2) not null default 3;      -- hours of court rental per 1 point (0 = off)
alter table public.settings add column if not exists points_purchase_amount numeric(10, 2) not null default 200; -- pesos spent per 1 point (0 = off)
alter table public.settings add column if not exists points_dance_booking numeric(6, 2) not null default 1;   -- points per Step Up Dance class
alter table public.settings add column if not exists points_event numeric(6, 2) not null default 0;           -- points per event registration
alter table public.settings drop constraint if exists settings_points_chk;
alter table public.settings add constraint settings_points_chk
  check (points_court_hours >= 0 and points_purchase_amount >= 0 and points_dance_booking >= 0 and points_event >= 0);

-- ====================================================================== member codes (loyalty QR)
create or replace function public._new_member_code()
returns text language plpgsql volatile set search_path = public as $$
declare v text; alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  loop
    v := 'YJ' || (select string_agg(substr(alphabet, 1 + floor(random() * 32)::int, 1), '') from generate_series(1, 8));
    exit when not exists (select 1 from public.profiles where member_code = v);
  end loop;
  return v;
end $$;
alter table public.profiles add column if not exists member_code text;
update public.profiles set member_code = public._new_member_code() where member_code is null;
alter table public.profiles alter column member_code set default public._new_member_code();
alter table public.profiles alter column member_code set not null;
create unique index if not exists profiles_member_code_key on public.profiles (member_code);

-- ====================================================================== cafe menu
create table if not exists public.cafe_items (
  id          uuid primary key default gen_random_uuid(),
  category    text not null default 'Food' check (char_length(trim(category)) between 1 and 40),
  name        text not null check (char_length(trim(name)) between 1 and 80),
  description text check (description is null or char_length(description) <= 300),
  price       numeric(10, 2) check (price is null or price >= 0),
  image_path  text,
  is_available boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ====================================================================== events
create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'open_play' check (kind in ('open_play', 'training', 'tournament', 'other')),
  sport       text check (sport is null or sport in ('pickleball', 'badminton', 'dance')),
  title       text not null check (char_length(trim(title)) between 2 and 100),
  description text check (description is null or char_length(description) <= 2000),
  image_path  text,
  starts_on   date not null,
  ends_on     date not null,
  start_time  time not null,
  end_time    time not null,
  price       numeric(10, 2) not null default 0 check (price >= 0),
  capacity    int check (capacity is null or capacity between 1 and 1000),
  is_published boolean not null default false,
  registration_open boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (ends_on >= starts_on and ends_on - starts_on <= 92),
  check (start_time <> end_time)
);
create index if not exists events_dates_idx on public.events (starts_on, ends_on);

-- ====================================================================== step up dance classes
create table if not exists public.dance_sessions (
  id          uuid primary key default gen_random_uuid(),
  dance_type  text not null check (char_length(trim(dance_type)) between 2 and 60),
  instructor  text not null check (char_length(trim(instructor)) between 2 and 80),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  capacity    int not null check (capacity between 1 and 500),
  price       numeric(10, 2) not null default 0 check (price >= 0),
  step_board  boolean not null default true,
  note        text check (note is null or char_length(note) <= 300),
  is_published boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (ends_at > starts_at and ends_at - starts_at <= interval '8 hours')
);
create index if not exists dance_sessions_start_idx on public.dance_sessions (starts_at);

-- ====================================================================== sign-ups (events + dance)
create table if not exists public.registrations (
  id               uuid primary key default gen_random_uuid(),
  reference        text not null unique default public._new_reference(),
  kind             text not null check (kind in ('event', 'dance')),
  event_id         uuid references public.events (id) on delete cascade,
  dance_session_id uuid references public.dance_sessions (id) on delete cascade,
  user_id          uuid references auth.users (id) on delete set null,
  customer_name    text,
  customer_phone   text,
  customer_email   text,
  amount           numeric(10, 2) not null default 0,
  status           text not null default 'confirmed' check (status in ('pending', 'confirmed', 'cancelled')),
  payment_method   text not null default 'free' check (payment_method in ('free', 'online', 'venue')),
  payment_status   text not null default 'not_required' check (payment_status in ('not_required', 'unpaid', 'submitted', 'verified', 'rejected')),
  payment_ref      text check (payment_ref is null or payment_ref ~ '^[0-9]{6}$'),
  payment_submitted_at timestamptz,
  payment_verified_at  timestamptz,
  payment_verified_by  uuid,
  payment_note     text,
  hold_expires_at  timestamptz,
  created_at       timestamptz not null default now(),
  cancelled_at     timestamptz,
  cancel_reason    text,
  check ((kind = 'event') = (event_id is not null) and (kind = 'dance') = (dance_session_id is not null))
);
create unique index if not exists registrations_one_event_per_user on public.registrations (event_id, user_id)
  where status <> 'cancelled' and event_id is not null and user_id is not null;
create unique index if not exists registrations_one_dance_per_user on public.registrations (dance_session_id, user_id)
  where status <> 'cancelled' and dance_session_id is not null and user_id is not null;
create index if not exists registrations_user_idx on public.registrations (user_id, created_at desc);

-- ====================================================================== loyalty
create table if not exists public.rewards (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(trim(title)) between 2 and 80),
  description text check (description is null or char_length(description) <= 300),
  points_cost numeric(10, 2) not null check (points_cost > 0),
  image_path  text,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.points_ledger (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  points     numeric(10, 2) not null check (points <> 0),
  source     text not null check (source in ('court', 'dance', 'event', 'purchase', 'manual', 'redeem', 'reversal')),
  ref        text,               -- reservation / registration id, reward id …
  note       text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists points_ledger_user_idx on public.points_ledger (user_id, created_at desc);
create unique index if not exists points_ledger_once on public.points_ledger (source, ref) where source in ('court', 'dance', 'event');

-- ====================================================================== RLS + grants
alter table public.cafe_items enable row level security;
alter table public.events enable row level security;
alter table public.dance_sessions enable row level security;
alter table public.registrations enable row level security;
alter table public.rewards enable row level security;
alter table public.points_ledger enable row level security;

create policy cafe_select on public.cafe_items for select to anon, authenticated using (true);
create policy cafe_admin on public.cafe_items for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy events_select on public.events for select to anon, authenticated using (is_published or (select public.is_admin()));
create policy events_admin on public.events for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy dance_select on public.dance_sessions for select to anon, authenticated using (is_published or (select public.is_admin()));
create policy dance_admin on public.dance_sessions for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy registrations_select on public.registrations for select to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy rewards_select on public.rewards for select to anon, authenticated using (is_active or (select public.is_admin()));
create policy rewards_admin on public.rewards for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy points_select on public.points_ledger for select to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));

revoke all on public.cafe_items, public.events, public.dance_sessions, public.registrations, public.rewards, public.points_ledger from anon, authenticated;
grant select on public.cafe_items, public.events, public.dance_sessions, public.rewards to anon;
grant select, insert, update, delete on public.cafe_items, public.events, public.dance_sessions, public.rewards to authenticated;
grant select on public.registrations, public.points_ledger to authenticated;

do $$
declare t text;
begin
  foreach t in array array['cafe_items', 'events', 'dance_sessions', 'rewards'] loop
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$s for each row execute function public._audit()', t);
  end loop;
  foreach t in array array['cafe_items', 'events', 'dance_sessions', 'registrations', 'rewards', 'points_ledger'] loop
    execute format('create trigger pulse_%1$s after insert or update or delete on public.%1$s for each statement execute function public._bump_pulse()', t);
  end loop;
end $$;

-- Places taken in an event or class (confirmed + pending that still hold a place).
create or replace function public._places_taken(p_kind text, p_target uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.registrations r
   where r.kind = p_kind
     and ((p_kind = 'event' and r.event_id = p_target) or (p_kind = 'dance' and r.dance_session_id = p_target))
     and (r.status = 'confirmed'
          or (r.status = 'pending' and (r.payment_status = 'submitted' or r.hold_expires_at > now())))
$$;

-- Public: places taken per event / class (no personal data).
create or replace function public.signup_counts()
returns table (kind text, target uuid, taken int)
language sql stable security definer set search_path = public as $$
  select 'event', e.id, public._places_taken('event', e.id) from public.events e
   where e.is_published and e.ends_on >= (now() at time zone 'Asia/Manila')::date - 1
  union all
  select 'dance', d.id, public._places_taken('dance', d.id) from public.dance_sessions d
   where d.is_published and d.ends_at > now() - interval '1 day'
$$;

-- ====================================================================== sign up
create or replace function public.register(p_kind text, p_target uuid, p_pay_online boolean default false)
returns public.registrations language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_profile public.profiles; v_settings public.settings;
  v_event public.events; v_dance public.dance_sessions;
  v_price numeric; v_cap int; v_starts timestamptz; v_ends timestamptz; v_title text;
  v_row public.registrations; v_online boolean;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Please sign in first.'; end if;
  select * into v_profile from public.profiles where id = v_uid;
  if v_profile.completed_at is null then raise exception 'PROFILE_INCOMPLETE: Add your name and contact number first.'; end if;
  select * into v_settings from public.settings where id;
  perform pg_advisory_xact_lock(hashtext('yepjo.signup.' || p_target::text));

  -- release lapsed holds for this target first
  update public.registrations set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Payment not received in time'
   where status = 'pending' and payment_status in ('unpaid', 'rejected') and hold_expires_at < now()
     and (event_id = p_target or dance_session_id = p_target);

  if p_kind = 'event' then
    select * into v_event from public.events where id = p_target;
    if not found or not v_event.is_published then raise exception 'NOT_FOUND: Event not found.'; end if;
    if not v_event.registration_open then raise exception 'REGISTRATION_CLOSED: Registration for this event is closed.'; end if;
    v_ends := ((v_event.ends_on + v_event.end_time + case when v_event.end_time <= v_event.start_time then interval '1 day' else interval '0' end)
               at time zone 'Asia/Manila');
    if v_ends < now() then raise exception 'REGISTRATION_CLOSED: This event has ended.'; end if;
    v_price := v_event.price; v_cap := v_event.capacity; v_title := v_event.title;
  elsif p_kind = 'dance' then
    select * into v_dance from public.dance_sessions where id = p_target;
    if not found or not v_dance.is_published then raise exception 'NOT_FOUND: Class not found.'; end if;
    if v_dance.starts_at <= now() then raise exception 'REGISTRATION_CLOSED: This class has already started.'; end if;
    v_price := v_dance.price; v_cap := v_dance.capacity; v_title := v_dance.dance_type;
  else
    raise exception 'INVALID_REQUEST: Unknown sign-up type.';
  end if;

  if exists (select 1 from public.registrations r where r.user_id = v_uid and r.status <> 'cancelled'
               and (r.event_id = p_target or r.dance_session_id = p_target)) then
    raise exception 'ALREADY_REGISTERED: You are already signed up. See My bookings.';
  end if;
  if v_cap is not null and public._places_taken(p_kind, p_target) >= v_cap then
    raise exception 'FULL: Sorry, % is full.', v_title;
  end if;

  v_online := v_price > 0 and coalesce(p_pay_online, false) and v_settings.online_payment_enabled and v_settings.payment_qr_path is not null;
  if v_price > 0 and not v_online and not v_settings.allow_pay_at_venue then
    raise exception 'PAYMENT_REQUIRED: Please pay online with the QR code.';
  end if;

  insert into public.registrations (kind, event_id, dance_session_id, user_id, customer_name, customer_phone, customer_email,
                                    amount, status, payment_method, payment_status, hold_expires_at)
  values (p_kind, case when p_kind = 'event' then p_target end, case when p_kind = 'dance' then p_target end, v_uid,
          v_profile.full_name, v_profile.phone, v_profile.email, v_price,
          case when v_online then 'pending' else 'confirmed' end,
          case when v_price = 0 then 'free' when v_online then 'online' else 'venue' end,
          case when v_online then 'unpaid' else 'not_required' end,
          case when v_online then now() + make_interval(mins => v_settings.payment_hold_minutes) end)
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.submit_registration_payment(p_id uuid, p_ref text)
returns public.registrations language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_ref text := regexp_replace(coalesce(p_ref, ''), '\D', '', 'g'); v_row public.registrations;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Please sign in first.'; end if;
  if v_ref !~ '^[0-9]{6}$' then raise exception 'INVALID_REFERENCE: Enter exactly the last 6 digits of your payment reference number.'; end if;
  select * into v_row from public.registrations where id = p_id for update;
  if not found or v_row.user_id is distinct from v_uid then raise exception 'NOT_FOUND: Sign-up not found.'; end if;
  if v_row.status <> 'pending' or v_row.payment_method <> 'online' then raise exception 'INVALID_REQUEST: This sign-up is not waiting for an online payment.'; end if;
  if v_row.payment_status = 'submitted' then raise exception 'ALREADY_SUBMITTED: Your reference was already sent. Yepjo will confirm it soon.'; end if;
  if v_row.hold_expires_at is not null and v_row.hold_expires_at < now() then
    update public.registrations set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Payment not received in time'
     where id = p_id returning * into v_row;
    return v_row;
  end if;
  update public.registrations set payment_ref = v_ref, payment_status = 'submitted', payment_submitted_at = now(), payment_note = null
   where id = p_id returning * into v_row;
  return v_row;
end $$;

create or replace function public.admin_review_registration(p_id uuid, p_approve boolean, p_note text default null)
returns public.registrations language plpgsql security definer set search_path = public as $$
declare v_row public.registrations; v_settings public.settings; v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  select * into v_settings from public.settings where id;
  select * into v_row from public.registrations where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Sign-up not found.'; end if;
  if v_row.status <> 'pending' or v_row.payment_status <> 'submitted' then
    raise exception 'INVALID_REQUEST: This sign-up has no payment waiting to be checked.';
  end if;
  if p_approve then
    update public.registrations set status = 'confirmed', payment_status = 'verified', payment_verified_at = now(),
           payment_verified_by = auth.uid(), payment_note = v_note, hold_expires_at = null
     where id = p_id returning * into v_row;
  else
    update public.registrations set payment_status = 'rejected', payment_note = coalesce(v_note, 'Payment not found.'),
           hold_expires_at = now() + make_interval(mins => v_settings.payment_hold_minutes)
     where id = p_id returning * into v_row;
  end if;
  perform public._log(case when p_approve then 'registration.payment_approve' else 'registration.payment_reject' end,
                      'registrations', p_id::text, jsonb_build_object('label', v_row.reference, 'note', v_note));
  return v_row;
end $$;

create or replace function public.cancel_registration(p_id uuid, p_reason text default null)
returns public.registrations language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_row public.registrations; v_admin boolean := public.is_admin(); v_start timestamptz;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Please sign in first.'; end if;
  select * into v_row from public.registrations where id = p_id for update;
  if not found or (v_row.user_id is distinct from v_uid and not v_admin) then raise exception 'NOT_FOUND: Sign-up not found.'; end if;
  if v_row.status = 'cancelled' then return v_row; end if;
  if not v_admin then
    if v_row.payment_status in ('submitted', 'verified') then
      raise exception 'CANCEL_NOT_ALLOWED: You already paid. Message Yepjo to cancel and arrange a refund.';
    end if;
    select coalesce((select starts_at from public.dance_sessions where id = v_row.dance_session_id),
                    (select (starts_on + start_time) at time zone 'Asia/Manila' from public.events where id = v_row.event_id))
      into v_start;
    if v_start is not null and v_start <= now() then raise exception 'CANCEL_NOT_ALLOWED: It has already started.'; end if;
  end if;
  update public.registrations set status = 'cancelled', cancelled_at = now(),
         cancel_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = p_id returning * into v_row;
  if v_admin and v_row.user_id is distinct from v_uid then
    perform public._log('registration.cancel', 'registrations', p_id::text, jsonb_build_object('label', v_row.reference));
  end if;
  return v_row;
end $$;

-- ====================================================================== points: automatic + counter
create or replace function public._award_reservation_points()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_set public.settings; v_pts numeric; v_given numeric;
begin
  if new.user_id is null or new.kind <> 'online' then return null; end if;
  select * into v_set from public.settings where id;
  if new.status = 'confirmed' and (tg_op = 'INSERT' or old.status is distinct from 'confirmed') then
    if not v_set.rewards_enabled or v_set.points_court_hours <= 0 then return null; end if;
    v_pts := round((extract(epoch from (new.ends_at - new.starts_at)) / 3600.0) / v_set.points_court_hours, 2);
    if v_pts > 0 then
      insert into public.points_ledger (user_id, points, source, ref, note)
      values (new.user_id, v_pts, 'court', new.id::text, 'Court booking ' || new.reference)
      on conflict do nothing;
    end if;
  elsif new.status = 'cancelled' and tg_op = 'UPDATE' and old.status = 'confirmed' then
    select sum(points) into v_given from public.points_ledger where ref = new.id::text and source in ('court', 'reversal');
    if coalesce(v_given, 0) > 0 then
      insert into public.points_ledger (user_id, points, source, ref, note)
      values (new.user_id, -v_given, 'reversal', new.id::text, 'Cancelled booking ' || new.reference);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists award_points on public.reservations;
create trigger award_points after insert or update of status on public.reservations
  for each row execute function public._award_reservation_points();

create or replace function public._award_registration_points()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_set public.settings; v_pts numeric; v_given numeric;
begin
  if new.user_id is null then return null; end if;
  select * into v_set from public.settings where id;
  if new.status = 'confirmed' and (tg_op = 'INSERT' or old.status is distinct from 'confirmed') then
    if not v_set.rewards_enabled then return null; end if;
    v_pts := case when new.kind = 'dance' then v_set.points_dance_booking else v_set.points_event end;
    if v_pts > 0 then
      insert into public.points_ledger (user_id, points, source, ref, note)
      values (new.user_id, v_pts, new.kind, new.id::text,
              case when new.kind = 'dance' then 'Step Up Dance ' else 'Event ' end || new.reference)
      on conflict do nothing;
    end if;
  elsif new.status = 'cancelled' and tg_op = 'UPDATE' and old.status = 'confirmed' then
    select sum(points) into v_given from public.points_ledger where ref = new.id::text and source in ('dance', 'event', 'reversal');
    if coalesce(v_given, 0) > 0 then
      insert into public.points_ledger (user_id, points, source, ref, note)
      values (new.user_id, -v_given, 'reversal', new.id::text, 'Cancelled ' || new.reference);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists award_points on public.registrations;
create trigger award_points after insert or update of status on public.registrations
  for each row execute function public._award_registration_points();

create or replace function public.points_balance(p_user uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(points), 0) from public.points_ledger where user_id = p_user
$$;

-- The signed-in member's card: code, balance, latest activity.
create or replace function public.my_rewards()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Please sign in first.'; end if;
  return jsonb_build_object(
    'member_code', (select member_code from public.profiles where id = v_uid),
    'balance', public.points_balance(v_uid),
    'history', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select points, source, note, created_at from public.points_ledger where user_id = v_uid order by created_at desc limit 30) x), '[]'));
end $$;

-- Admin: look up a member from their QR / code.
create or replace function public.admin_member_lookup(p_code text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_code text := upper(substring(coalesce(p_code, '') from '(YJ[A-Z0-9]{8})')); v_p public.profiles;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  if v_code is null then raise exception 'NOT_FOUND: That is not a Yepjo member code.'; end if;
  select * into v_p from public.profiles where member_code = v_code;
  if not found then raise exception 'NOT_FOUND: No member with code %.', v_code; end if;
  return jsonb_build_object(
    'member_code', v_p.member_code, 'name', v_p.full_name, 'phone', v_p.phone, 'email', v_p.email,
    'balance', public.points_balance(v_p.id),
    'history', coalesce((select jsonb_agg(x order by x.created_at desc) from (
        select points, source, note, created_at from public.points_ledger where user_id = v_p.id order by created_at desc limit 10) x), '[]'));
end $$;

-- Admin: give points for a purchase (amount in pesos) or a set number of points.
create or replace function public.admin_award_points(p_code text, p_amount numeric default null, p_points numeric default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_code text := upper(substring(coalesce(p_code, '') from '(YJ[A-Z0-9]{8})')); v_p public.profiles; v_set public.settings;
  v_pts numeric; v_src text; v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  select * into v_p from public.profiles where member_code = v_code;
  if not found then raise exception 'NOT_FOUND: Member not found.'; end if;
  select * into v_set from public.settings where id;
  if p_points is not null then
    if p_points = 0 or abs(p_points) > 1000 then raise exception 'INVALID_REQUEST: Points must be between -1000 and 1000, not 0.'; end if;
    v_pts := round(p_points, 2); v_src := 'manual';
  elsif p_amount is not null then
    if p_amount <= 0 or p_amount > 1000000 then raise exception 'INVALID_REQUEST: Enter the purchase amount.'; end if;
    if v_set.points_purchase_amount <= 0 then raise exception 'INVALID_REQUEST: Purchase points are turned off in Rewards settings.'; end if;
    v_pts := floor(p_amount / v_set.points_purchase_amount);
    if v_pts < 1 then
      raise exception 'TOO_SMALL: A purchase of % earns no points (1 point per % spent).', p_amount, v_set.points_purchase_amount;
    end if;
    v_src := 'purchase';
    v_note := coalesce(v_note, 'Purchase ₱' || trim(to_char(p_amount, 'FM999,999,990.00')));
  else
    raise exception 'INVALID_REQUEST: Enter a purchase amount or points.';
  end if;
  perform pg_advisory_xact_lock(hashtext('yepjo.points.' || v_p.id::text));
  if public.points_balance(v_p.id) + v_pts < 0 then raise exception 'NOT_ENOUGH_POINTS: The member does not have that many points.'; end if;
  insert into public.points_ledger (user_id, points, source, note, created_by) values (v_p.id, v_pts, v_src, v_note, auth.uid());
  perform public._log('points.award', 'points_ledger', v_p.member_code,
                      jsonb_build_object('label', v_p.full_name, 'points', v_pts, 'note', v_note));
  return jsonb_build_object('points', v_pts, 'balance', public.points_balance(v_p.id));
end $$;

-- Admin: redeem a reward for a member at the counter.
create or replace function public.admin_redeem_reward(p_code text, p_reward uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_code text := upper(substring(coalesce(p_code, '') from '(YJ[A-Z0-9]{8})')); v_p public.profiles; v_r public.rewards;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  select * into v_p from public.profiles where member_code = v_code;
  if not found then raise exception 'NOT_FOUND: Member not found.'; end if;
  select * into v_r from public.rewards where id = p_reward and is_active;
  if not found then raise exception 'NOT_FOUND: Reward not available.'; end if;
  perform pg_advisory_xact_lock(hashtext('yepjo.points.' || v_p.id::text));
  if public.points_balance(v_p.id) < v_r.points_cost then
    raise exception 'NOT_ENOUGH_POINTS: % needs % points; the member has %.', v_r.title, v_r.points_cost, public.points_balance(v_p.id);
  end if;
  insert into public.points_ledger (user_id, points, source, ref, note, created_by)
  values (v_p.id, -v_r.points_cost, 'redeem', v_r.id::text, 'Redeemed: ' || v_r.title, auth.uid());
  perform public._log('points.redeem', 'points_ledger', v_p.member_code,
                      jsonb_build_object('label', v_p.full_name, 'reward', v_r.title, 'points', v_r.points_cost));
  return jsonb_build_object('reward', v_r.title, 'balance', public.points_balance(v_p.id));
end $$;

-- ====================================================================== grants on functions
revoke all on function public._closure_window(public.closures, int, date) from public, anon, authenticated;
revoke all on function public._places_taken(text, uuid) from public, anon, authenticated;
revoke all on function public._new_member_code() from public, anon, authenticated;
revoke all on function public.points_balance(uuid) from public, anon, authenticated;
revoke all on function public.register(text, uuid, boolean) from public, anon;
revoke all on function public.submit_registration_payment(uuid, text) from public, anon;
revoke all on function public.admin_review_registration(uuid, boolean, text) from public, anon;
revoke all on function public.cancel_registration(uuid, text) from public, anon;
revoke all on function public.my_rewards() from public, anon;
revoke all on function public.admin_member_lookup(text) from public, anon;
revoke all on function public.admin_award_points(text, numeric, numeric, text) from public, anon;
revoke all on function public.admin_redeem_reward(text, uuid) from public, anon;
grant execute on function public.signup_counts() to anon, authenticated;
grant execute on function public.register(text, uuid, boolean) to authenticated;
grant execute on function public.submit_registration_payment(uuid, text) to authenticated;
grant execute on function public.admin_review_registration(uuid, boolean, text) to authenticated;
grant execute on function public.cancel_registration(uuid, text) to authenticated;
grant execute on function public.my_rewards() to authenticated;
grant execute on function public.admin_member_lookup(text) to authenticated;
grant execute on function public.admin_award_points(text, numeric, numeric, text) to authenticated;
grant execute on function public.admin_redeem_reward(text, uuid) to authenticated;

-- Starter rewards (admins can edit or remove them).
insert into public.rewards (title, description, points_cost, sort_order)
select * from (values
  ('Free 1 hour court', 'One hour on any court, any day. Book with the counter.', 10::numeric, 1),
  ('Free coffee', 'Any brewed coffee from Yepjo Cafe.', 3::numeric, 2)) v(title, description, points_cost, sort_order)
where not exists (select 1 from public.rewards);
