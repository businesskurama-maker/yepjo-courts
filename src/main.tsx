import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import '@fontsource/poppins/700.css';
import './styles.css';
import App from './App';
import { AuthProvider } from './state/auth';
import { SiteProvider } from './state/site';
import { ToastProvider } from './components/ui';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <AuthProvider>
        <SiteProvider>
          <App />
        </SiteProvider>
      </AuthProvider>
    </ToastProvider>
  </StrictMode>,
);

// Service worker: application shell only (see public/sw.js). Production builds only,
// so it never interferes with the dev server.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('/sw.js');
      const reg = await navigator.serviceWorker.ready;
      // Tell the worker which built files this page used so the shell opens offline.
      const urls = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((u) => u.startsWith(window.location.origin + '/assets/'));
      reg.active?.postMessage({ type: 'CACHE_URLS', urls });
    } catch {
      /* the app works without it */
    }
  });
}
