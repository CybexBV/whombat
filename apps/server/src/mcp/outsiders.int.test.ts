/**
 * Outsiders' turns are deny by default (docs/decisions/outsiders-turns.md): each kind is served only the allowlist, a
 * tool it isn't served is refused when called by name (as in every turn), and the tools it has keep to its own thread —
 * its room is the person's Chat, whose other threads, top level and Files are the person's. Postgres: the refusals are
 * decided from the dispatch, message and attachment rows a real turn has.
 */
import { ASSESSOR_TOOLS } from '@whombat/agent-runtime/feedback';
import { MCP_TOOL_NAMES } from '@whombat/core';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentAuth } from '../auth/agent-tokens';
import { sendMessage } from '../commands/messages';
import { dispatches, messages } from '../db/schema/index';
import { buildDispatchContext } from '../runtime/context';
import { IDS } from '../seed/test-world';
import { upload } from '../test/files';
import { useTestServer } from '../test/harness';
import { agentTokenFor, sessionFor, type TestDispatchOptions } from '../test/tokens';
import { OUTSIDERS_TOOLS } from './served';
import { callTool, mcpToolList } from './server';

const t = useTestServer({ seed: true });
const CHAT = IDS.dmDusty;
const SECRET = 'wombatOTSECRET';

let root = '';
let ownReply = '';
let otherRoot = '';
let reportFile = '';
let chatFile = '';

async function post(text: string, extra: { threadRootId?: string; attachmentIds?: string[] } = {}) {
  const res = await t.commit(IDS.mara, sendMessage, { conversationId: CHAT, text, ...extra });
  if (res.status !== 'ok') throw new Error(`not posted: ${res.status}`);
  return res.result.id;
}

beforeAll(async () => {
  const mara = { cookie: (await sessionFor(t.services, IDS.mara)).cookie };
  // The person's own things in their Chat: a file on a top-level message (in the Chat's Files too), another thread.
  chatFile = (await upload(t.api, mara, CHAT, 'payroll.txt', Buffer.from(`salaries ${SECRET}`))).id;
  await post(`Payroll for October ${SECRET}`, { attachmentIds: [chatFile] });
  otherRoot = await post('Plan the holiday');
  await post(`The flights ${SECRET}`, { threadRootId: otherRoot });
  // The outsiders' turn's own thread: its request, with the customer's file, and a reply in it.
  reportFile = (await upload(t.api, mara, CHAT, 'report.txt', Buffer.from('Export drops the last row'))).id;
  root = await post('@Dusty Assess it: Acme #5 “Exports lose the last row”', {
    attachmentIds: [reportFile],
  });
  ownReply = await post('More from the customer: it happens on every export.', { threadRootId: root });
});

/** A live turn in the person's Chat, in the request's thread unless said otherwise. */
async function turn(options: TestDispatchOptions = {}): Promise<AgentAuth> {
  const { dispatchId } = await agentTokenFor(t.services, t.burrowId, IDS.dusty, CHAT, {
    trigger: 'automation',
    messageId: root,
    threadRootId: root,
    ...options,
  });
  return { dispatchId, agentId: IDS.dusty, burrowId: t.burrowId };
}

const outsiders = () => turn({ onBehalfOfAccountId: null });

async function call(auth: AgentAuth, name: string, args: Record<string, unknown>) {
  const res = await callTool(t.services, auth, name, args);
  return {
    isError: res.isError === true,
    body: (res.structuredContent ?? {}) as { status?: string; error?: { code: string; message: string } },
  };
}

const served = async (auth: AgentAuth) =>
  (await mcpToolList(t.services, auth.agentId, auth.dispatchId)).map((tool) => tool.name);

/** Messages in the Chat outside the outsiders' turn's thread. */
async function elsewhere(): Promise<number> {
  const [row] = await t.services.db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, CHAT),
        ne(messages.id, root),
        or(isNull(messages.threadRootId), ne(messages.threadRootId, root)),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Calls every contract tool the turn isn't served, by name and without arguments: each is refused before its input is
 * even read, so nothing runs.
 */
async function walkUnserved(auth: AgentAuth, list: readonly string[]) {
  for (const name of MCP_TOOL_NAMES) {
    if (list.includes(name)) continue;
    const res = await call(auth, name, {});
    expect([name, res.isError], name).toEqual([name, true]);
    expect(['forbidden', 'not_allowed'], name).toContain(res.body.error?.code);
  }
}

describe('what each kind of outsiders’ turn is served (OT-01)', () => {
  it('an automation step of a customer’s report: the allowlist’s base, nothing else, and nothing else runs', async () => {
    const auth = await outsiders();
    const list = await served(auth);
    for (const name of list) expect(OUTSIDERS_TOOLS as readonly string[], name).toContain(name);
    expect([...list].sort()).toEqual(
      ['completion_evidence', 'read_attachment', 'read_conversation', 'reply_in_thread'].sort(),
    );
    const before = await elsewhere();
    await walkUnserved(auth, list);
    expect(await elsewhere()).toBe(before);
    // What it hears says why, without the person's things.
    const schedule = await call(auth, 'schedule', { action: 'list' });
    expect(schedule.body.error?.message).toContain('from outside');
    expect(JSON.stringify(schedule.body)).not.toContain(SECRET);
    // The person's mail stays out with its own words.
    expect((await call(auth, 'mail_search', { query: '' })).body.error?.code).toBe('not_allowed');
  });

  it('a Feedback assessment: its own tools only', async () => {
    const auth = await turn({ trigger: 'feedback', onBehalfOfAccountId: null });
    const list = await served(auth);
    expect([...list].sort()).toEqual([...ASSESSOR_TOOLS].sort());
    await walkUnserved(auth, list);
  });

  it('the person’s turn still has its tools, and a tool it isn’t served is refused too (OT-07)', async () => {
    const mine = await turn({ trigger: 'dm' });
    const list = await served(mine);
    expect(list).toEqual(expect.arrayContaining(['post_message', 'schedule', 'search']));
    for (const name of ['post_answer', 'run_step', 'finish_run', 'submit_assessment']) {
      expect(list).not.toContain(name);
      expect((await call(mine, name, {})).body.error?.code, name).toBe('forbidden');
    }
    expect((await call(mine, 'report_assessment', {})).body.error?.message).toContain('report_assessment');
  });
});

describe('an outsiders’ turn keeps to its own thread (OT-04)', () => {
  it('reads its thread, not the Chat’s top level, another thread or another room', async () => {
    const auth = await outsiders();
    const own = await call(auth, 'read_conversation', {
      conversationId: CHAT,
      threadRootId: root,
      limit: 20,
    });
    expect(own.body.status).toBe('ok');
    expect(JSON.stringify(own.body)).toContain('every export');
    for (const args of [
      { conversationId: CHAT, limit: 50 },
      { conversationId: CHAT, threadRootId: otherRoot, limit: 50 },
      { conversationId: IDS.billing, limit: 50 },
    ]) {
      const res = await call(auth, 'read_conversation', args);
      expect([args, res.body.error?.code]).toEqual([args, 'forbidden']);
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
      // The refusal says where it may read instead.
      expect(res.body.error?.message).toContain(root);
    }
  });

  it('replies in its thread only, in words', async () => {
    const auth = await outsiders();
    const before = await elsewhere();
    expect((await call(auth, 'reply_in_thread', { messageId: root, text: 'Looking.' })).body.status).toBe(
      'ok',
    );
    expect((await call(auth, 'reply_in_thread', { messageId: ownReply, text: 'On it.' })).body.status).toBe(
      'ok',
    );
    for (const args of [
      { messageId: otherRoot, text: 'Injected.' },
      { messageId: root, text: 'Here.', attachmentIds: [chatFile] },
    ]) {
      const res = await call(auth, 'reply_in_thread', args);
      expect([args.messageId, res.body.error?.code]).toEqual([args.messageId, 'forbidden']);
    }
    expect(await elsewhere()).toBe(before);
  });

  it('reads the files of its request and thread, never the Chat’s other files (OT-05)', async () => {
    const auth = await outsiders();
    const report = await call(auth, 'read_attachment', { attachmentId: reportFile });
    expect(report.body.status).toBe('ok');
    const payroll = await call(auth, 'read_attachment', { attachmentId: chatFile });
    expect(payroll.body.error?.code).toBe('not_found');
    expect(JSON.stringify(payroll.body)).not.toContain(SECRET);
    // The person's turn in the same place reads both.
    const mine = await turn({ trigger: 'dm' });
    expect((await call(mine, 'read_attachment', { attachmentId: chatFile })).body.status).toBe('ok');
  });

  it('gets neither the Chat’s Files nor the files of its window in its context', async () => {
    const contextOf = async (auth: AgentAuth) => {
      const [row] = await t.services.db.select().from(dispatches).where(eq(dispatches.id, auth.dispatchId));
      if (!row) throw new Error('no dispatch');
      return buildDispatchContext(t.services, row);
    };
    const outside = await contextOf(await outsiders());
    expect(outside.files).toBeNull();
    expect(outside.attachments.map((a) => a.id)).toEqual([reportFile]);
    const mine = await contextOf(await turn({ trigger: 'dm', threadRootId: null, messageId: null }));
    expect(mine.files?.entries.map((f) => f.id)).toContain(chatFile);
  });

  it('works nowhere when it has neither a thread nor a request', async () => {
    const lost = await turn({ onBehalfOfAccountId: null, messageId: null, threadRootId: null });
    expect((await call(lost, 'read_conversation', { conversationId: CHAT, limit: 5 })).body.error?.code).toBe(
      'forbidden',
    );
    expect((await call(lost, 'reply_in_thread', { messageId: root, text: 'x' })).body.error?.code).toBe(
      'forbidden',
    );
  });
});
