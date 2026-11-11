import { useState, type FormEvent } from 'react';
import { Confirm, Field, Icon, Modal, Notice, Toggle, useToast } from '../components/ui';
import { Link } from '../lib/router';
import { supabase, toAppError } from '../lib/supabase';
import { WEEKDAYS, fmtMoney } from '../lib/time';
import { SPORTS, SPORT_LABEL, type Court, type CourtHours, type Sport } from '../lib/types';
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
  const [busy, setBusy] = useState(false);

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
      <h1 className="page-title">Courts &amp; schedules</h1>
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
                    {summarise(hours.filter((h) => h.court_id === c.id))} · {c.hourly_rate != null ? `${fmtMoney(Number(c.hourly_rate), settings.currency)}/hr` : 'No rate set'}
                  </span>
                </span>
                <span className="row-actions">
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(c)}><Icon name="edit" size={16} /> Edit</button>
                  <button type="button" className="icon-btn" onClick={() => setRemoving(c)} aria-label={`Delete ${c.name}`}><Icon name="trash" size={18} /></button>
                </span>
              </li>
            ))}
            {courts.filter((c) => c.sport === sport).length === 0 && <li className="muted small">No courts yet.</li>}
          </ul>
        </section>
      ))}

      {editing && <CourtDialog court={editing} onClose={() => setEditing(null)} />}
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
      return { dow, opens: hhmm(h?.opens ?? '12:00'), closes: hhmm(h?.closes ?? '01:00'), is_closed: h?.is_closed ?? false };
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
          <Field label="Hourly rate (optional)" hint="Shown to customers and used to compute the court fee.">
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
