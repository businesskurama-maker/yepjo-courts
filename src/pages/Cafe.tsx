import { useEffect, useMemo, useState } from 'react';
import { Empty, Icon, Notice, Spinner } from '../components/ui';
import { Link } from '../lib/router';
import { photoUrl, supabase, toAppError } from '../lib/supabase';
import { fmtMoney } from '../lib/time';
import type { CafeItem } from '../lib/types';
import { useSite } from '../state/site';

/** Yepjo Cafe menu, managed by admins. */
export default function Cafe() {
  const { settings, pulse } = useSite();
  const [items, setItems] = useState<CafeItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cat, setCat] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void supabase.from('cafe_items').select('*').order('sort_order').order('name').then(({ data, error: err }) => {
      if (!alive) return;
      if (err) setError(toAppError(err).message);
      else { setItems((data as CafeItem[]) ?? []); setError(null); }
    });
    return () => { alive = false; };
  }, [pulse]);

  const cats = useMemo(() => Array.from(new Set((items ?? []).map((i) => i.category))), [items]);
  const groups = cats.filter((c) => !cat || c === cat).map((c) => [c, (items ?? []).filter((i) => i.category === c)] as const);
  const money = (v: number) => fmtMoney(v, settings.currency).replace(/\.00$/, '');
  const per = Number(settings.points_purchase_amount ?? 0);

  return (
    <div className="page portal">
      <header className="portal-head">
        <div>
          <h1 className="page-title">Yepjo Cafe</h1>
          <p className="muted small">All-day breakfast, coffee and snacks, right by the courts.</p>
        </div>
        {settings.rewards_enabled && per > 0 && (
          <Link to="/rewards" className="badge badge-ok cafe-points"><Icon name="gift" size={14} /> 1 point for every {money(per)} spent. Show your Rewards QR</Link>
        )}
      </header>

      {error && <Notice kind="error">{error}</Notice>}
      {items === null && !error && <Spinner label="Loading the menu…" />}
      {items !== null && items.length === 0 && <Empty icon="cup" title="Menu coming soon">Ask at the counter for today's food and drinks.</Empty>}

      {cats.length > 1 && (
        <div className="chip-row" role="radiogroup" aria-label="Category">
          <button type="button" role="radio" aria-checked={!cat} className={`chip${!cat ? ' is-active' : ''}`} onClick={() => setCat(null)}>All</button>
          {cats.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={cat === c} className={`chip${cat === c ? ' is-active' : ''}`} onClick={() => setCat(c)}>{c}</button>
          ))}
        </div>
      )}

      {groups.map(([c, list]) => (
        <section key={c} className="stack-sm" aria-label={c}>
          <h2 className="day-head">{c}</h2>
          <ul className="menu-grid">
            {list.map((i) => (
              <li key={i.id} className={`card menu-item${i.is_available ? '' : ' is-out'}`}>
                {i.image_path
                  ? <img src={photoUrl(i.image_path)} alt="" loading="lazy" decoding="async" className="menu-img" />
                  : <span className="menu-img menu-img-art" aria-hidden="true"><Icon name="cup" size={28} /></span>}
                <span className="menu-text">
                  <strong>{i.name}</strong>
                  {i.description && <span className="small muted">{i.description}</span>}
                  {!i.is_available && <span className="badge badge-off">Not available today</span>}
                </span>
                {i.price != null && <span className="portal-price">{money(Number(i.price))}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
