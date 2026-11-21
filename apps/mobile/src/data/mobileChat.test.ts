/**
 * Mobile chat (MX-01…MX-08): following the end and the “New messages ↓” pill, anchors (links that open a conversation
 * at a message), the kept drafts, Copy text / Copy link, day dividers and the “New” line, and the shared files' copies —
 * the pure parts.
 */
import { defaultCrypto } from '@libp2p/noise/crypto';
import { type DeployCard, formatDayDivider, type Message, type ThreadView } from '@whombat/core';
import { DM_DUSTY_MESSAGES, dusty, mara, SEED_NOW } from '@whombat/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DELEGATION_ID, delegationThread } from '../fixtures/delegation';
import { appUrlForPath, routeForLink, urlTarget } from '../navigation/routes';
import { worldContext } from '../test/world';
import { tilePicture } from './attachments';
import { ANCHOR_MAX_PAGES, anchorStep, followAction, isAtEnd, pinnedMessageOpen } from './chatScroll';
import { createDraftStore, DRAFT_SAVE_MS, DRAFT_TTL_MS, DRAFTS_MAX, draftKey, keptDrafts } from './drafts';
import { messageLinkPath, messageMenu, messageViewer } from './messageActions';
import { cardSummary, chatItems, firstUnreadId } from './messages';
import { type BoxCrypto, createSecureBox, memoryBoxDeps } from './secureBox';
import {
  cachedShareFiles,
  clearShare,
  currentShare,
  putShare,
  type SharedPayload,
  setShareFileCleaner,
  wipeShares,
} from './shareInbox';
import { movedCardLinks, THREAD_PAGE_SIZE, threadMessages, threadQuery } from './threadPages';
import { offersStop, stopConfirm } from './turns';

const ctx = worldContext();
const base = DM_DUSTY_MESSAGES[1] as Message;
const at = (minutesAgo: number) => new Date(SEED_NOW.getTime() - minutesAgo * 60_000).toISOString();
const msg = (id: string, over: Partial<Message> = {}): Message => ({
  ...base,
  id,
  card: null,
  text: id,
  replyCount: 0,
  threadRootId: null,
  ...over,
});

describe('following the end (MX-01)', () => {
  it('opens at the end, follows only a reader who is there, and shows the pill to one further up', () => {
    // The first messages: to the end, unless a link opens the list at a message.
    expect(followAction({ atEnd: true, seen: '', last: 'msg_2', anchored: false })).toBe('end');
    expect(followAction({ atEnd: true, seen: '', last: 'msg_2', anchored: true })).toBe('none');
    expect(followAction({ atEnd: true, seen: '', last: '', anchored: false })).toBe('none');
    // At the end: a new message, the thinking row, the keyboard — all followed.
    expect(followAction({ atEnd: true, seen: 'msg_2', last: 'msg_3', anchored: false })).toBe('end');
    expect(followAction({ atEnd: true, seen: 'msg_2', last: 'msg_2', anchored: false })).toBe('end');
    // Reading further up: a new message shows the pill; the thinking row or an older page changes nothing.
    expect(followAction({ atEnd: false, seen: 'msg_2', last: 'msg_3', anchored: false })).toBe('pill');
    expect(followAction({ atEnd: false, seen: 'msg_2', last: 'msg_2', anchored: false })).toBe('none');
    // Opened at a message near the end: what arrives shows the pill rather than pulling the reader away.
    expect(followAction({ atEnd: true, seen: 'msg_2', last: 'msg_3', anchored: true })).toBe('pill');
    // A thread folding out of the list: the scroll view keeps its end; a new message at the same time is followed.
    expect(followAction({ atEnd: true, seen: 'msg_2', last: 'msg_2', anchored: false, shrank: true })).toBe(
      'none',
    );
    expect(followAction({ atEnd: true, seen: 'msg_2', last: 'msg_3', anchored: false, shrank: true })).toBe(
      'end',
    );
  });

  it('waits while the reader scrolls, instead of pulling the list from under their finger', () => {
    const reading = { atEnd: true, seen: 'msg_2', anchored: false, reader: true };
    // Still within the end's slack as they start to scroll up: rows drawn above, the thinking row, a new message.
    expect(followAction({ ...reading, last: 'msg_2' })).toBe('later');
    expect(followAction({ ...reading, last: 'msg_3' })).toBe('later');
    expect(followAction({ ...reading, seen: '', last: 'msg_3' })).toBe('later');
    // Further up, a new message still shows the pill at once.
    expect(followAction({ ...reading, atEnd: false, last: 'msg_3' })).toBe('pill');
    // Once they let go, at the end, it follows.
    expect(followAction({ ...reading, reader: false, last: 'msg_3' })).toBe('end');
  });

  it('counts the last 80dp as the end', () => {
    const pos = (y: number) => ({
      contentOffset: { y },
      layoutMeasurement: { height: 600 },
      contentSize: { height: 2000 },
    });
    expect(isAtEnd(pos(1400))).toBe(true);
    expect(isAtEnd(pos(1320))).toBe(true);
    expect(isAtEnd(pos(1319))).toBe(false);
  });
});

describe('opening at a message (MX-03)', () => {
  const items = [{ id: 'msg_1' }, { id: 'msg_run', inside: [{ id: 'msg_skill' }] }, { id: 'msg_3' }];

  it('shows a loaded message (or the run it is folded into), loads older pages until it is there, bounded', () => {
    expect(anchorStep({ anchor: 'msg_3', items, hasMore: true, loading: false, pagesLoaded: 1 })).toEqual({
      kind: 'show',
      index: 2,
      id: 'msg_3',
    });
    expect(
      anchorStep({ anchor: 'msg_skill', items, hasMore: false, loading: false, pagesLoaded: 1 }),
    ).toEqual({
      kind: 'show',
      index: 1,
      id: 'msg_run',
    });
    expect(anchorStep({ anchor: 'msg_0', items, hasMore: true, loading: false, pagesLoaded: 1 })).toEqual({
      kind: 'load',
    });
    expect(anchorStep({ anchor: 'msg_0', items, hasMore: true, loading: true, pagesLoaded: 2 })).toEqual({
      kind: 'wait',
    });
    expect(
      anchorStep({ anchor: 'msg_0', items, hasMore: true, loading: false, pagesLoaded: ANCHOR_MAX_PAGES }),
    ).toEqual({ kind: 'missing' });
    expect(anchorStep({ anchor: 'msg_0', items, hasMore: false, loading: false, pagesLoaded: 1 })).toEqual({
      kind: 'missing',
    });
  });

  it('keeps the message a web link names, in a branch room and a thread’s reply', () => {
    expect(appUrlForPath('/pr/482#msg_42')).toBe('whombat://pr/482?anchor=msg_42');
    expect(appUrlForPath('/burrow-hq/pr/482?burrow=burrow-hq#msg_42')).toBe('whombat://pr/482?anchor=msg_42');
    expect(appUrlForPath('/pr/482?repo=acme/site#msg_42')).toBe(
      'whombat://pr/482?repo=acme%2Fsite&anchor=msg_42',
    );
    expect(appUrlForPath('/chat?thread=msg_0#msg_7')).toBe('whombat://threads/msg_0?anchor=msg_7');
    // The root itself, or a fragment that isn't a message id: just the thread, the conversation.
    expect(appUrlForPath('/chat?thread=msg_0#msg_0')).toBe('whombat://threads/msg_0');
    expect(appUrlForPath('/pr/482#heading')).toBe('whombat://pr/482');
    expect(appUrlForPath('/pr/482#msg_bad id')).toBe('whombat://pr/482');
    // A notification's path and a tapped web link take it along too.
    expect(urlTarget('https://app.whombat.com/pr/482#msg_42', ['https://app.whombat.com'])).toMatchObject({
      kind: 'app',
      url: 'whombat://pr/482?anchor=msg_42',
    });
  });

  it('opens message links — mention pushes, inbox rows, search results — at the message', () => {
    const where = { type: 'pr' as const, number: 482 };
    expect(routeForLink({ type: 'message', in: where, messageId: 'msg_9' }, null, 'Search')).toEqual({
      name: 'Conversation',
      params: { prNumber: 482, anchor: 'msg_9' },
    });
    expect(
      routeForLink({ type: 'message', in: where, messageId: 'msg_9', threadRootId: 'msg_1' }, null, 'Inbox'),
    ).toEqual({ name: 'Thread', params: { messageId: 'msg_1', back: 'Inbox', anchor: 'msg_9' } });
    // A link to a thread's root opens the thread at its top, as before.
    expect(
      routeForLink({ type: 'message', in: where, messageId: 'msg_1', threadRootId: 'msg_1' }, null),
    ).toEqual({ name: 'Thread', params: { messageId: 'msg_1' } });
    // A top-level message in Chat is its own thread (CHT-02, AP-4962).
    expect(routeForLink({ type: 'message', in: { type: 'dm' }, messageId: 'msg_9' }, null)).toEqual({
      name: 'Thread',
      params: { messageId: 'msg_9' },
    });
  });

  it('opens a pinned message in its thread, or back in the conversation below at the message', () => {
    expect(pinnedMessageOpen({ id: 'msg_9', threadRootId: 'msg_1' }, 'cnv_1', 'Conversation')).toEqual({
      kind: 'thread',
      messageId: 'msg_1',
      anchor: 'msg_9',
    });
    expect(pinnedMessageOpen({ id: 'msg_9', threadRootId: null }, 'cnv_1', 'Conversation')).toEqual({
      kind: 'back',
      anchor: 'msg_9',
    });
    expect(pinnedMessageOpen({ id: 'msg_9', threadRootId: null }, 'cnv_1', undefined)).toEqual({
      kind: 'conversation',
      conversationId: 'cnv_1',
      anchor: 'msg_9',
    });
  });
});

describe('a moved card’s link in a thread (card-moves.md CM-07)', () => {
  const card = delegationThread(SEED_NOW.getTime(), 'working').reply.card;
  const intro = msg('msg_intro', {
    authorId: dusty.id,
    threadRootId: 'msg_root' as Message['threadRootId'],
    movedCard: { kind: 'delegation', id: DELEGATION_ID },
  });
  const moved = msg('msg_card', {
    authorId: dusty.id,
    threadRootId: 'msg_root' as Message['threadRootId'],
    card,
  });
  const thread = [msg('msg_root'), intro, msg('msg_reply'), moved];

  it('goes from the message the card left to the message that holds it now, which the anchor then finds', () => {
    const links = movedCardLinks(thread);
    expect([...links.keys()]).toEqual(['msg_intro']);
    const link = links.get('msg_intro');
    expect(link?.targetId).toBe('msg_card');
    expect(link?.label).toContain('Tasks');
    const items = chatItems(thread, ctx, { authors: true });
    expect(
      anchorStep({ anchor: link?.targetId ?? '', items, hasMore: false, loading: false, pagesLoaded: 1 }),
    ).toMatchObject({ kind: 'show', id: 'msg_card' });
  });

  it('draws nothing when the card is not in the thread as loaded, or is another kind of card', () => {
    expect(movedCardLinks([msg('msg_root'), intro]).size).toBe(0);
    const other = msg('msg_other', { movedCard: { kind: 'council', id: DELEGATION_ID } });
    expect(movedCardLinks([other, moved]).size).toBe(0);
  });
});

describe('drafts (MX-02)', () => {
  const setup = () => {
    let now = 1_000_000;
    const timers: (() => void)[] = [];
    const store = createDraftStore({
      box: createSecureBox(memoryBoxDeps(defaultCrypto as unknown as BoxCrypto)),
      scope: 'managed:org/wb',
      now: () => now,
      setTimer: (run) => {
        timers.push(run);
        return timers.length;
      },
      clearTimer: (t) => {
        timers[(t as number) - 1] = () => {};
      },
    });
    return { store, timers, tick: (ms: number) => (now += ms) };
  };

  it('keeps a draft per conversation and per thread, saved once the typing rests, cleared by sending', async () => {
    const box = createSecureBox(memoryBoxDeps(defaultCrypto as unknown as BoxCrypto));
    const saves = vi.spyOn(box, 'save');
    const timers: (() => void)[] = [];
    const store = createDraftStore({
      box,
      scope: 's',
      setTimer: (run) => timers.push(run),
      clearTimer: () => {},
    });
    expect(draftKey('cnv_1', null)).toBe('cnv_1');
    expect(draftKey('cnv_1', 'msg_root')).toBe('cnv_1/msg_root');
    store.set('cnv_1', 'Hello');
    store.set('cnv_1', 'Hello @Dusty');
    store.set('cnv_1/msg_root', 'In the thread');
    expect(store.get('cnv_1')).toBe('Hello @Dusty');
    expect(store.get('cnv_1/msg_root')).toBe('In the thread');
    expect(saves).not.toHaveBeenCalled();
    await timers.at(-1)?.();
    expect(saves).toHaveBeenCalledTimes(1);
    // Sending clears the composer: the draft goes.
    store.set('cnv_1', '');
    expect(store.get('cnv_1')).toBe('');
    // A new launch reads what was kept.
    const again = createDraftStore({ box, scope: 's' });
    await again.load();
    expect(again.loaded()).toBe(true);
    expect(again.get('cnv_1')).toBe('Hello @Dusty');
    expect(again.get('cnv_1/msg_root')).toBe('In the thread');
  });

  it('lets drafts typed before the device’s are read win, and says once they are in', async () => {
    const { store } = setup();
    const heard = vi.fn();
    store.onLoad(heard);
    store.set('cnv_1', 'typed now');
    await store.load();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(store.get('cnv_1')).toBe('typed now');
    // Once loaded, a listener added later is not called again.
    const late = vi.fn();
    store.onLoad(late);
    expect(late).not.toHaveBeenCalled();
  });

  it('writes nothing after it is disposed (the box may be wiped), and flushes a waiting save on demand', async () => {
    const box = createSecureBox(memoryBoxDeps(defaultCrypto as unknown as BoxCrypto));
    const saves = vi.spyOn(box, 'save');
    const timers: (() => void)[] = [];
    const store = createDraftStore({
      box,
      scope: 's',
      setTimer: (run) => timers.push(run),
      clearTimer: () => {},
    });
    store.set('cnv_1', 'one');
    await store.flush();
    expect(saves).toHaveBeenCalledTimes(1);
    store.set('cnv_1', 'two');
    store.dispose();
    await timers.at(-1)?.();
    expect(saves).toHaveBeenCalledTimes(1);
    expect(DRAFT_SAVE_MS).toBeGreaterThan(0);
  });

  it('keeps the newest drafts only, none empty or too old', () => {
    const now = 10 * DRAFT_TTL_MS;
    const many = Object.fromEntries(
      Array.from({ length: DRAFTS_MAX + 5 }, (_, i) => [`cnv_${i}`, { text: `t${i}`, at: now - i }]),
    );
    const kept = keptDrafts(
      { ...many, empty: { text: '  ', at: now }, old: { text: 'x', at: now - DRAFT_TTL_MS } },
      now,
    );
    expect(Object.keys(kept)).toHaveLength(DRAFTS_MAX);
    expect(kept.cnv_0?.text).toBe('t0');
    expect(kept.empty).toBeUndefined();
    expect(kept.old).toBeUndefined();
    expect(kept[`cnv_${DRAFTS_MAX + 4}`]).toBeUndefined();
  });
});

describe('Copy text and Copy link (MX-04)', () => {
  const me = messageViewer({ id: mara.id });
  const features = { edit: true, pins: true, link: true };

  it('offers Copy text on a message with text and Copy link where it has a web address', () => {
    const kinds = (m: Message, f = features) =>
      messageMenu(m, me, { inThread: false, features: f })?.actions.map((a) => a.kind);
    expect(kinds(msg('msg_1', { authorId: dusty.id }))).toEqual([
      'reply_thread',
      'copy_text',
      'copy_link',
      'pin',
      'delete',
    ]);
    // Files only: nothing to copy as text; the demo world has no web address.
    expect(kinds(msg('msg_1', { authorId: dusty.id, text: '' }), { ...features, link: false })).toEqual([
      'reply_thread',
      'pin',
      'delete',
    ]);
    // A tombstone keeps its link, not its (gone) text.
    expect(kinds(msg('msg_1', { authorId: mara.id, deletedAt: SEED_NOW.toISOString() }))).toEqual([
      'reply_thread',
      'copy_link',
    ]);
  });

  it('copies the link the web and the phone open at the message', () => {
    const top = messageLinkPath({ id: 'msg_9', threadRootId: null }, { type: 'pr', number: 482 }, 'hq');
    expect(appUrlForPath(top)).toBe('whombat://pr/482?anchor=msg_9');
    const reply = messageLinkPath({ id: 'msg_9', threadRootId: 'msg_1' }, { type: 'dm' }, 'hq');
    expect(reply).toContain('thread=msg_1');
    expect(reply).toContain('burrow=hq');
    expect(appUrlForPath(reply)).toBe('whombat://threads/msg_1?anchor=msg_9');
  });
});

describe('day dividers and the “New” line (MX-05)', () => {
  const day = 24 * 60;
  const messages = [
    msg('msg_a', { authorId: dusty.id, createdAt: at(day + 30) }),
    msg('msg_b', { authorId: dusty.id, createdAt: at(day + 27) }),
    msg('msg_c', { authorId: mara.id, createdAt: at(40) }),
    msg('msg_d', { authorId: dusty.id, createdAt: at(30) }),
    msg('msg_e', { authorId: dusty.id, createdAt: at(27) }),
  ];

  it('puts a divider above the first message of each day, and names the author again under it', () => {
    const items = chatItems(messages, ctx, { authors: true });
    expect(items.map((i) => i.day)).toEqual([
      formatDayDivider(at(day + 30), ctx.now, ctx.timeZone),
      null,
      formatDayDivider(at(40), ctx.now, ctx.timeZone),
      null,
      null,
    ]);
    expect(items[2]?.day).toMatch(/^Today · /);
    expect(items.map((i) => i.showAuthor)).toEqual([true, false, true, true, false]);
  });

  it('marks the same author’s next message, which gets a line above it (AP-6144)', () => {
    expect(chatItems(messages, ctx, { authors: true }).map((i) => i.continues)).toEqual([
      false,
      true,
      false,
      false,
      true,
    ]);
    expect(chatItems(messages, ctx, { authors: true, everyAuthor: true }).some((i) => i.continues)).toBe(
      false,
    );
  });

  it('names the author and the time again when the same author writes after a pause, as on the web', () => {
    const later = [
      msg('msg_p1', { authorId: dusty.id, createdAt: at(30) }),
      msg('msg_p2', { authorId: dusty.id, createdAt: at(26) }),
      msg('msg_p3', { authorId: dusty.id, createdAt: at(12) }),
    ];
    const items = chatItems(later, ctx, { authors: true });
    expect(items.map((i) => i.showAuthor)).toEqual([true, false, true]);
    expect(items.map((i) => i.continues)).toEqual([false, true, false]);
  });

  it('names every thread’s author in a threaded room (chat-channel.md AP-2453)', () => {
    const items = chatItems(messages, ctx, { authors: true, everyAuthor: true });
    expect(items.map((i) => i.showAuthor)).toEqual([true, true, true, true, true]);
  });

  it('finds the first message by someone else after where the viewer had read', () => {
    expect(firstUnreadId(messages, 'msg_b', mara.id, false)).toBe('msg_d');
    expect(firstUnreadId(messages, 'msg_e', mara.id, false)).toBeNull();
    // Never read, or the read point gone: no line. Read before everything loaded: the first loaded one.
    expect(firstUnreadId(messages, null, mara.id, true)).toBeNull();
    expect(firstUnreadId(messages, 'msg_gone', mara.id, false)).toBeNull();
    expect(firstUnreadId(messages, 'msg_older', mara.id, true)).toBe('msg_a');
  });

  it('marks it once, and names its author again', () => {
    const items = chatItems(messages, ctx, { authors: true, readUpTo: 'msg_c' });
    expect(items.map((i) => i.unread)).toEqual([false, false, false, true, false]);
    expect(items[3]?.showAuthor).toBe(true);
    expect(chatItems(messages, ctx, { authors: true }).some((i) => i.unread)).toBe(false);
  });
});

describe('PR files from links (MX-06)', () => {
  it('opens the Files changed tab and one of its files on the phone', () => {
    expect(appUrlForPath('/pr/482?repo=acme/site&tab=files&file=src/app/main.tsx')).toBe(
      'whombat://pr/482/file?path=src%2Fapp%2Fmain.tsx&repo=acme%2Fsite',
    );
    expect(appUrlForPath('/burrow-hq/pr/482?tab=files')).toBe('whombat://pr/482/files');
    // A file name with a control character is not a path.
    expect(appUrlForPath('/pr/482?tab=files&file=a%0Ab')).toBe('whombat://pr/482/files');
  });
});

describe('shared files’ copies (MX-07)', () => {
  const CACHE = 'file:///data/user/0/com.whombat.mobile/cache/';
  const file = (uri: string) => ({ uri, name: 'x', type: 'image/jpeg', size: 1 });
  const payload = (...uris: string[]): Omit<SharedPayload, 'id'> => ({
    text: '',
    files: uris.map(file),
    dropped: 0,
    unreadable: 0,
  });
  afterEach(() => {
    wipeShares();
    setShareFileCleaner(null);
  });

  it('deletes only copies directly in the cache directory', () => {
    expect(
      cachedShareFiles(
        [
          file('/data/user/0/com.whombat.mobile/cache/IMG_1.jpg'),
          file('file:///data/user/0/com.whombat.mobile/cache/report.pdf'),
          file('/storage/emulated/0/DCIM/Camera/IMG_2.jpg'),
          file('/data/user/0/com.whombat.mobile/cache/ImagePicker/x.jpg'),
          file('/data/user/0/com.whombat.mobile/cache/../files/secret'),
        ],
        CACHE,
      ),
    ).toEqual([
      '/data/user/0/com.whombat.mobile/cache/IMG_1.jpg',
      '/data/user/0/com.whombat.mobile/cache/report.pdf',
    ]);
    expect(cachedShareFiles([file('/a')], '')).toEqual([]);
  });

  it('deletes a share’s copies once it is sent or cancelled, replaced, or wiped', () => {
    const removed: string[][] = [];
    setShareFileCleaner({ cacheDir: CACHE, remove: (paths) => removed.push([...paths]) });
    const first = putShare(payload('/data/user/0/com.whombat.mobile/cache/a.jpg'));
    // Replaced by a newer share: the older one's copies go, except a file both share (copied to the same name).
    putShare(
      payload('/data/user/0/com.whombat.mobile/cache/a.jpg', '/data/user/0/com.whombat.mobile/cache/b.jpg'),
    );
    expect(removed).toEqual([]);
    putShare(payload('/data/user/0/com.whombat.mobile/cache/c.jpg'));
    expect(removed).toEqual([
      ['/data/user/0/com.whombat.mobile/cache/a.jpg', '/data/user/0/com.whombat.mobile/cache/b.jpg'],
    ]);
    // An older share's clear changes nothing now.
    clearShare(first?.id ?? 0);
    expect(removed).toHaveLength(1);
    clearShare(currentShare()?.id ?? 0);
    expect(removed.at(-1)).toEqual(['/data/user/0/com.whombat.mobile/cache/c.jpg']);
    expect(currentShare()).toBeNull();
    putShare(payload('/data/user/0/com.whombat.mobile/cache/d.jpg', '/storage/emulated/0/e.jpg'));
    wipeShares();
    expect(removed.at(-1)).toEqual(['/data/user/0/com.whombat.mobile/cache/d.jpg']);
    expect(currentShare()).toBeNull();
  });
});

describe('contracts 0.55 on the phone (MX-09)', () => {
  it('offers Stop on the agent’s thinking line to a person', () => {
    const you = { id: mara.id, kind: 'person' as const };
    expect(offersStop({ typing: { dispatchId: 'dsp_1' }, viewer: you })).toBe(true);
    // A turn without its id, and the agent itself.
    expect(offersStop({ typing: {}, viewer: you })).toBe(false);
    expect(offersStop({ typing: { dispatchId: 'dsp_1' }, viewer: { id: 'prn_dusty', kind: 'agent' } })).toBe(
      false,
    );
    const confirm = stopConfirm('Dusty');
    expect(confirm.title).toContain('Dusty');
    expect(confirm.cta).toBe('Stop');
  });

  const deploy: DeployCard = {
    kind: 'deploy',
    deploymentId: 'dpl_1',
    environment: 'production',
    service: 'api',
    status: 'failed',
    sha: 'ABCDEF1234',
    url: 'https://api.example.com',
  };

  it('shows a deploy as one line that opens its card, with the site and the Deploys board', () => {
    const [item] = chatItems([msg('msg_deploy', { authorId: dusty.id, card: deploy, text: '' })], ctx, {
      authors: true,
    });
    expect(item?.display).toBe('line');
    expect(item?.line).toEqual({ lead: 'Deploy of api to production failed', detail: 'abcdef', tone: 'bad' });
    expect(cardSummary(deploy, ctx)).toMatchObject({
      label: 'FAILED',
      title: 'api to production',
      meta: 'abcdef',
      tone: 'bad',
      deploy: { url: 'https://api.example.com' },
    });
    expect(cardSummary({ ...deploy, status: 'succeeded', sha: null, url: null }, ctx)).toMatchObject({
      label: 'DEPLOYED',
      meta: null,
      tone: 'ok',
      deploy: { url: null },
    });
  });

  it('pages a thread: the newest replies, then earlier pages, each reply once and in order', () => {
    expect(threadQuery()).toEqual({ limit: THREAD_PAGE_SIZE });
    expect(threadQuery('msg_r3')).toEqual({ before: 'msg_r3', limit: THREAD_PAGE_SIZE });
    const root = msg('msg_root', { createdAt: at(100) });
    const reply = (id: string, minutesAgo: number) =>
      msg(id, { threadRootId: 'msg_root', createdAt: at(minutesAgo) });
    const view = (replies: Message[], more: { before: string } | null): ThreadView => ({
      root,
      replies,
      conversationId: 'cnv_1',
      where: '#general',
      topic: null,
      more,
    });
    const newest = view([reply('msg_r3', 30), reply('msg_r4', 20)], { before: 'msg_r3' });
    expect(threadMessages(newest, [])).toEqual({
      messages: [root, reply('msg_r3', 30), reply('msg_r4', 20)],
      more: { before: 'msg_r3' },
    });
    // An earlier page on its way: nothing more offered yet.
    expect(threadMessages(newest, [undefined]).more).toBeNull();
    // A live reply lands in every cached page: once, in time order.
    const earlier = view([reply('msg_r1', 50), reply('msg_r2', 40), reply('msg_r5', 10)], null);
    const both = threadMessages({ ...newest, replies: [...newest.replies, reply('msg_r5', 10)] }, [earlier]);
    expect(both.messages.map((m) => m.id)).toEqual([
      'msg_root',
      'msg_r1',
      'msg_r2',
      'msg_r3',
      'msg_r4',
      'msg_r5',
    ]);
    expect(both.more).toBeNull();
    // An older Whombat: every reply, no `more`.
    expect(threadMessages(view([reply('msg_r1', 50)], null), []).more).toBeNull();
    expect(threadMessages(undefined, [])).toEqual({ messages: [], more: null });
  });

  it('shows an image tile’s thumbnail when the Whombat made one', () => {
    const url = '/api/v1/burrows/hq/attachments/att_1';
    expect(tilePicture({ url, thumbnailUrl: `${url}/thumbnail` })).toEqual({
      path: `${url}/thumbnail`,
      preview: true,
    });
    expect(tilePicture({ url, thumbnailUrl: null })).toEqual({ path: url, preview: false });
    expect(tilePicture({ url })).toEqual({ path: url, preview: false });
  });
});
