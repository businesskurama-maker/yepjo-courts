import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react';
import { Link, navigate, useLocation } from './lib/router';
import { isConfigured, supabase } from './lib/supabase';
import { RETURN_KEY, useAuth } from './state/auth';
import { useSite } from './state/site';
import { GoogleButton, Icon, Notice, Spinner, useOnline } from './components/ui';
import { ProfileForm } from './components/ProfileForm';
import Home from './pages/Home';
import Book from './pages/Book';
import MyBookings from './pages/MyBookings';
import ChatPage from './pages/ChatPage';
import Account from './pages/Account';
import Privacy from './pages/Privacy';
import Calendar from './pages/Calendar';

const Admin = lazy(() => import('./admin/Admin'));

function takeReturnTo(): string {
  try {
    const to = localStorage.getItem(RETURN_KEY);
    localStorage.removeItem(RETURN_KEY);
    return to && to.startsWith('/') && !to.startsWith('/auth') && !to.startsWith('/welcome') ? to : '/';
  } catch {
    return '/';
  }
}

/** Unread replies from Yepjo for the signed-in customer (kept live over Realtime). */
function useUnreadReplies(userId: string | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!userId) {
      setCount(0);
      return;
    }
    let alive = true;
    const load = () =>
      supabase.from('conversations').select('user_unread').eq('user_id', userId).maybeSingle()
        .then(({ data }) => alive && setCount((data as { user_unread: number } | null)?.user_unread ?? 0));
    void load();
    const ch = supabase
      .channel(`unread-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations', filter: `user_id=eq.${userId}` }, () => void load())
      .subscribe();
    return () => {
      alive = false;
      void supabase.removeChannel(ch);
    };
  }, [userId]);
  return count;
}

const NAV = [
  { to: '/', label: 'Home', icon: 'home' },
  { to: '/book', label: 'Book', icon: 'calendar' },
  { to: '/calendar', label: 'Schedule', icon: 'grid' },
  { to: '/bookings', label: 'Bookings', icon: 'ticket' },
  { to: '/chat', label: 'Chat', icon: 'chat' },
  { to: '/account', label: 'Account', icon: 'user' },
];

function Shell({ children }: { children: ReactNode }) {
  const { path } = useLocation();
  const auth = useAuth();
  const { settings } = useSite();
  const online = useOnline();
  const unread = useUnreadReplies(auth.profileComplete ? auth.user?.id ?? null : null);
  const isActive = (to: string) => (to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`));
  const inAdmin = path.startsWith('/admin');

  const links = (className: string) =>
    NAV.map((n) => (
      <Link key={n.to} to={n.to} className={`${className}${isActive(n.to) ? ' is-active' : ''}`} aria-current={isActive(n.to) ? 'page' : undefined}>
        <span className="nav-icon">
          <Icon name={n.icon} />
          {n.to === '/chat' && unread > 0 && <span className="nav-badge" aria-label={`${unread} unread`}>{unread > 9 ? '9+' : unread}</span>}
        </span>
        <span>{n.label}</span>
      </Link>
    ));

  return (
    <div className={`app${inAdmin ? ' app-admin' : ''}`}>
      <a href="#main" className="skip-link">Skip to content</a>
      <header className="topbar">
        <Link to="/" className="brand" aria-label={`${settings.business_name} — home`}>
          <img src="/logo.webp" alt="" width={40} height={40} />
          <span className="brand-text">
            <strong>YEPJO</strong>
            <small>Pickleball &amp; Badminton Court</small>
          </span>
        </Link>
        <nav className="topnav" aria-label="Main">{links('topnav-link')}</nav>
        <div className="topbar-end">
          {auth.isAdmin && (
            <Link to="/admin" className={`btn btn-sm ${inAdmin ? 'btn-primary' : 'btn-outline'}`}><Icon name="shield" size={16} /> Admin</Link>
          )}
          {auth.ready && !auth.user && (
            <Link to="/account" className="btn btn-sm btn-outline">Sign in</Link>
          )}
        </div>
      </header>

      {!online && (
        <div className="offline-bar" role="status">
          <Icon name="offline" size={16} /> You're offline. Availability, booking and chat need a connection.
        </div>
      )}
      {auth.user && auth.ready && !auth.profileComplete && path !== '/welcome' && path !== '/auth/callback' && (
        <div className="offline-bar info-bar" role="status">
          Finish your profile to book courts and chat. <Link to="/welcome" className="link">Complete profile</Link>
        </div>
      )}

      <main id="main" className="main" tabIndex={-1}>{children}</main>

      {!inAdmin && <nav className="bottomnav" aria-label="Main">{links('bottomnav-link')}</nav>}
    </div>
  );
}

function AuthCallback() {
  const auth = useAuth();
  const { query } = useLocation();
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const problem = query.get('error_description') ?? hash.get('error_description');

  useEffect(() => {
    if (!auth.ready || !auth.user) return;
    if (auth.profileComplete) navigate(takeReturnTo(), { replace: true });
    else navigate('/welcome', { replace: true });
  }, [auth.ready, auth.user, auth.profileComplete]);

  if (problem || (auth.ready && !auth.user)) {
    return (
      <div className="page page-narrow">
        <Notice kind="error">Google sign-in did not finish{problem ? `: ${problem}` : '.'}</Notice>
        <GoogleButton onClick={() => void auth.signIn(takeReturnTo())} label="Try again with Google" />
        <Link to="/" className="btn btn-ghost btn-block">Back to home</Link>
      </div>
    );
  }
  return <div className="page page-narrow"><Spinner label="Signing you in…" /></div>;
}

function Welcome() {
  const auth = useAuth();
  if (!auth.ready) return <div className="page page-narrow"><Spinner /></div>;
  if (!auth.user) {
    return (
      <div className="page page-narrow">
        <h1>Sign in</h1>
        <p className="muted">Sign in with Google to book courts and message Yepjo.</p>
        <GoogleButton onClick={() => void auth.signIn('/')} />
      </div>
    );
  }
  return (
    <div className="page page-narrow">
      <div className="card">
        <h1>{auth.profileComplete ? 'Your details' : 'Welcome! One quick step'}</h1>
        <p className="muted small">We need your name and contact number so Yepjo can manage your reservations.</p>
        <ProfileForm submitLabel={auth.profileComplete ? 'Save' : 'Save and continue'} onSaved={() => navigate(takeReturnTo(), { replace: true })} />
      </div>
    </div>
  );
}

function SetupNeeded() {
  return (
    <div className="page page-narrow setup">
      <img src="/logo.webp" alt="Yepjo Pickleball and Badminton Court" width={120} height={120} className="logo-lg" />
      <h1>Almost there</h1>
      <Notice kind="warn">
        This deployment is not connected to Supabase yet. Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to the
        environment (see <code>.env.example</code> and the README), then rebuild.
      </Notice>
    </div>
  );
}

function NotFound() {
  return (
    <div className="page page-narrow">
      <h1>Page not found</h1>
      <p className="muted">That page doesn't exist.</p>
      <Link to="/" className="btn btn-primary">Go to home</Link>
    </div>
  );
}

export default function App() {
  const { path } = useLocation();
  if (!isConfigured) return <SetupNeeded />;

  let page: ReactNode;
  if (path === '/') page = <Home />;
  else if (path === '/book') page = <Book />;
  else if (path === '/bookings') page = <MyBookings />;
  else if (path === '/chat') page = <ChatPage />;
  else if (path === '/account') page = <Account />;
  else if (path === '/welcome') page = <Welcome />;
  else if (path === '/privacy') page = <Privacy />;
  else if (path === '/calendar') page = <Calendar />;
  else if (path === '/auth/callback') page = <AuthCallback />;
  else if (path === '/admin' || path.startsWith('/admin/')) {
    page = <Suspense fallback={<div className="page"><Spinner /></div>}><Admin /></Suspense>;
  } else page = <NotFound />;

  return <Shell>{page}</Shell>;
}
