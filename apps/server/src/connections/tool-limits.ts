/**
 * `connections.setToolLimits` (one-whombat-devices.md ONE-DD04, ONE-DD07): the person sets or removes the limits on
 * one of a connection's tools' arguments, a signed `Keys` event like its tiers (CX-22).
 */
import { ok } from '../routes/define';
import type { Services } from '../services';
import { setToolLimits } from './commands';
import { connectionFieldError } from './errors';
import { emitConnectionLifecycle } from './lifecycle';
import { limitsSetProblems, limitsSummary, type ToolLimits } from './limits';
import { type ConnectionViewer, visibleConnection } from './store';
import type { CatalogConnectionRow } from './types';

export async function setConnectionToolLimits(
  services: Services,
  viewer: ConnectionViewer,
  id: string,
  tool: string,
  limits: ToolLimits | null,
): Promise<CatalogConnectionRow> {
  const row = await visibleConnection(services.db, viewer, id);
  const cleaned = limits && Object.keys(limits.args).length ? limits : null;
  if (cleaned) {
    const problems = limitsSetProblems(cleaned);
    if (problems) throw connectionFieldError(problems, Object.values(problems)[0]);
  }
  ok(
    await services.pipeline.commit(
      setToolLimits,
      { connectionId: row.id, tool, limits: cleaned, summary: cleaned ? limitsSummary(cleaned) : null },
      { burrowId: viewer.burrowId, actorId: viewer.principal.id },
    ),
  );
  await emitConnectionLifecycle(services, { type: 'tiers', connectionId: row.id });
  return row;
}
