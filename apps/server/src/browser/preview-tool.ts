/**
 * Whombat's one browser tool, `browser_preview` (docs/decisions/browser.md BT-48…BT-51; hermes-engine.md HE-42, HE-S142):
 * the agent shows what it built. Hermes's own browser tools do the rest of the web in the agent's Chromium, gated by the
 * turn's tool policy (HE-44); Whombat's browser host and its other tools are gone (HE-20).
 *
 * The tool asks the turn's runner for the folder with `render` (`previews.ts`): the runner opens it in the agent's
 * Chromium, offline unless the agent may browse (`browser.use` at `can`, BT-50), and sends back the files and the
 * 1280×800 screenshot, which is published in the conversation (`publish.ts`) unless `attach: false`, and travels beside
 * the answer as MCP image content. No key of its own (it opens only the agent's own files); the hidden `browser.used`
 * event (`previewBuild`).
 */
import { BROWSER_PREVIEW_MAX_BYTES, framedPage, type McpToolOutput, PAGE_WIDTH } from '@whombat/core';
import { pageThemeCss } from '@whombat/tokens';
import { withImage } from '../mcp/image';
import type { ToolHandler } from '../mcp/tools';
import { loadGrants } from '../read/principals';
import { previewBuild } from './commands';
import { previewsFor } from './previews';
import { publishBrowserFile } from './publish';

/** Where a preview's site is served, in the agent's Chromium only (never a real address). */
export const PREVIEW_ORIGIN = 'https://preview.whombat.invalid';

/** What `browser_preview` answers when the runner sent the files but no screenshot (no Chromium). */
export const BROWSER_PREVIEW_NO_SHOT =
  'Your browser couldn’t take the screenshot this time. Tell the person the branch to look at instead.';

/** “dist” → `preview-dist.png`. */
export function previewFileName(dir: string): string {
  const label = dir
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `preview-${label || 'build'}.png`;
}

type PreviewAnswer = McpToolOutput<'browser_preview'>;

const browserPreview: ToolHandler<'browser_preview'> = async (ctx, input): Promise<PreviewAnswer> => {
  const opts = { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf };
  const begun = await ctx.services.pipeline.commit(previewBuild, { dispatchId: ctx.dispatch.id }, opts);
  if (begun.status !== 'ok') return { status: 'refused', reason: 'Previews aren’t available in this turn.' };
  // Online only for an agent that may browse without asking (BT-50).
  const online = await mayBrowse(ctx);
  const path = input.path ?? '/';
  const upload = await previewsFor(ctx.services).request(ctx.dispatch.id, input.dir, {
    path,
    find: input.find ?? null,
    online,
  });
  if ('error' in upload) return { status: 'refused', reason: upload.error.slice(0, 500) };
  if ('pages' in upload) return { status: 'failed', reason: BROWSER_PREVIEW_NO_SHOT };
  if (!upload.shot) return { status: 'failed', reason: BROWSER_PREVIEW_NO_SHOT };
  const bytes = Math.min(
    BROWSER_PREVIEW_MAX_BYTES,
    upload.files.reduce((n, f) => n + Math.floor((f.data.length * 3) / 4), 0),
  );
  const answer: Extract<PreviewAnswer, { status: 'ok' }> = {
    status: 'ok',
    title: upload.shot.title.slice(0, 300),
    url: `${PREVIEW_ORIGIN}${path}`.slice(0, 1000),
    files: upload.files.length,
    bytes,
  };
  if (input.attach !== false) {
    const published = await publishBrowserFile(
      ctx,
      previewFileName(input.dir),
      Buffer.from(upload.shot.png, 'base64'),
      'image/png',
    );
    if (!published.ok) return { status: 'refused', reason: published.reason.slice(0, 500) };
    answer.attachmentId = published.attachmentId;
  }
  return withImage(answer, upload.shot.png);
};

/** What `page_preview` answers when the runner had no browser to draw the page in. */
export const PAGE_PREVIEW_NO_SHOT =
  'Your browser couldn’t draw the page this time. Post it if you’re confident it’s right, or try again.';

/** Whether this agent may browse without asking (BT-50): its previews may then reach the internet. */
async function mayBrowse(ctx: Parameters<ToolHandler<'browser_preview'>>[0]): Promise<boolean> {
  return (await loadGrants(ctx.services.db, ctx.agentId)).some(
    (g) => g.keyId === 'browser.use' && g.tier === 'can',
  );
}

/**
 * `page_preview` (docs/decisions/visual-replies.md): the page as a message's frame shows it (the frame's policy, the
 * theme), drawn by the turn's runner in the agent's Chromium; the screenshot comes back as MCP image content, nothing
 * is published or recorded.
 */
const pagePreview: ToolHandler<'page_preview'> = async (ctx, input) => {
  const theme = input.theme ?? 'light';
  const page = { html: framedPage(input.html, pageThemeCss(theme)), width: input.width ?? PAGE_WIDTH };
  const upload = await previewsFor(ctx.services).requestPage(ctx.dispatch.id, page);
  if ('error' in upload) return { status: 'refused', reason: upload.error.slice(0, 500) };
  const shot = 'pages' in upload ? null : upload.shot;
  if (!shot) return { status: 'failed', reason: PAGE_PREVIEW_NO_SHOT };
  return withImage(
    {
      status: 'ok' as const,
      height: shot.height ?? 0,
      title: shot.title.slice(0, 300),
      console: shot.console ?? [],
      blocked: shot.blocked ?? 0,
    },
    shot.png,
  );
};

/** `TOOL_HANDLERS`' browser part: `browser_preview` and `page_preview`. */
export const BROWSER_TOOL_HANDLERS: {
  browser_preview: ToolHandler<'browser_preview'>;
  page_preview: ToolHandler<'page_preview'>;
} = {
  browser_preview: browserPreview,
  page_preview: pagePreview,
};
