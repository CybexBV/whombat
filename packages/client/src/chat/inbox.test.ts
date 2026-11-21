import type { ChatThread, Message } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  type InboxRow,
  inboxCounts,
  inboxFiltered,
  inboxIcon,
  inboxRows,
  lastOfMessage,
  nextRootAfter,
  plainLinks,
  quietChoiceOf,
  repoLetter,
  rowStep,
  splitRepoTitle,
} from './inbox';
import { threadPagesWithMessage } from './threads';

const now = new Date('2026-11-14T11:22:00.000Z');
const tz = 'Europe/Amsterdam';
const ME = 'prn_me';
const AGENT = 'prn_dusty';

function thread(over: Partial<ChatThread> = {}): ChatThread {
  return {
    conversationId: 'cnv_chat',
    room: 'chat',
    rootId: 'msg_a',
    authorId: ME,
    text: 'Why is pve-02 using so much memory?',
    createdAt: '2026-11-14T08:41:00.000Z',
    replyCount: 0,
    lastAt: '2026-11-14T08:41:00.000Z',
    working: false,
    ...over,
  };
}

const opts = { me: ME, agentId: AGENT, agentName: 'Dusty', now, timeZone: tz };

describe('inbox rows', () => {
  it('shows the newest reply as the second line, links as words', () => {
    const [row] = inboxRows(
      [
        thread({
          text: 'Look at https://www.github.com/lumio/shop/pull/412\nplease',
          replyCount: 2,
          lastAt: '2026-11-14T09:55:00.000Z',
          last: {
            authorId: AGENT,
            text: 'Staged at https://staging.lumio.example.org',
            at: '2026-11-14T09:55:00.000Z',
          },
        }),
      ],
      new Map([['msg_a', 2]]),
      opts,
    );
    expect(row).toMatchObject({
      title: 'Look at github.com/lumio/shop/pull/412',
      who: 'Dusty',
      line: 'Staged at staging.lumio.example.org',
      unread: 2,
    });
  });

  it('says what a thread without replies is', () => {
    const rows = inboxRows(
      [
        thread(),
        thread({ rootId: 'msg_b', working: true }),
        thread({ rootId: 'msg_c', authorId: AGENT, text: 'Backups ran.' }),
      ],
      new Map(),
      opts,
    );
    expect(rows.map((r) => [r.who, r.line])).toEqual([
      [null, 'No reply yet'],
      [null, ''],
      [null, 'From Dusty'],
    ]);
  });

  it('never shows the open thread as new', () => {
    const [row] = inboxRows([thread()], new Map([['msg_a', 3]]), { ...opts, openRootId: 'msg_a' });
    expect(row?.unread).toBe(0);
  });
});

describe('a row’s icon, title and name', () => {
  const shop = { fullName: 'acme/shop', name: 'shop', iconUrl: '/api/v1/burrows/b/attachments/att_1' };

  it('shows the repository first, then what the thread is about, else the assistant', () => {
    const server = { kind: 'server' as const, id: 'pve-02', name: 'pve-02' };
    expect(inboxIcon({ repo: shop, subject: server })).toBe('repo');
    expect(inboxIcon({ repo: null, subject: server })).toBe('subject');
    expect(inboxIcon({})).toBe('agent');
  });

  it('splits off the repository’s name at the end of the title, in any case', () => {
    expect(splitRepoTitle('Hunt for bugs · Shop', 'shop')).toEqual({
      head: 'Hunt for bugs',
      tail: ' · Shop',
    });
    expect(splitRepoTitle('Hunt for bugs in shop', 'shop')).toEqual({
      head: 'Hunt for bugs in shop',
      tail: null,
    });
    expect(splitRepoTitle(' · shop', 'shop')).toEqual({ head: ' · shop', tail: null });
    expect(splitRepoTitle('Hunt for bugs · shop', null)).toEqual({
      head: 'Hunt for bugs · shop',
      tail: null,
    });
  });

  it('gives a repository its first letter', () => {
    expect(repoLetter('shop')).toBe('S');
    expect(repoLetter('.github')).toBe('G');
    expect(repoLetter('_')).toBe('?');
  });

  it('leaves the assistant’s name off its own replies, and keeps everyone else’s', () => {
    const at = '2026-11-14T09:55:00.000Z';
    const rows = inboxRows(
      [
        thread({ repo: shop, text: 'Hunt for bugs · shop', last: { authorId: AGENT, text: 'Done.', at } }),
        thread({ rootId: 'msg_b', last: { authorId: ME, text: 'Thanks.', at } }),
        thread({ rootId: 'msg_c', last: { authorId: 'prn_ann', text: 'Hi.', at } }),
        thread({ rootId: 'msg_d', subject: { kind: 'server', id: 'pve-02', name: 'pve-02' } }),
      ],
      new Map(),
      { ...opts, nameOf: () => 'Ann' },
    );
    expect(rows.map((r) => [r.who, r.shownWho])).toEqual([
      ['Dusty', null],
      ['You', 'You'],
      ['Ann', 'Ann'],
      [null, null],
    ]);
    expect(rows[0]).toMatchObject({
      title: 'Hunt for bugs · shop',
      titleHead: 'Hunt for bugs',
      titleTail: ' · shop',
      icon: 'repo',
      repoName: 'shop',
      repoIconUrl: shop.iconUrl,
      repoLetter: 'S',
    });
    expect(rows[3]).toMatchObject({
      icon: 'subject',
      subjectKind: 'server',
      subjectId: 'pve-02',
      repoName: null,
    });
  });
});

describe('filters and moving', () => {
  const rows = [
    { rootId: 'a', unread: 2, waiting: false },
    { rootId: 'b', unread: 0, waiting: true },
    { rootId: 'c', unread: 0, waiting: false },
  ] as InboxRow[];

  it('filters by unread and waiting and counts both', () => {
    expect(inboxFiltered(rows, 'unread').map((r) => r.rootId)).toEqual(['a']);
    expect(inboxFiltered(rows, 'waiting').map((r) => r.rootId)).toEqual(['b']);
    expect(inboxFiltered(rows, 'all')).toBe(rows);
    expect(inboxCounts(rows)).toEqual({ unread: 1, waiting: 1 });
  });

  it('opens the next thread after a settle, else the one above', () => {
    expect(nextRootAfter(rows, 'a')).toBe('b');
    expect(nextRootAfter(rows, 'c')).toBe('b');
    expect(nextRootAfter(rows.slice(0, 1), 'a')).toBeNull();
  });

  it('steps through rows with J and K', () => {
    expect(rowStep(rows, null, 1)).toBe('a');
    expect(rowStep(rows, 'a', 1)).toBe('b');
    expect(rowStep(rows, 'a', -1)).toBeNull();
  });
});

describe('the last reply', () => {
  const reply = (over: Partial<Message>) =>
    ({
      authorId: AGENT,
      text: '',
      attachments: [],
      createdAt: '2026-11-14T10:00:00.000Z',
      ...over,
    }) as Message;

  it('takes the first line, else the files, and nothing for a card', () => {
    expect(lastOfMessage(reply({ text: '**Done.**\nMore' }))?.text).toBe('Done. More');
    expect(
      lastOfMessage(reply({ text: 'Ready in [PR 69](https://github.com/acme/shop/pull/69).' }))?.text,
    ).toBe('Ready in PR 69.');
    expect(lastOfMessage(reply({ attachments: [{}, {}] as Message['attachments'] }))?.text).toBe('2 files');
    expect(lastOfMessage(reply({}))).toBeNull();
  });

  it('moves with a reply in a cached list', () => {
    const pages = [[thread({ replyCount: 1 })]];
    const m = {
      id: 'msg_r',
      conversationId: 'cnv_chat',
      threadRootId: 'msg_a',
      authorId: AGENT,
      text: 'Found it.',
      attachments: [],
      createdAt: '2026-11-14T10:46:00.000Z',
    } as unknown as Message;
    const next = threadPagesWithMessage(pages, m, { room: 'chat', state: 'open' }, 'chat');
    expect(next?.[0]?.[0]?.last).toEqual({ authorId: AGENT, text: 'Found it.', at: m.createdAt });
  });
});

describe('settling by itself', () => {
  it('shows the nearest offered choice', () => {
    expect(quietChoiceOf(null).label).toBe('Never');
    expect(quietChoiceOf(3).days).toBe(3);
    expect(quietChoiceOf(10).days).toBe(7);
    expect(plainLinks('see http://x.nl')).toBe('see x.nl');
  });
});
