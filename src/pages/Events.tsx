import { useEffect, useMemo, useState } from 'react';
import { SignUpDialog, useSignupCounts } from '../components/SignUp';
import { Empty, Icon, Notice, Spinner } from '../components/ui';
import { fmtClock } from '../lib/pricing';
import { photoUrl, supabase, toAppError } from '../lib/supabase';
import { fmtDateLong, fmtMoney, toUtcMs, todayYmd } from '../lib/time';
import { EVENT_KIND_LABEL, SPORT_LABEL, type EventKind, type YepjoEvent } from '../lib/types';
import { useSite } from '../state/site';

const dayText = (ymd: string) => fmtDateLong(toUtcMs(ymd, 720));
export const eventWhen = (e: Pick<YepjoEvent, 'starts_on' | 'ends_on' | 'start_time' | 'end_time'>) =>
  `${e.starts_on === e.ends_on ? dayText(e.starts_on) : `${dayText(e.starts_on)} – ${dayText(e.ends_on)}`} · ${fmtClock(e.start_time)}–${fmtClock(e.end_time)}${e.starts_on !== e.ends_on ? ' daily' : ''}`;

/** Open play, trainings and tournaments set by Yepjo; members register here. */
export default function Events() {
  const { settings, pulse } = useSite();
  const [events, setEvents] = useState<YepjoEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<EventKind | 'all'>('all');
  const [joining, setJoining] = useState<YepjoEvent | null>(null);
  const [tick, setTick] = useState(0);
  const counts = useSignupCounts(pulse + tick);
  const today = todayYmd();

  useEffect(() => {
    let alive = true;
    void supabase.from('events').select('*').eq('is_published', true).gte('ends_on', today).order('starts_on').order('start_time')
      .then(({ data, error: err }) => {
        if (!alive) return;
        if (err) setError(toAppError(err).message);
        else { setEvents((data as YepjoEvent[]) ?? []); setError(null); }
      });
    return () => { alive = false; };
  }, [pulse, today]);

  const kinds = useMemo(() => Array.from(new Set((events ?? []).map((e) => e.kind))), [events]);
  const shown = (events ?? []).filter((e) => filter === 'all' || e.kind === filter);
  const money = (v: number) => fmtMoney(v, settings.currency).replace(/\.00$/, '');

  return (
    <div className="page portal">
      <header className="portal-head">
        <div>
          <h1 className="page-title">Events</h1>
          <p className="muted small">Open play, trainings and tournaments at Yepjo. Register here and pay by QR or at the venue.</p>
        </div>
        {kinds.length > 1 && (
          <div className="chip-row" role="radiogroup" aria-label="Show">
            <button type="button" role="radio" aria-checked={filter === 'all'} className={`chip${filter === 'all' ? ' is-active' : ''}`} onClick={() => setFilter('all')}>All</button>
            {kinds.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={filter === k} className={`chip${filter === k ? ' is-active' : ''}`} onClick={() => setFilter(k)}>{EVENT_KIND_LABEL[k]}</button>
            ))}
          </div>
        )}
      </header>

      {error && <Notice kind="error">{error}</Notice>}
      {events === null && !error && <Spinner label="Loading events…" />}
      {events !== null && shown.length === 0 && (
        <Empty icon="trophy" title="No upcoming events yet">New open play sessions, trainings and tournaments will appear here. Follow Yepjo on Facebook for news.</Empty>
      )}

      <div className="portal-grid">
        {shown.map((e) => {
          const taken = counts[e.id] ?? 0;
          const left = e.capacity != null ? Math.max(0, e.capacity - taken) : null;
          const full = left === 0;
          return (
            <article key={e.id} className={`card portal-card event-card kind-${e.kind}`}>
              {e.image_path
                ? <img className="portal-img" src={photoUrl(e.image_path)} alt="" loading="lazy" decoding="async" />
                : <div className="portal-img portal-img-art" aria-hidden="true"><Icon name={e.kind === 'tournament' ? 'trophy' : 'star'} size={40} /></div>}
              <div className="portal-body">
                <div className="badge-row">
                  <span className={`badge event-kind kind-${e.kind}`}>{EVENT_KIND_LABEL[e.kind]}</span>
                  {e.sport && <span className="badge">{e.sport === 'dance' ? 'Step Up Dance' : SPORT_LABEL[e.sport]}</span>}
                </div>
                <h2 className="portal-title">{e.title}</h2>
                <p className="small"><Icon name="calendar" size={14} /> {eventWhen(e)}</p>
                {e.description && <p className="small muted pre-line">{e.description}</p>}
                <div className="portal-foot">
                  <span className="portal-price">{e.price > 0 ? money(Number(e.price)) : 'Free'}</span>
                  {left !== null && <span className={`small ${left <= 3 ? 'warn-text' : 'muted'}`}>{full ? 'Full' : `${left} of ${e.capacity} places left`}</span>}
                </div>
                <button type="button" className="btn btn-primary btn-block" disabled={full || !e.registration_open} onClick={() => setJoining(e)}>
                  {full ? 'Full' : !e.registration_open ? 'Registration closed' : 'Register'}
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {joining && (
        <SignUpDialog kind="event" targetId={joining.id} title={joining.title} subtitle={eventWhen(joining)} price={Number(joining.price)}
          onClose={() => setJoining(null)} onDone={() => setTick((t) => t + 1)} />
      )}
    </div>
  );
}
