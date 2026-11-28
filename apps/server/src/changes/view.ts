/** A kept change as the apps list it (a thing's History) and as the assistant and a look read it. */
import type { ThingChange } from '@whombat/core';
import type { ThingChangeRow } from '../db/schema/index';
import { changeWords } from './words';

export function thingChange(row: ThingChangeRow, locale?: string | null): ThingChange {
  return {
    id: row.id,
    kind: row.kind,
    words: changeWords(row.fact, locale),
    at: row.seenAt.toISOString(),
    ...(row.since ? { since: row.since.toISOString() } : {}),
    by: row.by,
  };
}
