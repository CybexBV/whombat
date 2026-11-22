/**
 * Incoming emails mirrored for mail-triggered automations: trigger facts, item keys, run headlines and
 * outsider-fenced run scopes (`{{trigger.*}}`). Every sender-controlled field is defused and wrapped in
 * `[[mail …]] … [[/mail]]` before entering a run's scope so no step template can hand unfenced email text to an agent.
 */
import {
  type ConnectorProvider,
  fenceMailContent,
  fenceMailField,
  type JsonObject,
  MAIL_TRIGGER_BODY_MAX,
  MAIL_TRIGGER_SNIPPET_MAX,
  type MailTriggerFacts,
  type MissingMailAttachment,
  missingAttachmentReasonText,
  safeDisplayName,
} from '@whombat/core';
import type { StoredMailAttachment } from '../db/schema/mail-triggers';

export interface MirroredMailItem {
  id: string;
  burrowId: string;
  connectionId: string;
  provider: ConnectorProvider;
  mailbox: string;
  externalId: string;
  threadId: string;
  fromHeader: string;
  fromAddress: string;
  subject: string;
  snippet: string;
  body: string;
  bodyTruncated: boolean;
  attachments: readonly StoredMailAttachment[];
  /** Whombat attachment ids handed over by the server for the run's thread prompt. */
  attachmentIds: readonly string[];
  receivedAt: Date;
}

/** One thread per email in the automation's room. */
export function mailItemKey(connectionId: string, externalId: string): string {
  return `mail:${connectionId}:${externalId}`;
}

/** Short plain summary shown on the automation run list (clipped to fit `AutomationTriggerInfo.summary`). */
export function mailHeadline(item: Pick<MirroredMailItem, 'fromAddress' | 'fromHeader' | 'subject'>): string {
  const sender = (item.fromAddress || item.fromHeader || 'unknown sender').replace(/\s+/g, ' ').trim();
  const subject = item.subject.replace(/\s+/g, ' ').trim();
  const text = subject ? `Mail from ${sender}: “${subject}”` : `Mail from ${sender}`;
  return text.length <= 200 ? text : `${text.slice(0, 199).trimEnd()}…`;
}

/** Trigger facts evaluated against every live automation's `mail` trigger when scanning signed events. */
export function mailTriggerFactsOf(item: MirroredMailItem): MailTriggerFacts {
  return {
    kind: 'mail',
    connectionId: item.connectionId,
    from: item.fromHeader || item.fromAddress,
    subject: item.subject,
    hasAttachments: item.attachments.length > 0,
    attachments: item.attachments.map((a) => ({ name: a.name, mimeType: a.mimeType })),
  };
}

function attachmentsSummary(attachments: readonly StoredMailAttachment[]): string {
  if (attachments.length === 0) return 'none';
  return attachments
    .slice(0, 20)
    .map((a) => {
      const missing = a.missingReason
        ? ` — not attached: ${missingAttachmentReasonText(a.missingReason)}`
        : '';
      return `${a.name || 'attachment'} (${a.mimeType}, ${a.size} bytes${missing})`;
    })
    .join('; ');
}

function missingAttachmentsOf(attachments: readonly StoredMailAttachment[]): MissingMailAttachment[] {
  return attachments
    .filter(
      (
        a,
      ): a is StoredMailAttachment & { missingReason: NonNullable<StoredMailAttachment['missingReason']> } =>
        Boolean(a.missingReason),
    )
    .slice(0, 20)
    .map((a) => ({
      name: safeDisplayName(a.name || 'attachment').slice(0, 255),
      reason: a.missingReason,
    }));
}

/**
 * Scope stored on an automation run (`{{trigger.*}}`). All sender-written content (`text`, `from`, `subject`,
 * `snippet`, `body`, `attachments`) is defused and fenced as outsider data; non-sender metadata (`connectionId`,
 * `provider`, `messageId`, `threadId`, `receivedAt`, `hasAttachments`, `attachmentCount`, `attachmentIds`,
 * `missingAttachments`) stays structured so the server can hand over the email's files onto the run's prompt message
 * and show any files that didn't come along on the run page.
 */
export function mailItemScope(item: MirroredMailItem): JsonObject {
  const receivedAt = item.receivedAt.toISOString();
  const fromRaw = item.fromHeader || item.fromAddress || '(unknown sender)';
  const missingAttachments = missingAttachmentsOf(item.attachments);
  return {
    kind: 'mail',
    connectionId: item.connectionId,
    provider: item.provider,
    mailbox: item.mailbox,
    messageId: item.externalId,
    threadId: item.threadId,
    receivedAt,
    hasAttachments: item.attachments.length > 0,
    attachmentCount: item.attachments.length,
    attachmentIds: [...item.attachmentIds],
    ...(missingAttachments.length ? { missingAttachments } : {}),
    from: fenceMailField('from', fromRaw, 500),
    subject: fenceMailField('subject', item.subject || '(no subject)', 1000),
    snippet: fenceMailField('snippet', item.snippet, MAIL_TRIGGER_SNIPPET_MAX),
    body: fenceMailField('body', item.body, MAIL_TRIGGER_BODY_MAX),
    attachments: fenceMailField('attachments', attachmentsSummary(item.attachments), 1500),
    text: fenceMailContent({
      mailbox: item.mailbox,
      from: fromRaw,
      subject: item.subject,
      receivedAt,
      body: item.body,
      bodyTruncated: item.bodyTruncated,
      attachments: item.attachments.map(({ name, mimeType, size, missingReason }) => ({
        name,
        mimeType,
        size,
        ...(missingReason ? { notAttached: missingAttachmentReasonText(missingReason) } : {}),
      })),
    }),
  };
}

/**
 * Strips mail body text (`body`, `snippet`, `text`) from a mail run's scope once the agent step's prompt has been
 * rendered, so email contents are not kept forever on `automation_runs`. Keeps sender (`from`), `subject`,
 * attachment names/metadata (`attachments`, `attachmentIds`, `missingAttachments`) and routing fields.
 */
export function stripMailScopeContent(scope: JsonObject | null | undefined): JsonObject | null {
  if (!scope || (scope as { kind?: unknown }).kind !== 'mail') return null;
  if (!('body' in scope) && !('snippet' in scope) && !('text' in scope)) return null;
  const { body: _body, snippet: _snippet, text: _text, ...kept } = scope as Record<string, unknown>;
  return kept as JsonObject;
}
