import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent } from 'react';
import {
  MAX_PHOTO_BYTES, PhotoError, fmtBytes, loadImage, processPhoto, uploadPhoto,
  type CropRect, type LoadedImage, type PhotoFolder, type ProcessedPhoto, type Progress,
} from '../lib/image';
import { Icon, Modal, Notice } from './ui';

interface Props {
  folder: PhotoFolder;
  /** Called with the storage path once the WebP file is safely stored. */
  onUploaded: (path: string) => void | Promise<void>;
  onClose: () => void;
  title?: string;
}

type Stage = 'pick' | 'crop' | 'working' | 'ready' | 'uploading';
const ASPECTS: { label: string; value: number | null }[] = [
  { label: 'Wide 16:9', value: 16 / 9 },
  { label: '4:3', value: 4 / 3 },
  { label: 'Square', value: 1 },
  { label: 'Original', value: null },
];

/**
 * Choose → crop → automatic WebP conversion (≤ 300 KB) → preview → upload.
 * Used for every photo upload in the app.
 */
export function PhotoPicker({ folder, onUploaded, onClose, title = 'Add photo' }: Props) {
  const [stage, setStage] = useState<Stage>('pick');
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [srcUrl, setSrcUrl] = useState<string | null>(null);
  const [aspect, setAspect] = useState<number | null>(folder === 'carousel' ? 16 / 9 : 4 / 3);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0.5, y: 0.5 }); // centre of the crop, as a fraction of the image
  const [progress, setProgress] = useState<Progress>({ percent: 0, label: '' });
  const [result, setResult] = useState<ProcessedPhoto | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => image?.release(), [image]);
  useEffect(() => () => { if (srcUrl) URL.revokeObjectURL(srcUrl); }, [srcUrl]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const reset = () => {
    setStage('pick');
    setFile(null);
    setImage(null);
    setSrcUrl(null);
    setResult(null);
    setPreviewUrl(null);
    setZoom(1);
    setPos({ x: 0.5, y: 0.5 });
    if (inputRef.current) inputRef.current.value = '';
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setError(null);
    try {
      const img = await loadImage(f);
      setFile(f);
      setImage(img);
      setSrcUrl(URL.createObjectURL(f));
      setStage('crop');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This photo could not be opened.');
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  // Crop size in image pixels for the current aspect + zoom.
  const cropSize = () => {
    if (!image) return { w: 0, h: 0 };
    const a = aspect ?? image.width / image.height;
    let w = image.width;
    let h = w / a;
    if (h > image.height) {
      h = image.height;
      w = h * a;
    }
    return { w: w / zoom, h: h / zoom };
  };
  const clampPos = (p: { x: number; y: number }, size = cropSize()) => {
    if (!image) return p;
    const hx = size.w / image.width / 2;
    const hy = size.h / image.height / 2;
    return { x: Math.min(1 - hx, Math.max(hx, p.x)), y: Math.min(1 - hy, Math.max(hy, p.y)) };
  };
  const cropRect = (): CropRect | null => {
    if (!image) return null;
    const size = cropSize();
    const c = clampPos(pos, size);
    return {
      sx: Math.round(c.x * image.width - size.w / 2),
      sy: Math.round(c.y * image.height - size.h / 2),
      sw: Math.round(size.w),
      sh: Math.round(size.h),
    };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !viewRef.current || !image) return;
    const box = viewRef.current.getBoundingClientRect();
    const size = cropSize();
    const dx = ((e.clientX - drag.current.x) / box.width) * (size.w / image.width);
    const dy = ((e.clientY - drag.current.y) / box.height) * (size.h / image.height);
    setPos(clampPos({ x: drag.current.px - dx, y: drag.current.py - dy }, size));
  };
  const nudge = (dx: number, dy: number) => setPos((p) => clampPos({ x: p.x + dx, y: p.y + dy }));

  const optimise = async () => {
    if (!image || !file) return;
    setStage('working');
    setError(null);
    setProgress({ percent: 2, label: 'Preparing…' });
    try {
      const out = await processPhoto(image, file.size, cropRect(), setProgress);
      setResult(out);
      setPreviewUrl(URL.createObjectURL(out.blob));
      setStage('ready');
    } catch (err) {
      setError(err instanceof PhotoError ? err.message : 'The photo could not be processed. Please try again.');
      setStage('crop');
    }
  };

  const upload = async () => {
    if (!result) return;
    setStage('uploading');
    setError(null);
    try {
      const path = await uploadPhoto(result, folder);
      await onUploaded(path);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
      setStage('ready');
    }
  };

  const size = cropSize();
  const view = image ? clampPos(pos, size) : pos;
  const viewAspect = image ? size.w / size.h : 16 / 9;
  // Position the full image behind a viewport that shows exactly the crop.
  const imgStyle = image
    ? {
        width: `${(image.width / size.w) * 100}%`,
        left: `${-((view.x * image.width - size.w / 2) / size.w) * 100}%`,
        top: `${-((view.y * image.height - size.h / 2) / size.h) * 100}%`,
      }
    : undefined;

  return (
    <Modal title={title} onClose={onClose} wide footer={
      stage === 'crop' ? (
        <>
          <button type="button" className="btn btn-ghost" onClick={reset}>Choose another</button>
          <button type="button" className="btn btn-primary" onClick={optimise}>Optimise photo</button>
        </>
      ) : stage === 'ready' || stage === 'uploading' ? (
        <>
          <button type="button" className="btn btn-ghost" onClick={() => setStage('crop')} disabled={stage === 'uploading'}>Adjust crop</button>
          <button type="button" className="btn btn-primary" onClick={upload} disabled={stage === 'uploading'}>
            <Icon name="upload" size={18} /> {stage === 'uploading' ? 'Uploading…' : 'Upload photo'}
          </button>
        </>
      ) : undefined
    }>
      {error && <Notice kind="error">{error}</Notice>}

      {stage === 'pick' && (
        <div className="photo-drop">
          <Icon name="image" size={32} />
          <p>Choose a photo from this device.</p>
          <p className="muted small">It is automatically converted to WebP and compressed to 300 KB or less before upload.</p>
          <label className="btn btn-primary">
            <Icon name="plus" size={18} /> Choose photo
            <input ref={inputRef} type="file" accept="image/*" className="sr-only" onChange={onFile} />
          </label>
        </div>
      )}

      {stage === 'crop' && image && srcUrl && (
        <div className="cropper">
          <div className="chip-row" role="group" aria-label="Crop shape">
            {ASPECTS.map((a) => (
              <button key={a.label} type="button" className={`chip${aspect === a.value ? ' is-active' : ''}`}
                aria-pressed={aspect === a.value} onClick={() => { setAspect(a.value); setPos({ x: 0.5, y: 0.5 }); }}>
                {a.label}
              </button>
            ))}
          </div>
          <div
            ref={viewRef}
            className="crop-view"
            style={{ aspectRatio: String(viewAspect) }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
            tabIndex={0}
            role="img"
            aria-label="Crop preview. Drag, or use the arrow keys, to move the photo."
            onKeyDown={(e) => {
              const stepSize = 0.02;
              if (e.key === 'ArrowLeft') nudge(-stepSize, 0);
              else if (e.key === 'ArrowRight') nudge(stepSize, 0);
              else if (e.key === 'ArrowUp') nudge(0, -stepSize);
              else if (e.key === 'ArrowDown') nudge(0, stepSize);
              else return;
              e.preventDefault();
            }}
          >
            <img src={srcUrl} alt="" style={imgStyle} draggable={false} />
          </div>
          <label className="zoom-row">
            <span className="small">Zoom</span>
            <input type="range" min={1} max={4} step={0.05} value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))} aria-label="Zoom" />
          </label>
          <p className="muted small">Drag the photo to choose what is shown. Original: {image.width}×{image.height}px, {file ? fmtBytes(file.size) : ''}.</p>
        </div>
      )}

      {stage === 'working' && (
        <div className="photo-progress" role="status" aria-live="polite">
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
            <span style={{ width: `${progress.percent}%` }} />
          </div>
          <p className="small">{progress.label}</p>
        </div>
      )}

      {(stage === 'ready' || stage === 'uploading') && result && previewUrl && (
        <div className="photo-result">
          <img src={previewUrl} alt="Processed preview" className="photo-preview" />
          <dl className="facts">
            <div><dt>Format</dt><dd>WebP</dd></div>
            <div><dt>Final size</dt><dd>{result.bytes.toLocaleString()} bytes ({fmtBytes(result.bytes)}) <span className="badge badge-ok">≤ {MAX_PHOTO_BYTES / 1000} KB</span></dd></div>
            <div><dt>Dimensions</dt><dd>{result.width}×{result.height}px</dd></div>
            <div><dt>Quality</dt><dd>{Math.round(result.quality * 100)}%</dd></div>
            <div><dt>Original</dt><dd>{fmtBytes(result.originalBytes)}</dd></div>
          </dl>
        </div>
      )}
    </Modal>
  );
}
