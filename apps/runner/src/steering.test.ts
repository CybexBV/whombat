/**
 * Follow-ups into a running turn on the runner (docs/decisions/steering.md SX-03, SX-04, SX-06): what the server
 * offers with a beat's answer is prepared, rendered and handed to the provider once; the next beat reports the queued
 * dispatch once every message offered for it was delivered (and a last beat before `complete` when needed); a turn
 * that answered before it took a follow-up posts that answer first.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentProvider,
  BASIC_CAPABILITIES,
  type TurnEvent,
  type TurnInput,
  type TurnSteer,
  type WhombatMcp,
} from '@whombat/agent-runtime';
import type { DispatchContext, Message, TurnInjection } from '@whombat/core';
import { mara } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import type { FetchedAttachment, RunnerApi } from './api';
import type { ProviderRegistry } from './registry';
import { followUpPrompt, followUpsFor, TurnFollowUps, takesFollowUps } from './steering';
import { testContext } from './test-context';
import { testPolicy } from './test-sandbox';
import { runDispatch, type TurnDeps } from './turn';

const STEERING = { ...BASIC_CAPABILITIES, images: true, steering: true };

function message(id: string, text: string, extra: Partial<Message> = {}): Message {
  const base = testContext().trigger as Message;
  return {
    ...base,
    id,
    authorId: mara.id,
    text,
    mentions: [],
    reactions: [],
    createdAt: '2026-09-23T09:30:00.000Z',
    attachments: [],
    ...extra,
  };
}

function injection(
  dispatchId: string,
  m: Message,
  attachments: TurnInjection['attachments'] = [],
): TurnInjection {
  return { dispatchId, messageId: m.id, message: m, attachments };
}

/** A runner API whose beats answer `offers` in turn (then nothing more), recording every beat. */
class FakeApi implements RunnerApi {
  beats: Record<string, unknown>[] = [];
  completed: Record<string, unknown>[] = [];
  /** What each beat answers, by beat number (1-based); absent: no follow-ups. */
  answers = new Map<number, { inject?: TurnInjection[]; cancel?: boolean }>();
  /** Answer `inject` on every beat from `from` on (as the server repeats it until it hears back). */
  offerFrom: { from: number; inject: TurnInjection[]; until?: () => boolean } | null = null;
  async claim() {
    return null;
  }
  async progress(_id: string, body: Record<string, unknown>) {
    this.beats.push(body);
    const n = this.beats.length;
    const answer = this.answers.get(n);
    if (answer?.cancel) return { cancel: true, reason: 'cancelled' as const };
    const repeated =
      this.offerFrom && n >= this.offerFrom.from && !(this.offerFrom.until?.() ?? false)
        ? this.offerFrom.inject
        : undefined;
    const inject = answer?.inject ?? repeated;
    return { cancel: false, reason: null, ...(inject ? { inject } : {}) };
  }
  async complete(_id: string, body: Record<string, unknown>) {
    this.completed.push(body);
  }
  async heartbeat() {
    return { cancel: [] };
  }
  async gitCredentials(): Promise<never> {
    throw new Error('no git');
  }
  async fetchAttachment(_d: string, attachmentId: string): Promise<FetchedAttachment> {
    const bytes = Buffer.from(`bytes of ${attachmentId}`);
    return {
      body: (async function* () {
        yield bytes;
      })(),
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
}

class FakeMcp implements WhombatMcp {
  calls: { name: string; args: unknown }[] = [];
  async call(name: string, args: unknown) {
    this.calls.push({ name, args });
    return { ok: true, isError: false, body: { status: 'ok' } };
  }
  async close() {}
}

function deps(api: FakeApi, p: AgentProvider, mcp = new FakeMcp()): TurnDeps & { mcp: FakeMcp } {
  const registry: ProviderRegistry = {
    claims: () => ['claude'],
    for: () => p,
    report: () => [],
    // The scripted Hermes (HE-46): turns the server sent without a sign-in run on no one's.
    hermesScripted: () => true,
  };
  return {
    api,
    registry,
    serverUrl: 'http://whombat.test',
    workspacesRoot: mkdtempSync(join(tmpdir(), 'wb-steer-ws-')),
    managed: testPolicy(),
    log: () => {},
    progressMs: 5,
    connectMcp: async () => mcp,
    mcp,
  };
}

/**
 * A provider that can steer: it opens `input.steering`, plays `before`, waits for `wait` follow-ups (each a `steered`
 * as it arrives), then plays `after`. `refuse`: it answers false to every follow-up.
 */
function steeringProvider(opts: {
  before: TurnEvent[];
  wait?: number;
  after: TurnEvent[];
  refuse?: boolean;
}) {
  const seen = { steers: [] as TurnSteer[], input: null as TurnInput | null };
  const p: AgentProvider = {
    kind: 'claude',
    available: async () => ({ ok: true, version: 'test' }),
    capabilities: () => STEERING,
    async *runTurn(input, signal) {
      seen.input = input;
      const arrived: TurnSteer[] = [];
      let wake = () => {};
      input.steering?.open((steer) => {
        if (opts.refuse) return false;
        arrived.push(steer);
        seen.steers.push(steer);
        wake();
        return true;
      });
      try {
        for (const e of opts.before) yield e;
        for (let i = 0; i < (opts.wait ?? 0); i++) {
          while (!arrived.length) {
            if (signal.aborted) return;
            await new Promise<void>((r) => {
              wake = r;
              setTimeout(r, 20);
            });
          }
          const steer = arrived.shift() as TurnSteer;
          yield { type: 'steered', id: steer.id };
        }
        for (const e of opts.after) yield e;
      } finally {
        input.steering?.close();
      }
    },
  };
  return { p, seen };
}

describe('followUpPrompt (SX-08)', () => {
  it('names who added what, with its files, and says it belongs to this turn', () => {
    const ctx = testContext();
    const m = message('msg_f1', 'also the credit notes', {
      mentions: [ctx.agent.id],
      attachments: [
        {
          id: 'att_1',
          name: 'notes.txt',
          contentType: 'text/plain',
          size: 12,
          kind: 'text',
          url: '/api/v1/burrows/burrow-hq/attachments/att_1',
          width: null,
          height: null,
        },
      ],
    });
    expect(followUpPrompt(ctx, m)).toBe(
      [
        'Mara added this while you were working (message msg_f1): also the credit notes [file: notes.txt (text/plain, 12 bytes) · att_1]',
        'It is part of what you are doing now: take it into account, and answer it in this turn together with the rest.',
      ].join('\n'),
    );
  });

  it('says when it didn’t name the agent, outside a DM only (RT-05)', () => {
    const ctx = testContext();
    expect(followUpPrompt(ctx, message('msg_f2', 'and the rest?'))).toContain('They didn’t name you');
    const dm = testContext({ conversation: { ...ctx.conversation, kind: 'dm' } });
    expect(followUpPrompt(dm, message('msg_f3', 'and the rest?'))).not.toContain('They didn’t name you');
  });

  it('takes follow-ups only into a person’s chat or run turn', () => {
    const ctx = testContext();
    expect(takesFollowUps(ctx)).toBe(true);
    expect(
      takesFollowUps({ ...ctx, dispatch: { ...ctx.dispatch, mode: 'run', trigger: 'run_control' } }),
    ).toBe(true);
    for (const trigger of ['feedback', 'search', 'expand', 'automation'] as const)
      expect(takesFollowUps({ ...ctx, dispatch: { ...ctx.dispatch, trigger } })).toBe(false);
    expect(takesFollowUps({ ...ctx, dispatch: { ...ctx.dispatch, mode: 'answer' } })).toBe(false);
    expect(
      followUpsFor(ctx, BASIC_CAPABILITIES, { deps: {} as never, signal: new AbortController().signal }),
    ).toBe(null);
  });
});

describe('TurnFollowUps (SX-04)', () => {
  const make = (api = new FakeApi()) =>
    new TurnFollowUps({
      ctx: testContext(),
      deps: { api, workspacesRoot: mkdtempSync(join(tmpdir(), 'wb-steer-ws-')), log: () => {} },
      caps: STEERING,
      signal: new AbortController().signal,
    });

  it('hands each message once, in order, also those ready before the provider opened', async () => {
    const f = make();
    const a = message('msg_a', 'first');
    const b = message('msg_b', 'second');
    f.offer([injection('dsp_q', a)]);
    await f.settled();
    const taken: string[] = [];
    f.open((s) => {
      taken.push(s.id);
      return true;
    });
    f.offer([injection('dsp_q', a), injection('dsp_q', b)]);
    f.offer([injection('dsp_q', a), injection('dsp_q', b)]);
    await f.settled();
    expect(taken).toEqual(['msg_a', 'msg_b']);
    // Reported only once every message the latest offer names for it was delivered.
    expect(f.steered('msg_a')).toBe(true);
    expect(f.injected()).toEqual([]);
    expect(f.steered('msg_b')).toBe(true);
    expect(f.injected()).toEqual(['dsp_q']);
    // A third message the server adds later holds the report back until it is delivered too.
    const c = message('msg_c', 'third');
    f.offer([injection('dsp_q', a), injection('dsp_q', b), injection('dsp_q', c)]);
    await f.settled();
    expect(f.injected()).toEqual([]);
    f.steered('msg_c');
    expect(f.injected()).toEqual(['dsp_q']);
    // Merged: the server no longer offers it, and nothing is reported.
    f.offer([]);
    expect(f.injected()).toEqual([]);
  });

  it('a refused or late follow-up is never reported; nor a steered id it didn’t hand out', async () => {
    const f = make();
    f.open(() => false);
    f.offer([injection('dsp_q', message('msg_r', 'refused'))]);
    await f.settled();
    expect(f.steered('msg_r')).toBe(false);
    expect(f.steered('msg_other')).toBe(false);
    expect(f.injected()).toEqual([]);
    const closed = make();
    closed.close();
    closed.offer([injection('dsp_q', message('msg_late', 'too late'))]);
    await closed.settled();
    expect(closed.injected()).toEqual([]);
  });

  it('fetches a follow-up’s files as a trigger’s: images as input, the attachments section in the prompt', async () => {
    const f = make();
    const steers: TurnSteer[] = [];
    f.open((s) => {
      steers.push(s);
      return true;
    });
    const ctx = testContext();
    const bytes = Buffer.from('bytes of att_img');
    const m = message('msg_img', 'this screenshot', { mentions: [ctx.agent.id] });
    f.offer([
      injection('dsp_q', m, [
        {
          id: 'att_img',
          name: 'shot.png',
          contentType: 'image/png',
          size: bytes.length,
          kind: 'image',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          messageId: 'msg_img',
          conversationId: ctx.conversation.id,
          width: 10,
          height: 10,
        },
      ]),
    ]);
    await f.settled();
    expect(steers).toHaveLength(1);
    expect(steers[0]?.attachments).toEqual([
      expect.objectContaining({ id: 'att_img', kind: 'image', mediaType: 'image/png' }),
    ]);
    expect(steers[0]?.prompt).toContain('Attachments on these messages');
    expect(steers[0]?.prompt).toContain('att_img · shot.png (image/png');
    await f.release();
  });
});

describe('runDispatch with follow-ups (SX-03, SX-06)', () => {
  it('delivers what a beat offers, reports it on the next beat and again before complete; one reply', async () => {
    const api = new FakeApi();
    const follow = message('msg_follow', 'also the credit notes');
    api.offerFrom = { from: 2, inject: [injection('dsp_q', follow)], until: () => reported(api).length > 0 };
    const { p, seen } = steeringProvider({
      before: [{ type: 'thinking' }],
      wait: 1,
      after: [{ type: 'final', text: 'Both are fixed.' }],
    });
    const d = deps(api, p);
    const out = await runDispatch(testContext(), d, new AbortController().signal);
    expect(out.outcome).toBe('done');
    expect(seen.steers.map((s) => s.id)).toEqual(['msg_follow']);
    expect(seen.steers[0]?.prompt).toContain('Mara added this while you were working (message msg_follow)');
    expect(reported(api)).toContainEqual(['dsp_q']);
    // One reply: the final text that answered both.
    expect(d.mcp.calls).toEqual([
      {
        name: 'post_message',
        args: { conversationId: testContext().conversation.id, text: 'Both are fixed.' },
      },
    ]);
    expect(api.completed).toHaveLength(1);
  });

  it('inject, then the answer: the answer before the follow-up is posted first, then the follow-up’s own', async () => {
    const api = new FakeApi();
    const follow = message('msg_follow', 'and the refunds?');
    api.offerFrom = { from: 2, inject: [injection('dsp_q', follow)] };
    const { p } = steeringProvider({
      before: [{ type: 'final', text: 'Credit notes fixed.' }],
      wait: 1,
      after: [{ type: 'thinking' }, { type: 'final', text: 'Refunds too.' }],
    });
    const d = deps(api, p);
    await runDispatch(testContext(), d, new AbortController().signal);
    expect(d.mcp.calls.map((c) => (c.args as { text: string }).text)).toEqual([
      'Credit notes fixed.',
      'Refunds too.',
    ]);
    // The last word before complete carries it: the server merges the queued turn.
    const last = api.beats.at(-1);
    expect(last?.injected).toEqual(['dsp_q']);
    // Thinking again while the follow-up is worked on.
    const afterSteer = api.beats.findIndex((b) => Array.isArray(b.injected));
    expect(api.beats[afterSteer]?.thinking).toBe(true);
  });

  it('an agent that posted its answer itself: nothing posted twice, the follow-up’s answer still goes out', async () => {
    const api = new FakeApi();
    api.offerFrom = { from: 2, inject: [injection('dsp_q', message('msg_follow', 'and the refunds?'))] };
    const { p } = steeringProvider({
      before: [{ type: 'tool_call', name: 'post_message', input: { text: 'Credit notes fixed.' } }],
      wait: 1,
      after: [{ type: 'final', text: 'Refunds too.' }],
    });
    const d = deps(api, p);
    await runDispatch(testContext(), d, new AbortController().signal);
    expect(d.mcp.calls.map((c) => (c.args as { text: string }).text)).toEqual(['Refunds too.']);
  });

  it('the answer, then inject: the provider refuses it, nothing is reported (it runs as its own turn)', async () => {
    const api = new FakeApi();
    api.offerFrom = { from: 1, inject: [injection('dsp_q', message('msg_late', 'one more thing'))] };
    const { p, seen } = steeringProvider({
      before: [{ type: 'final', text: 'Done.' }],
      after: [],
      refuse: true,
    });
    await runDispatch(testContext(), deps(api, p), new AbortController().signal);
    expect(seen.steers).toEqual([]);
    expect(reported(api)).toEqual([]);
  });

  it('cancel with the offer: nothing is handed over or reported', async () => {
    const api = new FakeApi();
    api.answers.set(2, { inject: [injection('dsp_q', message('msg_follow', 'and this'))], cancel: true });
    const { p, seen } = steeringProvider({ before: [{ type: 'thinking' }], wait: 1, after: [] });
    const out = await runDispatch(testContext(), deps(api, p), new AbortController().signal);
    expect(out.outcome).toBe('cancelled');
    expect(seen.steers).toEqual([]);
    expect(reported(api)).toEqual([]);
  });

  it('two follow-ups of two queued turns: each reported once its message is in', async () => {
    const api = new FakeApi();
    api.offerFrom = {
      from: 2,
      inject: [
        injection('dsp_q1', message('msg_1', 'first')),
        injection('dsp_q2', message('msg_2', 'second')),
      ],
    };
    const { p, seen } = steeringProvider({
      before: [{ type: 'thinking' }],
      wait: 2,
      after: [{ type: 'final', text: 'All three.' }],
    });
    await runDispatch(testContext(), deps(api, p), new AbortController().signal);
    expect(seen.steers.map((s) => s.id)).toEqual(['msg_1', 'msg_2']);
    expect(reported(api).at(-1)).toEqual(['dsp_q1', 'dsp_q2']);
  });

  it('a provider that can’t steer gets no steering, and nothing is reported', async () => {
    const api = new FakeApi();
    api.offerFrom = { from: 1, inject: [injection('dsp_q', message('msg_follow', 'and this'))] };
    let given: unknown = 'unset';
    const p: AgentProvider = {
      kind: 'claude',
      available: async () => ({ ok: true, version: 'test' }),
      capabilities: () => BASIC_CAPABILITIES,
      async *runTurn(input) {
        given = input.steering;
        yield { type: 'final', text: 'Done.' };
      },
    };
    await runDispatch(testContext(), deps(api, p), new AbortController().signal);
    expect(given).toBeUndefined();
    expect(reported(api)).toEqual([]);
  });

  it('no follow-ups for an assessment', async () => {
    const ctx = testContext();
    const c: DispatchContext = { ...ctx, dispatch: { ...ctx.dispatch, trigger: 'feedback' } };
    expect(takesFollowUps(c)).toBe(false);
  });
});

/** The `injected` lists the beats carried. */
function reported(api: FakeApi): unknown[] {
  return api.beats.filter((b) => Array.isArray(b.injected)).map((b) => b.injected);
}
