import { describe, expect, it } from 'vitest';
import { ChatThread, threadPreview } from './conversation.js';

describe('a list row’s preview of a message', () => {
  it('reads a link as its words and a bare address without its scheme', () => {
    expect(threadPreview('The cleanup is ready in [PR 69](https://github.com/acme/shop/pull/69).')).toBe(
      'The cleanup is ready in PR 69.',
    );
    expect(threadPreview('See [the docs](https://example.com/a_(b)) and https://www.example.com/x')).toBe(
      'See the docs and example.com/x',
    );
    expect(threadPreview('![A chart](https://example.com/c.png) of the week')).toBe('A chart of the week');
  });

  it('goes on into the next lines, without Markdown marks', () => {
    expect(threadPreview('**Done.**\n\n- `main` is pushed\n- 2 tests added\n\n> as asked')).toBe(
      'Done. main is pushed 2 tests added as asked',
    );
    expect(threadPreview('## Result\n1. my_app.py is _fixed_\n```sh\npnpm check\n```')).toBe(
      'Result my_app.py is fixed pnpm check',
    );
    expect(threadPreview('| Name | Size |\n|---|---|\n| a | 1 |')).toBe('Name Size a 1');
  });

  it('clips at its limit and is empty without words', () => {
    const long = threadPreview('word '.repeat(80));
    expect([...long]).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
    expect(threadPreview('abcdef', 4)).toBe('abc…');
    expect(threadPreview('  \n\n ')).toBe('');
  });
});

describe('a thread’s repository', () => {
  const thread = {
    conversationId: 'cnv_1',
    room: 'chat',
    rootId: 'msg_1',
    authorId: 'prn_agent',
    text: 'Hunt for bugs · shop',
    createdAt: '2026-11-17T08:00:00.000Z',
    replyCount: 0,
    lastAt: '2026-11-17T08:00:00.000Z',
    working: false,
  };

  it('is optional, with or without an icon', () => {
    expect(ChatThread.parse(thread).repo).toBeUndefined();
    expect(ChatThread.parse({ ...thread, repo: null }).repo).toBeNull();
    expect(ChatThread.parse({ ...thread, repo: { fullName: 'acme/shop', name: 'shop' } }).repo?.name).toBe(
      'shop',
    );
    expect(
      ChatThread.parse({
        ...thread,
        repo: { fullName: 'acme/shop', name: 'shop', iconUrl: '/api/v1/burrows/acme/attachments/att_1' },
      }).repo?.iconUrl,
    ).toBe('/api/v1/burrows/acme/attachments/att_1');
  });
});
