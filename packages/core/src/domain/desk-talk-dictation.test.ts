/**
 * Contracts 3.3, Talk's mic is voice typing (Whombat docs/decisions/dictation.md): the screen's recording bar says what
 * the composers say, written out in `DESK_WORDS` so the console page can copy them.
 */
import { describe, expect, it } from 'vitest';
import { DESK_WORDS } from './desk.js';
import { VOICE_WORDS } from './voice.js';

describe('Talk’s voice typing words', () => {
  it('are the composers’ words', () => {
    const d = DESK_WORDS.dictation;
    const c = VOICE_WORDS.composer;
    expect([d.cancel, d.done, d.preparing, d.recording, d.transcribing]).toEqual([
      c.cancel,
      c.done,
      c.preparing,
      c.recording,
      c.transcribing,
    ]);
    const e = VOICE_WORDS.errors;
    expect([d.nothing, d.busy, d.badAudio, d.tooLong, d.failed]).toEqual([
      e.nothing,
      e.busy,
      e.bad_audio,
      e.too_long,
      e.failed,
    ]);
  });

  it('no longer tell anyone to hold the button', () => {
    expect(JSON.stringify(DESK_WORDS)).not.toMatch(/hold to talk|hold the space bar/i);
    expect(DESK_WORDS.tapToTalk).toBe('Tap to talk');
  });
});
