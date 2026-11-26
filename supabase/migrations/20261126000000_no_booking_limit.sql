-- No limit on how many upcoming bookings one customer can hold.
-- (The max_active_bookings setting stays in the table but is no longer checked.)
create or replace function public.book_court(p_court_id int, p_starts_at timestamptz, p_minutes int, p_pay_online boolean default false)
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
  v_online   boolean := coalesce(p_pay_online, false);
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
  if v_online and not (v_settings.online_payment_enabled and v_settings.payment_qr_path is not null) then
    raise exception 'PAYMENT_UNAVAILABLE: Online payment is not available right now. Please choose pay at the court.';
  end if;
  if not v_online and not v_settings.allow_pay_at_venue then
    raise exception 'PAYMENT_REQUIRED: Please pay online to book this court.';
  end if;
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
  if v_bdate > (v_today + interval '1 month')::date then
    raise exception 'OUTSIDE_WINDOW: Bookings open up to one month ahead only.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 7));
  -- Free any abandoned payment holds on this court/time before trying.
  perform public._expire_payment_holds(p_court_id, p_starts_at, p_starts_at + make_interval(mins => p_minutes));
  select count(*) into v_active from public.reservations
   where user_id = v_uid and status in ('pending', 'confirmed') and ends_at > now()
     and not (status = 'pending' and payment_status in ('unpaid', 'rejected') and hold_expires_at < now());

  loop
    v_try := v_try + 1;
    begin
      insert into public.reservations
        (reference, court_id, user_id, kind, status, starts_at, ends_at,
         customer_name, customer_phone, customer_email, amount, created_by,
         payment_method, payment_status, hold_expires_at)
      values
        (public._new_reference(), p_court_id, v_uid, 'online',
         case when v_online then 'pending' else 'confirmed' end,
         p_starts_at, p_starts_at + make_interval(mins => p_minutes),
         v_profile.full_name, v_profile.phone, v_profile.email,
         case when v_court.hourly_rate is null then null
              else round(v_court.hourly_rate * p_minutes / 60.0, 2) end,
         v_uid,
         case when v_online then 'online' else 'venue' end,
         case when v_online then 'unpaid' else 'not_required' end,
         case when v_online then now() + make_interval(mins => v_settings.payment_hold_minutes) end)
      returning * into v_row;
      exit;
    exception
      when exclusion_violation then
        raise exception 'SLOT_TAKEN: Sorry, that time has just been taken. Please choose another slot.';
      when unique_violation then
        if v_try >= 5 then raise; end if;
    end;
  end loop;
  return v_row;
end $$;
