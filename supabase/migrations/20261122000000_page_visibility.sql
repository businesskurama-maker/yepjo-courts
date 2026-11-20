-- Admin can hide the Cafe and the Loyalty Rewards pages from customers, or make them public.
alter table public.settings add column if not exists cafe_visible boolean not null default true;
alter table public.settings add column if not exists rewards_visible boolean not null default true;

-- While the cafe is hidden, customers cannot place cafe orders (administrators still can, to test).
create or replace function public._cafe_orders_visible()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not (select cafe_visible from public.settings where id) and not public.is_admin() then
    raise exception 'CAFE_CLOSED: The cafe page is not available right now.';
  end if;
  return new;
end $$;
revoke all on function public._cafe_orders_visible() from public, anon, authenticated;

drop trigger if exists cafe_orders_visible on public.cafe_orders;
create trigger cafe_orders_visible before insert on public.cafe_orders
  for each row execute function public._cafe_orders_visible();
