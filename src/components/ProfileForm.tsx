import { useState, type FormEvent } from 'react';
import { supabase, toAppError } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { Field, Notice } from './ui';

/** Mirrors public.normalize_phone() so problems are caught before the request. */
export function isValidPhone(input: string): boolean {
  const v = input.replace(/[\s\-().]/g, '');
  return /^0\d{9,10}$/.test(v) || /^63\d{9,10}$/.test(v) || /^\+[1-9]\d{7,14}$/.test(v);
}

export function ProfileForm({ submitLabel, onSaved }: { submitLabel: string; onSaved?: () => void }) {
  const { user, profile, refreshProfile } = useAuth();
  const googleName = (user?.user_metadata?.full_name ?? user?.user_metadata?.name ?? '') as string;
  const [name, setName] = useState(profile?.full_name ?? googleName ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const cleanName = name.trim().replace(/\s+/g, ' ');
  const nameError = cleanName.length < 2 ? 'Enter your full name.' : cleanName.length > 80 ? 'Name is too long (80 characters max).' : null;
  const phoneError = !phone.trim() ? 'Enter your contact number.' : !isValidPhone(phone) ? 'Use a valid number, e.g. 0917 123 4567 or +63 917 123 4567.' : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setSaved(false);
    if (nameError || phoneError) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc('save_profile', { p_full_name: cleanName, p_phone: phone });
    if (err) {
      setError(toAppError(err).message);
    } else {
      await refreshProfile();
      setSaved(true);
      onSaved?.();
    }
    setBusy(false);
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      {error && <Notice kind="error">{error}</Notice>}
      {saved && !onSaved && <Notice kind="ok">Your details were saved.</Notice>}
      <Field label="Full name" error={touched ? nameError : null}>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} required aria-invalid={touched && !!nameError} />
      </Field>
      <Field label="Contact number" hint="Mobile number we can reach you on about your booking." error={touched ? phoneError : null}>
        <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" inputMode="tel" placeholder="0917 123 4567" maxLength={20} required aria-invalid={touched && !!phoneError} />
      </Field>
      <Field label="Email address" hint="From your Google account. It cannot be changed here.">
        <input type="email" value={user?.email ?? profile?.email ?? ''} readOnly aria-readonly="true" />
      </Field>
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
    </form>
  );
}
