import { useCallback, useEffect, useState } from 'react';
import { supabase, toAppError } from '../lib/supabase';
import { fmtDateLong, fmtMoney, fmtTime, toUtcMs } from '../lib/time';
import { fmtClock } from '../lib/pricing';
import { EVENT_KIND_LABEL, type Registration } from '../lib/types';
import { useAuth } from '../state/auth';
import { useSite } from '../state/site';
import { PaymentPanel } from './Payment';
import { Confirm, Icon, Notice } from './ui';

const startOf = (r: Registration) =>
  r.dance ? new Date(r.dance.starts_at).getTime()
    : r.event ? toUtcMs(r.event.starts_on, Number(r.event.start_time.slice(0, 2)) * 60 + Number(r.event.start_time.slice(3, 5))) : 0;
const endOf = (r: Registration) =>
  r.dance ? new Date(r.dance.ends_at).getTime()
    : r.event ? toUtcMs(r.event.ends_on, Number(r.event.end_time.slice(0, 2)) * 60 + Number(r.event.end_time.slice(3, 5))) + (r.event.end_time <= r.event.start_time ? 86_400_000 : 0) : 0;

/** The member's event registrations and Step Up Dance class bookings. */
export function MySignups({ tab }: { tab: 'upcoming' | 'history' }) {
  const auth = useAuth();
  const { settings, pulse } = useSite();
  const [rows, setRows] = useState<Registration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Registration | null>(null);
  const [busy, setBusy] = useState(false);
  const uid = auth.user?.id;

  const load = useCallback(async () => {
    if (!uid) return;
    const { data, error: err } = await supabase.from('registrations')
      .select('*, event:events(id,title,kind,starts_on,ends_on,start_time,end_time), dance:dance_sessions(id,dance_type,instructor,starts_at,ends_at)')
      .eq('user_id', uid).order('created_at', { ascending: false }).limit(100);
    if (err) setError(toAppError(err).message);
    else { setRows((data as Registration[]) ?? []); setError(null); }
  }, [uid]);
  useEffect(() => { void load(); }, [load, pulse]);

  if (!uid || rows === null || rows.length === 0) return error ? <Notice kind="error">{error}</Notice> : null;
  const now = Date.now();
  const list = rows
    .filter((r) => (tab === 'upcoming' ? r.status !== 'cancelled' && endOf(r) > now : r.status === 'cancelled' || endOf(r) <= now))
    .sort((a, b) => (tab === 'upcoming' ? startOf(a) - startOf(b) : startOf(b) - startOf(a)));
  if (list.length === 0) return null;

  const cancel = async () => {
    if (!target) return;
    setBusy(true);
    const { error: err } = await supabase.rpc('cancel_registration', { p_id: target.id });
    setBusy(false);
    setTarget(null);
    if (err) setError(toAppError(err).message);
    void load();
  };
  const badge = (r: Registration) => {
    if (r.status === 'cancelled') return { t: 'Cancelled', c: 'badge-off' };
    if (r.status === 'pending') return r.payment_status === 'submitted' ? { t: 'Payment being checked', c: 'badge-warn' } : { t: 'Awaiting payment', c: 'badge-warn' };
    return { t: r.payment_status === 'verified' ? 'Paid · Confirmed' : 'Confirmed', c: 'badge-ok' };
  };

  return (
    <section className="stack-sm" aria-labelledby="signups-h">
      <h2 id="signups-h" className="day-head">Events &amp; dance classes</h2>
      {error && <Notice kind="error">{error}</Notice>}
      <ul className="booking-list">
        {list.map((r) => {
          const b = badge(r);
          const upcoming = endOf(r) > now && r.status !== 'cancelled';
          const started = startOf(r) <= now;
          return (
            <li key={r.id} className="card booking">
              <div className="booking-head">
                <strong>
                  <Icon name={r.kind === 'dance' ? 'dance' : 'trophy'} size={16} />{' '}
                  {r.kind === 'dance' ? `Step Up Dance · ${r.dance?.dance_type ?? ''}` : r.event?.title ?? 'Event'}
                </strong>
                <span className={`badge ${b.c}`}>{b.t}</span>
              </div>
              {r.kind === 'dance' && r.dance && (
                <p className="small">{fmtDateLong(r.dance.starts_at)} · {fmtTime(r.dance.starts_at)}–{fmtTime(r.dance.ends_at)} · {r.dance.instructor}</p>
              )}
              {r.kind === 'event' && r.event && (
                <p className="small">{EVENT_KIND_LABEL[r.event.kind]} · {fmtDateLong(toUtcMs(r.event.starts_on, 720))}{r.event.ends_on !== r.event.starts_on ? ` – ${fmtDateLong(toUtcMs(r.event.ends_on, 720))}` : ''} · {fmtClock(r.event.start_time)}–{fmtClock(r.event.end_time)}</p>
              )}
              <p className="tiny muted">{Number(r.amount) > 0 ? `${fmtMoney(Number(r.amount), settings.currency)} · ${r.payment_method === 'venue' ? 'pay at the venue' : 'paid by QR'}` : 'Free'}</p>
              {upcoming && r.status === 'pending' && (
                <PaymentPanel booking={r} onChange={() => void load()} rpc="submit_registration_payment" what={r.kind === 'dance' ? 'class booking' : 'registration'} />
              )}
              <div className="booking-foot">
                <span className="ref">Ref. {r.reference}</span>
                {upcoming && !started && r.payment_status !== 'submitted' && r.payment_status !== 'verified' && (
                  <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => setTarget(r)}>Cancel</button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {target && (
        <Confirm title="Cancel this sign-up?" confirmLabel="Cancel sign-up" danger busy={busy} onConfirm={() => void cancel()} onClose={() => setTarget(null)}>
          <p>Your place will be given to someone else.</p>
        </Confirm>
      )}
    </section>
  );
}
