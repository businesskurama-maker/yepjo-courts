import { useEffect, useState } from 'react';
import { Link } from '../lib/router';
import { supabase, toAppError } from '../lib/supabase';
import { fmtMoney } from '../lib/time';
import type { Registration } from '../lib/types';
import { useAuth } from '../state/auth';
import { useSite } from '../state/site';
import { PaymentPanel } from './Payment';
import { GoogleButton, Icon, Modal, Notice } from './ui';

/**
 * Sign up for an event or a Step Up Dance class: sign in → choose how to pay →
 * confirmed, or the payment QR with the 6-digit reference step.
 */
export function SignUpDialog({ kind, targetId, title, subtitle, price, onClose, onDone }: {
  kind: 'event' | 'dance'; targetId: string; title: string; subtitle: string; price: number;
  onClose: () => void; onDone: () => void;
}) {
  const auth = useAuth();
  const { settings } = useSite();
  const canOnline = settings.online_payment_enabled && !!settings.payment_qr_path;
  const canVenue = settings.allow_pay_at_venue;
  const [payOnline, setPayOnline] = useState(canOnline);
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Registration | null>(null);
  const what = kind === 'dance' ? 'class booking' : 'registration';

  useEffect(() => { if (!canOnline) setPayOnline(false); }, [canOnline]);

  const signIn = async () => {
    setSigningIn(true);
    const problem = await auth.signIn(`${window.location.pathname}${window.location.search}`);
    if (problem) { setError(problem); setSigningIn(false); }
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase.rpc('register', { p_kind: kind, p_target: targetId, p_pay_online: price > 0 && payOnline });
    setBusy(false);
    if (err) return setError(toAppError(err).message);
    setDone(data as Registration);
    onDone();
  };

  const money = (v: number) => fmtMoney(v, settings.currency).replace(/\.00$/, '');
  return (
    <Modal title={done ? (done.status === 'confirmed' ? "You're in!" : 'Almost done') : kind === 'dance' ? 'Book this class' : 'Join this event'} onClose={onClose}>
      <div className="form">
        <div className="signup-summary">
          <strong>{title}</strong>
          <span className="small muted">{subtitle}</span>
          <span className="small">{price > 0 ? <>Fee: <b className="ok-text">{money(price)}</b></> : 'Free'}</span>
        </div>
        {error && <Notice kind="error">{error}</Notice>}

        {done ? (
          <>
            {done.status === 'confirmed' && (
              <Notice kind="ok">
                Confirmed. Reference <strong>{done.reference}</strong>.
                {done.payment_method === 'venue' ? ' Please pay at the counter when you arrive.' : ''} You can see it under My bookings.
              </Notice>
            )}
            {done.status === 'pending' && (
              <PaymentPanel booking={done} onChange={setDone} rpc="submit_registration_payment" what={what} />
            )}
            {done.status === 'cancelled' && <Notice kind="error">The payment time ran out and your place was released. Please sign up again.</Notice>}
            <div className="btn-row">
              <Link to="/bookings" className="btn btn-outline">My bookings</Link>
              <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
            </div>
          </>
        ) : !auth.user ? (
          <>
            <p className="muted small">Sign in with Google so Yepjo can keep your place and contact you.</p>
            <GoogleButton onClick={() => void signIn()} busy={signingIn} label="Sign in with Google to continue" />
          </>
        ) : !auth.profileComplete ? (
          <Notice kind="warn">Add your name and contact number first. <Link to="/welcome" className="link">Complete profile</Link></Notice>
        ) : (
          <>
            {price > 0 && (canOnline || canVenue) && (
              <fieldset className="pay-choice">
                <legend className="field-label">How will you pay?</legend>
                {canOnline && (
                  <label className={`pay-option${payOnline ? ' is-active' : ''}`}>
                    <input type="radio" name="pay" checked={payOnline} onChange={() => setPayOnline(true)} />
                    <span><strong><Icon name="qr" size={16} /> Pay now with QR</strong><small>GCash, Maya or bank app, then enter the last 6 digits of the reference. Confirmed once Yepjo checks it.</small></span>
                  </label>
                )}
                {canVenue && (
                  <label className={`pay-option${!payOnline ? ' is-active' : ''}`}>
                    <input type="radio" name="pay" checked={!payOnline} onChange={() => setPayOnline(false)} />
                    <span><strong>Pay at the venue</strong><small>Confirmed right away. Pay at the counter when you arrive.</small></span>
                  </label>
                )}
              </fieldset>
            )}
            <p className="tiny muted">Signed in as {auth.profile?.full_name} · {auth.profile?.phone}</p>
            <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={() => void confirm()}>
              {busy ? 'Saving…' : price > 0 && payOnline ? 'Hold my place & pay' : kind === 'dance' ? 'Book my slot' : 'Register'}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Places taken per event / class (public counts, kept live). */
export function useSignupCounts(pulse: number) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    void supabase.rpc('signup_counts').then(({ data }) => {
      if (!alive || !data) return;
      const m: Record<string, number> = {};
      (data as { target: string; taken: number }[]).forEach((r) => { m[r.target] = r.taken; });
      setCounts(m);
    });
    return () => { alive = false; };
  }, [pulse]);
  return counts;
}
