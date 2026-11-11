import { useEffect, useState } from 'react';
import { Icon } from './ui';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
const waiters = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    waiters.forEach((w) => w());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    waiters.forEach((w) => w());
  });
}

function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

/** Install button where the browser supports it; otherwise instructions for this browser. */
export function InstallCard() {
  const [, force] = useState(0);
  const [installed, setInstalled] = useState(isStandalone());

  useEffect(() => {
    const w = () => force((n) => n + 1);
    waiters.add(w);
    return () => void waiters.delete(w);
  }, []);

  if (installed) {
    return <p className="muted small"><Icon name="check" size={16} /> Yepjo is installed on this device.</p>;
  }

  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const isSafariMac = /safari/i.test(ua) && !/chrome|chromium|edg|android/i.test(ua) && !isIos;
  const isFirefox = /firefox|fxios/i.test(ua);
  const isAndroid = /android/i.test(ua);

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === 'accepted') setInstalled(true);
    deferred = null;
    force((n) => n + 1);
  };

  return (
    <div className="install">
      {deferred ? (
        <button type="button" className="btn btn-outline btn-block" onClick={install}>
          <Icon name="download" size={18} /> Install the Yepjo app
        </button>
      ) : (
        <p className="small">
          <strong>Add Yepjo to your home screen: </strong>
          {isIos ? 'in Safari, tap the Share button, then “Add to Home Screen”.'
            : isSafariMac ? 'in Safari, choose File → “Add to Dock”.'
            : isFirefox && isAndroid ? 'open the browser menu (⋮), then tap “Install” or “Add to Home screen”.'
            : isFirefox ? 'Firefox on desktop cannot install web apps. Open this site in Chrome or Edge and use the install icon in the address bar.'
            : isAndroid ? 'open the browser menu (⋮), then tap “Install app” or “Add to Home screen”.'
            : 'use the install icon in the address bar, or the browser menu → “Install Yepjo”.'}
        </p>
      )}
    </div>
  );
}
