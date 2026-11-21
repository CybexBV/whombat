/**
 * Android's composer and edit sheet correct `@dusty ` to `@Dusty ` (docs/decisions/app-managed.md AP-607, Whombat
 * MS-C03): `onChangeText` gives the text only, so the shared model finds the caret from the change. These replay what
 * a keyboard reports: one character at a time, or a whole word committed at once (Gboard).
 */
import { autocorrectComposerMention, composerMentionTargets, composerText } from '@whombat/client';
import { mara, PRINCIPALS } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';

const targets = composerMentionTargets(PRINCIPALS, mara.id);

type Change = string | ((text: string) => string);

/**
 * The field after each change, as the composer keeps it (`draft.current`), with the last correction's caret. A change is
 * the field's new text, or a function of the current one (a key pressed).
 */
function replay(changes: readonly Change[]): { text: string; caret: number | null } {
  let text = '';
  let caret: number | null = null;
  for (const change of changes) {
    const next = typeof change === 'string' ? change : change(text);
    const fixed = autocorrectComposerMention({ previous: text, next }, targets);
    text = fixed?.text ?? next;
    caret = fixed ? fixed.caret : caret;
  }
  return { text, caret };
}

/** Typing `typed` one character at a time at the end. */
const typing = (typed: string): Change[] => [...typed].map((ch) => (text: string) => text + ch);

describe('Android: mentions in any letter case', () => {
  it('corrects as each character is typed', () => {
    expect(replay(typing('@dusty hi'))).toEqual({ text: '@Dusty hi', caret: 7 });
    expect(replay(typing('ping @DUSTY, please'))).toEqual({ text: 'ping @Dusty, please', caret: 12 });
  });

  it('corrects a word the keyboard commits at once', () => {
    expect(replay(['hey ', 'hey @', 'hey @dusty '])).toEqual({ text: 'hey @Dusty ', caret: 11 });
  });

  it('corrects a word typed before existing text, caret kept', () => {
    const text = 'can you look';
    const changes = [...'@dusty '].map((ch, i) => (t: string) => t.slice(0, i) + ch + t.slice(i));
    expect(replay([text, ...changes])).toEqual({ text: `@Dusty ${text}`, caret: 7 });
  });

  it('leaves emails, unknown names, code and deletions alone', () => {
    expect(replay(typing('john@banjo.example ')).text).toBe('john@banjo.example ');
    expect(replay(typing('@nobody ')).text).toBe('@nobody ');
    expect(replay(typing('`@banjo` ')).text).toBe('`@banjo` ');
    expect(replay(['@banjo hi', '@banjo h', '@banjo ']).text).toBe('@banjo ');
  });

  it('sends and saves canonical text', () => {
    expect(composerText('@dusty and @nobody, see john@dusty.example', targets)).toBe(
      '@Dusty and @nobody, see john@dusty.example',
    );
  });
});
