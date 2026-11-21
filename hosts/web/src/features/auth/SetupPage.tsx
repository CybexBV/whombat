// First-run setup (CONTRACT 2): create the admin account with the setup
// token from the hub log. The hub prints `<public-url>/setup#token=…`, so a
// token in the URL fragment is filled in (and removed from the address bar).

import { type FormEvent, useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { api, ApiError } from '../../api/client';
import { useAuthState } from '../../api/queries';
import { ErrorCard } from '../../components/common';
import { errorText, InlineError, TextField } from '../../components/forms';
import { t } from '../../lib/i18n';
import { PRODUCT_NAME } from '../../lib/product';
import { useTitle } from '../../lib/useTitle';
import { AuthFrame } from './AuthFrame';
import { safeNext } from './next';
import { MIN_PASSWORD } from './password';
import { useAfterSignIn } from './session';

const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;

type Errors = Partial<Record<'token' | 'username' | 'password' | 'confirm' | 'form', string>>;

function tokenFromHash(): string {
  const m = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
  return m?.[1] ? decodeURIComponent(m[1]) : '';
}

export function SetupPage() {
  useTitle(t('Set up {product}', { product: PRODUCT_NAME }));
  const auth = useAuthState();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const afterSignIn = useAfterSignIn();
  const [token, setToken] = useState(tokenFromHash);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Errors>({});

  // Keep the setup token out of the address bar and the history once read.
  useEffect(() => {
    if (window.location.hash.includes('token=')) {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    }
  }, []);

  if (auth.isPending) return <AuthFrame busy />;
  if (auth.isError) {
    return (
      <AuthFrame>
        <ErrorCard title={t('Cannot reach the hub')} error={auth.error} onRetry={() => void auth.refetch()} />
      </AuthFrame>
    );
  }
  if (!auth.data.setup_required) {
    return auth.data.authenticated ? <Navigate to={safeNext(params.get('next'))} replace /> : <Navigate to="/login" replace />;
  }

  const validate = (): Errors => {
    const e: Errors = {};
    if (!token.trim()) e.token = t('Paste the setup token from the hub log.');
    if (!USERNAME_RE.test(username.trim())) e.username = t("Use 1 to 64 letters, digits, '.', '_', '@' or '-'.");
    if (password.length < MIN_PASSWORD) e.password = t('Use at least {n} characters.', { n: MIN_PASSWORD });
    else if (confirm !== password) e.confirm = t('The passwords do not match.');
    return e;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) {
      const first = (['token', 'username', 'password', 'confirm'] as const).find((k) => e[k]);
      if (first) document.querySelector<HTMLInputElement>(`[name="setup-${first}"]`)?.focus();
      return;
    }
    setBusy(true);
    try {
      await api.setup(token.trim(), username.trim(), password);
      await afterSignIn();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError) {
        switch (err.code) {
          case 'setup_done':
            await afterSignIn();
            navigate('/login', { replace: true, state: { notice: t('The account already exists. Sign in with it.') } });
            return;
          case 'invalid_setup_token':
            setErrors({ token: err.message || t('The setup token is wrong. It is printed in the hub log.') });
            return;
          case 'weak_password':
            setErrors({ password: err.message || t('Choose a longer password.') });
            return;
          case 'invalid_username':
            setErrors({ username: err.message });
            return;
        }
      }
      setErrors({ form: errorText(err) });
    }
  };

  return (
    <AuthFrame
      title={t('Set up {product}', { product: PRODUCT_NAME })}
      intro={t('Create the administrator account. This page is only available until the first account exists.')}
    >
      <form className="form-stack" onSubmit={(e) => void submit(e)} noValidate>
        {errors.form && <InlineError>{errors.form}</InlineError>}
        <TextField
          label={t('Setup token')}
          name="setup-token"
          mono
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus={!token}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          hint={t('Printed in the hub log on first start (look for “{product} first-run setup”). A new token is printed on every restart until the account exists.', { product: PRODUCT_NAME })}
          error={errors.token}
          disabled={busy}
        />
        <TextField
          label={t('User name')}
          name="setup-username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus={!!token}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          error={errors.username}
          disabled={busy}
        />
        <TextField
          label={t('Password')}
          name="setup-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={t('At least {n} characters.', { n: MIN_PASSWORD })}
          error={errors.password}
          disabled={busy}
        />
        <TextField
          label={t('Confirm password')}
          name="setup-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={errors.confirm}
          disabled={busy}
        />
        <button type="submit" className="btn-primary btn-block" disabled={busy}>
          {busy && <span className="spinner on-primary" aria-hidden="true" />}
          {busy ? t('Creating account…') : t('Create account')}
        </button>
      </form>
    </AuthFrame>
  );
}
