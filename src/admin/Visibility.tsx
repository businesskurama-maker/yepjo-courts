import { useState } from 'react';
import { Toggle, useToast } from '../components/ui';
import { supabase, toAppError } from '../lib/supabase';
import { useSite } from '../state/site';

const PAGES = {
  cafe_visible: { name: 'Cafe', hidden: 'Customers cannot see the Cafe page or order online. You can still prepare the menu here.' },
  rewards_visible: { name: 'Loyalty Rewards', hidden: 'Customers cannot see the Rewards page, their points or the reward list. You can still set it up here.' },
} as const;
export type VisibilityField = keyof typeof PAGES;

/** Admin switch: show a customer page to the public, or hide it. Saves at once. */
export function VisibilitySwitch({ field }: { field: VisibilityField }) {
  const { settings, reload } = useSite();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<boolean | null>(null);
  const on = local ?? settings[field] ?? true;
  const { name, hidden } = PAGES[field];

  const change = async (v: boolean) => {
    setBusy(true); setLocal(v);
    const { error } = await supabase.from('settings').update({ [field]: v }).eq('id', true);
    setBusy(false);
    if (error) { setLocal(null); return toast(toAppError(error).message, 'error'); }
    toast(v ? `${name} is now public. Customers can see it.` : `${name} is now hidden from customers.`);
    await reload();
    setLocal(null);
  };

  return (
    <section className={`card visibility${on ? '' : ' is-hidden'}`}>
      <div>
        <strong>{name} page {on ? <span className="badge badge-ok">Public</span> : <span className="badge badge-off">Hidden</span>}</strong>
        <p className="small muted">{on ? `Customers can see ${name} in the menu.` : hidden}</p>
      </div>
      <Toggle checked={on} disabled={busy} onChange={(v) => void change(v)} label={on ? 'Public (live)' : 'Hidden'} />
    </section>
  );
}
