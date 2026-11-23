/**
 * Dropbox's page in slots (docs/service-pages.md): how much of its space is used, the folders at the top and its shared
 * links in Inventory; the files at the top that changed in the last 30 days in Live (Dropbox has no cheap “recently
 * changed” for a whole account, and the top is what one listing shows), left out when none did; the space used per day
 * as the Trend from Whombat's own readings, as a NAS's (the health pass stores the used space as a point every pass).
 *
 * One read: `users/get_space_usage`, `files/list_folder` of the top (not recursive, one page of 100) and
 * `sharing/list_shared_links` only when the sign-in holds `sharing.read` (without it Dropbox refuses, and a refusal
 * renews the token every read). Kept 10 minutes. One check, “Dropbox is almost full” from 85 %, starts off: an
 * allowance nearly used is information until someone asks to hear it.
 */
import type { ThingLine, ThingPageItem, ThingPageKpi } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import type { KindCheck, KindNotice } from '../../quiet/types';
import type { RawPoint } from '../../series';
import { bytes, clip, dateOf, line, list, num, pct, rec, str, thousands, when } from '../../words';
import { loader, optional, seenOfView, viewOrProblem } from '../business/common';
import { cachedRead, latestRead } from '../read';
import type { KindModule } from '../registry';
import { countLine, inventory, liveList, slotPanels } from '../slots';
import { readSpace, spaceWeek, usedPoint } from '../storage/nas';
import { FULL_BAD_PCT, FULL_WARN_PCT, fullTone, usedOf } from '../storage/shared';
import type { KindCtx, KindView } from '../types';
import { apiRead, type Counted } from './common';

const NAME = 'Dropbox';
export const DROPBOX_APP = 'https://www.dropbox.com/home';
export const DROPBOX_KEEP_MS = 10 * 60_000;
/** One page of the top's listing. */
const TOP = 100;
/** Files changed this long ago still count as lately. */
const LATELY_MS = 30 * 86_400_000;
const ROWS = 8;
export const SPACE_CHECK = 'dropbox.space';

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface DropboxSpace {
  used: number;
  /** What the account may use; null when Dropbox gives no limit. */
  allocated: number | null;
  /** The account's own, a team's shared space, or the person's share of a team's. */
  of: 'account' | 'team' | 'member';
}

export interface DropboxEntry {
  name: string;
  folder: boolean;
  /** A file's last change on Dropbox; folders have none. */
  modified: Date | null;
  size: number | null;
}

export interface DropboxSnapshot {
  readAt: Date;
  space: DropboxSpace | null;
  /** The top of the Dropbox; null when it couldn't be listed. */
  top: { entries: DropboxEntry[]; more: boolean } | null;
  /** Shared links; null when the sign-in may not list them. */
  links: Counted | null;
}

/** `users/get_space_usage`: used of the individual allowance, of a member's share, or of the team's space. */
export function dropboxSpace(body: unknown): DropboxSpace | null {
  const b = rec(body);
  const used = num(b.used);
  if (used === null || used < 0) return null;
  const a = rec(b.allocation);
  if (str(a['.tag']) === 'team') {
    const share = num(a.user_within_team_space_allocated);
    if (share && share > 0) return { used, allocated: share, of: 'member' };
    const teamUsed = num(a.used);
    const teamAllocated = num(a.allocated);
    return teamUsed !== null && teamAllocated && teamAllocated > 0
      ? { used: teamUsed, allocated: teamAllocated, of: 'team' }
      : { used, allocated: null, of: 'team' };
  }
  const allocated = num(a.allocated);
  return { used, allocated: allocated && allocated > 0 ? allocated : null, of: 'account' };
}

/** `files/list_folder` of the top: its files and folders, and whether there are more than one page. */
export function dropboxTop(body: unknown): { entries: DropboxEntry[]; more: boolean } {
  const b = rec(body);
  const entries: DropboxEntry[] = [];
  for (const e of list(b.entries).map(rec)) {
    const tag = str(e['.tag']);
    const name = str(e.name);
    if ((tag !== 'file' && tag !== 'folder') || !name) continue;
    entries.push({
      name: clip(name, 160),
      folder: tag === 'folder',
      modified: tag === 'file' ? dateOf(e.server_modified) : null,
      size: tag === 'file' ? num(e.size) : null,
    });
  }
  return { entries, more: b.has_more === true };
}

/** `sharing/list_shared_links`' first page as a count. */
export function dropboxLinks(body: unknown): Counted {
  const b = rec(body);
  return { n: list(b.links).length, more: b.has_more === true };
}

async function readDropbox(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<DropboxSnapshot> {
  const post = (path: string, body: unknown) => apiRead(services, row, NAME, path, { method: 'POST', body });
  const [usage, top, links] = await Promise.all([
    post('/2/users/get_space_usage', null),
    optional(post('/2/files/list_folder', { path: '', limit: TOP })),
    (row.scopes ?? []).includes('sharing.read')
      ? optional(post('/2/sharing/list_shared_links', {}))
      : Promise.resolve(null),
  ]);
  return {
    readAt: now,
    space: dropboxSpace(usage),
    top: top ? dropboxTop(top) : null,
    links: links ? dropboxLinks(links) : null,
  };
}

const keyOf = (row: CatalogConnectionRow) => `dropbox:${row.id}`;

function dropboxLoad(services: Services, row: CatalogConnectionRow, now: Date) {
  return loader(NAME, () => readDropbox(services, row, now));
}

/** Dropbox's read for its page (kept 10 minutes). */
export function dropboxLatest(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return latestRead(services, keyOf(row), row, dropboxLoad(services, row, now), { ttlMs: DROPBOX_KEEP_MS });
}

/* What it shows ------------------------------------------------------------------------------------------------------- */

export interface DropboxInput {
  snapshot: DropboxSnapshot;
  now: Date;
  timeZone: string;
  /** Whombat's own readings of the used space (`nas_used_gb`), oldest first. */
  points?: readonly RawPoint[];
}

/** How full, 0–100; null without an allowance. */
const fullPct = (s: DropboxSpace) => (s.allocated ? (s.used / s.allocated) * 100 : null);

const SPACE_WORDS: Record<DropboxSpace['of'], string | undefined> = {
  account: undefined,
  team: 'The team’s space',
  member: 'Your share of the team’s space',
};

export const DROPBOX_CHECKS: readonly KindCheck[] = [
  { check: SPACE_CHECK, name: 'Dropbox is almost full', nature: 'problem', perItem: false, startsOn: false },
];

/** Worth a look: almost full from 85 %, amber, and red from 95 %. */
export function dropboxNotices(s: DropboxSnapshot): KindNotice[] {
  const space = s.space;
  const p = space ? fullPct(space) : null;
  if (!space?.allocated || p === null || p < FULL_WARN_PCT) return [];
  const bad = p >= FULL_BAD_PCT;
  return [
    {
      id: 'space',
      tone: bad ? 'bad' : 'warn',
      icon: 'disk',
      title: bad ? 'Dropbox is full' : 'Dropbox is almost full',
      detail: `${pct(p)} used · ${usedOf(space.used, space.allocated)} · ${bytes(Math.max(0, space.allocated - space.used))} free`,
      link: {
        kind: 'ask',
        label: 'What takes space',
        question: 'My Dropbox is almost full. What takes the most space, and what could go?',
      },
      nature: 'problem',
      check: SPACE_CHECK,
      band: bad ? FULL_BAD_PCT : FULL_WARN_PCT,
      ignore: { lifts: 'fixed', words: 'Until there’s room again.' },
    },
  ];
}

/** A file's icon by what it holds. */
function fileIcon(name: string): ThingPageItem['icon'] {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (/^(jpe?g|png|gif|heic|webp|tiff?|raw|dng)$/.test(ext)) return 'photo';
  if (/^(mp4|mov|mkv|avi|m4v|webm)$/.test(ext)) return 'video';
  if (/^(mp3|m4a|wav|flac|aac|ogg)$/.test(ext)) return 'music';
  return 'log';
}

/** Changed lately (Live): files at the top changed in the last 30 days; left out when none did. */
function changed(input: DropboxInput) {
  const { snapshot: s, now, timeZone } = input;
  const files = (s.top?.entries ?? [])
    .filter((e): e is DropboxEntry & { modified: Date } => !e.folder && e.modified !== null)
    .filter((e) => now.getTime() - e.modified.getTime() <= LATELY_MS)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
  if (!files.length) return null;
  return liveList({
    id: 'changed',
    title: 'Changed lately',
    meta: 'Files at the top of your Dropbox',
    link: { kind: 'url', label: 'Open Dropbox', url: DROPBOX_APP },
    items: files.slice(0, ROWS).map(
      (f, i): ThingPageItem => ({
        id: `file-${i}`,
        title: f.name,
        icon: fileIcon(f.name),
        ...(f.size !== null ? { detail: bytes(f.size) } : {}),
        right: when(f.modified, now, timeZone),
      }),
    ),
  });
}

/** In Dropbox (Inventory): space used of the allowance, the folders at the top, the shared links. */
function counts(input: DropboxInput) {
  const { snapshot: s } = input;
  const lines: ThingPageItem[] = [];
  const space = s.space;
  if (space) {
    const p = fullPct(space);
    const tone = p !== null ? fullTone(p) : undefined;
    const detail = SPACE_WORDS[space.of];
    lines.push(
      countLine({
        id: 'space',
        title: 'Space used',
        icon: 'disk',
        ...(detail ? { detail } : {}),
        ...(tone ? { tone } : {}),
        value: p !== null ? pct(p) : bytes(space.used),
        note: space.allocated ? usedOf(space.used, space.allocated) : 'No limit given',
        ...(tone ? { noteTone: tone } : {}),
        url: DROPBOX_APP,
      }),
    );
  }
  if (s.top) {
    const plus = s.top.more ? '+' : '';
    const folders = s.top.entries.filter((e) => e.folder).length;
    const files = s.top.entries.length - folders;
    lines.push(
      countLine({
        id: 'folders',
        title: 'Folders',
        icon: 'disk',
        detail: 'At the top',
        value: `${thousands(folders)}${plus}`,
        ...(files
          ? { note: `${thousands(files)}${plus} ${files === 1 && !plus ? 'file' : 'files'} beside them` }
          : {}),
      }),
    );
  }
  if (s.links)
    lines.push(
      countLine({
        id: 'links',
        title: 'Shared links',
        icon: 'network',
        value: `${thousands(s.links.n)}${s.links.more ? '+' : ''}`,
      }),
    );
  return lines.length ? inventory({ id: 'counts', title: 'In Dropbox', items: lines }) : null;
}

function figures(s: DropboxSnapshot): ThingPageKpi[] {
  const space = s.space;
  if (!space) return [];
  const p = fullPct(space);
  return [
    {
      key: 'space',
      label: 'Space used',
      value: p !== null ? pct(p) : bytes(space.used),
      ...(space.allocated ? { sub: usedOf(space.used, space.allocated) } : {}),
    },
  ];
}

/** The page's Dropbox part, from what was read; pure. No machine card: it runs at Dropbox. */
export function dropboxView(input: DropboxInput): KindView {
  const { snapshot: s, now, timeZone } = input;
  const space = s.space;
  const p = space ? fullPct(space) : null;
  const facts: ThingLine[] = [];
  if (space)
    facts.push(
      line(
        space.allocated
          ? `**${bytes(space.used)}** of ${bytes(space.allocated)} used`
          : `**${bytes(space.used)}** used`,
      ),
    );
  const notices = dropboxNotices(s);
  return {
    kpis: [],
    charts: [],
    machine: 'after',
    notices,
    ...slotPanels({
      live: changed(input),
      inventory: counts(input),
      trend: spaceWeek({
        points: input.points ?? [],
        now,
        timeZone,
        freeBytes: space?.allocated ? space.allocated - space.used : null,
        what: 'Added per day',
      }),
    }),
    tabs: [],
    facts,
    // The head when nothing is worth a look; the line says when it is full, and only while its check is on.
    status: { status: 'ok', badge: p !== null ? `${pct(p)} used` : 'Signed in' },
    open: { label: 'Open Dropbox', url: DROPBOX_APP },
    actions: [],
    readAt: s.readAt,
    suggestions: ['What takes the most space', 'Files changed this week', 'Find a file'],
  };
}

/* The page ------------------------------------------------------------------------------------------------------------ */

export async function dropboxPage(ctx: KindCtx): Promise<KindView> {
  const [read, points] = await Promise.all([
    dropboxLatest(ctx.services, ctx.row, ctx.now),
    readSpace(ctx.services, ctx.row.id, ctx.now),
  ]);
  return viewOrProblem(read, NAME, { label: 'Open Dropbox', url: DROPBOX_APP }, (snapshot) =>
    dropboxView({ snapshot, now: ctx.now, timeZone: ctx.timeZone, points }),
  );
}

export const DROPBOX_KIND: KindModule = {
  page: dropboxPage,
  checks: DROPBOX_CHECKS,
  prefetch: (services, row, now) => dropboxLatest(services, row, now),
  async seen(services, row, now, timeZone) {
    const snapshot = await cachedRead(
      services,
      keyOf(row),
      row,
      dropboxLoad(services, row, now),
      DROPBOX_KEEP_MS,
    );
    const view = dropboxView({ snapshot, now, timeZone });
    return {
      ...seenOfView({ ...view, kpis: figures(snapshot) }, ['space']),
      points: usedPoint(snapshot.space?.used),
    };
  },
};
