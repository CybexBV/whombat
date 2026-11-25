/**
 * What the box remembers, per runtime, about calls to control still on their way (docs/decisions/team-reports.md).
 * Memory only: after a restart no call from before is still on its way.
 *
 * - The copies' generation: dropping every copy (the box left Link, or moved to new hardware) raises it. A read takes
 *   it when it starts, and the commands that keep copies write nothing for a read from an earlier generation, so an
 *   answer that left before the drop can't bring old reports back.
 * - The drafts this process is sending: a draft marked `sending` that no send here holds was left so by a process that
 *   stopped, and goes back to waiting.
 */
import type { Services } from '../services';

const generations = new WeakMap<Services, number>();

/** The copies' generation now: a read keeps it from its start. */
export function teamReportsGeneration(services: Services): number {
  return generations.get(services) ?? 0;
}

/** Every copy is about to go: answers to reads that started before keep nothing. */
export function raiseTeamReportsGeneration(services: Services): void {
  generations.set(services, teamReportsGeneration(services) + 1);
}

const sending = new WeakMap<Services, Set<string>>();

/** This process is sending the draft (marked before the commit that reserves it). */
export function noteDraftSending(services: Services, draftId: string): void {
  const held = sending.get(services) ?? new Set<string>();
  held.add(draftId);
  sending.set(services, held);
}

/** The send of the draft is over (sent or given back). */
export function draftSendOver(services: Services, draftId: string): void {
  sending.get(services)?.delete(draftId);
}

/** Whether this process is sending the draft now. */
export function draftSendingHere(services: Services, draftId: string): boolean {
  return sending.get(services)?.has(draftId) ?? false;
}
