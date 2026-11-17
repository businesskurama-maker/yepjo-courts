import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSignupCounts } from '../components/SignUp';
import { Confirm, Empty, Field, Icon, Modal, Notice, Spinner, Toggle, useToast } from '../components/ui';
import { supabase, toAppError } from '../lib/supabase';
import { fmtDateLong, fmtMoney, fmtTime, toUtcMs, todayYmd, ymdAdd, ymdOf } from '../lib/time';
import type { DanceSession } from '../lib/types';
import { useSite } from '../state/site';
import { SignupsDialog } from './Signups';

const toHhmm = (iso: string) => new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().slice(11, 16);
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Admin: Step Up Dance classes (date, time, type, instructor, slots) and who booked. */
export default function DanceAdmin() {
  const { settings, pulse } = useSite();
  const toast = useToast();
  const [rows, setRows] = useState<DanceSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [past, setPast] = useState(false);
  const [editing, setEditing] = useState<DanceSession | 'new' | null>(null);
  const [people, setPeople] = useState<DanceSession | null>(null);
  const [removing, setRemoving] = useState<DanceSession | null>(null);
  const [busy, setBusy] = useState(false);
  const counts = useSignupCounts(pulse);

  const load = useCallback(async () => {
    const now = new Date().toISOString();
    let q = supabase.from('dance_sessions').select('*');
    q = past ? q.lt('starts_at', now).order('starts_at', { ascending: false }) : q.gte('starts_at', now).order('starts_at');
    const { data, error: err } = await q.limit(200);
    if (err) setError(toAppError(err).message);
    else { setRows((data as DanceSession[]) ?? []); setError(null); }
  }, [past]);
  useEffect(() => { void load(); }, [load, pulse]);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const { error: err } = await supabase.from('dance_sessions').delete().eq('id', removing.id);
    setBusy(false);
    setRemoving(null);
    if (err) return toast(toAppError(err).message, 'error');
    toast('Class deleted.');
    void load();
  };
  const publish = async (s: DanceSession, v: boolean) => {
    const { error: err } = await supabase.from('dance_sessions').update({ is_published: v }).eq('id', s.id);
    if (err) toast(toAppError(err).message, 'error');
    void load();
  };

  return (
    <div className="stack">
      <div className="title-row">
        <h1 className="page-title">Step Up Dance</h1>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> New class</button>
      </div>
      <p className="muted small">Classes appear on the Step Up Dance page. Set the date, time, dance type, instructor and number of slots; members book a slot and earn {settings.points_dance_booking ?? 1} reward point{Number(settings.points_dance_booking) === 1 ? '' : 's'} per class.</p>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={!past} className={`tab${!past ? ' is-active' : ''}`} onClick={() => setPast(false)}>Upcoming</button>
        <button type="button" role="tab" aria-selected={past} className={`tab${past ? ' is-active' : ''}`} onClick={() => setPast(true)}>Past</button>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {rows === null && !error && <Spinner />}
      {rows !== null && rows.length === 0 && <Empty icon="dance" title={past ? 'No past classes' : 'No upcoming classes'}>Add classes with New class (you can repeat them weekly).</Empty>}
      <ul className="rows card">
        {(rows ?? []).map((s) => {
          const taken = counts[s.id] ?? 0;
          return (
            <li key={s.id} className="row">
              <span className="row-main">
                <strong>{s.dance_type} <span className="muted small">with {s.instructor}</span>{!s.is_published && <span className="badge badge-off">Hidden</span>}</strong>
                <span className="small muted">
                  {fmtDateLong(s.starts_at)} · {fmtTime(s.starts_at)}–{fmtTime(s.ends_at)} · {Number(s.price) > 0 ? fmtMoney(Number(s.price), settings.currency) : 'Free'} · {s.step_board ? 'Step board provided' : 'No step board'}
                </span>
                <span className="small"><b className={taken >= s.capacity ? 'warn-text' : 'ok-text'}>{taken} / {s.capacity}</b> slots booked</span>
                <Toggle checked={s.is_published} onChange={(v) => void publish(s, v)} label={s.is_published ? 'Shown' : 'Hidden'} />
              </span>
              <span className="row-actions">
                <button type="button" className="btn btn-sm" onClick={() => setPeople(s)}><Icon name="user" size={16} /> Bookings</button>
                <button type="button" className="btn btn-sm" onClick={() => setEditing(s)}><Icon name="edit" size={16} /> Edit</button>
                <button type="button" className="icon-btn" onClick={() => setRemoving(s)} aria-label="Delete class"><Icon name="trash" size={18} /></button>
              </span>
            </li>
          );
        })}
      </ul>
      {editing && <ClassDialog session={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {people && <SignupsDialog kind="dance" targetId={people.id} title={`${people.dance_type} · ${fmtDateLong(people.starts_at)} ${fmtTime(people.starts_at)}`} capacity={people.capacity} onClose={() => setPeople(null)} />}
      {removing && (
        <Confirm title="Delete this class?" confirmLabel="Delete class" danger busy={busy} onConfirm={() => void remove()} onClose={() => setRemoving(null)}>
          <p>{removing.dance_type} on {fmtDateLong(removing.starts_at)} at {fmtTime(removing.starts_at)}. {counts[removing.id] ? `${counts[removing.id]} people booked: let them know first. ` : ''}This cannot be undone.</p>
        </Confirm>
      )}
    </div>
  );
}

function ClassDialog({ session, onClose, onSaved }: { session: DanceSession | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    date: session ? ymdOf(new Date(session.starts_at).getTime()) : ymdAdd(todayYmd(), 1),
    start: session ? toHhmm(session.starts_at) : '18:00',
    minutes: session ? String(Math.round((new Date(session.ends_at).getTime() - new Date(session.starts_at).getTime()) / 60_000)) : '60',
    dance_type: session?.dance_type ?? '',
    instructor: session?.instructor ?? '',
    capacity: String(session?.capacity ?? 20),
    price: String(session?.price ?? 0),
    step_board: session?.step_board ?? true,
    note: session?.note ?? '',
    is_published: session?.is_published ?? true,
    weeks: '1',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const mins = Number(f.minutes), cap = Number(f.capacity), price = Number(f.price), weeks = session ? 1 : Number(f.weeks);
    if (f.dance_type.trim().length < 2) return setError('Enter the type of dance, e.g. Zumba Step or Hip-hop Step.');
    if (f.instructor.trim().length < 2) return setError("Enter the instructor's name.");
    if (!Number.isInteger(mins) || mins < 15 || mins > 480) return setError('Length must be 15 minutes to 8 hours.');
    if (!Number.isInteger(cap) || cap < 1 || cap > 500) return setError('Slots must be a whole number from 1 to 500.');
    if (!Number.isFinite(price) || price < 0) return setError('Enter a price of 0 or more (0 = free).');
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 12) return setError('Repeat for 1 to 12 weeks.');
    const rows = Array.from({ length: weeks }, (_, i) => {
      const start = toUtcMs(ymdAdd(f.date, i * 7), minutesOf(f.start));
      return {
        dance_type: f.dance_type.trim(), instructor: f.instructor.trim(), capacity: cap, price, step_board: f.step_board,
        note: f.note.trim() || null, is_published: f.is_published,
        starts_at: new Date(start).toISOString(), ends_at: new Date(start + mins * 60_000).toISOString(), updated_at: new Date().toISOString(),
      };
    });
    if (!session && new Date(rows[0].starts_at).getTime() < Date.now()) return setError('Choose a start time in the future.');
    setBusy(true);
    const { error: err } = session
      ? await supabase.from('dance_sessions').update(rows[0]).eq('id', session.id)
      : await supabase.from('dance_sessions').insert(rows);
    setBusy(false);
    if (err) return setError(toAppError(err).message);
    toast(session ? 'Class updated.' : weeks > 1 ? `${weeks} weekly classes added.` : 'Class added.');
    onSaved();
  };

  return (
    <Modal title={session ? 'Edit class' : 'New Step Up Dance class'} onClose={onClose} wide>
      <form className="form" onSubmit={save}>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="form-2">
          <Field label="Type of dance"><input type="text" value={f.dance_type} maxLength={60} onChange={(e) => set('dance_type', e.target.value)} placeholder="e.g. Zumba Step" required list="dance-types" /></Field>
          <Field label="Instructor"><input type="text" value={f.instructor} maxLength={80} onChange={(e) => set('instructor', e.target.value)} placeholder="Instructor's name" required /></Field>
        </div>
        <datalist id="dance-types"><option value="Zumba Step" /><option value="Aerobic Step" /><option value="Hip-hop Step" /><option value="Dance Fitness" /></datalist>
        <div className="form-3">
          <Field label="Date"><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} required /></Field>
          <Field label="Start time"><input type="time" step={900} value={f.start} onChange={(e) => set('start', e.target.value)} required /></Field>
          <Field label="Length (minutes)">
            <select value={f.minutes} onChange={(e) => set('minutes', e.target.value)}>
              {[30, 45, 60, 75, 90, 120].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m / 60} hr`}</option>)}
              {![30, 45, 60, 75, 90, 120].includes(Number(f.minutes)) && <option value={f.minutes}>{f.minutes} min</option>}
            </select>
          </Field>
        </div>
        <div className="form-2">
          <Field label="Slots available" hint="You can change this any time"><input type="number" min={1} max={500} value={f.capacity} onChange={(e) => set('capacity', e.target.value)} required /></Field>
          <Field label="Price per person (₱)" hint="0 = free"><input type="number" min={0} step="1" value={f.price} onChange={(e) => set('price', e.target.value)} /></Field>
        </div>
        <Field label="Note (optional)" hint="e.g. Wear rubber shoes; bring water"><input type="text" value={f.note} maxLength={300} onChange={(e) => set('note', e.target.value)} /></Field>
        <Toggle checked={f.step_board} onChange={(v) => set('step_board', v)} label="Step board provided" />
        <Toggle checked={f.is_published} onChange={(v) => set('is_published', v)} label="Show on the Step Up Dance page" />
        {!session && (
          <Field label="Repeat weekly" hint="Adds the same class on the same weekday">
            <select value={f.weeks} onChange={(e) => set('weeks', e.target.value)}>
              {[1, 2, 3, 4, 6, 8, 12].map((w) => <option key={w} value={w}>{w === 1 ? 'Just this date' : `${w} weeks`}</option>)}
            </select>
          </Field>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Saving…' : session ? 'Save changes' : 'Add class'}</button>
      </form>
    </Modal>
  );
}
