import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { photoUrl } from '../lib/supabase';
import type { CarouselPhoto } from '../lib/types';
import { Icon } from './ui';

const INTERVAL_MS = 5000;
const RESUME_AFTER_MS = 8000;

/** Featured photos: advances automatically, pauses on hover, focus, touch or manual control. */
export function Carousel({ photos }: { photos: CarouselPhoto[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const resumeTimer = useRef<number | undefined>(undefined);
  const swipeStart = useRef<number | null>(null);
  const count = photos.length;
  const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (index >= count) setIndex(0);
  }, [count, index]);

  useEffect(() => {
    if (count < 2 || paused || userPaused || reduceMotion) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') setIndex((i) => (i + 1) % count);
    }, INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [count, paused, userPaused, reduceMotion]);

  useEffect(() => () => window.clearTimeout(resumeTimer.current), []);

  // Any interaction pauses the slideshow, then it resumes after a quiet period.
  const interact = useCallback(() => {
    setPaused(true);
    window.clearTimeout(resumeTimer.current);
    resumeTimer.current = window.setTimeout(() => setPaused(false), RESUME_AFTER_MS);
  }, []);

  const go = (next: number) => {
    interact();
    setIndex((next + count) % count);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') go(index - 1);
    if (e.key === 'ArrowRight') go(index + 1);
  };
  const onPointerDown = (e: PointerEvent) => {
    swipeStart.current = e.clientX;
    interact();
  };
  const onPointerUp = (e: PointerEvent) => {
    if (swipeStart.current === null) return;
    const dx = e.clientX - swipeStart.current;
    swipeStart.current = null;
    if (Math.abs(dx) > 40) go(index + (dx < 0 ? 1 : -1));
  };

  if (count === 0) {
    return (
      <div className="carousel carousel-empty" aria-label="Featured photos">
        <div className="court-art" aria-hidden="true" />
        <p className="carousel-caption">Photos of the courts will appear here.</p>
      </div>
    );
  }

  const active = photos[Math.min(index, count - 1)];
  return (
    <section
      className="carousel"
      aria-roledescription="carousel"
      aria-label="Featured photos"
      tabIndex={0}
      onKeyDown={onKey}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className="carousel-track">
        {photos.map((p, i) => (
          <figure key={p.id} className={`carousel-slide${i === index ? ' is-active' : ''}`} aria-hidden={i !== index}
            role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${count}`}>
            <img
              src={photoUrl(p.image_path)}
              alt={p.alt_text || p.caption || 'Yepjo court photo'}
              loading={i === 0 ? 'eager' : 'lazy'}
              decoding="async"
              draggable={false}
            />
          </figure>
        ))}
      </div>
      {active.caption && <p className="carousel-caption" aria-live={paused || userPaused ? 'polite' : 'off'}>{active.caption}</p>}
      {count > 1 && (
        <>
          <button type="button" className="carousel-nav carousel-prev" onClick={() => go(index - 1)} aria-label="Previous photo"><Icon name="left" /></button>
          <button type="button" className="carousel-nav carousel-next" onClick={() => go(index + 1)} aria-label="Next photo"><Icon name="right" /></button>
          <div className="carousel-controls">
            <button type="button" className="carousel-pause" onClick={() => setUserPaused((v) => !v)}
              aria-label={userPaused ? 'Play slideshow' : 'Pause slideshow'}>
              <Icon name={userPaused ? 'play' : 'pause'} size={14} />
            </button>
            <div className="carousel-dots">
              {photos.map((p, i) => (
                <button key={p.id} type="button" className={`dot${i === index ? ' is-active' : ''}`} onClick={() => go(i)}
                  aria-label={`Show photo ${i + 1}`} aria-current={i === index} />
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
