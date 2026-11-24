import { PhotoError, loadImage } from './image';
import { supabase } from './supabase';

const BUCKET = 'receipts';
const MAX_SIDE = 1600;
const MAX_BYTES = 1_800_000;

const toJpeg = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

/** Shrinks a receipt screenshot to a readable JPEG (long side ≤ 1600 px) so it uploads fast on mobile data. */
export async function prepareReceipt(file: Blob): Promise<Blob> {
  const img = await loadImage(file);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new PhotoError('This browser cannot prepare the screenshot. Try another browser.');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img.source, 0, 0, canvas.width, canvas.height);
    for (const q of [0.85, 0.7, 0.55]) {
      const blob = await toJpeg(canvas, q);
      if (blob && blob.size <= MAX_BYTES) return blob;
    }
    throw new PhotoError('This screenshot is too large. Crop it to the receipt and try again.');
  } finally {
    img.release();
  }
}

/** Uploads the screenshot to the customer's private folder and returns its path. */
export async function uploadReceipt(blob: Blob, userId: string, tag: string): Promise<string> {
  const path = `${userId}/${tag}-${Date.now().toString(36)}.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw new PhotoError('The screenshot could not be uploaded. Check your connection and try again.');
  return path;
}

/** A short-lived link to a private receipt (the customer's own, or any for administrators). */
export async function receiptUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 900);
  return error ? null : data.signedUrl;
}

/**
 * Removes payment screenshots whose 30 days are over. Runs quietly when an administrator opens
 * the admin area, at most once a day per device.
 */
export async function purgeOldReceipts() {
  const key = 'yepjo:receipts-purged';
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (localStorage.getItem(key) === today) return;
    const { data, error } = await supabase.rpc('admin_receipts_to_purge');
    if (error) return;
    const paths = ((data as { path: string }[] | null) ?? []).map((r) => r.path);
    if (paths.length > 0) {
      const { error: rmErr } = await supabase.storage.from(BUCKET).remove(paths);
      if (rmErr) return;
      await supabase.rpc('admin_clear_receipts', { p_paths: paths });
    }
    localStorage.setItem(key, today);
  } catch {
    /* try again next time */
  }
}
