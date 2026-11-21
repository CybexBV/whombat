import { describe, expect, it } from 'vitest';
import { deskSocketSource, deskWordsSource } from './contractsSource';
import { DESK, DESK_WORDS } from './deskCopy';
import {
  DICTATION_ERROR_MS,
  DICTATION_IDLE,
  type Dictation,
  type DictationEvent,
  dictating,
  dictationLabel,
  dictationNotice,
  dictationReducer,
  hearRefusal,
  hearTimeoutMs,
  MAX_HEAR_SECONDS,
  MAX_TALK_TEXT,
  parseHeard,
  recordingTime,
  withHeard,
} from './dictation';

const run = (events: DictationEvent[], from: Dictation = DICTATION_IDLE) =>
  events.reduce(dictationReducer, from);

describe('Talk’s mic (CG-359, CG-360)', () => {
  it('records from the tap, turns it into text after Done, and is at rest again with the words', () => {
    let s = run([{ type: 'start' }]);
    expect(s).toEqual({ phase: 'preparing' });
    expect(dictating(s)).toBe(true);
    s = run([{ type: 'open', at: 1000 }], s);
    expect(s).toEqual({ phase: 'recording', since: 1000 });
    s = run([{ type: 'done' }], s);
    expect(s).toEqual({ phase: 'transcribing' });
    s = run([{ type: 'heard' }], s);
    expect(s).toBe(DICTATION_IDLE);
    expect(dictating(s)).toBe(false);
  });

  it('drops a recording on Cancel, and Done before the microphone opened records nothing', () => {
    expect(run([{ type: 'start' }, { type: 'open', at: 0 }, { type: 'cancel' }])).toBe(DICTATION_IDLE);
    expect(run([{ type: 'start' }, { type: 'open', at: 0 }, { type: 'done' }, { type: 'cancel' }])).toBe(
      DICTATION_IDLE,
    );
    expect(run([{ type: 'start' }, { type: 'done' }])).toBe(DICTATION_IDLE);
  });

  it('starts once at a time, and ignores what comes late', () => {
    const recording: Dictation = { phase: 'recording', since: 0 };
    expect(run([{ type: 'start' }], recording)).toBe(recording);
    expect(run([{ type: 'open', at: 5 }], recording)).toBe(recording);
    expect(run([{ type: 'heard' }], recording)).toBe(recording);
    // A failure after Cancel is nobody's.
    expect(run([{ type: 'failed', error: 'failed', at: 9 }])).toBe(DICTATION_IDLE);
  });

  it('says what happens: Starting…, the time recorded, then Turning speech into text…', () => {
    expect(dictationLabel(DICTATION_IDLE, 0)).toBeNull();
    expect(dictationLabel({ phase: 'preparing' }, 0)).toBe(DESK_WORDS.dictation.preparing);
    expect(dictationLabel({ phase: 'recording', since: 1000 }, 13_900)).toBe('Recording 0:12');
    expect(dictationLabel({ phase: 'transcribing' }, 0)).toBe(DESK_WORDS.dictation.transcribing);
    expect(recordingTime(0)).toBe('0:00');
    expect(recordingTime(299_999)).toBe('4:59');
    expect(recordingTime(-5)).toBe('0:00');
  });

  it('shows a failure on the mic’s line for five seconds, in the composers’ words', () => {
    const s = run([{ type: 'start' }, { type: 'failed', error: 'nothing', at: 100 }]);
    expect(s).toEqual({ phase: 'idle', error: 'nothing', at: 100 });
    expect(dictationNotice(s, 100)).toBe('Nothing was heard.');
    expect(dictationNotice(s, 100 + DICTATION_ERROR_MS)).toBeNull();
    expect(dictationNotice({ phase: 'idle', error: 'microphone', at: 0 }, 0)).toBe(DESK.talkMicrophone);
    expect(dictationNotice({ phase: 'idle', error: 'off', at: 0 }, 0)).toBe(DESK_WORDS.voiceUnavailable);
    expect(run([{ type: 'start' }], s)).toEqual({ phase: 'preparing' });
  });

  it('reads the runtime’s refusals of hear', () => {
    expect(hearRefusal(409, 'locked')).toBeNull();
    expect(hearRefusal(409, 'busy')).toBe('busy');
    expect(hearRefusal(503, 'voice_unavailable')).toBe('off');
    expect(hearRefusal(400, 'bad_audio')).toBe('badAudio');
    expect(hearRefusal(413, 'too_large')).toBe('tooLong');
    expect(hearRefusal(503, 'unavailable')).toBe('failed');
    expect(hearRefusal(502, null)).toBe('failed');
  });

  it('puts the words at the end of the box, one line, at most a question’s length', () => {
    expect(withHeard(null, 'Is pve-02 okay?')).toBe('Is pve-02 okay?');
    expect(withHeard('Also ', 'is pve-02 okay?')).toBe('Also is pve-02 okay?');
    expect(withHeard('x'.repeat(MAX_TALK_TEXT - 3), 'more words')).toHaveLength(MAX_TALK_TEXT);
    expect(parseHeard({ v: 1, text: ' Is  pve-02\nokay? ' })).toBe('Is pve-02 okay?');
    expect(parseHeard({ v: 1, text: '' })).toBe('');
    expect(parseHeard({ v: 1 })).toBeNull();
  });

  it('waits as long as the box may take', () => {
    expect(hearTimeoutMs(2)).toBe(110_000);
    expect(hearTimeoutMs(MAX_HEAR_SECONDS)).toBe(920_000);
  });

  it('copies the contracts: voice typing’s five minutes, a question of 1000, the path', () => {
    expect(deskSocketSource).toContain(
      'export const DESK_HEAR_BASE64_MAX = 4 * Math.ceil(VOICE_TYPING_MAX_BYTES / 3);',
    );
    expect(deskSocketSource).toContain(`export const DESK_TALK_TEXT_MAX = 1_000;`);
    expect(MAX_TALK_TEXT).toBe(1000);
    expect(deskSocketSource).toContain(`hear: '/v1/desk/hear',`);
    expect(MAX_HEAR_SECONDS).toBe(5 * 60);
    expect(deskWordsSource).toContain(`tooLong: 'That was longer than 5 minutes. Try a shorter one.'`);
  });
});
