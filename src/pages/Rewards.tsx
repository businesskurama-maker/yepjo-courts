import { useEffect, useMemo, useState } from 'react';
import { GoogleButton, Icon, Notice, Spinner } from '../components/ui';
import { Link } from '../lib/router';
import { qrSvg } from '../lib/qr';
import { photoUrl, supabase, toAppError } from '../lib/supabase';
import { fmtDateShort, fmtMoney, fmtTime } from '../lib/time';
import type { PointsEntry, Reward } from '../lib/types';
import { useAuth } from '../state/auth';
import { useSite } from '../state/site';

export const MEMBER_QR_PREFIX = 'YEPJO-MEMBER:';
export const fmtPoints = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ''));
const SOURCE_LABEL: Record<PointsEntry['source'], string> = {
  court: 'Court booking', dance: 'Step Up Dance', event: 'Event', purchase: 'Purchase', cafe: 'Cafe order', manual: 'From Yepjo', redeem: 'Reward claimed', reversal: 'Cancelled',
};

/** Loyalty: member QR, points balance, how to earn, and rewards to claim. */
export default function Rewards() {
  const auth = useAuth();
  const { settings, pulse } = useSite();
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [card, setCard] = useState<{ member_code: string; balance: number; history: PointsEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [big, setBig] = useState(false);
  const signedIn = !!auth.user && auth.profileComplete;

  useEffect(() => {
    void supabase.from('rewards').select('*').eq('is_active', true).order('points_cost').then(({ data }) => setRewards((data as Reward[]) ?? []));
  }, [pulse]);
  useEffect(() => {
    if (!signedIn) { setCard(null); return; }
    let alive = true;
    void supabase.rpc('my_rewards').then(({ data, error: err }) => {
      if (!alive) return;
      if (err) setError(toAppError(err).message);
      else { setCard(data as typeof card); setError(null); }
    });
    return () => { alive = false; };
  }, [signedIn, pulse]);

  const qr = useMemo(() => (card ? qrSvg(MEMBER_QR_PREFIX + card.member_code) : ''), [card]);
  const balance = Number(card?.balance ?? 0);
  const money = (v: number) => fmtMoney(v, settings.currency).replace(/\.00$/, '');
  const hours = Number(settings.points_court_hours ?? 0);
  const per = Number(settings.points_purchase_amount ?? 0);
  const dance = Number(settings.points_dance_booking ?? 0);
  const ev = Number(settings.points_event ?? 0);

  const signIn = async () => {
    setSigningIn(true);
    const problem = await auth.signIn('/rewards');
    if (problem) { setError(problem); setSigningIn(false); }
  };

  if (settings.rewards_enabled === false) {
    return <div className="page page-narrow"><h1 className="page-title">Rewards</h1><Notice>Yepjo Rewards is paused for now.</Notice></div>;
  }

  const code = card?.member_code.replace(/(.{2})(.{4})(.{4})/, '$1 $2 $3') ?? '';
  const next = card ? rewards.find((r) => Number(r.points_cost) > balance) ?? null : null;
  const claimable = card ? rewards.filter((r) => Number(r.points_cost) <= balance).length : 0;
  const earn = [
    hours > 0 && { icon: 'calendar', big: '1 pt', text: `every ${fmtPoints(hours)} court hour${hours === 1 ? '' : 's'}`, sub: 'Added automatically' },
    per > 0 && { icon: 'cup', big: '1 pt', text: `every ${money(per)} spent`, sub: 'Cafe orders add it automatically; at the counter, show your QR' },
    dance > 0 && { icon: 'dance', big: `${fmtPoints(dance)} pt${dance === 1 ? '' : 's'}`, text: 'per Step Up Dance class', sub: 'Added automatically' },
    ev > 0 && { icon: 'trophy', big: `${fmtPoints(ev)} pt${ev === 1 ? '' : 's'}`, text: 'per event you join', sub: 'Added when confirmed' },
  ].filter(Boolean) as { icon: string; big: string; text: string; sub: string }[];

  return (
    <div className="page portal rewards">
      <header className="portal-head">
        <div>
          <p className="eyebrow">Loyalty program</p>
          <h1 className="page-title">Yepjo Rewards</h1>
          <p className="muted small">Earn points when you play, dance or eat at Yepjo. Trade them for free court time, coffee and more.</p>
        </div>
      </header>
      {error && <Notice kind="error">{error}</Notice>}

      <section className="member-pass" aria-label="Your member card">
        {!auth.user ? (
          <div className="pass-info">
            <span className="pass-brand">YEPJO <b>MEMBER</b></span>
            <h2 className="pass-title">Get your member QR</h2>
            <p className="small pass-sub">Sign in once. Bookings, classes and cafe orders add points automatically.</p>
            <GoogleButton onClick={() => void signIn()} busy={signingIn} label="Sign in with Google" />
          </div>
        ) : !auth.profileComplete ? (
          <div className="pass-info">
            <Notice kind="warn">Add your name and contact number first. <Link to="/welcome" className="link">Complete profile</Link></Notice>
          </div>
        ) : !card ? (
          <div className="pass-info"><Spinner /></div>
        ) : (
          <>
            <div className="pass-info">
              <span className="pass-brand">YEPJO <b>MEMBER</b></span>
              <span className="pass-name">{auth.profile?.full_name}</span>
              <span className="pass-balance"><b>{fmtPoints(balance)}</b><small>points</small></span>
              {next ? (
                <span className="pass-next">
                  <span className="meter" aria-hidden="true"><span style={{ width: `${Math.min(100, (balance / Number(next.points_cost)) * 100)}%` }} /></span>
                  <span className="small">{fmtPoints(Math.round((Number(next.points_cost) - balance) * 100) / 100)} more to <b>{next.title}</b></span>
                </span>
              ) : rewards.length > 0 ? (
                <span className="small ok-text"><Icon name="check" size={14} /> You can claim any reward. Show your QR at the counter.</span>
              ) : null}
              {claimable > 0 && next && <span className="badge badge-ok">{claimable} reward{claimable === 1 ? '' : 's'} ready to claim</span>}
            </div>
            <div className="pass-qr-wrap">
              <button type="button" className="member-qr" onClick={() => setBig(true)} aria-label="Show the QR code larger">
                <span dangerouslySetInnerHTML={{ __html: qr }} />
              </button>
              <p className="member-code" aria-label="Member code">{code}</p>
              <p className="tiny pass-sub center">Tap to enlarge · show at the counter</p>
            </div>
          </>
        )}
      </section>

      {earn.length > 0 && (
        <section className="stack-sm" aria-labelledby="earn-h">
          <h2 id="earn-h" className="section-h">How to earn</h2>
          <ul className="earn-tiles">
            {earn.map((e) => (
              <li key={e.icon} className="earn-tile">
                <span className="earn-icon"><Icon name={e.icon} size={20} /></span>
                <span className="earn-big">{e.big}</span>
                <span className="earn-text">{e.text}</span>
                <span className="tiny muted">{e.sub}</span>
              </li>
            ))}
          </ul>
          <p className="tiny muted">Points from a cancelled booking, class or order are removed.</p>
        </section>
      )}

      <section className="stack-sm" aria-labelledby="rw-h">
        <h2 id="rw-h" className="section-h">Rewards</h2>
        {rewards.length === 0 && <p className="muted small">Rewards will be listed here soon.</p>}
        <ul className="prize-grid">
          {rewards.map((r) => {
            const cost = Number(r.points_cost);
            const ready = !!card && balance >= cost;
            const pct = card ? Math.min(100, (balance / cost) * 100) : 0;
            return (
              <li key={r.id} className={`prize${ready ? ' is-ready' : ''}`}>
                <span className="prize-media">
                  {r.image_path
                    ? <img src={photoUrl(r.image_path)} alt="" loading="lazy" decoding="async" />
                    : <span className="prize-art" aria-hidden="true"><Icon name="gift" size={36} /></span>}
                  <span className="prize-cost"><Icon name="star" size={13} /> {fmtPoints(cost)} pts</span>
                </span>
                <span className="prize-body">
                  <strong>{r.title}</strong>
                  {r.description && <span className="small muted">{r.description}</span>}
                  {card && (
                    <span className="prize-progress">
                      <span className="meter" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
                      <span className={`tiny ${ready ? 'ok-text' : 'muted'}`}>
                        {ready ? 'Ready: show your QR at the counter' : `${fmtPoints(Math.max(0, Math.round((cost - balance) * 100) / 100))} points to go`}
                      </span>
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {card && card.history.length > 0 && (
        <section className="card stack-sm" aria-labelledby="hist-h">
          <h2 id="hist-h" className="section-h">Points history</h2>
          <ul className="history">
            {card.history.map((h, i) => (
              <li key={i}>
                <span className="history-main">
                  <strong>{SOURCE_LABEL[h.source] ?? h.source}</strong>
                  <span className="tiny muted">{h.note ? `${h.note} · ` : ''}{fmtDateShort(h.created_at)}, {fmtTime(h.created_at)}</span>
                </span>
                <span className={`points-delta ${Number(h.points) > 0 ? 'ok-text' : 'warn-text'}`}>{Number(h.points) > 0 ? '+' : ''}{fmtPoints(Number(h.points))}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {big && card && (
        <button type="button" className="qr-fullscreen" onClick={() => setBig(false)} aria-label="Close the large QR code">
          <span dangerouslySetInnerHTML={{ __html: qr }} />
          <span className="member-code">{code}</span>
          <span className="small">Tap to close</span>
        </button>
      )}
    </div>
  );
}
