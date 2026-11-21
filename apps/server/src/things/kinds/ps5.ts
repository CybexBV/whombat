import type { Ps5Console, ThingGalleryItem, ThingImage, ThingPageBar, ThingPagePanel } from '@whombat/core';
import { externalEffect } from '../../commit/scope';
import { connectionDatagram, connectionLine, signedConnectionFetch } from '../../connections/http';
import {
  type Ps5Context,
  type Ps5Snapshot,
  ps5CoverPath,
  readPs5Console,
  readPs5Snapshot,
} from '../../connections/ps5-api';
import type { CatalogConnectionRow } from '../../connections/types';
import type { Services } from '../../services';
import { imageRef, thingImage } from '../images';
import type { KindCheck, KindNotice } from '../quiet/types';
import { bytes, clip, dayMonth, line, plural } from '../words';
import {
  describePs5Update,
  PS5_UPDATE_ACTIONS,
  type Ps5ButtonCtx,
  ps5UpdateAllButton,
  ps5UpdateButton,
  updatable,
} from './ps5-update';
import { cachedRead, KIND_DEADLINE_MS, KIND_MAX_BYTES, latestRead, withDeadline } from './read';
import type { KindModule } from './registry';
import { countLine, inventory, liveList, shelf, slotPanels } from './slots';
import type { KindView } from './types';

export const PS5_CHECKS: readonly KindCheck[] = [
  {
    check: 'ps5.available',
    name: 'Whether homebrew is ready',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
  { check: 'ps5.updates', name: 'Homebrew updates', nature: 'fyi', perItem: false, startsOn: false },
  {
    check: 'ps5.startup',
    name: 'Homebrew that didn’t start',
    nature: 'problem',
    perItem: false,
    startsOn: false,
  },
];

/** How the page reads the console: every request under the connection's policy, as a read. */
function context(services: Services, row: CatalogConnectionRow): Ps5Context {
  return {
    baseUrl: row.baseUrl,
    fields: row.fields,
    send: (req) =>
      externalEffect(
        'things.read',
        () =>
          signedConnectionFetch(services, row, req, {
            maxBytes: KIND_MAX_BYTES,
            deadlineMs: KIND_DEADLINE_MS,
          }),
        { idempotent: true },
      ),
    datagram: (port, payload) => connectionDatagram(services, row, port, payload),
    line: (port, command, idempotent) => connectionLine(services, row, port, command, idempotent),
  };
}

function load(services: Services, row: CatalogConnectionRow, now: Date) {
  return withDeadline(
    readPs5Snapshot(context(services, row)).then((s) => ({ ...s, readAt: now })),
    KIND_DEADLINE_MS,
    'Homebrew isn’t ready just now.',
  );
}

/** The console's own answer, read apart from homebrew: it answers while homebrew doesn't. */
function loadConsole(services: Services, row: CatalogConnectionRow) {
  return latestRead(services, `ps5-console:${row.id}`, row, () => readPs5Console(context(services, row)));
}

/** How the page draws pictures and dates; tests give their own. */
export interface Ps5ViewCtx {
  now: Date;
  timeZone: string;
  cover?: (path: string, alt: string) => ThingImage | undefined;
  /** Who reads it, for its Update buttons; absent: no buttons. */
  buttons?: Ps5ButtonCtx;
}

const OUTCOME_WORDS = { started: 'Started', failed: 'Didn’t start', skipped: 'Skipped' } as const;
const RUN_WORDS = {
  running: 'Starting now',
  done: 'Last start finished',
  stopped: 'Last start was stopped on the PS5',
  failed: 'Last start couldn’t read its list',
} as const;

const consoleOf = (c: Ps5Console | 'silent' | null) => (c && c !== 'silent' ? c : null);

/** Worth a look: updates (a heads-up) and startup payloads that didn't start. */
export function ps5Notices(s: Ps5Snapshot, bctx?: Ps5ButtonCtx): KindNotice[] {
  const out: KindNotice[] = [];
  const failed = (s.startup?.entries ?? []).filter((e) => e.outcome === 'failed');
  if (failed.length) {
    const names = failed.map((e) => nameOf(s, e.slot));
    out.push({
      id: 'startup-failed',
      tone: 'warn',
      icon: 'power',
      title:
        failed.length === 1
          ? `${clip(names[0] ?? '', 60)} didn’t start`
          : `${plural(failed.length, 'payload')} didn’t start`,
      detail: clip(
        `${names.join(', ')} ${failed.length === 1 ? 'was' : 'were'} in homebrew startup but didn’t start. Whombat can look at the log and run it again.`,
        300,
      ),
      nature: 'problem',
      check: 'ps5.startup',
      ignore: { lifts: 'newer', words: 'Until another start goes wrong.' },
      episode: failed.map((e) => e.slot).join(','),
    });
  }
  const newer = (s.updates ?? []).filter(updatable);
  // One update: its own button; more: Update all when they can go together.
  const button = bctx
    ? newer.length === 1 && newer[0]
      ? ps5UpdateButton(newer[0], bctx)
      : ps5UpdateAllButton(newer, bctx)
    : null;
  if (newer.length)
    out.push({
      id: 'updates',
      tone: 'info',
      icon: 'update',
      title:
        newer.length === 1
          ? `${clip(newer[0]?.name ?? '', 60)} ${newer[0]?.available.version ?? ''} is out`
          : `${plural(newer.length, 'homebrew update')} available`,
      detail: clip(
        `${newer.map((u) => `${u.name} ${u.available.version}`).join(', ')}. Update ${newer.length === 1 ? 'it' : 'them'} here, or ask Whombat.`,
        200,
      ),
      ...(button ? { action: button } : {}),
      nature: 'fyi',
      check: 'ps5.updates',
      ignore: { lifts: 'newer', words: 'Until another version comes out.' },
      episode: newer.map((u) => `${u.slot}@${u.available?.version}`).join(','),
    });
  return out;
}

/** A slot's name as people know it: its own name, its file's name, else the slot. */
function nameOf(s: Ps5Snapshot, slot: string): string {
  const p = s.payloads.items.find((i) => i.slot === slot);
  const u = s.updates?.find((x) => x.slot === slot);
  return u?.name || p?.name || p?.filename || slot;
}

function gameItem(
  g: NonNullable<Ps5Snapshot['games']>['games'][number],
  i: number,
  ctx: Ps5ViewCtx,
): ThingGalleryItem {
  const path = ps5CoverPath(g.title_id, g.icon_url);
  const image = path ? ctx.cover?.(path, g.title_name) : undefined;
  return {
    id: `game-${i}`,
    title: clip(g.title_name, 120),
    sub: clip(`${g.version} · ${g.platform.toUpperCase()}`, 120),
    ...(image ? { image } : {}),
    ...(!g.source_available
      ? { badge: { text: 'Source missing', tone: 'warn' as const } }
      : g.mounted
        ? { badge: { text: 'Mounted', tone: 'ok' as const } }
        : {}),
  };
}

/** Only user storage belongs here; firmware partitions are not useful space to manage. */
export function ps5View(s: Ps5Snapshot, ctx: Ps5ViewCtx): KindView {
  const daemons = s.processes?.processes.filter((p) => p.is_daemon);
  const seen = consoleOf(s.console);
  const updates = new Map((s.updates ?? []).map((u) => [u.slot, u]));
  const newer = (s.updates ?? []).filter(updatable);
  const running = {
    id: 'running',
    title: 'Running homebrew',
    items: (daemons ?? []).slice(0, 40).map((p) => ({
      id: `process-${p.pid}`,
      title: clip(p.name, 160),
      right: bytes(p.memory * 1024 * 1024),
    })),
    empty: daemons ? 'No running homebrew reported.' : 'Running homebrew couldn’t be read.',
  };
  const more: ThingPagePanel[] = [];
  // While updates wait, they are what happens now: To update takes Live and Running homebrew moves below.
  if (newer.length) more.push({ kind: 'list', ...running });
  more.push({
    kind: 'text',
    id: 'remote-reboot',
    title: 'Remote reboot',
    body: s.power?.ready
      ? 'Ready. Ask Whombat to reboot your PS5. Wait for updates to finish first, then open WebKit Autoloader again afterwards.'
      : 'Ask Whombat to enable remote reboot. It adds a small helper while Payload Manager is running. You’ll need to open WebKit Autoloader again after restarting.',
  });
  const mounts = s.storage?.mounts.filter(
    (m) => m.mount_point === '/user' || /^\/mnt\/(?:usb|ext)\d+$/.test(m.mount_point),
  );
  if (mounts?.length)
    more.push({
      kind: 'bars',
      id: 'storage',
      title: 'Storage',
      items: mounts.map((m, i) => ({
        id: `storage-${i}`,
        label: m.mount_point === '/user' ? 'Internal storage' : clip(m.mount_point, 80),
        value: `${bytes(m.available_bytes)} free`,
        pct: m.total_bytes ? Math.min(1, m.used_bytes / m.total_bytes) : null,
        sub: `${bytes(m.used_bytes)} of ${bytes(m.total_bytes)} used${m.read_only ? ' · Read only' : ''}`,
      })),
    });
  // A library larger than the shelf holds is listed in full here.
  if (s.games && s.games.games.length > 48)
    more.push({
      kind: 'table',
      id: 'games',
      title: 'All games',
      meta: plural(s.games.games.length, 'title'),
      columns: [
        { key: 'name', label: 'Game' },
        { key: 'version', label: 'Version' },
        { key: 'state', label: 'State' },
      ],
      rows: s.games.games.slice(0, 200).map((g, i) => ({
        id: `game-${i}`,
        cells: {
          name: { text: clip(g.title_name, 160), note: clip(`${g.platform} · ${g.title_id}`, 120) },
          version: { text: clip(g.version, 80) },
          state: {
            text: g.mounted ? 'Mounted' : g.installed ? 'Installed' : 'In library',
            ...(!g.source_available ? { note: 'Source isn’t available' } : {}),
          },
        },
      })),
    });
  if (s.config) {
    const bySlot = new Map(s.payloads.items.map((p) => [p.slot, p]));
    const outcomes = new Map((s.startup?.entries ?? []).map((e) => [e.slot, e.outcome]));
    more.push({
      kind: 'list',
      id: 'startup',
      title: 'Homebrew startup',
      meta: [
        s.config.AUTOLOAD_ENABLED ? 'On' : 'Off',
        `Wait ${s.config.AUTOLOAD_DELAY} s before starting`,
        s.config.AUTOLOAD_ENABLED && s.startup ? RUN_WORDS[s.startup.state] : null,
      ]
        .filter(Boolean)
        .join(' · '),
      items: s.config.AUTOLOAD_LIST.split(',')
        .filter(Boolean)
        .slice(0, 100)
        .map((slot, i) => {
          const outcome = slot.startsWith('!') ? undefined : outcomes.get(slot);
          return {
            id: `startup-${i}`,
            title: clip(
              slot.startsWith('!')
                ? `Wait ${Number(slot.slice(1)) / 1000} s`
                : updates.get(slot)?.name || bySlot.get(slot)?.name || bySlot.get(slot)?.filename || slot,
              160,
            ),
            ...(!slot.startsWith('!') ? { detail: clip(slot, 180) } : {}),
            ...(outcome ? { right: OUTCOME_WORDS[outcome] } : {}),
            ...(outcome === 'failed' ? { tone: 'bad' as const } : {}),
          };
        }),
      empty: 'No payloads chosen for startup.',
    });
  }
  more.push({
    kind: 'table',
    id: 'payloads',
    title: 'Homebrew payloads',
    columns: [
      { key: 'name', label: 'Payload' },
      { key: 'version', label: 'Version' },
      { key: 'slot', label: 'Slot' },
    ],
    rows: s.payloads.items.slice(0, 200).map((p, i) => {
      const u = updates.get(p.slot);
      const installer = /install/i.test(`${p.id} ${p.filename}`);
      const webkit = installer && s.webkit ? s.webkit : null;
      return {
        id: `payload-${i}`,
        cells: {
          name: {
            text: clip(u?.name || p.name || p.filename, 160),
            ...(webkit
              ? {
                  note: clip(
                    `Installer · run by Whombat on ${dayMonth(new Date(webkit.at), ctx.timeZone)}`,
                    120,
                  ),
                }
              : installer
                ? { note: 'Downloaded installer · cached version unknown' }
                : {}),
          },
          version: {
            text: clip(u?.installed || p.version || 'Not reported', 80),
            ...(u?.newer && u.available
              ? { note: clip(`${u.available.version} available`, 120) }
              : !p.version && u?.installed
                ? { note: 'From its file name' }
                : {}),
          },
          slot: { text: clip(p.slot, 180), mono: true },
        },
      };
    }),
    empty: 'No homebrew payloads downloaded.',
  });
  if (s.unavailable.length)
    more.push({
      kind: 'text',
      id: 'unavailable',
      title: 'Some details aren’t ready',
      body: `${s.unavailable.join(', ')} couldn’t be read. Leave the homebrew services running on your PS5 to see them here.`,
    });
  const machine: ThingPageBar[] = [
    ...(seen
      ? [
          {
            id: 'console',
            label: clip(seen.name ?? 'PlayStation 5', 80),
            value: seen.firmware ? `Firmware ${seen.firmware}` : 'Awake',
            pct: null,
          },
        ]
      : []),
    {
      id: 'manager',
      label: 'Payload Manager',
      value: clip(s.payloads.self.running_version, 40),
      pct: null,
      ...(s.payloads.self.pending_version
        ? { sub: clip(`${s.payloads.self.pending_version} downloaded · restart to use`, 120) }
        : {}),
    },
    ...(s.shadow
      ? [{ id: 'shadow', label: 'ShadowMountPlus', value: clip(s.shadow.shadowmount_version, 40), pct: null }]
      : []),
    ...(s.webkit
      ? [
          {
            id: 'webkit',
            label: 'WebKit Autoloader',
            value: clip(s.webkit.version, 40),
            pct: null,
            sub: clip(
              `Updated by Whombat on ${dayMonth(new Date(s.webkit.at), ctx.timeZone)}${s.webkit.startedSince ? ' · started again since' : s.webkit.startedSince === false ? ' · restart your PS5 to use it' : ''}`,
              120,
            ),
          },
        ]
      : []),
  ];
  const games = s.games?.games ?? [];
  return {
    ...slotPanels({
      live: newer.length
        ? liveList({
            id: 'updates',
            title: 'To update',
            meta: plural(newer.length, 'update'),
            items: newer.slice(0, 40).map((u, i) => {
              const button = ctx.buttons ? ps5UpdateButton(u, ctx.buttons) : null;
              return {
                id: `update-${i}`,
                icon: 'update' as const,
                title: clip(`${u.name} ${u.installed ?? ''} → ${u.available.version}`, 160),
                detail: clip(
                  [
                    u.startup ? 'In startup' : null,
                    u.source === 'uploaded' ? 'Uploaded by hand' : null,
                    u.firmware
                      ? u.fits === false
                        ? `Doesn’t support firmware ${seen?.firmware}`
                        : `Firmware ${u.firmware.from}–${u.firmware.to}`
                      : 'Check its notes for firmware support',
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  300,
                ),
                ...(u.fits === false ? { tone: 'warn' as const } : {}),
                ...(button ? { actions: [button] } : {}),
              };
            }),
            ...(() => {
              const all = ctx.buttons ? ps5UpdateAllButton(newer, ctx.buttons) : null;
              return all ? { buttons: [all] } : {};
            })(),
          })
        : liveList(running),
      inventory: inventory({
        id: 'inventory',
        title: 'On your PS5',
        items: [
          countLine({
            id: 'games',
            title: 'Games',
            value: s.games ? String(s.games.games.length) : '—',
            note: 'In ShadowMountPlus',
          }),
          countLine({ id: 'payloads', title: 'Homebrew payloads', value: String(s.payloads.items.length) }),
          countLine({
            id: 'updates',
            title: 'Homebrew updates',
            value: s.updates ? String(newer.length) : '—',
          }),
          countLine({
            id: 'startup',
            title: 'Homebrew startup',
            value: s.config ? (s.config.AUTOLOAD_ENABLED ? 'On' : 'Off') : '—',
          }),
        ],
      }),
      shelf: s.games
        ? shelf({
            id: 'library',
            title: 'Your games',
            meta: plural(games.length, 'title'),
            shape: 'square',
            items: games.slice(0, 48).map((g, i) => gameItem(g, i, ctx)),
            empty: 'No games reported by ShadowMountPlus.',
          })
        : null,
      more,
      machine,
    }),
    kpis: [],
    charts: [],
    notices: ps5Notices(s, ctx.buttons),
    tabs: [],
    facts: [
      line(`Payload Manager **${clip(s.payloads.self.running_version, 40)}**`),
      ...(seen?.firmware ? [line(`Firmware **${seen.firmware}**`)] : []),
    ],
    status: { status: 'ok', badge: 'Homebrew is ready' },
    verdict: newer.length
      ? `Homebrew is ready. ${newer.length === 1 ? 'One update is' : `${newer.length} updates are`} available.`
      : 'Homebrew is ready. You can check your games, storage and startup here.',
    actions: [],
    readAt: null,
    suggestions: newer.length
      ? ['Update my homebrew', 'Explain my startup settings']
      : ['Check for homebrew updates', 'Explain my startup settings'],
  };
}

/** What the console said when homebrew didn't answer, in the page's words. */
const UNAVAILABLE = {
  awake: {
    badge: 'Homebrew isn’t running',
    title: 'Homebrew isn’t running',
    body: 'Your PS5 is on, but Payload Manager isn’t answering. Open WebKit Autoloader on your PS5 to start homebrew again.',
  },
  resting: {
    badge: 'Resting',
    title: 'Your PS5 is resting',
    body: 'Homebrew stops in rest mode. Wake your PS5 and open WebKit Autoloader to start it again.',
  },
  silent: {
    badge: 'Not answering',
    title: 'Your PS5 isn’t answering',
    body: 'It may be switched off, or resting without its network. Turn it on and open WebKit Autoloader to see it here.',
  },
  unknown: {
    badge: 'Homebrew isn’t ready',
    title: 'Homebrew isn’t ready',
    body: 'Open WebKit Autoloader on your PS5 and leave Payload Manager running. The PS5 may be resting, or its jailbreak may need opening again after a reboot.',
  },
} as const;

const unavailableOf = (c: Ps5Console | 'silent' | null) =>
  c === 'silent' ? UNAVAILABLE.silent : c ? UNAVAILABLE[c.state] : UNAVAILABLE.unknown;

export function ps5UnavailableView(seen: Ps5Console | 'silent' | null = null): KindView {
  const words = unavailableOf(seen);
  const known = consoleOf(seen);
  return {
    ...slotPanels({
      more: [{ kind: 'text', id: 'not-ready', title: words.title, body: words.body }],
      machine: known
        ? [
            {
              id: 'console',
              label: clip(known.name ?? 'PlayStation 5', 80),
              value: known.firmware
                ? `Firmware ${known.firmware}`
                : known.state === 'resting'
                  ? 'Resting'
                  : 'Awake',
              pct: null,
            },
          ]
        : [],
    }),
    notices: [],
    tabs: [],
    facts: known?.firmware ? [line(`Firmware **${known.firmware}**`)] : [],
    actions: [],
    readAt: null,
    suggestions: [],
    status: { status: 'ok', badge: words.badge },
    verdict: 'Whombat can read your PS5 while Payload Manager is running.',
  };
}

export const PS5_KIND: KindModule = {
  checks: PS5_CHECKS,
  asksFirst: 'homebrew changes always ask first',
  actions: PS5_UPDATE_ACTIONS,
  describe: (actx, action, input) => describePs5Update(actx, action, input, context),
  prefetch: (services, row, now) =>
    latestRead(services, `ps5:${row.id}`, row, () => load(services, row, now)),
  page: async ({ services, row, now, timeZone }) => {
    // The console's own answer is read alongside: when homebrew doesn't answer, it says why without a second wait.
    const pending = loadConsole(services, row).catch(() => null);
    const read = await latestRead(services, `ps5:${row.id}`, row, () => load(services, row, now));
    const cover = (path: string, alt: string) =>
      thingImage(imageRef({ services, row, now }, { path }), clip(alt, 120), 'square');
    if (read.ok)
      return {
        ...ps5View(read.value, { now, timeZone, cover, buttons: { row } }),
        readAt: read.value.readAt,
        refreshing: read.refreshing,
        open: { label: 'Open Payload Manager', url: row.baseUrl },
      };
    const seen = await pending;
    return {
      ...ps5UnavailableView(seen?.ok ? seen.value : null),
      refreshing: read.refreshing,
      open: { label: 'Open Payload Manager', url: row.baseUrl },
    };
  },
  seen: async (services, row, now) => {
    const s = await cachedRead(services, `ps5:${row.id}`, row, () => load(services, row, now));
    return {
      glance: {
        facts: [
          { label: 'Games', value: s.games ? String(s.games.games.length) : '—' },
          { label: 'Payloads', value: String(s.payloads.items.length) },
        ],
        line: 'Homebrew is ready',
      },
      points: {},
      notices: ps5Notices(s, { row }),
      // Updates and startup can't be judged without their reads: their Ignores don't end now.
      skipped: [...(s.updates ? [] : ['ps5.updates']), ...(s.startup ? [] : ['ps5.startup'])],
    };
  },
  unanswered: async (services, row) => {
    const seen = await loadConsole(services, row).catch(() => null);
    return unavailableOf(seen?.ok ? seen.value : null).badge;
  },
};
