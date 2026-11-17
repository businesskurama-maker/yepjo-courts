import { useEffect, useMemo, useState } from 'react';
import { Icon, Notice, Spinner } from '../components/ui';
import { Link, navigate, useLocation } from '../lib/router';
import { supabase, toAppError } from '../lib/supabase';
import {
  DAY_MS, buildSlots, courtWindow, dayOfMonth, fmtDateLong, fmtMoney, fmtMonth, fmtTime, fmtWeekday,
  toUtcMs, todayYmd, ymdAdd, ymdAddMonth, ymdOf, type Slot,
} from '../lib/time';
import { CLOSURE_LABEL, SPORTS, SPORT_LABEL, type Busy, type Court, type CourtRate, type Sport } from '../lib/types';
import { closureFor, dayTypeOf, fmtClock, rateRange, sportClosure } from '../lib/pricing';
import { useSite } from '../state/site';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = (ymd: string) => new Date(toUtcMs(ymd, 720)).getUTCDay();
const hourLabel = (t: number) => fmtTime(t).replace(':00', '').replace(' ', '');

/**
 * Public availability calendar: every bookable day (today → one month ahead) with how much
 * court time is still open, plus a court-by-hour board for the chosen day. Tapping an open
 * hour jumps straight into the booking flow with that court and time selected.
 */
export default function Calendar() {
  const { courts, hours, settings, rates, closures, pulse, loading } = useSite();
  const { query } = useLocation();
  const [sport, setSport] = useState<Sport>(SPORTS.find((s) => s === query.get('sport')) ?? 'pickleball');
  const [busy, setBusy] = useState<Busy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const today = todayYmd(now);
  const lastDay = ymdAddMonth(today);
  const [day, setDay] = useState(today);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    const from = toUtcMs(today);
    void supabase.rpc('get_availability', {
      p_from: new Date(from).toISOString(),
      p_to: new Date(toUtcMs(lastDay) + 2 * DAY_MS).toISOString(),
    }).then(({ data, error: err }) => {
      if (!alive) return;
      if (err) setError(toAppError(err).message);
      else {
        setBusy((data as Busy[]) ?? []);
        setError(null);
      }
    });
    return () => { alive = false; };
  }, [today, lastDay, pulse]);

  const sportCourts = useMemo(() => courts.filter((c) => c.is_active && c.sport === sport), [courts, sport]);
  const slotMin = settings.slot_minutes;

  // Per day: slots for every court of the sport.
  const grid = useMemo(() => {
    const map = new Map<string, { courtId: number; slots: Slot[] }[]>();
    if (!busy) return map;
    for (let d = today; d <= lastDay; d = ymdAdd(d, 1)) {
      map.set(d, sportCourts.map((c) => ({
        courtId: c.id,
        slots: closureFor(closures, c.id, d) ? [] : buildSlots(courtWindow(hours, c.id, d), slotMin, busy, c.id, now),
      })));
    }
    return map;
  }, [busy, today, lastDay, sportCourts, hours, slotMin, now, closures]);

  const summary = (d: string) => {
    const rows = grid.get(d) ?? [];
    const total = rows.reduce((n, r) => n + r.slots.length, 0);
    const open = rows.reduce((n, r) => n + r.slots.filter((s) => s.state === 'available').length, 0);
    const level = total === 0 ? 'closed' : open === 0 ? 'full' : open / total > 0.5 ? 'high' : open / total > 0.2 ? 'mid' : 'low';
    return { total, open, level };
  };

  // Calendar cells: whole weeks covering today → last bookable day.
  const cells = useMemo(() => {
    const first = ymdAdd(today, -dow(today));
    const last = ymdAdd(lastDay, 6 - dow(lastDay));
    const out: string[] = [];
    for (let d = first; d <= last; d = ymdAdd(d, 1)) out.push(d);
    return out;
  }, [today, lastDay]);

  const dayRows = grid.get(day) ?? [];
  const times = useMemo(() => {
    const set = new Set<number>();
    dayRows.forEach((r) => r.slots.forEach((s) => set.add(s.start)));
    return [...set].sort((a, b) => a - b);
  }, [dayRows]);
  const daySum = summary(day);
  const money = (v: number) => fmtMoney(v, settings.currency).replace(/\.00$/, '');
  const range = rateRange(sportCourts, rates);
  const dayClosure = sportClosure(closures, sportCourts, day);
  const prices = priceGroups(sportCourts, rates, dayTypeOf(day));

  const book = (courtId: number, start: number) =>
    navigate(`/book?sport=${sport}&date=${day}&court=${courtId}&start=${start}`);

  return (
    <div className="page cal-page">
      <div className="title-row">
        <div>
          <h1 className="page-title">Court availability</h1>
          <p className="muted small">Open dates and times for the next month · Philippine time{range ? ` · ${range.min === range.max ? money(range.min) : `${money(range.min)}–${money(range.max)}`} per hour` : ''}</p>
        </div>
        <div className="chip-row" role="group" aria-label="Sport">
          {SPORTS.map((s) => (
            <button key={s} type="button" className={`chip${sport === s ? ' is-active' : ''}`} aria-pressed={sport === s} onClick={() => setSport(s)}>
              <Icon name={s} size={16} /> {SPORT_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {error && <Notice kind="error">Availability could not be loaded. {error}</Notice>}
      {(loading || (busy === null && !error)) && <Spinner label="Loading availability…" />}

      {busy !== null && (
        <div className="cal-layout">
          <section className="card cal-card" aria-label="Choose a day">
            <div className="cal-head">
              <h2>{fmtMonth(today)}{fmtMonth(lastDay) !== fmtMonth(today) ? ` – ${fmtMonth(lastDay)}` : ''}</h2>
            </div>
            <div className="cal-grid" role="grid">
              {WEEKDAYS.map((w) => <span key={w} className="cal-wd" role="columnheader">{w}</span>)}
              {cells.map((d) => {
                const inRange = d >= today && d <= lastDay;
                if (!inRange) return <span key={d} className="cal-day is-out" aria-hidden="true">{dayOfMonth(d)}</span>;
                const s = summary(d);
                const k = sportClosure(closures, sportCourts, d);
                return (
                  <button key={d} type="button" role="gridcell" className={`cal-day lvl-${k ? `closure kind-${k.kind}` : s.level}${d === day ? ' is-active' : ''}${d === today ? ' is-today' : ''}`}
                    onClick={() => setDay(d)} aria-pressed={d === day} title={k ? `${CLOSURE_LABEL[k.kind]}: ${k.title}` : undefined}
                    aria-label={`${fmtDateLong(toUtcMs(d, 720))}: ${k ? `${CLOSURE_LABEL[k.kind]}, ${k.title}` : s.level === 'closed' ? 'closed' : s.open === 0 ? 'fully booked' : `${s.open} open hours`}`}>
                    <span className="cal-num">{dayOfMonth(d)}</span>
                    <span className="cal-meta">{k ? (k.kind === 'event' ? 'Event' : CLOSURE_LABEL[k.kind]) : s.level === 'closed' ? '—' : s.open === 0 ? 'Full' : `${Math.round((s.open * slotMin) / 60)}h`}</span>
                    <span className="cal-bar" style={{ width: `${s.total ? Math.max(8, (s.open / s.total) * 100) : 0}%` }} />
                  </button>
                );
              })}
            </div>
            <ul className="legend cal-legend">
              <li><i className="sw lvl-high" /> Plenty open</li>
              <li><i className="sw lvl-mid" /> Filling up</li>
              <li><i className="sw lvl-low" /> Few left</li>
              <li><i className="sw lvl-full" /> Full</li>
              {closures.length > 0 && <li><i className="sw lvl-closure" /> Closed / holiday / event</li>}
            </ul>
          </section>

          <section className="card day-card" aria-labelledby="day-h">
            <div className="card-head">
              <h2 id="day-h">{fmtWeekday(day)}, {fmtDateLong(toUtcMs(day, 720)).replace(/^\w+, /, '')}</h2>
              <span className={`badge ${daySum.open ? 'badge-ok' : 'badge-off'}`}>{dayClosure ? CLOSURE_LABEL[dayClosure.kind] : daySum.level === 'closed' ? 'Closed' : daySum.open ? `${Math.round((daySum.open * slotMin) / 60)} open hours` : 'Fully booked'}</span>
            </div>
            {dayClosure && (
              <div className={`closure-note kind-${dayClosure.kind}`}>
                <strong>{CLOSURE_LABEL[dayClosure.kind]}: {dayClosure.title}</strong>
                <span className="small">{dayClosure.note || 'Online booking is closed for this day. Message Yepjo for details.'}</span>
              </div>
            )}
            {prices.length > 0 && !dayClosure && (
              <div className="price-list" aria-label="Prices for this day">
                {prices.map((g) => (
                  <p key={g.key} className="small">
                    {prices.length > 1 && <strong>{g.courts}: </strong>}
                    {g.sets.map((x, i) => (
                      <span key={i} className="price-set">{x.label} <b>{money(x.rate)}</b></span>
                    ))}
                    <span className="muted tiny"> / hour</span>
                  </p>
                ))}
              </div>
            )}
            {times.length === 0 ? (
              !dayClosure && <p className="muted small">The courts are closed on this day.</p>
            ) : (
              <>
                <p className="muted tiny">Tap an open hour to book it.</p>
                <div className="board-scroll">
                  <table className="board">
                    <thead>
                      <tr>
                        <th scope="col" className="board-court">Court</th>
                        {times.map((t) => (
                          <th key={t} scope="col" className={ymdOf(t) !== day ? 'is-next' : ''}>{hourLabel(t)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dayRows.map((r) => {
                        const c = sportCourts.find((x) => x.id === r.courtId);
                        return (
                          <tr key={r.courtId}>
                            <th scope="row" className="board-court">{c?.name}{(() => { const k = closureFor(closures, r.courtId, day); return k && !dayClosure ? <small className="board-closure">{CLOSURE_LABEL[k.kind]}</small> : null; })()}</th>
                            {times.map((t) => {
                              const s = r.slots.find((x) => x.start === t);
                              if (!s) return <td key={t} className="cell cell-closed" />;
                              const label = `${c?.name} ${fmtTime(s.start)}: ${s.state === 'available' ? 'open' : s.state}`;
                              return (
                                <td key={t} className={`cell cell-${s.state}`}>
                                  {s.state === 'available'
                                    ? <button type="button" onClick={() => book(r.courtId, s.start)} aria-label={`Book ${label}`} title={`Book ${fmtTime(s.start)}`} />
                                    : <span aria-label={label} title={label} />}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <ul className="legend">
                  <li><i className="sw sw-available" /> Open</li>
                  <li><i className="sw sw-booked" /> Booked</li>
                  <li><i className="sw sw-blocked" /> Blocked</li>
                  <li><i className="sw sw-past" /> Past</li>
                </ul>
                {times.some((t) => ymdOf(t) !== day) && <p className="tiny muted">Hours after midnight belong to this day's session.</p>}
              </>
            )}
            <Link to={`/book?sport=${sport}`} className="btn btn-primary btn-block"><Icon name="calendar" size={18} /> Book a court</Link>
          </section>
        </div>
      )}
    </div>
  );
}

/** Group courts that share the same time sets for a day type, e.g. "Courts 1–4: 7 AM–3 PM ₱250 · 3 PM–1 AM ₱350". */
function priceGroups(courtList: Court[], rates: CourtRate[], type: 'weekday' | 'weekend') {
  const groups = new Map<string, { key: string; names: string[]; sets: { label: string; rate: number }[] }>();
  for (const c of courtList) {
    const own = rates.filter((r) => r.court_id === c.id && r.day_type === type).sort((a, b) => a.starts.localeCompare(b.starts));
    const sets = own.length
      ? own.map((r) => ({ label: `${fmtClock(r.starts)}–${fmtClock(r.ends)}`, rate: Number(r.rate) }))
      : c.hourly_rate != null ? [{ label: 'All day', rate: Number(c.hourly_rate) }] : [];
    if (!sets.length) continue;
    const key = sets.map((x) => `${x.label}=${x.rate}`).join('|');
    const g = groups.get(key) ?? { key, names: [], sets };
    g.names.push(c.name);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, courts: g.names.join(', ') }));
}
