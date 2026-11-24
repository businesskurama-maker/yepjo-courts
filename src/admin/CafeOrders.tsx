import { ReceiptThumb } from '../components/Receipt';
import { useCallback, useEffect, useState } from 'react';
import { Confirm, Empty, Field, Icon, Modal, Notice, Toggle, useToast } from '../components/ui';
import { supabase, toAppError } from '../lib/supabase';
import { fmtDateMed, fmtMoney, fmtTime } from '../lib/time';
import type { CafeOrder, CafeOrderStatus } from '../lib/types';
import { clockLabel } from '../pages/Cafe';
import { useSite } from '../state/site';

type View = 'active' | 'done';
const STATUS: Record<CafeOrderStatus, string> = {
  pending: 'Awaiting payment', paid: 'New · paid', preparing: 'Preparing', ready: 'Ready for pickup', completed: 'Picked up', cancelled: 'Cancelled',
};
const NEXT: Partial<Record<CafeOrderStatus, [CafeOrderStatus, string]>> = {
  paid: ['preparing', 'Start preparing'], preparing: ['ready', 'Mark ready'], ready: ['completed', 'Picked up'],
};

/** Admin: cafe order queue (approve payment → preparing → ready → picked up). */
export function CafeOrdersAdmin() {
  const { settings, pulse } = useSite();
  const toast = useToast();
  const [view, setView] = useState<View>('active');
  const [rows, setRows] = useState<CafeOrder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<CafeOrder | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const money = (v: number) => fmtMoney(v, settings.currency).replace(/\.00$/, '');

  const load = useCallback(async () => {
    let q = supabase.from('cafe_orders').select('*');
    q = view === 'active'
      ? q.in('status', ['pending', 'paid', 'preparing', 'ready']).order('pickup_at', { ascending: true, nullsFirst: true }).order('created_at')
      : q.in('status', ['completed', 'cancelled']).order('created_at', { ascending: false }).limit(50);
    const { data, error: err } = await q;
    if (err) return setError(toAppError(err).message);
    setError(null);
    setRows((data as CafeOrder[]) ?? []);
  }, [view]);
  useEffect(() => { void load(); }, [load, pulse]);

  const run = async (o: CafeOrder, fn: () => PromiseLike<{ error: unknown }>, ok: string) => {
    setBusy(o.id);
    const { error: err } = await fn();
    setBusy(null);
    if (err) return toast(toAppError(err).message, 'error');
    toast(ok);
    void load();
  };
  const review = (o: CafeOrder, approve: boolean) =>
    run(o, () => supabase.rpc('admin_review_order', { p_id: o.id, p_approve: approve, p_note: approve ? null : 'Payment not found' }),
      approve ? `${o.reference} approved. It's in the kitchen queue.` : `${o.reference}: customer asked to resend the payment.`);
  const setStatus = (o: CafeOrder, s: CafeOrderStatus, why?: string) =>
    run(o, () => supabase.rpc('admin_set_order_status', { p_id: o.id, p_status: s, p_reason: why ?? null }), `${o.reference}: ${STATUS[s]}.`);

  const toCheck = rows.filter((o) => o.status === 'pending' && o.payment_status === 'submitted').length;
  return (
    <section className="stack-sm" aria-labelledby="orders-h">
      <div className="title-row">
        <h2 id="orders-h" className="section-h">Kitchen queue {toCheck > 0 && <span className="badge badge-warn">{toCheck} payment{toCheck === 1 ? '' : 's'} to check</span>}</h2>
        <div className="tabs tabs-sm" role="tablist" aria-label="Orders">
          {(['active', 'done'] as View[]).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={`tab${view === v ? ' is-active' : ''}`} onClick={() => setView(v)}>
              {v === 'active' ? 'Open' : 'Done'}
            </button>
          ))}
        </div>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {rows.length === 0 && !error && <Empty icon="cup" title={view === 'active' ? 'No open orders' : 'No finished orders yet'}>New online orders appear here live.</Empty>}
      <ul className="kitchen-grid">
        {rows.map((o) => {
          const next = NEXT[o.status];
          return (
            <li key={o.id} className={`card kitchen-card status-${o.status}`}>
              <div className="order-card-head">
                <strong>{o.reference}</strong>
                <span className={`badge ${o.status === 'cancelled' ? 'badge-off' : o.status === 'pending' ? 'badge-warn' : o.status === 'ready' ? 'badge-ready' : 'badge-ok'}`}>
                  {o.status === 'pending' && o.payment_status === 'submitted' ? 'Payment to check' : STATUS[o.status]}
                </span>
              </div>
              <p className="kitchen-when"><Icon name="clock" size={15} /> {o.pickup_at ? `${fmtDateMed(o.pickup_at)}, ${fmtTime(o.pickup_at)}` : 'ASAP'}</p>
              <ul className="kitchen-lines">
                {o.items.map((l) => <li key={l.id}><b>{l.qty}×</b> {l.name}</li>)}
              </ul>
              {o.note && <p className="small kitchen-note">“{o.note}”</p>}
              <p className="small muted">{o.customer_name}{o.customer_phone ? <> · <a className="link" href={`tel:${o.customer_phone}`}>{o.customer_phone}</a></> : null} · <b className="ok-text">{money(Number(o.total))}</b></p>
              {o.status === 'pending' && o.payment_status === 'submitted' && (
                o.payment_proof_path
                  ? <div className="receipt-line"><ReceiptThumb path={o.payment_proof_path} label={`Receipt · ${o.reference}`} size="sm" /><span className="small">Open the screenshot and check it in GCash/Maya before approving.</span></div>
                  : <p className="small">Reference ends <b>{o.payment_ref}</b>. Check it in GCash/Maya before approving.</p>
              )}
              {o.status === 'cancelled' && o.refund_status === 'to_claim' && <p className="refund-note small">Refund {money(Number(o.refund_amount ?? 0))} to hand over (see Payments).</p>}
              <div className="btn-row">
                {o.status === 'pending' && o.payment_status === 'submitted' && (
                  <>
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy === o.id} onClick={() => void review(o, true)}>Approve payment</button>
                    <button type="button" className="btn btn-sm btn-ghost" disabled={busy === o.id} onClick={() => void review(o, false)}>Not found</button>
                  </>
                )}
                {next && <button type="button" className="btn btn-sm btn-primary" disabled={busy === o.id} onClick={() => void setStatus(o, next[0])}>{next[1]}</button>}
                {['paid', 'preparing', 'ready'].includes(o.status) && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setReason(''); setCancelling(o); }}>Cancel</button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {cancelling && (
        <Confirm title={`Cancel ${cancelling.reference}?`} confirmLabel="Cancel order" danger busy={busy === cancelling.id}
          onConfirm={() => { const o = cancelling; setCancelling(null); void setStatus(o, 'cancelled', reason.trim() || 'Cancelled by Yepjo'); }}
          onClose={() => setCancelling(null)}>
          <p>The customer already paid {money(Number(cancelling.total))}. The full amount is listed under Payments → Refunds to hand over, for them to collect at the venue.</p>
          <Field label="Reason (shown to the customer)"><input type="text" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Out of stock" /></Field>
        </Confirm>
      )}
    </section>
  );
}

/** Admin: cafe hours and online ordering switch. */
export function CafeSettingsCard({ unpriced }: { unpriced: number }) {
  const { settings } = useSite();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ opens: '07:00', closes: '01:00', on: true, prep: 15 });
  const [busy, setBusy] = useState(false);
  const opens = (settings.cafe_opens ?? '07:00').slice(0, 5);
  const closes = (settings.cafe_closes ?? '01:00').slice(0, 5);
  const on = settings.cafe_ordering_enabled ?? true;
  const ready = on && settings.online_payment_enabled && !!settings.payment_qr_path;

  const save = async () => {
    setBusy(true);
    const { error } = await supabase.from('settings').update({
      cafe_opens: f.opens, cafe_closes: f.closes, cafe_ordering_enabled: f.on, cafe_prep_minutes: f.prep,
    }).eq('id', true);
    setBusy(false);
    if (error) return toast(toAppError(error).message, 'error');
    toast('Cafe settings saved.');
    setOpen(false);
  };

  return (
    <section className="card cafe-settings">
      <div>
        <strong>Online ordering {ready ? <span className="badge badge-ok">On</span> : <span className="badge badge-off">Off</span>}</strong>
        <p className="small muted">Hours {clockLabel(opens)} – {clockLabel(closes)} · ready in about {settings.cafe_prep_minutes ?? 15} min · customers pay by QR first.</p>
        {on && !ready && <p className="small warn-text">Turn on online payment and upload the payment QR in Settings to accept orders.</p>}
        {unpriced > 0 && <p className="small warn-text">{unpriced} item{unpriced === 1 ? ' has' : 's have'} no price yet and can't be ordered online yet. Add prices in the Menu tab.</p>}
      </div>
      <button type="button" className="btn btn-sm btn-outline" onClick={() => { setF({ opens, closes, on, prep: settings.cafe_prep_minutes ?? 15 }); setOpen(true); }}>
        <Icon name="settings" size={16} /> Hours &amp; ordering
      </button>
      {open && (
        <Modal title="Cafe hours & ordering" onClose={() => setOpen(false)}>
          <div className="form">
            <Toggle checked={f.on} onChange={(v) => setF({ ...f, on: v })} label={f.on ? 'Customers can order online' : 'Online ordering is off'} />
            <div className="form-2">
              <Field label="Opens"><input type="time" value={f.opens} onChange={(e) => setF({ ...f, opens: e.target.value })} /></Field>
              <Field label="Closes" hint="Past midnight is fine, e.g. 01:00"><input type="time" value={f.closes} onChange={(e) => setF({ ...f, closes: e.target.value })} /></Field>
            </div>
            <Field label="Preparation time (minutes)" hint="Earliest pickup is this long after ordering">
              <input type="number" min={5} max={120} value={f.prep} onChange={(e) => setF({ ...f, prep: Math.min(120, Math.max(5, Math.round(Number(e.target.value) || 15))) })} />
            </Field>
            <button type="button" className="btn btn-primary btn-block" disabled={busy || !f.opens || !f.closes} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
