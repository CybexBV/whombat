/**
 * Nextcloud's page (service-dashboards.md SD-57, SD-S17), in slots (service-slots.md): what it holds (files, users and
 * who was on today, shares, apps), who uses the most space, and its version, free space and database in the machine
 * card — read from the Monitoring app's `/ocs/v2.php/apps/serverinfo/api/v1/info` with `skipApps=false` and
 * `skipUpdate=false` (both default to true there), as the connection's account, which must be an admin, and its users
 * from `/ocs/v2.php/cloud/users/details` (kept 10 minutes). Nextcloud reports the free space only, not the disk's size,
 * so Free for files has no bar (SD-S17). An account that isn't an admin sees its own storage and a line saying why the
 * rest is missing. Nothing happens live that Whombat could show and Nextcloud keeps no history per day: no Live, Shelf
 * or Trend. Setup warnings have no API: left out. Read only.
 */
import type { ThingLine, ThingPageBar, ThingPageItem, ThingPageKpi, ThingPagePanel } from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import type { Services } from '../../../services';
import { shortHash } from '../../quiet/items';
import type { KindCheck } from '../../quiet/types';
import { bytes, clip, line, num, plural, rec, str, thousands } from '../../words';
import { cachedRead, KIND_DEADLINE_MS, latestRead, problemOf, ReadProblem, withDeadline } from '../read';
import type { KindModule } from '../registry';
import { countLine, inventory, people, slotPanels } from '../slots';
import type { KindCtx, KindView } from '../types';
import { fixed, type KindNotice, lookInto, newer, UNTIL } from './lines';
import { optional, readJson, StatusProblem } from './net';
import {
  ago,
  cardOf,
  fullTone,
  seenOf,
  serviceUrl,
  statusOf,
  unreadView,
  usedKpi,
  usedOf,
  worstFirst,
} from './shared';

const NAME = 'Nextcloud';
const OCS = { 'OCS-APIRequest': 'true' };
/** Free space under these is worth a look: amber under 10 GB, red under 2 GB (SD-S17; Nextcloud gives no total). */
export const FREE_WARN_BYTES = 10e9;
export const FREE_BAD_BYTES = 2e9;
/** Apps with updates listed. */
const APPS_MAX = 12;
/** Users read for Who uses most space: a big Nextcloud's first ones, by Nextcloud's own order. */
export const USERS_MAX = 100;
/** Who uses how much changes slowly: read again after 10 minutes. */
const USERS_KEEP_MS = 600_000;

/* Reading ------------------------------------------------------------------------------------------------------------ */

export interface NextcloudInfo {
  version: string | null;
  freeBytes: number | null;
  files: number | null;
  users: number | null;
  disabledUsers: number | null;
  active: { hour: number | null; day: number | null; week: number | null; month: number | null };
  shares: {
    total: number | null;
    links: number | null;
    linksOpen: number | null;
    people: number | null;
    groups: number | null;
    mail: number | null;
    talk: number | null;
    sent: number | null;
    received: number | null;
  } | null;
  /** Null when this Nextcloud didn't say (an older Monitoring app, or the skips weren't honoured). */
  update: { available: boolean; version: string | null } | null;
  apps: { installed: number | null; updates: { id: string; version: string }[] } | null;
  database: { type: string; version: string | null; bytes: number | null } | null;
}

export interface NextcloudSnapshot {
  readAt: Date;
  /** The Monitoring app's answer; null when the account isn't an admin. */
  info: NextcloudInfo | null;
  /** The account's own storage, when it isn't an admin (`/ocs/v2.php/cloud/user`). */
  quota: { used: number; total: number | null } | null;
}

/** “35.0.2.2” → “35.0.2”. */
export function shortVersion(v: string | null): string | null {
  if (!v) return null;
  return v.split('.').slice(0, 3).join('.').slice(0, 40);
}

const DB_NAMES: Record<string, string> = {
  sqlite3: 'SQLite',
  sqlite: 'SQLite',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  pgsql: 'PostgreSQL',
  postgres: 'PostgreSQL',
  oci: 'Oracle',
};

/** The Monitoring app's answer (`ocs.data`). */
export function parseInfo(body: unknown): NextcloudInfo {
  const data = rec(rec(rec(body).ocs).data);
  const nc = rec(data.nextcloud);
  const system = rec(nc.system);
  const storage = rec(nc.storage);
  const shares = rec(nc.shares);
  const active = rec(data.activeUsers);
  const db = rec(rec(data.server).database);
  const update = rec(system.update);
  const apps = rec(system.apps);
  const appUpdates = rec(apps.app_updates);
  const hasShares = Object.keys(shares).length > 0;
  const dbType = str(db.type);
  return {
    version: shortVersion(str(system.version)),
    freeBytes: num(system.freespace),
    files: num(storage.num_files),
    users: num(storage.num_users),
    disabledUsers: num(storage.num_disabled_users),
    active: {
      hour: num(active.last1hour),
      day: num(active.last24hours),
      week: num(active.last7days),
      month: num(active.last1month),
    },
    shares: hasShares
      ? {
          total: num(shares.num_shares),
          links: num(shares.num_shares_link),
          linksOpen: num(shares.num_shares_link_no_password),
          people: num(shares.num_shares_user),
          groups: num(shares.num_shares_groups),
          mail: num(shares.num_shares_mail),
          talk: num(shares.num_shares_room),
          sent: num(shares.num_fed_shares_sent),
          received: num(shares.num_fed_shares_received),
        }
      : null,
    update:
      typeof update.available === 'boolean'
        ? {
            available: update.available,
            version: shortVersion(str(update.available_version) ?? str(update.versionstring)),
          }
        : null,
    apps: Object.keys(apps).length
      ? {
          installed: num(apps.num_installed),
          // `app_updates` is `{ "<app id>": "<version>" }`, or `[]` when there are none.
          updates: Object.entries(appUpdates)
            .filter(([, v]) => typeof v === 'string')
            .map(([id, v]) => ({ id: clip(id, 60), version: clip(v as string, 30) })),
        }
      : null,
    database: dbType
      ? { type: DB_NAMES[dbType.toLowerCase()] ?? dbType, version: str(db.version), bytes: num(db.size) }
      : null,
  };
}

/** `/ocs/v2.php/cloud/user`: the account's own storage (`quota.total` absent or below 0: no limit). */
export function parseQuota(body: unknown): NextcloudSnapshot['quota'] {
  const q = rec(rec(rec(rec(body).ocs).data).quota);
  const used = num(q.used);
  if (used === null) return null;
  const limit = num(q.quota);
  const total = num(q.total);
  return { used, total: limit !== null && limit >= 0 && total !== null && total > 0 ? total : null };
}

/** The read; an account that isn't an admin gets its own storage only. */
export async function readNextcloud(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<NextcloudSnapshot> {
  try {
    const info = await readJson(services, row, NAME, {
      path: '/ocs/v2.php/apps/serverinfo/api/v1/info',
      query: { format: 'json', skipApps: 'false', skipUpdate: 'false' },
      headers: OCS,
    });
    return { readAt: now, info: parseInfo(info), quota: null };
  } catch (err) {
    if (!(err instanceof StatusProblem)) throw err;
    if (err.status === 404)
      throw new ReadProblem(
        'Nextcloud’s Monitoring app is off. Turn it on under Apps to see its overview here.',
      );
    if (err.status !== 401 && err.status !== 403) throw err;
    // Nextcloud answers 401 to an account that isn't an admin: whether the sign-in itself works decides.
    const user = await readJson(services, row, NAME, {
      path: '/ocs/v2.php/cloud/user',
      query: { format: 'json' },
      headers: OCS,
    });
    return { readAt: now, info: null, quota: parseQuota(user) };
  }
}

/** One of Nextcloud's users (`/ocs/v2.php/cloud/users/details`): what they use of their quota, and when they were on. */
export interface NextcloudUser {
  id: string;
  name: string;
  enabled: boolean;
  used: number;
  /** Their quota in bytes; null without one. */
  quota: number | null;
  /** Their last sign-in; null when they never signed in. */
  lastLogin: Date | null;
}

/** `/ocs/v2.php/cloud/users/details`: users by id (`[]` when there are none). */
export function parseUsers(body: unknown): NextcloudUser[] {
  const users = rec(rec(rec(body).ocs).data).users;
  const raws = Array.isArray(users) ? users : Object.values(rec(users));
  return raws.flatMap((raw) => {
    const u = rec(raw);
    const id = str(u.id);
    if (!id) return [];
    const q = rec(u.quota);
    const limit = num(q.quota);
    const last = num(u.lastLogin);
    return [
      {
        id: clip(id, 80),
        name: clip(str(u.displayname) ?? str(u['display-name']) ?? id, 80),
        enabled: u.enabled !== false,
        used: Math.max(0, num(q.used) ?? 0),
        quota: limit !== null && limit > 0 ? limit : null,
        lastLogin: last ? new Date(last) : null,
      },
    ];
  });
}

/** Every user with their space and last sign-in (an admin's), kept 10 minutes; null when it can't be read. */
export function readUsers(services: Services, row: CatalogConnectionRow): Promise<NextcloudUser[] | null> {
  return optional(
    cachedRead(
      services,
      `nextcloud-users:${row.id}`,
      row,
      async () =>
        parseUsers(
          await readJson(services, row, NAME, {
            path: '/ocs/v2.php/cloud/users/details',
            query: { format: 'json', limit: String(USERS_MAX) },
            headers: OCS,
          }),
        ),
      USERS_KEEP_MS,
    ),
  );
}

function load(services: Services, row: CatalogConnectionRow, now: Date) {
  return async () => {
    try {
      return await withDeadline(
        readNextcloud(services, row, now),
        KIND_DEADLINE_MS,
        `${NAME} didn’t answer in time.`,
      );
    } catch (err) {
      throw problemOf(err, NAME);
    }
  };
}

export function nextcloudLatest(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return latestRead(services, `nextcloud:${row.id}`, row, load(services, row, now));
}

export function nextcloudSnapshot(services: Services, row: CatalogConnectionRow, now = services.clock()) {
  return cachedRead(services, `nextcloud:${row.id}`, row, load(services, row, now));
}

/* What it shows ------------------------------------------------------------------------------------------------------ */

export interface NextcloudInput {
  snapshot: NextcloudSnapshot;
  url: string;
  /** Its users (an admin's read); absent or null: not read. */
  users?: NextcloudUser[] | null;
  now?: Date;
}

/** Updates waiting: Nextcloud's own and its apps'. */
function updateCount(i: NextcloudInfo): number | null {
  if (!i.update && !i.apps) return null;
  return (i.update?.available ? 1 : 0) + (i.apps?.updates.length ?? 0);
}

/** The card's figures (Active today and Free space, or Your storage). */
export function figures(s: NextcloudSnapshot): ThingPageKpi[] {
  const out: ThingPageKpi[] = [];
  const i = s.info;
  if (!i) {
    if (s.quota)
      out.push(
        s.quota.total
          ? usedKpi('yours', 'Your storage', s.quota.used, s.quota.total)
          : { key: 'yours', label: 'Your storage', value: bytes(s.quota.used), sub: 'No limit' },
      );
    return out;
  }
  if (i.active.day !== null)
    out.push({
      key: 'active',
      label: 'Active today',
      value: thousands(i.active.day),
      ...(i.users !== null ? { sub: `of ${plural(i.users, 'user')}` } : {}),
    });
  if (i.files !== null)
    out.push({
      key: 'files',
      label: 'Files',
      value: thousands(i.files),
      ...(i.shares?.total != null ? { sub: plural(i.shares.total, 'share') } : {}),
    });
  if (i.freeBytes !== null) {
    const tone = i.freeBytes < FREE_BAD_BYTES ? 'bad' : i.freeBytes < FREE_WARN_BYTES ? 'warn' : undefined;
    out.push({
      key: 'free',
      label: 'Free space',
      value: bytes(i.freeBytes),
      sub: 'for files',
      ...(tone ? { tone } : {}),
    });
  }
  const n = updateCount(i);
  if (n !== null) {
    const parts = [
      i.update?.available ? `Nextcloud ${i.update.version ?? 'update'}` : null,
      i.apps?.updates.length ? plural(i.apps.updates.length, 'app') : null,
    ].filter(Boolean);
    out.push({
      key: 'updates',
      label: 'Updates',
      value: String(n),
      sub: parts.length ? parts.join(' · ') : 'All up to date',
    });
  }
  return out;
}

/* Worth a look (quiet-notices.md QN-01…QN-04, QN-S4x) ------------------------------------------------------------------ */

/** Every check Nextcloud's page can raise (QN-15). */
export const NEXTCLOUD_CHECKS: readonly KindCheck[] = [
  {
    check: 'nextcloud.not_admin',
    name: 'Connected without an admin account',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
  {
    check: 'nextcloud.free',
    name: 'Free space running out',
    nature: 'problem',
    perItem: false,
    startsOn: true,
  },
  { check: 'nextcloud.update', name: 'Nextcloud updates', nature: 'fyi', perItem: false, startsOn: false },
  { check: 'nextcloud.app_update', name: 'App updates', nature: 'fyi', perItem: false, startsOn: false },
];

/** The checks this read couldn't see (QN-11): an account that isn't an admin, or a part Nextcloud didn't say. */
export function nextcloudSkipped(s: NextcloudSnapshot): string[] {
  const i = s.info;
  if (!i) return ['nextcloud.free', 'nextcloud.update', 'nextcloud.app_update'];
  return [
    ...(i.freeBytes === null ? ['nextcloud.free'] : []),
    ...(i.update === null ? ['nextcloud.update'] : []),
    ...(i.apps === null ? ['nextcloud.app_update'] : []),
  ];
}

function notices(input: NextcloudInput): KindNotice[] {
  const { snapshot: s, url } = input;
  const out: KindNotice[] = [];
  const i = s.info;
  if (!i) {
    out.push({
      id: 'not-admin',
      tone: 'info',
      icon: 'key',
      title: 'Nextcloud shows its overview to admins only',
      detail: 'Connect it with an admin’s app password to see users, files and updates here.',
      nature: 'fyi',
      check: 'nextcloud.not_admin',
      ignore: fixed('Until it’s connected as an admin.'),
    });
    return out;
  }
  if (i.freeBytes !== null && i.freeBytes < FREE_WARN_BYTES)
    out.push({
      id: 'free',
      tone: i.freeBytes < FREE_BAD_BYTES ? 'bad' : 'warn',
      icon: 'disk',
      title: `Only ${bytes(i.freeBytes)} free for files`,
      detail: 'Uploads fail when it runs out.',
      link: lookInto('What is taking the space on Nextcloud’s disk, and what can go?'),
      nature: 'problem',
      check: 'nextcloud.free',
      ignore: fixed(UNTIL.fuller),
    });
  if (i.update?.available)
    out.push({
      id: 'update',
      tone: 'info',
      icon: 'update',
      title: 'Nextcloud has an update',
      ...(i.update.version
        ? { detail: `Version ${i.update.version}${i.version ? `; this one runs ${i.version}` : ''}.` }
        : {}),
      link: { kind: 'url', label: 'Open updates', url: `${url}/settings/admin/overview` },
      nature: 'fyi',
      check: 'nextcloud.update',
      ignore: newer(UNTIL.version),
      episode: i.update.version ?? 'unknown',
    });
  // App updates are one line (a heads-up per app made the card a list); Open apps shows which. Its Ignore lasts while
  // the same apps wait at the same versions.
  const apps = i.apps?.updates ?? [];
  if (apps.length)
    out.push({
      id: 'app-updates',
      tone: 'info',
      icon: 'update',
      title: `${plural(apps.length, 'Nextcloud app')} ${apps.length === 1 ? 'has an update' : 'have updates'}`,
      link: { kind: 'url', label: 'Open apps', url: `${url}/settings/apps/updates` },
      nature: 'fyi',
      check: 'nextcloud.app_update',
      ignore: newer(UNTIL.version),
      episode: shortHash(apps.map((a) => `${a.id}@${a.version}`)),
    });
  return worstFirst(out);
}

/** In Nextcloud (Inventory): its files, users with who was on today, shares and apps; else the account's own storage. */
function holdings(input: NextcloudInput) {
  const { snapshot: s, url } = input;
  const i = s.info;
  const items: ThingPageItem[] = [];
  if (!i) {
    if (s.quota) {
      const tone = s.quota.total ? fullTone((s.quota.used / s.quota.total) * 100) : undefined;
      items.push(
        countLine({
          id: 'yours',
          title: 'Your files',
          icon: 'disk',
          value: s.quota.total ? usedOf(s.quota.used, s.quota.total) : bytes(s.quota.used),
          note: s.quota.total ? `${Math.round((s.quota.used / s.quota.total) * 100)} % used` : 'No limit',
          ...(tone ? { noteTone: tone, tone } : {}),
          url: `${url}/apps/files`,
        }),
      );
    }
  } else {
    if (i.files !== null)
      items.push(
        countLine({
          id: 'files',
          title: 'Files',
          icon: 'disk',
          value: thousands(i.files),
          url: `${url}/apps/files`,
        }),
      );
    if (i.users !== null) {
      const a = i.active;
      const detail = [
        a.week !== null ? `${a.week} this week` : null,
        i.disabledUsers ? `${i.disabledUsers} turned off` : null,
      ].filter(Boolean);
      items.push(
        countLine({
          id: 'users',
          title: 'Users',
          icon: 'key',
          ...(detail.length ? { detail: detail.join(' · ') } : {}),
          value: thousands(i.users),
          ...(a.day !== null
            ? a.day > 0
              ? { note: `${thousands(a.day)} on today`, noteTone: 'ok' as const }
              : { note: 'Nobody on today' }
            : {}),
          url: `${url}/settings/users`,
        }),
      );
    }
    if (i.shares?.total != null) {
      const sh = i.shares;
      // Short enough for a third of the page: links, and everyone else shared with in one count. An open link is
      // one without a password.
      const withOthers = (sh.people ?? 0) + (sh.groups ?? 0) + (sh.mail ?? 0) + (sh.talk ?? 0);
      const words = [
        sh.links ? plural(sh.links, 'link') : null,
        withOthers ? `${thousands(withOthers)} with people` : null,
      ].filter(Boolean);
      const fed = (sh.sent ?? 0) + (sh.received ?? 0);
      items.push(
        countLine({
          id: 'shares',
          title: 'Shares',
          icon: 'network',
          ...(words.length ? { detail: words.join(' · ') } : {}),
          value: thousands(sh.total ?? 0),
          ...(sh.linksOpen
            ? { note: `${thousands(sh.linksOpen)} open ${sh.linksOpen === 1 ? 'link' : 'links'}` }
            : fed
              ? { note: `${thousands(fed)} with other servers` }
              : {}),
          url: `${url}/apps/files/sharingout`,
        }),
      );
    }
    if (i.apps?.installed != null) {
      const n = i.apps.updates.length;
      items.push(
        countLine({
          id: 'apps',
          title: 'Apps',
          icon: 'plug',
          value: thousands(i.apps.installed),
          note: n ? `${plural(n, 'update')} waiting` : 'All up to date',
          url: `${url}/settings/apps${n ? '/updates' : ''}`,
        }),
      );
    }
  }
  if (!items.length) return null;
  return inventory({
    id: 'cloud',
    title: i ? 'In Nextcloud' : 'Your storage',
    ...(i ? {} : { meta: 'Only an admin sees the rest' }),
    items,
  });
}

/** Who uses most space: each user's space, their quota when nearly full (amber), and when they were last on. */
function whoUsesMost(input: NextcloudInput) {
  const now = input.now ?? input.snapshot.readAt;
  const users = [...(input.users ?? [])].filter((u) => u.used > 0).sort((a, b) => b.used - a.used);
  return people({
    title: 'Who uses most space',
    ...(input.users?.length ? { meta: plural(input.users.length, 'user') } : {}),
    items: users.map((u) => {
      const tone = u.quota ? fullTone((u.used / u.quota) * 100) : undefined;
      const on = u.lastLogin && now.getTime() - u.lastLogin.getTime() < 86_400_000;
      return {
        name: u.name,
        n: u.used,
        value: bytes(u.used),
        note: !u.enabled
          ? 'Turned off'
          : on
            ? 'On today'
            : u.lastLogin
              ? `Last seen ${ago(u.lastLogin, now)}`
              : 'Never signed in',
        ...(u.quota ? { sub: `Quota ${bytes(u.quota)}` } : {}),
        ...(tone ? { tone } : {}),
      };
    }),
  });
}

/** Nextcloud's lines in the machine card: its version and whether a newer one is out, the free space, the database. */
export function nextcloudMachineLines(i: NextcloudInfo | null): ThingPageBar[] {
  if (!i) return [];
  const out: ThingPageBar[] = [];
  if (i.version)
    out.push({
      id: 'nextcloud-version',
      label: 'Nextcloud',
      value: i.version,
      pct: null,
      ...(i.update?.available
        ? { sub: clip(`Version ${i.update.version ?? 'update'} is out`, 120) }
        : i.update
          ? { sub: 'Up to date', subTone: 'ok' as const }
          : {}),
    });
  if (i.freeBytes !== null) {
    const tone = i.freeBytes < FREE_BAD_BYTES ? 'bad' : i.freeBytes < FREE_WARN_BYTES ? 'warn' : undefined;
    out.push({
      id: 'free',
      label: 'Free for files',
      value: bytes(i.freeBytes),
      pct: null,
      ...(tone ? { tone, sub: 'Uploads fail when it runs out', subTone: tone } : {}),
    });
  }
  if (i.database)
    out.push({
      id: 'database',
      label: 'Database',
      value: clip([i.database.type, i.database.version].filter(Boolean).join(' '), 40),
      pct: null,
      ...(i.database.bytes !== null ? { sub: bytes(i.database.bytes) } : {}),
    });
  return out;
}

/** The page's Nextcloud part (SD-57), in slots, from what was read; pure. */
export function nextcloudView(input: NextcloudInput): KindView {
  const { snapshot: s, url } = input;
  const i = s.info;
  const more: ThingPagePanel[] = [];
  if (i?.apps?.updates.length) {
    const items: ThingPageItem[] = i.apps.updates.slice(0, APPS_MAX).map((u) => ({
      id: `app-${u.id}`,
      title: u.id,
      right: u.version,
      icon: 'update',
    }));
    more.push({
      kind: 'list',
      id: 'apps',
      place: 'main',
      title: 'Apps with updates',
      meta: i.apps.installed !== null ? `${plural(i.apps.installed, 'app')} installed` : '',
      link: { kind: 'url', label: 'Open apps', url: `${url}/settings/apps/updates` },
      items,
    });
  }
  const facts: ThingLine[] = [];
  if (i?.version) facts.push(line(`Nextcloud **${i.version}**`));
  if (i?.users != null) facts.push(line(`**${thousands(i.users)}** ${i.users === 1 ? 'user' : 'users'}`));
  const shown = notices(input);
  const calm =
    i?.active.day != null ? `${plural(i.active.day, 'person', 'people')} active today` : 'Running fine';
  return {
    // Its counts are in In Nextcloud; the card keeps its figures (`figures`).
    kpis: [],
    charts: [],
    machine: 'after',
    notices: shown,
    ...slotPanels({
      inventory: holdings(input),
      people: whoUsesMost(input),
      more,
      machine: nextcloudMachineLines(i),
    }),
    tabs: [],
    facts,
    status: statusOf(shown, calm),
    open: { label: 'Open Nextcloud', url },
    actions: [],
    readAt: s.readAt,
    suggestions: ['Who shares the most', 'Biggest folders', 'Files added this week'],
  };
}

/* The page ----------------------------------------------------------------------------------------------------------- */

export async function nextcloudPage(ctx: KindCtx): Promise<KindView> {
  const { services, row, now } = ctx;
  const url = serviceUrl(row);
  const read = await nextcloudLatest(services, row, now);
  if (!read.ok) return unreadView(NAME, url, problemOf(read.error, NAME).message, read.refreshing);
  // Only an admin may list the users.
  const users = read.value.info ? await readUsers(services, row) : null;
  return { ...nextcloudView({ snapshot: read.value, url, users, now }), refreshing: read.refreshing };
}

export const NEXTCLOUD_KIND: KindModule = {
  page: nextcloudPage,
  prefetch: (services, row, now) => nextcloudLatest(services, row, now),
  async seen(services, row, now) {
    const s = await nextcloudSnapshot(services, row, now);
    const view = nextcloudView({ snapshot: s, url: serviceUrl(row) });
    const version = s.info?.version;
    return seenOf(
      cardOf(
        { kpis: figures(s), notices: view.notices },
        s.info ? ['active', 'free'] : ['yours'],
        version ? `Files · Nextcloud ${version}` : 'Files',
      ),
      view.notices as KindNotice[],
      nextcloudSkipped(s),
    );
  },
  checks: NEXTCLOUD_CHECKS,
};
