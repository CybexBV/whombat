/**
 * “RUNS ON” for the agent (MA-17, CT-69; Whombat one-agent.md OA-11, one-person.md OP-09; app one-person.md AP-5692):
 * the sign-in it runs on, in the person's words — their own Claude or ChatGPT sign-in, with their subscription or their
 * own API key (one per provider, CT-1503). There is nothing to choose: no sources, no organization keys, no sign-in
 * shared. When the person isn't signed in it says so with a way to Settings → AI. Shown where the person signs in here
 * (managed Whombats, and self-hosted servers that serve `signins.*`). While the burrow sends the agent's tool through an
 * AI gateway (Whombat ai-gateway.md AIG-17; app AP-1121) it says “Runs on Fusebox” and why, and that the own sign-in
 * applies again once the switch is off. Not in the mock: the profile's own section label.
 */

import { Link } from '@tanstack/react-router';
import { GATEWAY_TEXT, gatewayRunsOn } from '@whombat/client';
import { useBootstrap } from '@whombat/client/react';
import { REFUSAL_TEXT, SOURCE_TEXT, signInOf } from '@whombat/client/signins';
import type { LiveProvider } from '@whombat/core/domain';
import { useId } from 'react';
import { useAppServices } from '../../app/providers';
import { SectionLabel } from '../../components/SectionLabel';
import { useSignInsStatus } from '../ai/useAi';
import styles from './CredentialSection.module.css';

/** The provider in a sign-in line: “Claude”, “ChatGPT” (chatgpt-no-client.md AP-5617). */
const PROVIDERS: Record<string, string> = { claude: 'Claude', codex: 'ChatGPT' };

export const CREDENTIAL_TEXT = {
  label: 'RUNS ON',
} as const;

/**
 * Whether RUNS ON shows: the person signs in here (a managed Whombat, or a self-hosted server that serves `signins.*`),
 * or the agent runs on the burrow's AI gateway, which a self-hosted server without sign-ins has too.
 */
function runsOnShown(where: { managed: boolean; signIns: boolean; gateway: boolean }): boolean {
  return where.managed || where.signIns || where.gateway;
}

export function CredentialSection({
  burrow,
  provider,
  modelLine = null,
}: {
  burrow: string;
  provider: string;
  /** The agent's model and effort (“Sonnet · High effort”, AP-1131), under the title; null for the defaults. */
  modelLine?: string | null;
}) {
  const { managed } = useAppServices();
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const signInsQ = useSignInsStatus();
  const ids = { gateway: useId() };

  // Its tool goes through the burrow's AI gateway (AIG-17): “Runs on Fusebox”, the own sign-in kept for later.
  const gateway = gatewayRunsOn(bootstrap?.burrow, provider);
  if (!runsOnShown({ managed: !!managed, signIns: !!signInsQ.data, gateway: !!gateway })) return null;
  const live = provider === 'claude' || provider === 'codex' ? (provider as LiveProvider) : null;
  const providerName = PROVIDERS[provider] ?? provider;
  const mine = live ? signInOf(signInsQ.data, live) : null;
  const title = SOURCE_TEXT.title(providerName);

  const modelRow = modelLine ? (
    <span className={styles.keyNote} data-model-line="">
      {modelLine}
    </span>
  ) : null;

  if (gateway)
    return (
      <section className={styles.section} aria-label={CREDENTIAL_TEXT.label} data-runs-on="gateway">
        <SectionLabel>{CREDENTIAL_TEXT.label}</SectionLabel>
        <span className={styles.doing}>{gateway.title}</span>
        {modelRow}
        <span className={styles.keyNote} id={ids.gateway}>
          {gateway.note}
        </span>
        {/* The own sign-in, which applies again once the switch is off. */}
        <span className={styles.keyNote} data-own-choice="">
          {GATEWAY_TEXT.ownChoice(title)}
        </span>
      </section>
    );

  // The refusal the person would get (CT-69), before they ask; not while the gateway answers instead (AIG-07).
  const signedOut = !!signInsQ.data && mine?.state !== 'ready';
  return (
    <section className={styles.section} aria-label={CREDENTIAL_TEXT.label}>
      <SectionLabel>{CREDENTIAL_TEXT.label}</SectionLabel>
      <span className={styles.doing}>{title}</span>
      {modelRow}
      <span className={styles.keyNote}>{SOURCE_TEXT.note}</span>
      {signedOut ? (
        <span className={styles.keyNote} role="status">
          {REFUSAL_TEXT['provider.not_signed_in']?.text(providerName)}{' '}
          <Link to="/settings" search={{ tab: 'agent', part: 'ai' }} className={styles.inlineLink}>
            {SOURCE_TEXT.signIn}
          </Link>
        </span>
      ) : null}
    </section>
  );
}
