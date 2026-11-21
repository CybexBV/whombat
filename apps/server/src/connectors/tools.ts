/**
 * Handlers of the connector tools (`CONNECTOR_MCP_TOOLS` in core; docs/decisions/connectors.md "Tools"),
 * spread into `TOOL_HANDLERS` (mcp/tools.ts). Every call is the agent's, working for the person, with
 * their connection (`personalAccess`): anything else is refused with the fix. Reads check the key
 * (`connector.read`, no event) and then call Google outside the burrow lock; writes are the commands in
 * commands.ts (content-free events, or an approval in the person's DM).
 */
import {
  CONNECTOR_MCP_TOOLS,
  type ConnectorProvider,
  type ConnectorService,
  type ConnectorToolName,
  type MailSummary,
  type McpToolOutput,
} from '@whombat/core';
import type { z } from 'zod';
import type { CommandDef, CommitOptions } from '../commit/types';
import { ApiError } from '../lib/errors';
import type { ToolContext, ToolHandler } from '../mcp/tools';
import { toOutcome } from '../mcp/tools';
import { shortName } from '../read/principals';
import { type PersonalAccess, personalAccess } from './access';
import {
  type ConnectorResult,
  callGoogle,
  connectorCalendarCreate,
  connectorCalendarDelete,
  connectorCalendarUpdate,
  connectorDocsEdit,
  connectorFilesCreate,
  connectorFilesOrganize,
  connectorFilesShare,
  connectorFilesTrash,
  connectorMailDraft,
  connectorMailOrganize,
  connectorMailSend,
  connectorMailTrash,
  connectorRead,
  connectorSheetsWrite,
  type ReadTool,
} from './commands';
import type { GoogleWorkspace } from './types';

function options(ctx: ToolContext): CommitOptions {
  return { burrowId: ctx.burrowId, actorId: ctx.agentId, onBehalfOf: ctx.onBehalfOf };
}

/**
 * The connection of the person this call's turn is for, or a refusal (one-agent.md OA-10): a turn for anyone else, or
 * a search answer, never reaches their account.
 */
async function guard(
  ctx: ToolContext,
  service: ConnectorService,
  provider?: ConnectorProvider,
): Promise<PersonalAccess> {
  const access = await personalAccess(ctx.services, ctx.services.db, ctx.agentId, service, provider);
  const refuse = (message: string, reason: string) =>
    new ApiError('not_allowed', message, { details: { connector: service, reason } });
  if (ctx.dispatch.search)
    throw refuse(`${access.personName}’s mail, calendar and files aren’t for answering searches.`, 'search');
  const forId = ctx.onBehalfOf.principalId;
  if (forId && forId !== access.person.id)
    throw refuse(`${shortName(access.agent)} only works for ${access.personName}.`, 'not_owner');
  return access;
}

type Outcome<N extends ConnectorToolName> = Promise<McpToolOutput<N>>;

/**
 * The conversation in the provider's web app, opened in the connected account (`authuser`, so a browser
 * signed in to several Google accounts picks the right one): a digest item links here (RM-08).
 */
export function mailWebUrl(
  access: Pick<PersonalAccess, 'provider' | 'connection'>,
  threadId: string,
): string | undefined {
  if (access.provider !== 'google') return undefined;
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(access.connection.email)}#all/${encodeURIComponent(threadId)}`;
}

function withWebUrls<M extends MailSummary>(access: PersonalAccess, messages: M[]): M[] {
  return messages.map((m) => {
    const webUrl = mailWebUrl(access, m.threadId);
    return webUrl ? { ...m, webUrl } : m;
  });
}

/** A read tool: the key check, then the call (no event). */
async function read<N extends ConnectorToolName & ReadTool, O extends object>(
  ctx: ToolContext,
  tool: N,
  provider: ConnectorProvider | undefined,
  fn: (workspace: GoogleWorkspace, token: string, access: PersonalAccess) => Promise<O>,
): Outcome<N> {
  const service = CONNECTOR_MCP_TOOLS[tool].connector;
  const access = await guard(ctx, service, provider);
  const res = await ctx.services.pipeline.commit(connectorRead, { tool, provider }, options(ctx));
  if (res.status !== 'ok') return toOutcome(res, () => ({})) as McpToolOutput<N>;
  const out = await callGoogle(ctx.services, access, service, (g, t) => fn(g, t, access));
  return { status: 'ok', ...out } as McpToolOutput<N>;
}

/** A write tool: its command, whose result is the tool's output or the person's approval. */
async function write<N extends ConnectorToolName, S extends z.ZodType, O extends object>(
  ctx: ToolContext,
  tool: N,
  command: CommandDef<S, ConnectorResult<O>>,
  input: z.input<S>,
): Outcome<N> {
  await guard(ctx, CONNECTOR_MCP_TOOLS[tool].connector, (input as { provider?: ConnectorProvider }).provider);
  const res = await ctx.services.pipeline.commit(command, input, options(ctx));
  if (res.status !== 'ok') return toOutcome(res, () => ({})) as McpToolOutput<N>;
  const r = res.result;
  if (r.kind === 'asked') {
    return {
      status: 'pending_approval',
      approvalId: r.approvalId,
      approvalNumber: r.approvalNumber,
      eventId: r.eventId,
      message: r.message,
    } as McpToolOutput<N>;
  }
  return { status: 'ok', ...r.out } as McpToolOutput<N>;
}

export const CONNECTOR_TOOL_HANDLERS: { [N in ConnectorToolName]: ToolHandler<N> } = {
  mail_attachment: (ctx, input) =>
    read(ctx, 'mail_attachment', input.provider, async (g, t) => ({
      file: await g.mailAttachment(t, input),
    })),
  files_download: (ctx, input) =>
    read(ctx, 'files_download', input.provider, async (g, t) => ({
      file: await g.filesDownload(t, input.fileId),
    })),
  files_organize: (ctx, input) => write(ctx, 'files_organize', connectorFilesOrganize, input),
  mail_search: (ctx, input) =>
    read(ctx, 'mail_search', input.provider, async (g, t, a) => ({
      messages: withWebUrls(a, await g.mailSearch(t, input)),
    })),
  mail_read: (ctx, input) =>
    read(ctx, 'mail_read', input.provider, async (g, t, a) => ({
      messages: withWebUrls(
        a,
        await g.mailRead(t, {
          ...(input.messageId ? { messageId: input.messageId } : {}),
          ...(input.threadId ? { threadId: input.threadId } : {}),
        }),
      ),
    })),
  mail_draft: (ctx, input) => write(ctx, 'mail_draft', connectorMailDraft, input),
  mail_send: (ctx, input) => write(ctx, 'mail_send', connectorMailSend, input),
  mail_organize: (ctx, input) => write(ctx, 'mail_organize', connectorMailOrganize, input),
  mail_trash: (ctx, input) => write(ctx, 'mail_trash', connectorMailTrash, input),
  calendar_events: (ctx, input) =>
    read(ctx, 'calendar_events', input.provider, async (g, t) => ({
      events: await g.calendarEvents(t, {
        calendarId: input.calendarId,
        limit: input.limit,
        ...(input.from ? { from: input.from } : {}),
        ...(input.to ? { to: input.to } : {}),
        ...(input.query ? { query: input.query } : {}),
      }),
    })),
  calendar_create_event: (ctx, input) => write(ctx, 'calendar_create_event', connectorCalendarCreate, input),
  calendar_update_event: (ctx, input) => write(ctx, 'calendar_update_event', connectorCalendarUpdate, input),
  calendar_delete_event: (ctx, input) => write(ctx, 'calendar_delete_event', connectorCalendarDelete, input),
  files_search: (ctx, input) =>
    read(ctx, 'files_search', input.provider, async (g, t) => ({ files: await g.filesSearch(t, input) })),
  files_read: (ctx, input) => read(ctx, 'files_read', input.provider, (g, t) => g.filesRead(t, input.fileId)),
  files_create: (ctx, input) => write(ctx, 'files_create', connectorFilesCreate, input),
  files_share: (ctx, input) => write(ctx, 'files_share', connectorFilesShare, input),
  files_trash: (ctx, input) => write(ctx, 'files_trash', connectorFilesTrash, input),
  docs_edit: (ctx, input) => write(ctx, 'docs_edit', connectorDocsEdit, input),
  sheets_read: (ctx, input) => read(ctx, 'sheets_read', input.provider, (g, t) => g.sheetsRead(t, input)),
  sheets_write: (ctx, input) => write(ctx, 'sheets_write', connectorSheetsWrite, input),
  contacts_search: (ctx, input) =>
    read(ctx, 'contacts_search', input.provider, async (g, t) => ({
      contacts: await g.contactsSearch(t, input),
    })),
};
