/**
 * The care plan's watcher (docs/decisions/care-plan.md): about every minute it reads the servers, and
 *
 * - on a Whombat from before care plans, writes down every server it has as known, once (they keep their hints, which
 *   *Ask {assistant} to handle these* answers with the same plan);
 * - writes down a temporary machine, or a server with nothing to look after, as known without a plan;
 * - for the first server that reported and isn't known yet, reads it and starts its care plan (`care.start`): one per
 *   pass, and only while a turn of the person's could run now, so the plan waits for the AI rather than failing.
 */
import { isTemporaryServer } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { burrows, serverCares } from '../db/schema/index';
import { screenText } from '../desk/glance';
import { thePerson } from '../domain/the-person';
import { hostsFor } from '../hosts/service';
import { burrowLocale } from '../i18n/locale';
import { agentRuntimeOf, loadAgentRow, type PrincipalRow } from '../read/principals';
import { providerReadiness } from '../runtime/readiness';
import type { Services } from '../services';
import { careBaseline, careKnown, serverKey, startCare } from './commands';
import { careFactsOf, careStepRows } from './facts';
import { changeWindowOf } from './window';

export interface CareWatchOptions {
  /** Whether a turn could run (the runtime's readiness otherwise). */
  ready?: (agent: PrincipalRow, person: PrincipalRow) => Promise<boolean>;
}

/** A server's key as the desk and Home name it (`server:pve-01`). */
export function serverThingKey(id: string): string {
  return screenText(`server:${id}`, 120);
}

/** One burrow's pass. Returns the research it started, if any. */
export async function careBurrow(
  services: Services,
  burrowId: string,
  options: CareWatchOptions = {},
): Promise<string | null> {
  const [burrow] = await services.db.select().from(burrows).where(eq(burrows.id, burrowId));
  if (!burrow) return null;
  const hosts = hostsFor(services);
  if (!hosts.present) return null;
  const agent = await loadAgentRow(services.db, burrowId);
  const person = await thePerson(services.db, burrowId);
  if (!agent || !person?.accountId) return null;
  const as = { burrowId, actorId: agent.id };
  // A Whombat the hosts service doesn't serve has no servers yet: none to write down.
  const serves = await hosts.serves(burrowId).catch(() => null);
  if (serves === null) return null;
  const servers = serves ? (await hosts.fleet().catch(() => null))?.servers : [];
  if (!servers) return null;
  if (burrow.careBaselineDue) {
    await services.pipeline.commit(
      careBaseline,
      { servers: servers.slice(0, 500).map((s) => ({ id: s.id, self: s.hostsThisWhombat === true })) },
      as,
    );
    return null;
  }
  const known = new Set(
    (
      await services.db
        .select({ id: serverCares.serverId })
        .from(serverCares)
        .where(and(eq(serverCares.burrowId, burrowId)))
    ).map((r) => r.id),
  );
  // Ready: it reported (its first report is what “Ready” means when it is added).
  const fresh = servers.filter((s) => s.status !== 'pending' && s.lastSeen && !known.has(serverKey(s.id)));
  for (const s of fresh.filter((x) => isTemporaryServer(x.name) || isTemporaryServer(x.id)))
    await services.pipeline.commit(careKnown, { server: s.id, self: s.hostsThisWhombat === true }, as);
  const next = fresh.find((x) => !isTemporaryServer(x.name) && !isTemporaryServer(x.id));
  if (!next) return null;
  const ready = options.ready
    ? await options.ready(agent, person)
    : (await providerReadiness(services, agent, agentRuntimeOf(agent.runtime).provider, person)).ok;
  if (!ready) return null;
  const facts = await careFactsOf(services, burrowId, next).catch(() => null);
  // Not read this time: tried again on the next pass.
  if (!facts) return null;
  const steps = careStepRows(facts, changeWindowOf(burrow), await burrowLocale(services, burrowId));
  const self = next.hostsThisWhombat === true;
  if (!steps.length) {
    await services.pipeline.commit(careKnown, { server: next.id, self }, as);
    return null;
  }
  const res = await services.pipeline.commit(
    startCare,
    {
      server: { id: next.id, name: next.name, self },
      thingKey: serverThingKey(next.id),
      steps,
      personId: person.id,
    },
    as,
  );
  return res.status === 'ok' ? (res.result?.researchId ?? null) : null;
}

/** Every burrow's pass (the home jobs' `home.care`). */
export class CareWatcher {
  constructor(
    private readonly services: Services,
    private readonly options: CareWatchOptions = {},
  ) {}

  async pass(): Promise<void> {
    const rows = await this.services.db.select({ id: burrows.id }).from(burrows);
    for (const { id } of rows)
      await careBurrow(this.services, id, this.options).catch((err) =>
        this.services.log.warn({ err: String(err), burrowId: id }, 'care: the pass failed'),
      );
  }
}
