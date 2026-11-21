// Shown instead of the app while the account signs in with a temporary
// password (an admin added it or reset it): the user picks their own before
// anything else. The hub refuses every other request until then
// (403 password_change_required). The current password is not asked again
// right after the sign-in; later the re-authentication dialog asks for it.

import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { accountsApi } from '../../api/accounts';
import { ApiError } from '../../api/client';
import { qk, useAuthState } from '../../api/queries';
import { errorText, InlineError, TextField } from '../../components/forms';
import { toast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import { useTitle } from '../../lib/useTitle';
import { AuthFrame } from './AuthFrame';
import { MIN_PASSWORD } from './password';
import { useSignOut } from './session';

export function ChangePasswordPage() {
  useTitle(t('Choose a password'));
  const auth = useAuthState();
  const qc = useQueryClient();
  const { signOut, pending } = useSignOut();
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ next?: string; confirm?: string; form?: string }>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errs: typeof errors = {};
    if (next.length < MIN_PASSWORD) errs.next = t('Use at least {n} characters.', { n: MIN_PASSWORD });
    else if (confirm !== next) errs.confirm = t('The passwords do not match.');
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await accountsApi.replaceTemporaryPassword(next);
      await qc.invalidateQueries({ queryKey: qk.auth });
      toast(t('Password set.'), 'success');
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && (err.code === 'weak_password' || err.code === 'same_password')) setErrors({ next: err.message });
      else if (!(err instanceof ApiError && err.code === 'reauth_required')) setErrors({ form: errorText(err) });
    }
  };

  return (
    <AuthFrame
      title={t('Choose your password')}
      intro={auth.data?.user?.name != null ? t('{name} signed in with a temporary password. Pick your own to continue.', { name: auth.data.user.name }) : t('You signed in with a temporary password. Pick your own to continue.')}
      footer={
        <button type="button" className="btn-text" onClick={() => void signOut()} disabled={pending}>
          {t('Sign out')}
        </button>
      }
    >
      <form className="form-stack" onSubmit={(e) => void submit(e)} noValidate>
        {errors.form && <InlineError>{errors.form}</InlineError>}
        <input type="text" name="username" autoComplete="username" value={auth.data?.user?.name ?? ''} readOnly hidden />
        <TextField
          label={t('New password')}
          type="password"
          autoComplete="new-password"
          autoFocus
          value={next}
          onChange={(e) => setNext(e.target.value)}
          hint={t('At least {n} characters.', { n: MIN_PASSWORD })}
          error={errors.next}
          disabled={busy}
        />
        <TextField label={t('Confirm new password')} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errors.confirm} disabled={busy} />
        <button type="submit" className="btn-primary btn-block" disabled={busy}>
          {busy && <span className="spinner on-primary" aria-hidden="true" />}
          {busy ? t('Saving…') : t('Set password')}
        </button>
      </form>
    </AuthFrame>
  );
}
