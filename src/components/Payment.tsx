import { useEffect, useRef, useState, type FormEvent } from 'react';
import { PhotoError } from '../lib/image';
import { prepareReceipt, uploadReceipt } from '../lib/receipt';
import { photoUrl, supabase, toAppError } from '../lib/supabase';
import { fmtMoney, fmtTime } from '../lib/time';
import { type Reservation } from '../lib/types';
import { useAuth } from '../state/auth';
import { useSite } from '../state/site';
import { ReceiptThumb } from './Receipt';
import { Icon, Notice, useOnline } from './ui';

/** "12:04 left" style countdown to an ISO time; null when there is no deadline. */
export function useCountdown(until: string | null | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [until]);
  if (!until) return null;
  const left = Math.max(0, new Date(until).getTime() - now);
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return { left, label: `${m}:${String(s).padStart(2, '0')}` };
}

/** Status pill for a booking, including payment state. */
export function bookingBadge(r: Reservation, past: boolean): { text: string; cls: string } {
  if (r.status === 'cancelled') return { text: 'Cancelled', cls: 'badge-off' };
  if (r.status === 'pending') {
    if (r.payment_status === 'submitted') return { text: 'Payment being checked', cls: 'badge-warn' };
    if (r.payment_status === 'rejected') return { text: 'Payment not found', cls: 'badge-off' };
    return { text: 'Awaiting payment', cls: 'badge-warn' };
  }
  if (past) return { text: 'Completed', cls: '' };
  return { text: r.payment_status === 'verified' ? 'Paid · Confirmed' : 'Confirmed', cls: 'badge-ok' };
}

/**
 * Online QR payment for a pending booking: shows the QR, amount, instructions and a
 * countdown, and collects a screenshot of the e-wallet receipt (reference number visible).
 */
/** Anything paid by QR: a court booking or an event / class sign-up. */
export interface Payable {
  id: string;
  status: string;
  payment_status?: string;
  payment_ref?: string | null;
  payment_proof_path?: string | null;
  payment_note?: string | null;
  hold_expires_at?: string | null;
  amount: number | null;
}

const KIND = { submit_payment: 'booking', submit_registration_payment: 'signup', submit_order_payment: 'order' } as const;

export function PaymentPanel<T extends Payable>({ booking, onChange, rpc = 'submit_payment', what = 'booking' }: {
  booking: T; onChange: (r: T) => void; rpc?: keyof typeof KIND; what?: string;
}) {
  const { settings } = useSite();
  const auth = useAuth();
  const online = useOnline();
  const picker = useRef<HTMLInputElement>(null);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState<'' | 'preparing' | 'sending'>('');
  const [error, setError] = useState<string | null>(null);
  const waiting = booking.status === 'pending' && (booking.payment_status === 'unpaid' || booking.payment_status === 'rejected');
  const countdown = useCountdown(waiting ? booking.hold_expires_at : null);
  const expired = countdown !== null && countdown.left === 0;
  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url); }, [shot]);

  if (booking.status !== 'pending') return null;

  if (booking.payment_status === 'submitted') {
    return (
      <div className="pay-panel pay-submitted" role="status">
        <Icon name="clock" size={22} />
        <div className="pay-sent">
          <strong>{booking.payment_proof_path ? 'Receipt sent' : `Payment sent: reference ending ${booking.payment_ref}`}</strong>
          <p className="small muted">Yepjo will check your payment and confirm your {what}. Your place is held meanwhile. This page updates by itself.</p>
        </div>
        <ReceiptThumb path={booking.payment_proof_path} label="Your receipt" size="sm" />
      </div>
    );
  }

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null); setBusy('preparing');
    try {
      const blob = await prepareReceipt(file);
      setShot({ blob, url: URL.createObjectURL(blob) });
    } catch (e) {
      setShot(null);
      setError(e instanceof PhotoError ? e.message : 'That file could not be opened. Choose a screenshot or photo of your receipt.');
    } finally {
      setBusy('');
      if (picker.current) picker.current.value = '';
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!shot) return setError('Attach the screenshot of your payment receipt first.');
    if (!auth.user) return setError('Please sign in again to send your receipt.');
    setBusy('sending');
    setError(null);
    try {
      const path = await uploadReceipt(shot.blob, auth.user.id, KIND[rpc]);
      const { data, error: err } = await supabase.rpc('submit_payment_receipt', { p_kind: KIND[rpc], p_id: booking.id, p_path: path });
      if (err) return setError(toAppError(err).message);
      const saved = data as T;
      if (saved.status === 'cancelled') setError(`The payment time for this ${what} ran out and the place was released. Please try again.`);
      setShot(null);
      onChange(saved);
    } catch (e2) {
      setError(e2 instanceof PhotoError ? e2.message : 'The receipt could not be sent. Check your connection and try again.');
    } finally {
      setBusy('');
    }
  };

  const amount = booking.amount != null ? fmtMoney(Number(booking.amount), settings.currency) : null;
  return (
    <form className="pay-panel" onSubmit={submit} noValidate>
      <div className="pay-head">
        <h3>Pay online to confirm</h3>
        {countdown && (
          <span className={`pay-timer${countdown.left < 5 * 60_000 ? ' is-low' : ''}`} aria-live="off">
            <Icon name="clock" size={16} /> {expired ? 'Time is up' : `${countdown.label} left`}
          </span>
        )}
      </div>
      {booking.payment_status === 'rejected' && (
        <Notice kind="error">{booking.payment_note || 'We could not confirm this payment.'} Send a clear screenshot of your receipt again.</Notice>
      )}
      <div className="pay-body">
        {settings.payment_qr_path && (
          <a href={photoUrl(settings.payment_qr_path)} target="_blank" rel="noopener noreferrer" className="pay-qr" aria-label="Open the payment QR code full size">
            <img src={photoUrl(settings.payment_qr_path)} alt="Yepjo payment QR code" width={220} height={220} />
          </a>
        )}
        <ol className="pay-steps small">
          <li>Scan the QR with GCash, Maya or your bank app{amount ? <> and pay <strong className="ok-text">{amount}</strong></> : ''}.</li>
          {settings.payment_instructions && <li className="pay-note">{settings.payment_instructions}</li>}
          <li>Take a <strong>screenshot of the receipt</strong>. The <strong>reference number</strong> and amount must be visible.</li>
          <li>Attach the screenshot below and send it. Yepjo checks it, and your {what} becomes <strong>Confirmed</strong>.</li>
        </ol>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="pay-form pay-upload">
        <input ref={picker} type="file" accept="image/*" className="sr-only" id={`receipt-${booking.id}`} aria-label="Receipt screenshot"
          onChange={(e) => void pick(e.target.files?.[0])} disabled={busy !== '' || expired} />
        {shot ? (
          <div className="receipt-picked">
            <a href={shot.url} target="_blank" rel="noopener noreferrer" className="receipt-thumb receipt-md" aria-label="Open the attached screenshot">
              <img src={shot.url} alt="Attached receipt screenshot" />
            </a>
            <div className="receipt-picked-text">
              <strong className="small">Screenshot attached</strong>
              <span className="tiny muted">Check that the reference number can be read.</span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => picker.current?.click()} disabled={busy !== ''}>Change screenshot</button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-outline receipt-pick" onClick={() => picker.current?.click()} disabled={busy !== '' || expired}>
            <Icon name="upload" size={18} /> {busy === 'preparing' ? 'Preparing…' : 'Attach receipt screenshot'}
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy !== '' || !online || expired || !shot}>
          {busy === 'sending' ? 'Sending…' : 'Send receipt'}
        </button>
      </div>
      <p className="tiny muted">
        {booking.hold_expires_at && !expired ? `If unpaid, this ${what} is released at ${fmtTime(booking.hold_expires_at)}. ` : ''}
        Only you and Yepjo staff can see your screenshot. It is removed 30 days after your payment is approved.
      </p>
    </form>
  );
}
