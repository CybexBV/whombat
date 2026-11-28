/**
 * A connection's changes, from what its kind's read already tells each health pass (docs/decisions/outside-changes.md):
 * its version, its devices' firmware, its proxy hosts or tunnel routes. Compared with the last read Whombat kept; the
 * first read only sets that.
 */
import { catalogEntry, thingId } from '@whombat/core';
import type { CatalogConnectionRow } from '../connections/types';
import type { Services } from '../services';
import { diffService, nextServiceState, type ServiceState, type TrackedFacts } from './diff';
import { readBaseline, recordRead } from './store';

const SOURCE = 'service';

/**
 * Keeps what a connection's read tells (`tracked`) and records what changed since the read before. `serverId`: the
 * server it runs on, whose changes Whombat made count as Whombat's for it too.
 */
export async function trackConnection(
  services: Services,
  row: Pick<CatalogConnectionRow, 'id' | 'burrowId' | 'catalogId' | 'label'>,
  tracked: TrackedFacts,
  serverId: string | null,
  now: Date,
): Promise<number> {
  if (tracked.version === undefined && tracked.firmware === undefined && tracked.routes === undefined)
    return 0;
  const thing = thingId('connection', row.id);
  const before = await readBaseline<ServiceState>(services.db, row.burrowId, thing, SOURCE);
  const after = nextServiceState(before?.state ?? null, tracked);
  // The service's own name, not the person's label for the connection: “Immich went from …”.
  const name = catalogEntry(row.catalogId)?.name ?? row.label;
  const drafts = diffService(name, before?.state ?? null, after);
  // Kept on every read, also when nothing changed: the next change says it happened after this read.
  return recordRead(services, {
    burrowId: row.burrowId,
    thing,
    source: SOURCE,
    state: after as Record<string, unknown>,
    drafts,
    since: before?.readAt ?? null,
    ...(serverId ? { alsoThings: [thingId('server', serverId)] } : {}),
    now,
  });
}
