/**
 * Connect your AI, the claim's third step (Whombat first-day.md): right after “Protect your Whombat”, before the
 * Whombat opens. The person picks ChatGPT or Claude Code and signs in with the same rows as Settings → AI
 * (`SignInRow`: ChatGPT's device code, Claude Code's own sign-in), so the assistant can answer from the first message.
 * Asked only while nothing is ready: a Whombat with a provider ready already, or whose sign-ins can't be read, opens at
 * once. Later opens the Whombat, where the line above Chat says the assistant can't work yet.
 */
import {
  boxSetupAiKicker,
  CONNECT_AI_PROVIDERS,
  CONNECT_AI_TEXT,
  connectAiStep,
  readyProviders,
} from '@whombat/client/managed';
import { useTheAgent } from '@whombat/client/react';
import { CLIENT_NAMES, clientOf, clientReady, needsClient, SIGNIN_TEXT } from '@whombat/client/signins';
import type { LiveProvider } from '@whombat/core/domain';
import { useEffect, useRef, useState } from 'react';
import { AuthLayout } from '../../app/auth/AuthLayout';
import { Button } from '../../components/Button';
import aiStyles from '../ai/ai.module.css';
import { ClientRow } from '../ai/ClientRow';
import { SignInRow, type SignInRowProps } from '../ai/SignIn';
import { useAiRefresh, useClientsStatus, useSignInsStatus } from '../ai/useAi';
import styles from './ConnectAiScreen.module.css';

const T = CONNECT_AI_TEXT;

export interface ConnectAiScreenProps {
  /** The Whombat's burrow (its assistant's name). */
  burrow: string;
  /** Open the Whombat. */
  onDone: () => void;
  /** Tests: a terminal without xterm. */
  terminal?: SignInRowProps['terminal'];
  /** On the box's own page this step ends the box's setup: its kicker carries on that count (“STEP 5 OF 5”). */
  afterBoxSetup?: boolean;
}

export function ConnectAiScreen({ burrow, onDone, terminal, afterBoxSetup }: ConnectAiScreenProps) {
  const signIns = useSignInsStatus();
  const clients = useClientsStatus();
  const refresh = useAiRefresh();
  const { words } = useTheAgent(burrow);
  const [asked, setAsked] = useState(false);
  const [chosen, setChosen] = useState<LiveProvider[]>([]);
  const step = connectAiStep({
    signIns: signIns.data,
    clients: clients.data,
    failed: signIns.isError || clients.isError,
    asked,
  });
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (step === 'ask') setAsked(true);
    if (step === 'go_on') done.current();
  }, [step]);

  if (step === 'go_on') return null;
  const ready = readyProviders(clients.data, signIns.data);
  const toggle = (p: LiveProvider) =>
    setChosen((now) => (now.includes(p) ? now.filter((c) => c !== p) : [...now, p]));

  return (
    <AuthLayout
      kicker={afterBoxSetup ? boxSetupAiKicker() : T.kicker}
      title={T.title}
      sub={T.sub(words.Name)}
      tip={T.tip}
    >
      {step === 'checking' ? (
        <p className={styles.status} role="status">
          {T.checking}
        </p>
      ) : (
        <div className={styles.step}>
          <div className={aiStyles.choices}>
            {CONNECT_AI_PROVIDERS.map((p) => {
              const selected = chosen.includes(p) || ready.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  className={aiStyles.choice}
                  data-selected={selected || undefined}
                  aria-pressed={selected}
                  aria-label={SIGNIN_TEXT.choose(CLIENT_NAMES[p])}
                  onClick={() => toggle(p)}
                >
                  <span className={aiStyles.check} data-selected={selected || undefined} aria-hidden="true">
                    {selected ? '✓' : ''}
                  </span>
                  <span className={aiStyles.choiceName}>{CLIENT_NAMES[p]}</span>
                  <span className={aiStyles.choiceBlurb}>{SIGNIN_TEXT.clientBlurb[p]}</span>
                </button>
              );
            })}
          </div>
          {CONNECT_AI_PROVIDERS.filter((p) => chosen.includes(p) || ready.includes(p)).map((p) => (
            <section key={p} className={aiStyles.card} aria-label={CLIENT_NAMES[p]}>
              {needsClient(p) ? (
                <ClientRow
                  provider={p}
                  client={clientOf(clients.data, p)}
                  onChanged={refresh}
                  listedAt={clients.dataUpdatedAt}
                  // Choosing Claude Code is wanting it: it installs at once, as in onboarding.
                  autoInstall={clients.data !== undefined}
                />
              ) : null}
              <SignInRow
                provider={p}
                list={signIns.data}
                onChanged={refresh}
                installed={clientReady(p, clients.data)}
                titled={!needsClient(p)}
                {...(terminal && { terminal })}
              />
            </section>
          ))}
          {step === 'done' ? (
            <p className={styles.status} role="status">
              {T.ready(ready, words.Name)}
            </p>
          ) : null}
          <div className={styles.actions}>
            {step === 'done' ? (
              <Button variant="primary" size="lg" onClick={onDone}>
                {T.continue}
              </Button>
            ) : (
              <Button variant="link" onClick={onDone}>
                {T.later}
              </Button>
            )}
          </div>
        </div>
      )}
    </AuthLayout>
  );
}
