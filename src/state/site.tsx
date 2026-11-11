import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isConfigured, supabase, toAppError } from '../lib/supabase';
import type { Court, CourtHours, Settings } from '../lib/types';

export const DEFAULT_SETTINGS: Settings = {
  business_name: 'YEPJO Pickleball & Badminton Court',
  tagline: 'Play pickleball and badminton in Tanauan.',
  address: 'Brgy. Cabuynan, Tanauan, Philippines 6502',
  email: 'yepjopickleball@gmail.com',
  phone: '',
  facebook_name: 'Yepjo Pickleball and Badminton Court',
  facebook_url: '',
  reclub_url: 'https://reclub.co/clubs/@yepjo-pickleball',
  slot_minutes: 60,
  min_slots: 1,
  max_slots: 12,
  max_active_bookings: 6,
  allow_cancellation: true,
  cancel_cutoff_hours: 6,
  cancellation_note: '',
  currency: 'PHP',
  hours_confirmed: false,
  rates_confirmed: false,
  policy_confirmed: false,
  online_payment_enabled: false,
  allow_pay_at_venue: true,
  payment_qr_path: null,
  payment_instructions: '',
  payment_hold_minutes: 30,
};

interface SiteState {
  loading: boolean;
  error: string | null;
  settings: Settings;
  courts: Court[];
  hours: CourtHours[];
  /** Increases whenever the server reports that availability or site content changed. */
  pulse: number;
  reload: () => Promise<void>;
}

const Ctx = createContext<SiteState | null>(null);

export function SiteProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(isConfigured);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [courts, setCourts] = useState<Court[]>([]);
  const [hours, setHours] = useState<CourtHours[]>([]);
  const [pulse, setPulse] = useState(0);

  const reload = useCallback(async () => {
    if (!isConfigured) return;
    try {
      const [s, c, h] = await Promise.all([
        supabase.from('settings').select('*').maybeSingle(),
        supabase.from('courts').select('id,sport,name,sort_order,is_active,hourly_rate').order('sort_order').order('id'),
        supabase.from('court_hours').select('court_id,dow,opens,closes,is_closed'),
      ]);
      const failed = s.error ?? c.error ?? h.error;
      if (failed) throw failed;
      if (s.data) setSettings({ ...DEFAULT_SETTINGS, ...(s.data as Settings) });
      setCourts((c.data as Court[]) ?? []);
      setHours((h.data as CourtHours[]) ?? []);
      setError(null);
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isConfigured) return;
    void reload();
    const bump = () => {
      setPulse((n) => n + 1);
      void reload();
    };
    const channel = supabase
      .channel('site-pulse')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pulse' }, bump)
      .subscribe();
    // Realtime can miss events while a phone sleeps; refresh when the app is shown again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') bump();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', bump);
    return () => {
      void supabase.removeChannel(channel);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', bump);
    };
  }, [reload]);

  const value = useMemo(
    () => ({ loading, error, settings, courts, hours, pulse, reload }),
    [loading, error, settings, courts, hours, pulse, reload],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSite(): SiteState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSite must be used inside SiteProvider');
  return v;
}
