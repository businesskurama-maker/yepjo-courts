import { useCallback, useEffect, useState } from 'react';
import { Empty, GoogleButton, Icon, Notice, Pager, Spinner } from '../components/ui';
import { Link, useLocation } from '../lib/router';
import { supabase, toAppError } from '../lib/supabase';
import { DAY_MS, fmtDateLong, fmtDateTime, fmtRange, toUtcMs, todayYmd } from '../lib/time';
import { SPORT_LABEL, type ActivityLog, type Reservation } from '../lib/types';
import { useAuth } from '../state/auth';
import { useSite } from '../state/site';
import Bookings from './Bookings';
import Courts from './Courts';
import { Announcements, Photos } from './Content';
import Inbox from './Inbox';
import SettingsPage from './SettingsPage';

const TABS = [
  { to: '/admin', label: 'Dashboard', icon: 'grid' },
  { to: '/admin/bookings', label: 'Bookings', icon: 'ticket' },
  { to: '/admin/courts', label: 'Courts', icon: 'court' },
  { to: '/admin/announcements', label: 'Announcements', icon: 'megaphone' },
  { to: '/admin/photos', label: 'Photos', icon: 'image' },
  { to: '/admin/inbox', label: 'Inbox', icon: 'chat' },
  { to: '/admin/settings', label: 'Settings', icon: 'settings' },
  { to: '/admin/logs', label: 'Activity', icon: 'list' },
];

/** Number of conversations with unread customer messages, kept live. */
function useUnreadInquiries(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      supabase.from('conversations').select('user_id', { count: 'exact', head: true }).gt('admin_unread', 0)
        .then(({ count: c }) => alive && setCount(c ?? 0));
    void load();
    const ch = supabase.channel('admin-unread')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => void load())
      .subscribe();
    return () => {
      alive = false;
      void supabase.removeChannel(ch);
    };
  }, []);
  return count;
}

export default function Admin() {
  const auth = useAuth();
  const { path } = useLocation();

  if (!auth.ready) return <div className="page"><Spinner /></div>;
  if (!auth.user) {
    return (
      <div className="page page-narrow">
        <h1 className="page-title">Admin</h1>
        <div className="card gate">
          <Icon name="lock" size={28} />
          <p>Sign in with an administrator account.</p>
          <GoogleButton onClick={() => void auth.signIn('/admin')} />
        </div>
      </div>
    );
  }
  if (!auth.isAdmin) {
    return (
      <div className="page page-narrow">
        <h1 className="page-title">Admin</h1>
        <Notice kind="error">This account ({auth.user.email}) does not have administrator access.</Notice>
        <Link to="/" className="btn btn-primary">Back to home</Link>
      </div>
    );
  }
  return <AdminArea path={path} />;
}

function AdminArea({ path }: { path: string }) {
  const unread = useUnreadInquiries();
  const active = (to: string) => (to === '/admin' ? path === '/admin' : path.startsWith(to));

  let page;
  if (path === '/admin') page = <Dashboard unread={unread} />;
  else if (path.startsWith('/admin/bookings')) page = <Bookings />;
  else if (path.startsWith('/admin/courts')) page = <Courts />;
  else if (path.startsWith('/admin/announcements')) page = <Announcements />;
  else if (path.startsWith('/admin/photos')) page = <Photos />;
  else if (path.startsWith('/admin/inbox')) page = <Inbox />;
  else if (path.startsWith('/admin/settings')) page = <SettingsPage />;
  else if (path.startsWith('/admin/logs')) page = <Logs />;
  else page = <Empty title="Page not found" />;

  return (
    <div className="admin">
      <nav className="admin-nav" aria-label="Admin sections">
        {TABS.map((t) => (
          <Link key={t.to} to={t.to} className={`admin-link${active(t.to) ? ' is-active' : ''}`} aria-current={active(t.to) ? 'page' : undefined}>
            <Icon name={t.icon} size={18} />
            <span>{t.label}</span>
            {t.to === '/admin/inbox' && unread > 0 && <span className="nav-badge nav-badge-inline" aria-label={`${unread} unread`}>{unread}</span>}
          </Link>
        ))}
      </nav>
      <div className="admin-main">{page}</div>
    </div>
  );
}

// ---------------------------------------------------------------- dashboard
function Dashboard({ unread }: { unread: number }) {
  const { settings, courts, pulse } = useSite();
  const [rows, setRows] = useState<Reservation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = todayYmd();

  useEffect(() => {
    let alive = true;
    const from = toUtcMs(today);
    // Today's sessions, including the part that runs past midnight.
    supabase.from('reservations').select('*')
      .eq('status', 'confirmed').lt('starts_at', new Date(from + DAY_MS).toISOString()).gt('ends_at', new Date(from).toISOString())
      .order('starts_at').limit(200)
      .then(({ data, error: err }) => {
        if (!alive) return;
        if (err) setError(toAppError(err).message);
        else setRows((data as Reservation[]) ?? []);
      });
    return () => {
      alive = false;
    };
  }, [today, pulse]);

  const courtName = (id: number) => {
    const c = courts.find((x) => x.id === id);
    return c ? `${SPORT_LABEL[c.sport]} ${c.name}` : `Court #${id}`;
  };
  const bookings = (rows ?? []).filter((r) => r.kind !== 'block');
  const blocks = (rows ?? []).filter((r) => r.kind === 'block');
  const pending = [
    !settings.hours_confirmed && { label: 'Operating hours are placeholders (12:00 noon – 1:00 AM daily)', to: '/admin/courts' },
    !settings.rates_confirmed && { label: 'Court rates have not been set or confirmed', to: '/admin/courts' },
    !settings.policy_confirmed && { label: 'Booking increments, durations and cancellation policy use defaults', to: '/admin/settings' },
    !settings.facebook_url && { label: 'Facebook page link is missing', to: '/admin/settings' },
  ].filter(Boolean) as { label: string; to: string }[];

  return (
    <div className="stack">
      <h1 className="page-title">Dashboard</h1>
      <p className="muted small">{fmtDateLong(Date.now())} · Philippine time</p>
      {error && <Notice kind="error">{error}</Notice>}

      <div className="stat-row">
        <Link to={`/admin/bookings?date=${today}`} className="stat card">
          <span className="stat-num">{rows ? bookings.length : '–'}</span>
          <span className="stat-label">Reservations today</span>
        </Link>
        <Link to="/admin/inbox" className="stat card">
          <span className="stat-num">{unread}</span>
          <span className="stat-label">Unread inquiries</span>
        </Link>
        <Link to={`/admin/bookings?date=${today}&kind=block`} className="stat card">
          <span className="stat-num">{rows ? blocks.length : '–'}</span>
          <span className="stat-label">Blocks today</span>
        </Link>
      </div>

      {pending.length > 0 && (
        <section className="card" aria-labelledby="need-h">
          <h2 id="need-h"><Icon name="alert" size={18} /> Needs business input</h2>
          <ul className="check-list">
            {pending.map((p) => (
              <li key={p.label}><Link to={p.to} className="link">{p.label}</Link></li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" aria-labelledby="today-h">
        <div className="card-head">
          <h2 id="today-h">Today's schedule</h2>
          <Link to={`/admin/bookings?date=${today}`} className="link small">Manage</Link>
        </div>
        {rows === null && !error && <Spinner />}
        {rows !== null && rows.length === 0 && <p className="muted small">Nothing booked for today yet.</p>}
        <ul className="rows">
          {(rows ?? []).map((r) => (
            <li key={r.id} className="row">
              <span className="row-main">
                <strong>{fmtRange(r.starts_at, r.ends_at)}</strong>
                <span className="small">{courtName(r.court_id)}</span>
              </span>
              <span className="row-side small">
                {r.kind === 'block' ? <span className="badge badge-off">Blocked</span> : r.customer_name}
                {r.kind === 'walk_in' && <span className="badge">Walk-in</span>}
                <span className="muted tiny">{r.kind === 'block' ? r.note : r.customer_phone}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- activity log
function Logs() {
  const [rows, setRows] = useState<ActivityLog[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    let q = supabase.from('activity_logs').select('*', { count: 'exact' });
    const term = search.trim().replace(/[%,()]/g, '');
    if (term) q = q.or(`action.ilike.%${term}%,actor_email.ilike.%${term}%`);
    const { data, error: err, count } = await q.order('created_at', { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
    if (err) setError(toAppError(err).message);
    else {
      setRows((data as ActivityLog[]) ?? []);
      setTotal(count ?? 0);
      setError(null);
    }
  }, [page, pageSize, search]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="stack">
      <h1 className="page-title">Activity log</h1>
      <div className="filters">
        <label className="field"><span className="field-label">Search action or admin</span>
          <input type="search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="e.g. cancel, settings" />
        </label>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {rows === null && !error && <Spinner />}
      {rows !== null && rows.length === 0 && <Empty title="No activity recorded yet" />}
      <ul className="rows card">
        {(rows ?? []).map((l) => (
          <li key={l.id} className="row">
            <span className="row-main">
              <strong>{l.action}</strong>
              <span className="small">{l.details?.label ?? l.entity_id ?? ''}{l.details?.changed?.length ? ` — changed: ${l.details.changed.join(', ')}` : ''}</span>
            </span>
            <span className="row-side small">
              <span>{l.actor_email ?? 'system'}</span>
              <span className="muted tiny">{fmtDateTime(l.created_at)}</span>
            </span>
          </li>
        ))}
      </ul>
      <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
    </div>
  );
}
