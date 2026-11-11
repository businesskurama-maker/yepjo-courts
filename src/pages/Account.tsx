import { useState } from 'react';
import { InstallCard } from '../components/InstallCard';
import { ProfileForm } from '../components/ProfileForm';
import { GoogleButton, Icon, Notice, Spinner, useToast } from '../components/ui';
import { Link, navigate } from '../lib/router';
import { useAuth } from '../state/auth';

export default function Account() {
  const auth = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!auth.ready) return <div className="page"><Spinner /></div>;

  const signIn = async () => {
    setBusy(true);
    const problem = await auth.signIn('/account');
    if (problem) {
      setBusy(false);
      setError(`Google sign-in could not start: ${problem}`);
    }
  };

  return (
    <div className="page page-narrow">
      <h1 className="page-title">Account</h1>
      {error && <Notice kind="error">{error}</Notice>}

      {!auth.user ? (
        <div className="card gate">
          <p>Sign in with your Google account to book courts, see your reservations and chat with Yepjo.</p>
          <GoogleButton onClick={() => void signIn()} busy={busy} />
          <p className="muted tiny">You can browse courts and announcements without an account.</p>
        </div>
      ) : (
        <>
          <section className="card" aria-labelledby="acc-h">
            <h2 id="acc-h">Your details</h2>
            {!auth.profileComplete && <Notice kind="warn">Complete your profile to book courts and send inquiries.</Notice>}
            <ProfileForm submitLabel="Save changes" onSaved={() => { toast('Your details were saved.'); navigate('/'); }} />
          </section>

          <section className="card link-list" aria-label="Shortcuts">
            <Link to="/bookings"><Icon name="ticket" /> My bookings <Icon name="right" size={16} /></Link>
            <Link to="/chat"><Icon name="chat" /> Chat with Yepjo <Icon name="right" size={16} /></Link>
            {auth.isAdmin && <Link to="/admin"><Icon name="shield" /> Admin <Icon name="right" size={16} /></Link>}
          </section>

          <button type="button" className="btn btn-ghost btn-block" onClick={async () => { await auth.signOut(); navigate('/'); }}>
            <Icon name="logout" size={18} /> Log out
          </button>
        </>
      )}

      <section className="card" aria-labelledby="inst-h">
        <h2 id="inst-h">Install the app</h2>
        <InstallCard />
      </section>
    </div>
  );
}
