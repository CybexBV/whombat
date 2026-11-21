/** What a recording said, as it goes into a draft: the service's notes about the sound go. */
import { VOICE_TYPING_TEXT_MAX } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { dictatedText } from './service';

describe('dictated text', () => {
  it('keeps what was said and drops the notes about the sound', () => {
    expect(dictatedText(' Kijk even naar  pve-02 [BLANK_AUDIO] ')).toBe('Kijk even naar pve-02');
    expect(dictatedText('(music) *coughs* Restart Plex.')).toBe('Restart Plex.');
  });

  it('is nothing when nothing but notes and marks is left', () => {
    expect(dictatedText('[BLANK_AUDIO]')).toBe('');
    expect(dictatedText(' … ')).toBe('');
  });

  it('is cut to the longest text between characters', () => {
    const long = `${'a'.repeat(VOICE_TYPING_TEXT_MAX - 1)}😀 more`;
    const cut = dictatedText(long);
    expect(cut.length).toBeLessThanOrEqual(VOICE_TYPING_TEXT_MAX);
    expect(cut.endsWith('a')).toBe(true);
  });
});
