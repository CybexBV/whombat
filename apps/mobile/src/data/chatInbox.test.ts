/**
 * Chat as an inbox on the phone (Whombat chat-inbox.md; app chat-inbox-phone.md): a row's spoken label, its swipes and
 * menu by its state, the filters' empty words, the “New” line in a thread and how
 * tall the message box grows.
 */
import { INBOX_WORDS, type InboxRow, inboxCounts, inboxFiltered, inboxRows } from '@whombat/client';
import type { ChatThread, Message } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  COMPOSER_MIN_CAP,
  composerMaxHeight,
  inboxActions,
  inboxEmpty,
  inboxRowLabel,
  inboxSwipe,
  parseInboxAction,
  plusLabel,
  repoTone,
  threadPlaceholderFromList,
  threadReadUpTo,
} from './chatInbox';

const ME = 'prn_mara';
const NEO = 'prn_neo';
const now = new Date('2026-11-14T13:22:00.000Z');

function thread(over: Partial<ChatThread> = {}): ChatThread {
  return {
    conversationId: 'cnv_chat',
    room: 'chat',
    rootId: 'msg_a',
    authorId: ME,
    text: 'Why is pve-02 using so much memory?',
    createdAt: '2026-11-14T09:41:00.000Z',
    replyCount: 1,
    lastAt: '2026-11-14T09:48:00.000Z',
    working: false,
    last: { authorId: NEO, text: 'Shall I cap the cache at 16 GB?', at: '2026-11-14T09:48:00.000Z' },
    ...over,
  };
}

const rowsOf = (threads: ChatThread[], unread: [string, number][] = []) =>
  inboxRows(threads, new Map(unread), {
    me: ME,
    agentId: NEO,
    agentName: 'Neo',
    now,
    timeZone: 'Europe/Amsterdam',
  });

function row(over: Partial<InboxRow> = {}): InboxRow {
  return {
    rootId: 'msg_a',
    href: '/chat?thread=msg_a',
    title: 'Why is pve-02 using so much memory?',
    who: 'Neo',
    line: 'Shall I cap the cache at 16 GB?',
    when: '10:48',
    unread: 0,
    waiting: false,
    working: false,
    settleable: true,
    markable: true,
    shownWho: null,
    titleHead: 'Why is pve-02 using so much memory?',
    titleTail: null,
    icon: 'agent',
    repoName: null,
    repoIconUrl: null,
    repoLetter: null,
    subjectKind: null,
    subjectId: null,
    subjectName: null,
    ...over,
  };
}

describe('a row as a screen reader hears it', () => {
  it('names the thread, what is new, that it waits for you, the latest line and the time', () => {
    const [r] = rowsOf([thread({ waiting: true })], [['msg_a', 2]]);
    if (!r) throw new Error('no row');
    const label = inboxRowLabel(r);
    expect(label).toContain('Why is pve-02 using so much memory?');
    expect(label).toContain('2 new messages');
    expect(label).toContain('waiting for you');
    expect(label).toContain('Neo: Shall I cap');
  });

  it('says nothing new on a read row, and “working” while the assistant works', () => {
    const label = inboxRowLabel(row({ working: true, who: null, line: '' }));
    expect(label).not.toContain('new message');
    expect(label).toContain('working');
    expect(label.endsWith('10:48')).toBe(true);
  });

  it('says the repository when the title doesn’t, and the assistant’s name though the row hides it', () => {
    const [r] = rowsOf([thread({ text: 'Hunt for bugs', repo: { fullName: 'acme/shop', name: 'shop' } })]);
    if (!r) throw new Error('no row');
    expect(r.shownWho).toBeNull();
    const label = inboxRowLabel(r);
    expect(label.startsWith('Hunt for bugs, shop,')).toBe(true);
    expect(label).toContain('Neo: Shall I cap');
    expect(inboxRowLabel(row({ title: 'Hunt for bugs · Shop', repoName: 'shop' }))).not.toContain(
      'Shop, shop',
    );
  });

  it('names the message box’s “+” by what it offers', () => {
    expect(plusLabel(['camera', 'photos', 'files'])).toContain('Attach');
    expect(plusLabel(['prompts'])).toBe('Prompts');
    expect(plusLabel(['files', 'prompts'])).toContain('prompt');
  });

  it('gives a repository’s letter tile the same tone every time', () => {
    expect(repoTone('shop')).toBe(repoTone('Shop'));
  });
});

describe('the swipes and the menu by the row’s state', () => {
  it('settles a row that may settle, and marks a read one unread', () => {
    expect(inboxSwipe(row())).toEqual({ settle: true, mark: 'unread' });
  });

  it('marks a row with something new read, and doesn’t settle what waits or works', () => {
    expect(inboxSwipe(row({ unread: 3, settleable: false }))).toEqual({ settle: false, mark: 'read' });
  });

  it('offers no Mark as unread where nothing came from someone else', () => {
    expect(inboxSwipe(row({ markable: false, settleable: false }))).toEqual({ settle: false, mark: null });
  });

  it('gives the menu the swipes’ actions, then the link and Share where there are', () => {
    const swipe = inboxSwipe(row({ unread: 1 }));
    expect(inboxActions(swipe, { link: true, share: true }).map((a) => a.id)).toEqual([
      'settle',
      'mark_read',
      'copy_link',
      'share',
    ]);
    expect(inboxActions(inboxSwipe(row()), { link: false, share: false }).map((a) => a.title)).toEqual([
      'Settle',
      INBOX_WORDS.markUnread,
    ]);
    expect(parseInboxAction('mark_unread')).toBe('mark_unread');
    expect(parseInboxAction('delete')).toBeNull();
  });
});

describe('the filters', () => {
  const rows = rowsOf(
    [
      thread({ rootId: 'msg_a', waiting: true }),
      thread({ rootId: 'msg_b' }),
      thread({ rootId: 'msg_c', working: true, authorId: ME, last: undefined, replyCount: 0 }),
    ],
    [['msg_b', 1]],
  );

  it('counts the unread and the waiting rows and shows each filter’s', () => {
    expect(inboxCounts(rows)).toEqual({ unread: 1, waiting: 1 });
    expect(inboxFiltered(rows, 'unread').map((r) => r.rootId)).toEqual(['msg_b']);
    expect(inboxFiltered(rows, 'waiting').map((r) => r.rootId)).toEqual(['msg_a']);
  });

  it('has words for each filter with nothing in it', () => {
    expect(inboxEmpty('all')).toEqual({ title: INBOX_WORDS.allSettled, hint: INBOX_WORDS.allSettledHint });
    expect(inboxEmpty('unread').title).toBe(INBOX_WORDS.nothingNew);
    expect(inboxEmpty('waiting')).toEqual({ title: INBOX_WORDS.nothingWaits, hint: null });
  });
});

describe('the “New” line in a thread', () => {
  const m = (id: string, authorId: string, deletedAt: string | null = null) =>
    ({ id, authorId, deletedAt }) as Pick<Message, 'id' | 'authorId' | 'deletedAt'>;
  const messages = [m('r', ME), m('a', NEO), m('b', ME), m('c', NEO), m('d', NEO)];

  it('goes after the message before the first new one, counting back over others’ messages', () => {
    expect(threadReadUpTo(messages, 1, ME)).toBe('c');
    expect(threadReadUpTo(messages, 2, ME)).toBe('b');
    expect(threadReadUpTo(messages, 3, ME)).toBe('r');
  });

  it('has none when nothing is new, or the first new one is the thread’s first or not loaded', () => {
    expect(threadReadUpTo(messages, 0, ME)).toBeNull();
    expect(threadReadUpTo([m('r', NEO), m('a', NEO)], 2, ME)).toBeNull();
    expect(threadReadUpTo(messages, 9, ME)).toBeNull();
  });
});

describe('the message box', () => {
  it('grows to 40 % of the screen, never capped under its old 120', () => {
    expect(composerMaxHeight(800)).toBe(320);
    expect(composerMaxHeight(932)).toBe(373);
    expect(composerMaxHeight(240)).toBe(COMPOSER_MIN_CAP);
  });
});

describe('a thread’s root while it loads', () => {
  it('comes from the inbox’s list when its whole first line is there', () => {
    const view = threadPlaceholderFromList([{ pages: [{ threads: [thread()] }] }], 'msg_a');
    expect(view?.root).toMatchObject({
      id: 'msg_a',
      text: 'Why is pve-02 using so much memory?',
      replyCount: 1,
    });
    expect(view?.replies).toEqual([]);
  });

  it('isn’t made from a text the list cut short', () => {
    const long = thread({ text: 'x'.repeat(200) });
    expect(threadPlaceholderFromList([{ pages: [{ threads: [long] }] }], 'msg_a')).toBeUndefined();
  });
});
