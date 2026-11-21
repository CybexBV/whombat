// Sign in (CONTRACT 2): user name + password, a passkey (WebAuthn), or
// single sign-on when the hub has an OpenID Connect provider (a full-page
// round trip; failures come back as ?oidc_error=). Redirects to /setup while
// no account exists and away (to `next`) once signed in.

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router';
import { ssoStartUrl } from '../../api/accounts';
import { api, ApiError } from '../../api/client';
import { useAuthState } from '../../api/queries';
import { ErrorCard } from '../../components/common';
import { errorText, InlineError, TextField } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { t } from '../../lib/i18n';
import { PRODUCT_NAME } from '../../lib/product';
import { useTitle } from '../../lib/useTitle';
import { AuthFrame } from './AuthFrame';
import { safeNext } from './next';
import { useAfterSignIn } from './session';
import { getAssertion, passkeyErrorMessage, webauthnSupported } from './webauthn';

function loginError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'invalid_credentials') return t('Wrong user name or password.');
    if (err.status === 429) return err.message || t('Too many attempts. Wait a few minutes and try again.');
    if (err.code === 'csrf') return t('Your sign-in form expired. Reload the page and try again.');
  }
  return errorText(err);
}

/** Why a single sign-on attempt came back to the login page (hub codes, oidc.go). */
export function ssoErrorText(code: string, provider: string): string {
  switch (code) {
    case 'not_registered':
      return t('There is no Rackoon account for you yet. Ask an admin to add you.');
    case 'no_role':
      return t('Your {provider} account has no Rackoon role. Ask an admin.', { provider });
    case 'denied':
      return t('{provider} did not sign you in.', { provider });
    case 'expired':
      return t('The sign-in took too long or was started in another tab. Try again.');
    case 'unavailable':
      return t('{provider} cannot be reached right now. Try again later.', { provider });
    case 'username_taken':
      return t('Your user name belongs to a Rackoon password account. Ask an admin.');
    case 'invalid_username':
      return t('Your {provider} user name cannot be used in Rackoon. Ask an admin.', { provider });
    case 'unverified_email':
      return t('Your email address is not verified at {provider}.', { provider });
    case 'last_admin':
      return t('Your {provider} groups would leave Rackoon without an admin. Ask an admin to sort out the roles.', { provider });
    case 'rate_limited':
      return t('Too many attempts. Wait a few minutes and try again.');
  }
  return t('Signing in with {provider} failed. Try again.', { provider });
}

export function LoginPage() {
  useTitle(t('Sign in'));
  const auth = useAuthState();
  const [params] = useSearchParams();
  const loc = useLocation();
  const notice = (loc.state as { notice?: string } | null)?.notice;
  const afterSignIn = useAfterSignIn();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'password' | 'passkey' | null>(null);
  const [error, setError] = useState('');
  const [ssoNotice, setSsoNotice] = useState(true);
  const pwRef = useRef<HTMLInputElement>(null);
  const [focusPw, setFocusPw] = useState(0);
  useEffect(() => {
    if (focusPw) pwRef.current?.focus();
  }, [focusPw]);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  if (auth.isPending) return <AuthFrame busy />;
  if (auth.isError) {
    return (
      <AuthFrame>
        <ErrorCard title={t('Cannot reach the hub')} error={auth.error} onRetry={() => void auth.refetch()} />
      </AuthFrame>
    );
  }
  if (auth.data.setup_required) return <Navigate to="/setup" replace />;
  if (auth.data.authenticated) return <Navigate to={safeNext(params.get('next'))} replace />;

  const hubPasskeys = auth.data.passkeys_available !== false;
  const browserPasskeys = webauthnSupported();
  const sso = auth.data.oidc ?? null;
  const ssoError = params.get('oidc_error');
  const shownError = error || (ssoNotice && ssoError ? ssoErrorText(ssoError, sso?.name ?? t('single sign-on')) : '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!username.trim() || !password) {
      setError(t('Enter your user name and password.'));
      return;
    }
    setBusy('password');
    setError('');
    setSsoNotice(false);
    try {
      await api.login(username.trim(), password);
      await afterSignIn();
    } catch (err) {
      setError(loginError(err));
      setPassword('');
      setBusy(null);
      setFocusPw((n) => n + 1);
    }
  };

  const passkey = async () => {
    if (busy) return;
    setBusy('passkey');
    setError('');
    setSsoNotice(false);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const begin = await api.passkeyLoginBegin();
      const cred = await getAssertion(begin, ac.signal);
      await api.passkeyLoginFinish(cred);
      await afterSignIn();
    } catch (err) {
      if (ac.signal.aborted) return;
      setError(err instanceof ApiError ? (err.code === 'invalid_credentials' ? t('The passkey was not accepted.') : loginError(err)) : passkeyErrorMessage(err));
      setBusy(null);
    }
  };

  return (
    <AuthFrame title={t('Sign in to {product}', { product: PRODUCT_NAME })}>
      {notice && (
        <p className="auth-notice" role="status">
          {notice}
        </p>
      )}
      <form className="form-stack" onSubmit={(e) => void submit(e)} noValidate aria-describedby={shownError ? 'login-error' : undefined}>
        {shownError && (
          <div id="login-error">
            <InlineError>{shownError}</InlineError>
          </div>
        )}
        <TextField
          label={t('User name')}
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={!!busy}
        />
        <TextField
          ref={pwRef}
          label={t('Password')}
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={!!busy}
        />
        <button type="submit" className="btn-primary btn-block" disabled={!!busy}>
          {busy === 'password' ? <span className="spinner on-primary" aria-hidden="true" /> : null}
          {busy === 'password' ? t('Signing in…') : t('Sign in')}
        </button>
      </form>
      {(hubPasskeys || sso) && (
        <div className="auth-or" aria-hidden="true">
          <span>{t('or')}</span>
        </div>
      )}
      {sso && (
        <a className="btn-ghost btn-block" href={ssoStartUrl(safeNext(params.get('next')))}>
          <Icon name="shield" size={16} />
          {t('Sign in with {name}', { name: sso.name })}
        </a>
      )}
      {hubPasskeys && (
        <>
          {browserPasskeys ? (
            <button type="button" className="btn-ghost btn-block" onClick={() => void passkey()} disabled={!!busy}>
              {busy === 'passkey' ? <span className="spinner" aria-hidden="true" /> : <Icon name="key" size={16} />}
              {busy === 'passkey' ? t('Waiting for your passkey…') : t('Sign in with a passkey')}
            </button>
          ) : (
            <p className="lbl auth-note">{t('Passkey sign-in is not available here: browsers allow passkeys only on a secure (https) connection to a host name.')}</p>
          )}
        </>
      )}
    </AuthFrame>
  );
}
