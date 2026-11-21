/**
 * The pure parts of getting one thing back (backup-look.md): how picked things become the backup file's records and
 * outcomes, how things are named and searched, what the backup service's refusals mean, and that nothing in a backup's
 * folders is read through a symlink.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirInside, filesUnder, openInside } from './inside';
import { peekProblem } from './peek';
import {
  categoryOfItem,
  itemIdOf,
  itemOutcome,
  keysOfItem,
  makePick,
  outcomeKey,
  PickFilter,
  parseItemId,
  pickedCategories,
  pickedConversations,
} from './pick';
import { peekBlobSegments } from './source';
import { clip, likePattern, searchWords, threadTitleOf, vaultKindWords } from './titles';

describe('picked things', () => {
  it('reads item ids both ways, and refuses ones it doesn’t know', () => {
    for (const id of [
      'thread:msg_abc123',
      'chat:cnv_task-1',
      'file:att_x1',
      'automation:aut_9',
      'connection:con_7',
      'account:cxn_2',
      'vault:vlt_3',
      'connection:github',
      'notes',
      'skills',
      'home:person',
      'home:outside',
    ]) {
      const item = parseItemId(id);
      expect(item, id).not.toBeNull();
      expect(itemIdOf(item as NonNullable<typeof item>)).toBe(id);
    }
    for (const bad of ['thread:../etc', 'run:run_1', 'thread:', 'home:somebody', 'thread:msg_a b'])
      expect(parseItemId(bad), bad).toBeNull();
    expect(categoryOfItem({ kind: 'thread', id: 'msg_1' })).toBe('messages');
    expect(categoryOfItem({ kind: 'github' })).toBe('connections');
    expect(categoryOfItem({ kind: 'home', home: 'person' })).toBe('memories');
  });

  it('runs only the collectors of what was picked, and reads only the picked chats’ conversations', () => {
    const pick = makePick([
      { item: { kind: 'thread', id: 'msg_root' }, conversation: 'cnv_chat' },
      { item: { kind: 'file', id: 'att_1' } },
    ]);
    expect(pickedCategories(pick)).toEqual(['messages', 'files']);
    expect([...(pickedConversations(pick) ?? [])]).toEqual(['cnv_chat']);
    expect(pickedConversations(makePick([], ['messages']))).toBeNull();
    // A file alone: its conversation is read (Files are read by conversation), and nothing else.
    const file = makePick([{ item: { kind: 'file', id: 'att_1' }, conversation: 'cnv_files' }]);
    expect([...(pickedConversations(file) ?? [])]).toEqual(['cnv_files']);
    expect(pickedCategories(file)).toEqual(['files']);
    expect(pickedCategories(makePick([], ['vault', 'automations']))).toEqual(['automations', 'vault']);
  });

  it('keeps a thread’s first message, its replies, its room and its choice of what answers — and nothing else', () => {
    const f = new PickFilter(
      makePick([{ item: { kind: 'thread', id: 'msg_root' }, conversation: 'cnv_chat' }]),
    );
    const keep = (v: Record<string, unknown>) => f.keep('messages', v as { type: string });
    expect(keep({ type: 'conversation', id: 'cnv_chat' })).toBe(true);
    expect(keep({ type: 'conversation', id: 'cnv_other' })).toBe(false);
    expect(keep({ type: 'message', id: 'msg_root', conversation: 'cnv_chat', threadRoot: null })).toBe(true);
    expect(keep({ type: 'message', id: 'msg_reply', conversation: 'cnv_chat', threadRoot: 'msg_root' })).toBe(
      true,
    );
    expect(keep({ type: 'message', id: 'msg_else', conversation: 'cnv_chat', threadRoot: null })).toBe(false);
    expect(keep({ type: 'chat_thread_runtime', root: 'msg_root', conversation: 'cnv_chat' })).toBe(true);
    expect(keep({ type: 'chat_thread_runtime', root: 'msg_else', conversation: 'cnv_chat' })).toBe(false);
    expect(keep({ type: 'canvas', id: 'cvs_1', conversation: 'cnv_chat' })).toBe(false);
  });

  it('keeps a whole chat with its canvases and their comments', () => {
    const f = new PickFilter(makePick([{ item: { kind: 'chat', id: 'cnv_task' } }]));
    const keep = (v: Record<string, unknown>) => f.keep('messages', v as { type: string });
    expect(keep({ type: 'conversation', id: 'cnv_task' })).toBe(true);
    expect(keep({ type: 'message', id: 'msg_1', conversation: 'cnv_task', threadRoot: null })).toBe(true);
    expect(keep({ type: 'canvas', id: 'cvs_1', conversation: 'cnv_task' })).toBe(true);
    expect(keep({ type: 'canvas_comment', id: 'cmt_1', canvas: 'cvs_1' })).toBe(true);
    expect(keep({ type: 'canvas_comment', id: 'cmt_2', canvas: 'cvs_other' })).toBe(false);
  });

  it('keeps a Google account with its sign-in app, an automation with the approved places it sends to', () => {
    const f = new PickFilter(
      makePick([{ item: { kind: 'account', id: 'cxn_1' } }, { item: { kind: 'automation', id: 'aut_1' } }]),
    );
    expect(f.keep('connections', { type: 'connector_account', id: 'cxn_1', provider: 'google' })).toBe(true);
    expect(f.keep('connections', { type: 'connector_app', provider: 'google' })).toBe(true);
    expect(f.keep('connections', { type: 'connector_app', provider: 'microsoft' })).toBe(false);
    expect(f.keep('connections', { type: 'connection', id: 'con_1' })).toBe(false);
    expect(f.keep('connections', { type: 'github' })).toBe(false);
    expect(f.keep('automations', { type: 'automation', id: 'aut_1' })).toBe(true);
    expect(f.keep('automations', { type: 'automation', id: 'aut_2' })).toBe(false);
    expect(f.keep('automations', { type: 'destination', url: 'https://x' })).toBe(true);
    // A whole category keeps every record.
    const whole = new PickFilter(makePick([], ['vault']));
    expect(whole.keep('vault', { type: 'vault_entry', id: 'vlt_any' })).toBe(true);
  });

  it('judges each picked thing by its records’ outcomes', () => {
    expect(outcomeKey('messages', { type: 'message', id: 'msg_1' })).toBe('message:msg_1');
    expect(outcomeKey('messages', { type: 'conversation', id: 'cnv_1' })).toBeNull();
    expect(outcomeKey('connections', { type: 'github' })).toBe(itemIdOf({ kind: 'github' }));
    expect(outcomeKey('memories', { type: 'hermes_home', home: 'person' })).toBe('home:person');
    expect(outcomeKey('memories', { type: 'agent_notes' })).toBe('notes');
    expect(keysOfItem({ kind: 'thread', id: 'msg_1' }, () => ['msg_1', 'msg_2'])).toEqual([
      'message:msg_1',
      'message:msg_2',
    ]);
    expect(keysOfItem({ kind: 'file', id: 'att_1' }, () => [])).toEqual(['file:att_1']);
    expect(itemOutcome(['unchanged', 'added'])).toBe('back');
    expect(itemOutcome(['unchanged', 'kept'])).toBe('already');
    expect(itemOutcome(['skipped'])).toBe('not_back');
    expect(itemOutcome([])).toBe('not_back');
  });
});

describe('names and search', () => {
  it('names a thread by its first words, Markdown dropped', () => {
    expect(threadTitleOf('\n## **Roof** is leaking\nmore')).toBe('Roof is leaking');
    expect(threadTitleOf('', 'pve-02')).toBe('pve-02');
    expect(threadTitleOf('x'.repeat(300)).length).toBeLessThanOrEqual(120);
    expect(clip('a  b\n c')).toBe('a b c');
  });

  it('searches every word, case aside, with the words’ own wildcards taken literally', () => {
    expect(searchWords('  The ROOF, kitchen! a ')).toEqual(['the', 'roof', 'kitchen']);
    expect(searchWords(undefined)).toEqual([]);
    expect(likePattern('50%_off')).toBe('%50\\%\\_off%');
    expect(vaultKindWords('ssh')).toContain('SSH');
  });
});

describe('the backup service’s answers', () => {
  it('says why a backup can’t be opened, in plain words with the size', () => {
    const room = peekProblem(507, {
      error: { code: 'no_space', needBytes: 3_200_000_000, freeBytes: 1_100_000_000 },
    });
    expect(room).toMatchObject({ code: 'no_room', needBytes: 3_200_000_000, freeBytes: 1_100_000_000 });
    expect(room?.message).toMatch(/3\.2\sGB/);
    expect(peekProblem(409, { error: { code: 'busy' } })?.code).toBe('busy');
    expect(peekProblem(404, { error: { code: 'not_found' } })?.code).toBe('not_found');
    // A service from before peeks: its router's 404, or not set up on this box.
    expect(peekProblem(404, null)?.code).toBe('not_supported');
    expect(peekProblem(503, { error: { code: 'unavailable' } })?.code).toBe('not_supported');
    expect(peekProblem(502, null)?.code).toBe('failed');
    expect(peekProblem(202, { id: 'x' })).toBeNull();
  });

  it('finds a blob only by a well-formed key', () => {
    const sha = 'ab'.repeat(32);
    expect(peekBlobSegments(`sha256/ab/ab/${sha}`)).toEqual(['home', 'files', 'sha256', 'ab', 'ab', sha]);
    expect(peekBlobSegments(`sha256/cd/ab/${sha}`)).toBeNull();
    expect(peekBlobSegments('sha256/../../etc/passwd')).toBeNull();
  });
});

describe('a backup’s folders', () => {
  let root = '';
  let outside = '';
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-look-inside-'));
    outside = await mkdtemp(join(tmpdir(), 'wb-look-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'not yours');
    await mkdir(join(root, 'home', 'files'), { recursive: true });
    await writeFile(join(root, 'home', 'files', 'a.txt'), 'hello');
    // Links the backup kept as they were: one to a file outside, one to a folder outside.
    await symlink(join(outside, 'secret.txt'), join(root, 'home', 'files', 'link.txt'));
    await symlink(outside, join(root, 'home', 'away'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('reads real files and never follows a symlink', async () => {
    const real = await openInside(root, ['home', 'files', 'a.txt']);
    expect((await real?.readFile())?.toString('utf8')).toBe('hello');
    await real?.close();
    expect(await openInside(root, ['home', 'files', 'link.txt'])).toBeNull();
    expect(await openInside(root, ['home', 'away', 'secret.txt'])).toBeNull();
    expect(await dirInside(root, ['home', 'away'])).toBeNull();
    expect(await openInside(root, ['home', '..', 'x'])).toBeNull();
    const files = await filesUnder(root, () => true);
    expect(files.map((f) => f.rel)).toEqual(['home/files/a.txt']);
  });
});
