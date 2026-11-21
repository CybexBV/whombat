// Settings › Account: who is signed in (role, Sign out), the password and
// passkeys, API tokens and kiosk links. Single sign-on accounts have no
// password card.

import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { qk, useAuthState, usePasskeys } from '../../api/queries';
import type { Passkey, Role } from '../../api/types';
import { ROLE_LABEL } from '../../components/AccountMenu';
import { Chip } from '../../components/controls';
import { errorText, InlineError, Switch, TextField } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { useNow } from '../../lib/clock';
import { formatAgoIso, formatDay, formatFull } from '../../lib/format';
import { t, tx } from '../../lib/i18n';
import { useReturnFocus } from '../../lib/useReturnFocus';
import { useTitle } from '../../lib/useTitle';
import { enableNotifications, notificationsEnabled, notificationsSupported } from '../../lib/browserNotify';
import { useSignOut } from '../auth/session';
import { MIN_PASSWORD } from '../auth/password';
import { createCredential, passkeyErrorMessage, webauthnSupported } from '../auth/webauthn';
import { ApiTokensCard, KioskLinksCard } from './AccessCards';

const ROLE_TEXT: Record<Role, string> = {
  admin: t('Full access: enrollment, server settings, remote control and the audit log.'),
  operator: t('Can open consoles and run power actions where remote control is on.'),
  viewer: t('Can see every page; no consoles or power actions.'),
};

// ------------------------------------------------------------------ account

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string; form?: string }>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errs: typeof errors = {};
    if (!current) errs.current = t('Enter your current password.');
    if (next.length < MIN_PASSWORD) errs.next = t('Use at least {n} characters.', { n: MIN_PASSWORD });
    else if (next === current) errs.next = t('Choose a password different from the current one.');
    else if (confirm !== next) errs.confirm = t('The passwords do not match.');
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      toast(t('Password changed. Other sessions were signed out.'), 'success');
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'invalid_credentials' || (err.status === 403 && err.code !== 'csrf' && err.code !== 'bad_origin'))) setErrors({ current: t('The current password is wrong.') });
      else if (err instanceof ApiError && err.code === 'weak_password') setErrors({ next: err.message });
      else setErrors({ form: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form-stack" onSubmit={(e) => void submit(e)} noValidate aria-labelledby="pw-title">
      {errors.form && <InlineError>{errors.form}</InlineError>}
      <TextField label={t('Current password')} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} error={errors.current} disabled={busy} />
      <TextField
        label={t('New password')}
        type="password"
        autoComplete="new-password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        hint={t('At least {n} characters. Other sessions are signed out.', { n: MIN_PASSWORD })}
        error={errors.next}
        disabled={busy}
      />
      <TextField label={t('Confirm new password')} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errors.confirm} disabled={busy} />
      <div>
        <button type="submit" className="btn-primary btn-sm" disabled={busy}>
          {busy && <span className="spinner on-primary" aria-hidden="true" />}
          {busy ? t('Changing…') : t('Change password')}
        </button>
      </div>
    </form>
  );
}

function PasswordCard() {
  return (
    <section className="card settings-card" aria-labelledby="pw-title">
      <h2 className="h2" id="pw-title">
        {t('Password')}
      </h2>
      <ChangePassword />
    </section>
  );
}

// ------------------------------------------------------------------ passkeys

function AddPasskeyDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const begin = await api.passkeyRegisterBegin(name.trim());
      const cred = await createCredential(begin);
      await api.passkeyRegisterFinish(cred);
      void qc.invalidateQueries({ queryKey: qk.passkeys });
      void qc.invalidateQueries({ queryKey: qk.auth });
      toast(name.trim() ? t('Passkey “{name}” added', { name: name.trim() }) : t('Passkey added'), 'success');
      onClose();
    } catch (err) {
      setBusy(false);
      setError(err instanceof ApiError ? errorText(err) : passkeyErrorMessage(err));
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      busy={busy}
      title={t('Add a passkey')}
      description={t('Sign in without a password using this device’s screen lock (Touch ID, Windows Hello), a phone or a security key.')}
    >
      <form className="form-stack" onSubmit={(e) => void submit(e)} noValidate>
        {error && <InlineError>{error}</InlineError>}
        <TextField label={t('Name')} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('e.g. MacBook Touch ID')} maxLength={64} hint={t('Helps you tell your passkeys apart.')} autoFocus disabled={busy} />
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy && <span className="spinner on-primary" aria-hidden="true" />}
            {busy ? t('Follow your browser’s prompt…') : t('Continue')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RemovePasskeyDialog({ passkey, onClose }: { passkey: Passkey; onClose: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await api.deletePasskey(passkey.id);
      void qc.invalidateQueries({ queryKey: qk.passkeys });
      void qc.invalidateQueries({ queryKey: qk.auth });
      toast(t('Passkey “{name}” removed', { name: passkey.name }), 'success');
      onClose();
    } catch (err) {
      setBusy(false);
      setError(errorText(err));
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      busy={busy}
      tone="serious"
      title={t('Remove “{name}”?', { name: passkey.name })}
      description={t('You can no longer sign in with this passkey. Your password and other passkeys keep working.')}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn-primary is-serious" onClick={() => void remove()} disabled={busy}>
            {busy && <span className="spinner on-primary" aria-hidden="true" />}
            {busy ? t('Removing…') : t('Remove passkey')}
          </button>
        </>
      }
    >
      {error && <InlineError>{error}</InlineError>}
    </Modal>
  );
}

function PasskeysCard({ available }: { available: boolean }) {
  const passkeys = usePasskeys();
  const now = useNow();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  useReturnFocus(adding || !!removing);
  const browser = webauthnSupported();
  const canAdd = available && browser;
  const list = passkeys.data ?? [];

  return (
    <section className="card settings-card" aria-labelledby="passkeys-title">
      <div className="list-card-head">
        <h2 className="h2" id="passkeys-title">
          {t('Passkeys')}
        </h2>
        <button type="button" className="btn-ghost" onClick={() => setAdding(true)} disabled={!canAdd} aria-describedby={!canAdd ? 'passkeys-why' : undefined}>
          <Icon name="plus" size={16} />
          {t('Add passkey')}
        </button>
      </div>
      {!available ? (
        <p className="lbl" id="passkeys-why">
          {t('Passkeys are not available on this hub: they need the hub’s public URL to be https with a host name (or http://localhost).')}
        </p>
      ) : !browser ? (
        <p className="lbl" id="passkeys-why">
          {t('This browser cannot use passkeys here: they need a secure (https) connection to a host name.')}
        </p>
      ) : (
        <p className="lbl">{t('Sign in with a fingerprint, face or device PIN instead of the password.')}</p>
      )}
      {passkeys.isError && !passkeys.data ? (
        <InlineRetry title={t('Could not load the passkeys')} error={passkeys.error} onRetry={() => void passkeys.refetch()} />
      ) : !passkeys.data ? (
        <div className="enroll-status" aria-busy="true">
          <span className="spinner" aria-hidden="true" />
          <span>{t('Loading…')}</span>
        </div>
      ) : list.length === 0 ? (
        <div className="alert-empty">{t('No passkeys yet.')}</div>
      ) : (
        <ul className="plain-list passkey-list" aria-labelledby="passkeys-title">
          {list.map((p) => (
            <li key={p.id} className="passkey-row">
              <span className="passkey-ic" aria-hidden="true">
                <Icon name="key" size={18} />
              </span>
              <div className="passkey-body">
                <div className="strong">{p.name}</div>
                <div className="lbl">
                  {tx('Added {day}', {
                    day: (
                      <time dateTime={p.created_at} title={formatFull(Date.parse(p.created_at))}>
                        {formatDay(Date.parse(p.created_at))}
                      </time>
                    ),
                  })}
                  {' · '}
                  {p.last_used_at
                    ? tx('last used {time}', {
                        time: (
                          <time dateTime={p.last_used_at} title={formatFull(Date.parse(p.last_used_at))}>
                            {formatAgoIso(p.last_used_at, now)}
                          </time>
                        ),
                      })
                    : t('never used')}
                </div>
              </div>
              <button type="button" className="btn-ghost row-action" onClick={() => setRemoving(p)}>
                <Icon name="trash" size={15} />
                {t('Remove')}
                <span className="sr-only"> {t('passkey {name}', { name: p.name })}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding && <AddPasskeyDialog onClose={() => setAdding(false)} />}
      {removing && <RemovePasskeyDialog passkey={removing} onClose={() => setRemoving(null)} />}
    </section>
  );
}

// ------------------------------------------------------------------ page

// ------------------------------------------------------------------ this browser

function BrowserCard() {
  const [notify, setNotify] = useState(notificationsEnabled());
  const [busy, setBusy] = useState(false);
  const supported = notificationsSupported();
  return (
    <section className="card settings-card" aria-labelledby="browser-title">
      <h2 className="h2" id="browser-title">
        {t('This browser')}
      </h2>
      <Switch
        checked={notify}
        busy={busy}
        disabled={!supported}
        label={t('Notify me of new alerts')}
        description={
          supported
            ? Notification.permission === 'denied'
              ? t('The browser blocks notifications for this site; allow them in its site settings first.')
              : t('A desktop notification when an alert opens while this tab is in the background.')
            : t('This browser does not support notifications.')
        }
        onChange={(v) => {
          setBusy(true);
          void enableNotifications(v)
            .then((on) => {
              setNotify(on);
              if (v && !on) toast(t('Notifications were not allowed.'), 'error');
            })
            .finally(() => setBusy(false));
        }}
      />
    </section>
  );
}

export function AccountPage() {
  useTitle(t('Account'));
  const auth = useAuthState();
  const { signOut, pending } = useSignOut();
  const user = auth.data?.user;
  if (!user) return null;
  return (
    <>
      <header className="page-head">
        <div className="account-who">
          <span className="account-avatar" aria-hidden="true">
            {user.name.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <h1 className="page-title">{t('Account')}</h1>
            <div className="account-line">
              <span className="strong">{user.name}</span>
              <Chip className="chip-sm">{ROLE_LABEL[user.role] ?? user.role}</Chip>
              {auth.data?.source === 'oidc' && <Chip className="chip-sm">{t('Signs in with {name}', { name: auth.data.oidc?.name ?? t('single sign-on') })}</Chip>}
              <span className="lbl">{ROLE_TEXT[user.role] ?? ''}</span>
            </div>
          </div>
        </div>
        <div className="page-controls">
          <button type="button" className="btn-ghost" onClick={() => void signOut()} disabled={pending}>
            <Icon name="logout" size={16} />
            {t('Sign out')}
          </button>
        </div>
      </header>
      <div className="settings-grid">
        {auth.data?.has_password !== false && <PasswordCard />}
        <PasskeysCard available={auth.data?.passkeys_available !== false} />
        <ApiTokensCard />
        <KioskLinksCard />
      <BrowserCard />
      </div>
    </>
  );
}
