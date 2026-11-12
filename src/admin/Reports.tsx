import { useCallback, useEffect, useMemo, useState } from 'react';
import { Empty, Icon, Notice, Spinner } from '../components/ui';
import { supabase, toAppError } from '../lib/supabase';
import { fmtMoney, todayYmd } from '../lib/time';
import { SPORT_LABEL, type Sport } from '../lib/types';
import { useSite } from '../state/site';

interface Totals {
  revenue: number; bookings: number; hours: number; customers: number;
  online_revenue: number; venue_revenue: number; walk_in_revenue: number; walk_ins: number;
  cancelled: number; cancelled_value: number; pending: number; pending_value: number;
  open_hours: number; prev_revenue: number; prev_bookings: number;
}
interface Day { date: string; revenue: number; bookings: number; hours: number }
interface CourtRow { court: string; sport: Sport; revenue: number; bookings: number; hours: number }
interface SportRow { sport: Sport; revenue: number; bookings: number; hours: number }
interface Row {
  date: string; reference: string; court: string; sport: Sport; starts_at: string; ends_at: string; hours: number;
  customer: string | null; phone: string | null; kind: string; payment: string; payment_ref: string | null;
  status: string; amount: number | null;
}
interface Report {
  month: string; from: string; to: string; totals: Totals; daily: Day[]; courts: CourtRow[];
  sports: SportRow[]; hours_of_day: { hour: number; bookings: number }[]; rows: Row[];
}

const n = (v: unknown) => Number(v ?? 0);
const monthOf = (ymd: string) => ymd.slice(0, 7);
const shiftMonth = (ym: string, by: number) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (ym: string) =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const hourLabel = (h: number) => `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`;
const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });
const PAYMENT_LABEL: Record<string, string> = { online: 'Paid online (QR)', venue: 'Pay at venue', walk_in: 'Walk-in' };
const STATUS_LABEL: Record<string, string> = { confirmed: 'Confirmed', cancelled: 'Cancelled', pending: 'Payment to check' };

function csvCell(v: unknown) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Monthly sales report: revenue, bookings, hours, by day / court / sport, with CSV export. */
export default function Reports() {
  const { settings, pulse } = useSite();
  const thisMonth = monthOf(todayYmd());
  const [month, setMonth] = useState(() => {
    const q = new URLSearchParams(window.location.search).get('month');
    return q && /^\d{4}-\d{2}$/.test(q) ? q : thisMonth;
  });
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const money = useCallback((v: number) => fmtMoney(v, settings.currency), [settings.currency]);

  const load = useCallback(async () => {
    const { data: d, error: err } = await supabase.rpc('admin_sales_report', { p_month: `${month}-01` });
    if (err) { setError(toAppError(err).message); return; }
    setError(null);
    setData(d as Report);
  }, [month]);

  useEffect(() => { setData(null); void load(); }, [load]);
  useEffect(() => { if (pulse) void load(); }, [pulse]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('month', month);
    window.history.replaceState(window.history.state, '', url);
  }, [month]);

  const t = data?.totals;
  const daily = data?.daily ?? [];
  const maxDay = useMemo(() => Math.max(1, ...daily.map((d) => n(d.revenue))), [daily]);
  const best = useMemo(() => daily.reduce<Day | null>((b, d) => (n(d.revenue) > n(b?.revenue) ? d : b), null), [daily]);
  const hours = useMemo(() => [...(data?.hours_of_day ?? [])].sort((a, b) => b.bookings - a.bookings).slice(0, 5), [data]);
  const maxHour = Math.max(1, ...hours.map((h) => h.bookings));
  const change = t && n(t.prev_revenue) > 0 ? ((n(t.revenue) - n(t.prev_revenue)) / n(t.prev_revenue)) * 100 : null;
  const usage = t && n(t.open_hours) > 0 ? (n(t.hours) / n(t.open_hours)) * 100 : null;
  const isCurrent = month === thisMonth;

  const exportCsv = () => {
    if (!data) return;
    const head = ['Business date', 'Reference', 'Sport', 'Court', 'Start', 'End', 'Hours', 'Customer', 'Phone', 'Payment', 'Payment ref (last 6)', 'Status', `Amount (${settings.currency})`];
    const lines = data.rows.map((r) => [
      r.date, r.reference, SPORT_LABEL[r.sport], r.court, timeLabel(r.starts_at), timeLabel(r.ends_at), r.hours,
      r.customer, r.phone, PAYMENT_LABEL[r.payment] ?? r.payment, r.payment_ref, STATUS_LABEL[r.status] ?? r.status,
      r.amount == null ? '' : n(r.amount).toFixed(2),
    ].map(csvCell).join(','));
    const total = ['', '', '', '', '', '', '', '', '', '', '', 'Total sales (confirmed)', n(data.totals.revenue).toFixed(2)].map(csvCell).join(',');
    const blob = new Blob(['﻿' + [head.join(','), ...lines, total].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `yepjo-sales-${data.month}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  return (
    <div className="stack report">
      <div className="report-head">
        <h1 className="page-title">Sales report</h1>
        <div className="report-actions no-print">
          <button type="button" className="btn btn-ghost btn-sm" onClick={exportCsv} disabled={!data || data.rows.length === 0}>
            <Icon name="download" size={16} /> CSV
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.print()} disabled={!data}>
            <Icon name="print" size={16} /> Print
          </button>
        </div>
      </div>

      <div className="month-picker no-print" role="group" aria-label="Report month">
        <button type="button" className="icon-btn" aria-label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
          <Icon name="left" size={18} />
        </button>
        <label className="month-label">
          <span>{monthLabel(month)}</span>
          <input type="month" value={month} max={shiftMonth(thisMonth, 1)} aria-label="Choose month"
            onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </label>
        <button type="button" className="icon-btn" aria-label="Next month" onClick={() => setMonth((m) => shiftMonth(m, 1))}
          disabled={month >= shiftMonth(thisMonth, 1)}>
          <Icon name="right" size={18} />
        </button>
        {!isCurrent && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMonth(thisMonth)}>This month</button>}
      </div>
      <p className="print-only report-print-title">Yepjo · {monthLabel(month)}</p>

      {error && <Notice kind="error">{error}</Notice>}
      {!data && !error && <Spinner />}

      {data && t && (
        <>
          {isCurrent && <p className="tiny muted">Includes bookings already scheduled for the rest of this month. Figures update live.</p>}

          <div className="stat-row">
            <div className="stat card stat-main">
              <span className="stat-num">{money(n(t.revenue))}</span>
              <span className="stat-label">Total sales</span>
              {change !== null && (
                <span className={`stat-delta ${change >= 0 ? 'up' : 'down'}`}>
                  {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(0)}% vs {monthLabel(shiftMonth(month, -1)).split(' ')[0]}
                </span>
              )}
            </div>
            <div className="stat card">
              <span className="stat-num">{n(t.bookings)}</span>
              <span className="stat-label">Bookings{n(t.walk_ins) ? ` · ${n(t.walk_ins)} walk-in${n(t.walk_ins) === 1 ? '' : 's'}` : ''}</span>
            </div>
            <div className="stat card">
              <span className="stat-num">{n(t.hours).toLocaleString('en-PH')}</span>
              <span className="stat-label">Court hours sold{usage !== null ? ` · ${usage.toFixed(usage < 10 ? 1 : 0)}% of open hours` : ''}</span>
            </div>
            <div className="stat card">
              <span className="stat-num">{n(t.customers)}</span>
              <span className="stat-label">Customers</span>
            </div>
          </div>

          {n(t.bookings) === 0 && n(t.cancelled) === 0 && n(t.pending) === 0 ? (
            <Empty icon="chart" title={`No sales in ${monthLabel(month)}`}>Confirmed bookings and walk-ins will show up here.</Empty>
          ) : (
            <>
              <section className="card report-card">
                <h2 className="report-h">How it was paid</h2>
                {([
                  ['Paid online (QR)', n(t.online_revenue)],
                  ['Pay at venue', n(t.venue_revenue)],
                  ['Walk-ins', n(t.walk_in_revenue)],
                ] as [string, number][]).map(([label, v]) => (
                  <div key={label} className="hbar">
                    <span className="hbar-label">{label}</span>
                    <span className="hbar-track"><span className="hbar-fill" style={{ width: `${n(t.revenue) ? (v / n(t.revenue)) * 100 : 0}%` }} /></span>
                    <span className="hbar-val">{money(v)}</span>
                  </div>
                ))}
                <div className="report-notes">
                  {n(t.pending) > 0 && (
                    <span className="badge badge-warn">{n(t.pending)} payment{n(t.pending) === 1 ? '' : 's'} to check · {money(n(t.pending_value))} not counted yet</span>
                  )}
                  {n(t.cancelled) > 0 && (
                    <span className="badge badge-off">{n(t.cancelled)} cancelled · {money(n(t.cancelled_value))}</span>
                  )}
                </div>
              </section>

              <section className="card report-card">
                <div className="report-row">
                  <h2 className="report-h">Sales per day</h2>
                  {best && n(best.revenue) > 0 && (
                    <span className="tiny muted">Best day: {new Date(`${best.date}T00:00:00Z`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC' })} · {money(n(best.revenue))}</span>
                  )}
                </div>
                <div className="day-chart" role="img" aria-label={`Daily sales for ${monthLabel(month)}`}>
                  {daily.map((d) => {
                    const day = Number(d.date.slice(8, 10));
                    const dow = new Date(`${d.date}T00:00:00Z`).getUTCDay();
                    return (
                      <div key={d.date} className={`day-col${dow === 0 || dow === 6 ? ' is-weekend' : ''}`}
                        title={`${d.date}: ${money(n(d.revenue))} · ${n(d.bookings)} booking${n(d.bookings) === 1 ? '' : 's'} · ${n(d.hours)} h`}>
                        <span className="day-bar" style={{ height: `${(n(d.revenue) / maxDay) * 100}%` }} />
                        <span className="day-num">{day === 1 || day % 5 === 0 ? day : ''}</span>
                      </div>
                    );
                  })}
                </div>
              </section>

              <div className="report-grid">
                <section className="card report-card">
                  <h2 className="report-h">By court</h2>
                  <table className="report-table">
                    <thead><tr><th>Court</th><th className="num">Bookings</th><th className="num">Hours</th><th className="num">Sales</th></tr></thead>
                    <tbody>
                      {data.courts.map((c) => (
                        <tr key={`${c.sport}-${c.court}`}>
                          <td>{SPORT_LABEL[c.sport]} · {c.court}</td>
                          <td className="num">{n(c.bookings)}</td>
                          <td className="num">{n(c.hours)}</td>
                          <td className="num">{money(n(c.revenue))}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      {data.sports.map((s) => (
                        <tr key={s.sport}>
                          <th>All {SPORT_LABEL[s.sport].toLowerCase()}</th>
                          <td className="num">{n(s.bookings)}</td>
                          <td className="num">{n(s.hours)}</td>
                          <td className="num">{money(n(s.revenue))}</td>
                        </tr>
                      ))}
                    </tfoot>
                  </table>
                </section>

                <section className="card report-card">
                  <h2 className="report-h">Busiest start times</h2>
                  {hours.length === 0 ? <p className="small muted">No bookings yet.</p> : hours.map((h) => (
                    <div key={h.hour} className="hbar">
                      <span className="hbar-label">{hourLabel(h.hour)}</span>
                      <span className="hbar-track"><span className="hbar-fill" style={{ width: `${(h.bookings / maxHour) * 100}%` }} /></span>
                      <span className="hbar-val">{h.bookings}</span>
                    </div>
                  ))}
                </section>
              </div>

              <p className="tiny muted">
                Sales count confirmed bookings and walk-ins by the night they were played (after-midnight hours belong to the evening before).
                Pay-at-venue bookings are counted as expected sales. Download the CSV for every booking line, including cancellations.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
