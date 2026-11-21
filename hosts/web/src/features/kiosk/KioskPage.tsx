// /kiosk#rk_…: a kiosk link. Opens a read-only session from the link's
// token (POST /auth/kiosk) and shows the overview; the token is removed
// from the address bar and history at once. A wall display keeps the
// session while it refreshes (up to the 90-day session limit); open the
// link again after that, or after the link was revoked.

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { accountsApi } from '../../api/accounts';
import { api, ApiError, setCsrfToken } from '../../api/client';
import { errorText } from '../../components/forms';
import { t } from '../../lib/i18n';
import { useTitle } from '../../lib/useTitle';
import { AuthFrame } from '../auth/AuthFrame';
import { useAfterSignIn } from '../auth/session';

export function KioskPage() {
  useTitle(t('Kiosk'));
  const navigate = useNavigate();
  const afterSignIn = useAfterSignIn();
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = decodeURIComponent(window.location.hash.slice(1));
    window.history.replaceState(window.history.state, '', '/kiosk');
    if (!token) {
      navigate('/', { replace: true });
      return;
    }
    void (async () => {
      try {
        setCsrfToken((await api.authState()).csrf_token);
        await accountsApi.kiosk(token);
        await afterSignIn();
        navigate('/', { replace: true });
      } catch (err) {
        setError(
          err instanceof ApiError && err.status === 401
            ? t('This kiosk link is not valid: it was revoked or has expired. Ask for a new one.')
            : err instanceof ApiError && err.status === 429
              ? t('Too many attempts. Wait a few minutes and reload.')
              : errorText(err),
        );
      }
    })();
  }, [navigate, afterSignIn]);

  if (!error) return <AuthFrame busy />;
  return (
    <AuthFrame title={t('Cannot open the kiosk')}>
      <p className="ink-2">{error}</p>
    </AuthFrame>
  );
}
