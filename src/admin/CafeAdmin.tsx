import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PhotoPicker } from '../components/PhotoPicker';
import { Confirm, Empty, Field, Icon, Modal, Notice, Spinner, Toggle, useToast } from '../components/ui';
import { photoUrl, supabase, toAppError } from '../lib/supabase';
import { fmtMoney } from '../lib/time';
import type { CafeItem } from '../lib/types';
import { useSite } from '../state/site';
import { CafeOrdersAdmin, CafeSettingsCard } from './CafeOrders';

/** Admin: Yepjo Cafe menu (categories, items, prices, photos, availability). */
export default function CafeAdmin() {
  const { settings, pulse } = useSite();
  const toast = useToast();
  const [rows, setRows] = useState<CafeItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CafeItem | 'new' | null>(null);
  const [removing, setRemoving] = useState<CafeItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'orders' | 'menu'>('orders');

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.from('cafe_items').select('*').order('category').order('sort_order').order('name');
    if (err) setError(toAppError(err).message);
    else { setRows((data as CafeItem[]) ?? []); setError(null); }
  }, []);
  useEffect(() => { void load(); }, [load, pulse]);

  const available = async (i: CafeItem, v: boolean) => {
    const { error: err } = await supabase.from('cafe_items').update({ is_available: v }).eq('id', i.id);
    if (err) toast(toAppError(err).message, 'error');
    void load();
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const { error: err } = await supabase.from('cafe_items').delete().eq('id', removing.id);
    setBusy(false);
    setRemoving(null);
    if (err) return toast(toAppError(err).message, 'error');
    toast('Item removed from the menu.');
    void load();
  };
  const cats = Array.from(new Set((rows ?? []).map((r) => r.category)));

  return (
    <div className="stack">
      <h1 className="page-title">Yepjo Cafe</h1>
      <CafeSettingsCard unpriced={(rows ?? []).filter((r) => r.price == null).length} />
      <div className="tabs" role="tablist" aria-label="Cafe">
        <button type="button" role="tab" aria-selected={tab === 'orders'} className={`tab${tab === 'orders' ? ' is-active' : ''}`} onClick={() => setTab('orders')}>Orders</button>
        <button type="button" role="tab" aria-selected={tab === 'menu'} className={`tab${tab === 'menu' ? ' is-active' : ''}`} onClick={() => setTab('menu')}>Menu</button>
      </div>
      {tab === 'orders' ? <CafeOrdersAdmin /> : (<>
      <div className="title-row">
        <p className="muted small">Shown on the Cafe page. Turn an item off when it runs out today. Items need a price to be ordered online.</p>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> Add item</button>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {rows === null && !error && <Spinner />}
      {rows !== null && rows.length === 0 && <Empty icon="cup" title="No menu items yet">Add food and drinks with Add item.</Empty>}
      {cats.map((c) => (
        <section key={c} className="stack-sm">
          <h2 className="day-head">{c}</h2>
          <ul className="rows card">
            {(rows ?? []).filter((r) => r.category === c).map((i) => (
              <li key={i.id} className="row row-photo">
                {i.image_path ? <img className="thumb" src={photoUrl(i.image_path)} alt="" /> : <span className="thumb portal-img-art"><Icon name="cup" size={18} /></span>}
                <span className="row-main">
                  <strong>{i.name}{i.price != null ? <span className="ok-text"> · {fmtMoney(Number(i.price), settings.currency)}</span> : <span className="badge badge-warn">No price</span>}</strong>
                  {i.description && <span className="small muted clamp-1">{i.description}</span>}
                  <Toggle checked={i.is_available} onChange={(v) => void available(i, v)} label={i.is_available ? 'Available' : 'Not available today'} />
                </span>
                <span className="row-actions">
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(i)}><Icon name="edit" size={16} /> Edit</button>
                  <button type="button" className="icon-btn" onClick={() => setRemoving(i)} aria-label={`Remove ${i.name}`}><Icon name="trash" size={18} /></button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      </>)}
      {editing && <ItemDialog item={editing === 'new' ? null : editing} categories={cats} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {removing && (
        <Confirm title={`Remove ${removing.name}?`} confirmLabel="Remove" danger busy={busy} onConfirm={() => void remove()} onClose={() => setRemoving(null)}>
          <p>It disappears from the Cafe page. To hide it just for today, switch it to Not available instead.</p>
        </Confirm>
      )}
    </div>
  );
}

function ItemDialog({ item, categories, onClose, onSaved }: { item: CafeItem | null; categories: string[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    category: item?.category ?? categories[0] ?? 'Breakfast',
    name: item?.name ?? '', description: item?.description ?? '',
    price: item?.price != null ? String(item.price) : '', image_path: item?.image_path ?? (null as string | null),
    is_available: item?.is_available ?? true, sort_order: String(item?.sort_order ?? 0),
  });
  const [photo, setPhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const price = f.price.trim() === '' ? null : Number(f.price);
    if (!f.name.trim()) return setError('Enter the item name.');
    if (!f.category.trim()) return setError('Enter a category, e.g. Breakfast or Drinks.');
    if (price !== null && (!Number.isFinite(price) || price < 0)) return setError('Enter a valid price, or leave it empty.');
    setBusy(true);
    const payload = {
      category: f.category.trim(), name: f.name.trim(), description: f.description.trim() || null, price,
      image_path: f.image_path, is_available: f.is_available, sort_order: Number(f.sort_order) || 0, updated_at: new Date().toISOString(),
    };
    const { error: err } = item ? await supabase.from('cafe_items').update(payload).eq('id', item.id) : await supabase.from('cafe_items').insert(payload);
    setBusy(false);
    if (err) return setError(toAppError(err).message);
    toast(item ? 'Item updated.' : 'Item added to the menu.');
    onSaved();
  };

  return (
    <Modal title={item ? 'Edit menu item' : 'Add menu item'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        {error && <Notice kind="error">{error}</Notice>}
        <Field label="Category"><input type="text" list="cafe-cats" value={f.category} maxLength={40} onChange={(e) => set('category', e.target.value)} required /></Field>
        <datalist id="cafe-cats">{[...new Set([...categories, 'Breakfast', 'Rice meals', 'Snacks', 'Coffee', 'Drinks'])].map((c) => <option key={c} value={c} />)}</datalist>
        <Field label="Name"><input type="text" value={f.name} maxLength={80} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Tapsilog" required /></Field>
        <Field label="Description (optional)"><input type="text" value={f.description} maxLength={300} onChange={(e) => set('description', e.target.value)} /></Field>
        <div className="form-2">
          <Field label="Price (₱)" hint="Needed for online orders"><input type="number" min={0} step="1" value={f.price} onChange={(e) => set('price', e.target.value)} /></Field>
          <Field label="Order in its category" hint="Lower comes first"><input type="number" value={f.sort_order} onChange={(e) => set('sort_order', e.target.value)} /></Field>
        </div>
        <div className="photo-field">
          {f.image_path ? <img src={photoUrl(f.image_path)} alt="" className="thumb thumb-lg" /> : <span className="muted small">No photo</span>}
          <button type="button" className="btn btn-sm btn-outline" onClick={() => setPhoto(true)}><Icon name="image" size={16} /> {f.image_path ? 'Change photo' : 'Add photo'}</button>
          {f.image_path && <button type="button" className="btn btn-sm btn-ghost" onClick={() => set('image_path', null)}>Remove</button>}
        </div>
        <Toggle checked={f.is_available} onChange={(v) => set('is_available', v)} label="Available today" />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Saving…' : item ? 'Save changes' : 'Add item'}</button>
      </form>
      {photo && <PhotoPicker folder="announcements" title="Menu photo" onClose={() => setPhoto(false)} onUploaded={(p) => { set('image_path', p); setPhoto(false); }} />}
    </Modal>
  );
}
