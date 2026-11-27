/**
 * The claim's steps (Whombat first-day.md): claim the Whombat, connect the AI. A new person gets from the claim to an
 * assistant that answers without leaving the journey: the AI sign-in the whole Whombat depends on is a step of the
 * claim, not a line above Chat. Where backups go isn't asked here: Needs you proposes a place. Pure, shared by the web
 * and the phone.
 *
 * - **Steps.** Claim · Connect your AI, numbered “CLAIM · STEP n OF 2”.
 * - **Connect your AI** asks only while no provider is ready (signed in, nothing left to install); a Whombat that has
 *   one already, or whose sign-ins can't be read, goes straight on. “Later” opens the Whombat, where the same amber
 *   line as before says the assistant can't work yet.
 * - **The providers** in the order that always works first: ChatGPT (a device code, nothing installed), then Claude
 *   (Claude Code's own sign-in: a link, then the code claude.ai shows, pasted back).
 */
import type { DiscoveredService } from '@whombat/core';
import type { LiveProvider } from '@whombat/core/domain';
import { formatLocaleList } from '@whombat/core/i18n';
import { theAgentOf } from '../agentName';
import type { WhombatClient } from '../http/client';
import { clientTranslator } from '../i18n/catalog';
import { CLIENT_NAMES } from '../signins/copy';
import { type ClientsList, clientUsable, type SignInsList } from '../signins/model';

export const CLAIM_STEPS = ['claim', 'ai'] as const;
export type ClaimStepName = (typeof CLAIM_STEPS)[number];

/** “CLAIM · STEP 2 OF 2”. */
export function claimStepKicker(step: ClaimStepName, locale?: string | null): string {
  return clientTranslator(locale).t('claim.stepKicker', {
    step: CLAIM_STEPS.indexOf(step) + 1,
    total: CLAIM_STEPS.length,
  });
}

/** The providers Connect your AI offers, in its order: the one that needs nothing installed first. */
export const CONNECT_AI_PROVIDERS: readonly LiveProvider[] = ['codex', 'claude'];

/** The providers the agent can use now: signed in, with nothing left to install. */
export function readyProviders(
  clients: ClientsList | undefined,
  signIns: SignInsList | undefined,
): LiveProvider[] {
  return CONNECT_AI_PROVIDERS.filter((p) => clientUsable(p, clients, signIns));
}

/**
 * What Connect your AI does now: `checking` the lists; `ask` (nothing ready); `done` (signed in here: say so, then
 * Continue); `go_on` (ready before the step was shown, or the lists can't be read: open the Whombat without asking).
 */
export type ConnectAiStep = 'checking' | 'ask' | 'done' | 'go_on';

export function connectAiStep(input: {
  signIns: SignInsList | undefined;
  clients: ClientsList | undefined;
  /** A list couldn't be read (an older Whombat, a refusal). */
  failed: boolean;
  /** The step was shown asking already (a sign-in that finishes here is `done`, not `go_on`). */
  asked: boolean;
}): ConnectAiStep {
  if (input.failed) return 'go_on';
  if (!input.signIns || !input.clients) return 'checking';
  if (readyProviders(input.clients, input.signIns).length > 0) return input.asked ? 'done' : 'go_on';
  return 'ask';
}

/** “ChatGPT”, “ChatGPT and Claude Code” / “ChatGPT en Claude Code”. */
function names(providers: readonly LiveProvider[], locale?: string | null): string {
  return formatLocaleList(
    providers.map((p) => CLIENT_NAMES[p]),
    locale,
    'conjunction',
  );
}

export function connectAiText(locale?: string | null) {
  const tr = clientTranslator(locale);
  return {
    kicker: claimStepKicker('ai', locale),
    title: tr.t('connectAi.title'),
    sub: (assistant: string) => tr.t('connectAi.sub', { assistant }),
    tip: tr.t('connectAi.tip'),
    checking: tr.t('connectAi.checking'),
    ready: (providers: readonly LiveProvider[], assistant: string) =>
      tr.t('connectAi.ready', { providers: names(providers, locale), assistant }),
    later: tr.t('connectAi.later'),
    continue: tr.t('connectAi.continue'),
    phone: {
      deviceHint: tr.t('connectAi.phone.deviceHint'),
      consoleHint: tr.t('connectAi.phone.consoleHint'),
    },
  };
}

export const CONNECT_AI_TEXT = connectAiText();

/** What the network scan found so far, and whether it is still looking (then ask again: more may come). */
export interface ClaimFound {
  found: DiscoveredService[];
  scanning: boolean;
}

/** The scan's finds for the claim's backup step (`connections.discover`, which starts none while one is recent). */
export async function readClaimFound(
  client: Pick<WhombatClient, 'connections'>,
  burrow: string,
): Promise<ClaimFound> {
  const discovery = await client.connections
    .discover({ params: { burrow }, body: {} })
    .then((r) => (r.status === 'ok' ? r.data : null))
    .catch(() => null);
  return { found: discovery?.found ?? [], scanning: discovery?.state === 'scanning' };
}

/**
 * What the claim's steps read from the Whombat just claimed, best effort (nothing breaks a step): its burrow, the
 * assistant's name for the words, and what the network scan found so far (the backup step offers a NAS it found first).
 */
export async function readClaimWorld(
  client: Pick<WhombatClient, 'me' | 'conversations' | 'connections'>,
): Promise<ClaimFound & { burrow: string | null; assistant: string | null }> {
  const burrow = (await client.me.get({}).catch(() => null))?.memberships[0]?.burrowSlug;
  if (!burrow) return { burrow: null, assistant: null, found: [], scanning: false };
  const [boot, found] = await Promise.all([
    client.conversations.bootstrap({ params: { burrow } }).catch(() => null),
    readClaimFound(client, burrow),
  ]);
  return { burrow, assistant: theAgentOf(boot?.principals)?.name ?? null, ...found };
}

/** How often, and how many times, the backup step asks again while the scan looks (about the first scan's minute). */
export const CLAIM_FOUND_POLL = { ms: 3_000, times: 30 } as const;
