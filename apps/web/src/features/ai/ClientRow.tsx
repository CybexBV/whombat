/**
 * One AI client as installed on this Whombat (CT-72, SUB-09): not installed, installing (with progress), installed
 * (its version; a newer tested one installs itself between turns), or failed with the reason. You install and remove
 * it. There is no update button: clients update themselves. Claude Code
 * is the only client (`CLIENT_PROVIDERS`): ChatGPT needs nothing installed and has no row (chatgpt-no-client.md AP-5610).
 *
 * Onboarding installs on its own (`autoInstall`, AP-194): choosing a client mounts its row, which starts the install
 * once when the client isn't installed; the bar shows the runtime's progress, and a failure its reason with Try again.
 * An install's own answer is shown until the list catches up with it — also a `failed` answer the list doesn't keep
 * (a runtime before Whombat SUB-55 listed `not_installed` again, so the click seemed to do nothing).
 */
import { useWhombat } from '@whombat/client/react';
import { CLIENT_NAMES, SIGNIN_TEXT } from '@whombat/client/signins';
import type { ClientStatus, LiveProvider } from '@whombat/core/domain';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { type DotTone, StatusDot } from '../../components/StatusDot';
import styles from './ai.module.css';
import { must, problemText } from './useAi';

const T = SIGNIN_TEXT;

/** “Installed · 2.1.278”, “Installing · 42%”, … */
export function clientStateText(c: ClientStatus | null): string {
  if (!c || c.state === 'not_installed') return T.notInstalled;
  if (c.state === 'installing') return T.installing(c.progress);
  if (c.state === 'failed') return c.installed ? T.installed(c.installed.version) : T.installFailed;
  if (!c.installed) return T.notInstalled;
  if (c.state === 'updating') return T.updating(c.installed.version);
  return T.installed(c.installed.version);
}

function tone(c: ClientStatus | null): DotTone {
  if (!c) return 'mut';
  if (c.state === 'failed') return 'bad';
  if (c.state === 'installing') return 'warn';
  return c.installed ? 'ok' : 'mut';
}

/** An install asked from this row: in flight, or its answer and when it came. */
export interface InstallAttempt {
  pending: boolean;
  answer: ClientStatus | null;
  at: number;
}

/**
 * What the row shows: the list, unless this row's install knows better — `installing` while the request is in flight,
 * the answer until a list read after it arrives, and a `failed` answer as long as the list says `not_installed`.
 */
export function shownClient(
  listed: ClientStatus | null,
  attempt: InstallAttempt | null,
  listedAt: number,
): ClientStatus | null {
  if (!attempt) return listed;
  const moving = listed && listed.state !== 'not_installed';
  if (attempt.pending) {
    if (moving && listed.state !== 'failed') return listed;
    return {
      provider: listed?.provider ?? attempt.answer?.provider ?? 'claude',
      installed: listed?.installed ?? null,
      latest: listed?.latest ?? null,
      state: listed?.installed ? 'updating' : 'installing',
      progress: null,
      error: null,
    };
  }
  const answer = attempt.answer;
  if (!answer) return listed;
  if (listedAt <= attempt.at) return answer;
  if (answer.state === 'failed' && !moving) return answer;
  return listed;
}

export interface ClientRowProps {
  provider: LiveProvider;
  client: ClientStatus | null;
  onChanged: () => void;
  /** Settings: the latest tested version, and Remove. */
  detailed?: boolean;
  /**
   * When the list was read (`dataUpdatedAt`, ms), so an install's answer shows until a newer read. 0: unknown.
   */
  listedAt?: number;
  /**
   * Onboarding: the list is loaded and choosing the client means installing it — the row starts the install once
   * when the client isn't installed, and offers only Try again after a failure.
   */
  autoInstall?: boolean;
  /** Settings → AI: what the host says about it, under the row (the fix, the sandbox, “Details”; SS-03). */
  children?: ReactNode;
}

export function ClientRow({
  provider,
  client: listed,
  onChanged,
  detailed = false,
  listedAt = 0,
  autoInstall = false,
  children,
}: ClientRowProps) {
  const { client: api } = useWhombat();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<InstallAttempt | null>(null);
  const name = CLIENT_NAMES[provider];
  const client = shownClient(listed, attempt, listedAt);
  const installing = client?.state === 'installing' || client?.state === 'updating';

  const act = async (what: 'install' | 'remove') => {
    if (what === 'remove' && !window.confirm(T.removeConfirm(name))) return;
    setBusy(true);
    setProblem(null);
    if (what === 'install') setAttempt({ pending: true, answer: null, at: Date.now() });
    try {
      const answer = must(
        what === 'install'
          ? await api.clients.install({ params: { provider } })
          : await api.clients.remove({ params: { provider } }),
      );
      setAttempt(what === 'install' ? { pending: false, answer, at: Date.now() } : null);
      onChanged();
    } catch (error) {
      setAttempt(null);
      setProblem(problemText(error, T.failed));
    } finally {
      setBusy(false);
    }
  };

  // Onboarding: once per mount (choosing the client again mounts the row again), when the list says not installed.
  const started = useRef(false);
  const actRef = useRef(act);
  actRef.current = act;
  const wantsInstall = autoInstall && (!listed || listed.state === 'not_installed');
  useEffect(() => {
    if (!wantsInstall || started.current) return;
    started.current = true;
    void actRef.current('install');
  }, [wantsInstall]);

  const meta = [
    clientStateText(client),
    detailed && client?.latest && client.installed?.version !== client.latest.version
      ? T.latest(client.latest.version)
      : null,
    detailed && client && !client.latest ? T.noLatest : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const missing = !client?.installed && !installing;
  const failed = client?.state === 'failed' || problem !== null;

  return (
    <div className={styles.row}>
      <div className={styles.head}>
        <StatusDot tone={tone(client)} size={8} label={null} />
        <span className={styles.main}>
          <span className={styles.name}>{name}</span>
          <span className={styles.meta}>{meta}</span>
          {client?.state === 'failed' && client.error ? (
            <span className={styles.problem}>{client.error.message}</span>
          ) : null}
        </span>
        {missing || failed ? (
          autoInstall && !failed ? null : (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void act('install')}>
              {failed ? T.retryInstall : T.install}
            </Button>
          )
        ) : detailed && client?.installed && !installing ? (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void act('remove')}>
            {T.remove}
          </Button>
        ) : null}
      </div>
      {installing ? (
        <div
          className={styles.progress}
          role="progressbar"
          aria-label={`${name} ${T.installing(null)}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={client?.progress ?? undefined}
        >
          {client?.progress == null ? (
            <span className={styles.progressFill} data-indeterminate="" />
          ) : (
            <span className={styles.progressFill} style={{ width: `${client.progress}%` }} />
          )}
        </div>
      ) : null}
      {detailed && client?.installed ? <span className={styles.hint}>{T.autoUpdates}</span> : null}
      {problem ? (
        <span className={styles.problem} role="alert">
          {problem}
        </span>
      ) : null}
      {children}
    </div>
  );
}
