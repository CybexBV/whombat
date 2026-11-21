/**
 * The scripted Hermes behind the real `HermesProvider` (HE-33): the profile it reads, ACP, Whombat's MCP through the
 * stdio bridge to a stub server, sessions across processes (on the provider and model they began with, HN-07), Stop,
 * follow-ups and permission cards.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DispatchContext } from '@whombat/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TurnEvent, TurnInput, TurnSteer, TurnSteering } from '../../contract';
import { base } from '../../testing/contexts';
import { type StubMcpServer, startStubMcpServer } from '../../testing/stub-mcp-server';
import { HERMES_PIN } from '../pin';
import { HERMES_SESSION_PREFIX, HermesProvider } from '../provider';
import { CANNED_REPLY, scriptedHermesLauncher } from './index';
import { STORYLINE } from './scripted-story';

const NOW = 'It is Wednesday 23 Sep 2026, 11:22 in Europe/Amsterdam; times in messages are in that zone.';

let stub: StubMcpServer;
let dir: string;
let bin: string;
let provider: HermesProvider;

beforeAll(async () => {
  stub = await startStubMcpServer();
  dir = mkdtempSync(join(tmpdir(), 'wb-scripted-hermes-'));
  bin = await scriptedHermesLauncher(dir, { thinkMs: 20, tickMs: 5 });
  provider = new HermesProvider({
    kind: 'claude',
    bin,
    root: join(dir, 'root'),
    env: { ...process.env, WHOMBAT_CLAUDE_PATH: '/usr/bin/true' },
    settleMs: 0,
    killGraceMs: 300,
    cancelGraceMs: 2000,
  });
});

afterAll(async () => {
  await stub?.close();
});

function input(prompt: string, extra: Partial<TurnInput> = {}): TurnInput {
  return {
    context: DispatchContext.parse(base({ dispatch: { ...base().dispatch, trigger: 'dm' } })),
    prompt,
    mcp: { url: stub.url, token: stub.token },
    cwd: dir,
    sandbox: 'workspace-write',
    network: false,
    model: 'sonnet',
    ...extra,
  };
}

async function collect(
  turn: TurnInput,
  signal = new AbortController().signal,
  onEvent?: (e: TurnEvent) => void,
  on: HermesProvider = provider,
) {
  const events: TurnEvent[] = [];
  for await (const e of on.runTurn(turn, signal)) {
    events.push(e);
    onEvent?.(e);
  }
  return events;
}

const asked = (text: string) =>
  [
    NOW,
    'Conversation: Mara’s Chat with you (conversationId cnv_dm-dusty)',
    '',
    `[11:21] Mara: ${text} (id msg_1)`,
    '',
    'Mara is asking you in the message above (id msg_1).',
  ].join('\n');

const runPrompt = (activity: string) =>
  [
    NOW,
    'Conversation: #billing-v2 (conversationId cnv_billing-v2)',
    `Your run #1907 “Address review on PR #482” on feat/invoice-pdf is live: pick up where it stands.`,
    `Steps: ${STORYLINE.steps.map((s, i) => `${i}. ${s.title} (${i === 0 ? 'active' : 'queued'})`).join('; ')}`,
    `Latest: ${activity}`,
  ].join('\n');

const finals = (events: TurnEvent[]) =>
  events.filter((e) => e.type === 'final').map((e) => (e as { text: string }).text);
const sessionOf = (events: TurnEvent[]) =>
  (events.find((e) => e.type === 'session') as { sessionId: string } | undefined)?.sessionId;

describe('the scripted Hermes', () => {
  it('says it is the pinned release, as the runner’s check reads it', () => {
    expect(execFileSync(bin, ['--version'], { encoding: 'utf8' })).toContain(
      `Hermes Agent v${HERMES_PIN.version}`,
    );
  });

  it('thinks, then answers with the canned reply in a session of its own', async () => {
    const events = await collect(input(asked('Can you look at the PDF cache?')));
    expect(sessionOf(events)).toMatch(new RegExp(`^${HERMES_SESSION_PREFIX}local-[0-9a-f]{64}$`));
    expect(events.some((e) => e.type === 'thinking')).toBe(true);
    expect(finals(events)).toEqual([CANNED_REPLY]);
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
  });

  it('plays the storyline run through Whombat’s MCP tools, each call as Hermes reports it', async () => {
    const before = stub.calls.length;
    const events = await collect(input(runPrompt(STORYLINE.lines[5] as string)));
    const calls = stub.calls.slice(before);
    expect(calls.filter((c) => c.name === 'run_log').map((c) => c.arguments.lines)).toEqual([
      [STORYLINE.lines[6]],
      [STORYLINE.lines[7]],
    ]);
    expect(calls.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'run_tests',
        'run_step',
        'run_files',
        'post_message',
        'finish_run',
        'set_status',
      ]),
    );
    expect(calls.every((c) => c.authorization === `Bearer ${stub.token}`)).toBe(true);
    const toolCalls = events.filter((e) => e.type === 'tool_call') as Extract<
      TurnEvent,
      { type: 'tool_call' }
    >[];
    expect(toolCalls.length).toBe(calls.length);
    expect(toolCalls.every((e) => e.category === 'mcp' && /^tc-[0-9a-f]{12}$/.test(e.id ?? ''))).toBe(true);
    expect(toolCalls.find((e) => e.name === 'finish_run')?.input).toMatchObject({
      run: 1907,
      outcome: 'done',
    });
    const results = events.filter((e) => e.type === 'tool_result') as Extract<
      TurnEvent,
      { type: 'tool_result' }
    >[];
    expect(results.length).toBe(calls.length);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(finals(events)).toEqual(['']);
    // The first run through the MCP tools starts them cold: beside a whole suite on a busy machine that alone has
    // taken more than the default five seconds.
  }, 30_000);

  it('stops at Stop, and picks the run up again on the same session from where it stood', async () => {
    const before = stub.calls.length;
    const controller = new AbortController();
    const logs = () => stub.calls.slice(before).filter((c) => c.name === 'run_log');
    const first = await collect(
      input(runPrompt('Reading Joris’s review on PR #482')),
      controller.signal,
      (e) => {
        if (e.type === 'tool_result' && e.name === 'run_log' && logs().length === 2) controller.abort();
      },
    );
    expect(logs()).toHaveLength(2);
    expect(stub.calls.slice(before).some((c) => c.name === 'finish_run')).toBe(false);
    expect(finals(first)).toEqual([]);
    const session = sessionOf(first);

    const second = await collect(
      input(runPrompt(logs().at(-1)?.arguments.lines?.toString() ?? ''), { resumeSessionId: session }),
    );
    expect(sessionOf(second)).toBe(session);
    // No line played twice; every line played.
    const played = logs().map((c) => (c.arguments.lines as string[])[0]);
    expect(played).toEqual(STORYLINE.lines);
    expect(finals(second)).toEqual(['']);
  });

  it('answers a search question with its receipts', async () => {
    const before = stub.calls.length;
    await collect(
      input(
        [
          NOW,
          'Conversation: #general (conversationId cnv_general)',
          'Search question from Mara: “have we seen this rounding error?”',
          'Results you may cite (id · type · where · snippet):',
          '- r1 · THREAD · #incidents · rounded after formatting',
          '- r2 · PATCH · PR #311 · round VAT first',
          '- r3 · RUN · Run #1882 · three invoices a cent off after rounding',
          'Answer with post_answer (answerId ans_1): a short answer citing results inline as [1], [2] …',
        ].join('\n'),
      ),
    );
    const answer = stub.calls.slice(before).find((c) => c.name === 'post_answer');
    expect(answer?.arguments).toMatchObject({
      answerId: 'ans_1',
      citations: [
        { n: 1, resultId: 'r1' },
        { n: 2, resultId: 'r2' },
        { n: 3, resultId: 'r3' },
      ],
    });
  });

  it('takes a follow-up into the running turn (`/steer`)', async () => {
    const slow = new HermesProvider({
      kind: 'claude',
      bin: await scriptedHermesLauncher(mkdtempSync(join(dir, 'slow-')), { thinkMs: 600 }),
      root: join(dir, 'root'),
      env: { ...process.env, WHOMBAT_CLAUDE_PATH: '/usr/bin/true' },
      settleMs: 0,
    });
    let take: ((s: TurnSteer) => boolean) | null = null;
    const steering: TurnSteering = {
      open: (t) => {
        take = t;
      },
      close: () => {
        take = null;
      },
    };
    const events: TurnEvent[] = [];
    let handed = false;
    for await (const e of slow.runTurn(input(asked('Hello'), { steering }), new AbortController().signal)) {
      events.push(e);
      if (e.type === 'thinking' && take && !handed)
        handed = (take as (s: TurnSteer) => boolean)({ id: 'msg_2', prompt: 'and the logs too' });
    }
    expect(handed).toBe(true);
    expect(events).toContainEqual({ type: 'steered', id: 'msg_2' });
    expect(finals(events)).toEqual([CANNED_REPLY]);
  });

  it('asks before running a command, through Whombat’s permission policy', async () => {
    const allowed = await collect(input(asked('Please run `echo scripted-ok`')));
    expect(allowed).toContainEqual(expect.objectContaining({ type: 'permission', allowed: true }));
    expect(allowed).toContainEqual(expect.objectContaining({ type: 'tool_call', category: 'command' }));
    expect(finals(allowed)).toEqual(['scripted-ok']);
  });
});

describe('a resumed session runs on the turn’s provider and model (HN-07)', () => {
  const DIRECTSDK = 'claude-subscription-directsdk-experimental';
  /** The provider and model the scripted Hermes keeps with a session, as Hermes does. */
  const routeOf = (turn: TurnInput, session: string | undefined) =>
    JSON.parse(
      readFileSync(
        join(
          provider.profileOf(turn),
          'scripted-hermes',
          'sessions',
          `${(session ?? '').slice(HERMES_SESSION_PREFIX.length)}.json`,
        ),
        'utf8',
      ),
    ).route;

  it('keeps the session and moves it to the turn’s model first', async () => {
    const first = input(asked('Is the NAS still full?'));
    const session = sessionOf(await collect(first));
    expect(routeOf(first, session)).toEqual({ provider: DIRECTSDK, model: 'sonnet' });
    const next = await collect(input(asked('And now?'), { model: 'opus', resumeSessionId: session }));
    expect(sessionOf(next)).toBe(session);
    expect(finals(next)).toEqual([CANNED_REPLY]);
    expect(routeOf(first, session)).toEqual({ provider: DIRECTSDK, model: 'opus' });
  });

  it('never runs a turn in a session on another provider', async () => {
    const first = input(asked('Is the NAS still full?'));
    const session = sessionOf(await collect(first));
    const codex = new HermesProvider({
      kind: 'codex',
      bin,
      root: join(dir, 'root'),
      env: process.env,
      settleMs: 0,
      killGraceMs: 300,
    });
    const turn = input(asked('And now?'), { model: 'gpt-6.1-sol', resumeSessionId: session });
    // Only what is new in the prompt: the turn fails, and the server's retry starts afresh with the whole window.
    const refused = await collect(turn, undefined, undefined, codex);
    expect(refused.find((e) => e.type === 'error')).toMatchObject({ retryable: true });
    expect(finals(refused)).toEqual([]);
    // A prompt with the whole conversation: a new session on ChatGPT, the Claude one as it was.
    const fresh = await collect({ ...turn, freshIfSessionGone: true }, undefined, undefined, codex);
    expect(sessionOf(fresh)).not.toBe(session);
    expect(finals(fresh)).toEqual([CANNED_REPLY]);
    expect(routeOf(first, session)).toEqual({ provider: DIRECTSDK, model: 'sonnet' });
    expect(routeOf(first, sessionOf(fresh))).toEqual({ provider: 'openai-codex', model: 'gpt-6.1-sol' });
  });
});
