-- Time-based prices per court and closed / holiday / special-event dates.
--
-- court_rates: up to 3 time sets per court for weekdays (Mon–Fri) and weekends
-- (Sat–Sun). A time set may run past midnight (e.g. 15:00–01:00). The day type
-- follows the business day, so Friday 12–1 AM still uses Friday's weekday price.
-- Any time not covered by a time set falls back to courts.hourly_rate.
--
-- closures: whole business days when online booking is refused, for all courts
-- (court_ids is null) or the listed ones. Admins can still add walk-ins/blocks.
--
-- Every booking total is calculated on the server by a trigger.

-- ------------------------------------------------------------ court_rates
create table if not exists public.court_rates (
  id        bigint generated always as identity primary key,
  court_id  int not null references public.courts (id) on delete cascade,
  day_type  text not null check (day_type in ('weekday', 'weekend')),
  starts    time not null,
  ends      time not null,
  rate      numeric(10, 2) not null check (rate >= 0),
  check (starts <> ends),
  check (extract(minute from starts) in (0, 30) and extract(second from starts) = 0),
  check (extract(minute from ends) in (0, 30) and extract(second from ends) = 0)
);
create index if not exists court_rates_court_idx on public.court_rates (court_id, day_type);

alter table public.court_rates enable row level security;
create policy court_rates_select on public.court_rates for select to anon, authenticated using (true);
revoke all on public.court_rates from anon, authenticated;
grant select on public.court_rates to anon, authenticated;
create trigger pulse_court_rates after insert or update or delete on public.court_rates
  for each statement execute function public._bump_pulse();

-- Does time t fall inside [s, e), where e <= s means the set runs past midnight?
create or replace function public._time_in(t time, s time, e time)
returns boolean language sql immutable as $$
  select case when s < e then t >= s and t < e else t >= s or t < e end
$$;

-- Price of one court from p_start to p_end, summed in 30-minute steps.
-- Returns null when some part has no time set and the court has no fallback rate.
create or replace function public._price(p_court int, p_start timestamptz, p_end timestamptz)
returns numeric language plpgsql stable set search_path = public as $$
declare
  v_bdate date;
  v_type  text;
  v_base  numeric;
  v_total numeric := 0;
  v_step  timestamptz := p_start;
  v_rate  numeric;
begin
  if p_end <= p_start then return 0; end if;
  v_bdate := coalesce(
    public._business_date(p_court, p_start, greatest(1, (extract(epoch from (p_end - p_start)) / 60)::int), 1),
    (p_start at time zone 'Asia/Manila')::date);
  v_type := case when extract(dow from v_bdate) in (0, 6) then 'weekend' else 'weekday' end;
  select hourly_rate into v_base from public.courts where id = p_court;

  while v_step < p_end loop
    select r.rate into v_rate from public.court_rates r
     where r.court_id = p_court and r.day_type = v_type
       and public._time_in((v_step at time zone 'Asia/Manila')::time, r.starts, r.ends)
     order by r.starts limit 1;
    v_rate := coalesce(v_rate, v_base);
    if v_rate is null then return null; end if;
    v_total := v_total + v_rate * extract(epoch from (least(v_step + interval '30 minutes', p_end) - v_step)) / 3600.0;
    v_step := v_step + interval '30 minutes';
    v_rate := null;
  end loop;
  return round(v_total, 2);
end $$;

-- Replace the time sets of the given courts in one go (admin only).
-- p_rates: [{"day_type":"weekday","starts":"07:00","ends":"15:00","rate":250}, ...]
create or replace function public.admin_set_rates(p_court_ids int[], p_rates jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_item jsonb; v_type text; v_s time; v_e time; v_rate numeric;
  v_marks int[]; v_m int; v_n int := 0; v_court int;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  if p_court_ids is null or cardinality(p_court_ids) = 0 then
    raise exception 'INVALID_REQUEST: Choose at least one court.';
  end if;
  if exists (select 1 from unnest(p_court_ids) c where not exists (select 1 from public.courts where id = c)) then
    raise exception 'COURT_UNAVAILABLE: Court not found.';
  end if;
  if jsonb_typeof(coalesce(p_rates, '[]'::jsonb)) <> 'array' then
    raise exception 'INVALID_REQUEST: Prices must be a list.';
  end if;

  foreach v_type in array array['weekday', 'weekend'] loop
    if (select count(*) from jsonb_array_elements(coalesce(p_rates, '[]')) x where x ->> 'day_type' = v_type) > 3 then
      raise exception 'INVALID_REQUEST: Up to 3 time sets per day type.';
    end if;
    v_marks := '{}';
    for v_item in select x from jsonb_array_elements(coalesce(p_rates, '[]')) x where x ->> 'day_type' = v_type loop
      begin
        v_s := (v_item ->> 'starts')::time; v_e := (v_item ->> 'ends')::time; v_rate := (v_item ->> 'rate')::numeric;
      exception when others then
        raise exception 'INVALID_REQUEST: Each time set needs a start, an end and a price.';
      end;
      if v_s is null or v_e is null or v_rate is null or v_rate < 0 or v_s = v_e then
        raise exception 'INVALID_REQUEST: Each time set needs a start, a different end and a price of 0 or more.';
      end if;
      if extract(minute from v_s) not in (0, 30) or extract(minute from v_e) not in (0, 30) then
        raise exception 'INVALID_REQUEST: Times must be on the hour or half hour.';
      end if;
      -- overlap check on 30-minute marks of the day
      for v_m in select generate_series(0, 47) loop
        if public._time_in(time '00:00' + make_interval(mins => v_m * 30), v_s, v_e) then
          if v_m = any (v_marks) then
            raise exception 'INVALID_REQUEST: The % time sets overlap. Make each one start where the previous one ends.',
              case when v_type = 'weekday' then 'weekday' else 'weekend' end;
          end if;
          v_marks := v_marks || v_m;
        end if;
      end loop;
    end loop;
  end loop;

  delete from public.court_rates where court_id = any (p_court_ids);
  foreach v_court in array p_court_ids loop
    insert into public.court_rates (court_id, day_type, starts, ends, rate)
    select v_court, x ->> 'day_type', (x ->> 'starts')::time, (x ->> 'ends')::time, (x ->> 'rate')::numeric
      from jsonb_array_elements(coalesce(p_rates, '[]')) x;
    v_n := v_n + 1;
  end loop;

  perform public._log('court_rates.update', 'court_rates', array_to_string(p_court_ids, ','),
    jsonb_build_object('label', (select string_agg(c.sport || ' ' || c.name, ', ' order by c.sport, c.sort_order)
                                   from public.courts c where c.id = any (p_court_ids)),
                       'rates', p_rates));
  return v_n;
end $$;

revoke all on function public._price(int, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_set_rates(int[], jsonb) from public, anon;
grant execute on function public.admin_set_rates(int[], jsonb) to authenticated;

-- ------------------------------------------------------------ closures
create table if not exists public.closures (
  id         uuid primary key default gen_random_uuid(),
  starts_on  date not null,
  ends_on    date not null,
  court_ids  int[],                       -- null = every court
  kind       text not null check (kind in ('closed', 'holiday', 'event')),
  title      text not null check (char_length(trim(title)) between 1 and 80),
  note       text check (note is null or char_length(note) <= 300),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  check (ends_on >= starts_on and ends_on - starts_on <= 92),
  check (court_ids is null or cardinality(court_ids) > 0)
);
create index if not exists closures_dates_idx on public.closures (starts_on, ends_on);

alter table public.closures enable row level security;
create policy closures_select on public.closures for select to anon, authenticated using (true);
create policy closures_insert on public.closures for insert to authenticated with check ((select public.is_admin()));
create policy closures_update on public.closures for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy closures_delete on public.closures for delete to authenticated using ((select public.is_admin()));
revoke all on public.closures from anon, authenticated;
grant select on public.closures to anon;
grant select, insert, update, delete on public.closures to authenticated;
create trigger audit_closures after insert or update or delete on public.closures
  for each row execute function public._audit();
create trigger pulse_closures after insert or update or delete on public.closures
  for each statement execute function public._bump_pulse();

-- Bookings already on the chosen days (so the admin can contact those customers).
create or replace function public.admin_closure_bookings(p_starts_on date, p_ends_on date, p_court_ids int[] default null)
returns table (reference text, court text, sport text, starts_at timestamptz, ends_at timestamptz,
               customer_name text, customer_phone text, status text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  return query
    select r.reference, c.name, c.sport, r.starts_at, r.ends_at, r.customer_name, r.customer_phone, r.status
      from public.reservations r join public.courts c on c.id = r.court_id
     where r.kind in ('online', 'walk_in')
       and r.status in ('pending', 'confirmed')
       and (p_court_ids is null or r.court_id = any (p_court_ids))
       and r.starts_at >= ((p_starts_on - 1)::timestamp at time zone 'Asia/Manila')
       and r.starts_at <  ((p_ends_on + 2)::timestamp at time zone 'Asia/Manila')
       and coalesce(public._business_date(r.court_id, r.starts_at,
                      greatest(1, (extract(epoch from (r.ends_at - r.starts_at)) / 60)::int), 1),
                    (r.starts_at at time zone 'Asia/Manila')::date) between p_starts_on and p_ends_on
     order by r.starts_at;
end $$;
revoke all on function public.admin_closure_bookings(date, date, int[]) from public, anon;
grant execute on function public.admin_closure_bookings(date, date, int[]) to authenticated;

-- ------------------------------------------------------------ booking trigger
create or replace function public._reservation_rules()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_bdate date; v_closure public.closures; v_court public.courts; v_price numeric;
begin
  if new.kind not in ('online', 'walk_in') then return new; end if;

  -- server-side price from the time sets (falls back to the court's hourly rate)
  v_price := public._price(new.court_id, new.starts_at, new.ends_at);
  if v_price is not null then new.amount := v_price; end if;

  if new.kind = 'online' then
    v_bdate := coalesce(
      public._business_date(new.court_id, new.starts_at,
        greatest(1, (extract(epoch from (new.ends_at - new.starts_at)) / 60)::int), 1),
      (new.starts_at at time zone 'Asia/Manila')::date);
    select * into v_closure from public.closures k
     where v_bdate between k.starts_on and k.ends_on
       and (k.court_ids is null or new.court_id = any (k.court_ids))
     order by k.created_at limit 1;
    if found then
      select * into v_court from public.courts where id = new.court_id;
      raise exception 'CLOSED: % is not open for booking on % (%).',
        v_court.name, to_char(v_bdate, 'FMMonth FMDD'), v_closure.title;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists reservation_rules on public.reservations;
create trigger reservation_rules before insert on public.reservations
  for each row execute function public._reservation_rules();

-- ------------------------------------------------------------ Yepjo rates (effective Nov 16, 2026)
-- Mon–Fri: 7 AM–3 PM ₱250 (all courts); 3 PM–1 AM ₱350 (Pickleball 1–4, Badminton 1–2), ₱400 (Pickleball Court 5)
-- Sat–Sun: 7 AM–1 AM ₱350 (Pickleball 1–4, Badminton 1–2), ₱400 (Pickleball Court 5)
-- Hours: 7 AM–1 AM daily.
do $$
declare c record; v_peak numeric;
begin
  if exists (select 1 from public.court_rates) then return; end if;   -- never overwrite admin edits
  for c in select * from public.courts loop
    v_peak := case when c.sport = 'pickleball' and c.name ~* 'court\s*5' then 400 else 350 end;
    insert into public.court_rates (court_id, day_type, starts, ends, rate) values
      (c.id, 'weekday', '07:00', '15:00', 250),
      (c.id, 'weekday', '15:00', '01:00', v_peak),
      (c.id, 'weekend', '07:00', '01:00', v_peak);
    update public.courts set hourly_rate = v_peak where id = c.id;
  end loop;
  update public.court_hours set opens = '07:00', closes = '01:00', is_closed = false;
  update public.settings set hours_confirmed = true, rates_confirmed = true where id;
end $$;
