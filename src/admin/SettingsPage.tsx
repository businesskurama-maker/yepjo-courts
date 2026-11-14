import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Confirm, Field, Icon, Notice, Toggle, useToast } from '../components/ui';
import { PhotoPicker } from '../components/PhotoPicker';
import { photoUrl, supabase, toAppError } from '../lib/supabase';
import { fmtDateMed, fmtDuration } from '../lib/time';
import type { Settings } from '../lib/types';
import { useAuth } from '../state/auth';
import { DEFAULT_SETTINGS, useSite } from '../state/site';

interface AdminRow {
  user_id: string;
  email: string | null;
  full_name: string | null;
  added_at: string;
}

const isUrl = (v: string) => v === '' || /^https?:\/\/\S+$/i.test(v);

export default function SettingsPage() {
  const { settings, reload } = useSite();
  const auth = useAuth();
  const toast = useToast();
  const [form, setForm] = useState<Settings>(settings);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [newAdmin, setNewAdmin] = useState('');
  const [revoking, setRevoking] = useState<AdminRow | null>(null);
  const [pickingQr, setPickingQr] = useState(false);
  const [invites, setInvites] = useState<{ email: string; created_at: string }[]>([]);

  useEffect(() => {
    if (!dirty) setForm(settings);
  }, [settings, dirty]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  };

  const loadAdmins = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('admin_list');
    if (!err) setAdmins((data as AdminRow[]) ?? []);
    const inv = await supabase.from('admin_invites').select('email,created_at').order('created_at');
    if (!inv.error) setInvites((inv.data as { email: string; created_at: string }[]) ?? []);
  }, []);
  useEffect(() => {
    void loadAdmins();
  }, [loadAdmins]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.business_name.trim()) return setError('Enter the business name.');
    if (!isUrl(form.facebook_url.trim()) || !isUrl(form.reclub_url.trim())) return setError('Links must start with https://');
    if (form.max_slots < form.min_slots) return setError('The longest booking cannot be shorter than the shortest booking.');
    setBusy(true);
    const cleaned: Settings = {
      ...form,
      business_name: form.business_name.trim(), tagline: form.tagline.trim(), address: form.address.trim(),
      email: form.email.trim(), phone: form.phone.trim(), facebook_name: form.facebook_name.trim(),
      facebook_url: form.facebook_url.trim(), reclub_url: form.reclub_url.trim(), cancellation_note: form.cancellation_note.trim(),
      payment_instructions: form.payment_instructions.trim(),
    };
    if (cleaned.online_payment_enabled && !cleaned.payment_qr_path) {
      setBusy(false);
      return setError('Upload the payment QR code before turning on online payment.');
    }
    if (!cleaned.allow_pay_at_venue && !cleaned.online_payment_enabled) {
      setBusy(false);
      return setError('Keep at least one way to pay: turn on online payment or allow paying at the court.');
    }
    // Send only the editable columns (never id / updated_at).
    const payload = Object.fromEntries((Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).map((k) => [k, cleaned[k]]));
    const { error: err } = await supabase.from('settings').update(payload).eq('id', true);
    setBusy(false);
    if (err) return setError(toAppError(err).message);
    setDirty(false);
    toast('Settings saved.');
    void reload();
  };

  const grant = async (e: FormEvent) => {
    e.preventDefault();
    const { data, error: err } = await supabase.rpc('admin_grant', { p_email: newAdmin });
    if (err) return toast(toAppError(err).message, 'error');
    toast(data === 'invited'
      ? `${newAdmin.trim()} is reserved. They become an administrator the first time they sign in with Google.`
      : `${newAdmin.trim()} is now an administrator.`);
    setNewAdmin('');
    void loadAdmins();
  };
  const revoke = async () => {
    if (!revoking) return;
    const { error: err } = await supabase.rpc('admin_revoke', { p_user_id: revoking.user_id });
    if (err) toast(toAppError(err).message, 'error');
    else toast('Administrator access removed.');
    setRevoking(null);
    void loadAdmins();
  };

  const removeInvite = async (email: string) => {
    const { error: err } = await supabase.rpc('admin_invite_remove', { p_email: email });
    if (err) toast(toAppError(err).message, 'error');
    else toast('Reserved slot cleared.');
    void loadAdmins();
  };

  const num = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || min)));

  return (
    <div className="stack">
      <h1 className="page-title">Settings</h1>
      <form className="stack" onSubmit={save}>
        {error && <Notice kind="error">{error}</Notice>}

        <section className="card" aria-labelledby="set-biz">
          <h2 id="set-biz">Business details and links</h2>
          <div className="form">
            <Field label="Business name"><input type="text" value={form.business_name} onChange={(e) => set('business_name', e.target.value)} maxLength={80} required /></Field>
            <Field label="Tagline"><input type="text" value={form.tagline} onChange={(e) => set('tagline', e.target.value)} maxLength={140} /></Field>
            <Field label="Address"><input type="text" value={form.address} onChange={(e) => set('address', e.target.value)} maxLength={200} /></Field>
            <div className="form-2">
              <Field label="Email"><input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} maxLength={120} /></Field>
              <Field label="Phone (optional)"><input type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} maxLength={30} /></Field>
            </div>
            <div className="form-2">
              <Field label="Facebook page name"><input type="text" value={form.facebook_name} onChange={(e) => set('facebook_name', e.target.value)} maxLength={120} /></Field>
              <Field label="Facebook page link" hint={form.facebook_url ? undefined : 'Needs business input: paste the page URL.'}>
                <input type="url" value={form.facebook_url} onChange={(e) => set('facebook_url', e.target.value)} placeholder="https://www.facebook.com/…" />
              </Field>
            </div>
            <Field label="Reclub club link" hint="Shown as an external link only. Bookings here are not synchronised with Reclub.">
              <input type="url" value={form.reclub_url} onChange={(e) => set('reclub_url', e.target.value)} />
            </Field>
          </div>
        </section>

        <section className="card" aria-labelledby="set-rules">
          <h2 id="set-rules">Booking rules {!form.policy_confirmed && <span className="badge badge-warn">Needs business input</span>}</h2>
          <div className="form">
            <div className="form-2">
              <Field label="Booking increment" hint="Length of one time slot.">
                <select value={form.slot_minutes} onChange={(e) => set('slot_minutes', Number(e.target.value))}>
                  <option value={30}>30 minutes</option>
                  <option value={60}>1 hour</option>
                </select>
              </Field>
              <Field label="Upcoming bookings allowed per customer">
                <input type="number" min={1} max={50} value={form.max_active_bookings} onChange={(e) => set('max_active_bookings', num(e.target.value, 1, 50))} />
              </Field>
            </div>
            <div className="form-2">
              <Field label="Shortest booking (slots)" hint={`= ${fmtDuration(form.min_slots * form.slot_minutes)}`}>
                <input type="number" min={1} max={12} value={form.min_slots} onChange={(e) => set('min_slots', num(e.target.value, 1, 12))} />
              </Field>
              <Field label="Longest booking (slots)" hint={`= ${fmtDuration(form.max_slots * form.slot_minutes)}`}>
                <input type="number" min={1} max={24} value={form.max_slots} onChange={(e) => set('max_slots', num(e.target.value, 1, 24))} />
              </Field>
            </div>
            <p className="muted small">Customers can always book from today through one calendar month ahead (Philippine time). Operating hours and rates are set per court under Courts.</p>
          </div>
        </section>

        <section className="card" aria-labelledby="set-cancel">
          <h2 id="set-cancel">Cancellation policy</h2>
          <div className="form">
            <Toggle checked={form.allow_cancellation} onChange={(v) => set('allow_cancellation', v)} label={form.allow_cancellation ? 'Customers can cancel online' : 'Customers cannot cancel online'} />
            <Field label="Cancel no later than (hours before start)">
              <input type="number" min={0} max={720} value={form.cancel_cutoff_hours} disabled={!form.allow_cancellation}
                onChange={(e) => set('cancel_cutoff_hours', num(e.target.value, 0, 720))} />
            </Field>
            <Field label="Policy note shown to customers (optional)">
              <textarea rows={2} value={form.cancellation_note} onChange={(e) => set('cancellation_note', e.target.value)} maxLength={300} />
            </Field>
          </div>
        </section>

        <section className="card" aria-labelledby="set-pay">
          <h2 id="set-pay"><Icon name="qr" size={18} /> Payments {!form.payment_qr_path && <span className="badge badge-warn">QR not uploaded</span>}</h2>
          <div className="form">
            <div className="qr-row">
              {form.payment_qr_path
                ? <img src={photoUrl(form.payment_qr_path)} alt="Current payment QR code" className="qr-preview" width={140} height={140} />
                : <div className="qr-preview qr-empty"><Icon name="qr" size={40} /></div>}
              <div className="stack">
                <p className="small muted">Customers scan this QR (GCash, Maya, InstaPay or bank) and enter the last 6 digits of their reference number. Use a clear, straight-on image of your official QR.</p>
                <div className="btn-row">
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setPickingQr(true)}>
                    <Icon name="upload" size={16} /> {form.payment_qr_path ? 'Replace QR' : 'Upload QR code'}
                  </button>
                  {form.payment_qr_path && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => { set('payment_qr_path', null); set('online_payment_enabled', false); set('allow_pay_at_venue', true); }}>Remove</button>
                  )}
                </div>
              </div>
            </div>
            <Toggle checked={form.online_payment_enabled} disabled={!form.payment_qr_path} onChange={(v) => set('online_payment_enabled', v)}
              label={form.online_payment_enabled ? 'Online QR payment is offered when booking' : 'Online QR payment is off'} />
            <Toggle checked={form.allow_pay_at_venue} disabled={!form.online_payment_enabled} onChange={(v) => set('allow_pay_at_venue', v)}
              label={form.allow_pay_at_venue ? 'Customers may also choose to pay at the court' : 'Online payment is required for every booking'} />
            <div className="form-2">
              <Field label="Hold the court while waiting for payment (minutes)" hint="Unpaid bookings are released after this time.">
                <input type="number" min={5} max={1440} value={form.payment_hold_minutes} onChange={(e) => set('payment_hold_minutes', num(e.target.value, 5, 1440))} />
              </Field>
              <Field label="Payment instructions (optional)" hint="Shown under the QR, e.g. account name or number.">
                <textarea rows={2} maxLength={600} value={form.payment_instructions} onChange={(e) => set('payment_instructions', e.target.value)}
                  placeholder="GCash: Yepjo Pickleball · 0917 xxx xxxx" />
              </Field>
            </div>
            <p className="muted small">After upload, press <strong>Save settings</strong> below. Payments to approve appear under <strong>Payments</strong>.</p>
          </div>
        </section>

        <section className="card" aria-labelledby="set-confirm">
          <h2 id="set-confirm">Confirmations</h2>
          <p className="muted small">The app launched with placeholder values. Tick each item once the business has confirmed it; the dashboard reminder then disappears.</p>
          <div className="form">
            <label className="check"><input type="checkbox" checked={form.hours_confirmed} onChange={(e) => set('hours_confirmed', e.target.checked)} /> <span>Operating hours for every court are correct</span></label>
            <label className="check"><input type="checkbox" checked={form.rates_confirmed} onChange={(e) => set('rates_confirmed', e.target.checked)} /> <span>Court rates are set (or intentionally left blank)</span></label>
            <label className="check"><input type="checkbox" checked={form.policy_confirmed} onChange={(e) => set('policy_confirmed', e.target.checked)} /> <span>Booking increments, durations and cancellation policy are correct</span></label>
          </div>
        </section>

        <div className="save-bar">
          <span className="muted small">{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>
          <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save settings'}</button>
        </div>
      </form>

      <section className="card" aria-labelledby="set-admins">
        <h2 id="set-admins"><Icon name="shield" size={18} /> Administrators</h2>
        <p className="small muted">
          {admins.length <= 1
            ? 'You are the only administrator, so this account cannot be removed. Add another administrator first.'
            : 'Any administrator can remove another one. You cannot remove yourself, and at least one administrator always remains.'}
        </p>
        <ul className="rows">
          {admins.map((a) => (
            <li key={a.user_id} className="row">
              <span className="row-main">
                <strong>{a.full_name ?? a.email ?? a.user_id}</strong>
                <span className="small muted">{a.email} · since {fmtDateMed(a.added_at)}</span>
              </span>
              {a.user_id === auth.user?.id
                ? <span className="badge">You</span>
                : <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => setRevoking(a)}>Remove</button>}
            </li>
          ))}
        </ul>
        <h3 className="section-label">Reserved client slots ({invites.length}/2)</h3>
        <ul className="rows">
          {[0, 1].map((i) => {
            const inv = invites[i];
            return (
              <li key={i} className="row">
                <span className="row-main">
                  <strong>{inv ? inv.email : `Slot ${i + 1} — open`}</strong>
                  <span className="small muted">{inv ? `Waiting for first Google sign-in · reserved ${fmtDateMed(inv.created_at)}` : 'Add a client email below to reserve this slot.'}</span>
                </span>
                {inv ? <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => void removeInvite(inv.email)}>Clear</button> : <span className="badge">Open</span>}
              </li>
            );
          })}
        </ul>
        <form className="inline-form" onSubmit={grant}>
          <Field label="Add an administrator by email" hint="Existing accounts become admins right away. New emails take a reserved slot and become admins on their first Google sign-in.">
            <input type="email" value={newAdmin} onChange={(e) => setNewAdmin(e.target.value)} placeholder="name@gmail.com" required />
          </Field>
          <button type="submit" className="btn btn-outline">Add</button>
        </form>
      </section>

      {pickingQr && (
        <PhotoPicker folder="payments" title="Upload payment QR code" onClose={() => setPickingQr(false)}
          onUploaded={(path) => { set('payment_qr_path', path); setPickingQr(false); toast('QR uploaded. Turn on online payment and press Save settings.'); }} />
      )}
      {revoking && (
        <Confirm title="Remove administrator?" danger confirmLabel="Remove access" onConfirm={() => void revoke()} onClose={() => setRevoking(null)}>
          <p>{revoking.full_name ?? revoking.email} will no longer be able to open the admin area. Their bookings and chats stay as they are.</p>
        </Confirm>
      )}
    </div>
  );
}
