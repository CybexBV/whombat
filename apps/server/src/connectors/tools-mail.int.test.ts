/**
 * Connector tools over MCP with the fake Google (docs/decisions/connectors.md "Tools", PA-09, one-agent.md OA-10): who
 * may use them (a turn for the person whose account it is: tools/list, refusals with the fix), mail reads without
 * events, drafts and organizing with content-free events, and sending only after the person approved in their Chat.
 */
import { agentDefaultGrants, CONNECTOR_TOOL_NAMES, MAIL_SEND_BODY_CAP, newId } from '@whombat/core';
import { and, eq, gt } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueDispatchToken } from '../auth/agent-tokens';
import { decideApproval } from '../commands/approvals';
import { sendMessage } from '../commands/messages';
import { approvals, dispatches, events, grants, messages } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { makePng } from '../test/files';
import { useTestServer } from '../test/harness';
import { mcpClient, type TestMcp } from '../test/mcp';
import { minimalPdf } from '../test/pdf';
import { addPersonalAgent, FAKE_ACCESS_TOKEN, type PersonalSetup } from '../test/personal';
import { agentTokenFor, sessionFor } from '../test/tokens';
import { GoogleApiError } from './types';
import type { FakeGoogleWorkspace } from './workspace-fake';

/** A person's own guide tool (AG-01). */
const GUIDE_TOOLS = ['start_guide'];

const t = useTestServer({ seed: true, listen: true });
const clients: TestMcp[] = [];
let maraChat: PersonalSetup;
let fake: FakeGoogleWorkspace;

async function as(agentId: string, conversationId: string, options: { outside?: boolean } = {}) {
  const { token } = await agentTokenFor(
    t.services,
    t.burrowId,
    agentId,
    conversationId,
    options.outside ? { onBehalfOfAccountId: null } : {},
  );
  const mcp = await mcpClient(t.baseUrl, token);
  clients.push(mcp);
  return mcp;
}

const asMara = () => as(maraChat.agentId, maraChat.dmId);

/** Events signed since `seq` (the burrow's chain position before a call). */
async function eventsSince(seq: number) {
  return t.services.db
    .select()
    .from(events)
    .where(and(eq(events.burrowId, t.burrowId), gt(events.seq, seq)))
    .orderBy(events.seq);
}

async function headSeq(): Promise<number> {
  const rows = await t.services.db
    .select({ seq: events.seq })
    .from(events)
    .where(eq(events.burrowId, t.burrowId));
  return Math.max(0, ...rows.map((r) => r.seq));
}

async function approvalRow(id: string) {
  const [row] = await t.services.db.select().from(approvals).where(eq(approvals.id, id));
  if (!row) throw new Error('no approval');
  return row;
}

/** Nothing the person's account holds shows in an event: texts and payloads (PA-09). */
function expectNoContent(
  rows: { text: string | null; payload: unknown; where: string | null }[],
  words: string[],
) {
  for (const row of rows) {
    const blob = `${row.text ?? ''} ${row.where ?? ''} ${JSON.stringify(row.payload)}`;
    for (const w of words) expect(blob, `event “${row.text}” holds “${w}”`).not.toContain(w);
  }
}

beforeAll(async () => {
  // Dusty with the keys a new Whombat's agent holds, a person's account keys among them (one-agent.md OA-05); the
  // test world's Dusty holds the mock crew's.
  maraChat = await addPersonalAgent(t.services, t.burrowId, IDS.mara, {
    grants: agentDefaultGrants(IDS.dusty),
  });
  fake = t.services.google.workspace as FakeGoogleWorkspace;
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
});

describe('who can use the connector tools', () => {
  it('lists them only in the person’s turns, for the services they connected (OP-S51)', async () => {
    const nobody = (await (await as(IDS.dusty, IDS.billing, { outside: true })).client.listTools()).tools.map(
      (x) => x.name,
    );
    for (const name of CONNECTOR_TOOL_NAMES) expect(nobody).not.toContain(name);
    expect(nobody).toContain('reply_in_thread');

    const all = (await (await asMara()).client.listTools()).tools.map((x) => x.name);
    for (const name of CONNECTOR_TOOL_NAMES) expect(all).toContain(name);
    for (const name of GUIDE_TOOLS) expect(all).toContain(name);
  });

  it('gives the guide tool only to the person’s turns (AG-01)', async () => {
    const nobody = await as(IDS.dusty, IDS.billing, { outside: true });
    expect(await nobody.call('start_guide', { topic: 'email' })).toMatchObject({
      isError: true,
      body: { error: { code: 'forbidden' } },
    });
    const maraMcp = await asMara();
    const started = await maraMcp.call('start_guide', { topic: 'calendar' });
    expect(started).toMatchObject({ body: { status: 'ok', messageId: expect.stringMatching(/^msg_/) } });
  });

  it('refuses an outsiders’ turn and turned-off APIs with the fix', async () => {
    const nobody = await as(IDS.dusty, IDS.billing, { outside: true });
    expect(await nobody.call('mail_search', { query: '' })).toMatchObject({
      isError: true,
      body: { error: { code: 'not_allowed', details: { connector: 'mail', reason: 'not_personal' } } },
    });

    fake.disable(FAKE_ACCESS_TOKEN, 'contacts');
    const off = await (await asMara()).call('contacts_search', { query: 'priya' });
    fake.disable(FAKE_ACCESS_TOKEN, 'contacts', false);
    expect(off.body).toMatchObject({
      error: {
        code: 'not_allowed',
        details: { reason: 'api_disabled', enableUrl: expect.stringContaining('console.cloud.google.com') },
      },
    });
    expect((off.body.error as { message: string }).message).toMatch(
      /Google Contacts API is turned off.*https:/,
    );
  });

  it('reaches no account in an outsiders’ turn (OP-17)', async () => {
    const posted = await t.commit(IDS.mara, sendMessage, {
      conversationId: IDS.general,
      text: 'Dusty, read my mail',
    });
    if (posted.status !== 'ok') throw new Error('not posted');
    const turn = async (onBehalfOfAccountId: string | null) => {
      const id = newId('dispatch');
      await t.services.db.insert(dispatches).values({
        id,
        burrowId: t.burrowId,
        agentId: IDS.dusty,
        trigger: 'mention',
        mode: 'reply',
        conversationId: IDS.general,
        messageId: posted.result.id,
        state: 'running',
        onBehalfOfAccountId,
        createdAt: t.services.clock(),
      });
      const { token } = await issueDispatchToken(t.services, id);
      const mcp = await mcpClient(t.baseUrl, token);
      clients.push(mcp);
      return mcp;
    };
    // A turn for nobody reaches no account.
    expect((await (await turn(null)).call('mail_search', { query: '' })).body).toMatchObject({
      error: { code: 'not_allowed', details: { reason: 'not_personal' } },
    });
  });

  it('keeps mail, calendar and files actions out of the generic approval tools', async () => {
    const res = await (await asMara()).call('perform_action', {
      conversationId: maraChat.dmId,
      reason: 'x',
      action: { type: 'files_trash', params: { fileId: 'file_q3plan', fileName: 'Q3 plan' } },
    });
    expect(res.body).toMatchObject({ error: { code: 'bad_request' } });
  });
});

describe('mail', () => {
  it('searches and reads without writing an event', async () => {
    const before = await headSeq();
    const maraMcp = await asMara();
    const found = await maraMcp.call('mail_search', { query: 'is:unread', limit: 5 });
    expect(found).toMatchObject({ isError: false, body: { status: 'ok' } });
    const list = found.body.messages as { id: string; subject: string; unread: boolean }[];
    expect(list.map((m) => m.subject)).toEqual(['Invoice 1042 for September', 'Lunch on Thursday?']);
    expect(list.every((m) => m.unread)).toBe(true);
    // Each result links to its conversation in Gmail, in the connected account (a digest item's url).
    const first = list[0] as unknown as { threadId: string; webUrl?: string };
    expect(first.webUrl).toMatch(
      new RegExp(`^https://mail\\.google\\.com/mail/\\?authuser=[^#]+%40[^#]+#all/${first.threadId}$`),
    );

    const read = await maraMcp.call('mail_read', { messageId: 'msg_receipt' });
    const [receipt] = read.body.messages as { body: string; labels: string[] }[];
    expect(receipt?.body).toContain('Thank you for your payment');
    expect(receipt?.body).toContain('View your invoices (https://accounts.hetzner.example/invoices)');
    expect(receipt?.labels).toContain('Receipts');
    expect(await eventsSince(before)).toEqual([]);
  });

  it('opens an attachment: a PDF’s text, and a picture beside the answer', async () => {
    const before = await headSeq();
    const pdf = minimalPdf(['Hetzner Online', 'Invoice 1042', 'Amount due EUR 12.34']);
    const picture = makePng(12, 8);
    const message = fake.stateFor(FAKE_ACCESS_TOKEN).messages.find((m) => m.id === 'msg_receipt');
    if (!message) throw new Error('no receipt in the fake mailbox');
    message.attachments = [
      {
        id: 'att_pdf',
        name: 'invoice.pdf',
        mimeType: 'application/pdf',
        size: pdf.length,
        contentBase64: pdf.toString('base64'),
      },
      {
        id: 'att_png',
        name: 'qr.png',
        mimeType: 'image/png',
        size: picture.length,
        contentBase64: picture.toString('base64'),
      },
    ];
    const maraMcp = await asMara();
    const read = await maraMcp.call('mail_attachment_open', {
      messageId: 'msg_receipt',
      attachmentId: 'att_pdf',
    });
    expect(read).toMatchObject({
      isError: false,
      body: { status: 'ok', attachment: { shows: 'text', pages: 1 } },
    });
    expect((read.body.attachment as { text: string }).text).toContain('Amount due EUR 12.34');
    const shown = await maraMcp.client.callTool({
      name: 'mail_attachment_open',
      arguments: { messageId: 'msg_receipt', attachmentId: 'att_png' },
    });
    expect(shown.structuredContent).toMatchObject({
      status: 'ok',
      attachment: { shows: 'picture', text: null },
    });
    expect(shown.content).toContainEqual({
      type: 'image',
      data: picture.toString('base64'),
      mimeType: 'image/png',
    });
    // The picture goes as image content only, not again inside the answer's text.
    expect(JSON.stringify(shown.structuredContent)).not.toContain(picture.toString('base64'));
    expect(await eventsSince(before)).toEqual([]);
  });

  it('drafts and organizes with content-free events', async () => {
    const before = await headSeq();
    const maraMcp = await asMara();
    const drafted = await maraMcp.call('mail_draft', {
      to: ['joris@example.org'],
      subject: '',
      body: 'Thursday at 12:30 works for me.',
      replyToMessageId: 'msg_lunch',
    });
    expect(drafted.body).toMatchObject({ status: 'ok', draftId: expect.any(String) });
    const draft = fake.stateFor(FAKE_ACCESS_TOKEN).drafts.find((d) => d.id === drafted.body.draftId);
    expect(draft).toMatchObject({ threadId: 'thr_lunch', subject: 'Re: Lunch on Thursday?' });

    const organized = await maraMcp.call('mail_organize', {
      messageIds: ['msg_newsletter'],
      addLabels: ['Later'],
      archive: true,
      read: true,
    });
    expect(organized.body).toMatchObject({ status: 'ok', updated: 1 });
    const letter = fake.stateFor(FAKE_ACCESS_TOKEN).messages.find((m) => m.id === 'msg_newsletter');
    expect(letter?.labelIds).not.toContain('INBOX');
    const later = fake.stateFor(FAKE_ACCESS_TOKEN).labels.find((l) => l.name === 'Later');
    expect(letter?.labelIds).toContain(later?.id);

    // Trash and Spam delete mail, which always asks: mail_organize refuses them (IN-15).
    const labelsBefore = [...(letter?.labelIds ?? [])];
    for (const labels of [{ addLabels: ['TRASH'] }, { addLabels: ['spam'] }, { removeLabels: ['Trash'] }]) {
      const refused = await maraMcp.call('mail_organize', { messageIds: ['msg_newsletter'], ...labels });
      expect(refused.isError).toBe(true);
    }
    expect(
      fake.stateFor(FAKE_ACCESS_TOKEN).messages.find((m) => m.id === 'msg_newsletter')?.labelIds,
    ).toEqual(labelsBefore);

    const rows = await eventsSince(before);
    expect(rows.map((r) => [r.type, r.kind, r.text, r.where, r.actorId])).toEqual([
      ['mail.drafted', 'Messages', 'Drafted an email', 'Gmail', maraChat.agentId],
      ['mail.organized', 'Messages', 'Organized 1 email', 'Gmail', maraChat.agentId],
    ]);
    expect(rows[0]?.keyUsed).toEqual({ id: 'mail.draft', label: 'Draft emails' });
    expectNoContent(rows, ['joris', 'Thursday', 'Lunch', 'newsletter', 'Later']);
  });

  it('calls Google after the commit: another write goes ahead while Google answers', async () => {
    const maraMcp = await asMara();
    const draft = fake.mailDraft.bind(fake);
    let otherWrite: 'done' | 'waited' | null = null;
    fake.mailDraft = async (token, input) => {
      // The burrow's write lock is free: a write of its own gets it at once (it would wait the whole call before).
      const deadline = new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 2000));
      otherWrite = await Promise.race([
        t.services.pipeline.transact(t.burrowId, async () => 'done' as const).then((r) => r.result),
        deadline,
      ]);
      return draft(token, input);
    };
    try {
      const drafted = await maraMcp.call('mail_draft', {
        to: ['joris@example.org'],
        subject: 'Hi',
        body: 'Hello.',
      });
      expect(drafted.body).toMatchObject({ status: 'ok', draftId: expect.any(String) });
      expect(otherWrite).toBe('done');
    } finally {
      fake.mailDraft = draft;
    }
  });

  it('sends only after the person approves in their DM, and the log names nobody', async () => {
    const before = await headSeq();
    const maraMcp = await asMara();
    const asked = await maraMcp.call('mail_send', {
      to: ['priya@northwind.example'],
      bcc: ['boss@northwind.example'],
      subject: 'Invoice 1042',
      body: 'Hi Priya, paid today. Thanks!',
    });
    expect(asked.body).toMatchObject({
      status: 'pending_approval',
      message: 'Mara has to approve this first. It goes ahead once they say yes.',
    });
    const approval = await approvalRow(asked.body.approvalId as string);
    expect(approval).toMatchObject({
      requesterId: maraChat.agentId,
      keyId: 'mail.send',
      conversationId: maraChat.dmId,
      state: 'pending',
      title: 'Send an email to priya@northwind.example',
      target: 'Gmail · you@example.com',
      command: null,
    });
    expect(approval.whatHappens[1]).toBe('Message: “Hi Priya, paid today. Thanks!”');
    expect(approval.whatHappens[0]).toBe(
      'Send “Invoice 1042” from you@example.com to priya@northwind.example, bcc boss@northwind.example',
    );
    expect(approval.conditions.find((c) => c.kind === 'person_approves')).toMatchObject({
      approverIds: [IDS.mara],
    });
    const [card] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, approval.messageId as string));
    expect(card).toMatchObject({ conversationId: maraChat.dmId, authorId: maraChat.agentId });
    // Nothing is sent before the person says yes.
    expect(fake.stateFor(FAKE_ACCESS_TOKEN).messages.some((m) => m.subject === 'Invoice 1042')).toBe(false);

    // The person sees it.
    const get = async (principalId: string) => {
      const { cookie } = await sessionFor(t.services, principalId);
      return t.api.inject({
        url: `/api/v1/burrows/burrow-hq/approvals/${approval.number}`,
        headers: { cookie },
      });
    };
    expect((await get(IDS.mara)).statusCode).toBe(200);
    const list = async (principalId: string) => {
      const { cookie } = await sessionFor(t.services, principalId);
      const res = await t.api.inject({ url: '/api/v1/burrows/burrow-hq/approvals', headers: { cookie } });
      return (res.json() as { approvals: { number: number }[] }).approvals.map((a) => a.number);
    };
    expect(await list(IDS.mara)).toContain(approval.number);

    const decided = await t.commit(IDS.mara, decideApproval, {
      number: approval.number,
      decision: 'approve',
    });
    expect(decided.status).toBe('ok');

    const sent = fake.stateFor(FAKE_ACCESS_TOKEN).messages.find((m) => m.subject === 'Invoice 1042');
    expect(sent).toMatchObject({
      to: ['priya@northwind.example'],
      bcc: ['boss@northwind.example'],
      labelIds: ['SENT'],
    });
    expect((await approvalRow(approval.id)).execution.state).toBe('succeeded');

    const rows = await eventsSince(before);
    const texts = rows.filter((r) => r.text).map((r) => r.text);
    expect(texts).toEqual([
      'Asked to send an email',
      'Approved Dusty’s request to send an email',
      'Sent an email',
    ]);
    const ask = rows.find((r) => r.type === 'approval.requested');
    expect(ask).toMatchObject({ kind: 'Asks', where: 'Gmail', payload: { action: { type: 'mail_send' } } });
    expectNoContent(rows, ['priya', 'boss', 'Invoice', 'paid today']);
  });

  it('sends an existing draft; a draft changed after approval is not sent', async () => {
    const maraMcp = await asMara();
    const drafted = await maraMcp.call('mail_draft', {
      to: ['joris@example.org'],
      subject: 'Plan',
      body: 'See the plan.',
    });
    const asked = await maraMcp.call('mail_send', { draftId: drafted.body.draftId });
    expect(asked.body.status).toBe('pending_approval');
    const approval = await approvalRow(asked.body.approvalId as string);
    expect(approval.action).toMatchObject({
      type: 'mail_send',
      params: {
        draftId: drafted.body.draftId,
        to: ['joris@example.org'],
        subject: 'Plan',
        bodyPreview: 'See the plan.',
      },
    });
    // Someone edits the draft in Gmail before the person approves.
    const draft = fake.stateFor(FAKE_ACCESS_TOKEN).drafts.find((d) => d.id === drafted.body.draftId);
    if (draft) draft.to = ['someone@else.example'];
    const before = await headSeq();
    await t.commit(IDS.mara, decideApproval, { number: approval.number, decision: 'approve' });
    expect((await approvalRow(approval.id)).execution).toMatchObject({
      state: 'failed',
      error: 'The draft changed after it was approved. Ask again.',
    });
    expect(fake.stateFor(FAKE_ACCESS_TOKEN).messages.some((m) => m.subject === 'Plan')).toBe(false);
    const failed = (await eventsSince(before)).find((r) => r.type === 'approval.failed');
    expect(failed?.text).toBe('Couldn’t send an email: The draft changed after it was approved. Ask again.');
  });

  it('refuses changed attachment bytes even when the filename and size are unchanged', async () => {
    const mcp = await asMara();
    const drafted = await mcp.call('mail_draft', {
      to: ['joris@example.org'],
      subject: 'Attachment integrity',
      body: 'See attached.',
      attachments: [
        {
          name: 'invoice.txt',
          mimeType: 'text/plain',
          contentBase64: Buffer.from('100 EUR').toString('base64'),
        },
      ],
    });
    const asked = await mcp.call('mail_send', { draftId: drafted.body.draftId });
    const approval = await approvalRow(asked.body.approvalId as string);
    const draft = fake.stateFor(FAKE_ACCESS_TOKEN).drafts.find((d) => d.id === drafted.body.draftId);
    expect(draft?.attachments?.length).toBe(1);
    if (draft?.attachments?.[0])
      draft.attachments[0].contentBase64 = Buffer.from('900 EUR').toString('base64');
    await t.commit(IDS.mara, decideApproval, { number: approval.number, decision: 'approve' });
    expect((await approvalRow(approval.id)).execution).toMatchObject({
      state: 'failed',
      error: 'The draft changed after it was approved. Ask again.',
    });
    expect(fake.stateFor(FAKE_ACCESS_TOKEN).messages.some((m) => m.subject === 'Attachment integrity')).toBe(
      false,
    );
  });

  it('shows the whole body and sends only that body; a longer one than a card holds is refused (IN-16)', async () => {
    const maraMcp = await asMara();
    const body = `${'Harmless first paragraph. '.repeat(60)}\n\nAnd the part after character 1000.`;
    const asked = await maraMcp.call('mail_send', { to: ['joris@example.org'], subject: 'Long', body });
    expect(asked.body.status).toBe('pending_approval');
    const approval = await approvalRow(asked.body.approvalId as string);
    expect(approval.action).toMatchObject({ type: 'mail_send', params: { body } });
    // Only the tail changes in Gmail after the card went out: the executor refuses it.
    const draftId = (approval.action as { params: { draftId: string } }).params.draftId;
    const draft = fake.stateFor(FAKE_ACCESS_TOKEN).drafts.find((d) => d.id === draftId);
    if (draft) draft.body = `${body} Plus something nobody approved.`;
    await t.commit(IDS.mara, decideApproval, { number: approval.number, decision: 'approve' });
    expect((await approvalRow(approval.id)).execution).toMatchObject({
      state: 'failed',
      error: 'The draft changed after it was approved. Ask again.',
    });
    expect(fake.stateFor(FAKE_ACCESS_TOKEN).messages.some((m) => m.subject === 'Long')).toBe(false);

    const tooLong = await maraMcp.call('mail_send', {
      to: ['joris@example.org'],
      subject: 'Too long',
      body: 'x'.repeat(MAIL_SEND_BODY_CAP + 1),
    });
    expect(tooLong.isError).toBe(true);
    expect(JSON.stringify(tooLong.body)).toContain('too long to approve in one card');
    // Refused before anything is written to the mailbox.
    expect(fake.stateFor(FAKE_ACCESS_TOKEN).drafts.some((d) => d.subject === 'Too long')).toBe(false);
  });

  it('a declined send is not sent and the log says only that', async () => {
    const maraMcp = await asMara();
    const asked = await maraMcp.call('mail_send', { to: ['tom@example.com'], subject: 'Secret', body: 'x' });
    const approval = await approvalRow(asked.body.approvalId as string);
    const before = await headSeq();
    await t.commit(IDS.mara, decideApproval, { number: approval.number, decision: 'decline' });
    expect(fake.stateFor(FAKE_ACCESS_TOKEN).messages.some((m) => m.subject === 'Secret')).toBe(false);
    const rows = await eventsSince(before);
    expect(rows.find((r) => r.type === 'approval.declined')?.text).toBe(
      'Declined Dusty’s request to send an email',
    );
    expectNoContent(rows, ['tom@', 'Secret']);
  });

  it('follows the keys: blocked without the key, a read set to ask is refused, a write set to ask waits', async () => {
    const setTier = (keyId: string, tier: 'can' | 'ask' | null) =>
      tier
        ? t.services.db
            .update(grants)
            .set({ tier })
            .where(and(eq(grants.agentId, maraChat.agentId), eq(grants.keyId, keyId)))
        : t.services.db
            .delete(grants)
            .where(and(eq(grants.agentId, maraChat.agentId), eq(grants.keyId, keyId)));
    const maraMcp = await asMara();

    await setTier('mail.send', null);
    const blocked = await maraMcp.call('mail_send', { to: ['a@b.com'], subject: 'Hi', body: 'x' });
    expect(blocked.body).toMatchObject({ status: 'blocked', keyNeeded: { id: 'mail.send' } });
    const [event] = await t.services.db
      .select()
      .from(events)
      .where(eq(events.id, blocked.body.eventId as string));
    expect(event).toMatchObject({
      kind: 'Blocked',
      text: 'Tried to send an email. Blocked.',
      where: 'Gmail',
    });

    await setTier('mail.read', 'ask');
    const before = await headSeq();
    expect((await maraMcp.call('mail_search', { query: '' })).body).toMatchObject({
      error: {
        code: 'not_allowed',
        message:
          'Mara set “Read mail” to ask first, and reading can’t wait for a yes. Ask Mara to change it in your keys.',
      },
    });
    expect(await eventsSince(before)).toEqual([]);
    await setTier('mail.read', 'can');

    await setTier('mail.draft', 'ask');
    const waiting = await maraMcp.call('mail_draft', { to: ['a@b.com'], subject: 'Later', body: 'x' });
    expect(waiting.body.status).toBe('pending_approval');
    const approval = await approvalRow(waiting.body.approvalId as string);
    expect(approval).toMatchObject({ conversationId: maraChat.dmId, title: 'Draft an email' });
    expect(approval.conditions.find((c) => c.kind === 'person_approves')).toMatchObject({
      approverIds: [IDS.mara],
    });
    const count = fake.stateFor(FAKE_ACCESS_TOKEN).drafts.length;
    await t.commit(IDS.mara, decideApproval, { number: approval.number, decision: 'approve' });
    expect(fake.stateFor(FAKE_ACCESS_TOKEN).drafts).toHaveLength(count + 1);
    expect((await approvalRow(approval.id)).execution.state).toBe('succeeded');
    const ask = await t.services.db
      .select()
      .from(events)
      .where(eq(events.id, waiting.body.eventId as string));
    expect(ask[0]?.text).toBe('Asked to draft an email');
    expect(JSON.stringify(ask[0]?.payload)).not.toContain('Later');

    // The approved re-run fails at Google: the approval keeps Google's words, the log only a reason (IN-21).
    const failing = await maraMcp.call('mail_draft', { to: ['a@b.com'], subject: 'Salaries', body: 'x' });
    const failingApproval = await approvalRow(failing.body.approvalId as string);
    expect(failingApproval.action).toMatchObject({ type: 'custom', params: { name: 'draft an email' } });
    const draft = fake.mailDraft;
    fake.mailDraft = async () => {
      throw new GoogleApiError(400, 'Invalid label "Salaries 2026 – Mara"', 'other');
    };
    const beforeFailure = await headSeq();
    try {
      await t.commit(IDS.mara, decideApproval, { number: failingApproval.number, decision: 'approve' });
    } finally {
      fake.mailDraft = draft;
    }
    const failed = await approvalRow(failingApproval.id);
    expect(failed.execution).toMatchObject({ state: 'failed' });
    expect(failed.execution.error).toContain('Salaries 2026');
    const logged = await eventsSince(beforeFailure);
    expect(logged.find((r) => r.type === 'approval.failed')?.text).toBe(
      'Couldn’t draft an email: Gmail answered with an error (HTTP 400).',
    );
    expectNoContent(logged, ['Salaries', 'connector.']);
    await setTier('mail.draft', 'can');
  });

  it('moves mail to the trash: asks first naming the emails, and goes ahead once the person allows it', async () => {
    const maraMcp = await asMara();
    const message = (id: string) => fake.stateFor(FAKE_ACCESS_TOKEN).messages.find((m) => m.id === id);
    const labels = (id: string) => [...(message(id)?.labelIds ?? [])];
    const kept = { msg_newsletter: labels('msg_newsletter'), msg_receipt: labels('msg_receipt') };
    try {
      const asked = await maraMcp.call('mail_trash', { messageIds: ['msg_newsletter'] });
      expect(asked.body.status).toBe('pending_approval');
      const approval = await approvalRow(asked.body.approvalId as string);
      expect(approval.conversationId).toBe(maraChat.dmId);
      expect(approval.whatHappens.join(' ')).toContain('Five small tools');
      expect(labels('msg_newsletter')).not.toContain('TRASH');
      await t.commit(IDS.mara, decideApproval, { number: approval.number, decision: 'approve' });
      expect(labels('msg_newsletter')).toContain('TRASH');

      // Allowed: it goes ahead, and the log says only how many.
      await t.services.db
        .update(grants)
        .set({ tier: 'can' })
        .where(and(eq(grants.agentId, maraChat.agentId), eq(grants.keyId, 'mail.delete')));
      const before = await headSeq();
      const done = await maraMcp.call('mail_trash', { messageIds: ['msg_receipt'] });
      expect(done.body).toMatchObject({ status: 'ok', trashed: 1 });
      expect(labels('msg_receipt')).toContain('TRASH');
      const rows = await eventsSince(before);
      expect(rows.map((r) => [r.type, r.where])).toEqual([['mail.trashed', 'Gmail']]);
      expect(rows[0]?.keyUsed?.id).toBe('mail.delete');
    } finally {
      await t.services.db
        .update(grants)
        .set({ tier: 'ask' })
        .where(and(eq(grants.agentId, maraChat.agentId), eq(grants.keyId, 'mail.delete')));
      for (const [id, was] of Object.entries(kept)) {
        const m = message(id);
        if (m) m.labelIds = was;
      }
    }
  });
});
