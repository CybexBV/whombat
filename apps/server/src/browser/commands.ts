/**
 * `browser_preview`'s command (docs/decisions/browser.md BT-48; hermes-engine.md HE-S142): it signs a hidden event
 * `browser.used` (`kind: System`, `text: null`), `{tool, origin, dispatchId}`. Hermes's own browser tools are gated by
 * the turn's tool policy (HE-44), not by a command here.
 */
import { DispatchId } from '@whombat/core';

/** Where a preview's site is served from, as the `browser.used` event records it (BT-48). */
const PREVIEW_ORIGIN = 'https://preview.whombat.invalid';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import { dispatches } from '../db/schema/index';
import { forbidden } from '../lib/errors';

/**
 * `browser_preview` (BT-48, contracts CT-198): the agent's own build, offline unless it holds `browser.use`, so no key;
 * the same hidden `browser.used` event.
 */
export const previewBuild = defineCommand({
  name: 'browser.preview',
  schema: z.object({ dispatchId: DispatchId }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only agents preview a build.');
    const [dispatch] = await tx
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(and(eq(dispatches.id, input.dispatchId), eq(dispatches.agentId, ctx.actor.id)));
    if (!dispatch) throw forbidden('This dispatch is gone.');
    const event = await ctx.emit({
      type: 'browser.used',
      kind: 'System',
      text: null,
      where: null,
      payload: { tool: 'browser_preview', origin: PREVIEW_ORIGIN, dispatchId: input.dispatchId },
    });
    return { eventId: event.id };
  },
});

export const BROWSER_COMMANDS = [previewBuild];
