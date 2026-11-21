/**
 * The `grant_key` executor (docs/decisions/key-requests.md): an approved key request gives the agent its key as
 * the person who approved it, through the commit pipeline (`grant_requested_key`), exactly as Configure would.
 */
import { grantRequestedKey } from '../commands/agents';
import type { Executor } from './engine';

export const grantKeyExecutor: Executor = async (approval, services) => {
  if (approval.action.type !== 'grant_key') throw new Error('Not a grant_key approval.');
  if (!approval.decidedById) return { ok: false, error: 'Nobody approved this.' };
  const res = await services.pipeline.commit(
    grantRequestedKey,
    { approvalId: approval.id },
    { burrowId: approval.burrowId, actorId: approval.decidedById },
  );
  if (res.status === 'ok') return { ok: true, resultUrl: null };
  return { ok: false, error: res.message };
};
