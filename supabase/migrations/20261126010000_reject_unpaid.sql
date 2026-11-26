-- Unpaid online bookings ("Waiting for customer"): staff can reject the reservation (it is cancelled
-- and the court opens again, the record stays) or delete it, also after the payment time ran out.
create or replace function public.admin_reject_reservation(p_id uuid, p_note text default null)
returns public.reservations language plpgsql security definer set search_path = public as $$
declare
  v_row public.reservations; v_court text; v_who text := public._staff_name();
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  select * into v_row from public.reservations where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Booking not found. It may already be deleted.'; end if;
  if v_row.status <> 'pending' then
    raise exception 'INVALID_REQUEST: Only a booking that is still waiting for payment can be rejected (this one is %).', v_row.status;
  end if;
  update public.reservations
     set status = 'cancelled', cancelled_at = now(), hold_expires_at = null,
         cancel_reason = coalesce(v_note, 'Payment not received in time'),
         payment_status = case when payment_status = 'submitted' then 'rejected' else payment_status end,
         payment_note = coalesce(v_note, payment_note)
   where id = p_id returning * into v_row;
  select name into v_court from public.courts where id = v_row.court_id;
  perform public._log('reservation.reject', 'reservations', v_row.id::text,
    jsonb_build_object('reference', v_row.reference, 'customer', v_row.customer_name, 'court', v_court,
      'starts_at', v_row.starts_at, 'ends_at', v_row.ends_at, 'amount', v_row.amount, 'reason', v_note, 'rejected_by', v_who,
      'label', v_row.reference || ' · ' || coalesce(v_row.customer_name, 'Customer') || ' · ' || coalesce(v_court, 'Court') || ' · '
               || to_char(v_row.starts_at at time zone 'Asia/Manila', 'Mon DD, HH12:MI AM') || ' · not paid · rejected by ' || coalesce(v_who, 'staff')
               || case when v_note is not null then ' · ' || v_note else '' end));
  return v_row;
end $$;
revoke all on function public.admin_reject_reservation(uuid, text) from public, anon;
grant execute on function public.admin_reject_reservation(uuid, text) to authenticated;

-- Delete: an unpaid hold can be deleted even when its time slot has already passed.
create or replace function public.admin_delete_reservation(p_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_row public.reservations; v_court text; v_given numeric; v_who text := public._staff_name();
  v_reason text := nullif(trim(coalesce(p_reason, '')), ''); v_what text;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN: Administrator access is required.'; end if;
  select * into v_row from public.reservations where id = p_id for update;
  if not found then raise exception 'NOT_FOUND: Booking not found. It may already be deleted.'; end if;
  if v_row.status = 'cancelled' then
    raise exception 'INVALID_REQUEST: This booking is already cancelled. Cancelled bookings are kept as a record.';
  end if;
  if v_row.status = 'confirmed' and v_row.ends_at <= now() then
    raise exception 'INVALID_REQUEST: This booking is already done. Done bookings are kept for the sales report.';
  end if;
  select name into v_court from public.courts where id = v_row.court_id;

  -- take back loyalty points given for this booking
  if v_row.user_id is not null then
    select sum(points) into v_given from public.points_ledger where ref = v_row.id::text and source in ('court', 'reversal');
    if coalesce(v_given, 0) > 0 then
      insert into public.points_ledger (user_id, points, source, ref, note)
      values (v_row.user_id, -v_given, 'reversal', v_row.id::text, 'Deleted booking ' || v_row.reference);
    end if;
  end if;

  v_what := case when v_row.kind = 'block' then coalesce(v_row.note, 'Blocked time') else coalesce(v_row.customer_name, 'Customer') end;
  delete from public.reservations where id = p_id;
  perform public._log('reservation.delete', 'reservations', v_row.id::text,
    jsonb_build_object(
      'reference', v_row.reference, 'kind', v_row.kind, 'status', v_row.status, 'court', v_court,
      'customer', v_row.customer_name, 'phone', v_row.customer_phone, 'email', v_row.customer_email,
      'starts_at', v_row.starts_at, 'ends_at', v_row.ends_at, 'amount', v_row.amount,
      'payment_method', v_row.payment_method, 'payment_status', v_row.payment_status, 'paid_via', v_row.paid_via,
      'payment_ref', v_row.payment_ref, 'note', v_row.note, 'reason', v_reason, 'deleted_by', v_who,
      'points_taken_back', coalesce(v_given, 0),
      'label', v_row.reference || ' · ' || v_what || ' · ' || coalesce(v_court, 'Court') || ' · '
               || to_char(v_row.starts_at at time zone 'Asia/Manila', 'Mon DD, HH12:MI AM')
               || case when coalesce(v_row.amount, 0) > 0 then ' · ' || to_char(v_row.amount, 'FM999,999,990.00')
                       || case when v_row.payment_status = 'verified' then ' (paid)' else '' end else '' end
               || ' · deleted by ' || coalesce(v_who, 'staff')
               || case when v_reason is not null then ' · ' || v_reason else '' end));
  return jsonb_build_object('reference', v_row.reference, 'was_paid', v_row.payment_status = 'verified' and coalesce(v_row.amount, 0) > 0);
end $$;
