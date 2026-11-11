import { Link } from '../lib/router';
import { useSite } from '../state/site';

/** Plain-language privacy policy (also linked from Google's sign-in consent screen). */
export default function Privacy() {
  const { settings } = useSite();
  const email = settings.email || 'yepjopickleball@gmail.com';
  return (
    <div className="page page-mid prose">
      <h1 className="page-title">Privacy policy</h1>
      <p className="muted small">Last updated: November 11, 2026</p>

      <h2>Who we are</h2>
      <p>
        {settings.business_name}, {settings.address}. This website lets you view court availability, book courts and
        message us.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>From Google sign-in: your name, email address and profile picture.</li>
        <li>From you: your full name and contact number, so we can manage your reservations.</li>
        <li>Your bookings (court, date and time) and the messages you send us in Chat with Yepjo.</li>
      </ul>
      <p>We do not collect payment details on this website, and we do not use your data for advertising.</p>

      <h2>How we use it</h2>
      <p>
        Only to confirm and manage your reservations, contact you about them, and answer your inquiries. Your name and
        contact details are visible only to you and to Yepjo staff. Other visitors see only which time slots are taken,
        never who booked them.
      </p>

      <h2>Where it is stored</h2>
      <p>
        Data is stored securely with our hosting providers (Supabase for the database and Vercel for the website). We do
        not sell or share your personal information with anyone else.
      </p>

      <h2>Your choices</h2>
      <p>
        You can update your name and contact number in Account at any time. To have your account and data deleted, email
        us at <a className="link" href={`mailto:${email}`}>{email}</a>.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy: <a className="link" href={`mailto:${email}`}>{email}</a>.
      </p>

      <p><Link to="/" className="btn btn-ghost">Back to home</Link></p>
    </div>
  );
}
