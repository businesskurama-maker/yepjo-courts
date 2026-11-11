import { useEffect, useState } from 'react';
import { Carousel } from '../components/Carousel';
import { Icon, Modal } from '../components/ui';
import { Link } from '../lib/router';
import { photoUrl, supabase } from '../lib/supabase';
import { fmtDateMed } from '../lib/time';
import { SPORTS, SPORT_LABEL, type Announcement, type CarouselPhoto } from '../lib/types';
import { useSite } from '../state/site';

const PREVIEW_COUNT = 3;

export default function Home() {
  const { settings, courts, pulse } = useSite();
  const [photos, setPhotos] = useState<CarouselPhoto[]>([]);
  const [news, setNews] = useState<Announcement[]>([]);
  const [open, setOpen] = useState<Announcement | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      supabase.from('carousel_photos').select('*').eq('is_active', true).order('sort_order').order('created_at'),
      supabase.from('announcements').select('*').eq('is_published', true).order('published_at', { ascending: false }).limit(20),
    ]).then(([p, a]) => {
      if (!alive) return;
      if (!p.error) setPhotos((p.data as CarouselPhoto[]) ?? []);
      if (!a.error) setNews((a.data as Announcement[]) ?? []);
    });
    return () => {
      alive = false;
    };
  }, [pulse]);

  const visible = showAll ? news : news.slice(0, PREVIEW_COUNT);
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${settings.business_name}, ${settings.address}`)}`;

  return (
    <div className="home">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="hero-logo-wrap">
          <img src="/logo.webp" alt={`${settings.business_name} logo`} width={220} height={220} className="hero-logo" />
        </div>
        <p className="eyebrow"><Icon name="pin" size={14} /> Brgy. Cabuynan · Tanauan</p>
        <h1 id="home-title" className="hero-title">
          <span className="hero-yepjo">YEPJO</span>
          <span className="hero-sub">Pickleball &amp; Badminton Court</span>
        </h1>
        <p className="hero-tagline">{settings.tagline}</p>
        <Link to="/book" className="btn btn-primary btn-xl"><Icon name="calendar" /> Book a Court</Link>
        <p className="section-label">Choose your sport</p>
        <div className="sport-row" role="group" aria-label="Choose a sport to book">
          {SPORTS.map((s) => {
            const n = courts.filter((c) => c.sport === s && c.is_active).length;
            return (
              <Link key={s} to={`/book?sport=${s}`} className={`sport-card sport-${s}`}>
                <span className="sport-icon"><Icon name={s} size={30} /></span>
                <span className="sport-name">{SPORT_LABEL[s]}</span>
                <span className="sport-meta">{n ? `${n} court${n > 1 ? 's' : ''}` : 'Courts'} <Icon name="right" size={14} /></span>
              </Link>
            );
          })}
        </div>
      </section>

      <div className="home-media">
        <Carousel photos={photos} />
      </div>

      <div className="home-info">
        <section className="card info-card" aria-labelledby="news-h">
          <div className="card-head">
            <h2 id="news-h"><Icon name="megaphone" size={18} /> Announcements</h2>
            {news.length > PREVIEW_COUNT && (
              <button type="button" className="link-btn" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : `View all (${news.length})`}</button>
            )}
          </div>
          {news.length === 0 ? (
            <p className="muted small empty-line"><Icon name="bolt" size={16} /> No announcements right now. Check back soon!</p>
          ) : (
            <ul className="news-list">
              {visible.map((a) => (
                <li key={a.id}>
                  <button type="button" className="news-item" onClick={() => setOpen(a)}>
                    {a.image_path && <img src={photoUrl(a.image_path)} alt="" loading="lazy" decoding="async" />}
                    <span className="news-text">
                      <strong>{a.title}</strong>
                      <span className="muted small clamp-1">{a.body}</span>
                      <span className="muted tiny">{a.published_at ? fmtDateMed(a.published_at) : ''}</span>
                    </span>
                    <Icon name="right" size={18} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card info-card" aria-labelledby="contact-h">
          <div className="card-head"><h2 id="contact-h"><Icon name="pin" size={18} /> Visit &amp; contact</h2></div>
          <ul className="contact-list">
            <li>
              <Icon name="pin" size={18} />
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer">{settings.address}</a>
            </li>
            {settings.email && (
              <li><Icon name="mail" size={18} /><a href={`mailto:${settings.email}`}>{settings.email}</a></li>
            )}
            {settings.phone && (
              <li><Icon name="phone" size={18} /><a href={`tel:${settings.phone.replace(/\s/g, '')}`}>{settings.phone}</a></li>
            )}
            {settings.facebook_name && (
              <li>
                <Icon name="facebook" size={18} />
                {settings.facebook_url
                  ? <a href={settings.facebook_url} target="_blank" rel="noopener noreferrer">{settings.facebook_name}</a>
                  : <span>{settings.facebook_name}</span>}
              </li>
            )}
          </ul>
          <div className="contact-actions">
            {settings.reclub_url && (
              <a href={settings.reclub_url} target="_blank" rel="noopener noreferrer" className="btn btn-outline btn-sm">
                <Icon name="external" size={16} /> Reclub
              </a>
            )}
            <Link to="/chat" className="btn btn-ghost btn-sm"><Icon name="chat" size={16} /> Chat with Yepjo</Link>
          </div>
        </section>
      </div>

      <footer className="site-footer home-footer muted tiny">
        <span>© {new Date().getFullYear()} {settings.business_name} · <Link to="/privacy" className="link">Privacy policy</Link></span>
        <span>Developer: Kurama Information Technology Solutions by Chi Omega</span>
      </footer>

      {open && (
        <Modal title={open.title} onClose={() => setOpen(null)} wide>
          {open.image_path && <img src={photoUrl(open.image_path)} alt={open.image_alt} className="news-photo" loading="lazy" decoding="async" />}
          <p className="muted small">{open.published_at ? fmtDateMed(open.published_at) : ''}</p>
          <p className="news-body">{open.body}</p>
        </Modal>
      )}
    </div>
  );
}
