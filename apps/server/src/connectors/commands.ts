/**
 * The connector tools as burrow commands (docs/decisions/connectors.md "Tools", CN-07; connectors-google-tools.md
 * GT-06…GT-11). Each runs through the commit pipeline as the agent, so the keys engine decides:
 *
 * - reads (`connector.read`) only check the key and write no event; the handler calls Google after the
 *   commit, outside the burrow lock;
 * - allowed writes call Google after the command's commit, outside the burrow lock (`changeAfterCommit`), and then
 *   sign a content-free event (“Drafted an email”); when the person set such a key to ask, the pipeline's own
 *   approval re-runs the command once they say yes;
 * - sending, invites, sharing and trashing always ask: the command prepares the action (a draft, the file's
 *   name, the event's guests) and asks the person in their DM; the executor (executors.ts) runs it after.
 *
 * Approvals go to the person only, in their Chat, and their Asks events carry no content.
 */
import {
  type ApprovalAction,
  ApprovalAction as ApprovalActionSchema,
  actionCopy,
  actionKey,
  CalendarEventPatch,
  ConnectorProvider,
  type ConnectorService,
  calendarChangeKey,
  decide,
  describeAction,
  describeAsk,
  formatClock,
  formatDate,
  joinWithAnd,
  KEY_CATALOG,
  type KeyId,
  KeyId as KeyIdSchema,
  keyRefOf,
  MAIL_SEND_BODY_CAP,
  MailAddress,
  MCP_TOOLS,
  type PersonalActionType,
  serviceLabel,
} from '@whombat/core';
import { z } from 'zod';
import { createApproval } from '../approvals/create';
import { assertOutsideLock } from '../commit/lock-scope';
import type { ApplyContext, CommandDef, KeyRequirement, RequirementContext } from '../commit/types';
import { defineCommand } from '../commit/types';
import type { Db } from '../db/client';
import { ensurePersonalDm, personalDmId } from '../domain/personal-dm';
import { ApiError, badRequest, conflict } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { engineActor, loadGrants } from '../read/principals';
import type { Services } from '../services';
import { connectorError, type PersonalAccess, personalAccess, withAccessToken } from './access';
import { providerWorkspace } from './providers';
import type { GoogleWorkspace } from './types';

const clip = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** A connector command's result: done (the tool's output), or the person was asked first. */
export type ConnectorResult<O> =
  | { kind: 'done'; out: O }
  | { kind: 'asked'; approvalId: string; approvalNumber: number; eventId: string; message: string };

type PersonalAction = Extract<ApprovalAction, { type: PersonalActionType }>;

/**
 * Calls Google as the person's connection (401 retried once); errors become tool errors naming the fix. Never while
 * the burrow's write lock is held (`assertOutsideLock`), except for a read named by `underLock`: what an approval card
 * shows, read while the command decides.
 */
export async function callGoogle<T>(
  services: Services,
  access: PersonalAccess,
  service: ConnectorService,
  fn: (workspace: GoogleWorkspace, token: string) => Promise<T>,
  underLock?: 'approval card',
): Promise<T> {
  if (!underLock)
    assertOutsideLock('Google', {
      production: services.config.NODE_ENV === 'production',
      warn: (msg) => services.log.warn(msg),
    });
  try {
    return await withAccessToken(
      services,
      access.accountId,
      (token) => fn(providerWorkspace(services, access.provider), token),
      access.provider,
    );
  } catch (err) {
    throw connectorError(err, access, service);
  }
}

function where(access: PersonalAccess, service: ConnectorService): string {
  return serviceLabel(service, access.provider);
}

/**
 * What a connector command needs from the keys engine. An approval the engine creates (a write key the person
 * set to ask) goes to the person only, in their DM, with no content in its Asks event.
 */
async function requirementFor(
  ctx: RequirementContext,
  provider: ConnectorProvider | undefined,
  service: ConnectorService,
  keyId: KeyId,
  attempt: string,
  onAsk: KeyRequirement['onAsk'] = 'approval',
): Promise<KeyRequirement> {
  const access = await personalAccess(ctx.services, ctx.db, ctx.actor.id, service, provider);
  return {
    keyId,
    attempt,
    where: where(access, service),
    // The approval goes to the person's DM whatever is named here (createApproval, PA-09).
    conversationId: await personalDmId(ctx.db, ctx.actor.id, access.person.id),
    onAsk,
    approval: {
      cardText: `I need your yes before I ${attempt}.`,
      explainer: `${ctx.actor.shortName} holds “${KEY_CATALOG[keyId].label}”, a key that only turns when you approve. If you approve, it goes ahead right away.`,
    },
  };
}

async function accessIn(
  ctx: ApplyContext,
  db: Db,
  service: ConnectorService,
  provider?: ConnectorProvider,
): Promise<PersonalAccess> {
  return personalAccess(ctx.services, db, ctx.actor.id, service, provider);
}

/** The content-free events a change to the person's account signs (PA-09). */
const CHANGE_TYPES = [
  'mail.drafted',
  'mail.organized',
  'mail.trashed',
  'calendar.event_created',
  'calendar.event_changed',
  'calendar.event_deleted',
  'files.created',
  'files.organized',
  'files.trashed',
  'docs.edited',
  'sheets.edited',
] as const;

/** Signs the content-free event of a change Google has made (PA-09), as the agent that asked for it. */
export const connectorChanged = defineCommand({
  name: 'connector.changed',
  schema: z.object({
    type: z.enum(CHANGE_TYPES),
    tool: z.string().min(1).max(60),
    service: z.string().min(1).max(30),
    text: z.string().min(1).max(120),
    where: z.string().min(1).max(60),
    /** The key the change was decided under, in the command before it (KEY USED). */
    keyId: KeyIdSchema.nullable(),
  }),
  async apply(_tx, ctx, input): Promise<void> {
    await ctx.emit({
      ...(input.keyId ? { keyUsed: keyRefOf(input.keyId) } : {}),
      type: input.type,
      kind: 'Messages',
      text: input.text,
      where: input.where,
      payload: { tool: input.tool, service: input.service },
    });
  },
});

/**
 * An allowed change to the person's account, made after this command's commit, outside the burrow lock: a slow
 * provider holds up no other write, and its event is signed only once Google said it was done. The command's result
 * is filled in before `commit` returns (a required continuation), and Google's error is the caller's.
 */
function changeAfterCommit<O extends object>(
  ctx: ApplyContext,
  access: PersonalAccess,
  service: ConnectorService,
  change: { tool: string; type: (typeof CHANGE_TYPES)[number]; text: (out: O) => string },
  call: (workspace: GoogleWorkspace, token: string) => Promise<O>,
): ConnectorResult<O> {
  const result: { kind: 'done'; out: O } = { kind: 'done', out: {} as O };
  const { services, onBehalfOf } = ctx;
  const options = { burrowId: ctx.burrow.id, actorId: ctx.actor.id, onBehalfOf };
  const keyId = ctx.actor.kind === 'agent' && ctx.decision ? ctx.decision.keyId : null;
  ctx.complete(async () => {
    result.out = await callGoogle(services, access, service, call);
    try {
      const logged = await services.pipeline.commit(
        connectorChanged,
        {
          type: change.type,
          tool: change.tool,
          service,
          text: change.text(result.out),
          where: where(access, service),
          keyId,
        },
        options,
      );
      return logged.status === 'ok' ? logged.eventIds : [];
    } catch (err) {
      // The change is made: the agent hears it was, even when its log line couldn't be signed.
      services.log.warn(
        { err: err instanceof Error ? err.name : 'error', tool: change.tool },
        'connector change not logged',
      );
      return [];
    }
  });
  return result;
}

/**
 * Asks the person to approve a personal action: the approval card in their DM with the agent, the person as
 * the only approver, and an Asks event without recipients, subjects or file names. The executor runs it.
 */
async function askOwner(
  ctx: ApplyContext,
  access: PersonalAccess,
  service: ConnectorService,
  raw: PersonalAction,
  extra: { summary?: string; whatHappens?: string[] } = {},
): Promise<ConnectorResult<never>> {
  const parsed = ApprovalActionSchema.safeParse({
    ...raw,
    params: {
      ...raw.params,
      provider: access.provider,
      connectionId: access.connection.id,
      externalAccountId: access.connection.externalId,
    },
  });
  if (!parsed.success) throw badRequest('Some addresses or fields of this request are not valid.');
  const action = parsed.data as PersonalAction;
  const conversation = await loadConversationRow(
    ctx.tx,
    await ensurePersonalDm(ctx, access.agent, access.person),
  );
  if (!conversation) throw conflict(`${access.personName} has no DM with ${ctx.actor.shortName} to ask in.`);
  const keyId = actionKey(action);
  const copy = actionCopy(action);
  const { approval, eventId } = await createApproval(ctx, {
    keyId,
    action,
    decision: ctx.decision?.outcome === 'ask' ? ctx.decision : null,
    title: copy.title,
    question: copy.question,
    target: copy.target,
    whatHappens: extra.whatHappens ?? [],
    explainer: `${ctx.actor.shortName} holds “${KEY_CATALOG[keyId].label}”, a key that always asks you first. If you approve, it goes ahead right away.`,
    summary: extra.summary ?? '',
    conditions: [],
    involvedIds: [],
    conversation,
    cardText: `I need your yes before I ${describeAction(action)}.`,
    askText: describeAsk(action),
    where: where(access, service),
    command: null,
  });
  return {
    kind: 'asked',
    approvalId: approval.id,
    approvalNumber: approval.number,
    eventId,
    message: `${access.personName} has to approve this first. It goes ahead once they say yes.`,
  };
}

/* Reads ----------------------------------------------------------------------------------------- */

export const READ_TOOLS = [
  'mail_attachment',
  'files_download',
  'mail_search',
  'mail_read',
  'calendar_events',
  'files_search',
  'files_read',
  'sheets_read',
  'contacts_search',
] as const;
export type ReadTool = (typeof READ_TOOLS)[number];

const READ_ATTEMPTS: Record<ReadTool, string> = {
  mail_attachment: 'read a mail attachment',
  files_download: 'download a file',
  mail_search: 'read mail',
  mail_read: 'read mail',
  calendar_events: 'read the calendar',
  files_search: 'read files',
  files_read: 'read files',
  sheets_read: 'read files',
  contacts_search: 'read contacts',
};

/**
 * The key check of a read tool. Nothing is written when it is allowed (read-only tools write no events,
 * PA-09); a read cannot wait for an approval, so a read key the person set to ask is refused with the fix.
 */
export const connectorRead = defineCommand({
  name: 'connector.read',
  schema: z.object({ tool: z.enum(READ_TOOLS), provider: ConnectorProvider.optional() }),
  async requiredKey(input, ctx) {
    const def = MCP_TOOLS[input.tool];
    return requirementFor(
      ctx,
      input.provider,
      def.connector,
      def.requiredKey as KeyId,
      READ_ATTEMPTS[input.tool],
      'apply',
    );
  },
  async apply(tx, ctx, input): Promise<Record<string, never>> {
    if (ctx.decision?.outcome === 'ask') {
      const access = await accessIn(ctx, tx, MCP_TOOLS[input.tool].connector, input.provider);
      const label = KEY_CATALOG[ctx.decision.keyId].label;
      throw new ApiError(
        'not_allowed',
        `${access.personName} set “${label}” to ask first, and reading can’t wait for a yes. Ask ${access.personName} to change it in your keys.`,
        { details: { connector: MCP_TOOLS[input.tool].connector, reason: 'read_asks' } },
      );
    }
    return {};
  },
});

/* Mail ------------------------------------------------------------------------------------------ */

export const connectorMailDraft = defineCommand({
  name: 'connector.mail_draft',
  schema: MCP_TOOLS.mail_draft.input,
  requiredKey: (input, ctx) => requirementFor(ctx, input.provider, 'mail', 'mail.draft', 'draft an email'),
  async apply(tx, ctx, input): Promise<ConnectorResult<{ draftId: string }>> {
    const access = await accessIn(ctx, tx, 'mail', input.provider);
    return changeAfterCommit(
      ctx,
      access,
      'mail',
      { tool: 'mail_draft', type: 'mail.drafted', text: () => 'Drafted an email' },
      async (g, t) => ({ draftId: (await g.mailDraft(t, input)).draftId }),
    );
  },
});

export const connectorMailOrganize = defineCommand({
  name: 'connector.mail_organize',
  schema: MCP_TOOLS.mail_organize.input,
  requiredKey: (input, ctx) => requirementFor(ctx, input.provider, 'mail', 'mail.organize', 'organize mail'),
  async apply(tx, ctx, input): Promise<ConnectorResult<{ updated: number }>> {
    const access = await accessIn(ctx, tx, 'mail', input.provider);
    return changeAfterCommit(
      ctx,
      access,
      'mail',
      {
        tool: 'mail_organize',
        type: 'mail.organized',
        text: ({ updated }) =>
          updated ? `Organized ${updated} ${updated === 1 ? 'email' : 'emails'}` : 'Organized mail',
      },
      async (g, t) => ({ updated: (await g.mailOrganize(t, input)).updated }),
    );
  },
});

/** Whether the agent's key asks first: only then does the card need to say which emails (one read each). */
async function asksFirst(ctx: RequirementContext, keyId: KeyId): Promise<boolean> {
  const grants = ctx.actor.kind === 'agent' ? await loadGrants(ctx.db, ctx.actor.id) : [];
  return decide(engineActor(ctx.actor), grants, keyId).outcome === 'ask';
}

/** How many emails, in words: “an email”, “3 emails”. */
const emails = (n: number) => (n === 1 ? 'an email' : `${n} emails`);

/** The emails a trash card names (the first three by subject and sender), so the person knows what goes. */
async function trashLines(
  ctx: RequirementContext,
  access: PersonalAccess,
  messageIds: readonly string[],
): Promise<string[]> {
  const shown = messageIds.slice(0, 3);
  const lines: string[] = [];
  for (const messageId of shown) {
    const [m] = await callGoogle(
      ctx.services,
      access,
      'mail',
      (g, t) => g.mailRead(t, { messageId }),
      'approval card',
    );
    lines.push(m ? `“${clip(m.subject || '(no subject)', 120)}” from ${clip(m.from, 80)}` : 'An email');
  }
  const more = messageIds.length - shown.length;
  if (more > 0) lines.push(more === 1 ? 'And one more' : `And ${more} more`);
  return lines;
}

export const connectorMailTrash = defineCommand({
  name: 'connector.mail_trash',
  schema: MCP_TOOLS.mail_trash.input,
  async requiredKey(input, ctx) {
    const attempt = `move ${emails(input.messageIds.length)} to the trash`;
    const req = await requirementFor(ctx, input.provider, 'mail', 'mail.delete', attempt);
    if (!(await asksFirst(ctx, 'mail.delete'))) return req;
    const access = await personalAccess(ctx.services, ctx.db, ctx.actor.id, 'mail', input.provider);
    return {
      ...req,
      approval: { ...req.approval, whatHappens: await trashLines(ctx, access, input.messageIds) },
    };
  },
  async apply(tx, ctx, input): Promise<ConnectorResult<{ trashed: number }>> {
    const access = await accessIn(ctx, tx, 'mail', input.provider);
    return changeAfterCommit(
      ctx,
      access,
      'mail',
      {
        tool: 'mail_trash',
        type: 'mail.trashed',
        text: ({ trashed }) => `Moved ${emails(trashed)} to the trash`,
      },
      async (g, t) => ({ trashed: (await g.mailTrash(t, { messageIds: input.messageIds })).trashed }),
    );
  },
});

export const connectorMailSend = defineCommand({
  name: 'connector.mail_send',
  schema: MCP_TOOLS.mail_send.input,
  requiredKey: (input, ctx) =>
    requirementFor(ctx, input.provider, 'mail', 'mail.send', 'send an email', 'apply'),
  async apply(tx, ctx, input): Promise<ConnectorResult<never>> {
    const access = await accessIn(ctx, tx, 'mail', input.provider);
    const tooLong = (body: string) => {
      if (body.length > MAIL_SEND_BODY_CAP)
        throw badRequest(
          `That email is too long to approve in one card: keep the body under ${MAIL_SEND_BODY_CAP.toLocaleString('en')} characters.`,
        );
    };
    if (!input.draftId) tooLong(input.body);
    // What the person approves is exactly what is sent: a full message is drafted first (CF-16).
    const draftId =
      input.draftId ??
      (
        await callGoogle(
          ctx.services,
          access,
          'mail',
          (g, t) =>
            g.mailDraft(t, {
              to: input.to,
              cc: input.cc,
              bcc: input.bcc,
              subject: input.subject,
              body: input.body,
              ...(input.attachments ? { attachments: input.attachments } : {}),
              ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
            }),
          'approval card',
        )
      ).draftId;
    const draft = await callGoogle(
      ctx.services,
      access,
      'mail',
      (g, t) => g.mailGetDraft(t, draftId),
      'approval card',
    );
    if (draft.to.length === 0) throw badRequest('That draft has no recipients yet. Draft it again with to.');
    // The person reads the whole body on the approval, and only that body is sent (IN-16).
    tooLong(draft.body);
    const bodyPreview = draft.body.slice(0, 1000);
    return askOwner(
      ctx,
      access,
      'mail',
      {
        type: 'mail_send',
        params: {
          connectionEmail: access.connection.email,
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          subject: draft.subject,
          bodyPreview,
          body: draft.body,
          draftId: draft.draftId,
          attachments: draft.attachments ?? [],
        },
      },
      {
        summary: bodyPreview.slice(0, 400),
        whatHappens: [
          `Message: “${clip(draft.body, 240)}”`,
          ...(draft.attachments ?? []).map((a) => `Attachment: ${a.name} (${a.size} bytes)`),
        ],
      },
    );
  },
});

/* Calendar -------------------------------------------------------------------------------------- */

/** “2 Oct 14:00–14:30” in the burrow's zone; all-day events by date. */
export function eventWhen(start: string, end: string, timeZone: string, now: Date): string {
  if (!start.includes('T')) return start === end || !end ? start : `${start} – ${end}`;
  const day = formatDate(start, timeZone, { now });
  const endDay = end.includes('T') ? formatDate(end, timeZone, { now }) : end;
  const endPart = endDay === day ? formatClock(end, timeZone) : `${endDay} ${formatClock(end, timeZone)}`;
  return `${day} ${formatClock(start, timeZone)}–${endPart}`;
}

/** The lines under WHAT HAPPENS for an invite: when, and who is emailed. */
function inviteLines(ctx: ApplyContext, start: string, end: string, guests: readonly string[]): string[] {
  const lines = [`When: ${eventWhen(start, end, ctx.burrow.timeZone, ctx.now)}`];
  if (guests.length) lines.push(`Guests: ${joinWithAnd(guests)}`);
  return lines;
}

/** Addresses the provider emails, as the approval action takes them (addresses it cannot read are left out). */
function guestAddresses(emails: readonly string[]): string[] {
  const out: string[] = [];
  for (const e of emails) {
    const parsed = MailAddress.safeParse(e);
    if (parsed.success && !out.includes(parsed.data)) out.push(parsed.data);
  }
  return out;
}

export const connectorCalendarCreate = defineCommand({
  name: 'connector.calendar_create_event',
  schema: MCP_TOOLS.calendar_create_event.input,
  requiredKey(input, ctx) {
    const keyId = calendarChangeKey(input.guests);
    return keyId === 'calendar.invite'
      ? requirementFor(ctx, input.provider, 'calendar', keyId, 'send a calendar invite', 'apply')
      : requirementFor(ctx, input.provider, 'calendar', keyId, 'create an event');
  },
  async apply(tx, ctx, input) {
    const access = await accessIn(ctx, tx, 'calendar', input.provider);
    const { calendarId, ...event } = input;
    if (ctx.requirement?.keyId === 'calendar.invite')
      return askOwner(
        ctx,
        access,
        'calendar',
        {
          type: 'calendar_invite',
          params: {
            op: 'create',
            summary: event.summary,
            start: event.start,
            end: event.end,
            guests: event.guests,
            calendarId,
            event,
          },
        },
        { whatHappens: inviteLines(ctx, event.start, event.end, event.guests) },
      );
    return changeAfterCommit(
      ctx,
      access,
      'calendar',
      { tool: 'calendar_create_event', type: 'calendar.event_created', text: () => 'Created an event' },
      async (g, t) => ({ event: await g.calendarCreateEvent(t, { calendarId, event, sendUpdates: false }) }),
    );
  },
});

/** Guests an event has now (a change emails them, so it becomes an invite that asks first). */
async function currentGuests(
  services: Services,
  access: PersonalAccess,
  calendarId: string,
  eventId: string,
) {
  const existing = await callGoogle(
    services,
    access,
    'calendar',
    (g, t) => g.calendarGetEvent(t, { calendarId, eventId }),
    'approval card',
  );
  return { existing, guests: guestAddresses(existing.guests.map((x) => x.email)) };
}

export const connectorCalendarUpdate = defineCommand({
  name: 'connector.calendar_update_event',
  schema: MCP_TOOLS.calendar_update_event.input,
  async requiredKey(input, ctx) {
    const access = await personalAccess(ctx.services, ctx.db, ctx.actor.id, 'calendar', input.provider);
    const { guests } = await currentGuests(ctx.services, access, input.calendarId, input.eventId);
    const keyId = calendarChangeKey([...guests, ...(input.guests ?? [])]);
    return keyId === 'calendar.invite'
      ? requirementFor(ctx, input.provider, 'calendar', keyId, 'send an updated calendar invite', 'apply')
      : requirementFor(ctx, input.provider, 'calendar', keyId, 'change an event');
  },
  async apply(tx, ctx, input) {
    const access = await accessIn(ctx, tx, 'calendar', input.provider);
    const { calendarId, eventId, ...rest } = input;
    const patch = CalendarEventPatch.parse(rest);
    if (ctx.requirement?.keyId === 'calendar.invite') {
      const { existing, guests } = await currentGuests(ctx.services, access, calendarId, eventId);
      const after = patch.guests ?? guests;
      const start = patch.start ?? existing.start;
      const end = patch.end ?? existing.end;
      return askOwner(
        ctx,
        access,
        'calendar',
        {
          type: 'calendar_invite',
          params: {
            op: 'update',
            summary: patch.summary ?? existing.summary,
            start,
            end,
            guests: after,
            calendarId,
            eventId,
            // The guest list is always spelled out, so the stored change never reads as “no guests”.
            event: { ...patch, guests: after },
          },
        },
        { whatHappens: inviteLines(ctx, start, end, after) },
      );
    }
    return changeAfterCommit(
      ctx,
      access,
      'calendar',
      { tool: 'calendar_update_event', type: 'calendar.event_changed', text: () => 'Changed an event' },
      async (g, t) => ({
        event: await g.calendarUpdateEvent(t, { calendarId, eventId, patch, sendUpdates: false }),
      }),
    );
  },
});

export const connectorCalendarDelete = defineCommand({
  name: 'connector.calendar_delete_event',
  schema: MCP_TOOLS.calendar_delete_event.input,
  async requiredKey(input, ctx) {
    const access = await personalAccess(ctx.services, ctx.db, ctx.actor.id, 'calendar', input.provider);
    const { guests } = await currentGuests(ctx.services, access, input.calendarId, input.eventId);
    const keyId = calendarChangeKey(guests);
    return keyId === 'calendar.invite'
      ? requirementFor(ctx, input.provider, 'calendar', keyId, 'cancel an event', 'apply')
      : requirementFor(ctx, input.provider, 'calendar', keyId, 'delete an event');
  },
  async apply(tx, ctx, input) {
    const access = await accessIn(ctx, tx, 'calendar', input.provider);
    const { calendarId, eventId } = input;
    if (ctx.requirement?.keyId === 'calendar.invite') {
      const { existing, guests } = await currentGuests(ctx.services, access, calendarId, eventId);
      return askOwner(
        ctx,
        access,
        'calendar',
        {
          type: 'calendar_invite',
          params: {
            op: 'delete',
            summary: existing.summary,
            start: existing.start,
            end: existing.end,
            guests,
            calendarId,
            eventId,
          },
        },
        { whatHappens: inviteLines(ctx, existing.start, existing.end, guests) },
      );
    }
    return changeAfterCommit(
      ctx,
      access,
      'calendar',
      { tool: 'calendar_delete_event', type: 'calendar.event_deleted', text: () => 'Deleted an event' },
      async (g, t) => {
        await g.calendarDeleteEvent(t, { calendarId, eventId, sendUpdates: false });
        return { deleted: true as const };
      },
    );
  },
});

/* Files, docs and sheets ------------------------------------------------------------------------ */

const CREATED_TEXT = {
  doc: 'Created a doc',
  sheet: 'Created a spreadsheet',
  text: 'Created a file',
} as const;

export const connectorFilesCreate = defineCommand({
  name: 'connector.files_create',
  schema: MCP_TOOLS.files_create.input,
  requiredKey: (input, ctx) => requirementFor(ctx, input.provider, 'files', 'files.write', 'create a file'),
  async apply(tx, ctx, input) {
    const access = await accessIn(ctx, tx, 'files', input.provider);
    return changeAfterCommit(
      ctx,
      access,
      'files',
      { tool: 'files_create', type: 'files.created', text: () => CREATED_TEXT[input.kind] },
      async (g, t) => ({ file: await g.filesCreate(t, input) }),
    );
  },
});

export const connectorFilesOrganize = defineCommand({
  name: 'connector.files_organize',
  schema: MCP_TOOLS.files_organize.input,
  requiredKey: (input, ctx) => requirementFor(ctx, input.provider, 'files', 'files.write', 'organize files'),
  async apply(tx, ctx, input) {
    const access = await accessIn(ctx, tx, 'files', input.provider);
    return changeAfterCommit(
      ctx,
      access,
      'files',
      { tool: 'files_organize', type: 'files.organized', text: () => 'Organized files' },
      async (g, t) => ({ file: await g.filesOrganize(t, input) }),
    );
  },
});

export const connectorFilesShare = defineCommand({
  name: 'connector.files_share',
  schema: MCP_TOOLS.files_share.input,
  requiredKey: (input, ctx) =>
    requirementFor(ctx, input.provider, 'files', 'files.share', 'share a file', 'apply'),
  async apply(tx, ctx, input) {
    const access = await accessIn(ctx, tx, 'files', input.provider);
    const file = await callGoogle(
      ctx.services,
      access,
      'files',
      (g, t) => g.filesGet(t, input.fileId),
      'approval card',
    );
    return askOwner(ctx, access, 'files', {
      type: 'files_share',
      params: { fileId: file.id, fileName: file.name, email: input.email, role: input.role },
    });
  },
});

export const connectorFilesTrash = defineCommand({
  name: 'connector.files_trash',
  schema: MCP_TOOLS.files_trash.input,
  requiredKey: (input, ctx) =>
    requirementFor(ctx, input.provider, 'files', 'files.delete', 'move a file to the trash', 'apply'),
  async apply(tx, ctx, input) {
    const access = await accessIn(ctx, tx, 'files', input.provider);
    // The person let it go ahead without asking (Move files to the trash: On).
    if (ctx.decision?.outcome !== 'ask') {
      return changeAfterCommit(
        ctx,
        access,
        'files',
        { tool: 'files_trash', type: 'files.trashed', text: () => 'Moved a file to the trash' },
        async (g, t) => {
          await g.filesTrash(t, input.fileId);
          return { trashed: true as const };
        },
      );
    }
    const file = await callGoogle(
      ctx.services,
      access,
      'files',
      (g, t) => g.filesGet(t, input.fileId),
      'approval card',
    );
    return askOwner(ctx, access, 'files', {
      type: 'files_trash',
      params: { fileId: file.id, fileName: file.name },
    });
  },
});

export const connectorDocsEdit = defineCommand({
  name: 'connector.docs_edit',
  schema: MCP_TOOLS.docs_edit.input,
  requiredKey: (input, ctx) => requirementFor(ctx, input.provider, 'docs', 'files.write', 'edit a doc'),
  async apply(tx, ctx, input) {
    const access = await accessIn(ctx, tx, 'docs', input.provider);
    return changeAfterCommit(
      ctx,
      access,
      'docs',
      { tool: 'docs_edit', type: 'docs.edited', text: () => 'Edited a doc' },
      async (g, t) => ({ applied: (await g.docsEdit(t, input)).applied }),
    );
  },
});

export const connectorSheetsWrite = defineCommand({
  name: 'connector.sheets_write',
  schema: MCP_TOOLS.sheets_write.input,
  requiredKey: (input, ctx) =>
    requirementFor(ctx, input.provider, 'sheets', 'files.write', 'edit a spreadsheet'),
  async apply(tx, ctx, input) {
    const access = await accessIn(ctx, tx, 'sheets', input.provider);
    return changeAfterCommit(
      ctx,
      access,
      'sheets',
      { tool: 'sheets_write', type: 'sheets.edited', text: () => 'Edited a spreadsheet' },
      (g, t) => g.sheetsWrite(t, input),
    );
  },
});

/**
 * Registered with the pipeline: a write the person set to ask is re-run by name once they approve (the
 * pipeline's deferred command). Reads and the always-asking actions never are, but share the registry.
 */
export const CONNECTOR_COMMANDS: CommandDef[] = [
  connectorRead,
  connectorChanged,
  connectorMailDraft,
  connectorMailOrganize,
  connectorMailTrash,
  connectorMailSend,
  connectorCalendarCreate,
  connectorCalendarUpdate,
  connectorCalendarDelete,
  connectorFilesCreate,
  connectorFilesOrganize,
  connectorFilesShare,
  connectorFilesTrash,
  connectorDocsEdit,
  connectorSheetsWrite,
] as CommandDef[];
