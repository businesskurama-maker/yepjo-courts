import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Confirm, Icon, Notice, Spinner, useToast } from '../components/ui';
import { supabase, toAppError } from '../lib/supabase';
import { fmtDateShort, fmtMoney, fmtTime } from '../lib/time';
import type { PointsEntry, Reward } from '../lib/types';
import { fmtPoints } from '../pages/Rewards';
import { useSite } from '../state/site';

interface Member { member_code: string; name: string | null; phone: string | null; email: string; balance: number; history: PointsEntry[] }
type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type JsQR = (data: Uint8ClampedArray, w: number, h: number) => { data: string } | null;

const CODE_RE = /YJ[A-Z0-9]{8}/i;
// Fallback decoder for browsers without BarcodeDetector (e.g. Chrome on Windows, Safari): loaded only when needed.
const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm';

/** Admin counter: scan a member's QR (or type the code), then give points or redeem a reward. */
export default function Scan() {
  const { settings } = useSite();
  const toast = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [member, setMember] = useState<Member | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState('');
  const [points, setPoints] = useState('');
  const [note, setNote] = useState('');
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [redeeming, setRedeeming] = useState<Reward | null>(null);
  const per = Number(settings.points_purchase_amount ?? 0);

  useEffect(() => {
    void supabase.from('rewards').select('*').eq('is_active', true).order('points_cost').then(({ data }) => setRewards((data as Reward[]) ?? []));
  }, []);

  const stop = useCallback(() => {
    window.clearInterval(timer.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  }, []);
  useEffect(() => stop, [stop]);

  const lookup = useCallback(async (raw: string) => {
    const m = raw.toUpperCase().replace(/\s/g, '').match(CODE_RE);
    if (!m) { setError('That is not a Yepjo member QR or code.'); return; }
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase.rpc('admin_member_lookup', { p_code: m[0] });
    setBusy(false);
    if (err) { setMember(null); setError(toAppError(err).message); return; }
    setMember(data as Member);
    setCode(m[0]);
  }, []);

  const start = async () => {
    setCamError(null);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      streamRef.current = stream;
      setScanning(true);
      await new Promise((r) => setTimeout(r, 50));
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
      const detector = BD ? new BD({ formats: ['qr_code'] }) : null;
      let jsqr: JsQR | null = null;
      if (!detector) {
        const mod = await import(/* @vite-ignore */ JSQR_URL).catch(() => null);
        jsqr = (mod?.default ?? null) as JsQR | null;
        if (!jsqr) { setCamError('This browser cannot read QR codes from the camera. Type the member code instead.'); stop(); return; }
      }
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      timer.current = window.setInterval(async () => {
        if (!video.videoWidth) return;
        let text: string | null = null;
        if (detector) {
          const found = await detector.detect(video).catch(() => []);
          text = found[0]?.rawValue ?? null;
        } else if (jsqr && ctx) {
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          text = jsqr(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data ?? null;
        }
        if (text && CODE_RE.test(text)) {
          stop();
          if (navigator.vibrate) navigator.vibrate(80);
          void lookup(text);
        }
      }, 250);
    } catch (e) {
      stop();
      setCamError(e instanceof DOMException && e.name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow the camera for this site, or type the member code.'
        : 'No camera available here. Type the member code instead.');
    }
  };

  const give = async (e: FormEvent) => {
    e.preventDefault();
    if (!member) return;
    const amt = amount.trim() ? Number(amount) : null;
    const pts = points.trim() ? Number(points) : null;
    if (amt === null && pts === null) return setError('Enter a purchase amount or a number of points.');
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase.rpc('admin_award_points', { p_code: member.member_code, p_amount: pts === null ? amt : null, p_points: pts, p_note: note.trim() || null });
    setBusy(false);
    if (err) return setError(toAppError(err).message);
    const r = data as { points: number; balance: number };
    toast(`${Number(r.points) > 0 ? '+' : ''}${fmtPoints(Number(r.points))} points for ${member.name ?? 'the member'}. New balance ${fmtPoints(Number(r.balance))}.`);
    setAmount(''); setPoints(''); setNote('');
    void lookup(member.member_code);
  };

  const redeem = async () => {
    if (!member || !redeeming) return;
    setBusy(true);
    const { data, error: err } = await supabase.rpc('admin_redeem_reward', { p_code: member.member_code, p_reward: redeeming.id });
    setBusy(false);
    setRedeeming(null);
    if (err) return setError(toAppError(err).message);
    const r = data as { reward: string; balance: number };
    toast(`${r.reward} given. ${fmtPoints(Number(r.balance))} points left.`);
    void lookup(member.member_code);
  };

  const preview = amount.trim() && per > 0 ? Math.floor(Number(amount) / per) : null;
  const balance = Number(member?.balance ?? 0);

  return (
    <div className="stack scan-page">
      <h1 className="page-title">Scan member QR</h1>
      <p className="muted small">Ask the customer to open Rewards on their phone and show their QR. Court bookings and dance classes add points by themselves; use this for purchases, extra points and rewards.</p>

      {!member && (
        <section className="card stack-sm">
          {scanning ? (
            <>
              <div className="scan-view">
                <video ref={videoRef} playsInline muted aria-label="Camera" />
                <span className="scan-frame" aria-hidden="true" />
              </div>
              <button type="button" className="btn btn-ghost" onClick={stop}>Stop camera</button>
            </>
          ) : (
            <button type="button" className="btn btn-primary btn-xl" onClick={() => void start()}><Icon name="scan" size={20} /> Scan with camera</button>
          )}
          {camError && <Notice kind="warn">{camError}</Notice>}
          <form className="code-form" onSubmit={(e) => { e.preventDefault(); void lookup(code); }}>
            <label className="field">
              <span className="field-label">Or type the member code</span>
              <input type="text" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="YJ 7K3Q 9X2M" autoCapitalize="characters" autoComplete="off" />
            </label>
            <button type="submit" className="btn btn-outline" disabled={busy || code.replace(/\s/g, '').length < 10}>Find member</button>
          </form>
        </section>
      )}

      {error && <Notice kind="error">{error}</Notice>}
      {busy && !member && <Spinner />}

      {member && (
        <>
          <section className="card member-found">
            <div>
              <strong className="member-name">{member.name ?? 'Member'}</strong>
              <span className="small muted">{member.phone} · {member.member_code}</span>
            </div>
            <span className="points-big"><b>{fmtPoints(balance)}</b> <small>points</small></span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setMember(null); setCode(''); setError(null); }}>Next customer</button>
          </section>

          <form className="card form" onSubmit={give} aria-labelledby="give-h">
            <h2 id="give-h">Give points</h2>
            <div className="form-2">
              <label className="field">
                <span className="field-label">Purchase amount (₱)</span>
                <input type="number" min={0} step="0.01" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setPoints(''); }} placeholder="e.g. 450" />
                <span className="field-hint">{per > 0 ? (preview !== null ? `= ${preview} point${preview === 1 ? '' : 's'} (1 per ${fmtMoney(per, settings.currency)})` : `1 point per ${fmtMoney(per, settings.currency)}`) : 'Purchase points are off'}</span>
              </label>
              <label className="field">
                <span className="field-label">Or exact points</span>
                <input type="number" step="0.5" value={points} onChange={(e) => { setPoints(e.target.value); setAmount(''); }} placeholder="e.g. 1 or -1" />
                <span className="field-hint">Use a minus to correct a mistake</span>
              </label>
            </div>
            <label className="field">
              <span className="field-label">Note (optional)</span>
              <input type="text" value={note} maxLength={120} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Cafe receipt #1023" />
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy || (!amount && !points)}>{busy ? 'Saving…' : 'Give points'}</button>
          </form>

          <section className="card stack-sm" aria-labelledby="redeem-h">
            <h2 id="redeem-h">Claim a reward</h2>
            <ul className="rows">
              {rewards.map((r) => {
                const ok = balance >= Number(r.points_cost);
                return (
                  <li key={r.id} className="row">
                    <span className="row-main"><strong>{r.title}</strong><span className="small muted">{fmtPoints(Number(r.points_cost))} points</span></span>
                    <button type="button" className="btn btn-sm btn-primary" disabled={!ok || busy} onClick={() => setRedeeming(r)}>{ok ? 'Give reward' : `Needs ${fmtPoints(Math.round((Number(r.points_cost) - balance) * 100) / 100)} more`}</button>
                  </li>
                );
              })}
              {rewards.length === 0 && <li className="muted small">No rewards set up yet (Admin → Rewards).</li>}
            </ul>
          </section>

          {member.history.length > 0 && (
            <section className="card stack-sm">
              <h2>Recent points</h2>
              <ul className="rows">
                {member.history.map((h, i) => (
                  <li key={i} className="row">
                    <span className="row-main"><span className="small">{h.note ?? h.source}</span><span className="tiny muted">{fmtDateShort(h.created_at)} {fmtTime(h.created_at)}</span></span>
                    <span className={`points-delta ${Number(h.points) > 0 ? 'ok-text' : 'warn-text'}`}>{Number(h.points) > 0 ? '+' : ''}{fmtPoints(Number(h.points))}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {redeeming && member && (
        <Confirm title={`Give ${redeeming.title}?`} confirmLabel="Give reward" busy={busy} onConfirm={() => void redeem()} onClose={() => setRedeeming(null)}>
          <p>{fmtPoints(Number(redeeming.points_cost))} points will be taken from {member.name}. They will have {fmtPoints(Math.round((balance - Number(redeeming.points_cost)) * 100) / 100)} left.</p>
        </Confirm>
      )}
    </div>
  );
}
