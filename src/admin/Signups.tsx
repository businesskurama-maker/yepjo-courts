import { ReceiptThumb } from '../components/Receipt';
import { useCallback, useEffect, useState } from 'react';
import { Confirm, Modal, Notice, Spinner, useToast } from '../components/ui';
import { supabase, toAppError } from '../lib/supabase';
import { fmtDateShort, fmtMoney, fmtTime } from '../lib/time';
import type { Registration } from '../lib/types';
import { useSite } from '../state/site';

const STATUS: Record<string, string> = { confirmed: 'Confirmed', pending: 'Waiting for payment', cancelled: 'Cancelled' };

/** Who signed up for an event or a dance class, with payment checks and cancelling. */
export function SignupsDialog({ kind, targetId, title, capacity, onClose }: {
  kind: 'event' | 'dance'; targetId: string; title: string; capacity: number | null; onClose: () => void;
}) {
  const { settings, pulse } = useSite();
  const toast = useToast();
  const [rows, setRows] = useState<Registration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Registration | null>(null);
  const [rejecting, setRejecting] = useState<Registration | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [fullRefund, setFullRefund] = useState(false);

  const load = useCallback(async () => {
    const col = kind === 'event' ? 'event_id' : 'dance_session_id';
    const { data, error: err } = await supabase.from('registrations').select('*').eq(col, targetId).order('created_at');
    if (err) setError(toAppError(err).message);
    else { setRows((data as Registration[]) ?? []); setError(null); }
  }, [kind, targetId]);
  useEffect(() => { void load(); }, [load, pulse]);

  const review = async (r: Registration, approve: boolean, why?: string) => {
    setBusy(true);
    const { error: err } = await supabase.rpc('admin_review_registration', { p_id: r.id, p_approve: approve, p_note: why ?? null });
    setBusy(false);
    setRejecting(null);
    if (err) return toast(toAppError(err).message, 'error');
    toast(approve ? `${r.customer_name ?? 'Sign-up'} confirmed.` : 'Payment marked as not found. The customer can send the reference again.');
    void load();
  };
  const cancel = async () => {
    if (!cancelling) return;
    setBusy(true);
    const { error: err } = await supabase.rpc('cancel_registration', { p_id: cancelling.id, p_reason: fullRefund ? 'Cancelled by Yepjo' : 'Cancelled for the customer', p_full_refund: fullRefund });
    setBusy(false);
    setCancelling(null);
    if (err) return toast(toAppError(err).message, 'error');
    toast('Sign-up cancelled.');
    void load();
  };

  const live = (rows ?? []).filter((r) => r.status !== 'cancelled');
  const toCheck = live.filter((r) => r.status === 'pending' && r.payment_status === 'submitted');
  const csv = () => {
    const head = ['Reference', 'Name', 'Phone', 'Email', 'Status', 'Payment', 'Ref (last 6)', 'Amount', 'Signed up'];
    const lines = (rows ?? []).map((r) => [r.reference, r.customer_name, r.customer_phone, r.customer_email, STATUS[r.status], r.payment_method, r.payment_ref, r.amount, r.created_at]
      .map((v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(','));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + [head.join(','), ...lines].join('\r\n')], { type: 'text/csv' }));
    a.download = `yepjo-${kind}-signups.csv`;
    a.click();
  };

  return (
    <Modal title={`Sign-ups · ${title}`} onClose={onClose} wide>
      <div className="stack-sm">
        <div className="report-row">
          <span className="small"><b>{live.length}</b>{capacity != null ? ` of ${capacity}` : ''} places taken{toCheck.length ? ` · ${toCheck.length} payment${toCheck.length === 1 ? '' : 's'} to check` : ''}</span>
          {rows && rows.length > 0 && <button type="button" className="btn btn-sm btn-ghost" onClick={csv}>Download CSV</button>}
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        {rows === null && !error && <Spinner />}
        {rows !== null && rows.length === 0 && <p className="muted small">No one has signed up yet.</p>}
        <ul className="rows">
          {(rows ?? []).map((r) => (
            <li key={r.id} className={`row${r.status === 'cancelled' ? ' is-dim' : ''}`}>
              <span className="row-main">
                <strong>{r.customer_name ?? 'Customer'} <span className={`badge ${r.status === 'confirmed' ? 'badge-ok' : r.status === 'pending' ? 'badge-warn' : 'badge-off'}`}>{r.status === 'pending' && r.payment_status === 'submitted' ? 'Payment to check' : STATUS[r.status]}</span></strong>
                <span className="small muted">
                  {r.customer_phone ? <a href={`tel:${r.customer_phone}`} className="link">{r.customer_phone}</a> : '—'} · {r.reference}
                  {Number(r.amount) > 0 ? ` · ${fmtMoney(Number(r.amount), settings.currency)} ${r.payment_method === 'venue' ? '(pay at venue)' : '(QR)'}` : ' · Free'}
                  {r.payment_ref ? ` · ref …${r.payment_ref}` : ''} · {fmtDateShort(r.created_at)} {fmtTime(r.created_at)}
                </span>
              </span>
              <span className="row-actions">
                <ReceiptThumb path={r.payment_proof_path} label={`Receipt · ${r.customer_name ?? r.reference}`} size="sm" />
                {r.status === 'pending' && r.payment_status === 'submitted' && (
                  <>
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void review(r, true)}>Approve</button>
                    <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => { setNote(''); setRejecting(r); }}>Not found</button>
                  </>
                )}
                {r.status !== 'cancelled' && <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => setCancelling(r)}>Cancel</button>}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {cancelling && (
        <Confirm title="Cancel this sign-up?" confirmLabel="Cancel sign-up" danger busy={busy} onConfirm={() => void cancel()} onClose={() => setCancelling(null)}>
          <p>{cancelling.customer_name} ({cancelling.reference}) loses their place.</p>
          {cancelling.payment_status === 'verified' && Number(cancelling.amount) > 0 && (
            <label className="check">
              <input type="checkbox" checked={fullRefund} onChange={(e) => setFullRefund(e.target.checked)} />
              <span>Yepjo cancelled: full refund of {fmtMoney(Number(cancelling.amount), settings.currency)} (otherwise {settings.cancel_fee_percent ?? 50}% fee is kept)</span>
            </label>
          )}
        </Confirm>
      )}
      {rejecting && (
        <Confirm title="Payment not found?" confirmLabel="Mark as not found" busy={busy} onConfirm={() => void review(rejecting, false, note)} onClose={() => setRejecting(null)}>
          <p className="small">The customer sees your note and can send the reference again. Their place stays held for {settings.payment_hold_minutes} more minutes.</p>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. No GCash payment with that reference" maxLength={200} aria-label="Note for the customer" />
        </Confirm>
      )}
    </Modal>
  );
}
