import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Confirm, Field, Icon, Modal, Notice, Toggle, useToast } from '../components/ui';
import { Link } from '../lib/router';
import { supabase, toAppError } from '../lib/supabase';
import { WEEKDAYS, fmtDateLong, fmtDateShort, fmtMoney, fmtTime, toUtcMs, todayYmd, ymdAdd } from '../lib/time';
import {
  CLOSURE_LABEL, SPORTS, SPORT_LABEL, type Closure, type ClosureKind, type Court, type CourtHours, type CourtRate,
  type DayType, type Sport,
} from '../lib/types';
import { fmtClock } from '../lib/pricing';
import { useSite } from '../state/site';

type DayRow = Pick<CourtHours, 'dow' | 'opens' | 'closes' | 'is_closed'>;
const hhmm = (t: string) => t.slice(0, 5);

function summarise(rows: CourtHours[]): string {
  if (rows.length === 0) return 'No hours set';
  const open = rows.filter((r) => !r.is_closed);
  if (open.length === 0) return 'Closed every day';
  const same = open.every((r) => r.opens === open[0].opens && r.closes === open[0].closes);
  const range = `${hhmm(open[0].opens)}–${hhmm(open[0].closes)}`;
  return same ? `${open.length === 7 ? 'Daily' : `${open.length} days`} ${range}` : 'Hours vary by day';
}

export default function Courts() {
  const { courts, hours, settings, reload } = useSite();
  const toast = useToast();
  const [editing, setEditing] = useState<Court | null>(null);
  const [adding, setAdding] = useState<Sport | null>(null);
  const [removing, setRemoving] = useState<Court | null>(null);
  const [pricing, setPricing] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { rates } = useSite();
  const money = (v: number) => fmtMoney(v, settings.currency).replace(/\.00$/, '');
  const priceSummary = (c: Court) => {
    const own = rates.filter((r) => r.court_id === c.id);
    if (!own.length) return c.hourly_rate != null ? `${money(Number(c.hourly_rate))}/hr` : 'No price set';
    const part = (t: DayType, label: string) => {
      const v = own.filter((r) => r.day_type === t).map((r) => Number(r.rate));
      if (!v.length) return null;
      const lo = Math.min(...v), hi = Math.max(...v);
      return `${label} ${lo === hi ? money(lo) : `${money(lo)}–${money(hi)}`}`;
    };
    return [part('weekday', 'Mon–Fri'), part('weekend', 'Sat–Sun')].filter(Boolean).join(' · ') + '/hr';
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const { error } = await supabase.from('courts').delete().eq('id', removing.id);
    setBusy(false);
    if (error) {
      const e = toAppError(error);
      toast(e.code === 'IN_USE' ? 'This court has reservations in its history, so it cannot be deleted. Switch it to inactive instead.' : e.message, 'error');
    } else {
      toast(`${removing.name} was removed.`);
    }
    setRemoving(null);
    void reload();
  };

  return (
    <div className="stack">
      <div className="report-head">
        <h1 className="page-title">Courts &amp; schedules</h1>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setPricing(courts.map((c) => c.id))}>
          <Icon name="edit" size={16} /> Set prices
        </button>
      </div>
      {(!settings.hours_confirmed || !settings.rates_confirmed) && (
        <Notice kind="warn">
          <strong>Needs business input.</strong> Hours start as a placeholder (12:00 noon – 1:00 AM daily, from the sample availability) and rates are empty.
          Set them here, then tick them off under <Link to="/admin/settings" className="link">Settings → Confirmations</Link>.
        </Notice>
      )}

      {SPORTS.map((sport) => (
        <section key={sport} className="card" aria-labelledby={`c-${sport}`}>
          <div className="card-head">
            <h2 id={`c-${sport}`}>{SPORT_LABEL[sport]}</h2>
            <button type="button" className="btn btn-sm btn-outline" onClick={() => setAdding(sport)}><Icon name="plus" size={16} /> Add court</button>
          </div>
          <ul className="rows">
            {courts.filter((c) => c.sport === sport).map((c) => (
              <li key={c.id} className="row">
                <span className="row-main">
                  <strong>{c.name} {!c.is_active && <span className="badge badge-off">Inactive</span>}</strong>
                  <span className="small muted">
                    {summarise(hours.filter((h) => h.court_id === c.id))} · {priceSummary(c)}
                  </span>
                </span>
                <span className="row-actions">
                  <button type="button" className="btn btn-sm" onClick={() => setPricing([c.id])}>₱ Prices</button>
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(c)}><Icon name="edit" size={16} /> Edit</button>
                  <button type="button" className="icon-btn" onClick={() => setRemoving(c)} aria-label={`Delete ${c.name}`}><Icon name="trash" size={18} /></button>
                </span>
              </li>
            ))}
            {courts.filter((c) => c.sport === sport).length === 0 && <li className="muted small">No courts yet.</li>}
          </ul>
        </section>
      ))}

      <Closures />

      {editing && <CourtDialog court={editing} onClose={() => setEditing(null)} />}
      {pricing && <RatesDialog courtIds={pricing} onClose={() => setPricing(null)} />}
      {adding && <CourtDialog sport={adding} onClose={() => setAdding(null)} />}
      {removing && (
        <Confirm title={`Delete ${removing.name}?`} danger busy={busy} confirmLabel="Delete court" onConfirm={() => void remove()} onClose={() => setRemoving(null)}>
          <p>Courts with any reservation history cannot be deleted; make them inactive instead so they can no longer be booked.</p>
        </Confirm>
      )}
    </div>
  );
}

function CourtDialog({ court, sport, onClose }: { court?: Court; sport?: Sport; onClose: () => void }) {
  const { courts, hours, reload } = useSite();
  const toast = useToast();
  const theSport = court?.sport ?? sport!;
  const siblings = courts.filter((c) => c.sport === theSport);
  const [name, setName] = useState(court?.name ?? `Court ${siblings.length + 1}`);
  const [active, setActive] = useState(court?.is_active ?? true);
  const [rate, setRate] = useState(court?.hourly_rate != null ? String(court.hourly_rate) : '');
  const [order, setOrder] = useState(String(court?.sort_order ?? siblings.length + 1));
  const [applyAll, setApplyAll] = useState(false);
  const [days, setDays] = useState<DayRow[]>(() =>
    Array.from({ length: 7 }, (_, dow) => {
      const h = court ? hours.find((x) => x.court_id === court.id && x.dow === dow) : undefined;
      return { dow, opens: hhmm(h?.opens ?? '07:00'), closes: hhmm(h?.closes ?? '01:00'), is_closed: h?.is_closed ?? false };
    }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setDay = (dow: number, patch: Partial<DayRow>) => setDays((list) => list.map((d) => (d.dow === dow ? { ...d, ...patch } : d)));
  const copyToAll = (from: DayRow) => setDays((list) => list.map((d) => ({ ...d, opens: from.opens, closes: from.closes, is_closed: from.is_closed })));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const rateValue = rate.trim() === '' ? null : Number(rate);
    if (!name.trim()) return setError('Enter a court name.');
    if (rateValue !== null && (!Number.isFinite(rateValue) || rateValue < 0)) return setError('Enter a valid hourly rate, or leave it empty.');
    setBusy(true);
    try {
      const payload = { name: name.trim(), is_active: active, hourly_rate: rateValue, sort_order: Number(order) || 0 };
      let id = court?.id;
      if (court) {
        const { error: err } = await supabase.from('courts').update(payload).eq('id', court.id);
        if (err) throw err;
      } else {
        const { data, error: err } = await supabase.from('courts').insert({ ...payload, sport: theSport }).select('id').single();
        if (err) throw err;
        id = (data as { id: number }).id;
      }
      const targets = applyAll ? [...new Set([id!, ...siblings.map((c) => c.id)])] : [id!];
      const rows = targets.flatMap((court_id) => days.map((d) => ({ court_id, ...d })));
      const { error: hErr } = await supabase.from('court_hours').upsert(rows, { onConflict: 'court_id,dow' });
      if (hErr) throw hErr;
      toast(court ? 'Court updated.' : 'Court added.');
      await reload();
      onClose();
    } catch (err) {
      setError(toAppError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={court ? `Edit ${SPORT_LABEL[theSport]} · ${court.name}` : `Add ${SPORT_LABEL[theSport].toLowerCase()} court`} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="form-2">
          <Field label="Court name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required /></Field>
          <Field label="Default hourly rate" hint="Used for any hour not covered by this court's time-based prices (₱ Prices).">
            <input type="number" inputMode="decimal" min={0} step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="e.g. 300" />
          </Field>
        </div>
        <div className="form-2">
          <Field label="Display order"><input type="number" value={order} onChange={(e) => setOrder(e.target.value)} /></Field>
          <div className="field"><span className="field-label">Availability</span><Toggle checked={active} onChange={setActive} label={active ? 'Bookable' : 'Inactive (hidden from booking)'} /></div>
        </div>

        <fieldset className="fieldset">
          <legend className="field-label">Operating hours (Philippine time)</legend>
          <p className="muted small">A closing time earlier than the opening time means the session ends after midnight, e.g. 12:00 → 01:00.</p>
          <div className="hours">
            {days.map((d) => (
              <div key={d.dow} className="hours-row">
                <span className="hours-day">{WEEKDAYS[d.dow].slice(0, 3)}</span>
                <input type="time" value={d.opens} disabled={d.is_closed} onChange={(e) => setDay(d.dow, { opens: e.target.value })} aria-label={`${WEEKDAYS[d.dow]} opens`} required />
                <input type="time" value={d.closes} disabled={d.is_closed} onChange={(e) => setDay(d.dow, { closes: e.target.value })} aria-label={`${WEEKDAYS[d.dow]} closes`} required />
                <label className="check"><input type="checkbox" checked={d.is_closed} onChange={(e) => setDay(d.dow, { is_closed: e.target.checked })} /> <span>Closed</span></label>
                <button type="button" className="link-btn tiny" onClick={() => copyToAll(d)}>Copy to all days</button>
              </div>
            ))}
          </div>
          <label className="check"><input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} /> <span>Apply these hours to every {SPORT_LABEL[theSport].toLowerCase()} court</span></label>
        </fieldset>

        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Saving…' : 'Save court'}</button>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Time-based prices
// ---------------------------------------------------------------------------

interface SetRow { starts: string; ends: string; rate: string }
const DAY_TYPES: { key: DayType; label: string; hint: string }[] = [
  { key: 'weekday', label: 'Monday – Friday', hint: 'Weekday prices' },
  { key: 'weekend', label: 'Saturday & Sunday', hint: 'Weekend prices' },
];
const MAX_SETS = 3;

function toRows(rates: CourtRate[], courtId: number | undefined, t: DayType): SetRow[] {
  return rates
    .filter((r) => r.court_id === courtId && r.day_type === t)
    .sort((a, b) => a.starts.localeCompare(b.starts))
    .map((r) => ({ starts: hhmm(r.starts), ends: hhmm(r.ends), rate: String(Number(r.rate)) }));
}

function RatesDialog({ courtIds, onClose }: { courtIds: number[]; onClose: () => void }) {
  const { courts, rates, settings, reload } = useSite();
  const toast = useToast();
  const [picked, setPicked] = useState<number[]>(courtIds);
  const seed = courtIds[0];
  const [sets, setSets] = useState<Record<DayType, SetRow[]>>(() => {
    const wd = toRows(rates, seed, 'weekday');
    const we = toRows(rates, seed, 'weekend');
    return {
      weekday: wd.length ? wd : [{ starts: '07:00', ends: '15:00', rate: '' }, { starts: '15:00', ends: '01:00', rate: '' }],
      weekend: we.length ? we : [{ starts: '07:00', ends: '01:00', rate: '' }],
    };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const single = courtIds.length === 1 ? courts.find((c) => c.id === courtIds[0]) : null;

  const setRow = (t: DayType, i: number, patch: Partial<SetRow>) =>
    setSets((all) => ({ ...all, [t]: all[t].map((r, k) => (k === i ? { ...r, ...patch } : r)) }));
  const addRow = (t: DayType) =>
    setSets((all) => {
      const last = all[t][all[t].length - 1];
      return { ...all, [t]: [...all[t], { starts: last?.ends ?? '07:00', ends: '01:00', rate: '' }] };
    });
  const removeRow = (t: DayType, i: number) => setSets((all) => ({ ...all, [t]: all[t].filter((_, k) => k !== i) }));
  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const pickGroup = (ids: number[]) => setPicked(ids);

  const save = async () => {
    setError(null);
    if (!picked.length) return setError('Choose at least one court.');
    const payload: { day_type: DayType; starts: string; ends: string; rate: number }[] = [];
    for (const t of ['weekday', 'weekend'] as DayType[]) {
      for (const r of sets[t]) {
        const rate = Number(r.rate);
        if (r.rate.trim() === '' || !Number.isFinite(rate) || rate < 0) return setError(`Enter a price for every ${t === 'weekday' ? 'weekday' : 'weekend'} time set.`);
        if (!r.starts || !r.ends || r.starts === r.ends) return setError('Each time set needs a start and a different end time.');
        if (!/:(00|30)$/.test(r.starts) || !/:(00|30)$/.test(r.ends)) return setError('Use times on the hour or half hour (e.g. 3:00 PM or 3:30 PM).');
        payload.push({ day_type: t, starts: r.starts, ends: r.ends, rate });
      }
    }
    setBusy(true);
    const { error: err } = await supabase.rpc('admin_set_rates', { p_court_ids: picked, p_rates: payload });
    setBusy(false);
    if (err) return setError(toAppError(err).message);
    toast(`Prices saved for ${picked.length} court${picked.length === 1 ? '' : 's'}.`);
    await reload();
    onClose();
  };

  const bySport = (sp: Sport) => courts.filter((c) => c.sport === sp);
  return (
    <Modal title={single ? `Prices · ${SPORT_LABEL[single.sport]} ${single.name}` : 'Set prices'} onClose={onClose} wide
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : `Save prices${picked.length > 1 ? ` for ${picked.length} courts` : ''}`}</button>
      </>}>
      <div className="form">
        {error && <Notice kind="error">{error}</Notice>}
        <p className="muted small">
          Up to {MAX_SETS} time sets for weekdays and for weekends. A set can run past midnight (e.g. 3:00 PM → 1:00 AM);
          hours after midnight use the price of the day the session started. Any hour not covered uses the court's default rate.
        </p>

        {DAY_TYPES.map(({ key, label }) => (
          <fieldset key={key} className="fieldset rate-block">
            <legend className="field-label">{label}</legend>
            {sets[key].length === 0 && <p className="tiny muted">No time sets: the default hourly rate applies all day.</p>}
            {sets[key].map((r, i) => (
              <div key={i} className="rate-row">
                <input type="time" step={1800} value={r.starts} onChange={(e) => setRow(key, i, { starts: e.target.value })} aria-label={`${label} set ${i + 1} from`} />
                <span className="muted">to</span>
                <input type="time" step={1800} value={r.ends} onChange={(e) => setRow(key, i, { ends: e.target.value })} aria-label={`${label} set ${i + 1} to`} />
                <span className="rate-input">
                  <span className="muted">₱</span>
                  <input type="number" inputMode="decimal" min={0} step="1" value={r.rate} placeholder="350"
                    onChange={(e) => setRow(key, i, { rate: e.target.value })} aria-label={`${label} set ${i + 1} price per hour`} />
                  <span className="muted tiny">/hr</span>
                </span>
                <button type="button" className="icon-btn" onClick={() => removeRow(key, i)} aria-label={`Remove ${label} set ${i + 1}`}><Icon name="trash" size={16} /></button>
                {r.starts && r.ends && <span className="tiny muted rate-read">{fmtClock(r.starts)} – {fmtClock(r.ends)}{r.ends <= r.starts ? ' (next day)' : ''}</span>}
              </div>
            ))}
            <div className="btn-row">
              {sets[key].length < MAX_SETS && <button type="button" className="btn btn-sm btn-outline" onClick={() => addRow(key)}><Icon name="plus" size={14} /> Add time set</button>}
              {key === 'weekend' && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSets((all) => ({ ...all, weekend: all.weekday.map((r) => ({ ...r })) }))}>Same as weekdays</button>
              )}
            </div>
          </fieldset>
        ))}

        <fieldset className="fieldset">
          <legend className="field-label">Apply to</legend>
          <div className="chip-row">
            <button type="button" className={`chip${picked.length === courts.length ? ' is-active' : ''}`} onClick={() => pickGroup(courts.map((c) => c.id))}>All courts</button>
            {SPORTS.map((sp) => (
              <button key={sp} type="button" className="chip" onClick={() => pickGroup(bySport(sp).map((c) => c.id))}>All {SPORT_LABEL[sp].toLowerCase()}</button>
            ))}
          </div>
          <div className="court-checks">
            {SPORTS.map((sp) => bySport(sp).map((c) => (
              <label key={c.id} className="check">
                <input type="checkbox" checked={picked.includes(c.id)} onChange={() => toggle(c.id)} />
                <span>{SPORT_LABEL[sp]} · {c.name}</span>
              </label>
            )))}
          </div>
          {picked.length > 1 && <p className="tiny muted">This replaces the current prices of all {picked.length} ticked courts. Bookings already made keep their price.</p>}
          {picked.length === 1 && <p className="tiny muted">Bookings already made keep their price.</p>}
        </fieldset>
        <p className="tiny muted">Currency: {settings.currency}</p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Closed dates, holidays and special events
// ---------------------------------------------------------------------------

const KINDS: { key: ClosureKind; hint: string; title: string }[] = [
  { key: 'closed', hint: 'Courts closed (maintenance, weather…)', title: 'Closed' },
  { key: 'holiday', hint: 'Public or local holiday', title: 'Holiday' },
  { key: 'event', hint: 'Tournament, private or special event', title: '' },
];

const dayLabel = (ymd: string) => fmtDateLong(toUtcMs(ymd, 720));
function rangeLabel(a: string, b: string) {
  return a === b ? dayLabel(a) : `${dayLabel(a)} – ${dayLabel(b)}`;
}

function Closures() {
  const { closures, courts, reload } = useSite();
  const toast = useToast();
  const [editing, setEditing] = useState<Closure | 'new' | null>(null);
  const [removing, setRemoving] = useState<Closure | null>(null);
  const [busy, setBusy] = useState(false);
  const today = todayYmd();
  const upcoming = closures.filter((k) => k.ends_on >= today);
  const courtNames = (ids: number[] | null) =>
    ids == null ? 'All courts'
      : ids.map((id) => courts.find((c) => c.id === id)).filter(Boolean).map((c) => `${SPORT_LABEL[c!.sport]} ${c!.name}`).join(', ');

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const { error } = await supabase.from('closures').delete().eq('id', removing.id);
    setBusy(false);
    if (error) toast(toAppError(error).message, 'error');
    else toast('Date reopened for booking.');
    setRemoving(null);
    void reload();
  };

  return (
    <section className="card" aria-labelledby="c-closures">
      <div className="card-head">
        <h2 id="c-closures">Closed dates &amp; events</h2>
        <button type="button" className="btn btn-sm btn-outline" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> Add date</button>
      </div>
      <p className="muted small">Customers cannot book online on these days; the Schedule and booking pages show the reason. For a few hours only, use Bookings → Block time.</p>
      <ul className="rows">
        {upcoming.map((k) => (
          <li key={k.id} className="row">
            <span className="row-main">
              <strong><span className={`badge closure-badge kind-${k.kind}`}>{CLOSURE_LABEL[k.kind]}</span> {k.title}</strong>
              <span className="small muted">{rangeLabel(k.starts_on, k.ends_on)} · {courtNames(k.court_ids)}{k.note ? ` · ${k.note}` : ''}</span>
            </span>
            <span className="row-actions">
              <button type="button" className="btn btn-sm" onClick={() => setEditing(k)}><Icon name="edit" size={16} /> Edit</button>
              <button type="button" className="icon-btn" onClick={() => setRemoving(k)} aria-label={`Remove ${k.title}`}><Icon name="trash" size={18} /></button>
            </span>
          </li>
        ))}
        {upcoming.length === 0 && <li className="muted small">No closed dates coming up.</li>}
      </ul>
      {editing && <ClosureDialog closure={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {removing && (
        <Confirm title={`Reopen ${removing.title}?`} confirmLabel="Remove and reopen" busy={busy} onConfirm={() => void remove()} onClose={() => setRemoving(null)}>
          <p>{rangeLabel(removing.starts_on, removing.ends_on)} will be open for online booking again.</p>
        </Confirm>
      )}
    </section>
  );
}

interface ClosureBooking { reference: string; court: string; sport: Sport; starts_at: string; ends_at: string; customer_name: string | null; customer_phone: string | null; status: string }

function ClosureDialog({ closure, onClose }: { closure: Closure | null; onClose: () => void }) {
  const { courts, reload } = useSite();
  const toast = useToast();
  const today = todayYmd();
  const [kind, setKind] = useState<ClosureKind>(closure?.kind ?? 'holiday');
  const [title, setTitle] = useState(closure?.title ?? 'Holiday');
  const [from, setFrom] = useState(closure?.starts_on ?? ymdAdd(today, 1));
  const [to, setTo] = useState(closure?.ends_on ?? closure?.starts_on ?? ymdAdd(today, 1));
  const [allCourts, setAllCourts] = useState(closure ? closure.court_ids == null : true);
  const [picked, setPicked] = useState<number[]>(closure?.court_ids ?? []);
  const [note, setNote] = useState(closure?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [affected, setAffected] = useState<ClosureBooking[] | null>(null);
  const titleTouched = useRef(!!closure);

  const pickKind = (k: ClosureKind) => {
    setKind(k);
    if (!titleTouched.current) setTitle(KINDS.find((x) => x.key === k)!.title);
  };

  // Bookings already made on those days, so the admin can contact the customers.
  useEffect(() => {
    if (!from || !to || to < from) { setAffected(null); return; }
    let alive = true;
    const ids = allCourts ? null : picked;
    if (ids && ids.length === 0) { setAffected([]); return; }
    void supabase.rpc('admin_closure_bookings', { p_starts_on: from, p_ends_on: to, p_court_ids: ids }).then(({ data }) => {
      if (alive) setAffected((data as ClosureBooking[]) ?? []);
    });
    return () => { alive = false; };
  }, [from, to, allCourts, picked]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError('Give it a short name, e.g. "Christmas Day" or "Club tournament".');
    if (!from || !to) return setError('Choose the dates.');
    if (to < from) return setError('The last day must be on or after the first day.');
    if (!allCourts && picked.length === 0) return setError('Choose at least one court, or tick All courts.');
    setBusy(true);
    const payload = { kind, title: title.trim(), starts_on: from, ends_on: to, court_ids: allCourts ? null : picked, note: note.trim() || null };
    const { error: err } = closure
      ? await supabase.from('closures').update(payload).eq('id', closure.id)
      : await supabase.from('closures').insert(payload);
    setBusy(false);
    if (err) {
      const msg = toAppError(err).message;
      return setError(/ends_on - starts_on|check constraint/i.test(msg) ? 'A closure can cover up to 3 months at a time.' : msg);
    }
    toast(closure ? 'Closed date updated.' : `${CLOSURE_LABEL[kind]} saved. Online booking is closed for ${from === to ? 'that day' : 'those days'}.`);
    await reload();
    onClose();
  };

  return (
    <Modal title={closure ? 'Edit closed date' : 'Close a date'} onClose={onClose} wide>
      <form className="form" onSubmit={save}>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="chip-row" role="radiogroup" aria-label="Type">
          {KINDS.map((k) => (
            <button key={k.key} type="button" role="radio" aria-checked={kind === k.key} className={`chip${kind === k.key ? ' is-active' : ''}`}
              onClick={() => pickKind(k.key)} title={k.hint}>{CLOSURE_LABEL[k.key]}</button>
          ))}
        </div>
        <Field label="Name shown to customers" hint={KINDS.find((k) => k.key === kind)!.hint}>
          <input type="text" value={title} maxLength={80} placeholder={kind === 'event' ? 'e.g. Yepjo Open Tournament' : 'e.g. Christmas Day'}
            onChange={(e) => { titleTouched.current = true; setTitle(e.target.value); }} required />
        </Field>
        <div className="form-2">
          <Field label="From"><input type="date" value={from} min={closure ? undefined : today} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} required /></Field>
          <Field label="To (same day for one day)"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required /></Field>
        </div>
        <fieldset className="fieldset">
          <legend className="field-label">Courts</legend>
          <Toggle checked={allCourts} onChange={setAllCourts} label="All courts" />
          {!allCourts && (
            <div className="court-checks">
              {SPORTS.map((sp) => courts.filter((c) => c.sport === sp).map((c) => (
                <label key={c.id} className="check">
                  <input type="checkbox" checked={picked.includes(c.id)}
                    onChange={() => setPicked((p) => (p.includes(c.id) ? p.filter((x) => x !== c.id) : [...p, c.id]))} />
                  <span>{SPORT_LABEL[sp]} · {c.name}</span>
                </label>
              )))}
            </div>
          )}
        </fieldset>
        <Field label="Note for customers (optional)" hint="e.g. Open again Dec 26 at 7 AM.">
          <input type="text" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {affected && affected.length > 0 && (
          <Notice kind="warn">
            <strong>{affected.length} booking{affected.length === 1 ? ' is' : 's are'} already on {from === to ? 'this day' : 'these days'}.</strong>{' '}
            They are not cancelled automatically. Contact the customer{affected.length === 1 ? '' : 's'} and cancel or move them in Bookings.
            <ul className="tiny affected-list">
              {affected.slice(0, 6).map((b) => (
                <li key={b.reference}>{b.reference} · {SPORT_LABEL[b.sport]} {b.court} · {fmtDateShort(b.starts_at)} {fmtTime(b.starts_at)} · {b.customer_name ?? 'Customer'}{b.customer_phone ? ` · ${b.customer_phone}` : ''}</li>
              ))}
              {affected.length > 6 && <li>…and {affected.length - 6} more</li>}
            </ul>
          </Notice>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Saving…' : closure ? 'Save changes' : `Close ${from === to ? 'this date' : 'these dates'}`}</button>
      </form>
    </Modal>
  );
}
