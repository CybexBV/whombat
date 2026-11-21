/**
 * Signing in to Claude Code or ChatGPT (SUB-01…SUB-05): the person's own subscription (Claude Code's sign-in console,
 * ChatGPT's device code, OpenAI's own sign-in) or their own API key — one sign-in per provider (one-person.md OP-09). Only Claude Code's subscription sign-in waits for an install (chatgpt-no-client.md AP-5612).
 * Every call is `signins.*` through the typed client (CT-70), so self-hosted (REST) and managed (session) share it.
 * Keys are typed into password fields, sent once in a `secret` op and never shown again.
 */
import { useWhombat } from '@whombat/client/react';
import {
  API_KEY_MODE,
  CLIENT_NAMES,
  modeOf,
  needsClient,
  SIGNIN_STATES,
  SIGNIN_TEXT,
  type SignInsList,
  SUBSCRIPTION_MODE,
  signInOf,
} from '@whombat/client/signins';
import type { LiveProvider, ProviderLogin } from '@whombat/core/domain';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { type DotTone, StatusDot } from '../../components/StatusDot';
import styles from './ai.module.css';
import { ClaudeSignIn, type ClaudeSignInProps } from './ClaudeSignIn';
import { DeviceCode } from './DeviceCode';
import { must, problemText } from './useAi';

const T = SIGNIN_TEXT;

type Flow = { kind: 'console' } | { kind: 'device'; login: ProviderLogin } | { kind: 'key' };

export interface SignInRowProps {
  provider: LiveProvider;
  list: SignInsList | undefined;
  /** Refetch the lists after a change. */
  onChanged: () => void;
  /**
   * The client isn't installed yet: the subscription sign-in runs it, so it waits (Claude Code; ChatGPT needs nothing
   * installed and never waits, AP-5612).
   */
  installed?: boolean;
  /**
   * Show the provider's name as the row's title (Settings, and onboarding's ChatGPT card, which has no client row);
   * onboarding's Claude Code card names it already.
   */
  titled?: boolean;
  /** Tests: a terminal without xterm. */
  terminal?: ClaudeSignInProps['terminal'];
  /**
   * Settings → AI in the assistant shell (less-is-more.md AP-1780): once signed in, the plan before the state (“Max
   * plan · Signed in with your Claude subscription”), a note after it (`after`: “usage as of 10:32”), a small control
   * beside Sign out (Refresh) and the usage meters under the row.
   */
  plan?: string | null;
  after?: string | null;
  tools?: ReactNode;
  children?: ReactNode;
}

function tone(state: string | undefined): DotTone {
  if (!state || state === 'not_signed_in') return 'mut';
  if (state === 'ready') return 'ok';
  return state === 'quota_exhausted' || state === 'outage' || state === 'version_drift' ? 'warn' : 'bad';
}

export function SignInRow({
  provider,
  list,
  onChanged,
  installed: clientInPlace = true,
  titled = false,
  terminal,
  plan = null,
  after = null,
  tools,
  children,
}: SignInRowProps) {
  const { client } = useWhombat();
  const name = CLIENT_NAMES[provider];
  const installed = clientInPlace || !needsClient(provider);
  const mine = signInOf(list, provider);
  const ready = mine?.state === 'ready';
  const subscription = modeOf(list, provider, SUBSCRIPTION_MODE[provider]);
  const ownKey = modeOf(list, provider, API_KEY_MODE);
  const running = (list?.consoles ?? []).find((c) => c.state === 'running') ?? null;
  const [flow, setFlow] = useState<Flow | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The sign-in in the panel said it worked: the panel folds into the row's signed-in state once the list says so. */
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done || !ready) return;
    setDone(false);
    setFlow(null);
  }, [done, ready]);
  // A reloaded page picks up a console that still runs (CT-71).
  const resumed = useRef(false);
  useEffect(() => {
    if (provider !== 'claude' || !running || resumed.current) return;
    resumed.current = true;
    setFlow({ kind: 'console' });
  }, [provider, running]);

  const startSubscription = async () => {
    setNote(null);
    setDone(false);
    if (provider === 'claude') {
      setFlow({ kind: 'console' });
      return;
    }
    setBusy(true);
    try {
      const login = must(
        await client.signins.loginStart({ body: { provider, authMode: SUBSCRIPTION_MODE[provider] } }),
      );
      setFlow({ kind: 'device', login });
    } catch (error) {
      setNote(problemText(error, T.failed));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setNote(null);
    try {
      must(await client.signins.logout({ params: { provider } }));
      onChanged();
    } catch (error) {
      setNote(problemText(error, T.failed));
    } finally {
      setBusy(false);
    }
  };

  const signedIn = () => {
    setDone(true);
    onChanged();
  };

  const status = mine
    ? mine.state === 'ready'
      ? (T.signedIn[mine.authMode] ?? T.signedInOther)
      : (SIGNIN_STATES[mine.state] ?? mine.state)
    : T.notSignedIn;
  const subscriptionOff = subscription && !subscription.available;

  return (
    <div className={styles.row}>
      <div className={styles.head}>
        <StatusDot tone={tone(mine?.state)} size={8} label={null} />
        <span className={styles.main}>
          {titled ? <span className={styles.name}>{name}</span> : null}
          {ready && (plan || after) ? (
            <span className={styles.meta} data-signin-line="">
              {plan ? `${plan} · ` : null}
              <span>{status}</span>
              {after ? ` · ${after}` : null}
            </span>
          ) : (
            <span className={titled ? styles.meta : styles.name}>{status}</span>
          )}
          {mine?.explanation ? <span className={styles.meta}>{mine.explanation}</span> : null}
        </span>
        {mine ? (
          <span className={styles.headActions}>
            {ready && tools ? tools : null}
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void signOut()}>
              {T.signOut}
            </Button>
          </span>
        ) : null}
      </div>
      {ready && !flow ? children : null}

      {!ready && !flow ? (
        <div className={styles.actions}>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !installed || !!subscriptionOff}
            aria-label={`${T.subscription} (${name})`}
            onClick={() => void startSubscription()}
          >
            {T.subscription}
          </Button>
          {ownKey?.available !== false ? (
            <Button
              variant="link"
              aria-label={`${T.ownKey} (${name})`}
              onClick={() => {
                setNote(null);
                setFlow({ kind: 'key' });
              }}
            >
              {T.ownKey}
            </Button>
          ) : null}
        </div>
      ) : null}
      {!ready && !flow && subscriptionOff && subscription.reason ? (
        <span className={styles.meta}>{subscription.reason}</span>
      ) : !ready && !flow && !installed ? (
        <span className={styles.hint}>{T.needsInstall(name)}</span>
      ) : null}

      {flow?.kind === 'console' ? (
        <ClaudeSignIn
          resume={running}
          onSignedIn={signedIn}
          onClose={() => {
            setFlow(null);
            onChanged();
          }}
          {...(terminal && { terminal })}
        />
      ) : flow?.kind === 'device' ? (
        <DeviceCode
          login={flow.login}
          onSignedIn={signedIn}
          onRestart={() => void startSubscription()}
          onClose={() => setFlow(null)}
        />
      ) : flow?.kind === 'key' ? (
        <KeyForm
          provider={provider}
          onDone={(message) => {
            setFlow(null);
            setNote(message);
            onChanged();
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

/** The person's own API key for a provider. */
export function KeyForm({
  provider,
  onDone,
  onCancel,
}: {
  provider: LiveProvider;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const { client } = useWhombat();
  const ids = { secret: useId() };
  const [secret, setSecret] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const login = must(await client.signins.loginStart({ body: { provider, authMode: API_KEY_MODE } }));
      const done = must(
        await client.signins.loginSubmit({ params: { loginId: login.loginId }, body: { secret } }),
      );
      setSecret('');
      onDone(done.verified === 'valid' ? T.key.valid : T.key.unverified);
    } catch (error) {
      setProblem(problemText(error, T.failed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.flow} onSubmit={(e) => void save(e)}>
      <div className={styles.keyFields}>
        <label className={styles.field} htmlFor={ids.secret}>
          <span className={styles.fieldLabel}>{`${CLIENT_NAMES[provider]} ${T.key.label}`}</span>
          <Input
            id={ids.secret}
            type="password"
            autoComplete="off"
            spellCheck={false}
            required
            minLength={8}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
      </div>
      {problem ? (
        <span className={styles.problem} role="alert">
          {problem}
        </span>
      ) : null}
      <div className={styles.flowActions}>
        <Button variant="primary" size="sm" type="submit" disabled={busy || !secret}>
          {T.key.save}
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          {T.key.cancel}
        </Button>
      </div>
    </form>
  );
}
