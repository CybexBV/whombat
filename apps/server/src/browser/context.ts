/**
 * The browser in a turn (docs/decisions/hermes-engine.md HE-42; one-person.md OP-S113): Hermes's browser on the agent's
 * Chromium, beside its commands.
 * `DispatchContext.browser` — null unless the agent holds `browser.use` (never for a search answer or a Feedback
 * assessment, whose own is `feedback/browser.ts`) — and `DispatchContext.logins`, the person's `login` entries switched
 * on for the agent (none in an outsiders' turn, one-person.md OP-17).
 */
import type { DispatchBrowser, DispatchLogin, Grant } from '@whombat/core';
import { and, asc, eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { vaultEntries } from '../db/schema/index';
import { loadGrants, type PrincipalRow } from '../read/principals';
import { dispatchPerson } from '../runtime/person';
import type { Services } from '../services';
import { vaultless } from '../vault/context';
import { onForAgent } from '../vault/store';
import { siteOf } from './sites';

/** The `login` entries switched on for the agent with a site and an https origin, as a turn carries them. */
export async function loginsOf(db: Db | Tx, agentId: string): Promise<DispatchLogin[]> {
  const rows = await db
    .select({
      entryId: vaultEntries.id,
      name: vaultEntries.name,
      url: vaultEntries.url,
      auth: vaultEntries.auth,
      totp: vaultEntries.totpSealed,
    })
    .from(vaultEntries)
    .where(and(onForAgent(agentId), eq(vaultEntries.kind, 'login')))
    .orderBy(asc(vaultEntries.name), asc(vaultEntries.id));
  return rows.flatMap((r) => {
    const site = r.url ? siteOf(r.url) : null;
    const origin = r.url ? originOf(r.url) : null;
    if (!site || !origin) return [];
    return [
      {
        entryId: r.entryId,
        name: r.name.slice(0, 80) || site,
        origin,
        username: (r.auth && 'username' in r.auth ? r.auth.username : '').slice(0, 320),
        otp: Boolean(r.totp),
      },
    ];
  });
}

/** The https origin of an entry's URL (`DispatchLogin.origin`), or null. */
function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** `DispatchContext.browser`, or null when the agent doesn't hold `browser.use` or the turn never browses. */
export async function browserContextFor(
  services: Services,
  agent: PrincipalRow,
  dispatch: Parameters<typeof vaultless>[0],
  /** The agent's grants, when the caller already read them. */
  grants?: readonly Grant[],
): Promise<DispatchBrowser | null> {
  if (vaultless(dispatch) || agent.kind !== 'agent') return null;
  const held = (grants ?? (await loadGrants(services.db, agent.id))).some(
    (g) => g.keyId === 'browser.use' && g.tier !== 'cannot',
  );
  return held ? { sites: null } : null;
}

/** `DispatchContext.logins`: the person's logins the agent holds keys to, with a browser only. */
export async function turnLoginsFor(
  services: Services,
  agent: PrincipalRow,
  dispatch: { burrowId: string; onBehalfOfAccountId: string | null },
  browser: DispatchBrowser | null,
  /** Who the turn is for, when the caller already read it (null: nobody, an outsiders' turn). */
  person?: PrincipalRow | null,
): Promise<DispatchLogin[]> {
  if (!browser) return [];
  if (!(person === undefined ? await dispatchPerson(services.db, dispatch) : person)) return [];
  return loginsOf(services.db, agent.id);
}
