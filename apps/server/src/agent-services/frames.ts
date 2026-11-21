/**
 * The `services.changed` frame (contracts 3.0, CT-1536; one-person.md OP-S46): published on the burrow's topic when a
 * list of the agent's services differs from the one before, so Settings → Agent reads it again.
 */
import { topics } from '@whombat/core';
import { burrows } from '../db/schema/index';
import { iso } from '../lib/time';
import type { Services } from '../services';

/** Publishes `services.changed` to the Whombat's one burrow. Never throws. */
export async function publishServicesChanged(services: Services): Promise<void> {
  try {
    const [row] = await services.db.select({ id: burrows.id }).from(burrows).limit(1);
    if (!row) return;
    services.bus.publish({
      topic: topics.burrow(row.id),
      event: { type: 'services.changed' },
      eventId: null,
      at: iso(services.clock()),
      outboxId: null,
    });
  } catch (err) {
    services.log.warn({ err: String(err) }, 'could not tell that the agent’s services changed');
  }
}
