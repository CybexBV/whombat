import { FACE_STATES } from '@whombat/avatars/motion';
import { describe, expect, it } from 'vitest';
import type { ConvoRow } from './conversation';
import type { DeskTalk } from './desk';
import { deskMood, facesAsleep, liveFaceRow, researchFace, type TalkFaceInput, talkFace } from './deskFace';
import { DICTATION_ERROR_MS, DICTATION_IDLE } from './dictation';
import { TALK_READY } from './talk';

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

const at = (p: Partial<TalkFaceInput>): TalkFaceInput => ({
  dictation: DICTATION_IDLE,
  pageNow: 10_000,
  talk: TALK_READY,
  followed: null,
  speaking: false,
  convoWorking: false,
  ...p,
});

describe('talkFace', () => {
  it('rests idle with nothing going on', () => {
    expect(talkFace(at({}))).toBe('idle');
    expect(
      talkFace(at({ talk: { phase: 'done', id: 't1', typed: 'hi' }, followed: talk({ state: 'answered' }) })),
    ).toBe('idle');
  });

  it('listens while the mic opens and records, and thinks while the box turns it into words', () => {
    expect(talkFace(at({ dictation: { phase: 'preparing' } }))).toBe('listening');
    expect(talkFace(at({ dictation: { phase: 'recording', since: 0 } }))).toBe('listening');
    expect(talkFace(at({ dictation: { phase: 'transcribing' } }))).toBe('thinking');
  });

  it('listens to the person even while an answer is awaited or said', () => {
    const waiting = { phase: 'waiting', id: 't1', typed: null } as const;
    expect(talkFace(at({ dictation: { phase: 'recording', since: 0 }, talk: waiting, speaking: true }))).toBe(
      'listening',
    );
  });

  it('thinks while the answer is awaited, and works once the talk or the conversation says so', () => {
    expect(talkFace(at({ talk: { phase: 'sending', typed: 'hi' } }))).toBe('thinking');
    const waiting = { phase: 'waiting', id: 't1', typed: 'hi' } as const;
    expect(talkFace(at({ talk: waiting, followed: talk({ state: 'thinking' }) }))).toBe('thinking');
    expect(talkFace(at({ talk: waiting, followed: talk({ state: 'working' }) }))).toBe('working');
    // Another talk's state says nothing about this one.
    expect(talkFace(at({ talk: waiting, followed: talk({ id: 'old', state: 'working' }) }))).toBe('thinking');
    expect(talkFace(at({ convoWorking: true }))).toBe('working');
  });

  it('speaks while the answer is said out loud', () => {
    const done = { phase: 'done', id: 't1', typed: 'hi' } as const;
    expect(
      talkFace(at({ talk: done, followed: talk({ state: 'answered', audio: true }), speaking: true })),
    ).toBe('speaking');
  });

  it('is sorry after a failure, not after the screen locked', () => {
    expect(talkFace(at({ talk: { phase: 'error', error: 'failed', typed: 'hi' } }))).toBe('sorry');
    expect(talkFace(at({ talk: { phase: 'error', error: 'busy', typed: 'hi' } }))).toBe('sorry');
    expect(talkFace(at({ talk: { phase: 'error', error: 'locked', typed: 'hi' } }))).toBe('idle');
    const done = { phase: 'done', id: 't1', typed: 'hi' } as const;
    expect(talkFace(at({ talk: done, followed: talk({ state: 'failed', reason: 'slow' }) }))).toBe('sorry');
  });

  it('is sorry while the mic’s failure shows, then rests', () => {
    const failed = { phase: 'idle', error: 'microphone', at: 10_000 } as const;
    expect(talkFace(at({ dictation: failed, pageNow: 10_500 }))).toBe('sorry');
    expect(talkFace(at({ dictation: failed, pageNow: 10_000 + DICTATION_ERROR_MS }))).toBe('idle');
  });

  it('only names states the face knows', () => {
    const inputs: Partial<TalkFaceInput>[] = [
      {},
      { dictation: { phase: 'recording', since: 0 } },
      { talk: { phase: 'sending', typed: 'hi' } },
      { convoWorking: true },
      { speaking: true },
      { talk: { phase: 'error', error: 'off', typed: null } },
    ];
    for (const i of inputs) expect(FACE_STATES).toContain(talkFace(at(i)));
  });
});

const row = (key: string, from: ConvoRow['from']): ConvoRow => ({
  key,
  from,
  paragraphs: ['…'],
  tone: 'text',
  more: false,
  ask: null,
  replay: null,
  thing: null,
  task: null,
});

describe('liveFaceRow', () => {
  it('is the first row of the assistant’s last run', () => {
    const rows = [row('a', 'assistant'), row('q', 'you'), row('b', 'assistant'), row('c', 'assistant')];
    expect(liveFaceRow(rows)).toBe(2);
    expect(liveFaceRow([...rows, row('q2', 'you')])).toBe(2);
    expect(liveFaceRow([...rows, row('q2', 'you'), row('thinking', 'assistant')])).toBe(5);
    expect(liveFaceRow([row('intro', 'assistant')])).toBe(0);
  });

  it('is none before the assistant said anything', () => {
    expect(liveFaceRow([])).toBe(-1);
    expect(liveFaceRow([row('q', 'you')])).toBe(-1);
  });
});

describe('the glance’s faces', () => {
  it('doze while nobody’s there and in quiet hours, never in Talk', () => {
    expect(facesAsleep('idle', false)).toBe(true);
    expect(facesAsleep('glance', true)).toBe(true);
    expect(facesAsleep('glance', false)).toBe(false);
    expect(facesAsleep('talk', true)).toBe(false);
  });

  it('say hello once they woke', () => {
    expect(deskMood(false, false)).toBe('idle');
    expect(deskMood(true, false)).toBe('asleep');
    expect(deskMood(true, true)).toBe('asleep');
    expect(deskMood(false, true)).toBe('welcome');
  });
});

describe('researchFace', () => {
  it('thinks while looking, works while fixing, is glad once fixed', () => {
    expect(researchFace('looking')).toBe('thinking');
    expect(researchFace('fixing')).toBe('working');
    expect(researchFace('fixed')).toBe('done');
    expect(researchFace('found')).toBeUndefined();
    expect(researchFace(null)).toBeUndefined();
  });
});
