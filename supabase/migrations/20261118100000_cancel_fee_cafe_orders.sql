-- 1) Cancellation fee: when a customer cancels something already paid online, Yepjo keeps
--    cancel_fee_percent (default 50%) and the rest is refunded in person at the venue.
--    Admins can cancel with a full refund (e.g. Yepjo had to close).
-- 2) Yepjo Cafe: hours, and orders ahead / for pickup, prepared only after the QR payment is approved.

-- ====================================================================== settings
alter table public.settings add column if not exists cancel_fee_percent int not null default 50;
alter table public.settings drop constraint if exists settings_cancel_fee_chk;
alter table public.settings add constraint settings_cancel_fee_chk check (cancel_fee_percent between 0 and 100);
alter table public.settings add column if not exists cafe_opens time not null default '07:00';
alter table public.settings add column if not exists cafe_closes time not null default '01:00';
alter table public.settings add column if not exists cafe_ordering_enabled boolean not null default true;
alter table public.settings add column if not exists cafe_prep_minutes int not null default 15;
alter table public.settings drop constraint if exists settings_cafe_prep_chk;
alter table public.settings add constraint settings_cafe_prep_chk check (cafe_prep_minutes between 0 and 240);
update public.settings
   set cancellation_note = 'Cancel up to 6 hours before your booking. If you already paid online, 50% is kept as a cancellation fee and the other 50% is refunded in person at Yepjo.'
 where id and cancellation_note like 'You can cancel in the app up to 6 hours%';

-- ====================================================================== refund tracking
do $$
declare t text;
begin
  foreach t in array array['reservations', 'registrations'] loop
    execute format('alter table public.%I add column if not exists cancel_fee numeric(10,2)', t);
    execute format('alter table public.%I add column if not exists refund_amount numeric(10,2)', t);
    execute format($f$alter table public.%I add column if not exists refund_status text not null default 'none'$f$, t);
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_refund_status_chk');
    execute format($f$alter table public.%I add constraint %I check (refund_status in ('none', 'to_claim', 'claimed'))$f$, t, t || '_refund_status_chk');
    execute format('alter table public.%I add column if not exists refund_claimed_at timestamptz', t);
    execute format('alter table public.%I add column if not exists refund_claimed_by uuid', t);
  end loop;
end $$;
alter table public.registrations add column if not exists cancelled_by uuid;

-- Fee and refund for a paid item being cancelled.
create or replace function public._refund_split(p_amount numeric, p_paid boolean, p_full boolean)
returns table (fee numeric, refund numeric) language sql stable set search_path = public as $$
  select case when not p_paid or coalesce(p_amount, 0) <= 0 then null
              when p_full then 0
              else round(p_amount * (select cancel_fee_percent from public.settings where id) / 100.0, 2) end,
         case when not p_paid or coalesce(p_amount, 0) <= 0 then null
              when p_full then p_amount
              else p_amount - round(p_amount * (select cancel_fee_percent from public.settings where id) / 100.0, 2) end
$$;

-- ---------------------------------------------------------------------- court bookings
drop function if exists public.cancel_reservation(uuid, text);
create or replace function public.cancel_reservation(p_id uuid, p_reason text default null, p_full_refund boolean default false)
returns public.reservations language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_admin boolean := public.is_admin();
  v_row public.reservations; v_settings public.settings; v_fee numeric; v_refund numeric;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Please sign in first.'; end if;
  select * into v_settings from public.settings where id;
  select * into v_row from public.reservations where id = p_id for update;
  if not found or (not v_admin and v_row.user_id is distinct from v_uid) then
    raise exception 'NOT_FOUND: Booking not found.';
  end if;
  if v_row.status = 'cancelled' then return v_row; end if;
  if not v_admin then
    if v_row.kind <> 'online' then raise exception 'NOT_FOUND: Booking not found.'; end if;
    if v_row.status = 'confirmed' then
      if not v_settings.allow_cancellation then
        raise exception 'CANCEL_NOT_ALLOWED: Online cancellation is turned off. Please message Yepjo.';
      end if;
      if now() > v_row.starts_at - make_interval(hours => v_settings.cancel_cutoff_hours) then
        raise exception 'CANCEL_NOT_ALLOWED: Bookings can be cancelled up to % hour(s) before the start time. Please call or message Yepjo.', v_settings.cancel_cutoff_hours;
      end if;
    elsif v_row.payment_status = 'submitted' then
      raise exception 'CANCEL_NOT_ALLOWED: Your payment is being checked. Please message Yepjo to cancel.';
    end if;
  end if;
  select fee, refund into v_fee, v_refund
    from public._refund_split(v_row.amount, v_row.payment_status = 'verified', v_admin and coalesce(p_full_refund, false));
  update public.reservations
     set status = 'cancelled', cancelled_at = now(), cancelled_by = v_uid,
         cancel_reason = nullif(trim(coalesce(p_reason, '')), ''),
         cancel_fee = v_fee, refund_amount = v_refund,
         refund_status = case when coalesce(v_refund, 0) > 0 then 'to_claim' else 'none' end
   where id = p_id
  returning * into v_row;
  if v_admin then
    perform public._log('reservation.cancel', 'reservations', v_row.id::text,
      jsonb_build_object('reference', v_row.reference, 'kind', v_row.kind, 'label', v_row.customer_name,
                         'reason', v_row.cancel_reason, 'fee', v_fee, 'refund', v_refund));
  end if;
  return v_row;
end $$;

-- ---------------------------------------------------------------------- event / class sign-ups
drop function if exists public.cancel_registration(uuid, text);
create or replace function public.cancel_registration(p_id uuid, p_reason text default null, p_full_refund boolean default false)
returns public.registrations language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_row public.registrations; v_admin boolean := public.is_admin();
  v_start timestamptz; v_settings public.settings; v_fee numeric; v_refund numeric;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Please sign in first.'; end if;
  select * into v_settings from public.settings where id;
  select * into v_row from public.registrations where id = p_id for update;
  if not found or (v_row.user_id is distinct from v_uid and not v_admin) then raise exception 'NOT_FOUND: Sign-up not found.'; end if;
  if v_row.status = 'cancelled' then return v_row; end if;
  if not v_admin then
    if v_row.payment_status = 'submitted' then
      raise exception 'CANCEL_NOT_ALLOWED: Your payment is being checked. Please message Yepjo to cancel.';
    end if;
    select coalesce((select starts_at from public.dance_sessions where id = v_row.dance_session_id),
                    (select (starts_on + start_time) at time zone 'Asia/Manila' from public.events where id = v_row.event_id))
      into v_start;
    if v_start is not null and now() > v_start - make_interval(hours => v_settings.cancel_cutoff_hours) then
      raise exception 'CANCEL_NOT_ALLOWED: Sign-ups can be cancelled up to % hour(s) before the start. Please call or message Yepjo.', v_settings.cancel_cutoff_hours;
    end if;
  end if;
  select fee, refund into v_fee, v_refund
    from public._refund_split(v_row.amount, v_row.payment_status = 'verified', v_admin and coalesce(p_full_refund, false));
  update public.registrations set status = 'cancelled', cancelled_at = now(), cancelled_by = v_uid,
         cancel_reason = nullif(trim(coalesce(p_reason, '')), ''),
         cancel_fee = v_fee, refund_amount = v_refund,
         refund_status = case when coalesce(v_refund, 0) > 0 then 'to_claim' else 'none' end
   where id = p_id returning * into v_row;
  if v_admin and v_row.user_id is distinct from v_uid then
    perform public._log('registration.cancel', 'registrations', p_id::text,
      jsonb_build_object('label', v_row.reference, 'fee', v_fee, 'refund', v_refund));
  end if;
  return v_row;
end $$;

-- ====================================================================== cafe orders
create table if not exists public.cafe_orders (
  id              uuid primary key default gen_random_uuid(),
  reference       text not null unique default public._new_reference(),
  user_id         uuid references auth.users (id) on delete set null,
  customer_name   text,
  customer_phone  text,
  items           jsonb not null,        -- [{id, name, price, qty}] as ordered
  total           numeric(10, 2) not null check (total > 0),
  pickup_at       timestamptz,           -- null = as soon as it is ready
  note            text check (note is null or char_length(note) <= 300),
  status          text not null default 'pending' check (status in ('pending', 'paid', 'preparing', 'ready', 'completed', 'cancelled')),
  payment_status  text not null default 'unpaid' check (payment_status in ('unpaid', 'submitted', 'verified', 'rejected')),
  payment_ref     text check (payment_ref is null or payment_ref ~ '^[0-9]{6}$'),
  payment_submitted_at timestamptz,
  payment_verified_at  timestamptz,
  payment_verified_by  uuid,
  payment_note    text,
  hold_expires_at timestamptz,
  refund_amount   numeric(10, 2),
  refund_status   text not null default 'none' check (refund_status in ('none', 'to_claim', 'claimed')),
  refund_claimed_at timestamptz,
  refund_claimed_by uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  cancelled_at    timestamptz,
  cancel_reason   text
);
create index if not exists cafe_orders_user_idx on public.cafe_orders (user_id, created_at desc);
create index if not exists cafe_orders_status_idx on public.cafe_orders (status, created_at);

alter table public.cafe_orders enable row level security;
create policy cafe_orders_select on public.cafe_orders for select to authenticated using (user_id = (select auth.uid()) or (select public.is_admin()));
revoke all on public.cafe_orders from anon, authenticated;
grant select on public.cafe_orders to authenticated;
create trigger pulse_cafe_orders after insert or update or delete on public.cafe_orders
  for each statement execute function public._bump_pulse();

-- Is a Manila wall-clock time inside the cafe's opening hours?
create or replace function public._cafe_open_at(p_at timestamptz)
returns boolean language sql stable set search_path = public as $$
  select public._time_in((p_at at time zone 'Asia/Manila')::time, s.cafe_opens, s.cafe_closes) from public.settings s where s.id
$$;

create or replace function public._expire_cafe_holds()
returns void language sql security definer set search_path = public as $$
  update public.cafe_orders set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Payment not received in time', updated_at = now()
   where status = 'pending' and payment_status in ('unpaid', 'rejected') and hold_expires_at < now()
$$;

create or replace function public.place_cafe_order(p_items jsonb, p_pickup_at timestamptz default null, p_note text default null)
returns public.cafe_orders language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_p public.profiles; v_s public.settings; v_row public.cafe_orders;
  v_lines jsonb := '[]'; v_total numeric := 0; v_line jsonb; v_item public.cafe_items; v_qty int; v_ready timestamptz;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Please sign in first.'; end if;
  select * into v_p from public.profiles where id = v_uid;
  if v_p.completed_at is null then raise exception 'PROFILE_INCOMPLETE: Add your name and contact number first.'; end if;
  select * into v_s from public.settings where id;
  if not v_s.cafe_ordering_enabled or not v_s.online_payment_enabled or v_s.payment_qr_path is null then
    raise exception 'ORDERING_CLOSED: Online ordering is not open right now. Please order at the counter.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'INVALID_REQUEST: Your order is empty.'; end if;
  if jsonb_array_length(p_items) > 30 then raise exception 'INVALID_REQUEST: Too many different items in one order.'; end if;
  if (select count(*) from public.cafe_orders where user_id = v_uid and status = 'pending' and payment_status in ('unpaid', 'rejected') and hold_expires_at > now()) >= 3 then
    raise exception 'TOO_MANY_PENDING: Please pay or cancel your unpaid orders first.';
  end if;

  for v_line in select x from jsonb_array_elements(p_items) x loop
    begin v_qty := (v_line ->> 'qty')::int; exception when others then v_qty := null; end;
    if v_qty is null or v_qty < 1 or v_qty > 20 then raise exception 'INVALID_REQUEST: Quantities must be 1 to 20.'; end if;
    select * into v_item from public.cafe_items where id = (v_line ->> 'id')::uuid;
    if not found then raise exception 'ITEM_UNAVAILABLE: An item in your order is no longer on the menu.'; end if;
    if not v_item.is_available or v_item.price is null then
      raise exception 'ITEM_UNAVAILABLE: % is not available to order right now.', v_item.name;
    end if;
    v_lines := v_lines || jsonb_build_object('id', v_item.id, 'name', v_item.name, 'price', v_item.price, 'qty', v_qty);
    v_total := v_total + v_item.price * v_qty;
  end loop;

  v_ready := now() + make_interval(mins => v_s.cafe_prep_minutes);
  if p_pickup_at is null then
    if not public._cafe_open_at(now()) then
      raise exception 'CAFE_CLOSED: Yepjo Cafe is closed now. Choose a pickup time during opening hours.';
    end if;
  else
    if p_pickup_at < v_ready - interval '1 minute' then
      raise exception 'INVALID_PICKUP: Choose a pickup time at least % minutes from now.', v_s.cafe_prep_minutes;
    end if;
    if p_pickup_at > now() + interval '7 days' then raise exception 'INVALID_PICKUP: You can order up to 7 days ahead.'; end if;
    if not public._cafe_open_at(p_pickup_at) then raise exception 'INVALID_PICKUP: That time is outside the cafe''s opening hours.'; end if;
  end if;

  insert into public.cafe_orders (user_id, customer_name, customer_phone, items, total, pickup_at, note, hold_expires_at)
  values (v_uid, v_p.full_name, v_p.phone, v_lines, v_total, p_pickup_at, nullif(trim(coalesce(p_note, '')), ''),
          now() + make_interval(mins => v_s.payment_hold_minutes))
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.submit_order_payment(p_id uuid, p_ref text)
returns public.cafe_orders language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_ref text := regexp_replace(coalesce(p_ref, ''), '\D', '', 'g'); v_row public.cafe_orders;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Please sign in first.'; end if;
  if v_ref !~ '^[0-9]{6}$' then raise exception 'INVALID_REFERENCE: Enter exactly the last 6 digits of your payment reference number.'; end if;
  select * into v_row from public.cafe_orders where id = p_id for update;
  if not found or v_row.user_id is distinct from v_uid then raise exception 'NOT_FOUND: Order not found.'; end if;
  if v_row.status <> 'pending' then raise exception 'INVALID_REQUEST: This order is not waiting for payment.'; end if;
  if v_row.payment_status = 'submitted' then raise exception 'ALREADY_SUBMITTED: Your reference was already sent. Yepjo will confirm it soon.'; end if;
  if v_row.hold_expires_at < now() then
    update public.cafe_orders set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Payment not received in time', updated_at = now()
     where id = p_id returning * into v_row;
    return v_row;
  end if;
  update public.cafe_orders set payment_ref = v_ref, payment_status = 'submitted', payment_submitted_at = now(), payment_note = null, updated_at = now()
   where id = p_id returning * into v_row;
  return v_row;
end $$;

create or replace function public.admin_review_order(p_id uuid, p_approve boolean, p_note text default null)
returns public.cafe_orders language plpgsql security definer set search_path = public as $$
declare v_row public.cafe_orders; v_s public.settings; v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  select * into v_s from public.settings where id;
  select * into v_row from public.cafe_orders where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Order not found.'; end if;
  if v_row.status <> 'pending' or v_row.payment_status <> 'submitted' then
    raise exception 'INVALID_REQUEST: This order has no payment waiting to be checked.';
  end if;
  if p_approve then
    update public.cafe_orders set status = 'paid', payment_status = 'verified', payment_verified_at = now(), payment_verified_by = auth.uid(),
           payment_note = v_note, hold_expires_at = null, updated_at = now()
     where id = p_id returning * into v_row;
  else
    update public.cafe_orders set payment_status = 'rejected', payment_note = coalesce(v_note, 'Payment not found.'),
           hold_expires_at = now() + make_interval(mins => v_s.payment_hold_minutes), updated_at = now()
     where id = p_id returning * into v_row;
  end if;
  perform public._log(case when p_approve then 'cafe_order.payment_approve' else 'cafe_order.payment_reject' end,
                      'cafe_orders', p_id::text, jsonb_build_object('label', v_row.reference, 'total', v_row.total, 'note', v_note));
  return v_row;
end $$;

-- Kitchen flow: paid → preparing → ready → completed; or cancelled (paid orders: refund at the counter).
create or replace function public.admin_set_order_status(p_id uuid, p_status text, p_reason text default null)
returns public.cafe_orders language plpgsql security definer set search_path = public as $$
declare v_row public.cafe_orders; v_paid boolean;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  if p_status not in ('preparing', 'ready', 'completed', 'cancelled') then raise exception 'INVALID_REQUEST: Unknown status.'; end if;
  select * into v_row from public.cafe_orders where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Order not found.'; end if;
  if v_row.status in ('completed', 'cancelled') then raise exception 'INVALID_REQUEST: This order is already %.', v_row.status; end if;
  if p_status <> 'cancelled' and v_row.status = 'pending' then
    raise exception 'NOT_PAID: Approve the payment before preparing this order.';
  end if;
  v_paid := v_row.payment_status = 'verified';
  update public.cafe_orders
     set status = p_status, updated_at = now(),
         cancelled_at = case when p_status = 'cancelled' then now() end,
         cancel_reason = case when p_status = 'cancelled' then coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Cancelled by Yepjo') end,
         refund_amount = case when p_status = 'cancelled' and v_paid then total end,
         refund_status = case when p_status = 'cancelled' and v_paid then 'to_claim' else refund_status end
   where id = p_id returning * into v_row;
  if p_status = 'cancelled' then
    perform public._log('cafe_order.cancel', 'cafe_orders', p_id::text, jsonb_build_object('label', v_row.reference, 'refund', v_row.refund_amount));
  end if;
  return v_row;
end $$;

create or replace function public.cancel_cafe_order(p_id uuid)
returns public.cafe_orders language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_row public.cafe_orders;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Please sign in first.'; end if;
  select * into v_row from public.cafe_orders where id = p_id for update;
  if not found or v_row.user_id is distinct from v_uid then raise exception 'NOT_FOUND: Order not found.'; end if;
  if v_row.status = 'cancelled' then return v_row; end if;
  if v_row.status <> 'pending' or v_row.payment_status = 'submitted' then
    raise exception 'CANCEL_NOT_ALLOWED: Your payment was already sent. Please message Yepjo to change this order.';
  end if;
  update public.cafe_orders set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Cancelled by customer', updated_at = now()
   where id = p_id returning * into v_row;
  return v_row;
end $$;

-- Refund handed over at the counter.
create or replace function public.admin_mark_refund_claimed(p_kind text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_ref text; v_amt numeric;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  if p_kind = 'reservation' then
    update public.reservations set refund_status = 'claimed', refund_claimed_at = now(), refund_claimed_by = auth.uid()
     where id = p_id and refund_status = 'to_claim' returning reference, refund_amount into v_ref, v_amt;
  elsif p_kind = 'registration' then
    update public.registrations set refund_status = 'claimed', refund_claimed_at = now(), refund_claimed_by = auth.uid()
     where id = p_id and refund_status = 'to_claim' returning reference, refund_amount into v_ref, v_amt;
  elsif p_kind = 'order' then
    update public.cafe_orders set refund_status = 'claimed', refund_claimed_at = now(), refund_claimed_by = auth.uid(), updated_at = now()
     where id = p_id and refund_status = 'to_claim' returning reference, refund_amount into v_ref, v_amt;
  else
    raise exception 'INVALID_REQUEST: Unknown item.';
  end if;
  if v_ref is null then raise exception 'NOT_FOUND: No refund waiting for this item.'; end if;
  perform public._log('refund.claimed', p_kind, p_id::text, jsonb_build_object('label', v_ref, 'amount', v_amt));
end $$;

-- Admin list of refunds waiting to be handed over.
create or replace function public.admin_refunds_to_claim()
returns table (kind text, id uuid, reference text, customer_name text, customer_phone text, what text, amount numeric, fee numeric, refund numeric, cancelled_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  return query
    select 'reservation', r.id, r.reference, r.customer_name, r.customer_phone,
           c.sport || ' ' || c.name || ' · ' || to_char(r.starts_at at time zone 'Asia/Manila', 'Mon DD, FMHH12:MI AM'),
           r.amount, r.cancel_fee, r.refund_amount, r.cancelled_at
      from public.reservations r join public.courts c on c.id = r.court_id where r.refund_status = 'to_claim'
    union all
    select 'registration', g.id, g.reference, g.customer_name, g.customer_phone,
           coalesce((select 'Event · ' || e.title from public.events e where e.id = g.event_id),
                    (select 'Step Up Dance · ' || d.dance_type from public.dance_sessions d where d.id = g.dance_session_id)),
           g.amount, g.cancel_fee, g.refund_amount, g.cancelled_at
      from public.registrations g where g.refund_status = 'to_claim'
    union all
    select 'order', o.id, o.reference, o.customer_name, o.customer_phone, 'Cafe order', o.total, 0::numeric, o.refund_amount, o.cancelled_at
      from public.cafe_orders o where o.refund_status = 'to_claim'
    order by 10;
end $$;

-- Extra income for the monthly report: cafe orders, cancellation fees kept, refunds.
create or replace function public.admin_report_extras(p_month date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz := (date_trunc('month', p_month)::date)::timestamp at time zone 'Asia/Manila';
        v_to timestamptz := ((date_trunc('month', p_month) + interval '1 month')::date)::timestamp at time zone 'Asia/Manila';
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  return jsonb_build_object(
    'cafe_sales', coalesce((select sum(total) from public.cafe_orders where payment_status = 'verified' and status <> 'cancelled'
                              and payment_verified_at >= v_from and payment_verified_at < v_to), 0),
    'cafe_orders', (select count(*) from public.cafe_orders where payment_status = 'verified' and status <> 'cancelled'
                      and payment_verified_at >= v_from and payment_verified_at < v_to),
    'cancel_fees', coalesce((select sum(cancel_fee) from public.reservations where cancel_fee > 0 and cancelled_at >= v_from and cancelled_at < v_to), 0)
                 + coalesce((select sum(cancel_fee) from public.registrations where cancel_fee > 0 and cancelled_at >= v_from and cancelled_at < v_to), 0),
    'signup_sales', coalesce((select sum(amount) from public.registrations where status = 'confirmed' and amount > 0
                                and created_at >= v_from and created_at < v_to), 0),
    'refunds_waiting', (select count(*) from public.admin_refunds_to_claim()));
end $$;

-- ====================================================================== points for cafe orders
alter table public.points_ledger drop constraint if exists points_ledger_source_check;
alter table public.points_ledger add constraint points_ledger_source_check
  check (source in ('court', 'dance', 'event', 'purchase', 'cafe', 'manual', 'redeem', 'reversal'));
drop index if exists public.points_ledger_once;
create unique index points_ledger_once on public.points_ledger (source, ref) where source in ('court', 'dance', 'event', 'cafe');

create or replace function public._award_order_points()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_s public.settings; v_pts numeric; v_given numeric;
begin
  if new.user_id is null then return null; end if;
  select * into v_s from public.settings where id;
  if new.status = 'paid' and old.status = 'pending' then
    if not v_s.rewards_enabled or v_s.points_purchase_amount <= 0 then return null; end if;
    v_pts := floor(new.total / v_s.points_purchase_amount);
    if v_pts > 0 then
      insert into public.points_ledger (user_id, points, source, ref, note)
      values (new.user_id, v_pts, 'cafe', new.id::text, 'Cafe order ' || new.reference) on conflict do nothing;
    end if;
  elsif new.status = 'cancelled' and old.status not in ('pending', 'cancelled') then
    select sum(points) into v_given from public.points_ledger where ref = new.id::text and source in ('cafe', 'reversal');
    if coalesce(v_given, 0) > 0 then
      insert into public.points_ledger (user_id, points, source, ref, note)
      values (new.user_id, -v_given, 'reversal', new.id::text, 'Cancelled order ' || new.reference);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists award_points on public.cafe_orders;
create trigger award_points after update of status on public.cafe_orders
  for each row execute function public._award_order_points();

-- ====================================================================== grants
revoke all on function public._refund_split(numeric, boolean, boolean) from public, anon, authenticated;
revoke all on function public._cafe_open_at(timestamptz) from public, anon, authenticated;
revoke all on function public._expire_cafe_holds() from public, anon, authenticated;
revoke all on function public.cancel_reservation(uuid, text, boolean) from public, anon;
revoke all on function public.cancel_registration(uuid, text, boolean) from public, anon;
revoke all on function public.place_cafe_order(jsonb, timestamptz, text) from public, anon;
revoke all on function public.submit_order_payment(uuid, text) from public, anon;
revoke all on function public.admin_review_order(uuid, boolean, text) from public, anon;
revoke all on function public.admin_set_order_status(uuid, text, text) from public, anon;
revoke all on function public.cancel_cafe_order(uuid) from public, anon;
revoke all on function public.admin_mark_refund_claimed(text, uuid) from public, anon;
revoke all on function public.admin_refunds_to_claim() from public, anon;
revoke all on function public.admin_report_extras(date) from public, anon;
grant execute on function public.cancel_reservation(uuid, text, boolean) to authenticated;
grant execute on function public.cancel_registration(uuid, text, boolean) to authenticated;
grant execute on function public.place_cafe_order(jsonb, timestamptz, text) to authenticated;
grant execute on function public.submit_order_payment(uuid, text) to authenticated;
grant execute on function public.admin_review_order(uuid, boolean, text) to authenticated;
grant execute on function public.admin_set_order_status(uuid, text, text) to authenticated;
grant execute on function public.cancel_cafe_order(uuid) to authenticated;
grant execute on function public.admin_mark_refund_claimed(text, uuid) to authenticated;
grant execute on function public.admin_refunds_to_claim() to authenticated;
grant execute on function public.admin_report_extras(date) to authenticated;

-- ====================================================================== Yepjo Cafe menu (from the cafe's posters)
-- Prices are left for the admin to fill in; items without a price are shown but cannot be ordered online.
insert into public.cafe_items (category, name, description, price, image_path, sort_order)
select * from (values
  ('All-day breakfast', 'Tapsilog', 'Beef tapa, garlic rice, egg, fresh tomato and cucumber', null::numeric, '/photos/cafe/tapa.webp', 1),
  ('All-day breakfast', 'Tocilog', 'Sweet pork tocino, garlic rice, egg', null, '/photos/cafe/tocino.webp', 2),
  ('All-day breakfast', 'Longsilog', 'Longganisa, garlic rice, egg', null, '/photos/cafe/longganisa.webp', 3),
  ('All-day breakfast', 'Spamsilog', 'Spam, garlic rice, egg', null, null, 4),
  ('All-day breakfast', 'Hotsilog', 'Hotdog, garlic rice, egg', null, null, 5),
  ('All-day breakfast', 'Cornsilog', 'Corned beef, garlic rice, egg', null, null, 6),
  ('All-day breakfast', 'Hungarian sausage', 'Hungarian sausage, garlic rice, egg', null, null, 7),
  ('Iced drinks', 'Iced Caramel Macchiato', null, null, '/photos/cafe/caramel-macchiato.webp', 1),
  ('Iced drinks', 'Iced Choco', null, null, '/photos/cafe/iced-choco.webp', 2),
  ('Iced drinks', 'Iced Americano', null, null, '/photos/cafe/iced-americano.webp', 3),
  ('Iced drinks', 'Iced Matcha', null, null, '/photos/cafe/iced-matcha.webp', 4),
  ('Freshly baked', 'Pizza Bread', 'Available from 3 PM', null, '/photos/cafe/pizza-bread.webp', 1),
  ('Freshly baked', 'Sausage Bread', 'Available from 3 PM', null, '/photos/cafe/sausage-bread.webp', 2),
  ('Freshly baked', 'Chocolate Chip Cookies', 'Available from 3 PM', null, '/photos/cafe/cookies.webp', 3)
) v(category, name, description, price, image_path, sort_order)
where not exists (select 1 from public.cafe_items);
