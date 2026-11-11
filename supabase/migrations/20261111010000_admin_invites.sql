-- =====================================================================
-- Admin invitations: reserve administrator access for an email address
-- before that person has signed in. On their first Google sign-in the
-- invite is redeemed automatically (only for the exact verified email).
-- Max 2 open invites at a time ("reserved client slots").
-- =====================================================================

create table if not exists public.admin_invites (
  email      text primary key check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  invited_by uuid,
  created_at timestamptz not null default now()
);
alter table public.admin_invites enable row level security;
create policy admin_invites_select on public.admin_invites for select to authenticated
  using ((select public.is_admin()));
revoke all on public.admin_invites from anon, authenticated;
grant select on public.admin_invites to authenticated;

-- Redeem an invite for a user id + verified email (internal).
create or replace function public._redeem_admin_invite(p_user uuid, p_email text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_user is null or coalesce(p_email, '') = '' then return false; end if;
  delete from public.admin_invites where email = lower(p_email);
  if not found then return false; end if;
  insert into public.admins (user_id) values (p_user) on conflict do nothing;
  insert into public.activity_logs (actor_id, actor_email, action, entity, entity_id, details)
  values (p_user, lower(p_email), 'admin.invite_redeemed', 'admins', p_user::text, jsonb_build_object('label', lower(p_email)));
  return true;
end $$;

-- New sign-ups: create the profile, then redeem any invite for their email.
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
  perform public._redeem_admin_invite(new.id, new.email);
  return new;
end $$;

-- Grant by email: existing account → admin now; otherwise reserve an invite slot.
-- Returns 'granted' or 'invited'. Replaces the earlier version (which required an account).
drop function if exists public.admin_grant(text);
create or replace function public.admin_grant(p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_id uuid;
  v_open int;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'INVALID_REQUEST: Enter a valid email address.'; end if;
  select id into v_id from public.profiles where lower(email) = v_email;
  if v_id is not null then
    insert into public.admins (user_id, added_by) values (v_id, auth.uid()) on conflict do nothing;
    delete from public.admin_invites where email = v_email;
    perform public._log('admin.grant', 'admins', v_id::text, jsonb_build_object('label', v_email));
    return 'granted';
  end if;
  if exists (select 1 from public.admin_invites where email = v_email) then return 'invited'; end if;
  select count(*) into v_open from public.admin_invites;
  if v_open >= 2 then
    raise exception 'LIMIT_REACHED: Both reserved admin slots are in use. Remove a pending invite first.';
  end if;
  insert into public.admin_invites (email, invited_by) values (v_email, auth.uid());
  perform public._log('admin.invite', 'admin_invites', v_email, jsonb_build_object('label', v_email));
  return 'invited';
end $$;

create or replace function public.admin_invite_remove(p_email text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  delete from public.admin_invites where email = lower(trim(coalesce(p_email, '')));
  perform public._log('admin.invite_removed', 'admin_invites', lower(trim(p_email)), jsonb_build_object('label', lower(trim(p_email))));
end $$;

revoke execute on function public._redeem_admin_invite(uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_grant(text), public.admin_invite_remove(text) from public, anon;
grant execute on function public.admin_grant(text) to authenticated;
grant execute on function public.admin_invite_remove(text) to authenticated;
