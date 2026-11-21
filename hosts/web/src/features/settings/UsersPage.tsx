// Settings › Users (admins): who can sign in and with which role. Add a
// user (a temporary password shown once, or a single sign-on account),
// change a role, reset a password, see and end sessions, delete. Changes
// need a recent sign-in (the hub asks, ReauthDialog confirms). You change
// your own account on the Account page.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { accountKeys, accountsApi, type User, type UserChange, type UserSource, useUserSessions, useUsers } from '../../api/accounts';
import { useAuthState } from '../../api/queries';
import type { Role } from '../../api/types';
import { ROLE_LABEL } from '../../components/AccountMenu';
import { Skeleton } from '../../components/common';
import { Chip, SegmentedControl } from '../../components/controls';
import { CopyBlock, errorText, InlineError, TextField } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { Menu } from '../../components/Menu';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { useNow } from '../../lib/clock';
import { formatAgoIso, formatFull, plural } from '../../lib/format';
import { t, tx } from '../../lib/i18n';
import { useReturnFocus } from '../../lib/useReturnFocus';
import { useTitle } from '../../lib/useTitle';
import { RequireAdmin } from './SettingsLayout';

const ROLES: Role[] = ['viewer', 'operator', 'admin'];

export const ROLE_HINT: Record<Role, string> = {
  viewer: t('Sees every page; no consoles or power actions.'),
  operator: t('Also opens consoles and runs power actions where remote control is on.'),
  admin: t('Everything, including agents, users, notifications and the audit log.'),
};

/** "Firefox on Linux" from a user agent string (enough to tell sessions apart). */
export function describeAgent(ua: string): string {
  if (!ua) return t('Unknown browser');
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : /curl|Wget|python|Go-http/i.test(ua)
            ? 'Script'
            : 'Browser';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux|X11/.test(ua)
            ? 'Linux'
            : '';
  return os ? t('{browser} on {os}', { browser, os }) : browser;
}

function RoleControl({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  return (
    <div className="form-stack">
      <SegmentedControl label={t('Role')} options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} value={value} onChange={onChange} />
      <span className="lbl">{ROLE_HINT[value]}</span>
    </div>
  );
}

/** The temporary password of a new account or a reset, shown once. */
function TemporaryPassword({ name, password, onClose }: { name: string; password: string; onClose: () => void }) {
  return (
    <Modal
      open
      onClose={onClose}
      title={t('Temporary password for {name}', { name })}
      description={t('Give it to {name}; it is shown only now. They choose their own password at the next sign-in.', { name })}
      actions={
        <button type="button" className="btn-primary" onClick={onClose}>
          {t('Done')}
        </button>
      }
    >
      <CopyBlock text={password} label={t('Temporary password')} />
    </Modal>
  );
}

function AddUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (c: UserChange) => void }) {
  const qc = useQueryClient();
  const auth = useAuthState();
  const sso = auth.data?.oidc ?? null;
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [source, setSource] = useState<UserSource>('local');
  const [error, setError] = useState('');
  const create = useMutation({
    mutationFn: () => accountsApi.createUser({ name: name.trim(), role, source }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: accountKeys.users });
      onCreated(c);
    },
    onError: (err) => setError(errorText(err)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) return setError(t('Give the user a name.'));
    create.mutate();
  };
  return (
    <Modal
      open
      onClose={onClose}
      busy={create.isPending}
      title={t('Add user')}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={create.isPending}>
            {t('Cancel')}
          </button>
          <button type="submit" form="add-user-form" className="btn-primary" disabled={create.isPending}>
            {create.isPending && <span className="spinner on-primary" aria-hidden="true" />}
            {t('Add user')}
          </button>
        </>
      }
    >
      <form id="add-user-form" className="form-stack" onSubmit={submit} noValidate>
        <TextField
          label={t('User name')}
          value={name}
          autoFocus
          autoCapitalize="none"
          spellCheck={false}
          maxLength={64}
          onChange={(e) => setName(e.target.value)}
          hint={source === 'oidc' ? t('As {provider} sends it; linked at the first sign-in.', { provider: sso?.name ?? t('the provider') }) : t('Letters, digits, ".", "_", "@" or "-".')}
        />
        <RoleControl value={role} onChange={setRole} />
        {sso && (
          <div className="form-stack">
            <SegmentedControl
              label={t('Signs in with')}
              options={[
                { value: 'local', label: t('Password') },
                { value: 'oidc', label: sso.name },
              ]}
              value={source}
              onChange={setSource}
            />
            <span className="lbl">{source === 'local' ? t('You get a temporary password to hand over.') : t('No password: they sign in through the provider.')}</span>
          </div>
        )}
        {error && <InlineError>{error}</InlineError>}
      </form>
    </Modal>
  );
}

function RoleDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const qc = useQueryClient();
  const [role, setRole] = useState<Role>(user.role);
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: () => accountsApi.setRole(user.id, role),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: accountKeys.users });
      toast(t('{name} is now {role}.', { name: user.name, role: ROLE_LABEL[role].toLowerCase() }), 'success');
      onClose();
    },
    onError: (err) => setError(errorText(err)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      busy={save.isPending}
      title={t('Role of {name}', { name: user.name })}
      description={t('Applies at once, also to open sessions.')}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={save.isPending}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending || role === user.role}>
            {t('Save')}
          </button>
        </>
      }
    >
      <RoleControl value={role} onChange={setRole} />
      {error && <InlineError>{error}</InlineError>}
    </Modal>
  );
}

function ConfirmDialog({
  title,
  description,
  action,
  run,
  onClose,
  onDone,
}: {
  title: string;
  description: string;
  action: string;
  run: () => Promise<unknown>;
  onClose: () => void;
  onDone: (result: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      onDone(await run());
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
      title={title}
      description={description}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn-primary is-serious" onClick={() => void go()} disabled={busy}>
            {busy && <span className="spinner on-primary" aria-hidden="true" />}
            {action}
          </button>
        </>
      }
    >
      {error && <InlineError>{error}</InlineError>}
    </Modal>
  );
}

function SessionsDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const qc = useQueryClient();
  const sessions = useUserSessions(user.id);
  const now = useNow();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: accountKeys.sessions(user.id) });
    void qc.invalidateQueries({ queryKey: accountKeys.users });
  };
  const revoke = useMutation({ mutationFn: (sid: string) => accountsApi.revokeSession(user.id, sid), onSettled: refresh, onError: (err) => toast(errorText(err), 'error') });
  const all = useMutation({
    mutationFn: () => accountsApi.revokeSessions(user.id),
    onSettled: refresh,
    onSuccess: () => toast(user.self ? t('Your other sessions were signed out.') : t('{name} was signed out everywhere.', { name: user.name }), 'success'),
    onError: (err) => toast(errorText(err), 'error'),
  });
  const list = sessions.data ?? [];
  const others = list.filter((s) => !s.current).length;
  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={t('Sessions of {name}', { name: user.name })}
      description={t('Browsers signed in now, kiosk displays included.')}
      actions={
        <>
          <button type="button" className="btn-ghost is-serious" onClick={() => all.mutate()} disabled={all.isPending || others === 0}>
            {user.self ? t('Sign out other sessions') : t('Sign out everywhere')}
          </button>
          <span className="spacer" />
          <button type="button" className="btn-primary" onClick={onClose}>
            {t('Close')}
          </button>
        </>
      }
    >
      {sessions.isError && !sessions.data ? (
        <InlineRetry title={t('Could not load the sessions')} error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : !sessions.data ? (
        <Skeleton height={60} />
      ) : list.length === 0 ? (
        <div className="lbl">{t('Not signed in anywhere.')}</div>
      ) : (
        <ul className="plain-list">
          {list.map((s) => (
            <li key={s.id} className="ch-row">
              <div className="ch-main">
                <div className="ch-line1">
                  <span className="strong" title={s.user_agent}>
                    {describeAgent(s.user_agent)}
                  </span>
                  {s.kiosk && <Chip className="chip-sm">{t('Kiosk')}</Chip>}
                  {s.current && <Chip className="chip-sm">{t('This session')}</Chip>}
                </div>
                <div className="lbl">
                  <span className="mono">{s.ip || t('unknown address')}</span>
                  {s.last_seen_at && (
                    <>
                      {' · '}
                      {tx('active {time}', {
                        time: (
                          <time dateTime={s.last_seen_at} title={formatFull(Date.parse(s.last_seen_at))}>
                            {formatAgoIso(s.last_seen_at, now)}
                          </time>
                        ),
                      })}
                    </>
                  )}
                  {s.created_at && <> · {t('signed in {time}', { time: formatAgoIso(s.created_at, now) })}</>}
                </div>
              </div>
              {!s.current && (
                <button type="button" className="btn-ghost row-action" onClick={() => revoke.mutate(s.id)} disabled={revoke.isPending}>
                  {t('Sign out')}
                  <span className="sr-only"> {describeAgent(s.user_agent)}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

type Dialog =
  | { kind: 'add' }
  | { kind: 'role' | 'reset' | 'sessions' | 'delete'; user: User }
  | { kind: 'password'; name: string; password: string }
  | null;

function UserRow({ u, sso, open }: { u: User; sso: string | null; open: (d: Dialog) => void }) {
  const qc = useQueryClient();
  const now = useNow();
  const signOut = useMutation({
    mutationFn: () => accountsApi.revokeSessions(u.id),
    onSuccess: () => toast(u.self ? t('Your other sessions were signed out.') : t('{name} was signed out everywhere.', { name: u.name }), 'success'),
    onError: (err) => toast(errorText(err), 'error'),
    onSettled: () => void qc.invalidateQueries({ queryKey: accountKeys.users }),
  });
  const self = u.self ? t('This is you: change your own account on the Account page.') : undefined;
  const facts = [
    u.last_login_at ? t('Signed in {time}', { time: formatAgoIso(u.last_login_at, now) }) : t('Never signed in'),
    u.passkeys ? plural(u.passkeys, 'passkey') : null,
    u.sessions ? plural(u.sessions, 'session') : null,
  ].filter(Boolean);
  return (
    <li className="ch-row">
      <div className="ch-main">
        <div className="ch-line1">
          <span className="strong">{u.name}</span>
          {u.self && <span className="lbl">{t('(you)')}</span>}
          <Chip className="chip-sm">{ROLE_LABEL[u.role] ?? u.role}</Chip>
          {u.source === 'oidc' && <Chip className="chip-sm">{sso ?? t('Single sign-on')}</Chip>}
          {u.must_change_password && (
            <Chip className="chip-sm" dot="var(--warning)" title={t('Signs in with a temporary password and must choose a new one.')}>
              {t('Temporary password')}
            </Chip>
          )}
        </div>
        <div className="lbl" title={u.last_login_at ? formatFull(Date.parse(u.last_login_at)) : undefined}>
          {facts.join(' · ')}
          {u.source === 'oidc' && !u.oidc_linked ? ` · ${t('waiting for the first sign-in')}` : ''}
        </div>
      </div>
      <Menu
        label={t('More for {name}', { name: u.name })}
        items={[
          {
            label: t('Change role…'),
            icon: 'shield',
            onSelect: () => open({ kind: 'role', user: u }),
            disabled: u.self || u.role_managed,
            title: self ?? (u.role_managed ? t('The role comes from {provider}.', { provider: sso ?? t('the single sign-on provider') }) : undefined),
          },
          u.source === 'local' && { label: t('Reset password…'), icon: 'key', onSelect: () => open({ kind: 'reset', user: u }), disabled: u.self, title: self },
          { label: t('Sessions…'), icon: 'monitor', onSelect: () => open({ kind: 'sessions', user: u }) },
          {
            label: u.self ? t('Sign out other sessions') : t('Sign out everywhere'),
            icon: 'logout',
            onSelect: () => signOut.mutate(),
            disabled: u.sessions <= (u.self ? 1 : 0) || signOut.isPending,
          },
          { label: t('Delete user…'), icon: 'trash', danger: true, onSelect: () => open({ kind: 'delete', user: u }), disabled: u.self, title: self },
        ]}
      />
    </li>
  );
}

export function UsersPage() {
  useTitle(t('Users'));
  const auth = useAuthState();
  const isAdmin = auth.data?.user?.role === 'admin';
  const users = useUsers(isAdmin);
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  useReturnFocus(dialog !== null);
  const sso = auth.data?.oidc?.name ?? null;
  const close = () => setDialog(null);
  const changed = (c: UserChange) => {
    void qc.invalidateQueries({ queryKey: accountKeys.users });
    if (c.temporary_password) setDialog({ kind: 'password', name: c.user.name, password: c.temporary_password });
    else {
      toast(t('{name} can now sign in with {provider}.', { name: c.user.name, provider: sso ?? t('single sign-on') }), 'success');
      close();
    }
  };
  const list = users.data ?? [];
  const admins = list.filter((u) => u.role === 'admin').length;
  return (
    <RequireAdmin title={t('Users')} text={t('Only admins manage users.')}>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t('Users')}</h1>
          <p className="page-sub">
            {t('Who can sign in, and what they may do.')}
            {users.data ? ` ${plural(list.length, 'user')}, ${plural(admins, 'admin')}.` : ''}
          </p>
        </div>
        <div className="page-controls">
          <button type="button" className="btn-ghost" onClick={() => setDialog({ kind: 'add' })}>
            <Icon name="plus" size={15} />
            {t('Add user')}
          </button>
        </div>
      </header>
      <section className="card list-card" aria-label={t('Users')}>
        {users.isError && !users.data ? (
          <InlineRetry title={t('Could not load the users')} error={users.error} onRetry={() => void users.refetch()} />
        ) : !users.data ? (
          <Skeleton height={80} />
        ) : (
          <ul className="plain-list">
            {list.map((u) => (
              <UserRow key={u.id} u={u} sso={sso} open={setDialog} />
            ))}
          </ul>
        )}
      </section>
      {dialog?.kind === 'add' && <AddUserDialog onClose={close} onCreated={changed} />}
      {dialog?.kind === 'role' && <RoleDialog user={dialog.user} onClose={close} />}
      {dialog?.kind === 'sessions' && <SessionsDialog user={dialog.user} onClose={close} />}
      {dialog?.kind === 'reset' && (
        <ConfirmDialog
          title={t('Reset the password of {name}?', { name: dialog.user.name })}
          description={t('They are signed out everywhere and get a temporary password to replace at the next sign-in. Passkeys keep working.')}
          action={t('Reset password')}
          run={() => accountsApi.resetPassword(dialog.user.id)}
          onClose={close}
          onDone={(r) => changed(r as UserChange)}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={t('Delete {name}?', { name: dialog.user.name })}
          description={t('Their sessions end now; their passkeys and API tokens are deleted. The audit log keeps what they did.')}
          action={t('Delete user')}
          run={() => accountsApi.deleteUser(dialog.user.id)}
          onClose={close}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: accountKeys.users });
            toast(t('{name} was deleted.', { name: dialog.user.name }), 'success');
            close();
          }}
        />
      )}
      {dialog?.kind === 'password' && <TemporaryPassword name={dialog.name} password={dialog.password} onClose={close} />}
    </RequireAdmin>
  );
}
