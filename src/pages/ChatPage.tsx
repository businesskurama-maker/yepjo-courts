import { ChatThread } from '../components/ChatThread';
import { GoogleButton, Icon, Spinner } from '../components/ui';
import { navigate } from '../lib/router';
import { RETURN_KEY, useAuth } from '../state/auth';

export default function ChatPage() {
  const auth = useAuth();

  const body = !auth.ready ? <Spinner />
    : !auth.user ? (
      <div className="card gate">
        <Icon name="lock" size={28} />
        <p>Chat is private and available to registered players. Sign in with Google to message Yepjo.</p>
        <GoogleButton onClick={() => void auth.signIn('/chat')} />
      </div>
    ) : !auth.profileComplete ? (
      <div className="card gate">
        <p>Add your name and contact number before sending an inquiry.</p>
        <button type="button" className="btn btn-primary" onClick={() => {
          try { localStorage.setItem(RETURN_KEY, '/chat'); } catch { /* ignore */ }
          navigate('/welcome');
        }}>Complete profile</button>
      </div>
    ) : <ChatThread conversationId={auth.user.id} selfId={auth.user.id} />;

  return (
    <div className="page page-mid chat-page">
      <h1 className="page-title">Chat with Yepjo</h1>
      {body}
    </div>
  );
}
