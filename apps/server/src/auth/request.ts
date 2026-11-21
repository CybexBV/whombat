/**
 * Who is calling a handler: the session's account (the session dispatcher, MR-05), or nobody (the runner's endpoints,
 * which check the runner token themselves). Burrow routes resolve the caller to their person principal in that burrow
 * and refuse everyone else.
 *
 * Agent tokens (`wat_…`) never reach a handler as a caller: agents act through the MCP server, where switched-off repos
 * are hidden and tool calls are rate-limited, and their turns' model calls go through the AI gateway relay.
 */
import { and, eq } from 'drizzle-orm';
import type { BurrowRow } from '../commit/types';
import { burrows, principals } from '../db/schema/index';
import { forbidden, notFound, unauthorized } from '../lib/errors';
import type { PrincipalRow } from '../read/principals';
import type { Services } from '../services';
import type { AccountRow } from './service';

export interface RequestAuth {
  account: AccountRow | null;
}

/** A bearer token from an `Authorization` header (the runner's token, agents' tokens). */
export function bearerOf(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const m = value ? /^Bearer\s+(\S+)$/i.exec(value) : null;
  return m?.[1] ?? null;
}

export interface BurrowAccess {
  burrow: BurrowRow;
  principal: PrincipalRow;
}

/** The caller's principal in a burrow (by slug). 401 without auth, 404 for an unknown one, 403 for anyone but its person. */
export async function burrowAccess(
  services: Services,
  auth: RequestAuth,
  slug: string,
): Promise<BurrowAccess> {
  const account = auth.account;
  if (!account) throw unauthorized();
  const [burrow] = await services.db.select().from(burrows).where(eq(burrows.slug, slug));
  if (!burrow) throw notFound('Whombat');
  const [person] = await services.db
    .select()
    .from(principals)
    .where(
      and(
        eq(principals.burrowId, burrow.id),
        eq(principals.accountId, account.id),
        eq(principals.kind, 'person'),
      ),
    );
  if (!person) throw forbidden('You’re not on this Whombat.');
  return { burrow, principal: person };
}
