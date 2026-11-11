import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Confirm, Empty, Field, Icon, Modal, Notice, Pager, Spinner, useToast } from '../components/ui';
import { useLocation } from '../lib/router';
import { supabase, toAppError } from '../lib/supabase';
import {
  DAY_MS, fmtDateLong, fmtDateTime, fmtDuration, fmtMoney, fmtRange, fromLocalInput, toLocalInput, toUtcMs, todayYmd,
} from '../lib/time';
import { SPORTS, SPORT_LABEL, type Reservation, type ReservationKind, type Sport } from '../lib/types';
import { useSite } from '../state/site';

const KIND_LABEL: Record<ReservationKind, string> = { online: 'Online', walk_in: 'Walk-in', block: 'Block' };

export default function Bookings() {
  const { courts, settings, pulse } = useSite();
  const { query } = useLocation();
  const toast = useToast();

  const [date, setDate] = useState(query.get('date') ?? todayYmd());
  const [sport, setSport] = useState<Sport | ''>('');
  const [courtId, setCourtId] = useState<number | ''>('');
  const [status, setStatus] = useState<'' | 'confirmed' | 'cancelled'>('confirmed');
  const [kind, setKind] = useState<ReservationKind | ''>((query.get('kind') as ReservationKind | null) ?? '');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [rows, setRows] = useState<Reservation[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Reservation | null>(null);
  const [cancelling, setCancelling] = useState<Reservation | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<'walk_in' | 'block' | null>(null);

  const courtOptions = useMemo(() => courts.filter((c) => !sport || c.sport === sport), [courts, sport]);
  const courtName = (id: number) => {
    const c = courts.find((x) => x.id === id);
    return c ? `${SPORT_LABEL[c.sport]} · ${c.name}` : `Court #${id}`;
  };

  const load = useCallback(async () => {
    let q = supabase.from('reservations').select('*', { count: 'exact' });
    if (date) {
      const from = toUtcMs(date);
      q = q.gte('starts_at', new Date(from).toISOString()).lt('starts_at', new Date(from + DAY_MS).toISOString());
    }
    if (courtId !== '') q = q.eq('court_id', courtId);
    else if (sport) q = q.in('court_id', courts.filter((c) => c.sport === sport).map((c) => c.id));
    if (status) q = q.eq('status', status);
    if (kind) q = q.eq('kind', kind);
    const { data, error: err, count } = await q
      .order('starts_at', { ascending: Boolean(date) })
      .order('court_id')
      .range((page - 1) * pageSize, page * pageSize - 1);
    if (err) setError(toAppError(err).message);
    else {
      setRows((data as Reservation[]) ?? []);
      setTotal(count ?? 0);
      setError(null);
    }
  }, [date, sport, courtId, status, kind, page, pageSize, courts]);

  useEffect(() => {
    void load();
  }, [load, pulse]);

  const resetPage = () => setPage(1);

  const cancel = async () => {
    if (!cancelling) return;
    setBusy(true);
    const { error: err } = await supabase.rpc('cancel_reservation', { p_id: cancelling.id, p_reason: reason });
    setBusy(false);
    if (err) toast(toAppError(err).message, 'error');
    else {
      toast(`${cancelling.reference} was cancelled and the time is open again.`);
      setCancelling(null);
      setDetail(null);
      setReason('');
    }
    void load();
  };

  return (
    <div className="stack">
      <div className="title-row">
        <h1 className="page-title">Bookings</h1>
        <div className="btn-row">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setDialog('walk_in')}><Icon name="plus" size={16} /> Walk-in</button>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setDialog('block')}><Icon name="lock" size={16} /> Block time</button>
        </div>
      </div>

      <div className="filters">
        <label className="field"><span className="field-label">Date</span>
          <input type="date" value={date} onChange={(e) => { setDate(e.target.value); resetPage(); }} />
        </label>
        <label className="field"><span className="field-label">Sport</span>
          <select value={sport} onChange={(e) => { setSport(e.target.value as Sport | ''); setCourtId(''); resetPage(); }}>
            <option value="">All sports</option>
            {SPORTS.map((s) => <option key={s} value={s}>{SPORT_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">Court</span>
          <select value={courtId} onChange={(e) => { setCourtId(e.target.value === '' ? '' : Number(e.target.value)); resetPage(); }}>
            <option value="">All courts</option>
            {courtOptions.map((c) => <option key={c.id} value={c.id}>{SPORT_LABEL[c.sport]} · {c.name}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-label">Status</span>
          <select value={status} onChange={(e) => { setStatus(e.target.value as typeof status); resetPage(); }}>
            <option value="">Any status</option>
            <option value="confirmed">Confirmed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <label className="field"><span className="field-label">Type</span>
          <select value={kind} onChange={(e) => { setKind(e.target.value as ReservationKind | ''); resetPage(); }}>
            <option value="">Any type</option>
            <option value="online">Online</option>
            <option value="walk_in">Walk-in</option>
            <option value="block">Block</option>
          </select>
        </label>
        {date && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setDate(''); resetPage(); }}>All dates</button>}
      </div>

      {error && <Notice kind="error" action={<button type="button" className="btn btn-sm" onClick={() => void load()}>Retry</button>}>{error}</Notice>}
      {rows === null && !error && <Spinner />}
      {rows !== null && rows.length === 0 && <Empty icon="ticket" title="No reservations match these filters" />}

      {rows !== null && rows.length > 0 && (
        <ul className="rows card">
          {rows.map((r) => (
            <li key={r.id} className="row">
              <button type="button" className="row-btn" onClick={() => setDetail(r)} aria-label={`Details for ${r.reference}`}>
                <span className="row-main">
                  <strong>{fmtRange(r.starts_at, r.ends_at)}</strong>
                  <span className="small">{date ? '' : `${fmtDateLong(r.starts_at)} · `}{courtName(r.court_id)}</span>
                </span>
                <span className="row-side small">
                  <span>{r.kind === 'block' ? r.note ?? 'Blocked' : r.customer_name ?? '—'}</span>
                  <span className="badges">
                    <span className={`badge ${r.kind === 'block' ? 'badge-off' : ''}`}>{KIND_LABEL[r.kind]}</span>
                    {r.status === 'cancelled' && <span className="badge badge-off">Cancelled</span>}
                  </span>
                </span>
                <Icon name="right" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />

      {detail && (
        <Modal title={`${KIND_LABEL[detail.kind]} · ${detail.reference}`} onClose={() => setDetail(null)} footer={
          detail.status === 'confirmed'
            ? <button type="button" className="btn btn-outline-danger" onClick={() => setCancelling(detail)}>{detail.kind === 'block' ? 'Remove block' : 'Cancel reservation'}</button>
            : undefined
        }>
          <dl className="facts">
            <div><dt>Court</dt><dd>{courtName(detail.court_id)}</dd></div>
            <div><dt>Date</dt><dd>{fmtDateLong(detail.starts_at)}</dd></div>
            <div><dt>Time</dt><dd>{fmtRange(detail.starts_at, detail.ends_at)} · {fmtDuration((new Date(detail.ends_at).getTime() - new Date(detail.starts_at).getTime()) / 60_000)}</dd></div>
            <div><dt>Status</dt><dd>{detail.status === 'confirmed' ? 'Confirmed' : `Cancelled ${detail.cancelled_at ? fmtDateTime(detail.cancelled_at) : ''}`}</dd></div>
            {detail.kind !== 'block' && <div><dt>Customer</dt><dd>{detail.customer_name ?? '—'}</dd></div>}
            {detail.customer_phone && <div><dt>Contact no.</dt><dd><a className="link" href={`tel:${detail.customer_phone}`}>{detail.customer_phone}</a></dd></div>}
            {detail.customer_email && <div><dt>Email</dt><dd><a className="link" href={`mailto:${detail.customer_email}`}>{detail.customer_email}</a></dd></div>}
            {detail.amount != null && <div><dt>Court fee</dt><dd>{fmtMoney(Number(detail.amount), settings.currency)}</dd></div>}
            {detail.note && <div><dt>{detail.kind === 'block' ? 'Reason' : 'Note'}</dt><dd>{detail.note}</dd></div>}
            {detail.cancel_reason && <div><dt>Cancel reason</dt><dd>{detail.cancel_reason}</dd></div>}
            <div><dt>Created</dt><dd>{fmtDateTime(detail.created_at)}</dd></div>
          </dl>
        </Modal>
      )}

      {cancelling && (
        <Confirm title={cancelling.kind === 'block' ? 'Remove this block?' : 'Cancel this reservation?'} danger busy={busy}
          confirmLabel={cancelling.kind === 'block' ? 'Remove block' : 'Cancel reservation'} onConfirm={() => void cancel()} onClose={() => setCancelling(null)}>
          <p>{courtName(cancelling.court_id)}<br />{fmtDateLong(cancelling.starts_at)} · {fmtRange(cancelling.starts_at, cancelling.ends_at)}</p>
          <Field label="Reason (optional, saved in the activity log)">
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
          </Field>
        </Confirm>
      )}

      {dialog && <CreateDialog kind={dialog} defaultDate={date || todayYmd()} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void load(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- walk-in / block dialog
function CreateDialog({ kind, defaultDate, onClose, onSaved }: { kind: 'walk_in' | 'block'; defaultDate: string; onClose: () => void; onSaved: () => void }) {
  const { courts, settings } = useSite();
  const toast = useToast();
  const active = courts.filter((c) => c.is_active || kind === 'block');
  const nextHour = Math.ceil((Date.now() + 60_000) / 3_600_000) * 3_600_000;
  const initialStart = defaultDate === todayYmd() ? nextHour : toUtcMs(defaultDate, 12 * 60);

  const [selected, setSelected] = useState<number[]>(kind === 'walk_in' && active[0] ? [active[0].id] : []);
  const [startAt, setStartAt] = useState(toLocalInput(initialStart));
  const [endAt, setEndAt] = useState(toLocalInput(initialStart + (kind === 'walk_in' ? settings.slot_minutes * 60_000 : 3 * 3_600_000)));
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: number) => setSelected((list) => (kind === 'walk_in' ? [id] : list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  const selectSport = (s: Sport) => setSelected(active.filter((c) => c.sport === s).map((c) => c.id));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (selected.length === 0) return setError('Choose at least one court.');
    if (!startAt || !endAt) return setError('Enter the start and end.');
    const s = fromLocalInput(startAt);
    const en = fromLocalInput(endAt);
    if (en <= s) return setError('The end must be after the start.');
    if (kind === 'walk_in' && !name.trim()) return setError("Enter the customer's name.");
    setBusy(true);
    const { error: err } = await supabase.rpc('admin_create_reservations', {
      p_court_ids: selected, p_starts_at: new Date(s).toISOString(), p_ends_at: new Date(en).toISOString(), p_kind: kind,
      p_customer_name: name || null, p_customer_phone: phone || null, p_note: note || null,
    });
    setBusy(false);
    if (err) return setError(toAppError(err).message);
    toast(kind === 'walk_in' ? 'Walk-in booking saved.' : `Blocked ${selected.length} court${selected.length > 1 ? 's' : ''}.`);
    onSaved();
  };

  return (
    <Modal title={kind === 'walk_in' ? 'Walk-in booking' : 'Block courts'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {error && <Notice kind="error">{error}</Notice>}
        <fieldset className="fieldset">
          <legend className="field-label">{kind === 'walk_in' ? 'Court' : 'Courts to block'}</legend>
          {kind === 'block' && (
            <div className="chip-row">
              {SPORTS.map((s) => <button key={s} type="button" className="chip" onClick={() => selectSport(s)}>All {SPORT_LABEL[s].toLowerCase()}</button>)}
              <button type="button" className="chip" onClick={() => setSelected(active.map((c) => c.id))}>All courts</button>
            </div>
          )}
          <div className="check-grid">
            {active.map((c) => (
              <label key={c.id} className="check">
                <input type={kind === 'walk_in' ? 'radio' : 'checkbox'} name="court" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
                <span>{SPORT_LABEL[c.sport]} · {c.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="form-2">
          <Field label="Starts (Philippine time)">
            <input type="datetime-local" value={startAt} step={900} onChange={(e) => setStartAt(e.target.value)} required />
          </Field>
          <Field label="Ends (Philippine time)">
            <input type="datetime-local" value={endAt} step={900} onChange={(e) => setEndAt(e.target.value)} required />
          </Field>
        </div>
        {kind === 'walk_in' && (
          <div className="form-2">
            <Field label="Customer name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></Field>
            <Field label="Contact number (optional)"><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} /></Field>
          </div>
        )}
        <Field label={kind === 'walk_in' ? 'Note (optional)' : 'Reason (maintenance, event, closure…)'}>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </Field>
        <p className="muted small">
          {kind === 'walk_in'
            ? 'Uses the same conflict check as online bookings: it is refused if the court is already taken.'
            : 'A block is refused if any selected court already has a booking in that period; cancel those bookings first. Nothing is saved unless every court can be blocked.'}
        </p>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Saving…' : kind === 'walk_in' ? 'Save walk-in' : 'Block time'}</button>
      </form>
    </Modal>
  );
}
