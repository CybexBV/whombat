/**
 * Executors of the personal approval actions (`mail_send`, `calendar_invite`, `files_share`, `files_trash`;
 * docs/decisions/connectors.md "Tools"), registered in the approvals executor registry. Each runs after the
 * person approved, as the person's connection (a token from `services.google.tokens`),
 * through `services.google.workspace`. Their error texts end up in the audit log (“Couldn’t send an email:
 * …”), so they name no recipients, subjects or files (PA-09).
 */
import {
  type Approval,
  CalendarEventInput,
  CalendarEventPatch,
  type ConnectorProvider,
  type ConnectorService,
  type ExecutionOutcome,
  type PersonalActionType,
} from '@whombat/core';
import type { ApprovalEngine, Executor } from '../approvals/engine';
import { ApiError } from '../lib/errors';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { connectorError, type PersonalAccess, personalAccess, withAccessToken } from './access';
import { providerWorkspace } from './providers';
import type { GoogleWorkspace } from './types';

type Act = (workspace: GoogleWorkspace, token: string) => Promise<ExecutionOutcome | undefined>;

async function runAsOwner(
  approval: Approval,
  services: Services,
  service: ConnectorService,
  act: Act,
): Promise<ExecutionOutcome> {
  const binding = approval.action.params as {
    provider?: ConnectorProvider;
    connectionId?: string;
    externalAccountId?: string;
  };
  let access: PersonalAccess;
  try {
    access = await personalAccess(
      services,
      services.db,
      approval.requesterId,
      service,
      binding.provider ?? 'google',
      // The account of the person who said yes: only they decide what the agent does with it (PA-09, OA-10).
      approval.decidedById
        ? ((await loadPrincipalRow(services.db, approval.decidedById))?.accountId ?? null)
        : null,
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (
    (binding.connectionId && binding.connectionId !== access.connection.id) ||
    (binding.externalAccountId && binding.externalAccountId !== access.connection.externalId)
  )
    return { ok: false, error: 'The connected account changed. Ask for approval again.' };
  // Only the person decides what their assistant does with their account (PA-09).
  if (approval.decidedById !== access.person.id)
    return { ok: false, error: `Only ${access.personName} can approve this.` };
  try {
    const outcome = await withAccessToken(
      services,
      access.accountId,
      (token) => act(providerWorkspace(services, access.provider), token),
      access.provider,
    );
    return outcome ?? { ok: true, resultUrl: null };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: connectorError(err, access, service, { forLog: true }).message };
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

export const CONNECTOR_EXECUTORS: Record<PersonalActionType, Executor> = {
  mail_send: (approval, services) => {
    if (approval.action.type !== 'mail_send') throw new Error('Not a mail_send approval.');
    const p = approval.action.params;
    return runAsOwner(approval, services, 'mail', async (g, token) => {
      // The draft must still be what the person approved (it lives in their mailbox and can be edited there).
      const draft = await g.mailGetDraft(token, p.draftId);
      const unchanged =
        sameSet(draft.to, p.to) &&
        sameSet(draft.cc, p.cc) &&
        sameSet(draft.bcc, p.bcc) &&
        draft.subject === p.subject &&
        JSON.stringify(draft.attachments ?? []) === JSON.stringify(p.attachments ?? []) &&
        (p.body !== undefined ? draft.body === p.body : draft.body.startsWith(p.bodyPreview));
      if (!unchanged) return { ok: false, error: 'The draft changed after it was approved. Ask again.' };
      await g.mailSendDraft(token, p.draftId);
      return undefined;
    });
  },

  calendar_invite: (approval, services) => {
    if (approval.action.type !== 'calendar_invite') throw new Error('Not a calendar_invite approval.');
    const p = approval.action.params;
    return runAsOwner(approval, services, 'calendar', async (g, token) => {
      if (p.op === 'create') {
        const event = CalendarEventInput.safeParse(p.event);
        if (!event.success) return { ok: false, error: 'The event to create is incomplete.' };
        await g.calendarCreateEvent(token, {
          calendarId: p.calendarId,
          event: event.data,
          sendUpdates: true,
        });
        return undefined;
      }
      if (!p.eventId) return { ok: false, error: 'The approval names no event.' };
      if (p.op === 'update') {
        // The approval spells out the guests after the change; the stored change is applied as it was approved.
        const patch = CalendarEventPatch.parse({ ...(p.event ?? {}), guests: p.guests });
        await g.calendarUpdateEvent(token, {
          calendarId: p.calendarId,
          eventId: p.eventId,
          patch,
          sendUpdates: true,
        });
        return undefined;
      }
      await g.calendarDeleteEvent(token, { calendarId: p.calendarId, eventId: p.eventId, sendUpdates: true });
      return undefined;
    });
  },

  files_share: (approval, services) => {
    if (approval.action.type !== 'files_share') throw new Error('Not a files_share approval.');
    const p = approval.action.params;
    return runAsOwner(approval, services, 'files', async (g, token) => {
      await g.filesShare(token, { fileId: p.fileId, email: p.email, role: p.role });
      return undefined;
    });
  },

  files_trash: (approval, services) => {
    if (approval.action.type !== 'files_trash') throw new Error('Not a files_trash approval.');
    const p = approval.action.params;
    return runAsOwner(approval, services, 'files', async (g, token) => {
      await g.filesTrash(token, p.fileId);
      return undefined;
    });
  },
};

export function registerConnectorExecutors(approvals: ApprovalEngine): void {
  for (const [type, executor] of Object.entries(CONNECTOR_EXECUTORS) as [PersonalActionType, Executor][])
    approvals.setExecutor(type, executor);
}
