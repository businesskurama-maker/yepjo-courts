// Automatic photo optimisation, applied to EVERY photo uploaded through the app.
//
//   any image  →  (optional crop)  →  genuine WebP  →  ≤ 300,000 bytes
//
// Quality is lowered step by step, then the dimensions, until the file fits.
// The result is re-checked here (magic bytes + size) and again by the
// `upload-photo` Edge Function and by the Storage bucket limits.
import { SUPABASE_KEY, SUPABASE_URL, supabase } from './supabase';

export const MAX_PHOTO_BYTES = 300_000;
const START_MAX_DIMENSION = 1920;
const MIN_DIMENSION = 320;
const QUALITIES = [0.86, 0.8, 0.72, 0.64, 0.56, 0.48];

export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface ProcessedPhoto {
  blob: Blob;
  width: number;
  height: number;
  quality: number;
  bytes: number;
  originalBytes: number;
}

export interface Progress {
  percent: number;
  label: string;
}

export class PhotoError extends Error {}

export interface LoadedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

/** Decodes an image file with its EXIF orientation applied. */
export async function loadImage(file: Blob): Promise<LoadedImage> {
  if (!file.type.startsWith('image/')) throw new PhotoError('That file is not an image. Choose a JPG, PNG, WebP or HEIC photo.');
  if ('createImageBitmap' in window) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
    } catch {
      /* fall through to <img> decoding */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    // Browsers apply EXIF orientation to <img> by default (image-orientation: from-image).
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new PhotoError('This photo could not be opened. It may be damaged or in a format this browser cannot read.');
  }
}

export async function isWebp(blob: Blob): Promise<boolean> {
  if (blob.size < 20) return false;
  const b = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  return tag(0) === 'RIFF' && tag(8) === 'WEBP' && tag(12).startsWith('VP8');
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
}

/**
 * Converts (and optionally crops) an image to WebP no larger than 300,000 bytes,
 * preserving the aspect ratio of the chosen area.
 */
export async function processPhoto(
  img: LoadedImage,
  originalBytes: number,
  crop: CropRect | null,
  onProgress: (p: Progress) => void = () => {},
): Promise<ProcessedPhoto> {
  const area = crop ?? { sx: 0, sy: 0, sw: img.width, sh: img.height };
  const longest = Math.max(area.sw, area.sh);
  let scale = Math.min(1, START_MAX_DIMENSION / longest);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new PhotoError('This browser cannot process images. Try a different browser.');

  const totalSteps = 6 * QUALITIES.length;
  let step = 0;
  for (let pass = 0; pass < 6; pass++) {
    const w = Math.max(1, Math.round(area.sw * scale));
    const h = Math.max(1, Math.round(area.sh * scale));
    canvas.width = w;
    canvas.height = h;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img.source, area.sx, area.sy, area.sw, area.sh, 0, 0, w, h);

    for (const quality of QUALITIES) {
      step++;
      onProgress({
        percent: Math.min(95, Math.round((step / totalSteps) * 100)),
        label: `Compressing… ${w}×${h}px at ${Math.round(quality * 100)}% quality`,
      });
      const blob = await encode(canvas, quality);
      if (!blob) throw new PhotoError('The photo could not be compressed. Please try again or pick another photo.');
      if (blob.type !== 'image/webp' || !(await isWebp(blob))) {
        throw new PhotoError(
          'This browser cannot create WebP images, so the photo was not uploaded. Please use a current version of Chrome, Edge or Firefox on a computer or Android device.',
        );
      }
      if (blob.size <= MAX_PHOTO_BYTES) {
        onProgress({ percent: 100, label: 'Optimised' });
        return { blob, width: w, height: h, quality, bytes: blob.size, originalBytes };
      }
      // Give the page a moment to paint progress between attempts.
      await new Promise((r) => setTimeout(r, 0));
    }
    if (Math.max(w, h) <= MIN_DIMENSION) break;
    scale = Math.max(MIN_DIMENSION / longest, scale * 0.8);
  }
  throw new PhotoError('This photo could not be reduced to 300 KB at a usable quality. Try cropping it tighter or choosing a simpler photo.');
}

export type PhotoFolder = 'carousel' | 'announcements';

/** Sends a processed photo through the trusted upload function. Returns its storage path. */
export async function uploadPhoto(photo: ProcessedPhoto, folder: PhotoFolder): Promise<string> {
  if (photo.blob.size > MAX_PHOTO_BYTES || !(await isWebp(photo.blob))) {
    throw new PhotoError('The photo is not a WebP file of 300 KB or less.');
  }
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new PhotoError('Your session has expired. Please sign in again.');
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/upload-photo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY, 'Content-Type': 'image/webp', 'x-folder': folder },
      body: photo.blob,
    });
  } catch {
    throw new PhotoError('Upload failed: could not reach the server. Check your connection and try again.');
  }
  const body = (await res.json().catch(() => ({}))) as { path?: string; error?: string; message?: string };
  if (!res.ok || !body.path) {
    if (res.status === 404) throw new PhotoError('Upload failed: the upload-photo function is not deployed yet (see README, step 4).');
    throw new PhotoError(`Upload failed: ${body.error ?? body.message ?? `server responded ${res.status}`}`);
  }
  return body.path;
}

/** Best-effort removal of a stored photo that is no longer referenced. */
export async function removePhoto(path: string | null | undefined) {
  if (!path || path.startsWith('/')) return; // starter photos ship with the site, nothing to delete
  await supabase.storage.from('photos').remove([path]);
}

export const fmtBytes = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);
