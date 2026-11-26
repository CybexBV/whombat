/**
 * A call the service refused for a permission its sign-in lacks, and named (an MCP server's `insufficient_scope`,
 * Cloudflare’s step-up; docs/decisions/connection-signin.md). Whombat keeps what was asked on the
 * connection, so the next sign-in asks for it on top of what was allowed, and puts one card in the thread that opens
 * the connection's page, where Allow on {Name} signs in again. What the entry never asks for (`scopesNever`:
 * Cloudflare's registrar, members, API tokens) gets no card: the agent hears that the person does it in the service.
 */
import {
  type CatalogEntry,
  CONNECT_HERE_DECLINE,
  CONNECT_HERE_TEXT,
  catalogSignIn,
  newId,
  scopeListWords,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { catalogConnections } from '../db/schema/index';
import { askWithCard, cardReturnTo } from '../guides/ask';
import { makeCard } from '../guides/flows';
import { loadPrincipalRow, shortName } from '../read/principals';
import type { Services } from '../services';
import type { CatalogConnectionRow } from './types';

/** What the server asks of every token, not a permission the person chooses. */
const BASELINE = new Set(['offline_access', 'openid', 'profile', 'email']);

/** The words the agent hears (to the agent, never the chat). */
export const STEP_UP_TEXT = {
  carded: (name: string, words: string) =>
    `${name} hasn’t allowed this yet: it needs the person’s OK to ${words}. A card in this thread asks them. End your turn; Whombat will wake you once they allow it.`,
  asked: (name: string, words: string, label: string) =>
    `${name} hasn’t allowed this yet: it needs the person’s OK to ${words}. They can allow it on ${label}’s page in Settings → Connections (Allow on ${name}); ask them to, then carry on.`,
  never: (name: string, words: string) =>
    `Whombat doesn’t ask ${name} to ${words}: the person does that in ${name} itself. Tell them what you need and why.`,
  held: (name: string) =>
    `${name} refused this although its sign-in allows it. Tell the person; signing in again on the connection’s page may help.`,
} as const;

/**
 * The scopes a challenge names that the connection doesn't hold yet (the challenge repeats what it holds; a sign-in
 * whose token answer named none holds what it asked, `scopes`).
 */
export function missingScopes(asked: readonly string[], row: Pick<CatalogConnectionRow, 'scopes'>): string[] {
  const held = new Set(row.scopes);
  return [...new Set(asked)].filter((s) => !held.has(s) && !BASELINE.has(s));
}

/** The connection page, which opens at Allow on {Name} while something is asked. */
export function allowMoreHref(
  entry: Pick<CatalogEntry, 'id'>,
  connectionId: string,
  returnTo?: string | null,
): string {
  const base = `/settings?tab=connections&connection=${encodeURIComponent(entry.id)}&id=${encodeURIComponent(connectionId)}`;
  return returnTo ? `${base}&returnTo=${encodeURIComponent(returnTo)}` : base;
}

/**
 * Records what the call needed and asks the person once per new permission. `call` is where it was asked (no
 * conversation: nobody to show a card to). The agent's words come back.
 */
export async function askForScopes(
  services: Services,
  row: CatalogConnectionRow,
  entry: CatalogEntry,
  asked: readonly string[],
  call: {
    burrowId: string;
    agentId: string;
    conversationId?: string | null;
    threadRootId?: string | null;
    personId?: string | null;
  },
): Promise<string> {
  const missing = missingScopes(asked, row);
  if (!missing.length) return STEP_UP_TEXT.held(entry.name);
  const method = catalogSignIn(entry, 'mcp_oauth');
  const never = new Set(method?.kind === 'mcp_oauth' ? (method.scopesNever ?? []) : []);
  const refused = missing.filter((s) => never.has(s));
  if (refused.length) return STEP_UP_TEXT.never(entry.name, scopeListWords(refused));
  const words = scopeListWords(missing);
  const fresh = missing.filter((s) => !row.scopesWanted.includes(s));
  if (fresh.length)
    await services.pipeline.transactAccount((tx) =>
      tx
        .update(catalogConnections)
        .set({ scopesWanted: [...new Set([...row.scopesWanted, ...missing])] })
        .where(eq(catalogConnections.id, row.id)),
    );
  if (!fresh.length || !call.conversationId) return STEP_UP_TEXT.asked(entry.name, words, row.label);
  const agent = await loadPrincipalRow(services.db, call.agentId);
  const who = agent ? shortName(agent) : 'Whombat';
  const messageId = newId('message');
  const returnTo = await cardReturnTo(
    services.db,
    call.burrowId,
    call.conversationId,
    call.threadRootId ?? null,
    messageId,
  );
  const directOAuth = method?.kind === 'mcp_oauth' && returnTo;
  const card = makeCard({
    guide: 'add_connection',
    node: 'allow_more',
    title: `Allow ${who} more on ${entry.name}?`.slice(0, 120),
    body: `To do this, ${who} needs to ${words}. ${entry.name} shows you what’s asked; what you allowed before stays.`,
    blocks: [
      {
        type: 'actions',
        actions: [
          {
            id: 'allow',
            label: `Allow on ${entry.name}…`,
            style: 'primary',
            href: allowMoreHref(entry, row.id, returnTo),
          },
          ...(returnTo
            ? [
                {
                  id: CONNECT_HERE_DECLINE,
                  label: CONNECT_HERE_TEXT.notNow,
                  style: 'quiet' as const,
                  href: null,
                },
              ]
            : []),
        ],
      },
    ],
    ...(directOAuth
      ? {
          connectOAuth: {
            catalogId: entry.id,
            method: 'mcp_oauth' as const,
            connectionId: row.id,
            returnTo,
          },
        }
      : {}),
  });
  const posted = await services.pipeline
    .commit(
      askWithCard,
      { conversationId: call.conversationId, threadRootId: call.threadRootId ?? null, card, messageId },
      {
        burrowId: call.burrowId,
        actorId: call.agentId,
        ...(call.personId ? { onBehalfOf: { principalId: call.personId } } : {}),
      },
    )
    .catch((err: unknown) => {
      services.log.warn(
        { err: err instanceof Error ? err.name : 'error' },
        'could not post the allow-more card',
      );
      return null;
    });
  return posted?.status === 'ok'
    ? STEP_UP_TEXT.carded(entry.name, words)
    : STEP_UP_TEXT.asked(entry.name, words, row.label);
}
