import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PhotoPicker } from '../components/PhotoPicker';
import { Confirm, Field, Icon, Modal, Notice, Spinner, Toggle, useToast } from '../components/ui';
import { Link } from '../lib/router';
import { photoUrl, supabase, toAppError } from '../lib/supabase';
import type { Reward } from '../lib/types';
import { fmtPoints } from '../pages/Rewards';
import { useSite } from '../state/site';

/** Admin: how points are earned, and the rewards members can claim. */
export default function RewardsAdmin() {
  const { pulse } = useSite();
  const toast = useToast();
  const [rows, setRows] = useState<Reward[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Reward | 'new' | null>(null);
  const [removing, setRemoving] = useState<Reward | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.from('rewards').select('*').order('sort_order').order('points_cost');
    if (err) setError(toAppError(err).message);
    else { setRows((data as Reward[]) ?? []); setError(null); }
  }, []);
  useEffect(() => { void load(); }, [load, pulse]);

  const active = async (r: Reward, v: boolean) => {
    const { error: err } = await supabase.from('rewards').update({ is_active: v }).eq('id', r.id);
    if (err) toast(toAppError(err).message, 'error');
    void load();
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const { error: err } = await supabase.from('rewards').delete().eq('id', removing.id);
    setBusy(false);
    setRemoving(null);
    if (err) return toast(toAppError(err).message, 'error');
    toast('Reward removed.');
    void load();
  };

  return (
    <div className="stack">
      <div className="title-row">
        <h1 className="page-title">Rewards</h1>
        <Link to="/admin/scan" className="btn btn-primary btn-sm"><Icon name="scan" size={16} /> Scan member QR</Link>
      </div>
      <PointRules />
      <section className="card stack-sm" aria-labelledby="rw-cat">
        <div className="card-head">
          <h2 id="rw-cat">Rewards to claim</h2>
          <button type="button" className="btn btn-sm btn-outline" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> Add reward</button>
        </div>
        <p className="muted small">Members see these on their Rewards page. To give one, scan the member's QR and choose the reward; the points are deducted.</p>
        {error && <Notice kind="error">{error}</Notice>}
        {rows === null && !error && <Spinner />}
        <ul className="rows">
          {(rows ?? []).map((r) => (
            <li key={r.id} className="row row-photo">
              {r.image_path ? <img className="thumb" src={photoUrl(r.image_path)} alt="" /> : <span className="thumb reward-img-art"><Icon name="gift" size={18} /></span>}
              <span className="row-main">
                <strong>{r.title} <span className="reward-cost">{fmtPoints(Number(r.points_cost))} pts</span></strong>
                {r.description && <span className="small muted clamp-1">{r.description}</span>}
                <Toggle checked={r.is_active} onChange={(v) => void active(r, v)} label={r.is_active ? 'Shown' : 'Hidden'} />
              </span>
              <span className="row-actions">
                <button type="button" className="btn btn-sm" onClick={() => setEditing(r)}><Icon name="edit" size={16} /> Edit</button>
                <button type="button" className="icon-btn" onClick={() => setRemoving(r)} aria-label={`Remove ${r.title}`}><Icon name="trash" size={18} /></button>
              </span>
            </li>
          ))}
          {rows !== null && rows.length === 0 && <li className="muted small">No rewards yet.</li>}
        </ul>
      </section>
      {editing && <RewardDialog reward={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {removing && (
        <Confirm title={`Remove ${removing.title}?`} confirmLabel="Remove" danger busy={busy} onConfirm={() => void remove()} onClose={() => setRemoving(null)}>
          <p>Members can no longer claim it. Points already used are not affected.</p>
        </Confirm>
      )}
    </div>
  );
}

function PointRules() {
  const { settings, reload } = useSite();
  const toast = useToast();
  const [f, setF] = useState(() => ({
    rewards_enabled: settings.rewards_enabled ?? true,
    points_court_hours: String(settings.points_court_hours ?? 3),
    points_purchase_amount: String(settings.points_purchase_amount ?? 200),
    points_dance_booking: String(settings.points_dance_booking ?? 1),
    points_event: String(settings.points_event ?? 0),
  }));
  useEffect(() => {
    setF({
      rewards_enabled: settings.rewards_enabled ?? true,
      points_court_hours: String(settings.points_court_hours ?? 3),
      points_purchase_amount: String(settings.points_purchase_amount ?? 200),
      points_dance_booking: String(settings.points_dance_booking ?? 1),
      points_event: String(settings.points_event ?? 0),
    });
  }, [settings]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const nums = { points_court_hours: Number(f.points_court_hours), points_purchase_amount: Number(f.points_purchase_amount), points_dance_booking: Number(f.points_dance_booking), points_event: Number(f.points_event) };
    if (Object.values(nums).some((n) => !Number.isFinite(n) || n < 0)) return setError('Use numbers of 0 or more (0 turns that rule off).');
    setBusy(true);
    const { error: err } = await supabase.from('settings').update({ rewards_enabled: f.rewards_enabled, ...nums }).eq('id', true);
    setBusy(false);
    if (err) return setError(toAppError(err).message);
    toast('Point rules saved. They apply from now on.');
    void reload();
  };

  return (
    <form className="card form" onSubmit={save} aria-labelledby="rules-h">
      <h2 id="rules-h">How members earn points</h2>
      {error && <Notice kind="error">{error}</Notice>}
      <Toggle checked={f.rewards_enabled} onChange={(v) => set('rewards_enabled', v)} label="Yepjo Rewards is on" />
      <div className="rule-grid">
        <Field label="Court rental" hint="Hours of court time for 1 point (e.g. 3 = 1 point per 3 hours). Automatic.">
          <span className="input-suffix"><input type="number" min={0} step="0.5" value={f.points_court_hours} onChange={(e) => set('points_court_hours', e.target.value)} /><span>hours = 1 pt</span></span>
        </Field>
        <Field label="Purchases (food, drinks, counter)" hint="Pesos spent for 1 point (e.g. 200). Given when you scan the member's QR.">
          <span className="input-suffix"><span>₱</span><input type="number" min={0} step="1" value={f.points_purchase_amount} onChange={(e) => set('points_purchase_amount', e.target.value)} /><span>= 1 pt</span></span>
        </Field>
        <Field label="Step Up Dance class" hint="Points per class booked. Automatic.">
          <span className="input-suffix"><input type="number" min={0} step="0.5" value={f.points_dance_booking} onChange={(e) => set('points_dance_booking', e.target.value)} /><span>pts</span></span>
        </Field>
        <Field label="Event registration" hint="Points per event joined (0 = none). Automatic.">
          <span className="input-suffix"><input type="number" min={0} step="0.5" value={f.points_event} onChange={(e) => set('points_event', e.target.value)} /><span>pts</span></span>
        </Field>
      </div>
      <p className="tiny muted">Points are added when a booking or sign-up is confirmed, and taken back if it is cancelled. Set a rule to 0 to turn it off.</p>
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save rules'}</button>
    </form>
  );
}

function RewardDialog({ reward, onClose, onSaved }: { reward: Reward | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    title: reward?.title ?? '', description: reward?.description ?? '', points_cost: String(reward?.points_cost ?? 10),
    image_path: reward?.image_path ?? (null as string | null), is_active: reward?.is_active ?? true, sort_order: String(reward?.sort_order ?? 0),
  });
  const [photo, setPhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const cost = Number(f.points_cost);
    if (f.title.trim().length < 2) return setError('Name the reward, e.g. Free 1 hour court.');
    if (!Number.isFinite(cost) || cost <= 0) return setError('Points needed must be more than 0.');
    setBusy(true);
    const payload = { title: f.title.trim(), description: f.description.trim() || null, points_cost: cost, image_path: f.image_path, is_active: f.is_active, sort_order: Number(f.sort_order) || 0, updated_at: new Date().toISOString() };
    const { error: err } = reward ? await supabase.from('rewards').update(payload).eq('id', reward.id) : await supabase.from('rewards').insert(payload);
    setBusy(false);
    if (err) return setError(toAppError(err).message);
    toast(reward ? 'Reward updated.' : 'Reward added.');
    onSaved();
  };

  return (
    <Modal title={reward ? 'Edit reward' : 'Add reward'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        {error && <Notice kind="error">{error}</Notice>}
        <Field label="Reward"><input type="text" value={f.title} maxLength={80} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Free iced coffee" required /></Field>
        <Field label="Details (optional)"><input type="text" value={f.description} maxLength={300} onChange={(e) => set('description', e.target.value)} /></Field>
        <div className="form-2">
          <Field label="Points needed"><input type="number" min={0.5} step="0.5" value={f.points_cost} onChange={(e) => set('points_cost', e.target.value)} required /></Field>
          <Field label="Order" hint="Lower comes first"><input type="number" value={f.sort_order} onChange={(e) => set('sort_order', e.target.value)} /></Field>
        </div>
        <div className="photo-field">
          {f.image_path ? <img src={photoUrl(f.image_path)} alt="" className="thumb thumb-lg" /> : <span className="muted small">No photo</span>}
          <button type="button" className="btn btn-sm btn-outline" onClick={() => setPhoto(true)}><Icon name="image" size={16} /> {f.image_path ? 'Change photo' : 'Add photo'}</button>
          {f.image_path && <button type="button" className="btn btn-sm btn-ghost" onClick={() => set('image_path', null)}>Remove</button>}
        </div>
        <Toggle checked={f.is_active} onChange={(v) => set('is_active', v)} label="Show to members" />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Saving…' : reward ? 'Save changes' : 'Add reward'}</button>
      </form>
      {photo && <PhotoPicker folder="announcements" title="Reward photo" onClose={() => setPhoto(false)} onUploaded={(p) => { set('image_path', p); setPhoto(false); }} />}
    </Modal>
  );
}
