/**
 * Dropbox's page from recorded answers: `users/get_space_usage`, `files/list_folder` and `sharing/list_shared_links`
 * shaped as Dropbox's API spec defines them (github.com/dropbox/dropbox-api-spec: users.stone, files.stone,
 * shared_links.stone, with its examples' values), and the space Trend from Whombat's own daily points.
 */
import { readFileSync } from 'node:fs';
import { ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import type { RawPoint } from '../../series';
import { rowOf } from '../media/testing';
import { forgetKindReads } from '../read';
import { slotProblems } from '../slots';
import { NAS_USED_KEY } from '../storage/nas';
import type { KindCtx } from '../types';
import {
  DROPBOX_CHECKS,
  DROPBOX_KIND,
  type DropboxInput,
  type DropboxSnapshot,
  dropboxLinks,
  dropboxNotices,
  dropboxPage,
  dropboxSpace,
  dropboxTop,
  dropboxView,
  SPACE_CHECK,
} from './dropbox';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/dropbox/${name}`, import.meta.url), 'utf8'));

const io = vi.hoisted(() => ({
  calls: [] as { path: string; body: string | undefined }[],
}));

vi.mock('../../../connections/http', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../connections/http')>();
  const { readFileSync: read } = await import('node:fs');
  const answer = (name: string) => read(new URL(`./fixtures/dropbox/${name}`, import.meta.url));
  return {
    ...real,
    signedConnectionFetch: async (_s: unknown, _r: unknown, req: { url: string; body?: string }) => {
      const path = new URL(req.url).pathname;
      io.calls.push({ path, body: req.body });
      const file = {
        '/2/users/get_space_usage': 'space-individual.json',
        '/2/files/list_folder': 'list-folder.json',
        '/2/sharing/list_shared_links': 'shared-links.json',
      }[path];
      return file
        ? { status: 200, headers: {}, body: answer(file) }
        : { status: 404, headers: {}, body: Buffer.from('{}') };
    },
  };
});

vi.mock('../../points', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../points')>();
  return { ...real, readPoints: async () => new Map() };
});

const TZ = 'Europe/Amsterdam';
// Tuesday 21 October 2026, 17:00 in Amsterdam.
const now = new Date('2026-10-21T15:00:00Z');

function snapshot(over: Partial<DropboxSnapshot> = {}): DropboxSnapshot {
  return {
    readAt: now,
    space: dropboxSpace(fixture('space-individual.json')),
    top: dropboxTop(fixture('list-folder.json')),
    links: dropboxLinks(fixture('shared-links.json')),
    ...over,
  };
}

/** A reading a day at noon, `gb` from oldest to today. */
function daily(gb: number[]): RawPoint[] {
  return gb.map((v, i) => ({ at: new Date(now.getTime() - (gb.length - 1 - i) * 86_400_000), value: v }));
}

const input = (over: Partial<DropboxSnapshot> = {}, points: RawPoint[] = []): DropboxInput => ({
  snapshot: snapshot(over),
  now,
  timeZone: TZ,
  points,
});

const panel = (view: ReturnType<typeof dropboxView>, id: string) => view.panels.find((p) => p.id === id);

describe('Dropbox’s answers', () => {
  it('reads the space of an account, of a team, and of a member’s share', () => {
    expect(dropboxSpace(fixture('space-individual.json'))).toEqual({
      used: 812e9,
      allocated: 2e12,
      of: 'account',
    });
    expect(dropboxSpace(fixture('space-team.json'))).toEqual({
      used: 27182818284,
      allocated: 100000000000,
      of: 'team',
    });
    expect(
      dropboxSpace({
        used: 5e8,
        allocation: { '.tag': 'team', used: 9e9, allocated: 1e11, user_within_team_space_allocated: 2e9 },
      }),
    ).toEqual({ used: 5e8, allocated: 2e9, of: 'member' });
    expect(dropboxSpace({ allocation: {} })).toBeNull();
  });

  it('reads the top’s files and folders, never what was deleted', () => {
    const top = dropboxTop(fixture('list-folder.json'));
    expect(top.more).toBe(false);
    expect(top.entries.map((e) => [e.name, e.folder])).toEqual([
      ['Photos', true],
      ['Work', true],
      ['Family', true],
      ['Taxes 2026.pdf', false],
      ['IMG_2041.jpg', false],
      ['old-notes.txt', false],
    ]);
    expect(dropboxLinks(fixture('shared-links.json'))).toEqual({ n: 3, more: false });
  });
});

describe('Dropbox’s page', () => {
  it('fills Live, Inventory and Trend in their slots', () => {
    const view = dropboxView(input({}, daily([800, 802, 803, 805, 806, 809, 810, 812])));
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['changed', 'counts', 'week']);
    for (const p of view.panels) expect(ThingPagePanel.safeParse(p).success).toBe(true);
  });

  it('shows the files at the top changed in the last 30 days, newest first; none, and Live is left out', () => {
    const changed = panel(dropboxView(input()), 'changed');
    if (changed?.kind !== 'list') throw new Error('no list');
    expect(changed.title).toBe('Changed lately');
    expect(changed.items.map((i) => [i.title, i.detail, i.right, i.icon])).toEqual([
      ['Taxes 2026.pdf', '482 kB', 'Yesterday 10:12', 'log'],
      ['IMG_2041.jpg', '3 MB', '2 Oct', 'photo'],
    ]);
    const old = dropboxTop({
      entries: [{ '.tag': 'file', name: 'a.txt', server_modified: '2025-01-01T00:00:00Z' }],
    });
    expect(panel(dropboxView(input({ top: old })), 'changed')).toBeUndefined();
  });

  it('counts the space used of the allowance, the folders at the top and the shared links', () => {
    const counts = panel(dropboxView(input()), 'counts');
    if (counts?.kind !== 'list') throw new Error('no counts');
    expect(counts.title).toBe('In Dropbox');
    expect(counts.items.map((i) => [i.title, i.figure?.value, i.figure?.note])).toEqual([
      ['Space used', '41 %', '0.8 of 2.0 TB'],
      ['Folders', '3', '3 files beside them'],
      ['Shared links', '3', undefined],
    ]);
    // Without the sign-in's leave to list shared links, that line is left out.
    const none = panel(dropboxView(input({ links: null })), 'counts');
    if (none?.kind !== 'list') throw new Error('no counts');
    expect(none.items.map((i) => i.title)).toEqual(['Space used', 'Folders']);
  });

  it('turns amber from 85 % and says so in Worth a look, a check that starts off', () => {
    const full = { used: 1.8e12, allocated: 2e12, of: 'account' as const };
    const view = dropboxView(input({ space: full }));
    const counts = panel(view, 'counts');
    if (counts?.kind !== 'list') throw new Error('no counts');
    expect(counts.items[0]?.tone).toBe('warn');
    expect(view.notices.map((n) => [n.check, n.tone, n.title])).toEqual([
      [SPACE_CHECK, 'warn', 'Dropbox is almost full'],
    ]);
    for (const n of view.notices) expect(ThingPageNotice.safeParse(n).success).toBe(true);
    expect(
      dropboxNotices(snapshot({ space: { used: 1.95e12, allocated: 2e12, of: 'account' } }))[0]?.tone,
    ).toBe('bad');
    expect(dropboxNotices(snapshot())).toEqual([]);
    expect(DROPBOX_CHECKS.map((c) => [c.check, c.startsOn])).toEqual([[SPACE_CHECK, false]]);
    // The head stays calm: the line says it, and only while its check is on.
    expect(view.status?.status).toBe('ok');
  });

  it('draws the space added per day from Whombat’s own readings, and leaves it out with fewer than two days', () => {
    const view = dropboxView(input({}, daily([800, 802, 803, 805, 806, 809, 810, 812])));
    const week = panel(view, 'week');
    if (week?.kind !== 'chart') throw new Error('no week');
    expect(week.title).toBe('Space used');
    expect(week.series[0]?.values).toEqual([2, 1, 2, 1, 3, 1, 2]);
    expect(week.figure?.value).toBe('+12 GB');
    expect(panel(dropboxView(input({}, daily([812]))), 'week')).toBeUndefined();
  });
});

describe('Reading Dropbox', () => {
  const services = { clock: () => now } as unknown as Services;
  const ctx = (row: CatalogConnectionRow): KindCtx =>
    ({ services, row, now, timeZone: TZ }) as unknown as KindCtx;

  beforeEach(() => {
    forgetKindReads(services);
    io.calls.length = 0;
  });

  it('lists shared links only when the sign-in may, and stores the used space as the health pass’s point', async () => {
    const row = rowOf('dropbox', {
      id: 'con_dropbox',
      baseUrl: 'https://api.dropboxapi.com',
      signIn: 'app_oauth',
      scopes: ['account_info.read', 'files.metadata.read'],
    });
    const view = await dropboxPage(ctx(row));
    expect(view.problem).toBeUndefined();
    expect(io.calls.map((c) => c.path).sort()).toEqual(['/2/files/list_folder', '/2/users/get_space_usage']);
    expect(JSON.parse(io.calls.find((c) => c.path === '/2/files/list_folder')?.body ?? '{}')).toEqual({
      path: '',
      limit: 100,
    });
    const seen = await DROPBOX_KIND.seen?.(services, row, now, TZ);
    expect(seen?.points).toEqual({ [NAS_USED_KEY]: 812 });
    expect(seen?.glance.facts.map((f) => [f.label, f.value])).toEqual([['Space used', '41 %']]);
    // Kept 10 minutes: the pass read nothing new.
    expect(io.calls).toHaveLength(2);

    const sharing = rowOf('dropbox', {
      id: 'con_dropbox_sharing',
      baseUrl: 'https://api.dropboxapi.com',
      signIn: 'app_oauth',
      scopes: ['account_info.read', 'files.metadata.read', 'sharing.read'],
    });
    await dropboxPage(ctx(sharing));
    expect(io.calls.map((c) => c.path)).toContain('/2/sharing/list_shared_links');
  });
});
