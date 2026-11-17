// Mirrors public._price() on the server, which always has the final say on the amount.
import type { Closure, Court, CourtRate, DayType } from './types';
import { timeToMin, ymdDow } from './time';

const MIN = 60_000;
const HALF = 30;

export const dayTypeOf = (ymd: string): DayType => {
  const d = ymdDow(ymd);
  return d === 0 || d === 6 ? 'weekend' : 'weekday';
};

/** Is minute-of-day m inside [s, e)? e <= s means the set runs past midnight. */
export function minuteIn(m: number, s: number, e: number): boolean {
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** Manila minute of the day for an instant (the app's timestamps are Manila wall-clock based). */
function manilaMinute(ms: number): number {
  const d = new Date(ms + 8 * 3600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Hourly price at a moment of a business day, or null if nothing applies. */
export function rateAt(court: Court | undefined, rates: CourtRate[], ymd: string, ms: number): number | null {
  if (!court) return null;
  const m = manilaMinute(ms);
  const type = dayTypeOf(ymd);
  const hit = rates
    .filter((r) => r.court_id === court.id && r.day_type === type)
    .sort((a, b) => timeToMin(a.starts) - timeToMin(b.starts))
    .find((r) => minuteIn(m, timeToMin(r.starts), timeToMin(r.ends)));
  if (hit) return Number(hit.rate);
  return court.hourly_rate != null ? Number(court.hourly_rate) : null;
}

/** Total for a booking from `start` for `minutes`, on business day `ymd`. */
export function priceFor(court: Court | undefined, rates: CourtRate[], ymd: string, start: number, minutes: number): number | null {
  let total = 0;
  for (let t = start; t < start + minutes * MIN; t += HALF * MIN) {
    const r = rateAt(court, rates, ymd, t);
    if (r == null) return null;
    total += (r * Math.min(HALF, (start + minutes * MIN - t) / MIN)) / 60;
  }
  return Math.round(total * 100) / 100;
}

/** Lowest and highest hourly price a court can have (for "₱250–₱400/hr" labels). */
export function rateRange(courtList: Court[], rates: CourtRate[], dayType?: DayType): { min: number; max: number } | null {
  const vals: number[] = [];
  for (const c of courtList) {
    const own = rates.filter((r) => r.court_id === c.id && (!dayType || r.day_type === dayType)).map((r) => Number(r.rate));
    if (own.length) vals.push(...own);
    else if (c.hourly_rate != null) vals.push(Number(c.hourly_rate));
  }
  return vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : null;
}

/** The closure that applies to a court on a business day, if any. */
export function closureFor(closures: Closure[], courtId: number | null, ymd: string): Closure | null {
  return (
    closures.find(
      (k) => ymd >= k.starts_on && ymd <= k.ends_on && (k.court_ids == null || (courtId != null && k.court_ids.includes(courtId))),
    ) ?? null
  );
}

/** Closure covering every court of a sport on a day (the whole sport is closed). */
export function sportClosure(closures: Closure[], courts: Court[], ymd: string): Closure | null {
  if (!courts.length) return null;
  const all = closures.find((k) => ymd >= k.starts_on && ymd <= k.ends_on && k.court_ids == null);
  if (all) return all;
  const each = courts.map((c) => closureFor(closures, c.id, ymd));
  return each.every(Boolean) ? each[0] : null;
}

/** "7 AM", "3:30 PM", "12 AM" */
export function fmtClock(t: string): string {
  const m = timeToMin(t) % (24 * 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${((h + 11) % 12) + 1}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}
