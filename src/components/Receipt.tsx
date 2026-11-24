import { useEffect, useState } from 'react';
import { receiptUrl } from '../lib/receipt';
import { Icon, Modal } from './ui';

/** Thumbnail of a payment receipt screenshot; tap to view it full size. */
export function ReceiptThumb({ path, label = 'Payment receipt', size = 'md' }: { path: string | null | undefined; label?: string; size?: 'sm' | 'md' }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    setUrl(null); setFailed(false);
    if (!path) return;
    void receiptUrl(path).then((u) => { if (live) { if (u) setUrl(u); else setFailed(true); } });
    return () => { live = false; };
  }, [path]);

  if (!path) return null;
  if (failed) return <span className="receipt-missing tiny muted"><Icon name="image" size={14} /> Screenshot not available</span>;
  return (
    <>
      <button type="button" className={`receipt-thumb receipt-${size}`} onClick={() => setOpen(true)} disabled={!url} aria-label={`View ${label.toLowerCase()} screenshot`}>
        {url ? <img src={url} alt={label} loading="lazy" onError={() => setFailed(true)} /> : <span className="receipt-loading" />}
        <span className="receipt-zoom"><Icon name="image" size={14} /> View</span>
      </button>
      {open && url && (
        <Modal title={label} onClose={() => setOpen(false)} footer={
          <>
            <a className="btn btn-ghost" href={url} target="_blank" rel="noopener noreferrer">Open full size</a>
            <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>Done</button>
          </>
        }>
          <img className="receipt-full" src={url} alt={label} />
        </Modal>
      )}
    </>
  );
}
