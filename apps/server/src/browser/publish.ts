/**
 * Files the browser hands the turn's conversation (docs/decisions/browser.md BT-04, BT-07): downloads and attached
 * screenshots go the `upload_file` path — sniffed, staged, published by `publish_artifact` as the agent into the
 * dispatch's conversation (quota, rate and burrow checks included) — and come back as `{attachmentId, name, size}`
 * for `post_message` `attachmentIds`. Nothing downloaded is run or opened.
 */
import { ARTIFACT_MAX_BYTES, safeDisplayName } from '@whombat/core';
import { publishArtifact } from '../files/commands';
import { sniffBuffer } from '../files/sniff';
import { ApiError } from '../lib/errors';
import type { ToolContext } from '../mcp/tools';

/** The largest file the browser keeps: the upload limit (the host drops larger downloads). */
export function browserFileMax(ctx: Pick<ToolContext, 'services'>): number {
  return Math.min(ARTIFACT_MAX_BYTES, ctx.services.files.maxBytes);
}

export type Published =
  | { ok: true; attachmentId: string; name: string; size: number }
  | { ok: false; reason: string };

/** Publishes `bytes` as an attachment of the dispatch's conversation. */
export async function publishBrowserFile(
  ctx: ToolContext,
  rawName: string,
  bytes: Buffer,
  declaredType = '',
): Promise<Published> {
  const name = safeDisplayName(rawName);
  if (bytes.length === 0) return { ok: false, reason: `${name} was empty.` };
  const max = browserFileMax(ctx);
  if (bytes.length > max) return { ok: false, reason: `${name} is larger than the upload limit.` };
  const sniffed = sniffBuffer(bytes, name);
  if (!sniffed.ok) return { ok: false, reason: `${name} isn’t a file Whombat keeps (a damaged image).` };
  const files = ctx.services.files;
  const staged = await files.store.stage([bytes], { maxBytes: max });
  let kept = false;
  try {
    const result = await ctx.services.pipeline.commit(
      publishArtifact,
      {
        conversationId: ctx.dispatch.conversationId,
        name,
        declaredType,
        staged: { token: staged.token, size: staged.size, sha256: staged.sha256 },
        sniffed: sniffed.value,
      },
      { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf },
    );
    if (result.status !== 'ok') return { ok: false, reason: `${name} couldn’t be kept here.` };
    kept = true;
    return { ok: true, attachmentId: result.result.id, name, size: bytes.length };
  } catch (err) {
    // A quota, rate or burrow refusal: its words, never a stack.
    return {
      ok: false,
      reason: err instanceof ApiError ? `${name}: ${err.message}` : `${name} couldn’t be kept.`,
    };
  } finally {
    if (!kept) await files.store.discard(staged).catch(() => {});
  }
}
