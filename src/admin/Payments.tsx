import { useCallback, useEffect, useState } from 'react';
import { Empty, Icon, Modal, Notice, Pager, Spinner, useToast } from '../components/ui';
import { useCountdown } from '../components/Payment';
import { Link } from '../lib/router';
import { supabase, toAppError } from '../lib/supabase';
import { fmtDateLong, fmtDateTime, fmtMoney, fmtRange } from '../lib/time';
import { SPORT_LABEL, type Reservation } from '../lib/types';
import { useSite } from '../state/site';

type Tab = 'check' | 'waiting' | 'verified';
const PAGE_SIZE = 10;

function HoldLeft({ until }: { until: string | null | undefined }) {
  const c = useCountdown(until);
  if (!c) return null;
  return <span className={`badge ${c.left === 0 ? 'badge-off' : 'badge-warn'}`}>{c.left === 0 ? 'Hold expired' : `${c.label} left`}</span>;
}

/** Online QR payments: verify the reference against the GCash/bank app, then approve or reject. */
export default function Payments() {
  const { courts, settings, pulse } = useSite();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('check');
  const [rows, setRows] = useState<Reservation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<Reservation | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    let q = supabase.from('reservations').select('*').eq('payment_method', 'online');
    if (tab === 'check') q = q.eq('status', 'pending').eq('payment_status', 'submitted').order('payment_submitted_at', { ascending: true });
    else if (tab === 'waiting') q = q.eq('status', 'pending').in('payment_status', ['unpaid', 'rejected']).order('created_at', { ascending: false });
    else q = q.eq('payment_status', 'verified').order('payment_verified_at', { ascending: false });
    const { data, error: err } = await q.limit(300);
    if (err) setError(toAppError(err).message);
    else {
      setRows((data as Reservation[]) ?? []);
      setError(null);
    }
  }, [tab]);
  useEffect(() => {
    void load();
  }, [load, pulse]);

  const review = async (r: Reservation, approve: boolean, why?: string) => {
    setBusyId(r.id);
    const { error: err } = await supabase.rpc('admin_review_payment', { p_id: r.id, p_approve: approve, p_note: why ?? null });
    setBusyId(null);
    if (err) return toast(toAppError(err).message, 'error');
    toast(approve ? `Payment approved. ${r.reference} is confirmed.` : `Payment rejected. ${r.customer_name ?? 'The customer'} can send a corrected reference.`);
    setRejecting(null);
    setNote('');
    void load();
  };

  const courtLabel = (id: number) => {
    const c = courts.find((x) => x.id === id);
    return c ? `${SPORT_LABEL[c.sport]} · ${c.name}` : `Court #${id}`;
  };
  const list = rows ?? [];
  const shown = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="stack">
      <h1 className="page-title">Payments</h1>
      {!settings.online_payment_enabled && (
        <Notice kind="warn">Online payment is off. Upload your QR code and turn it on in <Link className="link" to="/admin/settings">Settings → Payments</Link>.</Notice>
      )}
      <div className="tabs" role="tablist" aria-label="Payment status">
        {([['check', 'To check'], ['waiting', 'Waiting for customer'], ['verified', 'Approved']] as [Tab, string][]).map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab${tab === t ? ' is-active' : ''}`}
            onClick={() => { setTab(t); setPage(1); setRows(null); }}>
            {label}{tab === t && rows ? ` (${list.length})` : ''}
          </button>
        ))}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {rows === null && !error && <Spinner />}
      {rows !== null && list.length === 0 && (
        <Empty icon="check" title={tab === 'check' ? 'Nothing to check' : tab === 'waiting' ? 'No unpaid holds' : 'No approved payments yet'}>
          {tab === 'check' && 'New payment references appear here as soon as customers send them.'}
        </Empty>
      )}
      <ul className="booking-list">
        {shown.map((r) => (
          <li key={r.id} className="card booking pay-review">
            <div className="booking-head">
              <strong>{r.customer_name ?? 'Customer'}</strong>
              {r.status === 'pending' && r.payment_status !== 'submitted' ? <HoldLeft until={r.hold_expires_at} /> : null}
              {r.payment_status === 'verified' && <span className="badge badge-ok">Approved</span>}
            </div>
            <div className="pay-ref-row">
              <div>
                <span className="tiny muted">Reference (last 6)</span>
                <span className="pay-ref">{r.payment_ref ?? '— not sent —'}</span>
              </div>
              <div>
                <span className="tiny muted">Amount</span>
                <span className="pay-amt">{r.amount != null ? fmtMoney(Number(r.amount), settings.currency) : 'Rate not set'}</span>
              </div>
            </div>
            <p className="small">{courtLabel(r.court_id)} · {fmtDateLong(r.starts_at)} · {fmtRange(r.starts_at, r.ends_at)}</p>
            <p className="tiny muted">
              Booking {r.reference}
              {r.customer_phone ? <> · <a className="link" href={`tel:${r.customer_phone}`}>{r.customer_phone}</a></> : null}
              {r.payment_submitted_at ? ` · sent ${fmtDateTime(r.payment_submitted_at)}` : ''}
              {r.payment_verified_at ? ` · approved ${fmtDateTime(r.payment_verified_at)}` : ''}
            </p>
            {r.payment_status === 'rejected' && r.payment_note && <p className="tiny warn-text">Rejected: {r.payment_note}</p>}
            {r.status === 'pending' && (
              <div className="btn-row">
                <button type="button" className="btn btn-sm btn-outline-danger" disabled={busyId === r.id} onClick={() => { setRejecting(r); setNote(''); }}>
                  <Icon name="x" size={16} /> Reject
                </button>
                <button type="button" className="btn btn-sm btn-primary" disabled={busyId === r.id} onClick={() => void review(r, true)}>
                  <Icon name="check" size={16} /> {r.payment_status === 'submitted' ? 'Approve payment' : 'Mark as paid'}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <Pager page={page} pageSize={PAGE_SIZE} total={list.length} onPage={setPage} />

      {rejecting && (
        <Modal title="Reject this payment?" onClose={() => setRejecting(null)}
          footer={<>
            <button type="button" className="btn btn-ghost" onClick={() => setRejecting(null)}>Back</button>
            <button type="button" className="btn btn-danger" disabled={busyId === rejecting.id} onClick={() => void review(rejecting, false, note)}>Reject payment</button>
          </>}>
          <p className="small">{rejecting.customer_name} · reference <strong>{rejecting.payment_ref ?? 'not sent'}</strong></p>
          <p className="small muted">The court stays held for another {settings.payment_hold_minutes} minutes so they can send a corrected reference. To release the court now, cancel the booking in Bookings instead.</p>
          <label className="field">
            <span className="field-label">Message to the customer (optional)</span>
            <input type="text" value={note} maxLength={160} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Amount did not match, please check" />
          </label>
        </Modal>
      )}
    </div>
  );
}
