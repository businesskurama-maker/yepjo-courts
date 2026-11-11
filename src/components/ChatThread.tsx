import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { supabase, toAppError } from '../lib/supabase';
import { fmtDateLong, fmtTime, ymdOf } from '../lib/time';
import type { Message } from '../lib/types';
import { Icon, Notice, Spinner, useOnline } from './ui';

const PAGE = 40;
const MAX_LENGTH = 1000;
const COOLDOWN_MS = 1200;

type Local = Message & { state?: 'sending' | 'failed'; failReason?: string };

interface Props {
  /** The customer's user id: one private conversation per customer. */
  conversationId: string;
  /** The signed-in user's id. */
  selfId: string;
  /** True when an administrator is replying from the inbox. */
  asAdmin?: boolean;
}

export function ChatThread({ conversationId, selfId, asAdmin = false }: Props) {
  const [messages, setMessages] = useState<Local[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [text, setText] = useState('');
  const [cooling, setCooling] = useState(false);
  const online = useOnline();
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const markRead = useCallback(() => {
    if (document.visibilityState === 'visible') void supabase.rpc('mark_conversation_read', { p_conversation_id: conversationId });
  }, [conversationId]);

  const merge = useCallback((incoming: Message[]) => {
    setMessages((prev) => {
      const map = new Map<string, Local>(prev.map((m) => [m.id, m]));
      for (const m of incoming) map.set(m.id, m); // a saved row replaces its optimistic copy
      return [...map.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
    });
  }, []);

  const loadLatest = useCallback(async () => {
    const { data, error } = await supabase
      .from('messages').select('*').eq('conversation_id', conversationId)
      .order('created_at', { ascending: false }).limit(PAGE);
    if (error) {
      setLoadError(toAppError(error).message);
    } else {
      setLoadError(null);
      merge((data as Message[]) ?? []);
      setHasMore((data?.length ?? 0) === PAGE);
      markRead();
    }
    setLoading(false);
  }, [conversationId, merge, markRead]);

  useEffect(() => {
    setMessages([]);
    setLoading(true);
    stickToBottom.current = true;
    void loadLatest();

    const channel = supabase
      .channel(`chat-${conversationId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          merge([payload.new as Message]);
          markRead();
        })
      .subscribe();

    // Catch up on anything missed while the device slept or was offline.
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadLatest();
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    return () => {
      void supabase.removeChannel(channel);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [conversationId, loadLatest, merge, markRead]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  const onScroll = () => {
    const el = listRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadEarlier = async () => {
    const first = messages.find((m) => !m.state);
    if (!first) return;
    setLoadingMore(true);
    stickToBottom.current = false;
    const { data, error } = await supabase
      .from('messages').select('*').eq('conversation_id', conversationId)
      .lt('created_at', first.created_at).order('created_at', { ascending: false }).limit(PAGE);
    if (!error) {
      merge((data as Message[]) ?? []);
      setHasMore((data?.length ?? 0) === PAGE);
    }
    setLoadingMore(false);
  };

  const deliver = async (msg: Local) => {
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, state: 'sending', failReason: undefined } : m)));
    const { data, error } = await supabase.rpc('send_message', {
      p_id: msg.id, p_conversation_id: conversationId, p_body: msg.body,
    });
    if (error || !data) {
      const reason = toAppError(error ?? 'Message was not saved.').message;
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, state: 'failed', failReason: reason } : m)));
    } else {
      merge([data as Message]);
    }
  };

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || body.length > MAX_LENGTH || cooling || !online) return;
    const msg: Local = {
      id: crypto.randomUUID(), conversation_id: conversationId, sender_id: selfId, from_admin: asAdmin,
      body, created_at: new Date().toISOString(), state: 'sending',
    };
    stickToBottom.current = true;
    setMessages((prev) => [...prev, msg]);
    setText('');
    setCooling(true);
    window.setTimeout(() => setCooling(false), COOLDOWN_MS);
    void deliver(msg);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const tooLong = text.length > MAX_LENGTH;
  let lastDay = '';

  return (
    <div className="chat">
      <div className="chat-list" ref={listRef} onScroll={onScroll} aria-live="polite" aria-label="Messages">
        {loading && <Spinner label="Loading messages…" />}
        {loadError && <Notice kind="error" action={<button type="button" className="btn btn-sm" onClick={() => void loadLatest()}>Retry</button>}>{loadError}</Notice>}
        {!loading && hasMore && (
          <button type="button" className="btn btn-ghost btn-sm chat-more" onClick={loadEarlier} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load earlier messages'}
          </button>
        )}
        {!loading && !loadError && messages.length === 0 && (
          <p className="chat-empty muted">
            {asAdmin ? 'No messages in this conversation yet.' : 'Ask about court availability, rates, events or anything else. Yepjo staff will reply here.'}
          </p>
        )}
        {messages.map((m) => {
          const mine = asAdmin ? m.from_admin : !m.from_admin;
          const day = ymdOf(new Date(m.created_at).getTime());
          const showDay = day !== lastDay;
          lastDay = day;
          return (
            <div key={m.id}>
              {showDay && <div className="chat-day"><span>{fmtDateLong(m.created_at)}</span></div>}
              <div className={`bubble-row${mine ? ' is-mine' : ''}`}>
                <div className={`bubble${m.state === 'failed' ? ' is-failed' : ''}`}>
                  {!mine && <span className="bubble-from">{m.from_admin ? 'Yepjo' : 'Customer'}</span>}
                  <p>{m.body}</p>
                  <span className="bubble-meta">
                    {m.state === 'sending' ? 'Sending…' : m.state === 'failed' ? 'Not sent' : fmtTime(m.created_at)}
                  </span>
                </div>
              </div>
              {m.state === 'failed' && (
                <div className="bubble-fail" role="alert">
                  <span>{m.failReason}</span>
                  <button type="button" className="link-btn" onClick={() => void deliver(m)}>Retry</button>
                  <button type="button" className="link-btn" onClick={() => setMessages((prev) => prev.filter((x) => x.id !== m.id))}>Delete</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <form className="chat-compose" onSubmit={send}>
        {!online && <p className="small warn-text"><Icon name="offline" size={14} /> You're offline. Messages can be sent when you reconnect.</p>}
        <div className="chat-compose-row">
          <label className="sr-only" htmlFor={`msg-${conversationId}`}>Message</label>
          <textarea
            id={`msg-${conversationId}`}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={asAdmin ? 'Reply to the customer…' : 'Write a message…'}
            aria-invalid={tooLong}
            disabled={!online}
          />
          <button type="submit" className="btn btn-primary btn-send" disabled={!text.trim() || tooLong || cooling || !online} aria-label="Send message">
            <Icon name="send" size={18} />
          </button>
        </div>
        <span className={`chat-count small${tooLong ? ' warn-text' : ' muted'}`}>
          {text.length > MAX_LENGTH - 200 || tooLong ? `${text.length} / ${MAX_LENGTH}` : 'Enter to send · Shift+Enter for a new line'}
        </span>
      </form>
    </div>
  );
}
