-- =====================================================================
-- YEPJO Pickleball & Badminton Court — initial schema
-- Tables, Row Level Security, trusted (SECURITY DEFINER) functions,
-- Storage bucket + policies, Realtime publication, seed data.
-- All booking rules are enforced here, not only in the interface.
-- Business time zone: Asia/Manila.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;
set search_path = public, extensions;

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text not null default '',
  full_name    text,
  phone        text,
  avatar_url   text,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Administrators live in their own table. No client role can write to it.
create table public.admins (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  added_by uuid,
  added_at timestamptz not null default now()
);

-- Single-row site configuration (editable in the CMS).
create table public.settings (
  id                  boolean primary key default true check (id),
  business_name       text not null default 'YEPJO Pickleball & Badminton Court',
  tagline             text not null default 'Play pickleball and badminton in Tanauan.',
  address             text not null default 'Brgy. Cabuynan, Tanauan, Philippines 6502',
  email               text not null default 'yepjopickleball@gmail.com',
  phone               text not null default '',
  facebook_name       text not null default 'Yepjo Pickleball and Badminton Court',
  facebook_url        text not null default '',
  reclub_url          text not null default 'https://reclub.co/clubs/@yepjo-pickleball',
  slot_minutes        int  not null default 60 check (slot_minutes in (30, 60)),
  min_slots           int  not null default 1  check (min_slots between 1 and 12),
  max_slots           int  not null default 3  check (max_slots between 1 and 24),
  max_active_bookings int  not null default 6  check (max_active_bookings between 1 and 50),
  allow_cancellation  boolean not null default true,
  cancel_cutoff_hours int  not null default 2  check (cancel_cutoff_hours between 0 and 720),
  cancellation_note   text not null default '',
  currency            text not null default 'PHP',
  -- "Needs business input" flags shown in the CMS until an admin confirms them.
  hours_confirmed     boolean not null default false,
  rates_confirmed     boolean not null default false,
  policy_confirmed    boolean not null default false,
  updated_at          timestamptz not null default now(),
  check (max_slots >= min_slots)
);

create table public.courts (
  id          int generated always as identity primary key,
  sport       text not null check (sport in ('pickleball', 'badminton')),
  name        text not null check (char_length(name) between 1 and 40),
  sort_order  int  not null default 0,
  is_active   boolean not null default true,
  hourly_rate numeric(10, 2) check (hourly_rate is null or hourly_rate >= 0),
  created_at  timestamptz not null default now()
);

-- One operating window per court per weekday (0 = Sunday).
-- closes <= opens means the window ends on the following day (e.g. 12:00 → 01:00).
create table public.court_hours (
  court_id  int not null references public.courts (id) on delete cascade,
  dow       smallint not null check (dow between 0 and 6),
  opens     time not null default '12:00',
  closes    time not null default '01:00',
  is_closed boolean not null default false,
  primary key (court_id, dow)
);

create table public.reservations (
  id             uuid primary key default gen_random_uuid(),
  reference      text not null unique,
  court_id       int  not null references public.courts (id) on delete restrict,
  user_id        uuid references public.profiles (id) on delete set null,
  kind           text not null check (kind in ('online', 'walk_in', 'block')),
  status         text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  customer_name  text,
  customer_phone text,
  customer_email text,
  note           text,
  amount         numeric(10, 2),
  created_by     uuid,
  created_at     timestamptz not null default now(),
  cancelled_at   timestamptz,
  cancelled_by   uuid,
  cancel_reason  text,
  check (ends_at > starts_at),
  -- The database itself refuses any two confirmed entries (bookings, walk-ins
  -- or blocks) that overlap on the same court, even under concurrent requests.
  constraint reservations_no_overlap exclude using gist (
    court_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status = 'confirmed')
);
create index reservations_user_idx   on public.reservations (user_id, starts_at desc);
create index reservations_starts_idx on public.reservations (starts_at);

-- A single row that is touched whenever availability or site content changes.
-- Clients subscribe to it over Realtime and refetch; it carries no customer data.
create table public.pulse (
  id        boolean primary key default true check (id),
  bumped_at timestamptz not null default now()
);

create table public.announcements (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (char_length(title) between 1 and 120),
  body         text not null default '' check (char_length(body) <= 5000),
  image_path   text,
  image_alt    text not null default '',
  is_published boolean not null default false,
  published_at timestamptz,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index announcements_pub_idx on public.announcements (is_published, published_at desc);

create table public.carousel_photos (
  id         uuid primary key default gen_random_uuid(),
  image_path text not null,
  caption    text not null default '' check (char_length(caption) <= 140),
  alt_text   text not null default '' check (char_length(alt_text) <= 200),
  sort_order int  not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- One private conversation per registered user.
create table public.conversations (
  user_id         uuid primary key references public.profiles (id) on delete cascade,
  last_message_at timestamptz not null default now(),
  last_preview    text not null default '',
  user_unread     int  not null default 0,
  admin_unread    int  not null default 0,
  created_at      timestamptz not null default now()
);

create table public.messages (
  id              uuid primary key,              -- generated by the client so a retry cannot duplicate
  conversation_id uuid not null references public.conversations (user_id) on delete cascade,
  sender_id       uuid not null,
  from_admin      boolean not null default false,
  body            text not null check (char_length(body) between 1 and 1000),
  created_at      timestamptz not null default now()
);
create index messages_conv_idx on public.messages (conversation_id, created_at);
create index messages_sender_idx on public.messages (sender_id, created_at desc);

create table public.activity_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  actor_email text,
  action      text not null,
  entity      text not null,
  entity_id   text,
  details     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index activity_logs_created_idx on public.activity_logs (created_at desc);

-- ---------------------------------------------------------------------
-- 2. Helper functions
-- ---------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- Accepts PH numbers (0917…, 63917…, +63917…) and other international numbers
-- written with a leading +. Returns E.164 or NULL when invalid.
create or replace function public.normalize_phone(p text)
returns text language plpgsql immutable as $$
declare v text := regexp_replace(coalesce(p, ''), '[\s\-().]', '', 'g');
begin
  if v ~ '^0\d{9,10}$' then return '+63' || substr(v, 2);
  elsif v ~ '^63\d{9,10}$' then return '+' || v;
  elsif v ~ '^\+[1-9]\d{7,14}$' then return v;
  end if;
  return null;
end $$;

create or replace function public._log(p_action text, p_entity text, p_entity_id text, p_details jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.activity_logs (actor_id, actor_email, action, entity, entity_id, details)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()),
          p_action, p_entity, p_entity_id, coalesce(p_details, '{}'));
end $$;

create or replace function public._new_reference()
returns text language plpgsql volatile as $$
declare alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; v text := 'YPJ-'; i int;
begin
  for i in 1..6 loop
    v := v || substr(alphabet, 1 + floor(random() * 32)::int, 1);
  end loop;
  return v;
end $$;

-- Returns the operating day (Manila date on which the session opens) that fully
-- contains the requested period and on whose slot grid it starts; NULL otherwise.
-- A 12:00 AM–1:00 AM booking therefore belongs to the previous day's session.
create or replace function public._business_date(p_court int, p_start timestamptz, p_minutes int, p_slot int)
returns date language plpgsql stable set search_path = public as $$
declare
  v_local timestamp := p_start at time zone 'Asia/Manila';
  v_end   timestamp := v_local + make_interval(mins => p_minutes);
  d date; h public.court_hours; w_start timestamp; w_end timestamp;
begin
  foreach d in array array[v_local::date - 1, v_local::date]::date[] loop
    select * into h from public.court_hours where court_id = p_court and dow = extract(dow from d)::int;
    if found and not h.is_closed then
      w_start := d + h.opens;
      w_end   := d + h.closes + case when h.closes <= h.opens then interval '1 day' else interval '0' end;
      if v_local >= w_start and v_end <= w_end
         and extract(epoch from (v_local - w_start))::int % (p_slot * 60) = 0 then
        return d;
      end if;
    end if;
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------
-- 3. Auth → profile sync
-- ---------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')), ''),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.handle_user_email_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set email = coalesce(new.email, ''), updated_at = now() where id = new.id;
  return new;
end $$;

create trigger on_auth_user_email_changed
  after update of email on auth.users for each row
  when (old.email is distinct from new.email)
  execute function public.handle_user_email_change();

-- The only way a user can write their profile. The email always comes from the
-- verified Google identity in auth.users, never from the request.
create or replace function public.save_profile(p_full_name text, p_phone text)
returns public.profiles language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_name  text := regexp_replace(trim(coalesce(p_full_name, '')), '\s+', ' ', 'g');
  v_phone text := public.normalize_phone(p_phone);
  v_email text;
  v_row   public.profiles;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Please sign in first.'; end if;
  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'INVALID_NAME: Please enter your full name (2–80 characters).';
  end if;
  if v_phone is null then
    raise exception 'INVALID_PHONE: Enter a valid contact number, e.g. 0917 123 4567 or +63 917 123 4567.';
  end if;
  select email into v_email from auth.users where id = v_uid;
  insert into public.profiles (id, email, full_name, phone, completed_at)
  values (v_uid, coalesce(v_email, ''), v_name, v_phone, now())
  on conflict (id) do update
    set full_name = excluded.full_name,
        phone = excluded.phone,
        email = excluded.email,
        completed_at = coalesce(public.profiles.completed_at, now()),
        updated_at = now()
  returning * into v_row;
  return v_row;
end $$;

-- ---------------------------------------------------------------------
-- 4. Booking functions
-- ---------------------------------------------------------------------

-- Public availability: busy periods only, never who booked them.
create or replace function public.get_availability(p_from timestamptz, p_to timestamptz)
returns table (court_id int, starts_at timestamptz, ends_at timestamptz, state text)
language sql stable security definer set search_path = public as $$
  select r.court_id, r.starts_at, r.ends_at,
         case when r.kind = 'block' then 'blocked' else 'booked' end
  from public.reservations r
  where r.status = 'confirmed'
    and p_to > p_from
    and p_to - p_from <= interval '45 days'
    and r.starts_at < p_to and r.ends_at > p_from
  order by r.starts_at;
$$;

-- Online booking. One row covers all consecutive slots, so they are confirmed
-- (or rejected) together in a single transaction.
create or replace function public.book_court(p_court_id int, p_starts_at timestamptz, p_minutes int)
returns public.reservations language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid      uuid := auth.uid();
  v_profile  public.profiles;
  v_settings public.settings;
  v_court    public.courts;
  v_bdate    date;
  v_today    date := (now() at time zone 'Asia/Manila')::date;
  v_active   int;
  v_row      public.reservations;
  v_try      int := 0;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED: Please sign in with Google to book a court.';
  end if;
  select * into v_profile from public.profiles where id = v_uid;
  if not found or v_profile.completed_at is null then
    raise exception 'PROFILE_INCOMPLETE: Please complete your profile before booking.';
  end if;
  if p_starts_at is null or p_minutes is null then
    raise exception 'INVALID_REQUEST: A start time and duration are required.';
  end if;
  select * into v_settings from public.settings where id;
  select * into v_court from public.courts where id = p_court_id;
  if not found or not v_court.is_active then
    raise exception 'COURT_UNAVAILABLE: This court is not available for booking.';
  end if;
  if p_minutes <= 0 or p_minutes % v_settings.slot_minutes <> 0
     or p_minutes < v_settings.min_slots * v_settings.slot_minutes
     or p_minutes > v_settings.max_slots * v_settings.slot_minutes then
    raise exception 'INVALID_DURATION: That duration is not allowed.';
  end if;
  if p_starts_at <= now() then
    raise exception 'PAST_TIME: That start time has already passed.';
  end if;
  v_bdate := public._business_date(p_court_id, p_starts_at, p_minutes, v_settings.slot_minutes);
  if v_bdate is null then
    raise exception 'OUTSIDE_HOURS: That time is outside the court''s operating hours.';
  end if;
  -- Today through one calendar month ahead (Nov 11 → Dec 11; Jan 31 → Feb 28/29).
  if v_bdate > (v_today + interval '1 month')::date then
    raise exception 'OUTSIDE_WINDOW: Bookings open up to one month ahead only.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  select count(*) into v_active from public.reservations
   where user_id = v_uid and status = 'confirmed' and ends_at > now();
  if v_active >= v_settings.max_active_bookings then
    raise exception 'LIMIT_REACHED: You have reached the limit of % upcoming bookings.', v_settings.max_active_bookings;
  end if;

  loop
    v_try := v_try + 1;
    begin
      insert into public.reservations
        (reference, court_id, user_id, kind, starts_at, ends_at,
         customer_name, customer_phone, customer_email, amount, created_by)
      values
        (public._new_reference(), p_court_id, v_uid, 'online',
         p_starts_at, p_starts_at + make_interval(mins => p_minutes),
         v_profile.full_name, v_profile.phone, v_profile.email,
         case when v_court.hourly_rate is null then null
              else round(v_court.hourly_rate * p_minutes / 60.0, 2) end,
         v_uid)
      returning * into v_row;
      exit;
    exception
      when exclusion_violation then
        raise exception 'SLOT_TAKEN: Sorry, that time has just been taken. Please choose another slot.';
      when unique_violation then
        if v_try >= 5 then raise; end if;   -- reference collision: try a new one
    end;
  end loop;
  return v_row;
end $$;

-- Walk-ins and blocks (maintenance, events, closures). Uses the same overlap
-- constraint; several courts are handled atomically (all or nothing).
create or replace function public.admin_create_reservations(
  p_court_ids int[], p_starts_at timestamptz, p_ends_at timestamptz, p_kind text,
  p_customer_name text default null, p_customer_phone text default null, p_note text default null)
returns setof public.reservations language plpgsql security definer set search_path = public, extensions as $$
declare
  v_court public.courts; v_id int; v_row public.reservations; v_try int;
  v_name text := nullif(trim(coalesce(p_customer_name, '')), '');
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  if p_kind not in ('walk_in', 'block') then raise exception 'INVALID_REQUEST: Unknown reservation type.'; end if;
  if p_court_ids is null or cardinality(p_court_ids) = 0 then raise exception 'INVALID_REQUEST: Choose at least one court.'; end if;
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'INVALID_REQUEST: The end must be after the start.';
  end if;
  if p_ends_at <= now() then raise exception 'PAST_TIME: That period has already ended.'; end if;
  if p_kind = 'walk_in' and p_ends_at - p_starts_at > interval '24 hours' then
    raise exception 'INVALID_DURATION: A walk-in booking cannot be longer than 24 hours.';
  end if;
  if p_kind = 'block' and p_ends_at - p_starts_at > interval '62 days' then
    raise exception 'INVALID_DURATION: A block cannot be longer than 62 days.';
  end if;
  if p_kind = 'walk_in' and v_name is null then
    raise exception 'INVALID_REQUEST: Enter the customer''s name for a walk-in.';
  end if;

  foreach v_id in array p_court_ids loop
    select * into v_court from public.courts where id = v_id;
    if not found then raise exception 'COURT_UNAVAILABLE: Court not found.'; end if;
    v_try := 0;
    loop
      v_try := v_try + 1;
      begin
        insert into public.reservations
          (reference, court_id, kind, starts_at, ends_at, customer_name, customer_phone, note, amount, created_by)
        values
          (public._new_reference(), v_id, p_kind, p_starts_at, p_ends_at, v_name,
           nullif(trim(coalesce(p_customer_phone, '')), ''), nullif(trim(coalesce(p_note, '')), ''),
           case when p_kind = 'walk_in' and v_court.hourly_rate is not null
                then round(v_court.hourly_rate * extract(epoch from (p_ends_at - p_starts_at)) / 3600.0, 2) end,
           auth.uid())
        returning * into v_row;
        exit;
      exception
        when exclusion_violation then
          raise exception 'SLOT_TAKEN: % already has a booking or block in that period. Nothing was saved.', v_court.name;
        when unique_violation then
          if v_try >= 5 then raise; end if;
      end;
    end loop;
    perform public._log('reservation.' || p_kind, 'reservations', v_row.id::text,
      jsonb_build_object('reference', v_row.reference, 'court', v_court.name,
                         'starts_at', p_starts_at, 'ends_at', p_ends_at, 'label', coalesce(v_name, p_note)));
    return next v_row;
  end loop;
end $$;

-- Customers cancel their own upcoming bookings within the configured policy;
-- administrators can cancel anything. Cancelling frees the slot immediately.
create or replace function public.cancel_reservation(p_id uuid, p_reason text default null)
returns public.reservations language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_admin boolean := public.is_admin();
  v_row public.reservations; v_settings public.settings;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Please sign in first.'; end if;
  select * into v_row from public.reservations where id = p_id for update;
  if not found or (not v_admin and v_row.user_id is distinct from v_uid) then
    raise exception 'NOT_FOUND: Booking not found.';
  end if;
  if v_row.status = 'cancelled' then return v_row; end if;
  if not v_admin then
    select * into v_settings from public.settings where id;
    if v_row.kind <> 'online' then raise exception 'NOT_FOUND: Booking not found.'; end if;
    if not v_settings.allow_cancellation then
      raise exception 'CANCEL_NOT_ALLOWED: Online cancellation is turned off. Please message Yepjo.';
    end if;
    if now() > v_row.starts_at - make_interval(hours => v_settings.cancel_cutoff_hours) then
      raise exception 'CANCEL_NOT_ALLOWED: Bookings can be cancelled up to % hour(s) before the start time. Please message Yepjo.', v_settings.cancel_cutoff_hours;
    end if;
  end if;
  update public.reservations
     set status = 'cancelled', cancelled_at = now(), cancelled_by = v_uid,
         cancel_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = p_id
  returning * into v_row;
  if v_admin then
    perform public._log('reservation.cancel', 'reservations', v_row.id::text,
      jsonb_build_object('reference', v_row.reference, 'kind', v_row.kind, 'label', v_row.customer_name, 'reason', v_row.cancel_reason));
  end if;
  return v_row;
end $$;

-- ---------------------------------------------------------------------
-- 5. Chat functions
-- ---------------------------------------------------------------------

create or replace function public.send_message(p_id uuid, p_conversation_id uuid, p_body text)
returns public.messages language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_body text := trim(coalesce(p_body, ''));
  v_from_admin boolean;
  v_row public.messages;
  v_recent int; v_last timestamptz;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Please sign in to chat with Yepjo.'; end if;
  if p_id is null or p_conversation_id is null then raise exception 'INVALID_REQUEST: Missing message details.'; end if;

  if p_conversation_id = v_uid then
    v_from_admin := false;
    if not exists (select 1 from public.profiles where id = v_uid and completed_at is not null) then
      raise exception 'PROFILE_INCOMPLETE: Please complete your profile before sending a message.';
    end if;
  elsif public.is_admin() then
    v_from_admin := true;
    if not exists (select 1 from public.conversations where user_id = p_conversation_id) then
      raise exception 'NOT_FOUND: Conversation not found.';
    end if;
  else
    raise exception 'FORBIDDEN: You can only send messages in your own conversation.';
  end if;

  if char_length(v_body) = 0 then raise exception 'INVALID_MESSAGE: Type a message first.'; end if;
  if char_length(v_body) > 1000 then raise exception 'INVALID_MESSAGE: Messages are limited to 1,000 characters.'; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 11));

  -- A retry of a message that was actually saved returns the saved row.
  select * into v_row from public.messages where id = p_id;
  if found then
    if v_row.sender_id = v_uid then return v_row; end if;
    raise exception 'INVALID_REQUEST: Duplicate message id.';
  end if;

  -- Flood protection: at most 1 message per second and 6 per 15 seconds per sender.
  select count(*), max(created_at) into v_recent, v_last
    from public.messages where sender_id = v_uid and created_at > now() - interval '15 seconds';
  if v_last is not null and clock_timestamp() - v_last < interval '1 second' then
    raise exception 'RATE_LIMIT: You are sending messages too quickly. Please wait a moment.';
  end if;
  if v_recent >= 6 then
    raise exception 'RATE_LIMIT: Too many messages in a short time. Please wait a few seconds.';
  end if;

  insert into public.conversations (user_id) values (p_conversation_id) on conflict (user_id) do nothing;
  insert into public.messages (id, conversation_id, sender_id, from_admin, body, created_at)
  values (p_id, p_conversation_id, v_uid, v_from_admin, v_body, clock_timestamp())
  returning * into v_row;

  update public.conversations
     set last_message_at = v_row.created_at,
         last_preview    = left(v_body, 120),
         admin_unread    = case when v_from_admin then 0 else admin_unread + 1 end,
         user_unread     = case when v_from_admin then user_unread + 1 else 0 end
   where user_id = p_conversation_id;
  return v_row;
end $$;

create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  if p_conversation_id = auth.uid() then
    update public.conversations set user_unread = 0 where user_id = p_conversation_id and user_unread <> 0;
  elsif public.is_admin() then
    update public.conversations set admin_unread = 0 where user_id = p_conversation_id and admin_unread <> 0;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 6. Administrator management (after the first admin is assigned by SQL)
-- ---------------------------------------------------------------------

create or replace function public.admin_list()
returns table (user_id uuid, email text, full_name text, added_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  return query
    select a.user_id, p.email, p.full_name, a.added_at
    from public.admins a left join public.profiles p on p.id = a.user_id
    order by a.added_at;
end $$;

create or replace function public.admin_grant(p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  select id into v_id from public.profiles where lower(email) = lower(trim(coalesce(p_email, '')));
  if v_id is null then
    raise exception 'NOT_FOUND: No account uses that email yet. Ask them to sign in with Google once first.';
  end if;
  insert into public.admins (user_id, added_by) values (v_id, auth.uid()) on conflict do nothing;
  perform public._log('admin.grant', 'admins', v_id::text, jsonb_build_object('label', lower(trim(p_email))));
end $$;

create or replace function public.admin_revoke(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  if p_user_id = auth.uid() then raise exception 'INVALID_REQUEST: You cannot remove your own administrator access.'; end if;
  delete from public.admins where user_id = p_user_id;
  perform public._log('admin.revoke', 'admins', p_user_id::text,
    jsonb_build_object('label', (select email from public.profiles where id = p_user_id)));
end $$;

-- ---------------------------------------------------------------------
-- 7. Triggers: timestamps, default hours, audit log, change pulse
-- ---------------------------------------------------------------------

create or replace function public._touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger settings_touch before update on public.settings for each row execute function public._touch();

create or replace function public._announcement_stamp()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.is_published and (tg_op = 'INSERT' or not old.is_published) then
    new.published_at := now();
  end if;
  if tg_op = 'INSERT' then new.created_by := auth.uid(); end if;
  return new;
end $$;
create trigger announcements_stamp before insert or update on public.announcements
  for each row execute function public._announcement_stamp();

-- Every new court starts with the placeholder hours 12:00 noon – 1:00 AM daily.
create or replace function public._seed_court_hours()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.court_hours (court_id, dow)
  select new.id, g from generate_series(0, 6) g on conflict do nothing;
  return new;
end $$;
create trigger courts_seed_hours after insert on public.courts
  for each row execute function public._seed_court_hours();

create or replace function public._audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare r jsonb; o jsonb; v_changed jsonb := '[]';
begin
  if auth.uid() is null then return null; end if;      -- migrations / service role
  r := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  if tg_op = 'UPDATE' then
    o := to_jsonb(old);
    select coalesce(jsonb_agg(e.key), '[]') into v_changed
      from jsonb_each(r) e
     where e.value is distinct from o -> e.key and e.key not in ('updated_at', 'published_at');
    if v_changed = '[]' then return null; end if;
  end if;
  perform public._log(
    tg_table_name || '.' || lower(tg_op), tg_table_name,
    coalesce(r ->> 'id', r ->> 'court_id'),
    jsonb_build_object('label', coalesce(r ->> 'title', r ->> 'name', nullif(r ->> 'caption', ''), r ->> 'business_name'),
                       'changed', v_changed));
  return null;
end $$;

create trigger audit_announcements   after insert or update or delete on public.announcements   for each row execute function public._audit();
create trigger audit_carousel_photos after insert or update or delete on public.carousel_photos for each row execute function public._audit();
create trigger audit_courts          after insert or update or delete on public.courts          for each row execute function public._audit();
create trigger audit_court_hours     after update on public.court_hours                         for each row execute function public._audit();
create trigger audit_settings        after update on public.settings                            for each row execute function public._audit();

create or replace function public._bump_pulse()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.pulse (id, bumped_at) values (true, clock_timestamp())
  on conflict (id) do update set bumped_at = excluded.bumped_at;
  return null;
end $$;

create trigger pulse_reservations    after insert or update or delete on public.reservations    for each statement execute function public._bump_pulse();
create trigger pulse_courts          after insert or update or delete on public.courts          for each statement execute function public._bump_pulse();
create trigger pulse_court_hours     after insert or update or delete on public.court_hours     for each statement execute function public._bump_pulse();
create trigger pulse_settings        after update on public.settings                            for each statement execute function public._bump_pulse();
create trigger pulse_announcements   after insert or update or delete on public.announcements   for each statement execute function public._bump_pulse();
create trigger pulse_carousel_photos after insert or update or delete on public.carousel_photos for each statement execute function public._bump_pulse();

-- ---------------------------------------------------------------------
-- 8. Row Level Security
-- ---------------------------------------------------------------------

alter table public.profiles        enable row level security;
alter table public.admins          enable row level security;
alter table public.settings        enable row level security;
alter table public.courts          enable row level security;
alter table public.court_hours     enable row level security;
alter table public.reservations    enable row level security;
alter table public.pulse           enable row level security;
alter table public.announcements   enable row level security;
alter table public.carousel_photos enable row level security;
alter table public.conversations   enable row level security;
alter table public.messages        enable row level security;
alter table public.activity_logs   enable row level security;

-- Profiles: read your own (admins read all). Writes only through save_profile().
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

-- Admins: visible to admins only. No write policy exists for any client role.
create policy admins_select on public.admins for select to authenticated
  using ((select public.is_admin()));

-- Public site configuration.
create policy settings_select on public.settings for select to anon, authenticated using (true);
create policy settings_update on public.settings for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy courts_select on public.courts for select to anon, authenticated using (true);
create policy courts_insert on public.courts for insert to authenticated with check ((select public.is_admin()));
create policy courts_update on public.courts for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy courts_delete on public.courts for delete to authenticated using ((select public.is_admin()));

create policy court_hours_select on public.court_hours for select to anon, authenticated using (true);
create policy court_hours_insert on public.court_hours for insert to authenticated with check ((select public.is_admin()));
create policy court_hours_update on public.court_hours for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy court_hours_delete on public.court_hours for delete to authenticated using ((select public.is_admin()));

-- Reservations: customers see only their own rows; the public sees availability
-- solely through get_availability(). Writes only through the booking functions.
create policy reservations_select on public.reservations for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

create policy pulse_select on public.pulse for select to anon, authenticated using (true);

create policy announcements_select on public.announcements for select to anon, authenticated
  using (is_published or (select public.is_admin()));
create policy announcements_insert on public.announcements for insert to authenticated with check ((select public.is_admin()));
create policy announcements_update on public.announcements for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy announcements_delete on public.announcements for delete to authenticated using ((select public.is_admin()));

create policy carousel_select on public.carousel_photos for select to anon, authenticated
  using (is_active or (select public.is_admin()));
create policy carousel_insert on public.carousel_photos for insert to authenticated with check ((select public.is_admin()));
create policy carousel_update on public.carousel_photos for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy carousel_delete on public.carousel_photos for delete to authenticated using ((select public.is_admin()));

-- Chat: a user reads only their own conversation; admins read the inbox.
-- Messages are written only through send_message().
create policy conversations_select on public.conversations for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy messages_select on public.messages for select to authenticated
  using (conversation_id = (select auth.uid()) or (select public.is_admin()));

create policy activity_logs_select on public.activity_logs for select to authenticated
  using ((select public.is_admin()));

-- Table privileges (defence in depth on top of RLS).
revoke all on public.profiles, public.admins, public.reservations, public.pulse,
              public.conversations, public.messages, public.activity_logs from anon, authenticated;
grant select on public.profiles, public.admins, public.reservations,
                public.conversations, public.messages, public.activity_logs to authenticated;
grant select on public.pulse to anon, authenticated;
revoke all on public.settings, public.courts, public.court_hours,
              public.announcements, public.carousel_photos from anon;
grant select on public.settings, public.courts, public.court_hours,
                public.announcements, public.carousel_photos to anon;
-- Explicit (some projects do not auto-grant new tables); RLS limits writes to admins.
grant select, insert, update, delete on public.settings, public.courts, public.court_hours,
                public.announcements, public.carousel_photos to authenticated;

-- Function privileges.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.is_admin()                                   to anon, authenticated;
grant execute on function public.normalize_phone(text)                        to anon, authenticated;
grant execute on function public.get_availability(timestamptz, timestamptz)   to anon, authenticated;
grant execute on function public.save_profile(text, text)                     to authenticated;
grant execute on function public.book_court(int, timestamptz, int)            to authenticated;
grant execute on function public.cancel_reservation(uuid, text)               to authenticated;
grant execute on function public.admin_create_reservations(int[], timestamptz, timestamptz, text, text, text, text) to authenticated;
grant execute on function public.send_message(uuid, uuid, text)               to authenticated;
grant execute on function public.mark_conversation_read(uuid)                 to authenticated;
grant execute on function public.admin_list()                                 to authenticated;
grant execute on function public.admin_grant(text)                            to authenticated;
grant execute on function public.admin_revoke(uuid)                           to authenticated;

-- ---------------------------------------------------------------------
-- 9. Storage: one public-read bucket that only accepts WebP ≤ 300,000 bytes.
--    There is NO insert/update policy: uploads go through the `upload-photo`
--    Edge Function, which re-validates the bytes and uses the service role.
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 300000, array['image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = 300000, allowed_mime_types = array['image/webp'];

create policy photos_admin_select on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (select public.is_admin()));
create policy photos_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (select public.is_admin()));

-- ---------------------------------------------------------------------
-- 10. Realtime
-- ---------------------------------------------------------------------

alter publication supabase_realtime add table public.pulse;
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.conversations;

-- ---------------------------------------------------------------------
-- 11. Seed data (initial business details and courts from the reference)
-- ---------------------------------------------------------------------

insert into public.settings (id) values (true) on conflict do nothing;
insert into public.pulse (id) values (true) on conflict do nothing;

insert into public.courts (sport, name, sort_order) values
  ('pickleball', 'Court 1', 1), ('pickleball', 'Court 2', 2), ('pickleball', 'Court 3', 3),
  ('pickleball', 'Court 4', 4), ('pickleball', 'Court 5', 5),
  ('badminton',  'Court 1', 1), ('badminton',  'Court 2', 2);

-- Back-fill profiles for any accounts that existed before this migration.
insert into public.profiles (id, email, full_name)
select u.id, coalesce(u.email, ''),
       nullif(trim(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', '')), '')
from auth.users u on conflict (id) do nothing;
