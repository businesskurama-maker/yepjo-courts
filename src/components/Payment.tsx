import { useEffect, useState, type FormEvent } from 'react';
import { photoUrl, supabase, toAppError } from '../lib/supabase';
import { fmtMoney, fmtTime } from '../lib/time';
import { awaitingPayment, type Reservation } from '../lib/types';
import { useSite } from '../state/site';
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
 * countdown, and collects the last 6 digits of the payment reference.
 */
export function PaymentPanel({ booking, onChange }: { booking: Reservation; onChange: (r: Reservation) => void }) {
  const { settings } = useSite();
  const online = useOnline();
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const countdown = useCountdown(awaitingPayment(booking) ? booking.hold_expires_at : null);
  const expired = countdown !== null && countdown.left === 0;

  if (booking.status !== 'pending') return null;

  if (booking.payment_status === 'submitted') {
    return (
      <div className="pay-panel pay-submitted" role="status">
        <Icon name="clock" size={22} />
        <div>
          <strong>Payment sent: reference ending {booking.payment_ref}</strong>
          <p className="small muted">Yepjo will check your payment and confirm the booking. Your court is held meanwhile. This page updates by itself.</p>
        </div>
      </div>
    );
  }

  const digits = ref.replace(/\D/g, '');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (digits.length !== 6) return setError('Enter exactly the last 6 digits of the reference number.');
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase.rpc('submit_payment', { p_id: booking.id, p_ref: digits });
    setBusy(false);
    if (err) return setError(toAppError(err).message);
    const saved = data as Reservation;
    if (saved.status === 'cancelled') setError('The payment time for this booking ran out and the court was released. Please book again.');
    onChange(saved);
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
        <Notice kind="error">{booking.payment_note || 'We could not find this payment.'} Check the number and send it again.</Notice>
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
          <li>Type the <strong>last 6 digits</strong> of the reference number from your receipt.</li>
          <li>Yepjo confirms it, and your booking becomes <strong>Confirmed</strong>.</li>
        </ol>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="pay-form">
        <label className="field">
          <span className="field-label">Last 6 digits of the reference no.</span>
          <input type="text" inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" maxLength={7} placeholder="e.g. 482915"
            value={ref} onChange={(e) => setRef(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} className="pay-input" aria-invalid={!!error} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || !online || expired || digits.length !== 6}>
          {busy ? 'Sending…' : 'Submit payment'}
        </button>
      </div>
      {booking.hold_expires_at && !expired && (
        <p className="tiny muted">Unpaid bookings are released at {fmtTime(booking.hold_expires_at)}.</p>
      )}
    </form>
  );
}
