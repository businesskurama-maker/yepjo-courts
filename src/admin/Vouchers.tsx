import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Confirm, Empty, Field, Icon, Notice, Spinner, Toggle, useToast } from '../components/ui';
import { supabase, toAppError } from '../lib/supabase';
import { fmtDateShort, fmtMoney } from '../lib/time';
import type { Voucher } from '../lib/types';
import { useSite } from '../state/site';

const copy = async (text: string) => {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
};

/** Admin: generate discount voucher codes and see how they were used. */
export default function Vouchers() {
  const { settings, pulse } = useSite();
  const toast = useToast();
  const [rows, setRows] = useState<Voucher[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('10');
  const [count, setCount] = useState('1');
  const [uses, setUses] = useState('1');
  const [note, setNote] = useState('');
  const [expires, setExpires] = useState('');
  const [custom, setCustom] = useState('');
  const [once, setOnce] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Voucher[]>([]);
  const [removing, setRemoving] = useState<Voucher | null>(null);
  const [filter, setFilter] = useState<'all' | 'open' | 'used'>('all');
  const money = (v: number) => fmtMoney(v, settings.currency).replace(/\.00$/, '');
  const worth = (v: { kind: string; value: number }) => (v.kind === 'percent' ? `${Number(v.value)}% off` : `${money(Number(v.value))} off`);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('admin_vouchers');
    if (err) return setError(toAppError(err).message);
    setError(null); setRows((data as Voucher[]) ?? []);
  }, []);
  useEffect(() => { void load(); }, [load, pulse]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const v = Number(value); const n = Math.round(Number(count) || 1); const u = uses.trim() === '' ? null : Math.round(Number(uses));
    if (!(v > 0) || (kind === 'percent' && v > 100)) return setFormError(kind === 'percent' ? 'Enter a percentage from 1 to 100.' : 'Enter an amount above zero.');
    if (n < 1 || n > 100) return setFormError('Create between 1 and 100 codes at a time.');
    if (u !== null && !(u >= 1)) return setFormError('Uses per code must be 1 or more, or leave it empty for unlimited.');
    if (custom.trim() && n !== 1) return setFormError('A custom code can only be made one at a time.');
    setBusy(true);
    const { data, error: err } = await supabase.rpc('admin_create_vouchers', {
      p_kind: kind, p_value: v, p_count: n, p_note: note.trim() || null, p_max_uses: u,
      p_expires_on: expires || null, p_code: custom.trim() || null, p_once_per_customer: once,
    });
    setBusy(false);
    if (err) return setFormError(toAppError(err).message);
    const made = (data as Voucher[]) ?? [];
    setFresh(made); setCustom('');
    toast(made.length === 1 ? `Voucher ${made[0].code} created.` : `${made.length} voucher codes created.`);
    void load();
  };

  const setActive = async (v: Voucher, on: boolean) => {
    const { error: err } = await supabase.from('vouchers').update({ is_active: on }).eq('id', v.id);
    if (err) return toast(toAppError(err).message, 'error');
    void load();
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const { error: err } = await supabase.from('vouchers').delete().eq('id', removing.id);
    setBusy(false); setRemoving(null);
    if (err) return toast(toAppError(err).message, 'error');
    toast('Voucher deleted.'); void load();
  };
  const doCopy = async (text: string, label: string) => toast((await copy(text)) ? `${label} copied.` : 'Could not copy. Select the code and copy it by hand.');

  const today = new Date().toISOString().slice(0, 10);
  const state = (v: Voucher) => !v.is_active ? ['Off', 'badge-off'] : v.expires_on && v.expires_on < today ? ['Expired', 'badge-off']
    : v.max_uses !== null && v.uses >= v.max_uses ? ['Used', ''] : ['Ready', 'badge-ok'];
  const shown = (rows ?? []).filter((v) => filter === 'all' || (filter === 'open') === (state(v)[0] === 'Ready'));

  return (
    <div className="stack rw-admin">
      <div>
        <h1 className="page-title">Vouchers</h1>
        <p className="muted small">Make discount codes for customers and partners. They type the code at "Review your booking" before paying.</p>
      </div>
      <div className="rw-layout">
        <form className="card rw-rules" onSubmit={create} aria-labelledby="vg-h">
          <div className="rw-card-head"><div><h2 id="vg-h">Generate codes</h2><p className="tiny muted">For court bookings.</p></div></div>
          <div>
            <span className="field-label">Discount type</span>
            <div className="chip-row" role="radiogroup" aria-label="Discount type">
              <button type="button" role="radio" aria-checked={kind === 'percent'} className={`chip${kind === 'percent' ? ' is-active' : ''}`} onClick={() => setKind('percent')}>Percent (%)</button>
              <button type="button" role="radio" aria-checked={kind === 'amount'} className={`chip${kind === 'amount' ? ' is-active' : ''}`} onClick={() => setKind('amount')}>Amount ({settings.currency === 'PHP' ? '₱' : settings.currency})</button>
            </div>
          </div>
          <div className="form-2">
            <Field label={kind === 'percent' ? 'Percent off' : 'Amount off (₱)'}>
              <input type="number" min={1} max={kind === 'percent' ? 100 : undefined} step={kind === 'percent' ? 1 : 'any'} value={value} onChange={(e) => setValue(e.target.value)} required />
            </Field>
            <Field label="How many codes">
              <input type="number" min={1} max={100} step={1} value={count} onChange={(e) => setCount(e.target.value)} required />
            </Field>
            <Field label="Uses per code" hint="Empty = unlimited">
              <input type="number" min={1} step={1} value={uses} onChange={(e) => setUses(e.target.value)} placeholder="Unlimited" />
            </Field>
            <Field label="Valid until (optional)">
              <input type="date" value={expires} min={today} onChange={(e) => setExpires(e.target.value)} />
            </Field>
          </div>
          <Field label="For whom (optional)" hint="Only staff see this, e.g. a customer or partner name">
            <input type="text" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Tanauan Pickleball Club" />
          </Field>
          <Field label="Your own code (optional)" hint="Leave empty to get a random code like YPJ-7KQ2MX">
            <input type="text" maxLength={24} value={custom} onChange={(e) => setCustom(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))} placeholder="e.g. OPENING50" />
          </Field>
          <Toggle checked={once} onChange={setOnce} label="Each customer can use a code only once" />
          {formError && <Notice kind="error">{formError}</Notice>}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Creating…' : <><Icon name="plus" size={16} /> Generate</>}</button>
          {fresh.length > 0 && (
            <div className="voucher-fresh">
              <div className="title-row">
                <strong className="small">New: {worth(fresh[0])}</strong>
                <button type="button" className="btn btn-sm btn-outline" onClick={() => void doCopy(fresh.map((f) => f.code).join('\n'), fresh.length === 1 ? 'Code' : 'All codes')}><Icon name="copy" size={15} /> Copy{fresh.length > 1 ? ' all' : ''}</button>
              </div>
              <ul className="voucher-codes">{fresh.map((f) => <li key={f.id}><code>{f.code}</code></li>)}</ul>
            </div>
          )}
        </form>

        <section className="card rw-catalog" aria-labelledby="vl-h">
          <div className="rw-card-head">
            <div><h2 id="vl-h">All codes</h2><p className="tiny muted">{rows ? `${rows.length} code${rows.length === 1 ? '' : 's'}` : ' '}</p></div>
            <div className="chip-row" role="radiogroup" aria-label="Show">
              {(['all', 'open', 'used'] as const).map((f) => (
                <button key={f} type="button" role="radio" aria-checked={filter === f} className={`chip${filter === f ? ' is-active' : ''}`} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : f === 'open' ? 'Ready' : 'Used / off'}</button>
              ))}
            </div>
          </div>
          {error && <Notice kind="error">{error}</Notice>}
          {rows === null && !error && <Spinner />}
          {rows !== null && shown.length === 0 && <Empty icon="ticket" title={rows.length === 0 ? 'No voucher codes yet' : 'No codes in this view'}>Generate a code on the left.</Empty>}
          <ul className="voucher-list">
            {shown.map((v) => {
              const [label, cls] = state(v);
              return (
                <li key={v.id} className={`voucher-item${label === 'Ready' ? '' : ' is-dim'}`}>
                  <button type="button" className="voucher-code" onClick={() => void doCopy(v.code, v.code)} title="Copy code"><code>{v.code}</code><Icon name="copy" size={14} /></button>
                  <span className="voucher-main">
                    <strong>{worth(v)} <span className={`badge ${cls}`}>{label}</span></strong>
                    <span className="tiny muted">
                      {v.note ? `${v.note} · ` : ''}used {v.uses}{v.max_uses !== null ? ` of ${v.max_uses}` : ''}
                      {Number(v.discount_given) > 0 ? ` · ${money(Number(v.discount_given))} given` : ''}
                      {v.expires_on ? ` · until ${fmtDateShort(`${v.expires_on}T00:00:00+08:00`)}` : ''}
                    </span>
                  </span>
                  <span className="rw-actions">
                    <Toggle checked={v.is_active} onChange={(on) => void setActive(v, on)} label={v.is_active ? 'On' : 'Off'} />
                    <button type="button" className="icon-btn icon-btn-danger" onClick={() => setRemoving(v)} aria-label={`Delete ${v.code}`}><Icon name="trash" size={16} /></button>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
      {removing && (
        <Confirm title={`Delete ${removing.code}?`} confirmLabel="Delete" danger busy={busy} onConfirm={() => void remove()} onClose={() => setRemoving(null)}>
          <p>The code stops working. Bookings that already used it keep their discount.</p>
        </Confirm>
      )}
    </div>
  );
}
