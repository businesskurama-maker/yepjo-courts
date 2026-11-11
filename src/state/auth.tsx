import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { isConfigured, supabase } from '../lib/supabase';
import type { Profile } from '../lib/types';

export const RETURN_KEY = 'yepjo:return-to';

interface AuthState {
  ready: boolean;
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  profileComplete: boolean;
  isAdmin: boolean;
  /** Starts Google sign-in; the user comes back to `returnTo` (default: the current page). */
  signIn: (returnTo?: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(!isConfigured);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const loadedFor = useRef<string | null>(null);

  const loadAccount = useCallback(async (userId: string) => {
    const [p, a] = await Promise.all([
      supabase.from('profiles').select('id,email,full_name,phone,avatar_url,completed_at').eq('id', userId).maybeSingle(),
      supabase.rpc('is_admin'),
    ]);
    setProfile((p.data as Profile | null) ?? null);
    setIsAdmin(a.data === true);
  }, []);

  useEffect(() => {
    if (!isConfigured) return;
    let alive = true;

    const apply = async (s: Session | null) => {
      if (!alive) return;
      setSession(s);
      const id = s?.user.id ?? null;
      if (!id) {
        loadedFor.current = null;
        setProfile(null);
        setIsAdmin(false);
      } else if (loadedFor.current !== id) {
        loadedFor.current = id;
        await loadAccount(id).catch(() => undefined);
      }
      if (alive) setReady(true);
    };

    supabase.auth.getSession().then(({ data }) => apply(data.session));
    // Supabase calls must not run inside this callback, so defer them.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setTimeout(() => void apply(s), 0);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [loadAccount]);

  const signIn = useCallback(async (returnTo?: string) => {
    try {
      localStorage.setItem(RETURN_KEY, returnTo ?? window.location.pathname + window.location.search);
    } catch {
      /* storage unavailable: we simply return to the home page */
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback`, queryParams: { prompt: 'select_account' } },
    });
    return error ? error.message : null;
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    loadedFor.current = null;
    setSession(null);
    setProfile(null);
    setIsAdmin(false);
  }, []);

  const refreshProfile = useCallback(async () => {
    if (session?.user.id) await loadAccount(session.user.id);
  }, [session, loadAccount]);

  const value = useMemo<AuthState>(
    () => ({
      ready,
      session,
      user: session?.user ?? null,
      profile,
      profileComplete: Boolean(profile?.completed_at),
      isAdmin,
      signIn,
      signOut,
      refreshProfile,
    }),
    [ready, session, profile, isAdmin, signIn, signOut, refreshProfile],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
