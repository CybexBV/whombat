// Account page cards: API tokens (scripts, Prometheus) and kiosk links (a
// read-only overview on a wall display). Secrets are shown once, at
// creation; revoking ends the token's use (and its kiosk sessions) at once.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { accountKeys, accountsApi, type ApiToken, type CreatedToken, kioskUrl, type TokenKind, useTokens } from '../../api/accounts';
import { useAuthState } from '../../api/queries';
import type { Role } from '../../api/types';
import { ROLE_LABEL } from '../../components/AccountMenu';
import { Skeleton } from '../../components/common';
import { Chip, SegmentedControl } from '../../components/controls';
import { CopyBlock, errorText, InlineError, TextField } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { useNow } from '../../lib/clock';
import { formatAgoIso, formatDay, formatFull, plural } from '../../lib/format';
import { t, tx } from '../../lib/i18n';
import { useReturnFocus } from '../../lib/useReturnFocus';

const EXPIRY = [
  { value: '0', label: t('Never') },
  { value: '30', label: plural(30, 'day') },
  { value: '90', label: plural(90, 'day') },
  { value: '365', label: plural(1, 'year') },
] as const;

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

const TEXT: Record<TokenKind, { title: string; noName: string; loadError: string; add: string; intro: string; empty: string; placeholder: string }> = {
  api: {
    title: t('API tokens'),
    noName: t('Give the token a name.'),
    loadError: t('Could not load the API tokens'),
    add: t('New token'),
    intro: t('For scripts and monitoring: send “Authorization: Bearer <token>”. Prometheus scrapes /metrics with one.'),
    empty: t('No API tokens.'),
    placeholder: t('e.g. Prometheus'),
  },
  kiosk: {
    title: t('Kiosk links'),
    noName: t('Give the link a name.'),
    loadError: t('Could not load the kiosk links'),
    add: t('New link'),
    intro: t('A read-only overview for a wall display, without signing in. Anyone with the link can see it.'),
    empty: t('No kiosk links.'),
    placeholder: t('e.g. Office TV'),
  },
};

function CreateDialog({ kind, onClose }: { kind: TokenKind; onClose: () => void }) {
  const qc = useQueryClient();
  const auth = useAuthState();
  const myRole = auth.data?.user?.role ?? 'viewer';
  const text = TEXT[kind];
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [days, setDays] = useState<string>(kind === 'api' ? '90' : '0');
  const [error, setError] = useState('');
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const create = useMutation({
    mutationFn: () => accountsApi.createToken({ name: name.trim(), kind, role: kind === 'api' ? role : undefined, expires_days: Number(days) }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: accountKeys.tokens });
      setCreated(c);
    },
    onError: (err) => setError(errorText(err)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) return setError(text.noName);
    create.mutate();
  };
  if (created) {
    const secret = kind === 'kiosk' ? kioskUrl(created.token) : created.token;
    return (
      <Modal
        open
        onClose={onClose}
        wide
        title={kind === 'kiosk' ? t('Kiosk link “{name}”', { name: created.name }) : t('API token “{name}”', { name: created.name })}
        description={kind === 'kiosk' ? t('Open it on the display. Copy it now: it is not shown again.') : t('Copy it now: it is not shown again.')}
        actions={
          <button type="button" className="btn-primary" onClick={onClose}>
            {t('Done')}
          </button>
        }
      >
        <CopyBlock text={secret} label={kind === 'kiosk' ? t('Kiosk link') : t('API token')} />
      </Modal>
    );
  }
  const roles = (['viewer', 'operator', 'admin'] as Role[]).filter((r) => RANK[r] <= RANK[myRole]);
  return (
    <Modal
      open
      onClose={onClose}
      busy={create.isPending}
      title={kind === 'kiosk' ? t('New kiosk link') : t('New API token')}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={create.isPending}>
            {t('Cancel')}
          </button>
          <button type="submit" form="token-form" className="btn-primary" disabled={create.isPending}>
            {create.isPending && <span className="spinner on-primary" aria-hidden="true" />}
            {t('Create')}
          </button>
        </>
      }
    >
      <form id="token-form" className="form-stack" onSubmit={submit} noValidate>
        <TextField label={t('Name')} value={name} autoFocus maxLength={64} placeholder={text.placeholder} onChange={(e) => setName(e.target.value)} />
        {kind === 'api' && roles.length > 1 && (
          <div className="form-stack">
            <SegmentedControl label={t('Access')} options={roles.map((r) => ({ value: r, label: r === 'viewer' ? t('Read only') : ROLE_LABEL[r] }))} value={role} onChange={setRole} />
            <span className="lbl">{role === 'viewer' ? t('Reads everything; changes nothing. Enough for monitoring.') : t('Acts with your {role} rights.', { role: ROLE_LABEL[role].toLowerCase() })}</span>
          </div>
        )}
        <SegmentedControl label={t('Expires')} options={EXPIRY.map((x) => ({ value: x.value, label: x.label }))} value={days} onChange={setDays} />
        {error && <InlineError>{error}</InlineError>}
      </form>
    </Modal>
  );
}

function RevokeDialog({ token, onClose }: { token: ApiToken; onClose: () => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const revoke = useMutation({
    mutationFn: () => accountsApi.deleteToken(token.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: accountKeys.tokens });
      toast(t('“{name}” revoked', { name: token.name }), 'success');
      onClose();
    },
    onError: (err) => setError(errorText(err)),
  });
  return (
    <Modal
      open
      onClose={onClose}
      busy={revoke.isPending}
      tone="serious"
      title={t('Revoke “{name}”?', { name: token.name })}
      description={token.kind === 'kiosk' ? t('Displays showing this link are signed out.') : t('Scripts and scrapes using it stop working at once.')}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={revoke.isPending}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn-primary is-serious" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
            {t('Revoke')}
          </button>
        </>
      }
    >
      {error && <InlineError>{error}</InlineError>}
    </Modal>
  );
}

function TokensCard({ kind }: { kind: TokenKind }) {
  const tokens = useTokens();
  const now = useNow();
  const text = TEXT[kind];
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  useReturnFocus(creating || !!revoking);
  const list = (tokens.data ?? []).filter((x) => (x.kind ?? 'api') === kind);
  const id = `${kind}-tokens-title`;
  return (
    <section className="card settings-card" aria-labelledby={id}>
      <div className="list-card-head">
        <h2 className="h2" id={id}>
          {text.title}
        </h2>
        <button type="button" className="btn-ghost" onClick={() => setCreating(true)}>
          <Icon name="plus" size={16} />
          {text.add}
        </button>
      </div>
      <p className="lbl">{text.intro}</p>
      {tokens.isError && !tokens.data ? (
        <InlineRetry title={text.loadError} error={tokens.error} onRetry={() => void tokens.refetch()} />
      ) : !tokens.data ? (
        <Skeleton height={48} />
      ) : list.length === 0 ? (
        <div className="alert-empty">{text.empty}</div>
      ) : (
        <ul className="plain-list passkey-list" aria-labelledby={id}>
          {list.map((x) => {
            const expired = x.expires_at !== null && Date.parse(x.expires_at) <= now;
            const used = x.last_used_at ? (
              <time dateTime={x.last_used_at} title={formatFull(Date.parse(x.last_used_at))}>
                {formatAgoIso(x.last_used_at, now)}
              </time>
            ) : null;
            return (
              <li key={x.id} className="passkey-row">
                <span className="passkey-ic" aria-hidden="true">
                  <Icon name={kind === 'kiosk' ? 'monitor' : 'key'} size={18} />
                </span>
                <div className="passkey-body">
                  <div className="ch-line1">
                    <span className="strong">{x.name}</span>
                    {kind === 'api' && <Chip className="chip-sm">{x.role === 'viewer' ? t('Read only') : ROLE_LABEL[x.role]}</Chip>}
                  </div>
                  <div className="lbl">
                    {tx('Created {day}', {
                      day: (
                        <time dateTime={x.created_at} title={formatFull(Date.parse(x.created_at))}>
                          {formatDay(Date.parse(x.created_at))}
                        </time>
                      ),
                    })}
                    {' · '}
                    {used ? (kind === 'kiosk' ? tx('last opened {when}', { when: used }) : tx('last used {time}', { time: used })) : kind === 'kiosk' ? t('never opened') : t('never used')}
                    {' · '}
                    {x.expires_at ? (
                      <time dateTime={x.expires_at} title={formatFull(Date.parse(x.expires_at))}>
                        {expired ? t('expired') : t('expires {day}', { day: formatDay(Date.parse(x.expires_at)) })}
                      </time>
                    ) : (
                      t('no expiry')
                    )}
                  </div>
                </div>
                <button type="button" className="btn-ghost row-action" onClick={() => setRevoking(x)}>
                  <Icon name="trash" size={15} />
                  {t('Revoke')}
                  <span className="sr-only"> {x.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {creating && <CreateDialog kind={kind} onClose={() => setCreating(false)} />}
      {revoking && <RevokeDialog token={revoking} onClose={() => setRevoking(null)} />}
    </section>
  );
}

export function ApiTokensCard() {
  return <TokensCard kind="api" />;
}

export function KioskLinksCard() {
  return <TokensCard kind="kiosk" />;
}
