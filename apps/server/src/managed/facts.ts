/**
 * The manager's facts push (`POST /facts`), read tolerantly (docs/decisions/managed-db.md MD-19; the appliance
 * UP-X06). A host release can bring a newer manager to a runtime that stays: its facts may carry a member, an enum value
 * or a union member this runtime's contracts don't know. Refusing the whole push would cut the person off from the
 * update and backup facts, so the push is decoded with `decodeTolerant` (and a new top-level member is left out), with
 * three rules that keep a repair from ever saying something the manager didn't:
 *
 * 1. repairs under `update` are accepted (what `decodeTolerant` leaves out of it is simply not shown);
 * 2. any repair under `backup` (or of `backup` itself) keeps the backup facts stored before: an unknown backup state
 *    must never read as “unprotected”, and a half-understood status is no status;
 * 3. a repair of `update` itself (its `state`, or another member it can't do without, is unknown) keeps the update
 *    facts stored before; and the client security floor is never changed by a push that needed a repair of it.
 */
import { FactsRequest, type UpdateFacts } from '@whombat/control-contracts/local';
import { decodeTolerant, type SkippedItem } from '@whombat/protocol/session';
import { z } from 'zod';
import type { ApplianceFacts } from './dispatcher';

/** `FactsRequest` without its strictness at the top: a newer manager's new member is left out, not refused. */
const TolerantFactsRequest = z.object(FactsRequest.shape);

export type FactsPush =
  | {
      ok: true;
      backup: ApplianceFacts['backup'];
      update: ApplianceFacts['update'];
      /** The client floor to store; undefined keeps the stored one (as a push without update facts does). */
      clientFloor: UpdateFacts['clientFloor'] | null | undefined;
      /** What `decodeTolerant` left out. */
      skipped: SkippedItem[];
      /** Facts kept from before because a repair touched them. */
      kept: ('backup' | 'update' | 'clientFloor')[];
    }
  | { ok: false; error: z.ZodError };

const under = (s: SkippedItem, ...prefix: string[]) => prefix.every((p, i) => s.path[i] === p);

/** The facts to keep after a push, given the facts kept before it. */
export function acceptFactsPush(
  previous: Pick<ApplianceFacts, 'backup' | 'update'>,
  body: unknown,
): FactsPush {
  const decoded = decodeTolerant(TolerantFactsRequest, body);
  if (!decoded.ok) return { ok: false, error: decoded.error };
  const { data, skipped } = decoded;
  const kept: ('backup' | 'update' | 'clientFloor')[] = [];
  let backup = data.backup;
  if (skipped.some((s) => under(s, 'backup'))) {
    backup = previous.backup;
    kept.push('backup');
  }
  let update = data.update;
  let clientFloor: UpdateFacts['clientFloor'] | null | undefined = update
    ? (update.clientFloor ?? null)
    : undefined;
  if (skipped.some((s) => s.path.length === 1 && under(s, 'update'))) {
    update = previous.update;
    clientFloor = undefined;
    kept.push('update', 'clientFloor');
  } else if (skipped.some((s) => under(s, 'update', 'clientFloor'))) {
    clientFloor = undefined;
    kept.push('clientFloor');
  }
  return { ok: true, backup, update, clientFloor, skipped, kept };
}
