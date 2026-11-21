/**
 * Whombat's own signers that a burrow has one of (GitHub's, Feedback's, the trackers', the Servers'): an agent-shaped
 * principal marked by `principals.system`, made on first use with a signed line saying so, and announced to the
 * burrow's screens. Not on the roster, no keys, no channels, never dispatched (`insertSystemPrincipal`).
 */
import { topics } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import type { TxSession } from '../commit/types';
import type { Db } from '../db/client';
import { principals } from '../db/schema/index';
import { loadPrincipalRow, toPrincipal } from '../read/principals';
import type { Services } from '../services';
import { insertSystemPrincipal } from './members';

export interface BurrowSystemPrincipalSpec {
  /** `principals.system`. */
  system: string;
  name: string;
  /** The handle's stem; absent: from the name. */
  handle?: string;
  doing: string;
  job: string;
  /** The signed line that says it was made: its type (`feedback.system_principal`) and where it shows. */
  line: { type: string; where: string };
}

export interface BurrowSystemPrincipal {
  /** The burrow's one, if it exists yet. */
  find(db: Db, burrowId: string): Promise<string | null>;
  /**
   * Inside an open session of `session.burrowId`, which holds the burrow lock so two sessions can't both make one: the
   * existing one, else a new one with its signed line.
   */
  inSession(session: TxSession): Promise<string>;
  /** The burrow's one, made on first use (checked again under the burrow lock). */
  ensure(services: Services, burrowId: string): Promise<string>;
  /** Whether a principal row is this signer. */
  is(row: { system: string | null } | null | undefined): boolean;
}

export function burrowSystemPrincipal(spec: BurrowSystemPrincipalSpec): BurrowSystemPrincipal {
  async function find(db: Db, burrowId: string): Promise<string | null> {
    const [row] = await db
      .select({ id: principals.id })
      .from(principals)
      .where(and(eq(principals.burrowId, burrowId), eq(principals.system, spec.system)));
    return row?.id ?? null;
  }

  async function inSession(session: TxSession): Promise<string> {
    const burrowId = session.burrowId;
    const existing = await find(session.tx, burrowId);
    if (existing) return existing;
    const now = session.services.clock();
    const { id } = await insertSystemPrincipal(session, {
      burrowId,
      system: spec.system,
      name: spec.name,
      handle: spec.handle,
      doing: spec.doing,
      job: spec.job,
      createdAt: now,
    });
    await session.append(id, {
      type: spec.line.type,
      kind: 'System',
      text: null,
      where: spec.line.where,
      payload: { systemPrincipal: id },
      createdAt: now.toISOString(),
    });
    const row = await loadPrincipalRow(session.tx, id);
    if (row)
      session.publish(topics.burrow(burrowId), { type: 'principal.created', principal: toPrincipal(row) });
    return id;
  }

  return {
    find,
    inSession,
    async ensure(services, burrowId) {
      const existing = await find(services.db, burrowId);
      if (existing) return existing;
      const { result } = await services.pipeline.transact(burrowId, inSession);
      return result;
    },
    is: (row) => row?.system === spec.system,
  };
}
