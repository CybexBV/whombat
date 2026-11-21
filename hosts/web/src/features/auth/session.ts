// Session transitions shared by the login, setup, settings pages and the top bar.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError } from '../../api/client';
import { qk } from '../../api/queries';
import { toast } from '../../components/Toast';
import { errorText } from '../../components/forms';
import { t } from '../../lib/i18n';

/**
 * After a successful sign-in or setup: drop everything cached for the
 * previous (anonymous) state and reload /auth/state, which carries the
 * session-bound CSRF token. The auth pages redirect once it says
 * `authenticated`.
 */
export function useAfterSignIn(): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(async () => {
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== qk.auth[0] });
    await qc.invalidateQueries({ queryKey: qk.auth });
  }, [qc]);
}

/** POST /auth/logout, clear the query cache, go to /login. */
export function useSignOut(): { signOut: () => Promise<void>; pending: boolean } {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const signOut = useCallback(async () => {
    setPending(true);
    try {
      await api.logout();
    } catch (err) {
      // The session may already be gone (401); anything else is worth a word.
      if (!(err instanceof ApiError && err.status === 401)) {
        setPending(false);
        toast(t('Could not sign out: {error}', { error: errorText(err) }), 'error');
        return;
      }
    }
    await qc.cancelQueries();
    qc.clear();
    navigate('/login', { replace: true });
  }, [qc, navigate]);
  return { signOut, pending };
}
