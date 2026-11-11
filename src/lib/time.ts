// All business dates and times are Asia/Manila. The Philippines has a fixed
// UTC+8 offset (no daylight saving), so wall-clock maths can use that offset
// directly; the database enforces the same rules with the named time zone.
import type { Busy, CourtHours } from './types';

export const TZ = 'Asia/Manila';
const OFFSET_MS = 8 * 60 * 60 * 1000;
const MIN = 60 * 1000;
export const DAY_MS = 24 * 60 * MIN;

const pad = (n: number) => String(n).padStart(2, '0');

/** Manila calendar date (YYYY-MM-DD) of an instant. */
export function ymdOf(ms: number): string {
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 10);
}
export const todayYmd = (now = Date.now()) => ymdOf(now);

function parts(ymd: string): [number, number, number] {
  const [y, m, d] = ymd.split('-').map(Number);
  return [y, m, d];
}

export function ymdAdd(ymd: string, days: number): string {
  const [y, m, d] = parts(ymd);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** One calendar month later, clamped to the month's last day (Jan 31 → Feb 28/29). */
export function ymdAddMonth(ymd: string): string {
  const [y, m, d] = parts(ymd);
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

export function ymdDow(ymd: string): number {
  const [y, m, d] = parts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Instant (ms) of a Manila wall-clock time given as minutes after midnight of `ymd`. */
export function toUtcMs(ymd: string, minutes = 0): number {
  const [y, m, d] = parts(ymd);
  return Date.UTC(y, m - 1, d) - OFFSET_MS + minutes * MIN;
}

/** "12:00:00" → 720 */
export function timeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}
export const minToTime = (min: number) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;

/** Manila "YYYY-MM-DDTHH:mm" for <input type="datetime-local"> and back. */
export function toLocalInput(ms: number): string {
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 16);
}
export function fromLocalInput(v: string): number {
  const [date, time = '00:00'] = v.split('T');
  return toUtcMs(date, timeToMin(time));
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-PH', { timeZone: TZ, ...opts });
const F_LONG = fmt({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const F_SHORT = fmt({ weekday: 'short', month: 'short', day: 'numeric' });
const F_MED = fmt({ year: 'numeric', month: 'short', day: 'numeric' });
const F_TIME = fmt({ hour: 'numeric', minute: '2-digit', hour12: true });
const F_WD = fmt({ weekday: 'short' });
const F_MON = fmt({ month: 'short' });

type T = number | string;
const ms = (t: T) => (typeof t === 'number' ? t : new Date(t).getTime());

export const fmtDateLong = (t: T) => F_LONG.format(ms(t));
export const fmtDateShort = (t: T) => F_SHORT.format(ms(t));
export const fmtDateMed = (t: T) => F_MED.format(ms(t));
export const fmtTime = (t: T) => F_TIME.format(ms(t)).replace(/ /g, ' ').toUpperCase();
export const fmtDateTime = (t: T) => `${fmtDateMed(t)}, ${fmtTime(t)}`;
export const fmtWeekday = (ymd: string) => F_WD.format(toUtcMs(ymd, 720));
export const fmtMonth = (ymd: string) => F_MON.format(toUtcMs(ymd, 720));
export const dayOfMonth = (ymd: string) => Number(ymd.slice(8));

/** "7:00 PM – 1:00 AM (next day)" style range; flags an end on a later calendar date. */
export function fmtRange(start: T, end: T): string {
  const nextDay = ymdOf(ms(start)) !== ymdOf(ms(end));
  return `${fmtTime(start)} – ${fmtTime(end)}${nextDay ? ` (${fmtDateShort(end)})` : ''}`;
}

export function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return [h ? `${h} hr${h > 1 ? 's' : ''}` : '', m ? `${m} min` : ''].filter(Boolean).join(' ') || '0 min';
}

export function fmtMoney(amount: number, currency = 'PHP'): string {
  try {
    return new Intl.NumberFormat('en-PH', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---------------------------------------------------------------------------
// Operating windows and slots
// ---------------------------------------------------------------------------

export interface Window {
  start: number;
  end: number;
}

/** The session that OPENS on `ymd` for a court; it may end after midnight. */
export function courtWindow(hours: CourtHours[], courtId: number, ymd: string): Window | null {
  const h = hours.find((x) => x.court_id === courtId && x.dow === ymdDow(ymd));
  if (!h || h.is_closed) return null;
  const opens = timeToMin(h.opens);
  let closes = timeToMin(h.closes);
  if (closes <= opens) closes += 24 * 60;
  return { start: toUtcMs(ymd, opens), end: toUtcMs(ymd, closes) };
}

export type SlotState = 'available' | 'booked' | 'blocked' | 'past';
export interface Slot {
  start: number;
  end: number;
  state: SlotState;
}

export function buildSlots(win: Window | null, slotMinutes: number, busy: Busy[], courtId: number, now: number): Slot[] {
  if (!win) return [];
  const mine = busy
    .filter((b) => b.court_id === courtId)
    .map((b) => ({ s: new Date(b.starts_at).getTime(), e: new Date(b.ends_at).getTime(), state: b.state }));
  const out: Slot[] = [];
  for (let s = win.start; s + slotMinutes * MIN <= win.end; s += slotMinutes * MIN) {
    const e = s + slotMinutes * MIN;
    const hit = mine.find((b) => b.s < e && b.e > s);
    out.push({ start: s, end: e, state: hit ? hit.state : s <= now ? 'past' : 'available' });
  }
  return out;
}

/** How many consecutive available slots begin at index i. */
export function runLength(slots: Slot[], i: number): number {
  let n = 0;
  while (i + n < slots.length && slots[i + n].state === 'available') n++;
  return n;
}
