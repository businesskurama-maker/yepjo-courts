-- Online payments: the customer uploads a screenshot of the e-wallet receipt (with the reference
-- number visible) instead of typing the last 6 digits. Staff look at the screenshot and approve.
-- Screenshots are private (only the customer and administrators can open them) and are kept for
-- 30 days after approval, then removed.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 2000000, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = 2000000, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists receipts_insert on storage.objects;
drop policy if exists receipts_select on storage.objects;
drop policy if exists receipts_delete on storage.objects;
-- a customer can only put files in a folder named after their own account id
create policy receipts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy receipts_select on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_admin())));
create policy receipts_delete on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_admin())));

alter table public.reservations  add column if not exists payment_proof_path text, add column if not exists payment_proof_at timestamptz;
alter table public.registrations add column if not exists payment_proof_path text, add column if not exists payment_proof_at timestamptz;
alter table public.cafe_orders   add column if not exists payment_proof_path text, add column if not exists payment_proof_at timestamptz;

-- Customer: "I paid, here is my receipt". p_kind: booking | signup | order. p_path: the uploaded file.
create or replace function public.submit_payment_receipt(p_kind text, p_id uuid, p_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_b public.reservations; v_s public.registrations; v_o public.cafe_orders;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED: Please sign in first.'; end if;
  if p_path is null or p_path !~ ('^' || v_uid::text || '/[A-Za-z0-9._-]{1,80}$')
     or not exists (select 1 from storage.objects where bucket_id = 'receipts' and name = p_path) then
    raise exception 'INVALID_RECEIPT: Attach the screenshot of your payment receipt first.';
  end if;

  if p_kind = 'booking' then
    select * into v_b from public.reservations where id = p_id for update;
    if not found or v_b.user_id is distinct from v_uid then raise exception 'NOT_FOUND: Booking not found.'; end if;
    if v_b.status <> 'pending' or v_b.payment_method <> 'online' then
      raise exception 'INVALID_REQUEST: This booking is not waiting for an online payment.';
    end if;
    if v_b.payment_status = 'submitted' then raise exception 'ALREADY_SUBMITTED: Your receipt was already sent. Yepjo will confirm it soon.'; end if;
    if v_b.payment_status not in ('unpaid', 'rejected') then raise exception 'INVALID_REQUEST: This payment cannot be changed.'; end if;
    if v_b.hold_expires_at is not null and v_b.hold_expires_at < now() then
      update public.reservations set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Payment not received in time'
       where id = p_id returning * into v_b;
      return to_jsonb(v_b);
    end if;
    update public.reservations
       set payment_proof_path = p_path, payment_proof_at = now(), payment_ref = null,
           payment_status = 'submitted', payment_submitted_at = now(), payment_note = null
     where id = p_id returning * into v_b;
    return to_jsonb(v_b);

  elsif p_kind = 'signup' then
    select * into v_s from public.registrations where id = p_id for update;
    if not found or v_s.user_id is distinct from v_uid then raise exception 'NOT_FOUND: Sign-up not found.'; end if;
    if v_s.status <> 'pending' or v_s.payment_method <> 'online' then
      raise exception 'INVALID_REQUEST: This sign-up is not waiting for an online payment.';
    end if;
    if v_s.payment_status = 'submitted' then raise exception 'ALREADY_SUBMITTED: Your receipt was already sent. Yepjo will confirm it soon.'; end if;
    if v_s.hold_expires_at is not null and v_s.hold_expires_at < now() then
      update public.registrations set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Payment not received in time'
       where id = p_id returning * into v_s;
      return to_jsonb(v_s);
    end if;
    update public.registrations
       set payment_proof_path = p_path, payment_proof_at = now(), payment_ref = null,
           payment_status = 'submitted', payment_submitted_at = now(), payment_note = null
     where id = p_id returning * into v_s;
    return to_jsonb(v_s);

  elsif p_kind = 'order' then
    select * into v_o from public.cafe_orders where id = p_id for update;
    if not found or v_o.user_id is distinct from v_uid then raise exception 'NOT_FOUND: Order not found.'; end if;
    if v_o.status <> 'pending' then raise exception 'INVALID_REQUEST: This order is not waiting for payment.'; end if;
    if v_o.payment_status = 'submitted' then raise exception 'ALREADY_SUBMITTED: Your receipt was already sent. Yepjo will confirm it soon.'; end if;
    if v_o.hold_expires_at < now() then
      update public.cafe_orders set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Payment not received in time', updated_at = now()
       where id = p_id returning * into v_o;
      return to_jsonb(v_o);
    end if;
    update public.cafe_orders
       set payment_proof_path = p_path, payment_proof_at = now(), payment_ref = null,
           payment_status = 'submitted', payment_submitted_at = now(), payment_note = null, updated_at = now()
     where id = p_id returning * into v_o;
    return to_jsonb(v_o);
  end if;
  raise exception 'INVALID_REQUEST: Unknown payment type.';
end $$;

-- Typing the reference number is no longer accepted.
revoke execute on function public.submit_payment(uuid, text) from authenticated;
revoke execute on function public.submit_registration_payment(uuid, text) from authenticated;
revoke execute on function public.submit_order_payment(uuid, text) from authenticated;

-- Receipts whose 30 days are over: 30 days after approval, or 30 days after upload when never approved.
-- Also files that no booking, sign-up or order points to any more (replaced or deleted) after 30 days.
create or replace function public.admin_receipts_to_purge()
returns table (path text) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  return query
    with used as (
      select payment_proof_path as p, payment_status as st, payment_verified_at as v, payment_proof_at as u from public.reservations where payment_proof_path is not null
      union all select payment_proof_path, payment_status, payment_verified_at, payment_proof_at from public.registrations where payment_proof_path is not null
      union all select payment_proof_path, payment_status, payment_verified_at, payment_proof_at from public.cafe_orders where payment_proof_path is not null
    )
    select u.p from used u
     where coalesce(case when u.st = 'verified' then u.v end, u.u, '-infinity'::timestamptz) < now() - interval '30 days'
    union
    select o.name from storage.objects o
     where o.bucket_id = 'receipts' and o.created_at < now() - interval '30 days'
       and not exists (select 1 from used u where u.p = o.name)
    limit 500;
end $$;

-- After the files are removed from storage, forget their paths.
create or replace function public.admin_clear_receipts(p_paths text[])
returns int language plpgsql security definer set search_path = public as $$
declare v_n int := 0; v_c int;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  if p_paths is null or cardinality(p_paths) = 0 then return 0; end if;
  update public.reservations  set payment_proof_path = null where payment_proof_path = any(p_paths); get diagnostics v_c = row_count; v_n := v_n + v_c;
  update public.registrations set payment_proof_path = null where payment_proof_path = any(p_paths); get diagnostics v_c = row_count; v_n := v_n + v_c;
  update public.cafe_orders   set payment_proof_path = null where payment_proof_path = any(p_paths); get diagnostics v_c = row_count; v_n := v_n + v_c;
  perform public._log('receipts.purge', 'receipts', null,
    jsonb_build_object('files', cardinality(p_paths), 'label', cardinality(p_paths) || ' payment screenshot(s) removed after 30 days'));
  return v_n;
end $$;

revoke all on function public.submit_payment_receipt(text, uuid, text) from public, anon;
revoke all on function public.admin_receipts_to_purge() from public, anon;
revoke all on function public.admin_clear_receipts(text[]) from public, anon;
grant execute on function public.submit_payment_receipt(text, uuid, text) to authenticated;
grant execute on function public.admin_receipts_to_purge() to authenticated;
grant execute on function public.admin_clear_receipts(text[]) to authenticated;
