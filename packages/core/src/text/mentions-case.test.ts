/** Contracts 0.33: mentions in any letter case (Whombat messaging.md MS-C01…MS-C03, CT-207). */
import { describe, expect, it } from 'vitest';
import {
  autocorrectMentionAt,
  canonicalizeMentions,
  type MentionTarget,
  mentionCorrections,
  mentionNameOf,
  mentionNames,
  resolveMentions,
  segmentMentions,
} from './mentions.js';

const targets: MentionTarget[] = [
  { id: 'agt_banjo', kind: 'agent', name: 'Banjo' },
  { id: 'agt_pepper', kind: 'agent', name: 'Pepper' },
  { id: 'prn_mara', kind: 'person', name: 'Mara Visser' },
  { id: 'prn_joris', kind: 'person', name: 'Joris de Wit', shortName: 'Jo' },
  { id: 'agt_whombat', kind: 'agent', name: 'Whombat' },
];
const fix = (text: string, list: readonly MentionTarget[] = targets) => canonicalizeMentions(text, list);

describe('mentionNameOf', () => {
  it('is an agent’s name, a person’s short name or else first name', () => {
    expect(targets.map(mentionNameOf)).toEqual(['Banjo', 'Pepper', 'Mara', 'Jo', 'Whombat']);
  });
});

describe('canonicalizeMentions (MS-C01, MS-C02)', () => {
  it('rewrites a mention in any letter case to its canonical form', () => {
    expect(fix('@banjo are you able to connect?')).toBe('@Banjo are you able to connect?');
    expect(fix('@BANJO hi')).toBe('@Banjo hi');
    expect(fix('@bAnJo hi')).toBe('@Banjo hi');
    expect(fix('hey @mara and @jo, @pepper.')).toBe('hey @Mara and @Jo, @Pepper.');
    expect(fix('(@banjo) [@banjo] "@banjo" “@banjo” @banjo: @banjo! @banjo? @banjo; @banjo’s')).toBe(
      '(@Banjo) [@Banjo] "@Banjo" “@Banjo” @Banjo: @Banjo! @Banjo? @Banjo; @Banjo’s',
    );
    expect(fix('line one\n@banjo\n\t@pepper')).toBe('line one\n@Banjo\n\t@Pepper');
    expect(fix('@banjo. Done')).toBe('@Banjo. Done');
    expect(fix('ask @banjo - now')).toBe('ask @Banjo - now');
    expect(fix('ask @banjo-')).toBe('ask @Banjo-');
    expect(fix('ask @banjo.')).toBe('ask @Banjo.');
  });

  it('leaves the canonical form exactly as it was', () => {
    for (const text of ['@Banjo go', 'x/@Banjo', 'john@Banjo.example', '@BanjoBot', '`@Banjo`', '@Banjo2'])
      expect(fix(text)).toBe(text);
    expect(segmentMentions('@Banjo hi')).toEqual(segmentMentions(fix('@banjo hi')));
  });

  it('is not a mention after a letter, digit, `_`, `.`, `@`, `/` or `-`', () => {
    for (const text of [
      'john@banjo.example',
      'mail john@banjo please',
      'x/@banjo',
      'https://example.com/@banjo',
      'a.@banjo',
      'a-@banjo',
      'a_@banjo',
      '2@banjo',
      '@@banjo',
      'é@banjo',
      'é@banjo',
    ])
      expect(fix(text)).toBe(text);
  });

  it('is not a mention when the word goes on', () => {
    for (const text of [
      '@banjo.example',
      'see @banjo.example today',
      '@banjo.c',
      '@banjo.2',
      '@banjo-ci',
      '@banjo2',
      '@banjo_bot',
      '@banjo@example.com',
      '@whombat/core',
      '@banjos',
      '@banjoé',
      '@banjoé',
      '@ban',
    ])
      expect(fix(text)).toBe(text);
  });

  it('leaves code spans and fenced code blocks alone', () => {
    for (const text of [
      'type `@banjo` to ask',
      'type ``@banjo `x` `` to ask',
      '```\n@banjo\n```',
      '~~~sh\nssh @banjo\n~~~',
      '```\n@banjo unterminated',
      '  ```\n@banjo\n  ```',
    ])
      expect(fix(text)).toBe(text);
    expect(fix('```\n@banjo\n```\n@banjo after `@pepper` and @pepper')).toBe(
      '```\n@banjo\n```\n@Banjo after `@pepper` and @Pepper',
    );
    // An unmatched backtick is not code.
    expect(fix('a ` @banjo')).toBe('a ` @Banjo');
  });

  it('leaves unknown words as typed', () => {
    expect(fix('@nobody @someone @banjo')).toBe('@nobody @someone @Banjo');
    expect(fix('@banjo', [])).toBe('@banjo');
  });

  it('ignores names a mention can’t carry (not one capital and lowercase letters)', () => {
    const odd: MentionTarget[] = [
      { id: 'agt_r2', kind: 'agent', name: 'R2d2' },
      { id: 'prn_jp', kind: 'person', name: 'JP Smit' },
      { id: 'prn_low', kind: 'person', name: 'anne Smit' },
      { id: 'agt_code', kind: 'agent', name: 'Code Reviewer' },
    ];
    expect(fix('@r2d2 @jp @Jp @anne @code', odd)).toBe('@r2d2 @jp @Jp @anne @code');
  });

  it('compares ASCII letters only: no Unicode case folding', () => {
    // U+212A KELVIN SIGN lowercases to “k”; U+0130 and U+0131 are Turkish i's.
    const kate: MentionTarget[] = [{ id: 'prn_kate', kind: 'person', name: 'Kate Bos' }, ...targets];
    expect(fix('@Kate', kate)).toBe('@Kate');
    expect(fix('@kate', kate)).toBe('@Kate');
    expect(fix('@pİpper @pıpper', [{ id: 'agt_pip', kind: 'agent', name: 'Pipper' }])).toBe(
      '@pİpper @pıpper',
    );
  });

  it('keeps everything around it byte-identical, astral characters included', () => {
    expect(fix('👋@banjo 🦘 @pepper👍')).toBe('👋@Banjo 🦘 @Pepper👍');
    expect(fix('𝒳@banjo')).toBe('𝒳@banjo'); // a mathematical letter is a letter
    expect(fix('\u{1F600}‍@banjo\r\n@pepper ok')).toBe('\u{1F600}‍@Banjo\r\n@Pepper ok');
    expect(fix('日本語 @banjo です')).toBe('日本語 @Banjo です');
    const plain = 'no mentions here, just text: a@b, `code`, ```x```';
    expect(fix(plain)).toBe(plain);
  });

  it('is idempotent', () => {
    for (const text of [
      '@banjo @BANJO @Banjo @mara john@banjo.example `@banjo` @nobody',
      '👋@pepper\n```\n@banjo\n```\n@jo',
    ]) {
      const once = fix(text);
      expect(fix(once)).toBe(once);
      expect(mentionCorrections(once, targets)).toEqual([]);
    }
  });

  it('lists each correction with its place', () => {
    expect(mentionCorrections('hi @banjo and @PEPPER', targets)).toEqual([
      { start: 3, end: 9, from: '@banjo', to: '@Banjo' },
      { start: 14, end: 21, from: '@PEPPER', to: '@Pepper' },
    ]);
  });
});

describe('resolveMentions on the canonical text (MS-C02)', () => {
  it('resolves any letter case, in order, without duplicates', () => {
    expect(resolveMentions('@banjo are you able to connect to root@203.0.113.44?', targets)).toEqual([
      'agt_banjo',
    ]);
    expect(resolveMentions('@pepper @BANJO @Banjo @mara @jo', targets)).toEqual([
      'agt_pepper',
      'agt_banjo',
      'prn_mara',
      'prn_joris',
    ]);
    expect(resolveMentions('john@banjo.example `@banjo` x/@banjo @banjo.example', targets)).toEqual([]);
  });

  it('lets the agent win over a person with the same first name, for every case', () => {
    const clash: MentionTarget[] = [
      { id: 'prn_sam', kind: 'person', name: 'Sam Lee' },
      { id: 'agt_sam', kind: 'agent', name: 'Sam' },
    ];
    expect(resolveMentions('@sam', clash)).toEqual(['agt_sam']);
    expect(resolveMentions('@SAM', clash.slice(0, 1))).toEqual(['prn_sam']);
    expect(resolveMentions('@Sam', clash)).toEqual(['agt_sam']);
  });

  it('changes nothing for the canonical form', () => {
    expect(resolveMentions('@Banjo and @Pepper, see @Nobody', targets)).toEqual(['agt_banjo', 'agt_pepper']);
    expect(mentionNames(fix('@banjo @Pepper'))).toEqual(['Banjo', 'Pepper']);
  });
});

describe('autocorrectMentionAt (MS-C03)', () => {
  /** Types `text` one character at a time, auto-correcting after each, like a composer. */
  const typeOut = (text: string) => {
    let out = '';
    for (const ch of text) {
      out += ch;
      out = autocorrectMentionAt(out, out.length, targets)?.text ?? out;
    }
    return out;
  };

  it('corrects the word just ended, caret kept', () => {
    expect(autocorrectMentionAt('@banjo ', 7, targets)).toEqual({ text: '@Banjo ', caret: 7 });
    expect(autocorrectMentionAt('hi @banjo,', 10, targets)).toEqual({ text: 'hi @Banjo,', caret: 10 });
    expect(autocorrectMentionAt('hi @banjo\n', 10, targets)).toEqual({ text: 'hi @Banjo\n', caret: 10 });
    expect(autocorrectMentionAt('@banjo!', 7, targets)).toEqual({ text: '@Banjo!', caret: 7 });
  });

  it('corrects in the middle of the text', () => {
    const text = 'hi @banjo  and more';
    expect(autocorrectMentionAt(text, 10, targets)).toEqual({ text: 'hi @Banjo  and more', caret: 10 });
  });

  it('waits while the word may go on', () => {
    expect(autocorrectMentionAt('@banjo', 6, targets)).toBeNull();
    expect(autocorrectMentionAt('@banjo.', 7, targets)).toBeNull();
    expect(autocorrectMentionAt('@banjo-', 7, targets)).toBeNull();
    expect(autocorrectMentionAt('@banjo. ', 8, targets)).toEqual({ text: '@Banjo. ', caret: 8 });
    expect(autocorrectMentionAt('@banjo.c', 8, targets)).toBeNull();
  });

  it('corrects only the word just ended', () => {
    expect(autocorrectMentionAt('@banjo and ', 11, targets)).toBeNull();
    expect(autocorrectMentionAt('@Banjo ', 7, targets)).toBeNull();
    expect(autocorrectMentionAt('@nobody ', 8, targets)).toBeNull();
    expect(autocorrectMentionAt('', 0, targets)).toBeNull();
    expect(autocorrectMentionAt('@banjo ', 99, targets)).toBeNull();
  });

  it('leaves code alone, also a span still open on its line', () => {
    expect(autocorrectMentionAt('`@banjo ', 8, targets)).toBeNull();
    expect(autocorrectMentionAt('`@banjo `', 8, targets)).toBeNull();
    expect(autocorrectMentionAt('```\n@banjo ', 11, targets)).toBeNull();
    expect(autocorrectMentionAt('`x` @banjo ', 11, targets)).toEqual({ text: '`x` @Banjo ', caret: 11 });
    expect(autocorrectMentionAt('`x\n@banjo ', 10, targets)).toEqual({ text: '`x\n@Banjo ', caret: 10 });
  });

  it('typed out character by character, agrees with canonicalizeMentions', () => {
    for (const text of [
      '@banjo are you able to connect to root@203.0.113.44 using the key? ',
      'mail john@banjo.example or @banjo.example, ask @PEPPER. ',
      'see `@banjo` and x/@banjo and @banjo-ci and @mara\n',
      '@channel @here @jo! ',
    ])
      expect(typeOut(text)).toBe(fix(text));
  });
});
