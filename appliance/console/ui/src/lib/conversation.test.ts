import { describe, expect, it } from 'vitest';
import { conversation, sessionSig, WORKING_KEY } from './conversation';
import type { DeskSession, DeskSessionMessage, DeskTalk } from './desk';
import { DESK, DESK_WORDS, fill } from './deskCopy';
import { TALK_READY, type TalkUi } from './talk';

const msg = (
  id: string,
  from: 'you' | 'assistant',
  p: Partial<DeskSessionMessage> = {},
): DeskSessionMessage => ({
  id,
  from,
  at: '2026-10-20T12:30:00Z',
  paragraphs: [`${from} ${id}`],
  more: false,
  ask: null,
  talk: null,
  audio: false,
  thing: null,
  ...p,
});
const open = (messages: DeskSessionMessage[]): DeskSession => ({
  open: true,
  messages,
  earlier: 0,
  until: '2026-10-20T13:00:00Z',
});
const talk = (id: string, p: Partial<DeskTalk> = {}): DeskTalk => ({
  id,
  state: 'answered',
  question: 'Is pve-02 okay?',
  answer: 'Yes, it is fine.',
  thing: null,
  audio: true,
  reason: null,
  ...p,
});
const keys = (c: ReturnType<typeof conversation>) =>
  c.rows.map((r) => `${r.from}:${r.tone}:${r.paragraphs[0]}`);

describe('Talk as a conversation (DK-63, CG-196)', () => {
  it('shows the conversation, then nothing more once the page’s talk is in it', () => {
    const s = open([
      msg('msg_q0000001', 'you', { talk: 'dtk_00000001' }),
      msg('msg_a0000001', 'assistant', { talk: 'dtk_00000001', audio: true }),
    ]);
    const done: TalkUi = { phase: 'done', id: 'dtk_00000001', typed: null };
    const c = conversation(s, done, talk('dtk_00000001'), 'Neo', true);
    expect(keys(c)).toEqual(['you:text:you msg_q0000001', 'assistant:text:assistant msg_a0000001']);
    expect(c.rows[1]?.replay).toBe('dtk_00000001');
    expect(c.open).toBe(true);
  });

  it('adds the question the page sent and Thinking… until Whombat has them', () => {
    const s = open([msg('msg_q0000001', 'you')]);
    const waiting: TalkUi = { phase: 'waiting', id: 'dtk_00000002', typed: 'Is blackbox okay?' };
    const c = conversation(
      s,
      waiting,
      talk('dtk_00000002', { state: 'thinking', question: undefined as never }),
      'Neo',
      true,
    );
    expect(keys(c)).toEqual([
      'you:text:you msg_q0000001',
      'you:text:Is blackbox okay?',
      `assistant:thinking:${DESK_WORDS.thinking}`,
    ]);
    // The question in the conversation: only Thinking… stays after it.
    const s2 = open([msg('msg_q0000002', 'you', { talk: 'dtk_00000002' })]);
    expect(keys(conversation(s2, waiting, null, 'Neo', true))).toEqual([
      'you:text:you msg_q0000002',
      `assistant:thinking:${DESK_WORDS.thinking}`,
    ]);
  });

  it('shows an answer Whombat hasn’t put in the conversation yet, with its server and sound', () => {
    const done: TalkUi = { phase: 'done', id: 'dtk_00000003', typed: null };
    const thing = {
      name: 'pve-02',
      mark: 'proxmox',
      state: 'ok' as const,
      note: '',
      cpu: null,
      memory: null,
      temp: null,
    };
    const c = conversation(open([]), done, talk('dtk_00000003', { thing }), 'Neo', true);
    expect(keys(c)).toEqual(['you:text:Is pve-02 okay?', 'assistant:text:Yes, it is fine.']);
    expect(c.rows[1]?.thing).toEqual(thing);
    expect(c.rows[1]?.replay).toBe('dtk_00000003');
  });

  it('drops a failed talk’s line once the assistant said something after the question', () => {
    const failed: TalkUi = { phase: 'done', id: 'dtk_00000004', typed: 'Restart Plex' };
    const slow = talk('dtk_00000004', { state: 'failed', answer: undefined as never, reason: 'slow' });
    const asked = msg('msg_q0000004', 'you', { talk: 'dtk_00000004' });
    expect(keys(conversation(open([asked]), failed, slow, 'Neo', true)).at(-1)).toContain('assistant:error');
    const late = msg('msg_a0000004', 'assistant');
    expect(keys(conversation(open([asked, late]), failed, slow, 'Neo', true))).toEqual([
      'you:text:you msg_q0000004',
      'assistant:text:assistant msg_a0000004',
    ]);
  });

  it('opens an empty conversation with the opening line, and only an empty one', () => {
    expect(keys(conversation(open([]), TALK_READY, null, 'Neo', true))).toEqual([
      `assistant:prompt:${DESK.talkPrompt}`,
    ]);
    expect(keys(conversation(null, TALK_READY, null, 'Neo', false))).toEqual([
      `assistant:error:${DESK_WORDS.voiceUnavailable}`,
    ]);
    expect(keys(conversation(open([msg('msg_q0000001', 'you')]), TALK_READY, null, 'Neo', true))).toEqual([
      'you:text:you msg_q0000001',
    ]);
  });

  it('shows nothing of a closed one, and the earlier messages’ count of an open one', () => {
    const closed: DeskSession = {
      open: false,
      messages: [msg('msg_q0000001', 'you')],
      earlier: 3,
      until: null,
    };
    const c = conversation(closed, TALK_READY, null, 'Neo', true);
    expect(c.open).toBe(false);
    expect(c.earlier).toBe(0);
    expect(keys(c)).toEqual([`assistant:prompt:${DESK.talkPrompt}`]);
    expect(
      conversation({ ...open([msg('msg_q0000001', 'you')]), earlier: 6 }, TALK_READY, null, 'Neo', true)
        .earlier,
    ).toBe(6);
  });
});

describe('work in the conversation (0.116, TF-16, TF-17, CG-284, CG-285)', () => {
  const at = (m: number) => new Date(Date.parse('2026-10-20T12:30:00Z') + m * 60_000).toISOString();
  const working = { since: at(0), doing: 'Installing updates on Home Assistant' };

  it('says a talk past 90 s is working, in the talk’s place, and the answer replaces it', () => {
    const waiting: TalkUi = { phase: 'waiting', id: 'dtk_00000010', typed: 'Update Home Assistant' };
    const asked = msg('msg_q0000010', 'you', { talk: 'dtk_00000010' });
    const w = talk('dtk_00000010', { state: 'working', answer: undefined as never });
    expect(keys(conversation(open([asked]), waiting, w, 'Neo', true))).toEqual([
      'you:text:you msg_q0000010',
      `assistant:thinking:${fill(DESK_WORDS.working, { assistant: 'Neo' })}`,
    ]);
    const done: TalkUi = { ...waiting, phase: 'done' };
    const answer = msg('msg_a0000010', 'assistant', { talk: 'dtk_00000010' });
    expect(keys(conversation(open([asked, answer]), done, talk('dtk_00000010'), 'Neo', true))).toEqual([
      'you:text:you msg_q0000010',
      'assistant:text:assistant msg_a0000010',
    ]);
  });

  it('has one working row at the bottom: what the assistant does, else the talk’s line, else working', () => {
    const asked = msg('msg_q0000011', 'you', { talk: 'dtk_00000011' });
    const waiting: TalkUi = { phase: 'waiting', id: 'dtk_00000011', typed: null };
    const thinking = talk('dtk_00000011', { state: 'thinking', answer: undefined as never });
    const c = conversation({ ...open([asked]), working }, waiting, thinking, 'Neo', true);
    expect(c.rows.map((r) => r.key)).toEqual([asked.id, WORKING_KEY]);
    expect(c.rows.at(-1)?.paragraphs[0]).toContain('Installing updates on Home Assistant');
    expect(c.rows.at(-1)?.paragraphs[0]).toContain('Neo');
    expect(c.rows.at(-1)?.tone).toBe('thinking');
    const bare = { since: at(0), doing: null };
    expect(
      keys(conversation({ ...open([asked]), working: bare }, waiting, thinking, 'Neo', true)).at(-1),
    ).toBe(`assistant:thinking:${DESK_WORDS.thinking}`);
    // Nothing of the page's own: the runtime's words.
    expect(keys(conversation({ ...open([asked]), working: bare }, TALK_READY, null, 'Neo', true))).toEqual([
      'you:text:you msg_q0000011',
      `assistant:thinking:${fill(DESK_WORDS.working, { assistant: 'Neo' })}`,
    ]);
    // A slow talk's line gives way to it; another failure stays.
    const done: TalkUi = { ...waiting, phase: 'done' };
    const slow = talk('dtk_00000011', { state: 'failed', answer: undefined as never, reason: 'slow' });
    expect(
      conversation({ ...open([asked]), working }, done, slow, 'Neo', true).rows.map((r) => r.key),
    ).toEqual([asked.id, WORKING_KEY]);
    const failed = talk('dtk_00000011', { state: 'failed', answer: undefined as never, reason: 'failed' });
    expect(conversation({ ...open([asked]), working }, done, failed, 'Neo', true).rows).toHaveLength(3);
  });

  it('drops a follow talk’s line once the assistant says something newer', () => {
    const decided = Date.parse(at(1));
    const follow: TalkUi = { phase: 'done', id: 'dtk_00000012', typed: null, since: decided };
    const slow = talk('dtk_00000012', {
      state: 'failed',
      question: undefined as never,
      answer: undefined as never,
      reason: 'slow',
    });
    const before = msg('msg_a0000012', 'assistant', { at: at(0.5) });
    expect(keys(conversation(open([before]), follow, slow, 'Neo', true)).at(-1)).toContain('assistant:error');
    const newer = msg('msg_a0000013', 'assistant', { at: at(4) });
    expect(keys(conversation(open([before, newer]), follow, slow, 'Neo', true))).toEqual([
      'assistant:text:assistant msg_a0000012',
      'assistant:text:assistant msg_a0000013',
    ]);
    // …and its working line too.
    const followWaiting: TalkUi = { ...follow, phase: 'waiting' };
    const w = talk('dtk_00000012', {
      state: 'working',
      question: undefined as never,
      answer: undefined as never,
    });
    expect(conversation(open([before]), followWaiting, w, 'Neo', true).rows).toHaveLength(2);
    expect(conversation(open([before, newer]), followWaiting, w, 'Neo', true).rows).toHaveLength(2);
  });

  it('keeps a task’s card on its row', () => {
    const task = {
      title: 'Installing 23 updates on Home Assistant',
      state: 'running' as const,
      startedAt: at(0),
      endedAt: null,
      result: null,
    };
    const c = conversation(open([msg('msg_t0000014', 'assistant', { task })]), TALK_READY, null, 'Neo', true);
    expect(c.rows[0]?.task).toEqual(task);
    expect(
      conversation(open([msg('msg_a0000014', 'assistant')]), TALK_READY, null, 'Neo', true).rows[0]?.task,
    ).toBe(null);
  });
});

describe('what counts as something happening in the conversation (TF-18, CG-287)', () => {
  const base = open([msg('msg_q0000020', 'you'), msg('msg_a0000020', 'assistant')]);
  const task = {
    title: 'Installing updates',
    state: 'running' as const,
    startedAt: '2026-10-20T12:30:00Z',
    endedAt: null,
    result: null,
  };
  it('is a new message, new words, an ask’s or a task’s state, and the working row', () => {
    const sig = sessionSig(base);
    expect(sessionSig({ ...base, until: '2026-10-20T13:05:00Z' })).toBe(sig);
    expect(sessionSig(open([...base.messages, msg('msg_a0000021', 'assistant')]))).not.toBe(sig);
    expect(
      sessionSig(
        open([
          base.messages[0] as DeskSessionMessage,
          msg('msg_a0000020', 'assistant', { paragraphs: ['x'] }),
        ]),
      ),
    ).not.toBe(sig);
    expect(sessionSig({ ...base, working: { since: '2026-10-20T12:30:00Z', doing: null } })).not.toBe(sig);
    const running = open([msg('msg_t0000020', 'assistant', { task })]);
    const ended = open([
      msg('msg_t0000020', 'assistant', { task: { ...task, state: 'ok', endedAt: '2026-10-20T12:34:00Z' } }),
    ]);
    expect(sessionSig(running)).not.toBe(sessionSig(ended));
    const asked = open([msg('msg_k0000020', 'assistant', { ask: { number: 3, state: 'waiting' } })]);
    const approved = open([msg('msg_k0000020', 'assistant', { ask: { number: 3, state: 'approved' } })]);
    expect(sessionSig(asked)).not.toBe(sessionSig(approved));
  });
});
