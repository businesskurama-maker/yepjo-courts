-- Admins can delete a customer's whole inquiry conversation (all its messages).
-- The deletion is recorded in the activity log; message text is not kept.

create or replace function public.admin_delete_conversation(p_user_id uuid)
returns int language plpgsql security definer set search_path = public as $$
declare v_count int; v_email text;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  if p_user_id is null then raise exception 'INVALID_REQUEST: Missing conversation.'; end if;

  select count(*) into v_count from public.messages where conversation_id = p_user_id;
  delete from public.conversations where user_id = p_user_id;
  if not found then raise exception 'NOT_FOUND: Conversation not found or already deleted.'; end if;

  select email into v_email from public.profiles where id = p_user_id;
  perform public._log('conversation.delete', 'conversations', p_user_id::text,
                      jsonb_build_object('customer', v_email, 'messages', v_count));
  return v_count;
end $$;

revoke all on function public.admin_delete_conversation(uuid) from public, anon;
grant execute on function public.admin_delete_conversation(uuid) to authenticated;
