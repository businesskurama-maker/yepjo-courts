import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
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

  const shown = (rows ?? []).filter((r) => r.is_active).length;
  return (
    <div className="stack rw-admin">
      <div className="title-row">
        <div>
          <h1 className="page-title">Rewards</h1>
          <p className="muted small">Loyalty points members earn, and what they can trade them for.</p>
        </div>
        <Link to="/admin/scan" className="btn btn-primary btn-sm"><Icon name="scan" size={16} /> Scan member QR</Link>
      </div>
      <div className="rw-layout">
        <PointRules />
        <section className="card rw-catalog" aria-labelledby="rw-cat">
          <div className="rw-card-head">
            <div>
              <h2 id="rw-cat">Reward catalog</h2>
              <p className="tiny muted">{rows ? `${rows.length} reward${rows.length === 1 ? '' : 's'} · ${shown} shown to members` : ' '}</p>
            </div>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> Add reward</button>
          </div>
          {error && <Notice kind="error">{error}</Notice>}
          {rows === null && !error && <Spinner />}
          <ul className="rw-grid">
            {(rows ?? []).map((r) => (
              <li key={r.id} className={`rw-item${r.is_active ? '' : ' is-hidden'}`}>
                <span className="rw-media">
                  {r.image_path ? <img src={photoUrl(r.image_path)} alt="" loading="lazy" /> : <span className="rw-art" aria-hidden="true"><Icon name="gift" size={28} /></span>}
                  <span className="rw-cost"><Icon name="star" size={12} /> {fmtPoints(Number(r.points_cost))} pts</span>
                  {!r.is_active && <span className="rw-hidden-tag">Hidden</span>}
                </span>
                <span className="rw-body">
                  <strong className="rw-title">{r.title}</strong>
                  <span className="tiny muted rw-desc">{r.description || 'No details'}</span>
                </span>
                <span className="rw-foot">
                  <Toggle checked={r.is_active} onChange={(v) => void active(r, v)} label={r.is_active ? 'Shown' : 'Hidden'} />
                  <span className="rw-actions">
                    <button type="button" className="icon-btn" onClick={() => setEditing(r)} aria-label={`Edit ${r.title}`}><Icon name="edit" size={17} /></button>
                    <button type="button" className="icon-btn icon-btn-danger" onClick={() => setRemoving(r)} aria-label={`Remove ${r.title}`}><Icon name="trash" size={17} /></button>
                  </span>
                </span>
              </li>
            ))}
            <li>
              <button type="button" className="rw-add" onClick={() => setEditing('new')}><Icon name="plus" size={22} /><span>Add a reward</span><small className="muted">Free court time, coffee, merch…</small></button>
            </li>
          </ul>
          <p className="tiny muted rw-note"><Icon name="scan" size={13} /> To give a reward, scan the member's QR and pick it. The points are deducted automatically.</p>
        </section>
      </div>
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

  const dirty = f.rewards_enabled !== (settings.rewards_enabled ?? true)
    || Number(f.points_court_hours) !== Number(settings.points_court_hours ?? 3)
    || Number(f.points_purchase_amount) !== Number(settings.points_purchase_amount ?? 200)
    || Number(f.points_dance_booking) !== Number(settings.points_dance_booking ?? 1)
    || Number(f.points_event) !== Number(settings.points_event ?? 0);
  const rule = (icon: string, title: string, how: string, mode: 'auto' | 'scan', input: ReactNode, key: keyof typeof f) => (
    <li className={`rule${Number(f[key]) > 0 ? '' : ' is-off'}`}>
      <span className="rule-icon"><Icon name={icon} size={18} /></span>
      <span className="rule-text">
        <strong>{title}</strong>
        <span className="tiny muted">{how}</span>
      </span>
      <span className="rule-input">{input}</span>
      <span className={`rule-mode ${mode}`}>{Number(f[key]) > 0 ? (mode === 'auto' ? 'Automatic' : 'Scan QR') : 'Off'}</span>
    </li>
  );
  const num = (key: keyof typeof f, step: string, label: string) => (
    <input type="number" min={0} step={step} value={String(f[key])} aria-label={label} onChange={(e) => set(key, e.target.value as never)} />
  );

  return (
    <form className="card rw-rules" onSubmit={save} aria-labelledby="rules-h">
      <div className="rw-card-head">
        <div>
          <h2 id="rules-h">Earning rules</h2>
          <p className="tiny muted">Set any rule to 0 to turn it off.</p>
        </div>
        <Toggle checked={f.rewards_enabled} onChange={(v) => set('rewards_enabled', v)} label={f.rewards_enabled ? 'Program on' : 'Program paused'} />
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <ul className={`rule-list${f.rewards_enabled ? '' : ' is-paused'}`}>
        {rule('calendar', 'Court rental', '1 point for every', 'auto', <>{num('points_court_hours', '0.5', 'Court hours per point')}<span>hrs</span></>, 'points_court_hours')}
        {rule('cup', 'Food & drinks', '1 point for every', 'scan', <><span>₱</span>{num('points_purchase_amount', '1', 'Pesos per point')}</>, 'points_purchase_amount')}
        {rule('dance', 'Step Up Dance', 'Points per class booked', 'auto', <>{num('points_dance_booking', '0.5', 'Points per dance class')}<span>pts</span></>, 'points_dance_booking')}
        {rule('trophy', 'Events', 'Points per event joined', 'auto', <>{num('points_event', '0.5', 'Points per event')}<span>pts</span></>, 'points_event')}
      </ul>
      <p className="tiny muted">Automatic points are added when a booking, sign-up or cafe order is confirmed, and taken back if it is cancelled. Counter purchases earn points when you scan the member's QR.</p>
      <div className="rw-save">
        <span className="tiny muted">{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save rules'}</button>
      </div>
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
