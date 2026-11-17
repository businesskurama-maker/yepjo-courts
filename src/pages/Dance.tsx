import { useEffect, useMemo, useState } from 'react';
import { SignUpDialog, useSignupCounts } from '../components/SignUp';
import { Empty, Icon, Notice, Spinner } from '../components/ui';
import { supabase, toAppError } from '../lib/supabase';
import { dayOfMonth, fmtDateLong, fmtMoney, fmtMonth, fmtTime, fmtWeekday, toUtcMs, ymdOf } from '../lib/time';
import type { DanceSession } from '../lib/types';
import { useSite } from '../state/site';

/** Step Up Dance: classes set by Yepjo (date, time, dance type, instructor, slots). */
export default function Dance() {
  const { settings, pulse } = useSite();
  const [sessions, setSessions] = useState<DanceSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [booking, setBooking] = useState<DanceSession | null>(null);
  const [tick, setTick] = useState(0);
  const counts = useSignupCounts(pulse + tick);

  useEffect(() => {
    let alive = true;
    void supabase.from('dance_sessions').select('*').eq('is_published', true).gt('starts_at', new Date().toISOString())
      .order('starts_at').limit(200)
      .then(({ data, error: err }) => {
        if (!alive) return;
        if (err) setError(toAppError(err).message);
        else { setSessions((data as DanceSession[]) ?? []); setError(null); }
      });
    return () => { alive = false; };
  }, [pulse]);

  const list = sessions ?? [];
  const days = useMemo(() => Array.from(new Set(list.map((s) => ymdOf(new Date(s.starts_at).getTime())))), [list]);
  const types = useMemo(() => Array.from(new Set(list.map((s) => s.dance_type))).sort(), [list]);
  const shown = list.filter((s) => (!day || ymdOf(new Date(s.starts_at).getTime()) === day) && (!type || s.dance_type === type));
  const byDay = useMemo(() => {
    const m = new Map<string, DanceSession[]>();
    shown.forEach((s) => { const d = ymdOf(new Date(s.starts_at).getTime()); m.set(d, [...(m.get(d) ?? []), s]); });
    return [...m.entries()];
  }, [shown]);
  const money = (v: number) => fmtMoney(v, settings.currency).replace(/\.00$/, '');

  return (
    <div className="page portal">
      <header className="portal-head dance-hero">
        <div>
          <p className="eyebrow">Yepjo</p>
          <h1 className="page-title">Step Up Dance</h1>
          <p className="muted small">Fun step-board dance workouts with Yepjo's instructors. Pick a class and book your slot.</p>
        </div>
        <span className="badge badge-ok step-board-badge"><Icon name="check" size={14} /> Step board provided</span>
      </header>

      {error && <Notice kind="error">{error}</Notice>}
      {sessions === null && !error && <Spinner label="Loading classes…" />}

      {list.length > 0 && (
        <div className="stack-sm">
          <div className="date-strip" role="radiogroup" aria-label="Day">
            <button type="button" role="radio" aria-checked={!day} className={`date-chip${!day ? ' is-active' : ''}`} onClick={() => setDay(null)}>
              <small>All</small><strong><Icon name="calendar" size={18} /></strong><small>{list.length} classes</small>
            </button>
            {days.map((d) => (
              <button key={d} type="button" role="radio" aria-checked={day === d} className={`date-chip${day === d ? ' is-active' : ''}`}
                onClick={() => setDay(d)} aria-label={fmtDateLong(toUtcMs(d, 720))}>
                <small>{fmtWeekday(d)}</small><strong>{dayOfMonth(d)}</strong><small>{fmtMonth(d)}</small>
              </button>
            ))}
          </div>
          {types.length > 1 && (
            <div className="chip-row" role="radiogroup" aria-label="Dance type">
              <button type="button" role="radio" aria-checked={!type} className={`chip${!type ? ' is-active' : ''}`} onClick={() => setType(null)}>All types</button>
              {types.map((t) => (
                <button key={t} type="button" role="radio" aria-checked={type === t} className={`chip${type === t ? ' is-active' : ''}`} onClick={() => setType(t)}>{t}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {sessions !== null && shown.length === 0 && (
        <Empty icon="dance" title="No classes scheduled yet">New Step Up Dance classes will appear here. Message Yepjo to ask about the next schedule.</Empty>
      )}

      {byDay.map(([d, items]) => (
        <section key={d} className="stack-sm" aria-label={fmtDateLong(toUtcMs(d, 720))}>
          <h2 className="day-head">{fmtDateLong(toUtcMs(d, 720))}</h2>
          <ul className="class-list">
            {items.map((s) => {
              const taken = counts[s.id] ?? 0;
              const left = Math.max(0, s.capacity - taken);
              return (
                <li key={s.id} className="card class-card">
                  <div className="class-time">
                    <strong>{fmtTime(s.starts_at)}</strong>
                    <span className="tiny muted">to {fmtTime(s.ends_at)}</span>
                  </div>
                  <div className="class-main">
                    <strong className="class-type">{s.dance_type}</strong>
                    <span className="small"><Icon name="user" size={14} /> {s.instructor}</span>
                    <span className="badge-row">
                      {s.step_board && <span className="badge">Step board provided</span>}
                      <span className={`badge ${left === 0 ? 'badge-off' : left <= 3 ? 'badge-warn' : 'badge-ok'}`}>{left === 0 ? 'Full' : `${left} of ${s.capacity} slots left`}</span>
                    </span>
                    {s.note && <span className="tiny muted">{s.note}</span>}
                  </div>
                  <div className="class-cta">
                    <span className="portal-price">{s.price > 0 ? money(Number(s.price)) : 'Free'}</span>
                    <button type="button" className="btn btn-primary btn-sm" disabled={left === 0} onClick={() => setBooking(s)}>
                      {left === 0 ? 'Full' : 'Book slot'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {booking && (
        <SignUpDialog kind="dance" targetId={booking.id} title={`${booking.dance_type} with ${booking.instructor}`}
          subtitle={`${fmtDateLong(booking.starts_at)} · ${fmtTime(booking.starts_at)}–${fmtTime(booking.ends_at)}${booking.step_board ? ' · Step board provided' : ''}`}
          price={Number(booking.price)} onClose={() => setBooking(null)} onDone={() => setTick((t) => t + 1)} />
      )}
    </div>
  );
}
