import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** False until the two VITE_SUPABASE_* variables are set (see .env.example). */
export const isConfigured = Boolean(url && key && !url.includes('YOUR-PROJECT-REF'));

export const SUPABASE_URL = (url ?? 'https://not-configured.supabase.co').replace(/\/$/, '');
export const SUPABASE_KEY = key ?? 'not-configured';

// "Keep me signed in": on (default) keeps the session in localStorage so it survives closing the
// browser; off keeps it in sessionStorage, which the browser clears when the tab or window closes.
const KEEP_KEY = 'yepjo:keep-signed-in';
export const getKeepSignedIn = () => {
  try { return localStorage.getItem(KEEP_KEY) !== '0'; } catch { return true; }
};
export const setKeepSignedIn = (keep: boolean) => {
  try { localStorage.setItem(KEEP_KEY, keep ? '1' : '0'); } catch { /* storage unavailable */ }
};
const safe = (fn: () => void) => { try { fn(); } catch { /* storage unavailable */ } };
const authStorage = {
  getItem: (k: string) => {
    try { return localStorage.getItem(k) ?? sessionStorage.getItem(k); } catch { return null; }
  },
  setItem: (k: string, v: string) => {
    if (getKeepSignedIn()) { safe(() => localStorage.setItem(k, v)); safe(() => sessionStorage.removeItem(k)); }
    else { safe(() => sessionStorage.setItem(k, v)); safe(() => localStorage.removeItem(k)); }
  },
  removeItem: (k: string) => { safe(() => localStorage.removeItem(k)); safe(() => sessionStorage.removeItem(k)); },
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: authStorage },
});

/**
 * Public URL of a processed WebP photo. Normally a path in the `photos` bucket;
 * paths starting with "/" are starter photos shipped with the site (public/photos).
 */
export const photoUrl = (path: string) =>
  path.startsWith('/') ? path : `${SUPABASE_URL}/storage/v1/object/public/photos/${path}`;

export interface AppError {
  code: string;
  message: string;
}

/**
 * Database functions raise errors as "CODE: Friendly message". This turns any
 * thrown value into that pair, with plain-language fallbacks.
 */
export function toAppError(e: unknown): AppError {
  const raw =
    typeof e === 'string' ? e
    : e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message)
    : '';
  const m = /^([A-Z_]{3,}):\s*(.+)$/s.exec(raw);
  if (m) return { code: m[1], message: m[2] };
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { code: 'OFFLINE', message: 'You are offline. Reconnect and try again.' };
  }
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(raw)) {
    return { code: 'NETWORK', message: 'Could not reach the server. Check your connection and try again.' };
  }
  if (/permission denied|row-level security|not authorized|JWT/i.test(raw)) {
    return { code: 'FORBIDDEN', message: 'You do not have access to do that. Try signing in again.' };
  }
  if (/violates foreign key/i.test(raw)) {
    return { code: 'IN_USE', message: 'This item is still in use and cannot be removed.' };
  }
  return { code: 'UNKNOWN', message: raw || 'Something went wrong. Please try again.' };
}

/** Throws a normalised AppError when a Supabase call returned an error. */
export function unwrap<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw toAppError(res.error);
  return res.data as T;
}
