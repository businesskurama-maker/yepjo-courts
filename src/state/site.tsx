import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isConfigured, supabase, toAppError } from '../lib/supabase';
import type { Closure, Court, CourtHours, CourtRate, Settings } from '../lib/types';
import { todayYmd, ymdAdd } from '../lib/time';

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
  carousel_seconds: 6,
  rewards_enabled: true,
  points_court_hours: 3,
  points_purchase_amount: 200,
  points_dance_booking: 1,
  points_event: 0,
};

interface SiteState {
  loading: boolean;
  error: string | null;
  settings: Settings;
  courts: Court[];
  hours: CourtHours[];
  /** Time-based prices (weekday / weekend time sets per court). */
  rates: CourtRate[];
  /** Closed, holiday and special-event days from yesterday onward. */
  closures: Closure[];
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
  const [rates, setRates] = useState<CourtRate[]>([]);
  const [closures, setClosures] = useState<Closure[]>([]);
  const [pulse, setPulse] = useState(0);

  const reload = useCallback(async () => {
    if (!isConfigured) return;
    try {
      const [s, c, h, r, k] = await Promise.all([
        supabase.from('settings').select('*').maybeSingle(),
        supabase.from('courts').select('id,sport,name,sort_order,is_active,hourly_rate').order('sort_order').order('id'),
        supabase.from('court_hours').select('court_id,dow,opens,closes,is_closed'),
        supabase.from('court_rates').select('id,court_id,day_type,starts,ends,rate').order('starts'),
        supabase.from('closures').select('id,starts_on,ends_on,court_ids,kind,title,note,start_time,end_time')
          .gte('ends_on', ymdAdd(todayYmd(), -1)).order('starts_on'),
      ]);
      // Prices and closures are optional extras: if they cannot load, booking still works with the court's default rate.
      const failed = s.error ?? c.error ?? h.error;
      if (failed) throw failed;
      if (s.data) setSettings({ ...DEFAULT_SETTINGS, ...(s.data as Settings) });
      setCourts((c.data as Court[]) ?? []);
      setHours((h.data as CourtHours[]) ?? []);
      setRates(((r.data as CourtRate[]) ?? []).map((x) => ({ ...x, rate: Number(x.rate) })));
      setClosures((k.data as Closure[]) ?? []);
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
    () => ({ loading, error, settings, courts, hours, rates, closures, pulse, reload }),
    [loading, error, settings, courts, hours, rates, closures, pulse, reload],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSite(): SiteState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSite must be used inside SiteProvider');
  return v;
}
