import { useCallback, useEffect, useState } from 'react';
import { Field, Icon, Modal, Notice, useToast } from '../components/ui';
import { supabase, toAppError } from '../lib/supabase';
import { priceFor } from '../lib/pricing';
import { fmtDateShort, fmtDateTime, fmtMoney, fmtRange, ymdOf } from '../lib/time';
import { SPORT_LABEL, type PaidVia, type Reservation } from '../lib/types';
import { useSite } from '../state/site';

export const PAID_VIA: [PaidVia, string][] = [['cash', 'Cash'], ['gcash', 'GCash'], ['maya', 'Maya'], ['bank', 'Bank transfer'], ['other', 'Other']];
export const viaLabel = (v?: string | null) => PAID_VIA.find(([k]) => k === v)?.[1] ?? 'Other';

/** Tells the staff lists on the page to reload after a payment or an extension was saved. */
const CHANGED = 'yepjo:payments';
export const notifyPayments = () => window.dispatchEvent(new Event(CHANGED));
export function usePaymentsChanged(fn: () => void) {
  useEffect(() => {
    window.addEventListener(CHANGED, fn);
    return () => window.removeEventListener(CHANGED, fn);
  }, [fn]);
}

/** What is still to be collected at the court. Extra time that was already paid is not asked for again. */
export function amountDue(r: Reservation) {
  if (r.kind === 'block' || r.status !== 'confirmed' || r.payment_status === 'verified') return 0;
  return Math.max(0, Number(r.amount ?? 0) - Math.max(0, Number(r.extra_amount ?? 0) - Number(r.extra_unpaid ?? 0)));
}

/** One line for the booking details: how and to whom it was paid. */
export function paidLine(r: Reservation, currency: string) {
  if (r.payment_status !== 'verified') return null;
  if (r.paid_via) {
    return `${fmtMoney(Number(r.paid_amount ?? r.amount ?? 0), currency)} · ${viaLabel(r.paid_via)} at the court${r.paid_by_name ? ` · received by ${r.paid_by_name}` : ''}${r.payment_verified_at ? ` · ${fmtDateTime(r.payment_verified_at)}` : ''}`;
  }
  return `Paid online (QR)${r.payment_ref ? ` · ref ${r.payment_ref}` : ''}`;
}

/** Staff dialog: the customer paid at the court. A block made for a customer becomes a walk-in booking. */
export function RecordPaymentDialog({ booking, onClose, onDone }: { booking: Reservation; onClose: () => void; onDone: (r: Reservation) => void }) {
  const { settings, courts, rates } = useSite();
  const toast = useToast();
  const isBlock = booking.kind === 'block';
  const court = courts.find((c) => c.id === booking.court_id);
  const startMs = new Date(booking.starts_at).getTime();
  const expected = isBlock
    ? priceFor(court, rates, ymdOf(startMs), startMs, (new Date(booking.ends_at).getTime() - startMs) / 60_000) ?? 0
    : amountDue(booking);
  const [amount, setAmount] = useState(expected ? String(expected) : '');
  const [via, setVia] = useState<PaidVia>('cash');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const value = Number(amount);
    if (amount.trim() === '' || !Number.isFinite(value) || value < 0) return setError('Enter the amount you received.');
    if (isBlock && !name.trim()) return setError("Enter the customer's name.");
    setBusy(true); setError(null);
    const { data, error: err } = await supabase.rpc('admin_record_payment', {
      p_id: booking.id, p_amount: value, p_via: via, p_note: note || null,
      p_customer_name: isBlock ? name : null, p_customer_phone: isBlock ? phone || null : null,
    });
    setBusy(false);
    if (err) return setError(toAppError(err).message);
    const r = data as Reservation;
    notifyPayments();
    toast(`${r.reference}: ${fmtMoney(value, settings.currency)} received (${viaLabel(via)}). Saved to sales and the activity log.`);
    onDone(r);
  };

  return (
    <Modal title={`Record payment · ${booking.reference}`} onClose={onClose} footer={
      <>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Close</button>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Payment received'}</button>
      </>
    }>
      <div className="stack-sm">
        <p><strong>{isBlock ? booking.note ?? 'Blocked time' : booking.customer_name ?? 'Customer'}</strong> · {court ? `${SPORT_LABEL[court.sport]} · ${court.name}` : 'Court'}<br />
          <span className="muted small">{fmtDateShort(booking.starts_at)}, {fmtRange(booking.starts_at, booking.ends_at)}</span></p>
        {isBlock && (
          <>
            <Notice kind="info">This block will become a walk-in booking for the customer, so it is counted in the sales report.</Notice>
            <div className="form-2">
              <Field label="Customer name"><input type="text" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} maxLength={80} required /></Field>
              <Field label="Contact number (optional)"><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} /></Field>
            </div>
          </>
        )}
        <div className="form-2">
          <Field label={`Amount received (${settings.currency})`}>
            <input type="number" inputMode="decimal" min={0} step="0.01" value={amount} onChange={(e) => { setAmount(e.target.value); setError(null); }} required />
          </Field>
          <Field label="Paid by">
            <select value={via} onChange={(e) => setVia(e.target.value as PaidVia)}>
              {PAID_VIA.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Note (optional, e.g. receipt or GCash reference)">
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </Field>
        <p className="tiny muted">
          {expected > 0 ? `Court fee to collect: ${fmtMoney(expected, settings.currency)}. ` : ''}
          The sales report uses the amount you enter here, and the activity log records your name as the staff who received it.
        </p>
        {error && <Notice kind="error">{error}</Notice>}
      </div>
    </Modal>
  );
}

/** Staff list: bookings played today or earlier that are not paid yet. */
export function PaymentsDuePanel({ refresh = 0, onPaid }: { refresh?: number; onPaid?: () => void }) {
  const { settings, courts, pulse } = useSite();
  const [rows, setRows] = useState<Reservation[]>([]);
  const [paying, setPaying] = useState<Reservation | null>(null);
  const money = (v: number) => fmtMoney(v, settings.currency);
  const courtName = (id: number) => { const c = courts.find((x) => x.id === id); return c ? `${SPORT_LABEL[c.sport]} · ${c.name}` : 'Court'; };

  const load = useCallback(async () => {
    const { data: due } = await supabase.rpc('admin_payments_due', { p_days_ahead: 1 });
    const ids = ((due as { id: string }[] | null) ?? []).map((d) => d.id);
    if (ids.length === 0) return setRows([]);
    const { data } = await supabase.from('reservations').select('*').in('id', ids).order('starts_at');
    setRows(((data as Reservation[]) ?? []).filter((r) => amountDue(r) > 0));
  }, []);
  useEffect(() => { void load(); }, [load, pulse, refresh]);
  usePaymentsChanged(load);

  if (rows.length === 0) return null;
  return (
    <>
    <section className="card stack-sm refunds" aria-labelledby="due-h">
      <h2 id="due-h"><Icon name="alert" size={18} /> To collect at the court ({rows.length}) · {money(rows.reduce((s, r) => s + amountDue(r), 0))}</h2>
      <ul className="rows">
        {rows.map((r) => (
          <li key={r.id} className="row">
            <span className="row-main">
              <strong>{r.customer_name ?? 'Customer'} · <span className="warn-text">{money(amountDue(r))}</span></strong>
              <span className="small muted">{courtName(r.court_id)} · {fmtDateShort(r.starts_at)}, {fmtRange(r.starts_at, r.ends_at)} · {r.reference}{r.kind === 'walk_in' ? ' · Walk-in' : ''}</span>
            </span>
            <span className="btn-row">
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setPaying(r)}>Record payment</button>
            </span>
          </li>
        ))}
      </ul>
    </section>
      {paying && <RecordPaymentDialog booking={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); void load(); onPaid?.(); }} />}
    </>
  );
}
