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
  /** Signed in, but the saved profile could not be loaded (network). Do not treat as incomplete. */
  profileFailed: boolean;
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
  const [profileFailed, setProfileFailed] = useState(false);
  const loadedFor = useRef<string | null>(null);

  const loadAccount = useCallback(async (userId: string) => {
    // A brief network hiccup must not look like "no profile" (that would ask for the phone number again).
    for (let attempt = 0; attempt < 3; attempt++) {
      const [p, a] = await Promise.all([
        supabase.from('profiles').select('id,email,full_name,phone,avatar_url,completed_at,member_code').eq('id', userId).maybeSingle(),
        supabase.rpc('is_admin'),
      ]);
      if (!p.error) {
        setProfile((p.data as Profile | null) ?? null);
        setIsAdmin(a.data === true);
        return;
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    throw new Error('Could not load your profile.');
  }, []);

  useEffect(() => {
    if (!isConfigured) return;
    let alive = true;

    const apply = async (s: Session | null) => {
      if (!alive) return;
      const id = s?.user.id ?? null;
      if (!id) {
        loadedFor.current = null;
        setSession(null);
        setProfile(null);
        setIsAdmin(false);
      } else if (loadedFor.current !== id) {
        // Load the saved profile BEFORE announcing the signed-in user, so the app never sees
        // "signed in but no profile yet" and wrongly asks for the phone number again.
        loadedFor.current = id;
        setReady(false);
        await loadAccount(id).catch(() => setProfileFailed(true));
        if (!alive) return;
        setSession(s);
      } else {
        setSession(s);
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
    if (session?.user.id) { await loadAccount(session.user.id); setProfileFailed(false); }
  }, [session, loadAccount]);

  const value = useMemo<AuthState>(
    () => ({
      ready,
      session,
      user: session?.user ?? null,
      profile,
      profileComplete: Boolean(profile?.completed_at),
      profileFailed,
      isAdmin,
      signIn,
      signOut,
      refreshProfile,
    }),
    [ready, session, profile, isAdmin, signIn, signOut, refreshProfile, profileFailed],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
