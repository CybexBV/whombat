/** The agent, audit log, search, canvases, notifications and devices. */
import { type AgentSetupStatus, api, auditCsvFileName } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { verifyBurrowChain } from '../audit/verify';
import type { BurrowAccess } from '../auth/request';
import {
  markNotificationsRead,
  registerDevice,
  registerLiveActivity,
  removeDevice,
  updateDevice,
} from '../commands/account';
import { setAgentKeys, updateAgent } from '../commands/agents';
import {
  addCanvasComment,
  askSearch,
  createCanvas,
  postAnswer,
  resolveCanvasComment,
} from '../commands/content';
import { canvasComments, canvases, searchAnswers } from '../db/schema/index';
import { ApiError, forbidden, notFound, unauthorized } from '../lib/errors';
import { iso, isoOrNull } from '../lib/time';
import { auditEvent, auditExport, auditPage } from '../read/audit';
import { loadMessageRow, loadMessages } from '../read/messages';
import { loadAgentRow, loadPrincipalRow, toAgent } from '../read/principals';
import { search, toSearchAnswer } from '../read/search';
import { agentProfile, canvasDetail, canvasList, inbox, readableCanvas, toCanvas } from '../read/work-views';
import type { Services } from '../services';
import { commitAs } from './burrows';
import { Raw, route } from './define';

const RECHECK_EVERY_MS = 5_000;
let lastRecheck = 0;

const isOwnerAccess = (access: BurrowAccess) => access.principal.kind === 'person';

/** `host.agents`: the runners' reports. */
function agentSetupStatus(services: Services): AgentSetupStatus {
  return services.runtime.setupStatus();
}

function toDevice(row: Awaited<ReturnType<typeof registerDevice>>) {
  return {
    id: row.id,
    accountId: row.accountId,
    platform: row.platform,
    provider: row.provider,
    token: row.token,
    name: row.name,
    liveActivityToken: row.liveActivityToken,
    createdAt: iso(row.createdAt),
    lastSeenAt: isoOrNull(row.lastSeenAt),
  };
}

export const contentRoutes = [
  /* The agent (one-agent.md OA-09) -------------------------------------------------------------- */
  route(api.agent.get, async ({ access, services }) => {
    const row = await loadAgentRow(services.db, access.burrow.id);
    if (!row) throw notFound('Agent');
    return agentProfile(services.db, access.principal, row);
  }),

  route(api.agent.update, async (ctx) => {
    const { agentId } = await commitAs(ctx, updateAgent, {
      ...(ctx.body.name !== undefined ? { name: ctx.body.name } : {}),
      ...(ctx.body.face !== undefined ? { face: ctx.body.face } : {}),
      ...(ctx.body.runtime ? { runtime: ctx.body.runtime } : {}),
    });
    const row = await loadPrincipalRow(ctx.services.db, agentId);
    if (!row) throw notFound('Agent');
    return { agent: toAgent(row) };
  }),

  route(api.agent.setKeys, async (ctx) => commitAs(ctx, setAgentKeys, { grants: ctx.body.grants })),

  /* Host --------------------------------------------------------------------------------------- */
  route(api.host.info, async ({ services }) => {
    return {
      // Whether a deploy runs here: the condition `approvals/unavailable.ts` answers “Whombat can’t deploy here” on
      // (runs-approvals.md MDS-05, contracts CT-215). Configure's Deploy row shows its hint while it is false.
      deployWorkflow: services.approvals.hasExecutor('deploy'),
      // Whether the agent's services work here: the container engine (one-person.md OP-19).
      services: services.agentServices.hostStatus(),
    };
  }),

  route(api.host.agents, async ({ services }) => agentSetupStatus(services)),

  route(api.host.recheckAgents, async ({ services, access }) => {
    if (!isOwnerAccess(access)) throw forbidden('Only you can check the AI providers again.');
    const now = Date.now();
    // One re-check per few seconds: each starts Claude Code and Codex on the host.
    if (now - lastRecheck >= RECHECK_EVERY_MS) {
      lastRecheck = now;
      services.runtime.requestRecheck();
    }
    return agentSetupStatus(services);
  }),

  /* Audit -------------------------------------------------------------------------------------- */
  route(api.audit.list, async ({ access, query, services }) =>
    auditPage(services.db, access.burrow.id, {
      actor: query.actor,
      kind: query.kind,
      who: query.who,
      before: query.before,
      limit: query.limit,
    }),
  ),

  route(api.audit.get, async ({ access, params, services }) => {
    const event = await auditEvent(services.db, access.burrow.id, params.eventId);
    if (!event) throw notFound('Event');
    return { event };
  }),

  route(api.audit.export, async ({ access, query, services }) => {
    const now = services.clock();
    const { csv } = await auditExport(
      services.db,
      access.burrow,
      { actor: query.actor, kind: query.kind, who: query.who },
      now,
    );
    return new Raw(csv, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${auditCsvFileName(access.burrow.slug, now, access.burrow.timeZone)}"`,
    });
  }),

  route(api.audit.verify, async ({ access, services }) => {
    if (access.principal.kind !== 'person') throw forbidden('Only you can walk the whole chain.');
    return verifyBurrowChain(services.db, access.burrow.id);
  }),

  /* Search ------------------------------------------------------------------------------------- */
  route(api.search.query, async ({ access, auth, query, services }) =>
    search(
      services.db,
      access.principal,
      access.burrow,
      // `after` / `before` are days in the viewer's zone (CT-180).
      { ...query, timeZone: auth.account?.preferences.timeZone ?? access.burrow.timeZone, log: services.log },
      services.clock(),
    ),
  ),

  route(api.search.ask, async (ctx) => {
    const { answerId } = await commitAs(ctx, askSearch, ctx.body);
    const [row] = await ctx.services.db.select().from(searchAnswers).where(eq(searchAnswers.id, answerId));
    if (!row) throw notFound('Answer');
    return { answer: toSearchAnswer(row) };
  }),

  route(api.search.getAnswer, async ({ access, params, services }) => {
    const [row] = await services.db
      .select()
      .from(searchAnswers)
      .where(and(eq(searchAnswers.id, params.answerId), eq(searchAnswers.burrowId, access.burrow.id)));
    if (!row || row.askedById !== access.principal.id) throw notFound('Answer');
    return { answer: toSearchAnswer(row) };
  }),

  route(api.search.postAnswer, async (ctx) => {
    const { messageId } = await commitAs(ctx, postAnswer, {
      answerId: ctx.params.answerId,
      conversationId: ctx.body.conversationId,
    });
    const row = await loadMessageRow(ctx.services.db, messageId);
    const [message] = row ? await loadMessages(ctx.services.db, [row], ctx.access.principal.id) : [];
    if (!message) throw notFound('Message');
    return { message };
  }),

  /* Canvases ----------------------------------------------------------------------------------- */
  route(api.canvases.list, async ({ access, services }) => ({
    canvases: await canvasList(services.db, access.burrow.id),
  })),

  route(api.canvases.create, async (ctx) => {
    const { canvasId } = await commitAs(ctx, createCanvas, ctx.body);
    const [row] = await ctx.services.db.select().from(canvases).where(eq(canvases.id, canvasId));
    if (!row) throw notFound('Canvas');
    return { canvas: toCanvas(row) };
  }),

  route(api.canvases.get, async ({ access, params, services }) => {
    const row = await readableCanvas(services.db, access.burrow.id, params.slug);
    // Who is on the canvas right now comes from the live document's awareness (collab-server.md).
    return { ...(await canvasDetail(services.db, row)), presentIds: services.collab.presentIds(row.id) };
  }),

  // A canvas as Markdown, read-only, for clients without the editor: the text `canvas_read` gives agents (RF-07).
  route(api.canvases.content, async ({ access, params, services }) => {
    const row = await readableCanvas(services.db, access.burrow.id, params.slug);
    const markdown = await services.collab.readMarkdown(row);
    const canvas = toCanvas(row);
    return { canvas, markdown, updatedAt: canvas.updatedAt };
  }),

  route(api.canvases.collabToken, async ({ access, params, services }) => {
    const row = await readableCanvas(services.db, access.burrow.id, params.slug);
    const issued = services.collab.issueToken({
      canvasId: row.id,
      burrowId: access.burrow.id,
      principalId: access.principal.id,
      dispatchId: null,
    });
    return { ...issued, expiresAt: iso(issued.expiresAt) };
  }),

  route(api.canvases.addComment, async (ctx) => {
    const { commentId } = await commitAs(ctx, addCanvasComment, { slug: ctx.params.slug, ...ctx.body });
    const [row] = await ctx.services.db.select().from(canvasComments).where(eq(canvasComments.id, commentId));
    if (!row) throw notFound('Comment');
    return {
      comment: {
        id: row.id,
        canvasId: row.canvasId,
        anchor: row.anchor,
        parentId: row.parentId,
        authorId: row.authorId,
        text: row.text,
        createdAt: iso(row.createdAt),
        resolved: row.resolved,
      },
    };
  }),

  route(api.canvases.resolveComment, async (ctx) => {
    await commitAs(ctx, resolveCanvasComment, {
      slug: ctx.params.slug,
      commentId: ctx.params.commentId,
      resolved: ctx.body.resolved,
    });
    const [row] = await ctx.services.db
      .select()
      .from(canvasComments)
      .where(eq(canvasComments.id, ctx.params.commentId));
    if (!row) throw notFound('Comment');
    return {
      comment: {
        id: row.id,
        canvasId: row.canvasId,
        anchor: row.anchor,
        parentId: row.parentId,
        authorId: row.authorId,
        text: row.text,
        createdAt: iso(row.createdAt),
        resolved: row.resolved,
      },
    };
  }),

  /* Notifications and devices ------------------------------------------------------------------ */
  route(api.notifications.inbox, async ({ access, query, services }) =>
    inbox(services.db, access.principal.id, query.filter),
  ),

  route(api.notifications.markRead, async ({ access, body, services }) => ({
    unread: await markNotificationsRead(services, access.principal.id, body),
  })),

  route(api.devices.register, async ({ auth, body, services }) => {
    if (!auth.account) throw unauthorized();
    return { device: toDevice(await registerDevice(services, auth.account.id, body)) };
  }),

  route(api.devices.update, async ({ auth, body, params, services }) => {
    if (!auth.account) throw unauthorized();
    return { device: toDevice(await updateDevice(services, auth.account.id, params.deviceId, body)) };
  }),

  route(api.devices.remove, async ({ auth, params, services }) => {
    if (!auth.account) throw unauthorized();
    await removeDevice(services, auth.account.id, params.deviceId);
    return { ok: true as const };
  }),

  route(api.devices.registerLiveActivity, async ({ auth, body, params, services }) => {
    if (!auth.account) throw unauthorized();
    await registerLiveActivity(services, auth.account.id, params.deviceId, {
      kind: body.kind,
      refId: body.kind === 'run' ? body.runId : body.approvalId,
      pushToken: body.pushToken,
    });
    return { ok: true as const };
  }),

  // What stopped the phone app (or one of its pages): its own JavaScript errors, which Apple's and Google's crash
  // reports don't carry. Only written into the box's log, for whoever looks into it; nothing is stored.
  route(api.devices.reportErrors, async ({ auth, body, services }) => {
    if (!auth.account) throw unauthorized();
    for (const note of body.notes)
      services.log.warn({ accountId: auth.account.id, ...note }, 'app error noted on the phone');
    return { ok: true as const };
  }),

  // The box's own Web Push key over the session (CT-1307, HE-S221): a community box's, or a configured one.
  route(api.devices.vapidKey, async ({ services }) => {
    const vapid = services.push.vapid();
    if (!vapid)
      throw new ApiError('not_allowed', 'This Whombat doesn’t send browser notifications itself.', {
        details: { code: 'push.web_unavailable' },
      });
    return { publicKey: vapid.publicKey };
  }),
];
