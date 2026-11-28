import type { ChatThread, Handoff, Message } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  INBOX_WORDS,
  type InboxRow,
  inboxCounts,
  inboxFiltered,
  inboxIcon,
  inboxRows,
  lastOfMessage,
  nextRootAfter,
  plainLinks,
  quietChoiceOf,
  type RowStatusKind,
  repoLetter,
  rowStatus,
  rowStatusWords,
  rowStep,
  sameRowStatus,
  splitRepoTitle,
} from './inbox';
import { rootTitle, threadOfMessage, threadPagesWithMessage } from './threads';

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

  it('never calls a thread “No reply yet”: a card-only first message is called by its card', () => {
    const card = {
      kind: 'guide',
      guide: 'welcome',
      node: 'mail',
      title: 'Your email',
      body: '',
      blocks: [],
      state: 'open',
      answer: null,
    } as unknown as Message['card'];
    const root = {
      id: 'msg_m',
      conversationId: 'cnv_chat',
      threadRootId: null,
      authorId: AGENT,
      text: '',
      card,
      attachments: [],
      createdAt: '2026-11-14T10:00:00.000Z',
      replyCount: 0,
      lastReplyAt: null,
    } as unknown as Message;
    const live = threadOfMessage(root, 'chat');
    const [fromCard, older, mine] = inboxRows(
      [live, thread({ rootId: 'msg_o', authorId: AGENT, text: '' }), thread({ rootId: 'msg_p', text: '' })],
      new Map(),
      opts,
    );
    expect(fromCard?.title).toBe('Your email');
    expect(older?.title).toContain('Dusty');
    expect(mine?.title).not.toBe(INBOX_WORDS.noReply);
    for (const row of [fromCard, older, mine]) expect(row?.title).not.toBe(INBOX_WORDS.noReply);
    // The open thread's head says the same.
    expect(rootTitle(root)).toBe('Your email');
    // A card without a title of its own is called by its kind.
    expect(rootTitle({ ...root, card: { kind: 'approval' } as unknown as Message['card'] })).not.toBe('');
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
  const st = (kind: RowStatusKind) => ({ kind, words: kind, named: false, since: null, line: null });
  const rows = [
    { rootId: 'a', unread: 2, waiting: false, status: null },
    { rootId: 'b', unread: 0, waiting: true, status: st('waiting') },
    { rootId: 'c', unread: 0, waiting: false, status: null },
  ] as InboxRow[];
  const stood = [
    ...rows,
    { rootId: 'd', unread: 0, waiting: false, status: st('working') },
    { rootId: 'e', unread: 0, waiting: false, status: st('checks') },
    { rootId: 'f', unread: 0, waiting: false, status: st('done') },
    { rootId: 'g', unread: 0, waiting: false, status: st('failed') },
  ] as InboxRow[];

  it('filters by unread, waiting, working and done and counts each', () => {
    expect(inboxFiltered(stood, 'unread').map((r) => r.rootId)).toEqual(['a']);
    expect(inboxFiltered(stood, 'waiting').map((r) => r.rootId)).toEqual(['b']);
    expect(inboxFiltered(stood, 'working').map((r) => r.rootId)).toEqual(['d', 'e']);
    expect(inboxFiltered(stood, 'done').map((r) => r.rootId)).toEqual(['f', 'g']);
    expect(inboxFiltered(stood, 'all')).toBe(stood);
    expect(inboxCounts(stood)).toEqual({ unread: 1, waiting: 1, working: 2, done: 2 });
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

describe('where a row stands', () => {
  const ROOT = 'msg_a';
  function handoff(over: Partial<Handoff> = {}): Handoff {
    return {
      id: 't3_1',
      to: 't3code',
      conversationId: 'cnv_chat',
      rootId: ROOT,
      agentId: AGENT,
      title: 'Dusty - Fix Settle',
      state: 'working',
      since: '2026-11-14T11:16:00.000Z',
      endedAt: null,
      outcome: null,
      steps: [
        { text: 'Reading the code', detail: null, done: true },
        { text: 'Running the tests', detail: null, done: false },
      ],
      asks: null,
      pullRequests: [],
      program: null,
      url: null,
      ...over,
    } as Handoff;
  }
  const statusOf = (t: Partial<ChatThread>, handoffs: Handoff[] = [], live = false) =>
    rowStatus(thread({ rootId: ROOT, ...t }), handoffs, { live, me: ME, agentName: 'Dusty' });

  it('says nothing when nothing goes on and nothing ended', () => {
    expect(statusOf({})).toBeNull();
  });

  it('puts what waits for the person first, T3 Code asking for their OK too', () => {
    expect(statusOf({ waiting: true, working: true })?.kind).toBe('waiting');
    const ok = statusOf({}, [handoff({ state: 'needs_ok', asks: 'push to main' })]);
    expect(ok).toMatchObject({ kind: 'waiting', words: INBOX_WORDS.waitingForYou });
    expect(ok?.line).toContain('push to main');
  });

  it('says who works on it: the assistant, or T3 Code with its clock and step', () => {
    expect(statusOf({ working: true })).toMatchObject({ kind: 'working', line: null });
    expect(statusOf({ working: true })?.words).toContain('Dusty');
    expect(statusOf({}, [], true)?.kind).toBe('working');
    const t3 = statusOf({ handedOver: true }, [handoff()]);
    expect(t3).toMatchObject({ kind: 'working', line: 'Running the tests' });
    expect(t3?.words).toContain('T3 Code');
    expect(t3 && rowStatusWords(t3, now.getTime())).toMatch(/· 6m$/);
    expect(statusOf({ handedOver: true })).toMatchObject({ kind: 'working', words: INBOX_WORDS.working });
  });

  it('waits for checks quietly', () => {
    const s = statusOf({ handedOver: true }, [handoff({ state: 'checks', pullRequests: ['#342'] })]);
    expect(s).toMatchObject({ kind: 'checks', words: INBOX_WORDS.waitingChecks, since: null });
  });

  it('says how the latest job ended, from the server or a hand-over that just ended', () => {
    const job = { outcome: 'completed' as const, endedAt: '2026-11-14T10:00:00.000Z' };
    expect(statusOf({ job })).toMatchObject({ kind: 'done', words: INBOX_WORDS.done });
    expect(statusOf({ job: { ...job, outcome: 'failed' } })).toMatchObject({ kind: 'failed' });
    expect(statusOf({ job: { ...job, outcome: 'stopped' } })).toMatchObject({ kind: 'stopped' });
    const ended = handoff({ state: 'ended', outcome: 'failed', endedAt: '2026-11-14T11:00:00.000Z' });
    expect(statusOf({ job }, [ended])?.kind).toBe('failed');
  });

  it('drops the end once the person wrote after it, and work going on wins over it', () => {
    const job = { outcome: 'completed' as const, endedAt: '2026-11-14T10:00:00.000Z' };
    expect(
      statusOf({ job, last: { authorId: ME, text: 'And now?', at: '2026-11-14T10:05:00.000Z' } }),
    ).toBeNull();
    expect(
      statusOf({ job, last: { authorId: AGENT, text: 'Done.', at: '2026-11-14T10:05:00.000Z' } })?.kind,
    ).toBe('done');
    expect(statusOf({ job, working: true })?.kind).toBe('working');
  });

  it('marks the row: waiting and working ones don’t settle, and T3 Code’s step stands in for the reply', () => {
    const [row] = inboxRows([thread({ rootId: ROOT, handedOver: true })], new Map(), {
      ...opts,
      handoffs: [handoff()],
    });
    expect(row).toMatchObject({ working: true, settleable: false, waiting: false });
    expect(row?.status?.line).toBe('Running the tests');
    const [asks] = inboxRows([thread({ rootId: ROOT })], new Map(), {
      ...opts,
      handoffs: [handoff({ state: 'needs_ok' })],
    });
    expect(asks).toMatchObject({ waiting: true, settleable: false });
  });

  it('keeps a status that reads the same', () => {
    const a = statusOf({ working: true });
    expect(sameRowStatus(a, statusOf({ working: true }))).toBe(true);
    expect(sameRowStatus(a, statusOf({ waiting: true }))).toBe(false);
    expect(sameRowStatus(null, null)).toBe(true);
  });
});
