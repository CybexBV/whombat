// "Confirm it's you": shown when the hub refuses a sensitive change
// (turning on remote control, API tokens, users, backups) because the
// session's sign-in is older than the re-authentication window. The user
// confirms with their password or a passkey; the request is then retried.
// Single sign-on accounts without a passkey sign in again at the provider:
// a full-page round trip that comes back with ?reauth=ok (or a failure
// code), after which the change is made again.

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { ssoStartUrl } from '../../api/accounts';
import { api, ApiError, setReauthHandler } from '../../api/client';
import { useAuthState } from '../../api/queries';
import { errorText, TextField } from '../../components/forms';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import { getAssertion, passkeyErrorMessage, webauthnSupported } from './webauthn';

function ssoReauthText(code: string, provider: string): string {
  switch (code) {
    case 'stale':
      return t('{provider} did not ask you to sign in again. Try again, or add a passkey and confirm with it.', { provider });
    case 'wrong_account':
      return t('That was another {provider} account.', { provider });
    case 'denied':
      return t('{provider} did not confirm it.', { provider });
    case 'expired':
      return t('The confirmation took too long. Try again.');
  }
  return t('Could not confirm with {provider}. Try again.', { provider });
}

/** The answer of a single sign-on re-authentication (?reauth=), once. */
function useSsoReauthResult(provider: string) {
  const [params, setParams] = useSearchParams();
  const result = params.get('reauth');
  useEffect(() => {
    if (!result) return;
    if (result === 'ok') toast(t('Confirmed. Make the change again.'), 'success');
    else toast(ssoReauthText(result, provider), 'error');
    setParams(
      (p) => {
        p.delete('reauth');
        return p;
      },
      { replace: true },
    );
  }, [result, provider, setParams]);
}

type Pending = { resolve: (ok: boolean) => void } | null;

export function ReauthDialog() {
  const auth = useAuthState();
  const loc = useLocation();
  const sso = auth.data?.source === 'oidc' ? (auth.data.oidc ?? null) : null;
  useSsoReauthResult(sso?.name ?? t('Single sign-on'));
  const [pending, setPending] = useState<Pending>(null);
  const pendingRef = useRef<Pending>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setReauthHandler(
      () =>
        new Promise<boolean>((resolve) => {
          // A second request while the dialog is open waits for the same answer.
          const prev = pendingRef.current;
          const p: Pending = {
            resolve: (ok) => {
              prev?.resolve(ok);
              resolve(ok);
            },
          };
          pendingRef.current = p;
          setPassword('');
          setError('');
          setPending(p);
        }),
    );
    return () => setReauthHandler(null);
  }, []);

  const finish = (ok: boolean) => {
    pendingRef.current?.resolve(ok);
    pendingRef.current = null;
    setPending(null);
    setBusy(false);
  };

  const hasPassword = auth.data?.has_password !== false;
  const canPasskey = (auth.data?.passkeys ?? 0) > 0 && auth.data?.passkeys_available !== false && webauthnSupported();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError('');
    try {
      await api.reauth(password);
      finish(true);
    } catch (err) {
      setBusy(false);
      setError(err instanceof ApiError && err.code === 'invalid_credentials' ? t('The password is wrong.') : errorText(err));
    }
  };

  const passkey = async () => {
    setBusy(true);
    setError('');
    try {
      const begin = await api.passkeyReauthBegin();
      const cred = await getAssertion(begin);
      await api.passkeyReauthFinish(cred);
      finish(true);
    } catch (err) {
      setBusy(false);
      setError(err instanceof ApiError ? errorText(err) : passkeyErrorMessage(err));
    }
  };

  return (
    <Modal
      open={pending !== null}
      onClose={() => finish(false)}
      busy={busy}
      title={t("Confirm it's you")}
      description={
        !hasPassword && !canPasskey && sso
          ? t('This change needs a recent sign-in. Sign in with {name} again; you come back here and make the change once more.', { name: sso.name })
          : t('This change needs a recent sign-in.')
      }
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={() => finish(false)} disabled={busy}>
            {t('Cancel')}
          </button>
          {sso && !hasPassword && (
            <a className={canPasskey ? 'btn-ghost' : 'btn-primary'} href={ssoStartUrl(loc.pathname + loc.search, true)}>
              {t('Continue with {name}', { name: sso.name })}
            </a>
          )}
          {canPasskey && (
            <button type="button" className={hasPassword ? 'btn-ghost' : 'btn-primary'} onClick={() => void passkey()} disabled={busy}>
              {t('Use passkey')}
            </button>
          )}
          {hasPassword && (
            <button type="submit" form="reauth-form" className="btn-primary" disabled={busy || !password}>
              {t('Confirm')}
            </button>
          )}
        </>
      }
    >
      {hasPassword && (
        <form id="reauth-form" onSubmit={(e) => void submit(e)}>
          <TextField label={t('Password')} type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} error={error || undefined} />
        </form>
      )}
      {!hasPassword && error && <p className="field-error">{error}</p>}
    </Modal>
  );
}
