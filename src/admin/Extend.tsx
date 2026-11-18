import { useCallback, useEffect, useState } from 'react';
import { Confirm, Icon, Modal, Notice, useToast } from '../components/ui';
import { supabase, toAppError } from '../lib/supabase';
import { fmtDateShort, fmtDuration, fmtMoney, fmtRange, fmtTime } from '../lib/time';
import { SPORT_LABEL, type Reservation } from '../lib/types';
import { useSite } from '../state/site';

/** Staff dialog: add hours to a booking, with the extra time paid or not paid yet. */
export function ExtendDialog({ booking, onClose, onDone }: { booking: Reservation; onClose: () => void; onDone: (r: Reservation) => void }) {
  const { settings, courts } = useSite();
  const toast = useToast();
  const [hours, setHours] = useState(Math.min(4, Math.max(1, Math.round((booking.extend_request_minutes ?? 60) / 60))));
  const [paid, setPaid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const court = courts.find((c) => c.id === booking.court_id);
  const newEnd = new Date(new Date(booking.ends_at).getTime() + hours * 3_600_000).toISOString();

  const save = async () => {
    setBusy(true); setError(null);
    const { data, error: err } = await supabase.rpc('admin_extend_reservation', { p_id: booking.id, p_minutes: hours * 60, p_paid: paid });
    setBusy(false);
    if (err) return setError(toAppError(err).message);
    const r = data as Reservation;
    toast(`${r.reference} extended to ${fmtTime(r.ends_at)}${paid ? '' : `. ${fmtMoney(Number(r.extra_unpaid ?? 0), settings.currency)} still to collect`}.`);
    onDone(r);
  };

  return (
    <Modal title={`Extend ${booking.reference}`} onClose={onClose} footer={
      <>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Close</button>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Extending…' : `Extend to ${fmtTime(newEnd)}`}</button>
      </>
    }>
      <div className="stack-sm">
        <p><strong>{booking.customer_name ?? 'Customer'}</strong> · {court ? `${SPORT_LABEL[court.sport]} · ${court.name}` : 'Court'}<br />
          <span className="muted small">Now {fmtRange(booking.starts_at, booking.ends_at)}</span></p>
        {booking.extend_request_minutes ? <Notice kind="info">The customer asked for {fmtDuration(booking.extend_request_minutes)} more.</Notice> : null}
        <div>
          <span className="field-label">Add time</span>
          <div className="chip-row" role="radiogroup" aria-label="Extra hours">
            {[1, 2, 3, 4].map((h) => (
              <button key={h} type="button" role="radio" aria-checked={hours === h} className={`chip${hours === h ? ' is-active' : ''}`} onClick={() => { setHours(h); setError(null); }}>
                +{h} hr{h === 1 ? '' : 's'}
              </button>
            ))}
          </div>
        </div>
        <fieldset className="pay-choice">
          <legend className="field-label">Payment for the extra time</legend>
          <label className={`pay-option${paid ? ' is-active' : ''}`}>
            <input type="radio" name="ext-paid" checked={paid} onChange={() => setPaid(true)} />
            <span><strong>Payment received</strong><small>The customer already paid for the extra time.</small></span>
          </label>
          <label className={`pay-option${!paid ? ' is-active' : ''}`}>
            <input type="radio" name="ext-paid" checked={!paid} onChange={() => setPaid(false)} />
            <span><strong>Not paid yet</strong><small>Extend now and collect later. It stays on the "to collect" list until you mark it paid.</small></span>
          </label>
        </fieldset>
        <p className="tiny muted">The extra time is only added if the court is free and open until {fmtTime(newEnd)}. The price follows the court's hourly rates.</p>
        {error && <Notice kind="error">{error}</Notice>}
      </div>
    </Modal>
  );
}

/** Staff list: customers asking for more time, and extensions that are not paid yet. */
export function ExtensionsPanel() {
  const { settings, courts, pulse } = useSite();
  const toast = useToast();
  const [reqs, setReqs] = useState<Reservation[]>([]);
  const [owed, setOwed] = useState<Reservation[]>([]);
  const [extending, setExtending] = useState<Reservation | null>(null);
  const [declining, setDeclining] = useState<Reservation | null>(null);
  const [paying, setPaying] = useState<Reservation | null>(null);
  const [busy, setBusy] = useState(false);
  const money = (v: number) => fmtMoney(v, settings.currency);
  const courtName = (id: number) => { const c = courts.find((x) => x.id === id); return c ? `${SPORT_LABEL[c.sport]} · ${c.name}` : 'Court'; };

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase.from('reservations').select('*').eq('status', 'confirmed').not('extend_request_minutes', 'is', null).order('extend_requested_at'),
      supabase.from('reservations').select('*').gt('extra_unpaid', 0).neq('status', 'cancelled').order('starts_at'),
    ]);
    setReqs(((a.data as Reservation[]) ?? []).filter((r) => new Date(r.ends_at).getTime() > Date.now() - 3_600_000));
    setOwed((b.data as Reservation[]) ?? []);
  }, []);
  useEffect(() => { void load(); }, [load, pulse]);

  const run = async (fn: string, r: Reservation, ok: string) => {
    setBusy(true);
    const { error } = await supabase.rpc(fn, { p_id: r.id });
    setBusy(false); setDeclining(null); setPaying(null);
    if (error) return toast(toAppError(error).message, 'error');
    toast(ok); void load();
  };

  if (reqs.length === 0 && owed.length === 0) return null;
  return (
    <section className="card stack-sm refunds" aria-labelledby="ext-h">
      {reqs.length > 0 && (<>
        <h2 id="ext-h"><Icon name="clock" size={18} /> Extension requests ({reqs.length})</h2>
        <ul className="rows">
          {reqs.map((r) => (
            <li key={r.id} className="row">
              <span className="row-main">
                <strong>{r.customer_name ?? 'Customer'} wants +{fmtDuration(r.extend_request_minutes ?? 60)}</strong>
                <span className="small muted">{courtName(r.court_id)} · {fmtDateShort(r.starts_at)}, {fmtRange(r.starts_at, r.ends_at)} · {r.reference}</span>
                {r.customer_phone && <a href={`tel:${r.customer_phone}`} className="small link">{r.customer_phone}</a>}
              </span>
              <span className="btn-row">
                <button type="button" className="btn btn-sm btn-primary" onClick={() => setExtending(r)}>Approve</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDeclining(r)}>Decline</button>
              </span>
            </li>
          ))}
        </ul>
      </>)}
      {owed.length > 0 && (<>
        <h2><Icon name="alert" size={18} /> Extensions to collect ({owed.length})</h2>
        <ul className="rows">
          {owed.map((r) => (
            <li key={r.id} className="row">
              <span className="row-main">
                <strong>{r.customer_name ?? 'Customer'} · <span className="warn-text">{money(Number(r.extra_unpaid))}</span></strong>
                <span className="small muted">{courtName(r.court_id)} · {fmtDateShort(r.starts_at)}, {fmtRange(r.starts_at, r.ends_at)} · {r.reference}</span>
              </span>
              <span className="btn-row">
                {new Date(r.ends_at).getTime() > Date.now() - 3_600_000 && <button type="button" className="btn btn-sm btn-outline" onClick={() => setExtending(r)}><Icon name="clock" size={15} /> Extend more</button>}
                <button type="button" className="btn btn-sm btn-primary" onClick={() => setPaying(r)}>Mark paid</button>
              </span>
            </li>
          ))}
        </ul>
      </>)}
      {extending && <ExtendDialog booking={extending} onClose={() => setExtending(null)} onDone={() => { setExtending(null); void load(); }} />}
      {declining && (
        <Confirm title="Decline this request?" confirmLabel="Decline" danger busy={busy}
          onConfirm={() => void run('clear_extension_request', declining, 'Request declined.')} onClose={() => setDeclining(null)}>
          <p>{declining.customer_name ?? 'The customer'} keeps the original time, {fmtRange(declining.starts_at, declining.ends_at)}. Let them know at the court.</p>
        </Confirm>
      )}
      {paying && (
        <Confirm title={`Received ${money(Number(paying.extra_unpaid))}?`} confirmLabel="Mark paid" busy={busy}
          onConfirm={() => void run('admin_mark_extension_paid', paying, `${paying.reference}: extension marked paid.`)} onClose={() => setPaying(null)}>
          <p>Payment for the extra time on {paying.reference} ({paying.customer_name ?? 'customer'}).</p>
        </Confirm>
      )}
    </section>
  );
}
