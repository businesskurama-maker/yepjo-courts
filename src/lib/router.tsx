// A very small History-API router: enough for this app, no dependency.
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
if (typeof window !== 'undefined') window.addEventListener('popstate', emit);

const current = () => window.location.pathname + window.location.search;

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === current()) return;
  window.history[opts.replace ? 'replaceState' : 'pushState'](null, '', to);
  emit();
  window.scrollTo(0, 0);
}

export function useLocation() {
  const href = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    current,
  );
  const [path, search = ''] = href.split('?');
  return { path: path.replace(/\/+$/, '') || '/', query: new URLSearchParams(search), href };
}

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
}

export function Link({ to, onClick, children, ...rest }: LinkProps) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  );
}
