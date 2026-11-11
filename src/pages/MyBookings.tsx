import { useCallback, useEffect, useState } from 'react';
import { Confirm, Empty, GoogleButton, Icon, Notice, Pager, Spinner, useOnline, useToast } from '../components/ui';
import { Link } from '../lib/router';
import { supabase, toAppError } from '../lib/supabase';
import { fmtDateLong, fmtDuration, fmtMoney, fmtRange } from '../lib/time';
import { SPORT_LABEL, type Reservation } from '../lib/types';
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
  const isUpcoming = (r: Reservation) => r.status === 'confirmed' && new Date(r.ends_at).getTime() > now;
  const upcoming = all.filter(isUpcoming).reverse();
  const history = all.filter((r) => !isUpcoming(r));
  const list = tab === 'upcoming' ? upcoming : history;
  const shown = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const cutoffMs = settings.cancel_cutoff_hours * 3_600_000;
  const canCancel = (r: Reservation) => settings.allow_cancellation && new Date(r.starts_at).getTime() - cutoffMs > now;

  const cancel = async () => {
    if (!target) return;
    setBusy(true);
    const { error: err } = await supabase.rpc('cancel_reservation', { p_id: target.id });
    setBusy(false);
    if (err) {
      toast(toAppError(err).message, 'error');
    } else {
      toast(`Booking ${target.reference} was cancelled. The slot is open again.`);
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
          const minutes = (new Date(r.ends_at).getTime() - new Date(r.starts_at).getTime()) / 60_000;
          return (
            <li key={r.id} className="card booking">
              <div className="booking-head">
                <strong>{r.court ? `${SPORT_LABEL[r.court.sport]} · ${r.court.name}` : 'Court'}</strong>
                <span className={`badge ${r.status === 'cancelled' ? 'badge-off' : past ? '' : 'badge-ok'}`}>
                  {r.status === 'cancelled' ? 'Cancelled' : past ? 'Completed' : 'Confirmed'}
                </span>
              </div>
              <p>{fmtDateLong(r.starts_at)}</p>
              <p className="small">{fmtRange(r.starts_at, r.ends_at)} · {fmtDuration(minutes)}{r.amount != null ? ` · ${fmtMoney(Number(r.amount), settings.currency)}` : ''}</p>
              <div className="booking-foot">
                <span className="ref">Ref. {r.reference}</span>
                {isUpcoming(r) && (canCancel(r)
                  ? <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => setTarget(r)} disabled={!online}>Cancel booking</button>
                  : <span className="muted tiny">{settings.allow_cancellation ? `Cancellation closes ${settings.cancel_cutoff_hours}h before start.` : 'Online cancellation is off.'} <Link to="/chat" className="link">Message Yepjo</Link></span>)}
              </div>
            </li>
          );
        })}
      </ul>
      <Pager page={page} pageSize={PAGE_SIZE} total={list.length} onPage={setPage} />

      {target && (
        <Confirm title="Cancel this booking?" confirmLabel="Cancel booking" danger busy={busy} onConfirm={() => void cancel()} onClose={() => setTarget(null)}>
          <p>{target.court ? `${SPORT_LABEL[target.court.sport]} · ${target.court.name}` : ''}</p>
          <p>{fmtDateLong(target.starts_at)}<br />{fmtRange(target.starts_at, target.ends_at)}</p>
          <p className="muted small">The slot will be released for others to book. This cannot be undone.</p>
        </Confirm>
      )}
    </div>
  );
}
