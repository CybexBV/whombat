import { describe, expect, it } from 'vitest';
import type { DeskTalk } from './desk';
import { DESK_WORDS, fill } from './deskCopy';
import { canAsk, settledId, TALK_READY, type TalkUi, talkBusy, talkReducer, talkView } from './talk';

const talk = (p: Partial<DeskTalk>): DeskTalk => ({
  id: 't1',
  state: 'thinking',
  question: null,
  answer: null,
  thing: null,
  audio: false,
  reason: null,
  ...p,
});

const run = (events: Parameters<typeof talkReducer>[1][], from: TalkUi = TALK_READY) =>
  events.reduce(talkReducer, from);

describe('talkReducer', () => {
  it('sends, follows and settles', () => {
    let s = run([{ type: 'type', text: 'Is pve-02 okay?' }]);
    expect(s.phase).toBe('sending');
    s = run([{ type: 'sent', id: 't1' }], s);
    expect(s).toEqual({ phase: 'waiting', id: 't1', typed: 'Is pve-02 okay?' });
    s = run([{ type: 'update', talk: talk({ state: 'thinking' }) }], s);
    expect(s.phase).toBe('waiting');
    s = run([{ type: 'update', talk: talk({ state: 'answered', answer: 'Yes.' }) }], s);
    expect(s).toEqual({ phase: 'done', id: 't1', typed: 'Is pve-02 okay?' });
    expect(canAsk(s)).toBe(true);
  });

  it('asks one thing at a time', () => {
    const waiting: TalkUi = { phase: 'waiting', id: 't1', typed: null };
    expect(run([{ type: 'type', text: 'hi' }], waiting)).toBe(waiting);
    expect(run([{ type: 'update', talk: talk({ id: 'other', state: 'answered' }) }], waiting)).toBe(waiting);
  });

  it('sends typed questions, trimmed, and ignores empty ones', () => {
    expect(run([{ type: 'type', text: '  is pve-02 okay? ' }])).toEqual({
      phase: 'sending',
      typed: 'is pve-02 okay?',
    });
    expect(run([{ type: 'type', text: '   ' }])).toEqual(TALK_READY);
  });

  it('maps Whombat’s refusals', () => {
    const sending: TalkUi = { phase: 'sending', typed: null };
    const err = (status: number, code: string | null) => run([{ type: 'refused', status, code }], sending);
    expect(err(409, 'locked')).toMatchObject({ error: 'locked' });
    expect(err(409, 'busy')).toMatchObject({ error: 'busy' });
    expect(err(503, 'voice_unavailable')).toMatchObject({ error: 'off' });
    expect(err(400, null)).toMatchObject({ error: 'failed' });
  });

  it('picks up a talk still going after a reload', () => {
    expect(run([{ type: 'resume', id: 't9' }])).toEqual({ phase: 'waiting', id: 't9', typed: null });
  });

  it('marks the moment a talk has its answer or failed (CG-54)', () => {
    expect(settledId({ phase: 'waiting', id: 't1', typed: null })).toBeNull();
    expect(settledId({ phase: 'done', id: 't1', typed: null })).toBe('t1');
    expect(settledId({ phase: 'error', error: 'busy', typed: null })).toBeNull();
  });
});

describe('talkView', () => {
  it('shows the prompt, then the question with Thinking…', () => {
    expect(talkView(TALK_READY, null, 'Neo').answer?.kind).toBe('prompt');
    const v = talkView(
      { phase: 'waiting', id: 't1', typed: null },
      talk({ question: 'Is pve-02 okay?' }),
      'Neo',
    );
    expect(v.question).toBe('Is pve-02 okay?');
    expect(v.answer?.kind).toBe('thinking');
  });

  it('shows the answer, its server and whether it can be heard', () => {
    const thing = {
      name: 'pve-02',
      mark: 'proxmox',
      state: 'ok' as const,
      note: '',
      cpu: null,
      memory: null,
      temp: null,
    };
    const v = talkView(
      { phase: 'done', id: 't1', typed: null },
      talk({ state: 'answered', question: 'Q', answer: 'Yes, pve-02 is fine.', thing, audio: true }),
      'Neo',
    );
    expect(v.answer).toEqual({ kind: 'answer', text: 'Yes, pve-02 is fine.' });
    expect(v.thing?.name).toBe('pve-02');
    expect(v.audio).toBe(true);
  });

  it('says why a talk failed, with the assistant’s real name', () => {
    const done: TalkUi = { phase: 'done', id: 't1', typed: 'hi' };
    const slow = talkView(done, talk({ state: 'failed', reason: 'slow' }), 'Banjo');
    expect(slow.answer?.kind).toBe('error');
    expect(slow.answer?.text).toContain('Banjo');
    expect(slow.answer?.text).toContain('Chat');
    expect(slow.question).toBe('hi');
    expect(talkView(done, talk({ state: 'failed', reason: 'not_heard' }), 'Banjo').answer?.text).toContain(
      'catch',
    );
  });

  it('says typing still asks when Talk has no voice (DK-T12, CG-53)', () => {
    expect(talkView(TALK_READY, null, 'Neo', false).answer).toEqual({
      kind: 'error',
      text: DESK_WORDS.voiceUnavailable,
    });
    const typed = talkView(
      { phase: 'done', id: 't1', typed: 'Is pve-02 okay?' },
      talk({ state: 'answered', answer: 'Yes.' }),
      'Neo',
      false,
    );
    expect(typed.answer).toEqual({ kind: 'answer', text: 'Yes.' });
  });

  it('ignores a talk that isn’t the one it follows', () => {
    const v = talkView(
      { phase: 'waiting', id: 't1', typed: null },
      talk({ id: 't2', state: 'answered' }),
      'Neo',
    );
    expect(v.answer?.kind).toBe('thinking');
  });
});

describe('talkBusy (DK-71, CG-172)', () => {
  it('is busy while sending, thinking or speaking the answer, not at rest or done', () => {
    const busy: TalkUi[] = [
      { phase: 'sending', typed: null },
      { phase: 'waiting', id: 'talk-0001', typed: null },
    ];
    for (const s of busy) expect(talkBusy(s, false)).toBe(true);
    const rest: TalkUi[] = [
      TALK_READY,
      { phase: 'done', id: 'talk-0001', typed: null },
      { phase: 'error', error: 'failed', typed: null },
    ];
    for (const s of rest) expect(talkBusy(s, false)).toBe(false);
    expect(talkBusy({ phase: 'done', id: 'talk-0001', typed: null }, true)).toBe(true);
  });
});

describe('a talk that is working (0.116, TF-16, CG-283)', () => {
  it('keeps following it past 90 s, until it is answered or fails', () => {
    const waiting: TalkUi = { phase: 'waiting', id: 't1', typed: null };
    const working = talk({ state: 'working' });
    expect(run([{ type: 'update', talk: working }], waiting)).toBe(waiting);
    expect(talkBusy(waiting, false)).toBe(true);
    expect(talkView(waiting, working, 'Neo').answer).toEqual({
      kind: 'thinking',
      text: fill(DESK_WORDS.working, { assistant: 'Neo' }),
    });
    const answered = run([{ type: 'update', talk: talk({ state: 'answered', answer: 'Done.' }) }], waiting);
    expect(answered.phase).toBe('done');
    const slow = talk({ state: 'failed', reason: 'slow' });
    expect(run([{ type: 'update', talk: slow }], waiting).phase).toBe('done');
    expect(talkView({ ...waiting, phase: 'done' }, slow, 'Neo').answer).toMatchObject({
      kind: 'error',
      slow: true,
    });
  });

  it('stops following a talk Whombat no longer knows', () => {
    const waiting: TalkUi = { phase: 'waiting', id: 't1', typed: null };
    expect(run([{ type: 'lost', id: 't1' }], waiting)).toEqual(TALK_READY);
    expect(run([{ type: 'lost', id: 'other' }], waiting)).toBe(waiting);
    const done: TalkUi = { phase: 'done', id: 't1', typed: null };
    expect(run([{ type: 'lost', id: 't1' }], done)).toBe(done);
  });

  it('follows the words after a decision from when it was decided', () => {
    expect(run([{ type: 'resume', id: 't2', at: 1000 }])).toEqual({
      phase: 'waiting',
      id: 't2',
      typed: null,
      since: 1000,
    });
    const s = run([
      { type: 'resume', id: 't2', at: 1000 },
      { type: 'update', talk: talk({ id: 't2', state: 'answered', answer: 'x' }) },
    ]);
    expect(s).toEqual({ phase: 'done', id: 't2', typed: null, since: 1000 });
    expect(run([{ type: 'resume', id: 't3' }])).toEqual({ phase: 'waiting', id: 't3', typed: null });
  });
});
