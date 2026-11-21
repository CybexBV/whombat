/**
 * Provider subscriptions on a managed appliance (docs/decisions/provider-subscriptions.md SUB-04, SUB-20…; contracts
 * 0.9.0 CT-69…CT-71): the agent on each requester's own sign-in, the person behind every dispatch, the sign-ins as
 * `signins.*` api ops over the session (with the native `providers.*` names still answering), and the Claude sign-in
 * console end to end with a fake Claude Code.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CredentialMeta,
  ensureCredentialHome,
  writeCredentialMeta,
} from '@whombat/agent-runtime/providers';
import type { DispatchContext } from '@whombat/core/contracts';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { updateAgent } from '../../commands/agents';
import { sendMessage } from '../../commands/messages';
import { dispatches, principals } from '../../db/schema/index';
import { IDS, TEST_BURROW_ID } from '../../seed/test-world';
import { useManagedRuntime } from '../../test/managed';
import type { RequestAnswer } from '../dispatcher';
import { RequestControl } from '../dispatcher';
import type { SessionPrincipal } from '../trust';
import { dispatchCredential } from './credential-owner';
import { providerLogins } from './service';

const root = mkdtempSync(join(tmpdir(), 'wb-subscriptions-'));
const FAKES = fileURLToPath(
  new URL('../../../../../packages/agent-runtime/src/providers/testing/', import.meta.url),
);
const m = useManagedRuntime({
  seed: true,
  env: { WHOMBAT_CREDENTIALS_ROOT: root, WHOMBAT_SIGNIN_EXECUTOR: 'local' },
});
const accounts: Record<string, string> = {};
let mara: SessionPrincipal;

async function signIn(provider: 'codex' | 'claude', authMode = 'api_key') {
  const home = await ensureCredentialHome(root, provider);
  const meta: CredentialMeta = {
    v: 1,
    provider,
    authMode,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    verified: 'valid',
    verifiedAt: null,
    creatorAttested: false,
    login: null,
    signal: null,
  };
  await writeCredentialMeta(home, meta);
}

const commit = (actor: string, command: Parameters<typeof m.t.services.pipeline.commit>[0], input: unknown) =>
  m.t.services.pipeline.commit(command, input, { burrowId: TEST_BURROW_ID, actorId: actor });

async function run(
  principal: SessionPrincipal,
  id: string,
  op: string,
  input: unknown,
): Promise<RequestAnswer> {
  let answer: RequestAnswer | null = null;
  await m.runtime.dispatcher.handle(
    principal,
    { id, op, input },
    { accepted: () => {}, result: (a) => (answer = a) },
    new RequestControl(null),
  );
  return answer as unknown as RequestAnswer;
}

const output = <T = Record<string, unknown>>(a: RequestAnswer): T => {
  if (a.type !== 'result') throw new Error(`not a result: ${JSON.stringify(a)}`);
  return a.output as T;
};

let agentId = '';

beforeAll(async () => {
  providerLogins(m.t.services, {
    commands: { gh: join(FAKES, 'fake-gh.mjs') },
    claude: join(FAKES, 'fake-claude.mjs'),
    fetch: async () => ({ status: 200 }),
    drift: async () => null,
  });
  const [row] = await m.t.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
  accounts.mara = row?.accountId as string;
  const a = await m.enroll(IDS.mara);
  mara = await m.runtime.trust.identify(a.peerId, a.publicKey);
  // The agent on Codex (one-agent.md OA-01: no one to hire).
  const moved = await commit(IDS.mara, updateAgent, { runtime: { provider: 'codex' } });
  if (moved.status !== 'ok') throw new Error(`update: ${moved.status}`);
  agentId = IDS.dusty;
  await signIn('codex');
});

const queued = async (agentId: string) =>
  m.t.services.db
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.agentId, agentId), eq(dispatches.state, 'queued')));

const ctxOf = (row: typeof dispatches.$inferSelect, authorId: string | null) =>
  ({
    dispatch: { id: row.id, agentId: row.agentId, trigger: row.trigger },
    agent: { runtime: { provider: 'codex' } },
    burrow: { id: TEST_BURROW_ID },
    trigger: authorId ? { authorId } : null,
  }) as unknown as DispatchContext;

describe('the person’s sign-in (one-person.md OP-S09)', () => {
  it('records the person who asked', async () => {
    await commit(IDS.mara, sendMessage, {
      conversationId: IDS.general,
      text: '@Dusty can you look at the VAT?',
    });
    const rows = await queued(agentId);
    expect(rows.map((r) => r.onBehalfOfAccountId)).toEqual([accounts.mara]);
    const forMara = rows.find((r) => r.onBehalfOfAccountId === accounts.mara);
    const credential = await dispatchCredential(m.t.services, ctxOf(forMara as never, IDS.mara));
    expect(credential).toEqual({ v: 1, provider: 'codex', authMode: 'api_key' });
    await m.t.services.db.delete(dispatches).where(eq(dispatches.agentId, agentId));
  });

  it('work for nobody runs on the person’s sign-in too', async () => {
    const [row] = await m.t.services.db
      .insert(dispatches)
      .values({
        id: 'dsp_nobody',
        burrowId: TEST_BURROW_ID,
        agentId: agentId,
        trigger: 'feedback',
        mode: 'reply',
        conversationId: IDS.general,
        state: 'queued',
        onBehalfOfAccountId: null,
        createdAt: new Date(),
      })
      .returning();
    expect(await dispatchCredential(m.t.services, ctxOf(row as never, null))).toEqual({
      v: 1,
      provider: 'codex',
      authMode: 'api_key',
    });
    await m.t.services.db.delete(dispatches).where(eq(dispatches.id, 'dsp_nobody'));
  });
});

describe('signins.* over the session (CT-70)', () => {
  it('lists the caller’s sign-ins, consoles and the modes they may start', async () => {
    const api = output<{
      signIns: unknown[];
      consoles: unknown[];
      modes: { provider: string; authMode: string; available: boolean }[];
    }>(await run(mara, 'r-list-1', 'signins.list', { params: {}, query: {} }));
    expect(api.consoles).toEqual([]);
    expect(api.modes.find((x) => x.provider === 'codex' && x.authMode === 'chatgpt')?.available).toBe(true);
    expect(
      api.modes.find((x) => x.provider === 'claude' && x.authMode === 'subscription_cli')?.available,
    ).toBe(true);
  });
});

describe('the Claude sign-in console (CT-71)', () => {
  const read = async (principal: SessionPrincipal, consoleId: string, cursor: number, n: number) =>
    output<{
      console: { state: string; inputSeq: number };
      from: number;
      data: string;
      next: number;
      more: boolean;
    }>(
      await run(principal, `r-read-${consoleId}-${n}`, 'signins.consoleRead', {
        params: { consoleId },
        query: { cursor, waitMs: 5_000 },
      }),
    );

  async function until(
    principal: SessionPrincipal,
    consoleId: string,
    pred: (text: string, state: string) => boolean,
  ) {
    let cursor = 0;
    let text = '';
    for (let n = 0; n < 40; n++) {
      const r = await read(principal, consoleId, cursor, n);
      text += Buffer.from(r.data, 'base64').toString('utf8');
      cursor = r.next;
      if (pred(text, r.console.state)) return { text, state: r.console.state, cursor };
    }
    throw new Error(`console never got there: ${JSON.stringify(text)}`);
  }

  it('runs Claude Code’s own sign-in; keystrokes once per seq; completes only on the CLI’s own status', async () => {
    const started = output<{ consoleId: string; state: string; expiresAt: string }>(
      await run(mara, 'r-console-1', 'signins.consoleStart', {
        params: {},
        query: {},
        body: { provider: 'claude', authMode: 'subscription_cli', cols: 100, rows: 30 },
      }),
    );
    expect(started.state).toBe('running');
    const id = started.consoleId;
    await until(mara, id, (text) => /code/i.test(text));
    // A gap is refused with the last applied seq.
    expect(
      await run(mara, 'r-w-gap', 'signins.consoleWrite', {
        params: { consoleId: id },
        query: {},
        body: { seq: 3, data: 'x' },
      }),
    ).toMatchObject({ type: 'error', details: { code: 'provider.console_input_gap', inputSeq: 0 } });
    const typed = output<{ inputSeq: number }>(
      await run(mara, 'r-w-1', 'signins.consoleWrite', {
        params: { consoleId: id },
        query: {},
        body: { seq: 1, data: 'good\r' },
      }),
    );
    expect(typed.inputSeq).toBe(1);
    // A resend of seq 1 (a lost answer) is answered without typing again.
    expect(
      output<{ inputSeq: number }>(
        await run(mara, 'r-w-1b', 'signins.consoleWrite', {
          params: { consoleId: id },
          query: {},
          body: { seq: 1, data: 'good\r' },
        }),
      ).inputSeq,
    ).toBe(1);
    const done = await until(mara, id, (_t, state) => state !== 'running');
    expect(done.state).toBe('completed');
    const list = output<{
      signIns: { provider: string; authMode: string }[];
      consoles: { consoleId: string; state: string }[];
    }>(await run(mara, 'r-list-after', 'signins.list', { params: {}, query: {} }));
    expect(list.signIns).toContainEqual(
      expect.objectContaining({ provider: 'claude', authMode: 'subscription_cli' }),
    );
    expect(list.consoles).toContainEqual(expect.objectContaining({ consoleId: id, state: 'completed' }));
    // The sign-in is audited, without anything typed.
    // The sign-in is audited (right after the exit report), without anything typed.
    let claude: { payload: unknown } | undefined;
    for (let n = 0; n < 40 && !claude; n++) {
      const events = await m.t.services
        .sql`select type, payload from appliance_events where type = 'provider.signed_in'`;
      claude = events.find((e) => (e.payload as { authMode?: string }).authMode === 'subscription_cli') as
        | { payload: unknown }
        | undefined;
      if (!claude) await new Promise((r) => setTimeout(r, 50));
    }
    expect(claude).toBeTruthy();
    expect(JSON.stringify(claude)).not.toContain('good');
  });

  it('a sign-in the CLI doesn’t confirm fails; a second console takes over the first', async () => {
    const first = output<{ consoleId: string }>(
      await run(mara, 'r-c2-1', 'signins.consoleStart', {
        params: {},
        query: {},
        body: { provider: 'claude', authMode: 'subscription_cli', cols: 80, rows: 24 },
      }),
    );
    const second = output<{ consoleId: string }>(
      await run(mara, 'r-c2-2', 'signins.consoleStart', {
        params: {},
        query: {},
        body: { provider: 'claude', authMode: 'subscription_cli', cols: 80, rows: 24 },
      }),
    );
    expect((await read(mara, first.consoleId, 0, 99)).console.state).toBe('cancelled');
    await until(mara, second.consoleId, (text) => /code/i.test(text));
    await run(mara, 'r-c2-w', 'signins.consoleWrite', {
      params: { consoleId: second.consoleId },
      query: {},
      body: { seq: 1, data: 'nosignin\r' },
    });
    const done = await until(mara, second.consoleId, (_t, state) => state !== 'running');
    expect(done.state).toBe('failed');
    const list = output<{ consoles: { consoleId: string; error: { code: string } | null }[] }>(
      await run(mara, 'r-c2-list', 'signins.list', { params: {}, query: {} }),
    );
    expect(list.consoles.find((c) => c.consoleId === second.consoleId)?.error?.code).toBe(
      'provider.login_missing',
    );
  });
});
