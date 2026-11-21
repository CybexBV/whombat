/**
 * Onboarding's “Set up your AI” (SUB-08, CT-68; not in the mocks — built from the step's agent cards and repo/invite
 * rows): pick Claude Code, ChatGPT or both, see Claude Code install as soon as it's picked, and sign in to each with
 * your own subscription or an API key. ChatGPT needs
 * nothing installed: its card is its sign-in alone, titled (chatgpt-no-client.md AP-5615). Then the agent's provider,
 * among those that are ready and signed in. `clients` stays the contract's record of what was picked, `codex` included.
 */

import {
  CLIENT_NAMES,
  clientOf,
  clientReady,
  clientUsable,
  needsClient,
  SIGNIN_TEXT,
} from '@whombat/client/signins';
import { type AgentProvider, LIVE_PROVIDERS, type LiveProvider } from '@whombat/core/domain';
import { useEffect, useRef } from 'react';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import styles from './ai.module.css';
import { ClientRow } from './ClientRow';
import { SignInRow, type SignInRowProps } from './SignIn';
import { useAiRefresh, useClientsStatus, useSignInsStatus } from './useAi';

const T = SIGNIN_TEXT;

export interface AiSetupProps {
  /** The chosen clients, in the order picked. */
  clients: readonly LiveProvider[];
  onClientsChange: (next: LiveProvider[]) => void;
  /** The agent's provider; null = the first usable one. */
  provider: AgentProvider | null;
  onProviderChange: (provider: LiveProvider) => void;
  terminal?: SignInRowProps['terminal'];
}

/** The picker's value: the chosen provider when it's usable, else the first usable client. */
export function firstAgentsProvider(
  chosen: readonly LiveProvider[],
  provider: AgentProvider | null,
  usable: (p: LiveProvider) => boolean,
): LiveProvider | null {
  if (
    provider &&
    (provider === 'claude' || provider === 'codex') &&
    chosen.includes(provider) &&
    usable(provider)
  )
    return provider;
  return chosen.find(usable) ?? null;
}

export function AiSetup({
  clients: chosen,
  onClientsChange,
  provider,
  onProviderChange,
  terminal,
}: AiSetupProps) {
  const clientsQ = useClientsStatus();
  const signInsQ = useSignInsStatus();
  const refresh = useAiRefresh();
  const clients = clientsQ.data;
  const usable = (p: LiveProvider) => clientUsable(p, clients, signInsQ.data);
  const picked = firstAgentsProvider(chosen, provider, usable);
  // The agent's client follows what's usable until the person picks one (saved with the progress).
  const pick = useRef(onProviderChange);
  pick.current = onProviderChange;
  useEffect(() => {
    if (picked && picked !== provider) pick.current(picked);
  }, [picked, provider]);

  const toggle = (p: LiveProvider) => {
    if (chosen.includes(p)) {
      onClientsChange(chosen.filter((c) => c !== p));
      return;
    }
    // Choosing is wanting it: Claude Code's row installs it at once when it isn't (AP-194); ChatGPT has nothing to install.
    onClientsChange([...chosen, p]);
  };

  return (
    <div className={styles.setup}>
      <div className={styles.choices}>
        {LIVE_PROVIDERS.map((p) => {
          const selected = chosen.includes(p);
          return (
            <button
              key={p}
              type="button"
              className={styles.choice}
              data-selected={selected || undefined}
              aria-pressed={selected}
              aria-label={T.choose(CLIENT_NAMES[p])}
              onClick={() => toggle(p)}
            >
              <span className={styles.check} data-selected={selected || undefined} aria-hidden="true">
                {selected ? '✓' : ''}
              </span>
              <span className={styles.choiceName}>{CLIENT_NAMES[p]}</span>
              <span className={styles.choiceBlurb}>{T.clientBlurb[p]}</span>
            </button>
          );
        })}
      </div>

      {chosen.map((p) => {
        const hasClient = needsClient(p);
        return (
          <section key={p} className={styles.card} aria-label={CLIENT_NAMES[p]}>
            {hasClient ? (
              <ClientRow
                provider={p}
                client={clientOf(clients, p)}
                onChanged={refresh}
                listedAt={clientsQ.dataUpdatedAt}
                autoInstall={clients !== undefined}
              />
            ) : null}
            <SignInRow
              provider={p}
              list={signInsQ.data}
              onChanged={refresh}
              installed={clientReady(p, clients)}
              titled={!hasClient}
              {...(terminal && { terminal })}
            />
          </section>
        );
      })}

      <p className={styles.model}>{T.model}</p>

      {chosen.length > 0 ? (
        <div className={styles.picker}>
          <SectionLabel>{T.picker.label}</SectionLabel>
          <SegmentedControl<string>
            label="AI provider"
            options={chosen.map((p) => ({ value: p, label: CLIENT_NAMES[p], disabled: !usable(p) }))}
            value={picked ?? ''}
            onChange={(next) => {
              if (next === 'claude' || next === 'codex') onProviderChange(next);
            }}
          />
          {!picked ? <span className={styles.hint}>{T.picker.none}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
