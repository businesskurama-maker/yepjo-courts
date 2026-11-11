import { useCallback, useEffect, useState } from 'react';
import { ChatThread } from '../components/ChatThread';
import { Empty, Icon, Notice, Pager, Spinner } from '../components/ui';
import { navigate, useLocation } from '../lib/router';
import { supabase, toAppError } from '../lib/supabase';
import { fmtDateMed, fmtTime, todayYmd, ymdOf } from '../lib/time';
import type { Conversation } from '../lib/types';
import { useAuth } from '../state/auth';

export default function Inbox() {
  const auth = useAuth();
  const { query } = useLocation();
  const selectedId = query.get('c');
  const [rows, setRows] = useState<Conversation[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    let q = supabase.from('conversations').select('*, profile:profiles(full_name,email,phone)', { count: 'exact' });
    if (unreadOnly) q = q.gt('admin_unread', 0);
    const { data, error: err, count } = await q.order('last_message_at', { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
    if (err) setError(toAppError(err).message);
    else {
      setRows((data as Conversation[]) ?? []);
      setTotal(count ?? 0);
      setError(null);
    }
  }, [page, pageSize, unreadOnly]);

  useEffect(() => {
    void load();
    const ch = supabase.channel('admin-inbox')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => void load())
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [load]);

  const selected = (rows ?? []).find((c) => c.user_id === selectedId) ?? null;
  const when = (iso: string) => (ymdOf(new Date(iso).getTime()) === todayYmd() ? fmtTime(iso) : fmtDateMed(iso));

  return (
    <div className={`inbox${selectedId ? ' has-thread' : ''}`}>
      <section className="inbox-list" aria-label="Conversations">
        <div className="title-row">
          <h1 className="page-title">Inquiries</h1>
          <label className="check small"><input type="checkbox" checked={unreadOnly} onChange={(e) => { setUnreadOnly(e.target.checked); setPage(1); }} /> <span>Unread only</span></label>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        {rows === null && !error && <Spinner />}
        {rows !== null && rows.length === 0 && <Empty icon="chat" title={unreadOnly ? 'No unread inquiries' : 'No inquiries yet'} />}
        <ul className="rows card">
          {(rows ?? []).map((c) => (
            <li key={c.user_id} className="row">
              <button type="button" className={`row-btn${c.user_id === selectedId ? ' is-active' : ''}`} onClick={() => navigate(`/admin/inbox?c=${c.user_id}`)}>
                <span className="row-main">
                  <strong>{c.profile?.full_name ?? c.profile?.email ?? 'Customer'}</strong>
                  <span className={`small clamp-1${c.admin_unread ? '' : ' muted'}`}>{c.last_preview}</span>
                </span>
                <span className="row-side small">
                  <span className="muted tiny">{when(c.last_message_at)}</span>
                  {c.admin_unread > 0 && <span className="nav-badge nav-badge-inline" aria-label={`${c.admin_unread} unread`}>{c.admin_unread}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
      </section>

      <section className="inbox-thread" aria-label="Conversation">
        {selectedId && auth.user ? (
          <>
            <header className="thread-head">
              <button type="button" className="icon-btn thread-back" onClick={() => navigate('/admin/inbox')} aria-label="Back to conversations"><Icon name="left" /></button>
              <div>
                <strong>{selected?.profile?.full_name ?? 'Customer'}</strong>
                <p className="small muted">
                  {selected?.profile?.email}{selected?.profile?.phone ? ` · ${selected.profile.phone}` : ''}
                </p>
              </div>
            </header>
            <ChatThread key={selectedId} conversationId={selectedId} selfId={auth.user.id} asAdmin />
          </>
        ) : (
          <Empty icon="chat" title="Select a conversation">Customer inquiries appear here in real time.</Empty>
        )}
      </section>
    </div>
  );
}
