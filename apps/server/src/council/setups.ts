/**
 * The person's council (docs/decisions/council.md): one per Whombat. Who sits on it is always T3 Code's own council, so
 * `council.save_setup` keeps only what the person chooses, its rounds and score (the seats a client sends are kept but
 * never sit); `council.reset_setup` forgets them. The person's, in Settings → the assistant → Council, or the assistant's
 * settings tools on their word, which run as them. Settings reads it with who T3 Code's council sits and what T3 Code
 * can run.
 */
import {
  type CouncilSetup,
  type CouncilSetupResponse,
  councilSeatsProblem,
  newId,
  SaveCouncilSetupBody,
} from '@whombat/core';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { type CouncilSetupRow, councilMembers, councilSetups, councils } from '../db/schema/index';
import { ApiError, forbidden } from '../lib/errors';
import type { Services } from '../services';
import { rarelyRead } from '../things/kinds/business/common';
import { callT3 } from '../things/kinds/business/t3code';
import {
  isEffortOption,
  providerOptions,
  providersOf,
  type SatSeat,
  seatSetupOf,
  T3_COUNCIL,
  type T3Provider,
  t3CouncilSeats,
} from './members';
import { councilConnection } from './run';

/** The name the one council's row carries (the table once held named councils). */
const COUNCIL_NAME = 'Council';

const refused = (message: string, field: string) =>
  new ApiError('validation_failed', message, { fields: { [field]: [message] } });

export function setupOf(row: CouncilSetupRow): CouncilSetup {
  return {
    seats: row.seats,
    builder: Math.min(row.builder, row.seats.length - 1),
    rounds: row.rounds,
    target: Math.round(row.target * 2) / 2,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The person's council: its row (the one that was the default when there were named councils, else the first), or null
 * when they set none.
 */
export async function theCouncil(db: Db | Tx, burrowId: string): Promise<CouncilSetupRow | null> {
  const rows = await db
    .select()
    .from(councilSetups)
    .where(eq(councilSetups.burrowId, burrowId))
    .orderBy(asc(councilSetups.position), asc(councilSetups.createdAt));
  return rows.find((r) => r.isDefault) ?? rows[0] ?? null;
}

/**
 * Who T3 Code's own council sat last: the seats of the latest council that followed it and had a reviewer (each seat
 * moved to the model that came), then the reviewers that sat after its seats. A seat nobody sat goes only when that
 * council finished: one stopped early says nothing about who the skill sits. Empty when none had a reviewer.
 */
export async function lastT3Council(db: Db | Tx, burrowId: string): Promise<SatSeat[]> {
  const recent = await db
    .select({ id: councils.id, seats: councils.seats, state: councils.state })
    .from(councils)
    .where(and(eq(councils.burrowId, burrowId), eq(councils.setupName, T3_COUNCIL)))
    .orderBy(desc(councils.createdAt))
    .limit(5);
  for (const council of recent) {
    const rows = await db
      .select({
        role: councilMembers.role,
        position: councilMembers.position,
        provider: councilMembers.provider,
        model: councilMembers.model,
        options: councilMembers.options,
        threadId: councilMembers.threadId,
      })
      .from(councilMembers)
      .where(eq(councilMembers.councilId, council.id))
      .orderBy(asc(councilMembers.position), asc(councilMembers.startedAt));
    const sat = rows.filter((r) => r.role === 'member' && r.threadId);
    if (!sat.length) continue;
    const seats: SatSeat[] = council.seats
      .filter((_, i) => council.state !== 'done' || sat.some((r) => r.position === i))
      .map((s) => ({ provider: s.provider, model: s.model, options: s.options }));
    for (const r of sat)
      if (
        r.position >= council.seats.length &&
        !seats.some((s) => s.provider === r.provider && s.model === r.model)
      )
        seats.push({ provider: r.provider, model: r.model, options: r.options ?? [] });
    return seats;
  }
  return [];
}

/** Settings and the assistant change the council as the person; nobody else does. */
function personOnly(kind: string) {
  if (kind !== 'person') throw forbidden('Only you set up your council.');
}

export const saveCouncilSetup = defineCommand({
  name: 'council.save_setup',
  schema: SaveCouncilSetupBody.extend({
    /** Each seat's names as T3 Code gives them now (the route reads them), in the seats' order. */
    names: z
      .array(z.object({ providerName: z.string().max(40), modelLabel: z.string().max(60) }).nullable())
      .max(4)
      .optional(),
  }),
  async apply(tx, ctx, input): Promise<CouncilSetup> {
    personOnly(ctx.actor.kind);
    const problem = councilSeatsProblem(input.seats);
    if (problem) throw refused(problem, 'seats');
    if (input.builder >= input.seats.length) throw refused('Choose who builds among its seats.', 'builder');
    const mine = await theCouncil(tx, ctx.burrow.id);
    // Names as T3 Code gives them now, else as kept before for the same seat: the council reads in words without it.
    const kept = (s: { provider: string; model: string }) =>
      (mine?.seats ?? []).find(
        (k) => k.provider === s.provider && k.model === s.model && (k.providerName || k.modelLabel),
      );
    const values = {
      name: COUNCIL_NAME,
      seats: input.seats.map((s, i) => {
        const named = input.names?.[i] ?? null;
        const before = kept(s);
        return {
          provider: s.provider,
          model: s.model,
          effort: s.effort,
          providerName: named?.providerName ?? before?.providerName ?? null,
          modelLabel: named?.modelLabel ?? before?.modelLabel ?? null,
        };
      }),
      builder: input.builder,
      rounds: input.rounds,
      target: input.target,
      isDefault: true,
      updatedAt: ctx.now,
    };
    // One council: whatever else the table still holds from named councils goes.
    await tx.delete(councilSetups).where(eq(councilSetups.burrowId, ctx.burrow.id));
    const [row] = await tx
      .insert(councilSetups)
      .values({
        id: mine?.id ?? newId('councilSetup'),
        burrowId: ctx.burrow.id,
        position: 0,
        createdAt: mine?.createdAt ?? ctx.now,
        ...values,
      })
      .returning();
    if (!row) throw new Error('council not kept');
    return setupOf(row);
  },
});

export const resetCouncilSetup = defineCommand({
  name: 'council.reset_setup',
  schema: z.object({}),
  async apply(tx, ctx): Promise<null> {
    personOnly(ctx.actor.kind);
    await tx.delete(councilSetups).where(eq(councilSetups.burrowId, ctx.burrow.id));
    return null;
  },
});

/** What T3 Code can run now (read at most once a few minutes per connection); null when it can't be reached. */
export async function t3Providers(
  services: Services,
  burrowId: string,
): Promise<{
  providers: T3Provider[] | null;
  t3: CouncilSetupResponse['t3'];
}> {
  const connection = await councilConnection(services.db, burrowId);
  if (!connection) return { providers: null, t3: 'not_connected' };
  const body = await rarelyRead(
    services,
    `t3code-caps:${connection.id}`,
    connection,
    () => callT3(services, connection, 'orchestrator_capabilities', {}),
    { optional: true },
  );
  return body ? { providers: providersOf(body), t3: 'ready' } : { providers: null, t3: 'unreachable' };
}

/**
 * Settings → the assistant → Council: who T3 Code's council sits (`automatic`, also the seats of the person's council),
 * the rounds and score the person chose, and what T3 Code can run.
 */
export async function councilSetupView(services: Services, burrowId: string): Promise<CouncilSetupResponse> {
  const [row, t3, sat] = await Promise.all([
    theCouncil(services.db, burrowId),
    t3Providers(services, burrowId),
    lastT3Council(services.db, burrowId),
  ]);
  const auto = t3.providers ? t3CouncilSeats(t3.providers, sat) : null;
  // T3 Code out of reach: who its last council sat, as it sat them.
  const automatic = auto?.ok
    ? auto.seats.map(seatSetupOf)
    : sat.map((s) => {
        const effort = s.options.find((o) => isEffortOption(o.id))?.value;
        return { provider: s.provider, model: s.model, effort: typeof effort === 'string' ? effort : null };
      });
  const setup = row ? setupOf(row) : null;
  return {
    setup: setup ? { ...setup, seats: automatic.length >= 2 ? automatic : setup.seats, builder: 0 } : null,
    automatic,
    options: t3.providers ? providerOptions(t3.providers) : null,
    t3: t3.t3,
  };
}
