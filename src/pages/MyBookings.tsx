import { useCallback, useEffect, useState } from 'react';
import { MySignups } from '../components/MySignups';
import { Confirm, Empty, GoogleButton, Icon, Modal, Notice, Pager, Spinner, useOnline, useToast } from '../components/ui';
import { Link } from '../lib/router';
import { supabase, toAppError } from '../lib/supabase';
import { fmtDateLong, fmtDuration, fmtMoney, fmtRange, fmtTime } from '../lib/time';
import { SPORT_LABEL, awaitingPayment, type Reservation } from '../lib/types';
import { PaymentPanel, bookingBadge } from '../components/Payment';
import { useAuth } from '../state/auth';
import { useSite } from '../state/site';

const PAGE_SIZE = 10;

export default function MyBookings() {
  const auth = useAuth();
  const { settings, pulse } = useSite();
  const online = useOnline();
  const toast = useToast();
  const [tab, setTab] = useState<'upcoming' | 'history'>('upcoming');
  const [rows, setRows] = useState<Reservation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<Reservation | null>(null);
  const [busy, setBusy] = useState(false);
  const [extending, setExtending] = useState<Reservation | null>(null);
  const [extHours, setExtHours] = useState(1);
  const [extError, setExtError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const userId = auth.user?.id;

  const load = useCallback(async () => {
    if (!userId) return;
    const { data, error: err } = await supabase
      .from('reservations')
      .select('*, court:courts(id,name,sport)')
      .eq('user_id', userId)
      .order('starts_at', { ascending: false })
      .limit(300);
    if (err) setError(toAppError(err).message);
    else {
      setRows((data as Reservation[]) ?? []);
      setError(null);
    }
    setNow(Date.now());
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load, pulse]);

  if (!auth.ready) return <div className="page"><Spinner /></div>;
  if (!auth.user) {
    return (
      <div className="page page-narrow">
        <h1 className="page-title">My bookings</h1>
        <div className="card gate">
          <p>Sign in to see your reservations.</p>
          <GoogleButton onClick={() => void auth.signIn('/bookings')} />
        </div>
      </div>
    );
  }

  const all = rows ?? [];
  const holdLapsed = (r: Reservation) => awaitingPayment(r) && !!r.hold_expires_at && new Date(r.hold_expires_at).getTime() <= now;
  const isUpcoming = (r: Reservation) => (r.status === 'confirmed' || (r.status === 'pending' && !holdLapsed(r))) && new Date(r.ends_at).getTime() > now;
  const upcoming = all.filter(isUpcoming).reverse();
  const history = all.filter((r) => !isUpcoming(r));
  const list = tab === 'upcoming' ? upcoming : history;
  const shown = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const cutoffMs = settings.cancel_cutoff_hours * 3_600_000;
  const canCancel = (r: Reservation) => r.status === 'pending'
    ? r.payment_status !== 'submitted'
    : settings.allow_cancellation && new Date(r.starts_at).getTime() - cutoffMs > now;
  const feePct = settings.cancel_fee_percent ?? 50;
  const paidOnline = (r: Reservation) => r.payment_status === 'verified' && Number(r.amount ?? 0) > 0;
  const money = (v: number) => fmtMoney(v, settings.currency);
  const replace = (saved: Reservation) => setRows((rs) => (rs ?? []).map((x) => (x.id === saved.id ? { ...x, ...saved } : x)));

  const askExtend = async () => {
    if (!extending) return;
    setBusy(true); setExtError(null);
    const { data, error: err } = await supabase.rpc('request_extension', { p_id: extending.id, p_minutes: extHours * 60 });
    setBusy(false);
    if (err) return setExtError(toAppError(err).message);
    replace(data as Reservation); setExtending(null);
    toast('Request sent. Yepjo staff will confirm your extra time.');
  };
  const withdraw = async (r: Reservation) => {
    const { data, error: err } = await supabase.rpc('clear_extension_request', { p_id: r.id });
    if (err) return toast(toAppError(err).message, 'error');
    replace(data as Reservation);
  };

  const cancel = async () => {
    if (!target) return;
    setBusy(true);
    const { error: err } = await supabase.rpc('cancel_reservation', { p_id: target.id });
    setBusy(false);
    if (err) {
      toast(toAppError(err).message, 'error');
    } else {
      toast(paidOnline(target)
        ? `Booking ${target.reference} cancelled. Claim your ${money(Number(target.amount) * (100 - feePct) / 100)} refund in person at Yepjo.`
        : `Booking ${target.reference} was cancelled. The slot is open again.`);
      setTarget(null);
    }
    void load();
  };

  return (
    <div className="page page-mid">
      <div className="title-row">
        <h1 className="page-title">My bookings</h1>
        <Link to="/book" className="btn btn-primary btn-sm"><Icon name="plus" size={16} /> New booking</Link>
      </div>

      <div className="tabs" role="tablist" aria-label="Bookings">
        {(['upcoming', 'history'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab${tab === t ? ' is-active' : ''}`}
            onClick={() => { setTab(t); setPage(1); }}>
            {t === 'upcoming' ? `Upcoming (${upcoming.length})` : `History (${history.length})`}
          </button>
        ))}
      </div>

      {error && <Notice kind="error" action={<button type="button" className="btn btn-sm" onClick={() => void load()}>Retry</button>}>{error}</Notice>}
      {!online && <Notice kind="warn">You're offline. Your bookings are shown only with a live connection.</Notice>}
      {rows === null && !error && <Spinner label="Loading your bookings…" />}

      {rows !== null && list.length === 0 && (
        <Empty icon="ticket" title={tab === 'upcoming' ? 'No upcoming bookings' : 'No past bookings yet'}>
          {tab === 'upcoming' && <Link to="/book" className="link">Book a court</Link>}
        </Empty>
      )}

      <ul className="booking-list">
        {shown.map((r) => {
          const past = r.status === 'confirmed' && !isUpcoming(r);
          const badge = r.status === 'pending' && holdLapsed(r) ? { text: 'Expired · not paid', cls: 'badge-off' } : bookingBadge(r, past);
          const minutes = (new Date(r.ends_at).getTime() - new Date(r.starts_at).getTime()) / 60_000;
          return (
            <li key={r.id} className="card booking">
              <div className="booking-head">
                <strong>{r.court ? `${SPORT_LABEL[r.court.sport]} · ${r.court.name}` : 'Court'}</strong>
                <span className={`badge ${badge.cls}`}>{badge.text}</span>
              </div>
              <p>{fmtDateLong(r.starts_at)}</p>
              <p className="small">{fmtRange(r.starts_at, r.ends_at)} · {fmtDuration(minutes)}{r.amount != null ? ` · ${fmtMoney(Number(r.amount), settings.currency)}` : ''}</p>
              {r.status === 'cancelled' && r.cancel_reason && <p className="tiny muted">{r.cancel_reason}</p>}
              {r.status === 'cancelled' && Number(r.refund_amount ?? 0) > 0 && (
                <p className={`small refund-note ${r.refund_status === 'claimed' ? 'is-done' : ''}`}>
                  {r.refund_status === 'claimed'
                    ? `Refund of ${money(Number(r.refund_amount))} received at Yepjo.`
                    : `Refund ${money(Number(r.refund_amount))}: claim it in person at Yepjo${Number(r.cancel_fee ?? 0) > 0 ? ` (${money(Number(r.cancel_fee))} cancellation fee kept)` : ''}. Bring your reference ${r.reference}.`}
                </p>
              )}
              {isUpcoming(r) && r.status === 'pending' && <PaymentPanel booking={r} onChange={replace} />}
              {Number(r.extra_minutes ?? 0) > 0 && r.status === 'confirmed' && (
                <p className="small refund-note is-done">Extended by {fmtDuration(Number(r.extra_minutes))}.{Number(r.extra_unpaid ?? 0) > 0 ? ` Please pay ${money(Number(r.extra_unpaid))} for the extra time at the counter.` : ''}</p>
              )}
              {isUpcoming(r) && r.status === 'confirmed' && (r.extend_request_minutes ? (
                <p className="small extend-wait">
                  <Icon name="clock" size={15} /> You asked for +{fmtDuration(r.extend_request_minutes)}. Waiting for Yepjo staff to approve.{' '}
                  <button type="button" className="link" onClick={() => void withdraw(r)}>Withdraw</button>
                </p>
              ) : (
                <button type="button" className="btn btn-sm btn-outline extend-btn" onClick={() => { setExtHours(1); setExtError(null); setExtending(r); }} disabled={!online}>
                  <Icon name="clock" size={16} /> Extend time
                </button>
              ))}
              <div className="booking-foot">
                <span className="ref">Ref. {r.reference}</span>
                {isUpcoming(r) && (canCancel(r)
                  ? <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => setTarget(r)} disabled={!online}>{r.status === 'pending' ? 'Cancel' : 'Cancel booking'}</button>
                  : <span className="muted tiny cancel-help">
                      {r.status === 'pending' ? 'Payment is being checked. To cancel, ' : settings.allow_cancellation ? `Less than ${settings.cancel_cutoff_hours} hours to go. To cancel, ` : 'To cancel, '}
                      {settings.phone ? <><a href={`tel:${settings.phone.replace(/\s/g, '')}`} className="link">call {settings.phone}</a> or </> : 'call or '}
                      <Link to="/chat" className="link">message Yepjo</Link>.
                    </span>)}
              </div>
            </li>
          );
        })}
      </ul>
      <Pager page={page} pageSize={PAGE_SIZE} total={list.length} onPage={setPage} />
      <MySignups tab={tab} />

      {extending && (
        <Modal title="Extend your time" onClose={() => setExtending(null)} footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setExtending(null)} disabled={busy}>Close</button>
            <button type="button" className="btn btn-primary" onClick={() => void askExtend()} disabled={busy}>{busy ? 'Sending…' : 'Ask Yepjo staff'}</button>
          </>
        }>
          <div className="stack-sm">
            <p>{extending.court ? `${SPORT_LABEL[extending.court.sport]} · ${extending.court.name}` : 'Court'}<br /><span className="muted small">Now {fmtRange(extending.starts_at, extending.ends_at)}</span></p>
            <div className="chip-row" role="radiogroup" aria-label="Extra hours">
              {[1, 2].map((h) => (
                <button key={h} type="button" role="radio" aria-checked={extHours === h} className={`chip${extHours === h ? ' is-active' : ''}`} onClick={() => { setExtHours(h); setExtError(null); }}>
                  +{h} hour{h === 1 ? '' : 's'}
                </button>
              ))}
            </div>
            <p className="small">New end time: <strong>{fmtTime(new Date(new Date(extending.ends_at).getTime() + extHours * 3_600_000).toISOString())}</strong></p>
            <p className="tiny muted">You can only ask while the next hour is still free. Staff will approve it and tell you how to pay for the extra time.</p>
            {extError && <Notice kind="error">{extError}</Notice>}
          </div>
        </Modal>
      )}

      {target && (
        <Confirm title="Cancel this booking?" confirmLabel="Cancel booking" danger busy={busy} onConfirm={() => void cancel()} onClose={() => setTarget(null)}>
          <p>{target.court ? `${SPORT_LABEL[target.court.sport]} · ${target.court.name}` : ''}</p>
          <p>{fmtDateLong(target.starts_at)}<br />{fmtRange(target.starts_at, target.ends_at)}</p>
          {paidOnline(target) ? (
            <div className="fee-box">
              <p><strong>Cancellation fee: {money(Number(target.amount) * feePct / 100)}</strong> ({feePct}% of {money(Number(target.amount))}).</p>
              <p>The other <strong>{money(Number(target.amount) * (100 - feePct) / 100)}</strong> is not refunded online. Claim it in person at Yepjo with your reference {target.reference}.</p>
            </div>
          ) : null}
          <p className="muted small">The slot will be released for others to book. This cannot be undone.</p>
        </Confirm>
      )}
    </div>
  );
}
