/**
 * A person's own GitHub sign-in on a managed Whombat (Whombat essentials item 6; contracts CT-181; AP-493…): GitHub's
 * device code (show the code and github.com, copy, wait) or a pasted token, through the same `signins.*` calls as
 * Claude Code and ChatGPT (provider `github`, modes `device` and `token`). A managed box has no shell, so this is how you
 * get GitHub there; Settings → Connections → GitHub (the only place it is, AP-550, SS-05) then connects it for the burrow. The code and the token stay in
 * component state only.
 */
import { useWhombat } from '@whombat/client/react';
import {
  GITHUB_DEVICE_MODE,
  GITHUB_SIGNIN_TEXT,
  GITHUB_TOKEN_MODE,
  githubModeAvailable,
  githubSignInOf,
  SIGNIN_STATES,
  type SignInsList,
} from '@whombat/client/signins';
import type { ProviderLogin } from '@whombat/core/domain';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { type DotTone, StatusDot } from '../../components/StatusDot';
import styles from './ai.module.css';
import { DeviceCode } from './DeviceCode';
import { must, problemText } from './useAi';

const T = GITHUB_SIGNIN_TEXT;

type Flow = { kind: 'device'; login: ProviderLogin } | { kind: 'token' };

export interface GitHubSignInRowProps {
  list: SignInsList | undefined;
  /** Read the lists (and GitHub's status) again after a change. */
  onChanged: () => void;
  /** The row's title (“Your GitHub sign-in”); the state goes under it. Without one the state is the title. */
  title?: string;
  /** A signed-in state was just reached (device code or token): Repositories connects the burrow then (AP-543). */
  onSignedIn?: () => void;
}

function tone(state: string | undefined): DotTone {
  if (!state || state === 'not_signed_in') return 'mut';
  return state === 'ready' ? 'ok' : 'bad';
}

/** The row: its state (“Signed in as @maraokafor”), Sign out, and — not signed in — the device code or a token. */
export function GitHubSignInRow({ list, onChanged, title, onSignedIn }: GitHubSignInRowProps) {
  const { client } = useWhombat();
  const mine = githubSignInOf(list);
  const ready = mine?.state === 'ready';
  const [flow, setFlow] = useState<Flow | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // The panel folds into the signed-in state once the list says so.
  useEffect(() => {
    if (!done || !ready) return;
    setDone(false);
    setFlow(null);
  }, [done, ready]);

  const startDevice = async () => {
    setNote(null);
    setDone(false);
    setBusy(true);
    try {
      const login = must(
        await client.signins.loginStart({ body: { provider: 'github', authMode: GITHUB_DEVICE_MODE } }),
      );
      setFlow({ kind: 'device', login });
    } catch (error) {
      setNote(problemText(error, 'Couldn’t start GitHub’s sign-in. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setNote(null);
    try {
      must(await client.signins.logout({ params: { provider: 'github' } }));
      onChanged();
    } catch (error) {
      setNote(problemText(error, 'That didn’t work. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const signedIn = () => {
    setDone(true);
    onChanged();
    onSignedIn?.();
  };

  const status = mine
    ? mine.state === 'ready'
      ? mine.login
        ? T.signedInAs(mine.login)
        : T.signedIn
      : (SIGNIN_STATES[mine.state] ?? mine.state)
    : T.notSignedIn;
  const deviceOn = githubModeAvailable(list, GITHUB_DEVICE_MODE);
  const tokenOn = githubModeAvailable(list, GITHUB_TOKEN_MODE);

  return (
    <div className={styles.row}>
      <div className={styles.head}>
        <StatusDot tone={tone(mine?.state)} size={8} label={null} />
        <span className={styles.main}>
          {title ? <span className={styles.name}>{title}</span> : null}
          <span className={title ? styles.meta : styles.name}>{status}</span>
          {mine?.explanation ? <span className={styles.meta}>{mine.explanation}</span> : null}
        </span>
        {mine ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            aria-label={`${T.signOut} (${T.name})`}
            onClick={() => void signOut()}
          >
            {T.signOut}
          </Button>
        ) : null}
      </div>

      {!ready && !flow ? (
        <div className={styles.actions}>
          {deviceOn ? (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void startDevice()}>
              {T.signIn}
            </Button>
          ) : null}
          {tokenOn ? (
            <Button
              variant="link"
              onClick={() => {
                setNote(null);
                setFlow({ kind: 'token' });
              }}
            >
              {T.useToken}
            </Button>
          ) : null}
        </div>
      ) : null}

      {flow?.kind === 'device' ? (
        <DeviceCode
          kind="github"
          login={flow.login}
          onSignedIn={signedIn}
          onRestart={() => void startDevice()}
          onClose={() => setFlow(null)}
        />
      ) : flow?.kind === 'token' ? (
        <GitHubTokenForm
          onDone={(message) => {
            setFlow(null);
            setNote(message);
            onChanged();
            onSignedIn?.();
          }}
          onCancel={() => setFlow(null)}
        />
      ) : null}

      {note ? (
        <span className={styles.meta} role="status">
          {note}
        </span>
      ) : null}
    </div>
  );
}

/** A GitHub token instead of the device code: typed into a password field, sent once and never shown again. */
function GitHubTokenForm({ onDone, onCancel }: { onDone: (message: string) => void; onCancel: () => void }) {
  const { client } = useWhombat();
  const id = useId();
  const [secret, setSecret] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const login = must(
        await client.signins.loginStart({ body: { provider: 'github', authMode: GITHUB_TOKEN_MODE } }),
      );
      must(await client.signins.loginSubmit({ params: { loginId: login.loginId }, body: { secret } }));
      setSecret('');
      onDone(T.token.saved);
    } catch (error) {
      setProblem(problemText(error, 'That token didn’t work. Check it and try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.flow} onSubmit={(e) => void save(e)}>
      <label className={styles.field} htmlFor={id}>
        <span className={styles.fieldLabel}>{T.token.label}</span>
        <Input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          minLength={8}
          value={secret}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setSecret(e.target.value)}
        />
      </label>
      <span id={`${id}-hint`} className={styles.flowHint}>
        {T.token.hint}
      </span>
      {problem ? (
        <span className={styles.problem} role="alert">
          {problem}
        </span>
      ) : null}
      <div className={styles.flowActions}>
        <Button variant="primary" size="sm" type="submit" disabled={busy || secret.length < 8}>
          {T.token.save}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          {T.token.cancel}
        </Button>
      </div>
    </form>
  );
}
