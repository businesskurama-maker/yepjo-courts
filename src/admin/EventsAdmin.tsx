import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PhotoPicker } from '../components/PhotoPicker';
import { useSignupCounts } from '../components/SignUp';
import { Confirm, Empty, Field, Icon, Modal, Notice, Spinner, Toggle, useToast } from '../components/ui';
import { photoUrl, supabase, toAppError } from '../lib/supabase';
import { fmtMoney, todayYmd, ymdAdd } from '../lib/time';
import { EVENT_KIND_LABEL, type EventKind, type YepjoEvent } from '../lib/types';
import { eventWhen } from '../pages/Events';
import { useSite } from '../state/site';
import { SignupsDialog } from './Signups';

const hhmm = (t: string) => t.slice(0, 5);

/** Admin: create and manage events (open play, trainings, tournaments) and their sign-ups. */
export default function EventsAdmin() {
  const { settings, pulse } = useSite();
  const toast = useToast();
  const [rows, setRows] = useState<YepjoEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [past, setPast] = useState(false);
  const [editing, setEditing] = useState<YepjoEvent | 'new' | null>(null);
  const [people, setPeople] = useState<YepjoEvent | null>(null);
  const [removing, setRemoving] = useState<YepjoEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const counts = useSignupCounts(pulse);
  const today = todayYmd();

  const load = useCallback(async () => {
    let q = supabase.from('events').select('*');
    q = past ? q.lt('ends_on', today).order('starts_on', { ascending: false }) : q.gte('ends_on', today).order('starts_on');
    const { data, error: err } = await q.limit(100);
    if (err) setError(toAppError(err).message);
    else { setRows((data as YepjoEvent[]) ?? []); setError(null); }
  }, [past, today]);
  useEffect(() => { void load(); }, [load, pulse]);

  const toggle = async (e: YepjoEvent, patch: Partial<YepjoEvent>) => {
    const { error: err } = await supabase.from('events').update(patch).eq('id', e.id);
    if (err) toast(toAppError(err).message, 'error');
    void load();
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const { error: err } = await supabase.from('events').delete().eq('id', removing.id);
    setBusy(false);
    setRemoving(null);
    if (err) return toast(toAppError(err).message, 'error');
    toast('Event deleted.');
    void load();
  };

  return (
    <div className="stack">
      <div className="title-row">
        <h1 className="page-title">Events</h1>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> New event</button>
      </div>
      <p className="muted small">Open play, trainings and tournaments shown on the Events page. Members register and pay by QR or at the venue. To keep courts free for an event, also add the hours under Courts → Closed dates, open play &amp; events.</p>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={!past} className={`tab${!past ? ' is-active' : ''}`} onClick={() => setPast(false)}>Upcoming</button>
        <button type="button" role="tab" aria-selected={past} className={`tab${past ? ' is-active' : ''}`} onClick={() => setPast(true)}>Past</button>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {rows === null && !error && <Spinner />}
      {rows !== null && rows.length === 0 && <Empty icon="trophy" title={past ? 'No past events' : 'No upcoming events'}>Create one with New event.</Empty>}
      <ul className="rows card">
        {(rows ?? []).map((e) => {
          const taken = counts[e.id] ?? 0;
          return (
            <li key={e.id} className="row row-photo">
              {e.image_path ? <img className="thumb thumb-lg" src={photoUrl(e.image_path)} alt="" /> : <span className="thumb thumb-lg portal-img-art"><Icon name="trophy" /></span>}
              <span className="row-main">
                <strong>{e.title} <span className={`badge event-kind kind-${e.kind}`}>{EVENT_KIND_LABEL[e.kind]}</span>{!e.is_published && <span className="badge badge-off">Draft</span>}</strong>
                <span className="small muted">{eventWhen(e)} · {Number(e.price) > 0 ? fmtMoney(Number(e.price), settings.currency) : 'Free'} · {taken}{e.capacity != null ? `/${e.capacity}` : ''} signed up</span>
                <span className="toggle-row">
                  <Toggle checked={e.is_published} onChange={(v) => void toggle(e, { is_published: v })} label={e.is_published ? 'Published' : 'Hidden'} />
                  <Toggle checked={e.registration_open} onChange={(v) => void toggle(e, { registration_open: v })} label="Registration open" />
                </span>
              </span>
              <span className="row-actions">
                <button type="button" className="btn btn-sm" onClick={() => setPeople(e)}><Icon name="user" size={16} /> Sign-ups</button>
                <button type="button" className="btn btn-sm" onClick={() => setEditing(e)}><Icon name="edit" size={16} /> Edit</button>
                <button type="button" className="icon-btn" onClick={() => setRemoving(e)} aria-label={`Delete ${e.title}`}><Icon name="trash" size={18} /></button>
              </span>
            </li>
          );
        })}
      </ul>
      {editing && <EventDialog event={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {people && <SignupsDialog kind="event" targetId={people.id} title={people.title} capacity={people.capacity} onClose={() => setPeople(null)} />}
      {removing && (
        <Confirm title={`Delete ${removing.title}?`} confirmLabel="Delete event" danger busy={busy} onConfirm={() => void remove()} onClose={() => setRemoving(null)}>
          <p>The event and its sign-up list are removed. {counts[removing.id] ? `${counts[removing.id]} people signed up: let them know first.` : ''} This cannot be undone. To stop new sign-ups instead, turn off Registration open.</p>
        </Confirm>
      )}
    </div>
  );
}

function EventDialog({ event, onClose, onSaved }: { event: YepjoEvent | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const tomorrow = ymdAdd(todayYmd(), 1);
  const [f, setF] = useState({
    kind: (event?.kind ?? 'open_play') as EventKind,
    sport: (event?.sport ?? 'pickleball') as string,
    title: event?.title ?? '',
    description: event?.description ?? '',
    image_path: event?.image_path ?? null as string | null,
    starts_on: event?.starts_on ?? tomorrow,
    ends_on: event?.ends_on ?? tomorrow,
    start_time: event ? hhmm(event.start_time) : '18:00',
    end_time: event ? hhmm(event.end_time) : '21:00',
    price: String(event?.price ?? 0),
    capacity: event?.capacity != null ? String(event.capacity) : '',
    is_published: event?.is_published ?? true,
    registration_open: event?.registration_open ?? true,
  });
  const [photo, setPhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const price = Number(f.price);
    const cap = f.capacity.trim() === '' ? null : Number(f.capacity);
    if (f.title.trim().length < 2) return setError('Give the event a name.');
    if (f.ends_on < f.starts_on) return setError('The last day must be on or after the first day.');
    if (f.start_time === f.end_time) return setError('Choose a different end time.');
    if (!Number.isFinite(price) || price < 0) return setError('Enter a price of 0 or more (0 = free).');
    if (cap !== null && (!Number.isInteger(cap) || cap < 1)) return setError('Places must be a whole number, or empty for no limit.');
    setBusy(true);
    const payload = {
      kind: f.kind, sport: f.sport || null, title: f.title.trim(), description: f.description.trim() || null, image_path: f.image_path,
      starts_on: f.starts_on, ends_on: f.ends_on, start_time: f.start_time, end_time: f.end_time, price, capacity: cap,
      is_published: f.is_published, registration_open: f.registration_open, updated_at: new Date().toISOString(),
    };
    const { error: err } = event ? await supabase.from('events').update(payload).eq('id', event.id) : await supabase.from('events').insert(payload);
    setBusy(false);
    if (err) return setError(toAppError(err).message);
    toast(event ? 'Event updated.' : 'Event created.');
    onSaved();
  };

  return (
    <Modal title={event ? 'Edit event' : 'New event'} onClose={onClose} wide>
      <form className="form" onSubmit={save}>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="chip-row" role="radiogroup" aria-label="Type">
          {(Object.keys(EVENT_KIND_LABEL) as EventKind[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={f.kind === k} className={`chip${f.kind === k ? ' is-active' : ''}`} onClick={() => set('kind', k)}>{EVENT_KIND_LABEL[k]}</button>
          ))}
        </div>
        <Field label="Name"><input type="text" value={f.title} maxLength={100} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Friday Night Open Play" required /></Field>
        <Field label="Sport">
          <select value={f.sport} onChange={(e) => set('sport', e.target.value)}>
            <option value="pickleball">Pickleball</option><option value="badminton">Badminton</option><option value="dance">Step Up Dance</option><option value="">Any / mixed</option>
          </select>
        </Field>
        <Field label="Details (optional)" hint="Format, levels, prizes, what to bring…"><textarea rows={4} maxLength={2000} value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
        <div className="form-2">
          <Field label="First day"><input type="date" value={f.starts_on} onChange={(e) => { set('starts_on', e.target.value); if (f.ends_on < e.target.value) set('ends_on', e.target.value); }} required /></Field>
          <Field label="Last day" hint="Same day for a one-day event"><input type="date" value={f.ends_on} min={f.starts_on} onChange={(e) => set('ends_on', e.target.value)} required /></Field>
        </div>
        <div className="form-2">
          <Field label="Starts at"><input type="time" step={900} value={f.start_time} onChange={(e) => set('start_time', e.target.value)} required /></Field>
          <Field label="Ends at" hint={f.end_time <= f.start_time ? 'Ends after midnight' : undefined}><input type="time" step={900} value={f.end_time} onChange={(e) => set('end_time', e.target.value)} required /></Field>
        </div>
        <div className="form-2">
          <Field label="Registration fee (₱)" hint="0 = free"><input type="number" min={0} step="1" inputMode="decimal" value={f.price} onChange={(e) => set('price', e.target.value)} /></Field>
          <Field label="Places" hint="Empty = no limit"><input type="number" min={1} step="1" inputMode="numeric" value={f.capacity} onChange={(e) => set('capacity', e.target.value)} /></Field>
        </div>
        <div className="photo-field">
          {f.image_path ? <img src={photoUrl(f.image_path)} alt="" className="thumb thumb-lg" /> : <span className="muted small">No photo</span>}
          <button type="button" className="btn btn-sm btn-outline" onClick={() => setPhoto(true)}><Icon name="image" size={16} /> {f.image_path ? 'Change photo' : 'Add photo'}</button>
          {f.image_path && <button type="button" className="btn btn-sm btn-ghost" onClick={() => set('image_path', null)}>Remove</button>}
        </div>
        <Toggle checked={f.is_published} onChange={(v) => set('is_published', v)} label="Show on the Events page" />
        <Toggle checked={f.registration_open} onChange={(v) => set('registration_open', v)} label="Registration open" />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Saving…' : event ? 'Save changes' : 'Create event'}</button>
      </form>
      {photo && <PhotoPicker folder="announcements" title="Event photo" onClose={() => setPhoto(false)} onUploaded={(p) => { set('image_path', p); setPhoto(false); }} />}
    </Modal>
  );
}
