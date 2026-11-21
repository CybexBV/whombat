import type { MentionTarget, Principal } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { autocorrectComposerMention, composerMentionTargets, composerText, isInsertion } from './composer';

const targets: MentionTarget[] = [
  { id: 'agt_banjo', kind: 'agent', name: 'Banjo' },
  { id: 'agt_pepper', kind: 'agent', name: 'Pepper' },
  { id: 'prn_joris', kind: 'person', name: 'Joris de Vries', shortName: 'Joris' },
  { id: 'prn_mara', kind: 'person', name: 'Mara Okafor' },
];

/** Types `typed` at the end of `before`, the way a field reports it (caret after the inserted text). */
const type = (before: string, typed: string, extra: { caret?: number | null; inputType?: string } = {}) => {
  const next = before + typed;
  return autocorrectComposerMention(
    {
      previous: before,
      next,
      ...(extra.caret === null ? {} : { caret: extra.caret ?? next.length }),
      ...(extra.inputType ? { inputType: extra.inputType } : {}),
    },
    targets,
  );
};

describe('the composer auto-corrects a mention in another letter case (AP-607, MS-C03)', () => {
  it('corrects `@banjo ` to `@Banjo ` with the caret kept', () => {
    expect(type('@banjo', ' ')).toEqual({ text: '@Banjo ', caret: 7 });
    expect(type('hey @BANJO', ',')).toEqual({ text: 'hey @Banjo,', caret: 11 });
    expect(type('@joris', '\n')).toEqual({ text: '@Joris\n', caret: 7 });
    expect(type('cc @mara', ' ')).toEqual({ text: 'cc @Mara ', caret: 9 });
  });

  it('corrects in the middle of the text and keeps the caret there', () => {
    const previous = '@banjo can you look';
    const next = '@banjo  can you look';
    expect(
      autocorrectComposerMention({ previous, next, caret: 7, inputType: 'insertText' }, targets),
    ).toEqual({
      text: '@Banjo  can you look',
      caret: 7,
    });
  });

  it('finds the caret from the change when the field doesn’t say it (Android)', () => {
    expect(type('@banjo', ' ', { caret: null })).toEqual({ text: '@Banjo ', caret: 7 });
    // A space typed beside a space reads two ways; either one corrects.
    expect(autocorrectComposerMention({ previous: '@pepper x', next: '@pepper  x' }, targets)).toEqual({
      text: '@Pepper  x',
      caret: 8,
    });
    expect(autocorrectComposerMention({ previous: 'a @banjo', next: 'a @banjo!' }, targets)?.text).toBe(
      'a @Banjo!',
    );
  });

  it('waits a character after `.` and `-`', () => {
    expect(type('@banjo', '.')).toBeNull();
    expect(type('@banjo.', ' ')).toEqual({ text: '@Banjo. ', caret: 8 });
    expect(type('@banjo.', 'c')).toBeNull();
  });

  it('leaves emails, unknown names, broadcasts and the canonical form alone', () => {
    expect(type('john@banjo', '.')).toBeNull();
    expect(type('john@banjo.example', ' ')).toBeNull();
    expect(type('@nobody', ' ')).toBeNull();
    expect(type('@channel', ' ')).toBeNull();
    expect(type('@here', ' ')).toBeNull();
    expect(type('@Banjo', ' ')).toBeNull();
    expect(type('x/@banjo', ' ')).toBeNull();
    expect(type('@banjo2', ' ')).toBeNull();
  });

  it('leaves code alone', () => {
    expect(type('`@banjo', ' ')).toBeNull();
    expect(type('`@banjo`', ' ')).toBeNull();
    expect(type('```\n@banjo', ' ')).toBeNull();
    expect(type('`code` @banjo', ' ')).toEqual({ text: '`code` @Banjo ', caret: 14 });
  });

  it('never corrects on a deletion or during an IME composition', () => {
    expect(
      autocorrectComposerMention(
        { previous: '@banjo h', next: '@banjo ', caret: 7, inputType: 'deleteContentBackward' },
        targets,
      ),
    ).toBeNull();
    expect(
      autocorrectComposerMention({ previous: '@banjo hi', next: '@banjo ', caret: 7 }, targets),
    ).toBeNull();
    expect(autocorrectComposerMention({ previous: '@banjo h', next: '@banjo ' }, targets)).toBeNull();
    expect(
      autocorrectComposerMention({ previous: '@banjo', next: '@banjo ', caret: 7, composing: true }, targets),
    ).toBeNull();
  });

  it('tells insertions from deletions', () => {
    expect(isInsertion({ previous: 'ab', next: 'abc' })).toBe(true);
    expect(isInsertion({ previous: 'abc', next: 'ab' })).toBe(false);
    expect(isInsertion({ previous: 'abc', next: 'aXc' })).toBe(true);
    expect(isInsertion({ previous: 'ab', next: 'abc', inputType: 'deleteByCut' })).toBe(false);
    expect(isInsertion({ previous: 'ab', next: 'ab\n', inputType: 'insertLineBreak' })).toBe(true);
  });

  it('is idempotent: a corrected draft corrects no further', () => {
    const once = type('@banjo', ' ');
    expect(once).not.toBeNull();
    expect(
      autocorrectComposerMention({ previous: '@banjo ', next: once?.text ?? '', caret: 7 }, targets),
    ).toBeNull();
  });
});

describe('what the composer sends (MS-C02)', () => {
  it('sends every mention in its canonical form and the rest as typed', () => {
    expect(composerText('@banjo hi, @PEPPER and john@banjo.example `@banjo`', targets)).toBe(
      '@Banjo hi, @Pepper and john@banjo.example `@banjo`',
    );
    expect(composerText('@nobody @Banjo', targets)).toBe('@nobody @Banjo');
  });
});

describe('the composer’s targets', () => {
  const principal = (p: Record<string, unknown>) => p as unknown as Principal;
  it('are the people and the agent, never a system actor (OA-17)', () => {
    const principals = [
      principal({ id: 'prn_mara', kind: 'person', name: 'Mara Okafor', shortName: 'Mara' }),
      principal({ id: 'prn_dusty', kind: 'agent', name: 'Dusty' }),
      principal({ id: 'prn_github', kind: 'system', name: 'GitHub' }),
    ];
    const ids = composerMentionTargets(principals, 'prn_mara').map((t) => t.id);
    expect(ids).toEqual(['prn_mara', 'prn_dusty']);
    expect(composerText('@github and @dusty', composerMentionTargets(principals, 'prn_mara'))).toBe(
      '@github and @Dusty',
    );
  });

  it('names the person and the agent (one-person.md OP-01)', () => {
    const principals = [
      principal({ id: 'prn_mara', kind: 'person', name: 'Mara Okafor', shortName: 'Mara' }),
      principal({ id: 'prn_dusty', kind: 'agent', name: 'Dusty' }),
    ];
    const targets = composerMentionTargets(principals, 'prn_mara');
    expect(targets.map((t) => t.id)).toEqual(['prn_mara', 'prn_dusty']);
    expect(composerText('@kim and @dusty', targets)).toBe('@kim and @Dusty');
  });
});
