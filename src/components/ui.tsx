import {
  createContext, useCallback, useContext, useEffect, useId, useRef, useState, useSyncExternalStore,
  type ReactNode,
} from 'react';

// ---------------------------------------------------------------- icons
const PATHS: Record<string, string> = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  calendar: 'M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  ticket: 'M4 7h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4zM14 7v12',
  chat: 'M4 5h16v11H9l-5 4z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  left: 'M15 5l-7 7 7 7',
  right: 'M9 5l7 7-7 7',
  up: 'M5 15l7-7 7 7',
  down: 'M5 9l7 7 7-7',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  pin: 'M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.800 7 11 7 11zM12 12.500a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5z',
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  phone: 'M6 3h4l2 5-2.500 1.500a11 11 0 0 0 5 5L16 12l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z',
  facebook: 'M14 8h3V4h-3a4 4 0 0 0-4 4v3H7v4h3v6h4v-6h3l1-4h-4V8z',
  link: 'M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1',
  shield: 'M12 3l8 3v6c0 4.500-3.200 8-8 9-4.800-1-8-4.500-8-9V6z',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.500 6.500l4 4',
  plus: 'M12 5v14M5 12h14',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  offline: 'M3 3l18 18M8.500 16.500a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4-2.600M19 13a10 10 0 0 0-5-2.800M2 9.500A15 15 0 0 1 6.500 6.700M22 9.500a15 15 0 0 0-10-3.500M12 20h.01',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  refresh: 'M20 11a8 8 0 0 0-14.500-4.500L4 8M4 4v4h4M4 13a8 8 0 0 0 14.500 4.500L20 16M20 20v-4h-4',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9.500h.01',
  megaphone: 'M4 10v4h3l8 4V6l-8 4zM18 9a4 4 0 0 1 0 6',
  settings: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  send: 'M4 12l16-8-6 16-3-6z',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 5l12 7-12 7z',
  logout: 'M9 4H5v16h4M16 8l4 4-4 4M20 12H10',
  court: 'M3 5h18v14H3zM12 5v14M3 12h18',
};

export function Icon({ name, size = 20 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.800" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

// ---------------------------------------------------------------- small pieces
export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="muted small">{label}</span>
    </div>
  );
}

export function Notice({ kind = 'info', children, action }: { kind?: 'info' | 'error' | 'warn' | 'ok'; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon name={kind === 'ok' ? 'check' : kind === 'info' ? 'clock' : 'alert'} size={18} />
      <div className="notice-body">{children}</div>
      {action}
    </div>
  );
}

export function Empty({ icon = 'list', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={28} />
      <p className="empty-title">{title}</p>
      {children && <div className="muted small">{children}</div>}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error" role="alert">{error}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="toggle">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

// ---------------------------------------------------------------- modal dialog
interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

export function Modal({ title, onClose, children, footer, wide }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === 'Tab' && node) {
        const items = node.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]');
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === node)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.classList.add('modal-open');
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('modal-open');
      previous?.focus?.();
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref}>
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close dialog">
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Confirm({ title, children, confirmLabel, danger, busy, onConfirm, onClose }: {
  title: string; children: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose} footer={
      <>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Keep</button>
        <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </>
    }>
      {children}
    </Modal>
  );
}

// ---------------------------------------------------------------- pagination (10 or 20 per page)
export function Pager({ page, pageSize, total, onPage, onPageSize }: {
  page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize?: (n: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="pager" aria-label="Pagination">
      <span className="muted small">{from}–{to} of {total}</span>
      {onPageSize && (
        <label className="pager-size small">
          <span className="sr-only">Items per page</span>
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
            <option value={10}>10 / page</option>
            <option value={20}>20 / page</option>
          </select>
        </label>
      )}
      <div className="pager-btns">
        <button type="button" className="icon-btn" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page"><Icon name="left" /></button>
        <span className="small" aria-current="page">{page} / {pages}</span>
        <button type="button" className="icon-btn" onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page"><Icon name="right" /></button>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------- online status
const subscribeOnline = (cb: () => void) => {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
};
export const useOnline = () => useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);

// ---------------------------------------------------------------- toasts
interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'info';
  text: string;
}
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((list) => [...list.slice(-2), { id, kind, text }]);
    window.setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'ok' ? 'check' : 'clock'} size={18} />
            <span>{t.text}</span>
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={() => setItems((l) => l.filter((x) => x.id !== t.id))}>
              <Icon name="x" size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- Google button
export function GoogleButton({ onClick, busy, label = 'Continue with Google' }: { onClick: () => void; busy?: boolean; label?: string }) {
  return (
    <button type="button" className="btn btn-google" onClick={onClick} disabled={busy}>
      <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#EA4335" d="M24 9.500c3.500 0 6.600 1.200 9.100 3.600l6.800-6.800C35.800 2.400 30.300 0 24 0 14.600 0 6.500 5.400 2.600 13.200l7.900 6.100C12.400 13.600 17.700 9.500 24 9.500z" />
        <path fill="#4285F4" d="M46.500 24.500c0-1.600-.100-3.100-.400-4.500H24v9h12.700c-.600 3-2.300 5.500-4.800 7.200l7.700 6c4.500-4.200 6.900-10.300 6.900-17.700z" />
        <path fill="#FBBC05" d="M10.500 28.700A14.500 14.500 0 0 1 9.500 24c0-1.600.300-3.200.800-4.700l-7.900-6.100A24 24 0 0 0 0 24c0 3.900.900 7.500 2.600 10.800z" />
        <path fill="#34A853" d="M24 48c6.500 0 11.900-2.100 15.900-5.800l-7.700-6c-2.200 1.400-4.900 2.300-8.200 2.300-6.300 0-11.600-4.100-13.500-9.800l-7.900 6.100C6.500 42.600 14.600 48 24 48z" />
      </svg>
      {busy ? 'Opening Google…' : label}
    </button>
  );
}
