// Settings › Assistant (admins, docs/ASSIST.md 7): the switch, Claude Code
// and Codex (install, update, remove; sign in with a `claude setup-token`
// token or Codex's device code), the default provider, the access level,
// automatic investigations, auto-update, channel and models, and the recent
// investigations. Every change needs a recent sign-in (the client asks).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Link, useLocation } from 'react-router';
import {
  type Access,
  assistApi,
  assistKeys,
  type AssistantSettings,
  type AssistantState,
  type ProviderId,
  type ProviderState,
  useAssistant,
  useAssistantChange,
  useInvestigations,
} from '../../api/assist';
import { ApiError } from '../../api/client';
import { Skeleton } from '../../components/common';
import { Chip, Dot, Meter, SegmentedControl } from '../../components/controls';
import { errorText, InlineError, Switch, TextField } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { Menu } from '../../components/Menu';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { useNow } from '../../lib/clock';
import { formatAgoIso, formatClock, formatFull } from '../../lib/format';
import { t, tn, tx } from '../../lib/i18n';
import { useTitle } from '../../lib/useTitle';
import { Warn } from '../agents/agentParts';
import { RequireAdmin } from '../settings/SettingsLayout';
import { ACCESS, PROVIDER_NAME, stateColor, stateText } from './labels';
import { withInvestigation } from './open';

const PROVIDERS: ProviderId[] = ['claude', 'codex'];

const PROVIDER_BLURB: Record<ProviderId, string> = {
  claude: t('Anthropic’s agent. Signs in with your Claude Pro or Max subscription.'),
  codex: t('OpenAI’s agent. Signs in with your ChatGPT account.'),
};

const AUTO = [
  { value: 'off', label: t('Off') },
  { value: 'critical', label: t('Critical alerts') },
  { value: 'all', label: t('All alerts') },
] as const;

/** PUT /settings, shown at once and rolled back when the hub refuses. */
function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AssistantSettings>) => assistApi.saveSettings(patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: assistKeys.state });
      const prev = qc.getQueryData<AssistantState>(assistKeys.state);
      if (prev) qc.setQueryData<AssistantState>(assistKeys.state, { ...prev, settings: { ...prev.settings, ...patch } });
      return { prev };
    },
    onError: (err, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(assistKeys.state, ctx.prev);
      toast(t('Could not save: {error}', { error: errorText(err) }), 'error');
    },
    onSuccess: (s) => qc.setQueryData(assistKeys.state, s),
  });
}

function RunnerNotice({ runner }: { runner: AssistantState['runner'] }) {
  if (!runner.connected) {
    return <Warn>{runner.error ? t('The assistant’s runner is not reachable: {error}', { error: runner.error }) : t('The assistant’s runner is not reachable.')}</Warn>;
  }
  if (!runner.sandboxed) {
    return (
      <Warn>
        {tx('Not sandboxed: the hub runs the CLIs as its own child process (no {flag}), with the hub’s rights. Packaged installs use {unit}.', {
          flag: <code className="mono">--assist-socket</code>,
          unit: <code className="mono">rackoon-assist.socket</code>,
        })}
      </Warn>
    );
  }
  return null;
}

// ---------------------------------------------------------------- providers

function ClaudeSignIn({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const signIn = useAssistantChange((v: string) => assistApi.signIn('claude', v));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!token.trim()) return setError(t('Paste the token.'));
    signIn.mutate(token.trim(), {
      onSuccess: () => {
        toast(t('Signed in to Claude Code.'), 'success');
        onClose();
      },
      onError: (err) => setError(errorText(err)),
    });
  };
  return (
    <Modal
      open
      onClose={onClose}
      busy={signIn.isPending}
      title={t('Sign in to Claude Code')}
      description={tx('Run {cmd} on a computer where you use Claude Code and paste the token.', { cmd: <code className="mono">claude setup-token</code> })}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={signIn.isPending}>
            {t('Cancel')}
          </button>
          <button type="submit" form="claude-token-form" className="btn-primary" disabled={signIn.isPending}>
            {signIn.isPending ? t('Signing in…') : t('Sign in')}
          </button>
        </>
      }
    >
      <form id="claude-token-form" onSubmit={submit}>
        <TextField
          label={t('Token')}
          type="password"
          mono
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-oat01-…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          hint={t('It uses your Claude subscription. Rackoon keeps it in the assistant’s own state, never in its database.')}
          error={error || undefined}
        />
      </form>
    </Modal>
  );
}

/** Codex's device login: the code to enter at the link; SSE flips the provider to signed in. */
function DeviceLogin({ login, onCancel, busy }: { login: NonNullable<ProviderState['login']>; onCancel: () => void; busy: boolean }) {
  const now = useNow();
  const expires = Date.parse(login.expires_at);
  return (
    <div className="inv-device" role="status">
      <span>
        {tx('Open {link} and enter this code:', {
          link: (
            <a href={login.verification_url} target="_blank" rel="noopener noreferrer" className="link">
              {login.verification_url}
              <Icon name="externalLink" size={13} />
            </a>
          ),
        })}
      </span>
      <span className="inv-code mono" aria-label={t('Code {code}', { code: login.user_code.split('').join(' ') })}>
        {login.user_code}
      </span>
      <span className="lbl inv-device-wait">
        <span className="spinner spinner-sm" aria-hidden="true" />
        {Number.isFinite(expires) ? t('Waiting for you to sign in · the code expires {time}', { time: formatClock(expires, now) }) : t('Waiting for you to sign in…')}
      </span>
      <div>
        <button type="button" className="btn-ghost row-action" onClick={onCancel} disabled={busy}>
          {t('Cancel')}
        </button>
      </div>
    </div>
  );
}

function ProviderCard({ p }: { p: ProviderState }) {
  const now = useNow(30_000);
  const titleId = useId();
  const [signingIn, setSigningIn] = useState(false);
  const fail = (what: string) => (err: Error) => toast(`${what}: ${errorText(err)}`, 'error');
  const install = useAssistantChange(() => assistApi.install(p.id));
  const uninstall = useAssistantChange(() => assistApi.uninstall(p.id));
  const signIn = useAssistantChange(() => assistApi.signIn(p.id));
  const signOut = useAssistantChange(() => assistApi.signOut(p.id));
  const pending = install.isPending || uninstall.isPending || signIn.isPending || signOut.isPending;
  const busy = !!p.busy || pending;
  const name = p.name || PROVIDER_NAME[p.id];
  const pct = p.progress != null ? Math.round(p.progress * 100) : null;
  return (
    <section className="card settings-card inv-provider" aria-labelledby={titleId}>
      <div className="list-card-head">
        <h2 className="h2" id={titleId}>
          {name}
        </h2>
        {p.installed ? (
          <Chip dot={p.signed_in ? 'var(--good)' : 'var(--warning)'}>{p.signed_in ? t('Ready') : t('Signed out')}</Chip>
        ) : (
          <Chip>{t('Not installed')}</Chip>
        )}
      </div>
      {p.busy && (
        <div className="inv-progress" role="status">
          {p.busy === 'installing' ? (
            <>
              <span>{pct != null ? t('Installing… {pct}%', { pct }) : t('Installing…')}</span>
              <Meter pct={pct ?? 0} color="var(--ink-2)" />
            </>
          ) : (
            <span className="inv-device-wait">
              <span className="spinner spinner-sm" aria-hidden="true" />
              {t('Removing…')}
            </span>
          )}
        </div>
      )}
      {!p.installed && !p.busy && <p className="ink-2 inv-blurb">{PROVIDER_BLURB[p.id]}</p>}
      {p.installed && (
        <dl className="kv-grid is-plain">
          <div>
            <dt className="lbl">{t('Version')}</dt>
            <dd>
              <span className="mono">{p.version ?? '?'}</span>
              {p.update_available && p.latest && <span className="lbl kv-sub">{t('Update available: {version}', { version: p.latest })}</span>}
              {!p.update_available && p.latest && <span className="lbl kv-sub">{t('Up to date')}</span>}
            </dd>
          </div>
          <div>
            <dt className="lbl">{t('Last check')}</dt>
            <dd>
              {p.checked_at ? (
                <time dateTime={p.checked_at} title={formatFull(Date.parse(p.checked_at))}>
                  {formatAgoIso(p.checked_at, now)}
                </time>
              ) : (
                t('Never')
              )}
            </dd>
          </div>
          <div>
            <dt className="lbl">{t('Account')}</dt>
            <dd>{p.signed_in ? (p.account ?? t('Signed in')) : t('Not signed in')}</dd>
          </div>
        </dl>
      )}
      {p.error && <InlineError>{p.error}</InlineError>}
      {p.login && <DeviceLogin login={p.login} busy={pending} onCancel={() => signOut.mutate(undefined, { onError: fail(t('Could not cancel the sign-in')) })} />}
      <div className="form-actions is-start">
        {!p.installed ? (
          <button type="button" className="btn-primary" disabled={busy} onClick={() => install.mutate(undefined, { onError: fail(t('Could not install {name}', { name })) })}>
            <Icon name="download" size={15} />
            {t('Install')}
            <span className="sr-only"> {name}</span>
          </button>
        ) : (
          <>
            {p.update_available && (
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => install.mutate(undefined, { onError: fail(t('Could not update {name}', { name })) })}>
                <Icon name="refresh" size={15} />
                {p.latest ? t('Update to {version}', { version: p.latest }) : t('Update')}
                <span className="sr-only"> {name}</span>
              </button>
            )}
            {p.signed_in ? (
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => signOut.mutate(undefined, { onError: fail(t('Could not sign out')) })}>
                {t('Sign out')}
                <span className="sr-only"> {name}</span>
              </button>
            ) : (
              !p.login && (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy}
                  onClick={() => (p.id === 'claude' ? setSigningIn(true) : signIn.mutate(undefined, { onError: fail(t('Could not start the sign-in')) }))}
                >
                  {t('Sign in')}
                  <span className="sr-only"> {name}</span>
                </button>
              )
            )}
            <Menu
              label={t('More for {name}', { name })}
              items={[{ label: t('Remove {name}', { name }), icon: 'trash', danger: true, disabled: busy, onSelect: () => uninstall.mutate(undefined, { onError: fail(t('Could not remove {name}', { name })) }) }]}
            />
          </>
        )}
      </div>
      {signingIn && <ClaudeSignIn onClose={() => setSigningIn(false)} />}
    </section>
  );
}

// ---------------------------------------------------------------- investigation settings

function Models({ s, save }: { s: AssistantSettings; save: ReturnType<typeof useSaveSettings> }) {
  const [claude, setClaude] = useState<string | null>(null);
  const [codex, setCodex] = useState<string | null>(null);
  const dirty = (claude !== null && claude !== s.claude_model) || (codex !== null && codex !== s.codex_model);
  return (
    <details className="lc-advanced">
      <summary>{t('Advanced')}</summary>
      <div className="form-stack">
        <div className="inv-field">
          <span className="field-label" aria-hidden="true">
            {t('Claude Code channel')}
          </span>
          <SegmentedControl
            label={t('Claude Code channel')}
            options={[
              { value: 'stable', label: t('Stable') },
              { value: 'latest', label: t('Latest') },
            ]}
            value={s.claude_channel}
            onChange={(v) => save.mutate({ claude_channel: v })}
          />
          <span className="field-hint">{t('Latest gets new versions about a week earlier.')}</span>
        </div>
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(
              { ...(claude !== null ? { claude_model: claude.trim() } : {}), ...(codex !== null ? { codex_model: codex.trim() } : {}) },
              {
                onSuccess: () => {
                  setClaude(null);
                  setCodex(null);
                  toast(t('Models saved.'), 'success');
                },
              },
            );
          }}
        >
          <div className="form-grid">
            <TextField label={t('Claude Code model')} mono value={claude ?? s.claude_model} placeholder={t('Default (opus, sonnet, …)')} maxLength={128} onChange={(e) => setClaude(e.target.value)} />
            <TextField label={t('Codex model')} mono value={codex ?? s.codex_model} placeholder={t('Default (gpt-5-codex, …)')} maxLength={128} onChange={(e) => setCodex(e.target.value)} />
          </div>
          <div className="form-actions is-start">
            <button type="submit" className="btn-ghost" disabled={!dirty || save.isPending}>
              {t('Save models')}
            </button>
            <span className="lbl">{t('Empty: the CLI’s default. New investigations use them.')}</span>
          </div>
        </form>
      </div>
    </details>
  );
}

function InvestigationSettings({ state }: { state: AssistantState }) {
  const save = useSaveSettings();
  const s = state.settings;
  const titleId = useId();
  const accessName = useId();
  // The choice shows at once (a controlled radio would flip back until the cache updates).
  const [access, setAccess] = useState<Access | null>(null);
  return (
    <section className="card settings-card" aria-labelledby={titleId}>
      <h2 className="h2" id={titleId}>
        {t('Investigations')}
      </h2>
      <div className="inv-field">
        <span className="field-label" aria-hidden="true">
          {t('Default provider')}
        </span>
        <SegmentedControl
          label={t('Default provider')}
          options={PROVIDERS.map((p) => ({
            value: p,
            label: PROVIDER_NAME[p],
            disabled: !state.providers[p]?.installed,
            title: state.providers[p]?.installed ? undefined : t('Install it first'),
          }))}
          value={s.provider}
          onChange={(v) => save.mutate({ provider: v })}
        />
      </div>
      <fieldset className="inv-radios">
        <legend className="field-label">{t('Access')}</legend>
        {ACCESS.map((a) => (
          <label key={a.value} className="inv-radio">
            <input
              type="radio"
              name={accessName}
              value={a.value}
              checked={(access ?? s.access) === a.value}
              onChange={() => {
                setAccess(a.value);
                save.mutate({ access: a.value }, { onSettled: () => setAccess(null) });
              }}
            />
            <span>
              <span className="switch-label">{a.label}</span>
              <span className="lbl"> — {a.text}</span>
            </span>
          </label>
        ))}
        <span className="field-hint">{t('On top of this, each host’s own switches apply: commands need its Host shell, guest actions its Power actions.')}</span>
      </fieldset>
      <div className="inv-field">
        <span className="field-label" aria-hidden="true">
          {t('Investigate new alerts automatically')}
        </span>
        <SegmentedControl label={t('Investigate new alerts automatically')} options={AUTO.map((o) => ({ value: o.value, label: o.label }))} value={s.auto_investigate} onChange={(v) => save.mutate({ auto_investigate: v })} />
        <span className="field-hint">{t('One at a time and at most 6 an hour, for alerts that need attention for a minute (not acknowledged or muted).')}</span>
      </div>
      <Switch
        checked={s.auto_update}
        onChange={(v) => save.mutate({ auto_update: v })}
        label={t('Keep Claude Code and Codex up to date')}
        description={t('Checks every 6 hours and installs new versions; running investigations keep theirs.')}
      />
      <Models s={s} save={save} />
    </section>
  );
}

function RecentInvestigations({ enabled }: { enabled: boolean }) {
  const list = useInvestigations({ limit: 10 });
  const loc = useLocation();
  const now = useNow(30_000);
  const titleId = useId();
  // Off and never used: nothing to show.
  if (!enabled && list.data?.length === 0) return null;
  return (
    <section className="card list-card" aria-labelledby={titleId}>
      <div className="list-card-head">
        <h2 className="h2" id={titleId}>
          {t('Recent investigations')}
        </h2>
        <span className="lbl">{t('Kept 180 days')}</span>
      </div>
      {list.isError && !list.data ? (
        <InlineRetry title={t('Could not load the investigations')} error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data ? (
        <Skeleton height={80} />
      ) : list.data.length === 0 ? (
        <div className="alert-empty">{t('No investigations yet. Start one from an alert (Investigate) or a host (Ask assistant).')}</div>
      ) : (
        <ul className="plain-list" aria-labelledby={titleId}>
          {list.data.map((i) => (
            <li key={i.id} className="inv-row">
              <Link to={loc.pathname + withInvestigation(loc.search, i.id)} className="inv-row-link">
                <Dot color={stateColor(i)} />
                <span className="inv-row-main">
                  <span className="strong inv-row-title">{i.title}</span>
                  <span className="lbl">
                    {i.server ? <span className="mono">{i.server_name ?? i.server}</span> : t('All hosts')}
                    {' · '}
                    {stateText(i)}
                    {i.auto ? ` · ${t('automatic')}` : ''}
                  </span>
                </span>
                <time className="lbl" dateTime={i.updated_at} title={formatFull(Date.parse(i.updated_at))}>
                  {formatAgoIso(i.updated_at, now)}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AssistantSettingsView() {
  const q = useAssistant();
  const save = useSaveSettings();
  if (!q.data) {
    if (q.isError) {
      const missing = q.error instanceof ApiError && q.error.status === 404;
      return (
        <div className="card settings-card">
          {missing ? <p className="ink-2">{t('This hub has no assistant yet: update the hub.')}</p> : <InlineRetry title={t('Could not load the assistant')} error={q.error} onRetry={() => void q.refetch()} />}
        </div>
      );
    }
    return (
      <div aria-busy="true" aria-label={t('Loading the assistant')} className="form-stack">
        <Skeleton height={96} />
        <Skeleton height={220} />
      </div>
    );
  }
  const state = q.data;
  const s = state.settings;
  const usable = PROVIDERS.some((p) => state.providers[p]?.installed && state.providers[p]?.signed_in);
  return (
    <>
      <section className="card settings-card" aria-label={t('Assistant')}>
        <Switch
          checked={s.enabled}
          busy={save.isPending}
          onChange={(v) => save.mutate({ enabled: v })}
          label={t('Assistant')}
          description={t('Admins can start investigations from alerts and hosts. Turning it on also turns on the read-only diagnostics on every host; a host’s Agent tab can turn them off.')}
        />
        {s.enabled && !usable && <Warn>{t('Install Claude Code or Codex below and sign in, then investigations can start.')}</Warn>}
        {s.enabled && state.running > 0 && (
          <span className="lbl inv-device-wait">
            <span className="spinner spinner-sm" aria-hidden="true" />
            {tn(state.running, '{n} investigation running', '{n} investigations running')}
          </span>
        )}
        <RunnerNotice runner={state.runner} />
      </section>
      <div className="settings-grid">
        {PROVIDERS.map((p) => state.providers[p] && <ProviderCard key={p} p={state.providers[p]} />)}
      </div>
      <InvestigationSettings state={state} />
      <RecentInvestigations enabled={s.enabled} />
    </>
  );
}

export function AssistantPage() {
  useTitle(t('Assistant'));
  return (
    <RequireAdmin title={t('Assistant')} text={t('Only admins set up the assistant and run investigations.')}>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t('Assistant')}</h1>
          <p className="page-sub">{t('Claude Code or Codex investigates alerts and questions: it gathers evidence on your hosts through Rackoon, explains what is wrong and, when its access allows, fixes it.')}</p>
        </div>
      </header>
      <AssistantSettingsView />
    </RequireAdmin>
  );
}
