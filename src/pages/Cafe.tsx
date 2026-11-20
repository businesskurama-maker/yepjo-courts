import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PaymentPanel } from '../components/Payment';
import { Confirm, Empty, GoogleButton, Icon, Modal, Notice, Spinner, useOnline, useToast } from '../components/ui';
import { Link } from '../lib/router';
import { photoUrl, supabase, toAppError } from '../lib/supabase';
import { fmtDateMed, fmtMoney, fmtTime, fromLocalInput, timeToMin, toLocalInput, TZ } from '../lib/time';
import type { CafeItem, CafeOrder } from '../lib/types';
import { useAuth } from '../state/auth';
import { useSite } from '../state/site';

const CART_KEY = 'yepjo:cafe-cart';
type Cart = Record<string, number>;

function readCart(): Cart {
  try { return JSON.parse(localStorage.getItem(CART_KEY) ?? '{}') as Cart; } catch { return {}; }
}

/** "07:00" → "7 AM", "13:30" → "1:30 PM" */
export function clockLabel(t: string) {
  const m = timeToMin(t);
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${((h + 11) % 12) + 1}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Minutes after Manila midnight for a timestamp. */
function manilaMinutes(ms: number) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms);
  return Number(p.find((x) => x.type === 'hour')?.value) * 60 + Number(p.find((x) => x.type === 'minute')?.value);
}

export function cafeOpenAt(ms: number, opens: string, closes: string) {
  const m = manilaMinutes(ms);
  const o = timeToMin(opens);
  const c = timeToMin(closes);
  if (o === c) return true;
  return c > o ? m >= o && m < c : m >= o || m < c;
}

/** Customer-facing order status. */
export function orderBadge(o: CafeOrder): { text: string; cls: string } {
  if (o.status === 'cancelled') return { text: 'Cancelled', cls: 'badge-off' };
  if (o.status === 'pending') {
    if (o.payment_status === 'submitted') return { text: 'Payment being checked', cls: 'badge-warn' };
    if (o.payment_status === 'rejected') return { text: 'Payment not found', cls: 'badge-off' };
    return { text: 'Awaiting payment', cls: 'badge-warn' };
  }
  if (o.status === 'paid') return { text: 'Paid · in the queue', cls: 'badge-ok' };
  if (o.status === 'preparing') return { text: 'Being prepared', cls: 'badge-ok' };
  if (o.status === 'ready') return { text: 'Ready for pickup', cls: 'badge-ready' };
  return { text: 'Picked up', cls: '' };
}

const withAmount = (o: CafeOrder): CafeOrder => ({ ...o, amount: Number(o.total) });

/** Yepjo Cafe: menu, cart and prepaid orders for pickup (now or later). */
export default function Cafe() {
  const { settings, pulse } = useSite();
  const auth = useAuth();
  const online = useOnline();
  const toast = useToast();
  const [items, setItems] = useState<CafeItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cat, setCat] = useState<string | null>(null);
  const [cart, setCart] = useState<Cart>(readCart);
  const [checkout, setCheckout] = useState(false);
  const [orders, setOrders] = useState<CafeOrder[]>([]);
  const [paying, setPaying] = useState<CafeOrder | null>(null);
  const [cancelling, setCancelling] = useState<CafeOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const userId = auth.user?.id;

  useEffect(() => {
    let alive = true;
    void supabase.from('cafe_items').select('*').order('sort_order').order('name').then(({ data, error: err }) => {
      if (!alive) return;
      if (err) setError(toAppError(err).message);
      else { setItems((data as CafeItem[]) ?? []); setError(null); }
    });
    return () => { alive = false; };
  }, [pulse]);

  const loadOrders = useCallback(async () => {
    if (!userId) return setOrders([]);
    const { data } = await supabase.from('cafe_orders').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(20);
    setOrders(((data as CafeOrder[]) ?? []).map(withAmount));
  }, [userId]);
  useEffect(() => { void loadOrders(); }, [loadOrders, pulse]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* storage unavailable */ }
  }, [cart]);
  // Keep the open payment panel in sync with live updates.
  useEffect(() => {
    if (paying) { const fresh = orders.find((o) => o.id === paying.id); if (fresh && fresh !== paying) setPaying(fresh); }
  }, [orders]); // eslint-disable-line react-hooks/exhaustive-deps

  const opens = settings.cafe_opens ?? '07:00';
  const closes = settings.cafe_closes ?? '01:00';
  const isOpen = cafeOpenAt(now, opens, closes);
  const canOrder = (settings.cafe_ordering_enabled ?? true) && settings.online_payment_enabled && !!settings.payment_qr_path;

  const orderable = (i: CafeItem) => i.is_available && i.price != null && Number(i.price) > 0;
  const cats = useMemo(() => Array.from(new Set((items ?? []).map((i) => i.category))), [items]);
  const curCat = cat && cats.includes(cat) ? cat : cats[0] ?? null;
  const catItems = useMemo(() => (items ?? []).filter((i) => i.category === curCat), [items, curCat]);
  const [pg, setPg] = useState(0);
  const [perPage, setPerPage] = useState(6);
  const [showOrders, setShowOrders] = useState(false);
  const gridRef = useRef<HTMLUListElement>(null);
  const money = (v: number) => fmtMoney(v, settings.currency).replace(/\.00$/, '');
  const per = Number(settings.points_purchase_amount ?? 0);

  const lines = useMemo(() => (items ?? []).filter((i) => cart[i.id] > 0 && orderable(i)).map((i) => ({ item: i, qty: cart[i.id] })), [items, cart]);
  const count = lines.reduce((s, l) => s + l.qty, 0);
  const total = lines.reduce((s, l) => s + l.qty * Number(l.item.price), 0);
  const setQty = (id: string, qty: number) => setCart((c) => {
    const next = { ...c };
    if (qty <= 0) delete next[id]; else next[id] = Math.min(20, qty);
    return next;
  });

  const active = orders.filter((o) => ['pending', 'paid', 'preparing', 'ready'].includes(o.status));
  const past = orders.filter((o) => !active.includes(o)).slice(0, 10);

  const cartShown = count > 0 && canOrder;
  // Fit the menu to the window: as many rows as fit above the pager / cart bar, no page scrolling.
  useLayoutEffect(() => {
    const fit = () => {
      const el = gridRef.current;
      if (!el) return;
      const nav = document.querySelector<HTMLElement>('.bottomnav');
      const navH = nav && getComputedStyle(nav).display !== 'none' ? nav.offsetHeight : 0;
      const w = el.clientWidth;
      const cols = w >= 980 ? 3 : w >= 560 ? 2 : 1;
      const avail = window.innerHeight - el.getBoundingClientRect().top - navH - 44 - (cartShown ? 72 : 0) - 10;
      const rows = Math.max(2, Math.floor((avail + 8) / 82));
      setPerPage(rows * cols);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [items, active.length, curCat, canOrder, cartShown]);
  const pages = Math.max(1, Math.ceil(catItems.length / perPage));
  const pageNo = Math.min(pg, pages - 1);
  const shown = catItems.slice(pageNo * perPage, pageNo * perPage + perPage);
  const pickCat = (c: string) => { setCat(c); setPg(0); };

  const cancelOrder = async () => {
    if (!cancelling) return;
    setBusy(true);
    const { error: err } = await supabase.rpc('cancel_cafe_order', { p_id: cancelling.id });
    setBusy(false);
    setCancelling(null);
    if (err) return toast(toAppError(err).message, 'error');
    toast('Order cancelled.');
    if (paying?.id === cancelling.id) setPaying(null);
    void loadOrders();
  };

  if (settings.cafe_visible === false && !auth.isAdmin) {
    return <div className="page page-narrow"><h1 className="page-title">Yepjo Cafe</h1><Notice>The cafe page is not available right now.</Notice></div>;
  }

  return (
    <div className="page portal cafe-page">
      {settings.cafe_visible === false && <Notice kind="info">Hidden from customers. Only administrators can see this page. Make it public in Admin → Cafe.</Notice>}
      <header className="cafe-bar card">
        <img src="/photos/cafe/cafe-logo.webp" alt="" className="cafe-logo" width={52} height={52} />
        <div className="cafe-bar-text">
          <h1 className="page-title">Yepjo Cafe</h1>
          <div className="badge-row">
            <span className={`badge ${isOpen ? 'badge-ok' : 'badge-off'}`}><Icon name="clock" size={13} /> {isOpen ? 'Open now' : 'Closed now'} · {opens.slice(0, 5) === closes.slice(0, 5) ? 'open all day' : `${clockLabel(opens)} – ${clockLabel(closes)}`}</span>
            {settings.rewards_enabled && (settings.rewards_visible !== false || auth.isAdmin) && per > 0 && (
              <Link to="/rewards" className="badge badge-gift cafe-points"><Icon name="gift" size={13} /> 1 pt per {money(per)}</Link>
            )}
            {!canOrder && items && items.length > 0 && <span className="badge">Order at the counter</span>}
          </div>
        </div>
        {userId && orders.length > 0 && (
          <button type="button" className={`btn btn-sm ${active.some((o) => o.status === 'ready') ? 'btn-primary' : 'btn-outline'}`} onClick={() => setShowOrders(true)} aria-label="My orders">
            <Icon name="list" size={16} /> <span className="hide-sm">My orders</span>{active.length ? <span className="order-count">{active.length}</span> : ''}
          </button>
        )}
      </header>

      {active.length > 0 && (
        <ul className="order-strip" aria-label="Your current orders">
          {active.map((o) => {
            const b = orderBadge(o);
            return (
              <li key={o.id}>
                <button type="button" className={`order-chip status-${o.status}`} onClick={() => (o.status === 'pending' ? setPaying(o) : setShowOrders(true))}>
                  <strong>{o.reference}</strong><span className={`badge ${b.cls}`}>{b.text}</span>
                  {o.status === 'pending' && o.payment_status !== 'submitted' && <span className="link small">Pay now</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {error && <Notice kind="error">{error}</Notice>}
      {items === null && !error && <Spinner label="Loading the menu…" />}
      {items !== null && items.length === 0 && <Empty icon="cup" title="Menu coming soon">Ask at the counter for today's food and drinks.</Empty>}

      {cats.length > 0 && (
        <div className="cafe-tabs" role="tablist" aria-label="Menu category">
          {cats.map((c) => (
            <button key={c} type="button" role="tab" aria-selected={curCat === c} className={`chip${curCat === c ? ' is-active' : ''}`} onClick={() => pickCat(c)}>
              {c} <small>{(items ?? []).filter((i) => i.category === c).length}</small>
            </button>
          ))}
        </div>
      )}

      {curCat && (
        <ul ref={gridRef} className="menu-rows" aria-label={curCat}>
          {shown.map((i) => {
            const qty = cart[i.id] ?? 0;
            const can = canOrder && orderable(i);
            const later = /from \d/i.test(i.description ?? '');
            return (
              <li key={i.id} className={`menu-row${i.is_available ? '' : ' is-out'}${qty ? ' in-cart' : ''}`}>
                {i.image_path
                  ? <img src={photoUrl(i.image_path)} alt="" loading="lazy" decoding="async" className="menu-thumb" />
                  : <span className="menu-thumb menu-thumb-art" aria-hidden="true"><Icon name="cup" size={22} /></span>}
                <span className="menu-row-text">
                  <strong className="menu-row-name">{i.name}</strong>
                  {!i.is_available
                    ? <span className="tiny warn-text">Sold out today</span>
                    : i.description && <span className={`tiny ${later ? 'menu-later' : 'muted'} menu-row-desc`}>{i.description}</span>}
                  <span className="menu-row-price">{i.price != null ? money(Number(i.price)) : <span className="muted tiny">Ask at counter</span>}</span>
                </span>
                {can && (qty === 0 ? (
                  <button type="button" className="icon-btn menu-add" onClick={() => setQty(i.id, 1)} aria-label={`Add ${i.name}`}><Icon name="plus" size={18} /></button>
                ) : (
                  <span className="qty-stepper is-compact" role="group" aria-label={`${i.name} quantity`}>
                    <button type="button" onClick={() => setQty(i.id, qty - 1)} aria-label="One less">−</button>
                    <output aria-live="polite">{qty}</output>
                    <button type="button" onClick={() => setQty(i.id, qty + 1)} aria-label="One more" disabled={qty >= 20}>+</button>
                  </span>
                ))}
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 && (
        <nav className="menu-pager" aria-label="Menu pages">
          <button type="button" className="icon-btn" onClick={() => setPg(pageNo - 1)} disabled={pageNo === 0} aria-label="Previous page"><Icon name="left" size={18} /></button>
          {pages > 6 ? <span className="pager-count">Page <b>{pageNo + 1}</b> of {pages}</span> : Array.from({ length: pages }, (_, n) => (
            <button key={n} type="button" className={`pager-dot${n === pageNo ? ' is-active' : ''}`} onClick={() => setPg(n)} aria-label={`Page ${n + 1}`} aria-current={n === pageNo ? 'page' : undefined}>{n + 1}</button>
          ))}
          <button type="button" className="icon-btn" onClick={() => setPg(pageNo + 1)} disabled={pageNo >= pages - 1} aria-label="Next page"><Icon name="right" size={18} /></button>
        </nav>
      )}

      {showOrders && (
        <Modal title="My cafe orders" onClose={() => setShowOrders(false)}>
          <div className="stack-sm">
            {active.length > 0 && (
              <ul className="order-list order-list-1">
                {active.map((o) => <OrderCard key={o.id} o={o} money={money} onPay={() => { setShowOrders(false); setPaying(o); }} onCancel={() => setCancelling(o)} />)}
              </ul>
            )}
            {past.length > 0 && <h3 className="section-h">Past orders</h3>}
            <ul className="order-list order-list-1">
              {past.map((o) => <OrderCard key={o.id} o={o} money={money} />)}
            </ul>
          </div>
        </Modal>
      )}

      {count > 0 && canOrder && (
        <div className="cart-bar" role="region" aria-label="Your order">
          <span><strong>{count} item{count === 1 ? '' : 's'}</strong> · {money(total)}</span>
          <button type="button" className="btn btn-primary" onClick={() => setCheckout(true)} disabled={!online}>
            Review order <Icon name="right" size={16} />
          </button>
        </div>
      )}

      {checkout && (
        <Checkout lines={lines} total={total} money={money} opens={opens} closes={closes} isOpen={isOpen}
          prep={settings.cafe_prep_minutes ?? 15} setQty={setQty}
          onClose={() => setCheckout(false)}
          onPlaced={(o) => { setCart({}); setCheckout(false); setPaying(withAmount(o)); void loadOrders(); }}
          signedIn={!!auth.user} profileComplete={auth.profileComplete} signIn={() => auth.signIn('/cafe')} />
      )}

      {paying && (
        <Modal title={`Order ${paying.reference}`} onClose={() => setPaying(null)}>
          <div className="stack-sm">
            <OrderSummary o={paying} money={money} />
            {paying.status === 'pending'
              ? <PaymentPanel booking={paying} rpc="submit_order_payment" what="order" onChange={(o) => { setPaying(withAmount(o)); void loadOrders(); }} />
              : <Notice kind="ok">Payment approved. Your order is in the kitchen queue. We'll mark it Ready when you can pick it up.</Notice>}
          </div>
        </Modal>
      )}

      {cancelling && (
        <Confirm title="Cancel this order?" confirmLabel="Cancel order" danger busy={busy} onConfirm={() => void cancelOrder()} onClose={() => setCancelling(null)}>
          <p>Order {cancelling.reference} · {money(Number(cancelling.total))}. Nothing has been paid yet.</p>
        </Confirm>
      )}
    </div>
  );
}

function OrderSummary({ o, money }: { o: CafeOrder; money: (v: number) => string }) {
  return (
    <div className="order-summary">
      <ul>
        {o.items.map((l) => (
          <li key={l.id}><span>{l.qty} × {l.name}</span><span>{money(l.qty * Number(l.price))}</span></li>
        ))}
      </ul>
      <p className="order-total"><span>Total</span><strong>{money(Number(o.total))}</strong></p>
      <p className="small muted"><Icon name="clock" size={14} /> {o.pickup_at ? `Pickup ${fmtDateMed(o.pickup_at)}, ${fmtTime(o.pickup_at)}` : 'Pickup as soon as it is ready'}{o.note ? ` · “${o.note}”` : ''}</p>
    </div>
  );
}

function OrderCard({ o, money, onPay, onCancel }: { o: CafeOrder; money: (v: number) => string; onPay?: () => void; onCancel?: () => void }) {
  const b = orderBadge(o);
  const unpaid = o.status === 'pending' && o.payment_status !== 'submitted';
  return (
    <li className={`card order-card status-${o.status}`}>
      <div className="order-card-head">
        <span>
          <strong>{o.reference}</strong>
          <span className="small muted"> · {o.items.reduce((s, l) => s + l.qty, 0)} item{o.items.reduce((s, l) => s + l.qty, 0) === 1 ? '' : 's'} · {money(Number(o.total))}</span>
        </span>
        <span className={`badge ${b.cls}`}>{b.text}</span>
      </div>
      <p className="small muted">{o.items.map((l) => `${l.qty}× ${l.name}`).join(', ')}</p>
      <p className="small"><Icon name="clock" size={14} /> {o.pickup_at ? `Pickup ${fmtDateMed(o.pickup_at)}, ${fmtTime(o.pickup_at)}` : 'Pickup ASAP'}</p>
      {o.status === 'ready' && <p className="ready-note"><Icon name="check" size={16} /> Ready! Show reference <strong>{o.reference}</strong> at the cafe counter.</p>}
      {o.status === 'cancelled' && o.refund_status === 'to_claim' && o.refund_amount != null && (
        <p className="refund-note small">Refund of {money(Number(o.refund_amount))} to collect in person at the venue. Show reference {o.reference}.</p>
      )}
      {o.status === 'cancelled' && o.refund_status === 'claimed' && <p className="refund-note is-done small">Refund received.</p>}
      {(onPay || onCancel) && o.status === 'pending' && (
        <div className="btn-row">
          {onPay && <button type="button" className="btn btn-sm btn-primary" onClick={onPay}>{unpaid ? 'Pay now' : 'View'}</button>}
          {onCancel && unpaid && <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button>}
        </div>
      )}
    </li>
  );
}

function Checkout({ lines, total, money, opens, closes, isOpen, prep, setQty, onClose, onPlaced, signedIn, profileComplete, signIn }: {
  lines: { item: CafeItem; qty: number }[]; total: number; money: (v: number) => string; opens: string; closes: string; isOpen: boolean;
  prep: number; setQty: (id: string, q: number) => void; onClose: () => void; onPlaced: (o: CafeOrder) => void;
  signedIn: boolean; profileComplete: boolean; signIn: () => Promise<string | null>;
}) {
  const earliest = Date.now() + (prep + 5) * 60_000;
  const [when, setWhen] = useState<'asap' | 'later'>(isOpen ? 'asap' : 'later');
  const [at, setAt] = useState(() => toLocalInput(Math.ceil(earliest / 900_000) * 900_000));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const place = async () => {
    setError(null);
    let pickup: string | null = null;
    if (when === 'later') {
      const ms = fromLocalInput(at);
      if (!at || Number.isNaN(ms)) return setError('Choose a pickup date and time.');
      if (ms < Date.now() + prep * 60_000) return setError(`Choose a pickup time at least ${prep} minutes from now.`);
      if (!cafeOpenAt(ms, opens, closes)) return setError(`Pickup must be during cafe hours, ${clockLabel(opens)} – ${clockLabel(closes)}.`);
      pickup = new Date(ms).toISOString();
    }
    setBusy(true);
    const { data, error: err } = await supabase.rpc('place_cafe_order', {
      p_items: lines.map((l) => ({ id: l.item.id, qty: l.qty })), p_pickup_at: pickup, p_note: note.trim() || null,
    });
    setBusy(false);
    if (err) return setError(toAppError(err).message);
    onPlaced(data as CafeOrder);
  };

  return (
    <Modal title="Your order" onClose={onClose} footer={signedIn && profileComplete ? (
      <>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Keep browsing</button>
        <button type="button" className="btn btn-primary" onClick={() => void place()} disabled={busy || lines.length === 0}>
          {busy ? 'Placing…' : `Place order · ${money(total)}`}
        </button>
      </>
    ) : undefined}>
      <div className="stack-sm">
        <ul className="cart-lines">
          {lines.map(({ item, qty }) => (
            <li key={item.id}>
              <span className="cart-name">{item.name}<small className="muted">{money(Number(item.price))} each</small></span>
              <span className="qty-stepper" role="group" aria-label={`${item.name} quantity`}>
                <button type="button" onClick={() => setQty(item.id, qty - 1)} aria-label="One less">−</button>
                <output>{qty}</output>
                <button type="button" onClick={() => setQty(item.id, qty + 1)} aria-label="One more" disabled={qty >= 20}>+</button>
              </span>
              <strong className="cart-sum">{money(qty * Number(item.price))}</strong>
            </li>
          ))}
        </ul>
        <p className="order-total"><span>Total</span><strong>{money(total)}</strong></p>

        <fieldset className="pay-choice">
          <legend className="field-label">When will you pick it up?</legend>
          <label className={`pay-option${when === 'asap' ? ' is-active' : ''}${!isOpen ? ' is-disabled' : ''}`}>
            <input type="radio" name="when" checked={when === 'asap'} disabled={!isOpen} onChange={() => setWhen('asap')} />
            <span><strong>As soon as possible</strong><small>{isOpen ? `About ${prep} minutes after Yepjo approves your payment.` : 'The cafe is closed right now.'}</small></span>
          </label>
          <label className={`pay-option${when === 'later' ? ' is-active' : ''}`}>
            <input type="radio" name="when" checked={when === 'later'} onChange={() => setWhen('later')} />
            <span><strong>Order in advance</strong><small>Pick a time up to 7 days ahead, {clockLabel(opens)} – {clockLabel(closes)}.</small></span>
          </label>
        </fieldset>
        {when === 'later' && (
          <label className="field">
            <span className="field-label">Pickup date and time</span>
            <input type="datetime-local" value={at} step={900} min={toLocalInput(Date.now() + prep * 60_000)} max={toLocalInput(Date.now() + 7 * 86_400_000)}
              onChange={(e) => setAt(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span className="field-label">Note for the kitchen (optional)</span>
          <input type="text" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. less ice, extra rice" />
        </label>
        <p className="tiny muted">Pay by QR after placing the order. Yepjo starts preparing it once your payment is approved.</p>
        {error && <Notice kind="error">{error}</Notice>}
        {!signedIn ? (
          <GoogleButton onClick={() => void signIn()} label="Sign in with Google to order" />
        ) : !profileComplete ? (
          <Notice kind="warn">Add your name and contact number first. <Link to="/welcome" className="link">Complete profile</Link></Notice>
        ) : null}
      </div>
    </Modal>
  );
}
