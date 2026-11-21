import { PUSH_PREVIEW_BODY_RE, PUSH_PREVIEW_TITLE_RE, PushPreview } from '@whombat/control-contracts/device';
import { plainMessageText } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  approvalPushGroup,
  buildPushPreview,
  GENERIC_PUSH_TEXT,
  genericPushText,
  notificationPushTitle,
  previewBody,
  previewLine,
  previewTitle,
  threadPushGroup,
  withoutCodeBlocks,
} from './push-preview';

const codePoints = (s: string) => [...s].length;

const NASTY = [
  '',
  ' ',
  '\n\n\t',
  'Hello\nworld',
  'tabs\tand\r\nCRLF',
  'no break line para',
  'zero​width‍join⁠er﻿',
  'bidi ‮hidden‬ text ⁦iso⁩',
  'emoji 👍🏽 and family 👨‍👩‍👧‍👦 and flag 🏴󠁧󠁢󠁥󠁮󠁧󠁿',
  '中文的消息内容。日本語のテキスト。한국어 텍스트',
  'lone \ud800 high and \udc00 low surrogates',
  'control \u0000\u0007\u001b[31m\u007f\u0085 chars',
  'combining é́́ marks',
  `a${'́'.repeat(400)}`,
  'x'.repeat(1000),
  '👨‍👩‍👧‍👦'.repeat(200),
  '中'.repeat(1000),
  'word '.repeat(300),
  `https://example.com/${'path/'.repeat(100)}?q=1`,
];

describe('previewLine (NT-14)', () => {
  it('always satisfies the contract patterns', () => {
    for (const text of NASTY) {
      const title = previewTitle(text);
      const body = previewBody(text);
      expect(title, JSON.stringify(text)).toMatch(PUSH_PREVIEW_TITLE_RE);
      expect(body, JSON.stringify(text)).toMatch(PUSH_PREVIEW_BODY_RE);
      expect(PushPreview.safeParse({ title, body }).success).toBe(true);
    }
  });

  it('turns whitespace, separators and controls into one space, drops format characters', () => {
    expect(previewLine('Hello\n\n  world\t!', 160)).toBe('Hello world !');
    expect(previewLine('no break line', 160)).toBe('no break line');
    expect(previewLine('zero​width‍join﻿', 160)).toBe('zerowidthjoin');
    expect(previewLine('lone \ud800 surrogate', 160)).toBe('lone surrogate');
    expect(previewLine('  trim me  ', 160)).toBe('trim me');
    expect(previewLine('中文的消息', 160)).toBe('中文的消息');
  });

  it('cuts at a character boundary with “…” as the last code point', () => {
    const cut = previewLine('x'.repeat(1000), 160);
    expect(codePoints(cut)).toBe(160);
    expect(cut.endsWith('…')).toBe(true);
    const emoji = previewLine('👍🏽'.repeat(100), 160);
    expect(codePoints(emoji)).toBeLessThanOrEqual(160);
    // 👍🏽 is two code points: never split between them.
    expect(emoji).toBe(`${'👍🏽'.repeat(79)}…`);
    expect(previewLine('word '.repeat(100), 20)).toBe('word word word word…');
    expect(previewLine('exactly', 7)).toBe('exactly');
    expect(previewLine('exactly!', 7)).toBe('exactl…');
    const marks = previewLine(`a${'́'.repeat(400)}`, 80);
    expect(codePoints(marks)).toBe(80);
  });

  it('a title is never empty', () => {
    expect(previewTitle('')).toBe('Whombat');
    expect(previewTitle('​\n')).toBe('Whombat');
    expect(previewBody('\n')).toBe('');
  });
});

describe('titles (NT-14)', () => {
  it('says who and where', () => {
    expect(notificationPushTitle('mention', 'Dusty', '#general')).toBe('Dusty mentioned you in #general');
    expect(notificationPushTitle('reply', 'Dusty', '#general')).toBe('Dusty replied in #general');
    expect(notificationPushTitle('direct', 'Mara', 'Direct')).toBe('Mara · Direct');
    expect(notificationPushTitle('agent_update', 'Dusty', 'Direct')).toBe('Dusty');
    expect(notificationPushTitle('agent_update', 'Dusty', '#general')).toBe('Dusty · #general');
    expect(notificationPushTitle('needs_you', 'Dusty', '#ops')).toBe('Needs you · #ops');
  });

  it('builds a valid preview from any name and text', () => {
    expect(
      buildPushPreview({ kind: 'mention', actor: 'Dusty', where: '#general', text: 'Can you\nlook?' }),
    ).toEqual({ title: 'Dusty mentioned you in #general', body: 'Can you look?' });
    const long = buildPushPreview({
      kind: 'reply',
      actor: 'B'.repeat(100),
      where: `#${'c'.repeat(100)}`,
      text: '中'.repeat(500),
    });
    expect(PushPreview.safeParse(long).success).toBe(true);
    expect(codePoints(long.title)).toBe(80);
    expect(buildPushPreview({ kind: 'agent_update', actor: ' ', where: 'Direct', text: '' })).toEqual({
      title: 'Whombat',
      body: '',
    });
  });

  it('previews off: the phone’s generic words', () => {
    expect(genericPushText('mention')).toBe('Someone mentioned you');
    expect(genericPushText('agent_update')).toBe(GENERIC_PUSH_TEXT.message);
    expect(genericPushText('needs_you')).toBe('Something is waiting for your approval');
  });
});

describe('withoutCodeBlocks (NT-14)', () => {
  it('replaces fenced blocks with “(code)”', () => {
    const text = 'The fix:\n\n```ts\nconst secret = 42;\n```\n\nWorks now.';
    expect(withoutCodeBlocks(text)).toBe('The fix:\n\n(code)\n\nWorks now.');
    expect(previewBody(plainMessageText(withoutCodeBlocks(text)))).toBe('The fix: (code) Works now.');
  });

  it('handles tildes, longer fences, indentation and an unclosed block', () => {
    expect(withoutCodeBlocks('a\n~~~\nx\n~~~\nb')).toBe('a\n(code)\nb');
    expect(withoutCodeBlocks('````\n```\nstill code\n````\nafter')).toBe('(code)\nafter');
    expect(withoutCodeBlocks('  ```sh\nrm -rf /\n  ```')).toBe('(code)');
    expect(withoutCodeBlocks('start\n```\nnever closed\nsecret')).toBe('start\n(code)');
    // A backtick fence's info string has no backtick: inline code, not a fence.
    expect(withoutCodeBlocks('```inline``` stays')).toBe('```inline``` stays');
    expect(withoutCodeBlocks('no code `here`')).toBe('no code `here`');
  });
});

describe('groups (NT-15)', () => {
  it('one per thread or approval', () => {
    expect(threadPushGroup('cnv_1', null)).toBe('thread:cnv_1:main');
    expect(threadPushGroup('cnv_1', 'msg_2')).toBe('thread:cnv_1:msg_2');
    expect(approvalPushGroup('approval_3')).toBe('approval:approval_3');
  });
});
