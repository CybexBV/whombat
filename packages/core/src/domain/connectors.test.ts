/** Connectors vocabulary and the agent's connector keys (docs/decisions/connectors.md). */
import { describe, expect, it } from 'vitest';
import { actionCopy } from '../approvals/copy.js';
import { ReturnPath } from '../contracts/connectors.js';
import { MCP_TOOLS, mcpRequiredKey } from '../contracts/index.js';
import { actionKey, describeAction, describeActionForLog, describeAsk } from '../keys/actions.js';
import { agentDefaultGrants } from '../keys/grants.js';
import { ApprovalAction } from './approval.js';
import {
  CONNECTOR_SERVICES,
  clientIdHint,
  connectorMissingText,
  GOOGLE_SCOPES,
  googleEnableApisUrl,
  googleRedirectPath,
  googleRedirectUri,
  googleScopesFor,
  googleServicesGranted,
  SERVICE_LABELS,
  serviceLabel,
} from './connectors.js';

describe('the agent’s connector keys', () => {
  it('reads by default and asks for sending, invites, sharing and trashing', () => {
    const tiers = Object.fromEntries(agentDefaultGrants('prn_dusty').map((g) => [g.keyId, g.tier]));
    expect(tiers['messages.search']).toBe('can');
    expect(tiers['mail.read']).toBe('can');
    for (const keyId of ['mail.send', 'calendar.invite', 'files.share', 'files.delete'])
      expect(tiers[keyId], keyId).toBe('ask');
  });
});

describe('connectors vocabulary (CN-01)', () => {
  it('labels services neutrally and by provider', () => {
    expect(CONNECTOR_SERVICES.map((s) => SERVICE_LABELS[s])).toEqual([
      'Mail',
      'Calendar',
      'Drive',
      'Docs',
      'Sheets',
      'Contacts',
    ]);
    expect(serviceLabel('mail', 'google')).toBe('Gmail');
    expect(serviceLabel('files', 'google')).toBe('Google Drive');
    expect(serviceLabel('calendar')).toBe('Calendar');
    expect(connectorMissingText('Mara', 'files')).toBe(
      'Mara hasn’t connected Google Drive. They can connect it in Settings → Connections.',
    );
  });

  it('builds Google scopes, links and the redirect URI', () => {
    expect(googleScopesFor(['calendar', 'mail'])).toEqual([
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/calendar',
    ]);
    expect(GOOGLE_SCOPES.contacts).toBe('https://www.googleapis.com/auth/contacts.readonly');
    expect(googleServicesGranted(['openid', GOOGLE_SCOPES.files, GOOGLE_SCOPES.docs])).toEqual([
      'files',
      'docs',
    ]);
    expect(googleEnableApisUrl()).toBe(
      'https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com,docs.googleapis.com,sheets.googleapis.com,people.googleapis.com',
    );
    expect(googleRedirectPath).toBe('/api/v1/connectors/google/callback');
    expect(googleRedirectUri('https://dev.whombat.com/')).toBe(
      'https://dev.whombat.com/api/v1/connectors/google/callback',
    );
    expect(clientIdHint('1234567890-abcdefg.apps.googleusercontent.com')).toBe('1234567890-a…');
  });
});

describe('connector tools', () => {
  it('need the personal keys; calendar changes with guests are invites', () => {
    expect(mcpRequiredKey('mail_search', {})).toEqual({ keyId: 'mail.read', scope: {} });
    expect(mcpRequiredKey('files_trash', { fileId: 'f1' })?.keyId).toBe('files.delete');
    const event = {
      summary: 'Standup',
      start: '2026-09-24T10:00:00+02:00',
      end: '2026-09-24T10:15:00+02:00',
    };
    expect(mcpRequiredKey('calendar_create_event', event)?.keyId).toBe('calendar.write');
    expect(mcpRequiredKey('calendar_create_event', { ...event, guests: ['a@b.com'] })?.keyId).toBe(
      'calendar.invite',
    );
    expect(mcpRequiredKey('calendar_update_event', { eventId: 'e1', guests: ['a@b.com'] })?.keyId).toBe(
      'calendar.invite',
    );
    expect(mcpRequiredKey('calendar_update_event', { eventId: 'e1', summary: 'x' })?.keyId).toBe(
      'calendar.write',
    );
    expect(mcpRequiredKey('calendar_delete_event', { eventId: 'e1' })?.keyId).toBe('calendar.write');
  });

  it('validate their inputs', () => {
    expect(MCP_TOOLS.mail_read.input.safeParse({}).success).toBe(false);
    expect(MCP_TOOLS.mail_read.input.safeParse({ threadId: 't1' }).success).toBe(true);
    expect(MCP_TOOLS.mail_send.input.safeParse({ subject: 'x' }).success).toBe(false);
    expect(MCP_TOOLS.mail_send.input.safeParse({ draftId: 'd1' }).success).toBe(true);
    expect(MCP_TOOLS.mail_search.input.safeParse({ limit: 26 }).success).toBe(false);
    // Start and end of one kind (IN-24); a window that starts before it ends (IN-25).
    const event = { summary: 'Offsite', start: '2026-09-25', end: '2026-09-26T10:00:00+02:00' };
    expect(MCP_TOOLS.calendar_create_event.input.safeParse(event).success).toBe(false);
    expect(MCP_TOOLS.calendar_create_event.input.safeParse({ ...event, end: '2026-09-26' }).success).toBe(
      true,
    );
    expect(MCP_TOOLS.calendar_update_event.input.safeParse({ eventId: 'e1', ...event }).success).toBe(false);
    expect(
      MCP_TOOLS.calendar_update_event.input.safeParse({ eventId: 'e1', start: '2026-09-25' }).success,
    ).toBe(true);
    const window = { from: '2026-09-25T00:00:00Z', to: '2026-09-20T00:00:00Z' };
    expect(MCP_TOOLS.calendar_events.input.safeParse(window).success).toBe(false);
    expect(MCP_TOOLS.calendar_events.input.safeParse({ to: window.to }).success).toBe(true);
    // Gmail's own labels are never added or removed (IN-15).
    for (const label of ['TRASH', 'Spam', ' sent ', 'DRAFT', 'CHAT'])
      for (const field of ['addLabels', 'removeLabels'])
        expect(
          MCP_TOOLS.mail_organize.input.safeParse({ messageIds: ['m1'], [field]: [label] }).success,
        ).toBe(false);
    expect(
      MCP_TOOLS.mail_organize.input.safeParse({ messageIds: ['m1'], addLabels: ['STARRED', 'Trash talk'] })
        .success,
    ).toBe(true);
    expect(MCP_TOOLS.files_share.input.parse({ fileId: 'f', email: 'A@B.com', role: 'reader' }).email).toBe(
      'a@b.com',
    );
  });
});

describe('personal approval actions', () => {
  const parse = (a: unknown) => ApprovalAction.parse(a);
  it('need the asking keys and describe themselves', () => {
    const mail = parse({
      type: 'mail_send',
      params: {
        connectionEmail: 'mara@example.com',
        to: ['a@b.com'],
        subject: 'Invoice',
        bodyPreview: 'Hi',
        draftId: 'd1',
      },
    });
    expect(actionKey(mail)).toBe('mail.send');
    expect(describeAction(mail)).toBe('send an email to a@b.com');
    const invite = parse({
      type: 'calendar_invite',
      params: {
        op: 'create',
        summary: 'Standup',
        start: '2026-09-24T10:00:00+02:00',
        end: '2026-09-24T10:15:00+02:00',
        guests: ['a@b.com', 'c@d.com', 'e@f.com'],
      },
    });
    expect(actionKey(invite)).toBe('calendar.invite');
    expect(describeAction(invite)).toBe('send a calendar invite for “Standup” to 3 people');
    const share = parse({
      type: 'files_share',
      params: { fileId: 'f1', fileName: 'Q3 plan', email: 'a@b.com', role: 'writer' },
    });
    expect(actionKey(share)).toBe('files.share');
    expect(describeAction(share)).toBe('share “Q3 plan” with a@b.com');
    const trash = parse({ type: 'files_trash', params: { fileId: 'f1', fileName: 'Q3 plan' } });
    expect(actionKey(trash)).toBe('files.delete');
    expect(describeAsk(trash)).toBe('Asked to move a file to the trash');
  });

  it('keep recipients, subjects and file names out of the audit log (PA-09)', () => {
    const mail = parse({
      type: 'mail_send',
      params: {
        connectionEmail: 'mara@example.com',
        to: ['a@b.com'],
        bcc: ['c@d.com'],
        subject: 'Invoice',
        bodyPreview: 'Hi',
        draftId: 'd1',
      },
    });
    expect(describeActionForLog(mail)).toBe('send an email');
    expect(describeAsk(mail)).toBe('Asked to send an email');
    const invite = (op: 'create' | 'update' | 'delete') =>
      parse({
        type: 'calendar_invite',
        params: { op, summary: 'Standup', start: '2026-09-24', end: '2026-09-25', guests: ['a@b.com'] },
      });
    expect(describeAsk(invite('create'))).toBe('Asked to send a calendar invite');
    expect(describeAsk(invite('update'))).toBe('Asked to send an updated calendar invite');
    expect(describeAsk(invite('delete'))).toBe('Asked to cancel an event');
    expect(
      describeAsk(
        parse({
          type: 'files_share',
          params: { fileId: 'f', fileName: 'Q3', email: 'a@b.com', role: 'reader' },
        }),
      ),
    ).toBe('Asked to share a file');
    // Other actions keep their full description.
    expect(describeActionForLog(parse({ type: 'merge_pr', params: { prNumber: 4, base: 'main' } }))).toBe(
      'merge PR #4 into main',
    );
    // The owner's approval shows every recipient, blind copies included.
    expect(actionCopy(mail).runs).toBe('Send “Invoice” from mara@example.com to a@b.com, bcc c@d.com');
  });
});

describe('ReturnPath (IN-19)', () => {
  it('takes paths on this Whombat and nothing that normalizes off it', () => {
    for (const ok of ['/burrow-hq/settings?tab=connections', '/', '/a.b/c', '/x?next=/./y'])
      expect(ReturnPath.safeParse(ok).success).toBe(true);
    for (const bad of [
      '//evil.com',
      '/.//evil.com',
      '/a/..//evil.com',
      '/%2e//evil.com',
      '/%2E%2e/x',
      '/a\\b',
    ])
      expect(ReturnPath.safeParse(bad).success).toBe(false);
  });
});
