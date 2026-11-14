-- Removing administrators:
--  * any administrator can remove another administrator;
--  * nobody can remove their own access;
--  * the last remaining administrator can never be removed.
-- A transaction lock stops two admins from removing each other at the same moment.

create or replace function public.admin_revoke(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  if p_user_id = auth.uid() then
    raise exception 'INVALID_REQUEST: You cannot remove your own administrator access. Another administrator has to do it.';
  end if;

  perform pg_advisory_xact_lock(hashtext('yepjo.admins'));

  -- Re-check after waiting for the lock: the caller may have been removed meanwhile.
  if not exists (select 1 from public.admins where user_id = auth.uid()) then
    raise exception 'FORBIDDEN: Administrator access is required.';
  end if;
  if not exists (select 1 from public.admins where user_id = p_user_id) then
    raise exception 'NOT_FOUND: That person is no longer an administrator.';
  end if;
  if (select count(*) from public.admins) <= 1 then
    raise exception 'LAST_ADMIN: At least one administrator must remain.';
  end if;

  delete from public.admins where user_id = p_user_id;
  perform public._log('admin.revoke', 'admins', p_user_id::text,
    jsonb_build_object('label', (select email from public.profiles where id = p_user_id)));
end $$;

revoke all on function public.admin_revoke(uuid) from public, anon;
grant execute on function public.admin_revoke(uuid) to authenticated;
