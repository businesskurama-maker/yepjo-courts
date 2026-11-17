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
  court: 'Court booking', dance: 'Step Up Dance', event: 'Event', purchase: 'Purchase', manual: 'From Yepjo', redeem: 'Reward claimed', reversal: 'Cancelled',
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

  return (
    <div className="page portal rewards">
      <header className="portal-head">
        <div>
          <h1 className="page-title">Yepjo Rewards</h1>
          <p className="muted small">Earn points every time you play, dance or eat at Yepjo, then trade them for free court time, coffee and more.</p>
        </div>
      </header>
      {error && <Notice kind="error">{error}</Notice>}

      <div className="rewards-top">
        <section className="card member-card" aria-label="Your member card">
          {!auth.user ? (
            <div className="stack-sm">
              <h2 className="portal-title">Your member QR</h2>
              <p className="small muted">Sign in to get your personal QR. Court bookings and dance classes add points automatically.</p>
              <GoogleButton onClick={() => void signIn()} busy={signingIn} label="Sign in with Google" />
            </div>
          ) : !auth.profileComplete ? (
            <Notice kind="warn">Add your name and contact number first. <Link to="/welcome" className="link">Complete profile</Link></Notice>
          ) : !card ? (
            <Spinner />
          ) : (
            <>
              <div className="member-head">
                <span className="small muted">{auth.profile?.full_name}</span>
                <span className="points-big"><b>{fmtPoints(balance)}</b> <small>points</small></span>
              </div>
              <button type="button" className="member-qr" onClick={() => setBig(true)} aria-label="Show the QR code larger">
                <span dangerouslySetInnerHTML={{ __html: qr }} />
              </button>
              <p className="member-code" aria-label="Member code">{card.member_code.replace(/(.{2})(.{4})(.{4})/, '$1 $2 $3')}</p>
              <p className="tiny muted center">Show this QR at the counter to earn points on purchases or claim a reward.</p>
            </>
          )}
        </section>

        <section className="card earn-card" aria-labelledby="earn-h">
          <h2 id="earn-h" className="portal-title">How to earn</h2>
          <ul className="earn-list">
            {hours > 0 && <li><Icon name="calendar" size={18} /><span><b>1 point</b> for every {fmtPoints(hours)} hour{hours === 1 ? '' : 's'} of court rental. <span className="muted">Added automatically when your booking is confirmed.</span></span></li>}
            {per > 0 && <li><Icon name="cup" size={18} /><span><b>1 point</b> for every {money(per)} spent at Yepjo Cafe or the counter. <span className="muted">Show your QR when you pay.</span></span></li>}
            {dance > 0 && <li><Icon name="dance" size={18} /><span><b>{fmtPoints(dance)} point{dance === 1 ? '' : 's'}</b> for every Step Up Dance class. <span className="muted">Added automatically.</span></span></li>}
            {ev > 0 && <li><Icon name="trophy" size={18} /><span><b>{fmtPoints(ev)} point{ev === 1 ? '' : 's'}</b> for every event you join.</span></li>}
          </ul>
          <p className="tiny muted">Points from a booking or class are removed if it is cancelled.</p>
        </section>
      </div>

      <section className="stack-sm" aria-labelledby="rw-h">
        <h2 id="rw-h" className="day-head">Rewards you can claim</h2>
        {rewards.length === 0 && <p className="muted small">Rewards will be listed here soon.</p>}
        <ul className="reward-grid">
          {rewards.map((r) => {
            const cost = Number(r.points_cost);
            const ready = !!card && balance >= cost;
            const pct = card ? Math.min(100, (balance / cost) * 100) : 0;
            return (
              <li key={r.id} className={`card reward-card${ready ? ' is-ready' : ''}`}>
                {r.image_path
                  ? <img src={photoUrl(r.image_path)} alt="" className="reward-img" loading="lazy" decoding="async" />
                  : <span className="reward-img reward-img-art" aria-hidden="true"><Icon name="gift" size={30} /></span>}
                <div className="reward-body">
                  <strong>{r.title}</strong>
                  {r.description && <span className="small muted">{r.description}</span>}
                  <span className="reward-cost"><Icon name="star" size={14} /> {fmtPoints(cost)} points</span>
                  {card && (
                    <>
                      <span className="meter" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
                      <span className={`tiny ${ready ? 'ok-text' : 'muted'}`}>
                        {ready ? 'You can claim this. Show your QR at the counter.' : `${fmtPoints(Math.max(0, Math.round((cost - balance) * 100) / 100))} more points to go`}
                      </span>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {card && card.history.length > 0 && (
        <section className="card stack-sm" aria-labelledby="hist-h">
          <h2 id="hist-h" className="portal-title">Points history</h2>
          <ul className="rows">
            {card.history.map((h, i) => (
              <li key={i} className="row">
                <span className="row-main">
                  <strong>{SOURCE_LABEL[h.source]}</strong>
                  <span className="tiny muted">{h.note ? `${h.note} · ` : ''}{fmtDateShort(h.created_at)} {fmtTime(h.created_at)}</span>
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
          <span className="member-code">{card.member_code.replace(/(.{2})(.{4})(.{4})/, '$1 $2 $3')}</span>
          <span className="small">Tap to close</span>
        </button>
      )}
    </div>
  );
}
