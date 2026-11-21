import { blockedEventFields, renderJsonTemplate } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { automationDestinations as automationDestinationsTable } from '../../db/schema/index';
import { keyDecision } from '../authority';
import { automationPrincipal } from './checks';
import { block, updateStep } from './state';
import type { StepExecution } from './types';

export async function executeHttpCallback({
  ctx,
  run,
  idx,
  scope,
  publisher,
  base,
  step,
}: StepExecution<'http_callback'>): Promise<void> {
  const tx = ctx.tx;
  const [allowed] = await tx
    .select()
    .from(automationDestinationsTable)
    .where(
      and(
        eq(automationDestinationsTable.burrowId, run.burrowId),
        eq(automationDestinationsTable.url, step.url),
      ),
    );
  if (!allowed) return block(ctx, run, idx, 'You haven’t approved that URL.');
  if (publisher.kind !== 'person')
    return block(ctx, run, idx, 'Only automations you published may call URLs.');
  const decision = await keyDecision(
    tx,
    (await automationPrincipal(tx, run)) ?? '',
    publisher,
    'messages.external',
  );
  if (decision.outcome !== 'allow') {
    await ctx.emit({
      ...blockedEventFields(decision, ctx.actor.shortName, `call ${new URL(step.url).host}`),
      where: null,
      payload: { runId: run.id, keyId: 'messages.external', reason: decision.reason },
    });
    return block(
      ctx,
      run,
      idx,
      decision.outcome === 'ask'
        ? 'Calling a URL needs “Message people outside your Whombat” at can. Put an approval step before it instead.'
        : 'It doesn’t hold “Message people outside your Whombat”.',
    );
  }
  const body = renderJsonTemplate(step.body, scope);
  await updateStep(
    tx,
    run.id,
    idx,
    { ...base, state: 'running', inputSummary: `Calling ${new URL(step.url).host}`, output: { body } },
    ctx.now,
  );
  return;
}
