import { useCallback, useEffect, useState } from 'react';
import { Confirm, Icon, useToast } from '../components/ui';
import { supabase, toAppError } from '../lib/supabase';
import { fmtDateShort, fmtMoney } from '../lib/time';
import { useSite } from '../state/site';

interface Refund {
  kind: 'reservation' | 'registration' | 'order'; id: string; reference: string; customer_name: string | null; customer_phone: string | null;
  what: string; amount: number; fee: number | null; refund: number; cancelled_at: string;
}

/** Refunds to hand over in person at the counter (the online part is never refunded online). */
export function RefundsPanel() {
  const { settings, pulse } = useSite();
  const toast = useToast();
  const [rows, setRows] = useState<Refund[]>([]);
  const [giving, setGiving] = useState<Refund | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.rpc('admin_refunds_to_claim');
    setRows((data as Refund[]) ?? []);
  }, []);
  useEffect(() => { void load(); }, [load, pulse]);

  const give = async () => {
    if (!giving) return;
    setBusy(true);
    const { error } = await supabase.rpc('admin_mark_refund_claimed', { p_kind: giving.kind, p_id: giving.id });
    setBusy(false);
    setGiving(null);
    if (error) return toast(toAppError(error).message, 'error');
    toast(`Refund for ${giving.reference} marked as given.`);
    void load();
  };

  if (rows.length === 0) return null;
  const money = (v: number) => fmtMoney(Number(v), settings.currency);
  return (
    <section className="card stack-sm refunds" aria-labelledby="refunds-h">
      <h2 id="refunds-h"><Icon name="alert" size={18} /> Refunds to hand over ({rows.length})</h2>
      <p className="small muted">Customers claim these in person. Check their reference, give the cash, then mark it as given.</p>
      <ul className="rows">
        {rows.map((r) => (
          <li key={`${r.kind}-${r.id}`} className="row">
            <span className="row-main">
              <strong>{r.customer_name ?? 'Customer'} · <span className="ok-text">{money(r.refund)}</span></strong>
              <span className="small muted">{r.reference} · {r.what} · paid {money(r.amount)}{Number(r.fee ?? 0) > 0 ? `, fee kept ${money(Number(r.fee))}` : ''} · cancelled {fmtDateShort(r.cancelled_at)}</span>
              {r.customer_phone && <a href={`tel:${r.customer_phone}`} className="small link">{r.customer_phone}</a>}
            </span>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setGiving(r)}>Refund given</button>
          </li>
        ))}
      </ul>
      {giving && (
        <Confirm title={`Give ${money(giving.refund)} to ${giving.customer_name ?? 'the customer'}?`} confirmLabel="Refund given" busy={busy} onConfirm={() => void give()} onClose={() => setGiving(null)}>
          <p>Reference <strong>{giving.reference}</strong>. Mark it only after the customer has received the money.</p>
        </Confirm>
      )}
    </section>
  );
}
