import { useCallback, useEffect, useMemo, useState } from 'react';
import { GoogleButton, Icon, Notice, Spinner, useOnline, useToast } from '../components/ui';
import { Link, navigate, useLocation } from '../lib/router';
import { supabase, toAppError, type AppError } from '../lib/supabase';
import {
  DAY_MS, buildSlots, courtWindow, dayOfMonth, fmtDateLong, fmtDateShort, fmtDuration, fmtMoney, fmtMonth, fmtTime,
  fmtWeekday, runLength, toUtcMs, todayYmd, ymdAdd, ymdAddMonth, ymdOf, type Slot,
} from '../lib/time';
import { SPORTS, SPORT_LABEL, type Busy, type Court, type Reservation, type Sport } from '../lib/types';
import { RETURN_KEY, useAuth } from '../state/auth';
import { useSite } from '../state/site';

const PENDING_KEY = 'yepjo:pending-booking';
const STEPS = ['Sport', 'Date', 'Court', 'Time', 'Review'];

interface Pending {
  sport: Sport;
  date: string;
  courtId: number;
  start: number;
  minutes: number;
}

// The selection survives the trip to Google and back (and profile completion).
function readPending(): Pending | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Pending;
    const valid = SPORTS.includes(p.sport) && /^\d{4}-\d{2}-\d{2}$/.test(p.date)
      && Number.isFinite(p.courtId) && Number.isFinite(p.start) && Number.isFinite(p.minutes) && p.start > Date.now();
    return valid ? p : null;
  } catch {
    return null;
  }
}

export default function Book() {
  const { settings, courts, hours, pulse, loading, error: siteError, reload } = useSite();
  const auth = useAuth();
  const online = useOnline();
  const toast = useToast();
  const { query } = useLocation();

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const restored = useMemo(readPending, []);
  useEffect(() => {
    try {
      localStorage.removeItem(PENDING_KEY);   // restored once; never left behind
    } catch {
      /* ignore */
    }
  }, []);
  const qsSport = SPORTS.find((s) => s === query.get('sport')) ?? null;
  const [sport, setSport] = useState<Sport | null>(restored?.sport ?? qsSport);
  const [date, setDate] = useState<string | null>(restored?.date ?? null);
  const [courtId, setCourtId] = useState<number | null>(restored?.courtId ?? null);
  const [start, setStart] = useState<number | null>(restored?.start ?? null);
  const [minutes, setMinutes] = useState(restored?.minutes ?? 0);
  const [step, setStep] = useState(restored ? 5 : qsSport ? 2 : 1);

  const [avail, setAvail] = useState<{ date: string; busy: Busy[] } | null>(null);
  const [availError, setAvailError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Reservation | null>(null);

  const slotMin = settings.slot_minutes;
  const slotMs = slotMin * 60_000;
  const today = todayYmd(now);
  const lastDay = ymdAddMonth(today);
  const sportCourts = useMemo(() => courts.filter((c) => c.is_active && c.sport === sport), [courts, sport]);
  const court: Court | null = sportCourts.find((c) => c.id === courtId) ?? null;

  // Today → one calendar month ahead. Last night's session is offered too while it is still running.
  const dates = useMemo(() => {
    const list: string[] = [];
    const yesterday = ymdAdd(today, -1);
    const lateSession = sportCourts.some((c) => {
      const w = courtWindow(hours, c.id, yesterday);
      return w !== null && w.end - slotMs > now;
    });
    if (lateSession) list.push(yesterday);
    for (let d = today; d <= lastDay; d = ymdAdd(d, 1)) list.push(d);
    return list;
  }, [today, lastDay, sportCourts, hours, slotMs, now]);

  const loadBusy = useCallback(async (d: string): Promise<Busy[]> => {
    const from = toUtcMs(d);
    const { data, error: err } = await supabase.rpc('get_availability', {
      p_from: new Date(from).toISOString(),
      p_to: new Date(from + 2 * DAY_MS).toISOString(),
    });
    if (err) throw toAppError(err);
    return (data as Busy[]) ?? [];
  }, []);

  // Live availability: refetched on date change, on every server "pulse", and on demand.
  useEffect(() => {
    if (!date) return;
    let alive = true;
    loadBusy(date)
      .then((busy) => {
        if (!alive) return;
        setAvail({ date, busy });
        setAvailError(null);
      })
      .catch((e: AppError) => alive && setAvailError(e.message));
    return () => {
      alive = false;
    };
  }, [date, pulse, reloadKey, loadBusy]);

  const availReady = avail !== null && avail.date === date;
  const slotsFor = useCallback(
    (id: number): Slot[] => (date && availReady ? buildSlots(courtWindow(hours, id, date), slotMin, avail!.busy, id, now) : []),
    [date, availReady, avail, hours, slotMin, now],
  );
  const slots = useMemo(() => (court ? slotsFor(court.id) : []), [court, slotsFor]);
  const startIndex = start === null ? -1 : slots.findIndex((s) => s.start === start);
  const count = Math.round(minutes / slotMin);
  const maxRun = startIndex >= 0 ? runLength(slots, startIndex) : 0;
  const selectionOk = startIndex >= 0 && count >= settings.min_slots && count <= settings.max_slots && maxRun >= count;
  const end = start !== null ? start + minutes * 60_000 : null;

  // If the chosen time stops being available (someone else booked it, it passed, an admin
  // blocked it), send the user back to the time step with an explanation.
  useEffect(() => {
    if (done || submitting || !availReady || loading || step !== 5) return;
    if (!court || !selectionOk) {
      setStart(null);
      setStep(court ? 4 : sport ? (date ? 3 : 2) : 1);
      setError('That time is no longer available. Please choose another slot.');
    }
  }, [done, submitting, availReady, loading, step, court, selectionOk, sport, date]);

  const pickSport = (s: Sport) => {
    if (s !== sport) {
      setCourtId(null);
      setStart(null);
    }
    setSport(s);
    setError(null);
    setStep(2);
  };
  const pickDate = (d: string) => {
    if (d !== date) setStart(null);
    setDate(d);
    setError(null);
    setStep(3);
  };
  const pickCourt = (id: number) => {
    if (id !== courtId) setStart(null);
    setCourtId(id);
    setError(null);
    setStep(4);
  };
  const pickSlot = (i: number) => {
    if (slots[i].state !== 'available') return;
    if (runLength(slots, i) < settings.min_slots) {
      toast(`The minimum booking is ${fmtDuration(settings.min_slots * slotMin)}; there isn't enough free time from ${fmtTime(slots[i].start)}.`, 'error');
      return;
    }
    setError(null);
    setStart(slots[i].start);
    setMinutes(settings.min_slots * slotMin);
  };

  const savePending = () => {
    if (!sport || !date || !court || start === null) return;
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({ sport, date, courtId: court.id, start, minutes } satisfies Pending));
    } catch {
      /* ignore */
    }
  };

  const signIn = async () => {
    savePending();
    setSigningIn(true);
    const problem = await auth.signIn('/book');
    if (problem) {
      setSigningIn(false);
      setError(`Google sign-in could not start: ${problem}`);
    }
  };
  const completeProfile = () => {
    savePending();
    try {
      localStorage.setItem(RETURN_KEY, '/book');
    } catch {
      /* ignore */
    }
    navigate('/welcome');
  };

  const confirm = async () => {
    if (!court || !date || start === null || end === null) return;
    setSubmitting(true);
    setError(null);
    try {
      // Re-check availability right before confirming…
      const fresh = await loadBusy(date);
      setAvail({ date, busy: fresh });
      const clash = fresh.some((b) => b.court_id === court.id && new Date(b.starts_at).getTime() < end && new Date(b.ends_at).getTime() > start);
      if (clash) throw { code: 'SLOT_TAKEN', message: 'Sorry, that time has just been taken. Please choose another slot.' } satisfies AppError;
      // …and let the database make the final, atomic decision.
      const { data, error: err } = await supabase.rpc('book_court', {
        p_court_id: court.id, p_starts_at: new Date(start).toISOString(), p_minutes: minutes,
      });
      if (err) throw toAppError(err);
      const saved = data as Reservation | null;
      if (!saved?.reference) {
        throw { code: 'UNKNOWN', message: 'We could not confirm that the booking was saved. Please check My Bookings before trying again.' } satisfies AppError;
      }
      setDone(saved);                 // success is shown only once the reservation exists
      setReloadKey((k) => k + 1);
    } catch (e) {
      const err = e && typeof e === 'object' && 'code' in e ? (e as AppError) : toAppError(e);
      setError(err.message);
      if (['SLOT_TAKEN', 'PAST_TIME', 'OUTSIDE_HOURS', 'INVALID_DURATION'].includes(err.code)) {
        setStart(null);
        setStep(4);
        setReloadKey((k) => k + 1);
      } else if (err.code === 'OUTSIDE_WINDOW') {
        setStart(null);
        setStep(2);
      } else if (err.code === 'COURT_UNAVAILABLE') {
        setCourtId(null);
        setStart(null);
        setStep(3);
        void reload();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const bookAnother = () => {
    setDone(null);
    setStart(null);
    setError(null);
    setStep(sport ? 2 : 1);
  };

  if (loading) return <div className="page"><Spinner label="Loading courts…" /></div>;
  if (siteError && courts.length === 0) {
    return (
      <div className="page page-narrow">
        <Notice kind="error" action={<button type="button" className="btn btn-sm" onClick={() => void reload()}>Retry</button>}>
          Court information could not be loaded. {siteError}
        </Notice>
      </div>
    );
  }

  // ------------------------------------------------------------ success
  if (done) {
    const c = courts.find((x) => x.id === done.court_id);
    return (
      <div className="page page-narrow">
        <div className="card success-card" role="status">
          <span className="success-mark"><Icon name="check" size={30} /></span>
          <h1>Booking confirmed</h1>
          <p className="muted small">Show this reference at the court.</p>
          <p className="reference" aria-label={`Booking reference ${done.reference}`}>{done.reference}</p>
          <dl className="facts">
            <div><dt>Sport</dt><dd>{c ? SPORT_LABEL[c.sport] : ''}</dd></div>
            <div><dt>Court</dt><dd>{c?.name}</dd></div>
            <div><dt>Date</dt><dd>{fmtDateLong(done.starts_at)}</dd></div>
            <div><dt>Starts</dt><dd>{fmtTime(done.starts_at)}</dd></div>
            <div><dt>Ends</dt><dd>{fmtTime(done.ends_at)}{ymdOf(new Date(done.starts_at).getTime()) !== ymdOf(new Date(done.ends_at).getTime()) ? `, ${fmtDateLong(done.ends_at)}` : ''}</dd></div>
          </dl>
          <div className="btn-row">
            <Link to="/bookings" className="btn btn-primary">View my bookings</Link>
            <button type="button" className="btn btn-ghost" onClick={bookAnother}>Book another</button>
          </div>
        </div>
      </div>
    );
  }

  const reached = !sport ? 1 : !date ? 2 : !court ? 3 : !selectionOk ? 4 : 5;
  const nextDaySlots = date ? slots.filter((s) => ymdOf(s.start) !== date) : [];
  const sameDaySlots = date ? slots.filter((s) => ymdOf(s.start) === date) : [];
  const endsNextDay = start !== null && end !== null && ymdOf(start) !== ymdOf(end);
  const amount = court?.hourly_rate != null ? (court.hourly_rate * minutes) / 60 : null;

  const slotButton = (s: Slot) => {
    const i = slots.indexOf(s);
    const selected = startIndex >= 0 && i >= startIndex && i < startIndex + count;
    const label = `${fmtTime(s.start)} to ${fmtTime(s.end)}, ${selected ? 'selected' : s.state === 'past' ? 'no longer available' : s.state}`;
    return (
      <button key={s.start} type="button" className={`slot slot-${s.state}${selected ? ' is-selected' : ''}`}
        disabled={s.state !== 'available'} aria-pressed={selected} aria-label={label} onClick={() => pickSlot(i)}>
        <span>{fmtTime(s.start)}</span>
        <small>{selected ? 'Selected' : s.state === 'available' ? 'Open' : s.state === 'past' ? 'Past' : s.state === 'booked' ? 'Booked' : 'Blocked'}</small>
      </button>
    );
  };

  return (
    <div className="page book">
      <h1 className="page-title">Book a court</h1>

      <ol className="stepper" aria-label="Booking steps">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const state = n === step ? 'is-current' : n < step ? 'is-done' : '';
          return (
            <li key={label}>
              <button type="button" className={`step ${state}`} disabled={n > reached} onClick={() => setStep(n)} aria-current={n === step ? 'step' : undefined}>
                <span className="step-num">{n < step ? <Icon name="check" size={14} /> : n}</span>
                <span className="step-label">{label}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {error && <Notice kind="error">{error}</Notice>}
      {!online && <Notice kind="warn">You're offline. Live availability and booking need a connection.</Notice>}

      {/* ---------------------------------------------------------- 1. sport */}
      {step === 1 && (
        <section className="card" aria-labelledby="s1">
          <h2 id="s1">Choose a sport</h2>
          <div className="sport-row">
            {SPORTS.map((s) => {
              const n = courts.filter((c) => c.sport === s && c.is_active).length;
              return (
                <button key={s} type="button" className={`sport-card sport-${s}${sport === s ? ' is-active' : ''}`} onClick={() => pickSport(s)} disabled={n === 0}>
                  <span className="sport-icon"><Icon name={s} size={28} /></span>
                  <span className="sport-name">{SPORT_LABEL[s]}</span>
                  <span className="sport-meta">{n ? `${n} court${n > 1 ? 's' : ''}` : 'Not available'} <Icon name="right" size={16} /></span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* ---------------------------------------------------------- 2. date */}
      {step === 2 && sport && (
        <section className="card" aria-labelledby="s2">
          <h2 id="s2">Choose a date</h2>
          <p className="muted small">Bookings are open from today until {fmtDateLong(toUtcMs(lastDay, 720))} (Philippine time).</p>
          <div className="date-strip" role="group" aria-label="Available dates">
            {dates.map((d, i) => (
              <button key={d} type="button" className={`date-chip${date === d ? ' is-active' : ''}`} onClick={() => pickDate(d)}
                aria-pressed={date === d} aria-label={fmtDateLong(toUtcMs(d, 720))}>
                <small>{d === today ? 'Today' : d < today ? 'Tonight' : fmtWeekday(d)}</small>
                <strong>{dayOfMonth(d)}</strong>
                <small>{i === 0 || dayOfMonth(d) === 1 || d === today ? fmtMonth(d) : ' '}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ---------------------------------------------------------- 3. court */}
      {step === 3 && sport && date && (
        <section className="card" aria-labelledby="s3">
          <h2 id="s3">Choose a court</h2>
          <p className="muted small">{SPORT_LABEL[sport]} · {fmtDateLong(toUtcMs(date, 720))}</p>
          {availError && <Notice kind="error" action={<button type="button" className="btn btn-sm" onClick={() => setReloadKey((k) => k + 1)}>Retry</button>}>Availability could not be loaded. {availError}</Notice>}
          {!availReady && !availError && <Spinner label="Checking availability…" />}
          {availReady && (
            <div className="court-grid">
              {sportCourts.map((c) => {
                const list = slotsFor(c.id);
                const open = list.filter((s) => s.state === 'available').length;
                return (
                  <button key={c.id} type="button" className={`court-card${courtId === c.id ? ' is-active' : ''}`} onClick={() => pickCourt(c.id)} disabled={open === 0}>
                    <span className="court-name"><Icon name="court" size={18} /> {c.name}</span>
                    <span className={`small ${open ? 'ok-text' : 'muted'}`}>
                      {list.length === 0 ? 'Closed this day' : open === 0 ? 'Fully booked' : `${open} of ${list.length} slots open`}
                    </span>
                    {c.hourly_rate != null && <span className="muted tiny">{fmtMoney(c.hourly_rate, settings.currency)} / hour</span>}
                  </button>
                );
              })}
              {sportCourts.length === 0 && <p className="muted">No courts are available for this sport.</p>}
            </div>
          )}
        </section>
      )}

      {/* ---------------------------------------------------------- 4. time */}
      {step === 4 && sport && date && court && (
        <section className="card" aria-labelledby="s4">
          <h2 id="s4">Select time and duration</h2>
          <p className="muted small">{SPORT_LABEL[sport]} · {court.name} · {fmtDateLong(toUtcMs(date, 720))}</p>
          {availError && <Notice kind="error" action={<button type="button" className="btn btn-sm" onClick={() => setReloadKey((k) => k + 1)}>Retry</button>}>Availability could not be loaded. {availError}</Notice>}
          {!availReady && !availError && <Spinner label="Checking availability…" />}
          {availReady && slots.length === 0 && <p className="muted">This court is closed on this day. Choose another date.</p>}
          {availReady && slots.length > 0 && (
            <>
              <ul className="legend" aria-label="Legend">
                <li><i className="sw sw-available" /> Available</li>
                <li><i className="sw sw-selected" /> Selected</li>
                <li><i className="sw sw-booked" /> Booked</li>
                <li><i className="sw sw-blocked" /> Blocked</li>
              </ul>
              <div className="slot-grid">{sameDaySlots.map(slotButton)}</div>
              {nextDaySlots.length > 0 && (
                <>
                  <h3 className="slot-divider">After midnight · {fmtDateShort(nextDaySlots[0].start)}</h3>
                  <div className="slot-grid">{nextDaySlots.map(slotButton)}</div>
                </>
              )}

              {startIndex >= 0 && (
                <div className="duration" role="group" aria-label="Duration">
                  <span className="field-label">Duration</span>
                  <div className="chip-row">
                    {Array.from({ length: settings.max_slots - settings.min_slots + 1 }, (_, k) => settings.min_slots + k).map((n) => (
                      <button key={n} type="button" className={`chip${count === n ? ' is-active' : ''}`} disabled={n > maxRun}
                        aria-pressed={count === n} onClick={() => setMinutes(n * slotMin)}
                        title={n > maxRun ? 'The following slot is not available' : undefined}>
                        {fmtDuration(n * slotMin)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          <div className="step-bar">
            <p className="small">
              {selectionOk && start !== null && end !== null
                ? <><strong>{fmtTime(start)} – {fmtTime(end)}</strong>{endsNextDay ? ` (ends ${fmtDateShort(end)})` : ''} · {fmtDuration(minutes)}</>
                : <span className="muted">Tap an available start time.</span>}
            </p>
            <button type="button" className="btn btn-primary" disabled={!selectionOk} onClick={() => setStep(5)}>Review</button>
          </div>
        </section>
      )}

      {/* ---------------------------------------------------------- 5. review */}
      {step === 5 && sport && date && court && start !== null && end !== null && (
        <section className="card" aria-labelledby="s5">
          <h2 id="s5">Review your booking</h2>
          <dl className="facts">
            <div><dt>Sport</dt><dd>{SPORT_LABEL[sport]}</dd></div>
            <div><dt>Court</dt><dd>{court.name}</dd></div>
            <div><dt>Date</dt><dd>{fmtDateLong(start)}</dd></div>
            <div><dt>Start time</dt><dd>{fmtTime(start)}</dd></div>
            <div><dt>End time</dt><dd>{fmtTime(end)}{endsNextDay && <> <span className="badge">next day</span><br /><span className="small muted">{fmtDateLong(end)}</span></>}</dd></div>
            <div><dt>Duration</dt><dd>{fmtDuration(minutes)}</dd></div>
            {amount != null && <div><dt>Court fee</dt><dd>{fmtMoney(amount, settings.currency)} <span className="muted small">(pay at the court)</span></dd></div>}
          </dl>
          <p className="muted small policy">
            {settings.allow_cancellation
              ? `You can cancel in My Bookings up to ${settings.cancel_cutoff_hours} hour${settings.cancel_cutoff_hours === 1 ? '' : 's'} before the start time.`
              : 'Online cancellation is not available. Message Yepjo if your plans change.'}
            {settings.cancellation_note ? ` ${settings.cancellation_note}` : ''}
          </p>

          {!auth.ready ? <Spinner label="Checking your account…" />
            : !auth.user ? (
              <div className="gate">
                <p className="small">Sign in with Google to confirm. Your selection is kept.</p>
                <GoogleButton onClick={() => void signIn()} busy={signingIn} label="Sign in with Google to confirm" />
              </div>
            ) : !auth.profileComplete ? (
              <div className="gate">
                <p className="small">Add your name and contact number to confirm. Your selection is kept.</p>
                <button type="button" className="btn btn-primary btn-block" onClick={completeProfile}>Complete profile</button>
              </div>
            ) : (
              <div className="btn-row">
                <button type="button" className="btn btn-ghost" onClick={() => setStep(4)} disabled={submitting}>Change time</button>
                <button type="button" className="btn btn-primary" onClick={() => void confirm()} disabled={submitting || !online || !selectionOk}>
                  {submitting ? 'Confirming…' : 'Confirm booking'}
                </button>
              </div>
            )}
        </section>
      )}

      {step > 1 && (
        <button type="button" className="link-btn back-link" onClick={() => setStep(step - 1)}>
          <Icon name="left" size={16} /> Back
        </button>
      )}
    </div>
  );
}
