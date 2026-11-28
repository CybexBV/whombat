/**
 * The Servers tools for Docker Compose apps (app-updates.md): `app_updates` reads which apps have a newer version, which
 * ask first and why, and how each one's last update went; `app_update` updates up to ten apps of one server as one task
 * on it — the agent pulls each app's image, restarts only that app (with the other services of its project that run the
 * same image), and puts the previous image back by itself when it doesn't come up.
 *
 * Asking: like a container update, it asks unless the server is set not to; a database's update, a new major version and
 * an update whose versions aren't known always ask (`ask: true` makes the catalog's rule apply on every server,
 * `serverAsksApply`), and the call refuses to run them without a person's yes. What the card says comes from the call's
 * `reasons`, so a yes always covers what it said: a run whose apps ask for more than the card said refuses and asks
 * again. An app whose new version turns out to be a major one, or isn't known, stays as it is (`hold_major`) unless the
 * yes said it may be a new major version.
 *
 * The yes is bound to what was checked (`expect`): the call carries, per app, its service, the image it runs, Compose's
 * hash of its settings and the exact newer image, read when it was asked for (`bindAppUpdateArgs`). No card is made for
 * an app Whombat can't bind, and a yes that isn't bound to every app it updates runs nothing. The update refuses an app
 * that changed since, and the agent deploys exactly that image.
 *
 * A snapshot first (`snapshot: true`): when the server is a Proxmox VM or container Whombat watches, Whombat takes a
 * snapshot of it and waits for it before the update starts. The task is followed: one plain line in the chat when it
 * ends (`appsOutcomeText`), Done recently records it, and the server stays quiet while it runs (planned work).
 */
import {
  APP_UPDATE_MAX,
  agentReportsApps,
  appUpdateRisk,
  appUpdateState,
  type HostGuest,
  isDatabaseImage,
  isMajorJump,
  versionWords,
} from '@whombat/core';
import type { Adapter } from '../connections/adapters/types';
import { ConnectionArgumentError } from '../connections/request';
import type { Services } from '../services';
import { keepQuietForWork, updateWork } from '../things/quiet/window-work';
import { type AddressIndex, addressIndex } from '../things/runs-on';
import { HOSTS_API, type HostsActor, seg } from './client';
import { arr, obj, str, toHostGuest, toHostManageResult } from './map';
import { type HostsChange, type HostsService, hostsFor, WHOMBAT_ACTOR } from './service';
import {
  call,
  changeOf,
  FOLLOWED_NOTE,
  follow,
  idsOf,
  opt,
  optBool,
  optStrList,
  output,
  req,
  resolveServer,
  S,
  scope,
  send,
} from './tools-shared';

/**
 * The arguments each of these tools takes (`checkArgs` refuses any other by name, so the agent hears what it got wrong).
 * `expect` is Whombat's own: what was checked of each app when the call was asked for.
 */
export const APP_TOOL_ARGS: Readonly<Record<string, readonly string[]>> = {
  app_updates: ['server'],
  app_update: ['server', 'apps', 'ask', 'reasons', 'snapshot', 'hold_major', 'reason', 'expect'],
};

/** What the card may say before the yes: the ask-first reasons and that the version isn't known. */
export const APP_CARD_REASONS = ['database', 'major', 'version_unknown'] as const;
export type AppCardReason = (typeof APP_CARD_REASONS)[number];

/** How long Whombat waits for the snapshot before the update. */
const SNAPSHOT_WAIT_MS = 3 * 60_000;

/** A container's name without its platform: `docker:immich_server` → `immich_server`. */
export const appName = (guestId: string) => guestId.replace(/^docker:/, '');

/**
 * What one app was when the call was asked for: its service, the image it runs, Compose's hash of its settings, the
 * newer image (its registry digest, null when the registry didn't say) and the facts the card's reasons came from. The
 * update deploys exactly this and refuses when the app is something else by then.
 */
export interface AppBinding {
  app: string;
  service: string;
  imageId: string;
  image: string;
  digest: string | null;
  configHash: string | null;
  version: string | null;
  newVersion: string | null;
}

/** Why an update asks first: a database, a new major version, or versions that aren't known (it may be a new major). */
export type AppAskFirst = AppCardReason;

/**
 * Why one app's update asks first, from what was read of it (pure). Without the newer image's digest the agent takes
 * whatever its tag names by then, so its version isn't known either.
 */
export function bindingReasons(
  b: Pick<AppBinding, 'image' | 'version' | 'newVersion' | 'digest'>,
): AppAskFirst[] {
  const out: AppAskFirst[] = [];
  if (isDatabaseImage(b.image)) out.push('database');
  if (isMajorJump(b.version, b.newVersion)) out.push('major');
  else if (!versionWords(b.version) || !versionWords(b.newVersion) || !b.digest) out.push('version_unknown');
  return out;
}

/**
 * What is read of one app for a call (pure). Null when Whombat can't tell which image it runs or with which Compose
 * settings: then nothing can be bound to it.
 */
export function bindingOf(g: HostGuest): AppBinding | null {
  if (!g.app?.configHash || !/^sha256:[0-9a-f]{64}$/.test(g.imageId ?? '')) return null;
  return {
    app: g.id,
    service: g.app.service,
    imageId: g.imageId as string,
    image: g.image,
    digest: g.app.newDigest ?? null,
    configHash: g.app.configHash ?? null,
    version: g.app.version,
    newVersion: g.app.newVersion,
  };
}

/** The facts the ask-first reasons come from, for an app Whombat can't bind (pure). */
function bindingFacts(g: HostGuest): Pick<AppBinding, 'image' | 'version' | 'newVersion' | 'digest'> {
  return {
    image: g.image,
    version: g.app?.version ?? null,
    newVersion: g.app?.newVersion ?? null,
    digest: g.app?.newDigest ?? null,
  };
}

/**
 * The apps a call updates: the ones named and every other Compose app of the same project that runs the same image,
 * running or not, healthy or not — the agent updates and puts those back together, so the card names them too (pure).
 * It can be more than one update takes (`APP_UPDATE_MAX`): the caller refuses then, naming the app.
 */
export function withSharedImage(all: readonly HostGuest[], picked: readonly HostGuest[]): HostGuest[] {
  const out = [...picked];
  for (const g of picked) {
    if (!g.project || !g.imageId) continue;
    for (const x of all)
      if (
        !out.includes(x) &&
        x.app &&
        !x.app.blocked &&
        !x.labels?.['whombat.service'] &&
        x.project === g.project &&
        x.imageId === g.imageId
      )
        out.push(x);
  }
  return out;
}

/** The app whose shared image makes an update more than one takes, or null (pure). */
export function tooManyWith(picked: readonly HostGuest[], apps: readonly HostGuest[]): HostGuest | null {
  if (apps.length <= APP_UPDATE_MAX) return null;
  return (
    picked.find((g) => apps.filter((x) => x.project === g.project && x.imageId === g.imageId).length > 1) ??
    picked[0] ??
    null
  );
}

/** Why Whombat can't bind a yes to an app, for the agent; null when it can (pure). */
export function unboundText(g: HostGuest, hasApps: boolean): string | null {
  if (bindingOf(g)) return null;
  const state = appUpdateState(g, hasApps);
  if (state === 'outdated')
    return 'This server’s helper is older than app updates; it gets the newer one by itself, then this works.';
  if (state === 'none')
    return `${g.name} wasn’t started with Docker Compose, so Whombat can’t update it (Whombat can update apps started with Docker Compose).`;
  return `Whombat can’t tell exactly which image ${g.name} runs or with which Compose settings, so it can’t update it now. Try again once app_updates lists it again.`;
}

/** Why an update of these apps is more than one takes, for the agent (pure). */
export const tooManyText = (g: HostGuest) =>
  `${g.name} and the services that share its image are more than ${APP_UPDATE_MAX} apps, which is the most one update takes.`;

/**
 * Why a call isn't bound when it is asked for: what the agent hears, and the failure it reads as (`unreachable` when the
 * apps couldn't be read).
 */
export class AppBindError extends Error {
  constructor(
    readonly reason: 'invalid_arguments' | 'unreachable',
    message: string,
  ) {
    super(message);
  }
}

/**
 * The `expect` a call carries, read back; null when it carries none or it isn't Whombat's shape (every app with its
 * service, image and Compose settings).
 */
export function parseBindings(raw: unknown): AppBinding[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > APP_UPDATE_MAX) return null;
  const text = (v: unknown, max: number) => (typeof v === 'string' && v && v.length <= max ? v : null);
  const out: AppBinding[] = [];
  for (const item of raw) {
    const o = obj(item);
    const app = text(o.app, 200);
    const service = text(o.service, 200);
    const imageId = text(o.imageId, 80);
    const image = text(o.image, 300);
    const configHash = text(o.configHash, 128);
    if (!app || !service || !imageId || image === null || !configHash) return null;
    out.push({
      app,
      service,
      imageId,
      image,
      digest: text(o.digest, 80),
      configHash,
      version: text(o.version, 64),
      newVersion: text(o.newVersion, 64),
    });
  }
  return out;
}

/** One app as an agent reads it (pure). */
export function appFacts(g: HostGuest, agentHasApps: boolean): Record<string, unknown> {
  const state = appUpdateState(g, agentHasApps);
  const risk = appUpdateRisk(g);
  const asks = state === 'available' || state === 'unknown' ? askFirstOf(g) : risk.reasons;
  const last = g.app?.last ?? null;
  return {
    app: g.id,
    name: g.name,
    ...(g.app ? { service: g.app.service } : {}),
    ...(g.project ? { project: g.project } : {}),
    image: g.image,
    state,
    ...(risk.from ? { version: risk.from } : {}),
    ...(risk.to ? { newVersion: risk.to } : {}),
    ...(state === 'available' && !risk.to ? { newVersionKnown: false } : {}),
    ...(asks.length ? { asksFirst: asks } : {}),
    ...(g.app?.blocked === 'pinned'
      ? { why: 'Its image is pinned to one exact version in its Compose file.' }
      : {}),
    ...(last
      ? {
          last: {
            result: last.status,
            ...(last.reason ? { reason: last.reason } : {}),
            ...(versionWords(last.from) ? { from: versionWords(last.from) } : {}),
            ...(versionWords(last.to) ? { to: versionWords(last.to) } : {}),
            ...(last.at ? { at: last.at } : {}),
          },
        }
      : {}),
  };
}

/** Why one app's update asks first, as Whombat reads it now (pure). */
function askFirstOf(g: HostGuest): AppAskFirst[] {
  return bindingReasons(bindingFacts(g));
}

/** What a card must say for these apps: why they ask first, a version that isn't known among them (pure). */
export function cardReasons(guests: readonly HostGuest[]): AppCardReason[] {
  return askReasons(guests);
}

/** The ask-first reasons of these apps (pure). */
export function askReasons(guests: readonly HostGuest[]): AppAskFirst[] {
  return askReasonsOf(guests.map(bindingFacts));
}

/** Whether a yes that said `said` covers `reason`: one that may be a new major version covers a version not known. */
export const yesCovers = (said: readonly string[], reason: AppAskFirst) =>
  said.includes(reason) || (reason === 'version_unknown' && said.includes('major'));

/** Whether a yes said the update may be a new major version: then the agent doesn't hold one back (pure). */
export const yesAllowsMajor = (said: readonly string[]) =>
  said.includes('major') || said.includes('version_unknown');

/** An app a call names: by its id first, then by its name (`immich_server`). */
export function findApp(all: readonly HostGuest[], raw: string): HostGuest | undefined {
  const want = raw.trim().toLowerCase();
  return (
    all.find((x) => x.id.toLowerCase() === want) ??
    all.find((x) => x.name.toLowerCase() === want || appName(x.id).toLowerCase() === want)
  );
}

/**
 * Binds an `app_update` call to what Whombat reads now, when it is asked for: the apps it names and those that share
 * their image, what each one is (`expect`), and every reason the card must say, besides the agent's own. Anything an
 * agent put in `expect` itself is dropped. When an app can't be bound, or the apps can't be read, it throws
 * `AppBindError` and no card is made.
 */
export async function bindAppUpdateArgs(
  services: Services,
  args: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  return bindAppArgs(args, async (server) => {
    const hosts = hostsFor(services);
    if (!hosts.present) throw new Error('no hosts service');
    const { id } = await resolveServer({ hosts }, server);
    return { id, all: await dockerGuests(hosts, WHOMBAT_ACTOR, id) };
  });
}

/** `bindAppUpdateArgs` with the server's apps read by `read` (a server it doesn't know: `ConnectionArgumentError`). */
export async function bindAppArgs(
  args: Readonly<Record<string, unknown>>,
  read: (server: string) => Promise<{ id: string; all: HostGuest[] }>,
): Promise<Record<string, unknown>> {
  const { expect: _theirs, ...rest } = args;
  const server = typeof args.server === 'string' ? args.server : '';
  const named = Array.isArray(args.apps) ? args.apps.filter((a): a is string => typeof a === 'string') : [];
  // The tool refuses these itself, before anything is asked.
  if (!server.trim() || !named.length) return rest;
  const { id, all } = await read(server).catch((err: unknown) => {
    if (err instanceof ConnectionArgumentError) throw new AppBindError('invalid_arguments', err.message);
    throw new AppBindError(
      'unreachable',
      'Whombat can’t read this server’s apps right now, so it didn’t ask.',
    );
  });
  const hasApps = agentReportsApps(all);
  const picked: HostGuest[] = [];
  for (const raw of named) {
    const g = findApp(all, raw);
    if (!g)
      throw new AppBindError(
        'invalid_arguments',
        `There’s no app “${raw}” on ${id}. app_updates lists them.`,
      );
    if (!picked.includes(g)) picked.push(g);
  }
  const apps = withSharedImage(all, picked);
  const many = tooManyWith(picked, apps);
  if (many) throw new AppBindError('invalid_arguments', tooManyText(many));
  const expect: AppBinding[] = [];
  for (const g of apps) {
    const b = bindingOf(g);
    if (!b) throw new AppBindError('invalid_arguments', unboundText(g, hasApps) ?? '');
    expect.push(b);
  }
  // The card says every reason the apps ask for, so a yes covers them; the agent's own stay.
  const theirs = Array.isArray(args.reasons)
    ? args.reasons.filter((r): r is string => typeof r === 'string')
    : [];
  const reasons = [...new Set([...theirs, ...askReasonsOf(expect)])];
  return { ...rest, apps: apps.map((g) => g.id), expect, ...(reasons.length ? { reasons } : {}) };
}

/** The ask-first reasons of what was read of these apps (pure). */
function askReasonsOf(bindings: readonly Pick<AppBinding, 'image' | 'version' | 'newVersion' | 'digest'>[]) {
  const out = new Set(bindings.flatMap(bindingReasons));
  return APP_CARD_REASONS.filter((r) => out.has(r));
}

/**
 * Whether an app is still what the call was bound to: the same service runs the same image from the same Compose
 * settings (pure).
 */
export function stillBound(g: HostGuest, b: AppBinding): boolean {
  if (!g.app || g.app.service !== b.service || g.imageId !== b.imageId) return false;
  return !!b.configHash && g.app.configHash === b.configHash;
}

/**
 * Takes a snapshot and waits for it to finish: listening starts before the snapshot is asked for, so one that ends at
 * once is still heard. Its result, or null when it didn't say in time.
 */
export async function snapshotFinished(
  hosts: Pick<HostsService, 'onChange'>,
  start: () => Promise<string | null>,
  ms: number,
): Promise<{ result: string; message: string | null } | null> {
  const early = new Map<string, { result: string; message: string | null }>();
  let want: string | null = null;
  let settle: (v: { result: string; message: string | null } | null) => void = () => {};
  const finished = new Promise<{ result: string; message: string | null } | null>((resolve) => {
    settle = resolve;
  });
  const stop = hosts.onChange((c: HostsChange) => {
    if (c.kind !== 'task') return;
    const d = obj(c.data);
    const id = str(d.action_id);
    if (!id) return;
    const r = { result: str(d.result) ?? 'error', message: str(d.message) };
    if (want === null) early.set(id, r);
    else if (id === want) settle(r);
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const id = await start();
    if (!id) return null;
    want = id;
    const now = early.get(id);
    if (now) return now;
    early.clear();
    timer = setTimeout(() => settle(null), ms);
    return await finished;
  } finally {
    if (timer) clearTimeout(timer);
    stop();
  }
}

/**
 * The Proxmox VM or container a server is, when Whombat watches both (they answer on one address): what a snapshot
 * before an update is taken of. Pure.
 */
export function proxmoxGuestOf(
  index: AddressIndex,
  serverId: string,
): { serverId: string; guestId: string; name: string } | null {
  const self = index.machines.find((m) => m.serverId === serverId && m.guestId === null);
  if (!self?.addresses.length) return null;
  const mine = new Set(self.addresses.map((a) => a.toLowerCase()));
  const hits = index.machines.filter(
    (m) =>
      m.serverId !== serverId &&
      m.guestId?.startsWith('pve:') &&
      m.addresses.some((a) => mine.has(a.toLowerCase())),
  );
  const hit = hits.length === 1 ? hits[0] : null;
  return hit?.guestId ? { serverId: hit.serverId, guestId: hit.guestId, name: hit.name } : null;
}

/** A server's Docker guests, as the hub lists them. */
async function dockerGuests(hosts: Pick<HostsService, 'call'>, actor: HostsActor, serverId: string) {
  const page = await hosts.call<unknown>({
    path: `${S(serverId)}/guests`,
    query: { platform: 'docker', limit: 500 },
    actor,
  });
  return arr(obj(page).guests).map((g) => toHostGuest(g, serverId));
}

/** A snapshot's name: `whombat-apps-` and the time (Proxmox takes letters, digits, `-` and `_`). */
export const snapshotName = (now: Date) =>
  `whombat-apps-${now.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;

export const APP_TOOLS: Adapter = {
  async app_updates(ctx, args) {
    const s = await scope(ctx);
    const server = opt(args, 'server');
    return call(
      async () => {
        const id = server ? (await resolveServer(s, server)).id : undefined;
        const raw = await s.hosts.call<unknown>({
          path: `${HOSTS_API}/guests`,
          query: { server: id, platform: 'docker', limit: 500 },
          actor: s.actor('viewer'),
        });
        const guests = arr(obj(raw).guests).map((g) => toHostGuest(g, str(obj(g).server) ?? id ?? ''));
        const byServer = new Map<string, HostGuest[]>();
        for (const g of guests) {
          if (g.labels?.['whombat.service']) continue;
          byServer.set(g.serverId, [...(byServer.get(g.serverId) ?? []), g]);
        }
        const index = await addressIndex(s.hosts).catch(() => null);
        const servers = [...byServer.entries()].map(([serverId, list]) => {
          const hasApps = agentReportsApps(list);
          const vm = index ? proxmoxGuestOf(index, serverId) : null;
          const apps = list.filter((g) => g.app).map((g) => appFacts(g, hasApps));
          const outdated = !hasApps && list.some((g) => g.project);
          return {
            server: serverId,
            ...(outdated
              ? {
                  needsNewerHelper: true,
                  note: 'This server’s helper is older than app updates; it gets the newer one by itself.',
                }
              : {}),
            // The Proxmox guest this server is: app_update can take a snapshot of it first (snapshot: true).
            ...(vm && hasApps ? { snapshotFirst: vm.name } : {}),
            apps,
            ...(list.some((g) => !g.app && !g.project)
              ? { notCompose: list.filter((g) => !g.app && !g.project).map((g) => g.id) }
              : {}),
          };
        });
        return output({
          servers,
          next: 'app_update updates them. An app with asksFirst (a database, a new major version, or versions that aren’t known) asks the person first: ask: true with those reasons. Where snapshotFirst names a VM, offer a snapshot first (snapshot: true). Containers docker run started can’t be updated: Whombat can update apps started with Docker Compose.',
        });
      },
      server ? { server } : {},
    );
  },

  async app_update(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const named = optStrList(args, 'apps', APP_UPDATE_MAX);
    if (!named?.length)
      throw new ConnectionArgumentError('apps: one to ten apps, as app_updates lists them.');
    const said = optStrList(args, 'reasons', 3) ?? [];
    if (said.some((r) => !(APP_CARD_REASONS as readonly string[]).includes(r)))
      throw new ConnectionArgumentError('reasons: database, major or version_unknown.');
    const snapshot = optBool(args, 'snapshot') === true;
    // Only a yes that said it may be a new major version lets one through; every other run keeps it as it is.
    const holdMajor = optBool(args, 'hold_major') === true || !(s.call.approvalId && yesAllowsMajor(said));
    const reason = opt(args, 'reason');
    const given = parseBindings(args.expect);
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const { id } = srv;
        const all = await dockerGuests(s.hosts, s.actor('viewer'), id);
        const hasApps = agentReportsApps(all);
        const picked: HostGuest[] = [];
        for (const raw of named) {
          const g = findApp(all, raw);
          if (!g)
            throw new ConnectionArgumentError(`There’s no app “${raw}” on ${id}. app_updates lists them.`);
          if (g.labels?.['whombat.service'])
            throw new ConnectionArgumentError(
              `${g.name} is one of Whombat’s own services; Whombat updates it itself.`,
            );
          const state = appUpdateState(g, hasApps);
          if (state === 'outdated')
            return output(
              {
                error: `${srv.label}’s helper is older than app updates; it gets the newer one by itself, then this works.`,
                code: 'agent_outdated',
              },
              true,
            );
          if (state === 'none')
            throw new ConnectionArgumentError(
              `${g.name} wasn’t started with Docker Compose, so Whombat can’t update it (Whombat can update apps started with Docker Compose).`,
            );
          if (state === 'blocked')
            throw new ConnectionArgumentError(
              `${g.name}’s image is pinned to one exact version in its Compose file.`,
            );
          if (state === 'updating')
            throw new ConnectionArgumentError(`${g.name} is being updated right now.`);
          if (!picked.includes(g)) picked.push(g);
        }
        // What the update is bound to: what was read when it was asked for, else (no person was asked) what is read now.
        // A yes runs only bound to every app it updates. An app that isn't that any more, or a service that has come to
        // share its image since, isn't updated.
        const now = withSharedImage(all, picked);
        const many = tooManyWith(picked, now);
        if (many) return output({ error: tooManyText(many), code: 'too_many' }, true);
        if (s.call.approvalId && !given)
          return output(
            {
              error: 'Whombat couldn’t tell what this yes was for, so nothing was updated.',
              code: 'not_bound',
              next: 'Call app_update again; it asks the person again where it must.',
            },
            true,
          );
        if (!given)
          for (const g of now) {
            const why = unboundText(g, hasApps);
            if (why) return output({ error: why, code: 'not_bound' }, true);
          }
        const bindings = given ?? now.flatMap((g) => bindingOf(g) ?? []);
        const apps = given ? picked : now;
        const changed =
          (given !== null &&
            (now.some((g) => !picked.includes(g)) ||
              apps.some((g) => !bindings.some((b) => b.app === g.id)))) ||
          bindings.some((b) => {
            const g = apps.find((x) => x.id === b.app);
            return !g || !stillBound(g, b);
          });
        if (changed)
          return output(
            {
              error: s.call.approvalId
                ? 'These apps changed since the person said yes, so nothing was updated.'
                : 'These apps changed while you asked, so nothing was updated.',
              code: 'changed',
              next: 'Read app_updates again; if an update is still there, call app_update again (it asks the person again where it must).',
            },
            true,
          );
        // A database, a new major version or a version that isn't known never updates without a person's yes, and
        // the yes must have said so.
        const risk = apps.map((g) => bindings.find((b) => b.app === g.id) ?? bindingFacts(g));
        const asks = APP_CARD_REASONS.filter((r) => risk.some((b) => bindingReasons(b).includes(r)));
        const uncovered = asks.filter((r) => !yesCovers(said, r));
        if (asks.length && (!s.call.approvalId || uncovered.length))
          return output(
            {
              error: s.call.approvalId
                ? 'These apps changed since the person was asked; ask again.'
                : `${apps.map((g) => g.name).join(', ')} ask the person first.`,
              code: 'asks_first',
              next: `Call app_update again with ask: true and reasons: ${JSON.stringify(asks)}; a card asks the person.`,
            },
            true,
          );
        // A snapshot of the Proxmox guest the server is, first, when asked for.
        let snapped: string | null = null;
        if (snapshot) {
          const index = await addressIndex(s.hosts).catch(() => null);
          const vm = index ? proxmoxGuestOf(index, id) : null;
          if (!vm)
            return output(
              {
                error: `${srv.label} isn’t a Proxmox VM or container Whombat watches, so it can’t take a snapshot first.`,
                code: 'no_snapshot',
              },
              true,
            );
          const name = snapshotName(s.call.services.clock());
          // The update starts only once the snapshot is confirmed; one that fails or doesn't say in time stops it.
          const done = await snapshotFinished(
            s.hosts,
            async () =>
              str(
                obj(
                  await send<unknown>(s, 'operator', {
                    method: 'POST',
                    path: `${S(vm.serverId)}/guests/${seg(vm.guestId)}/actions`,
                    body: {
                      action: 'snapshot_create',
                      snapshot: name,
                      description: 'Before Whombat updated apps',
                    },
                  }),
                ).action_id,
              ),
            SNAPSHOT_WAIT_MS,
          );
          if (done?.result !== 'ok')
            return output(
              {
                error: `The snapshot of ${vm.name} didn’t work, so the apps weren’t updated.`,
                code: 'snapshot_failed',
              },
              true,
            );
          snapped = `${vm.name} (${name})`;
        }
        const r = toHostManageResult(
          await send<unknown>(s, 'admin', {
            method: 'POST',
            path: `${S(id)}/apps/update`,
            // A person said yes where the call asked; the hub still wants the confirmation.
            body: {
              apps: apps.map((g) => g.id),
              ...(holdMajor ? { hold_major: true } : {}),
              ...(bindings.length
                ? {
                    expect: bindings.map((b) => ({
                      app: b.app,
                      service: b.service,
                      image_id: b.imageId,
                      ...(b.digest ? { digest: b.digest } : {}),
                      ...(b.configHash ? { config_hash: b.configHash } : {}),
                    })),
                  }
                : {}),
              confirm: true,
            },
          }),
        );
        s.hosts.forget('fleet');
        // The restart is Whombat's planned work: the server is kept quiet until 15 minutes after the task ends.
        if (r.task?.id)
          await keepQuietForWork(s.call.services, {
            burrowId: s.call.burrowId,
            serverId: id,
            work: updateWork(id, r.task.id),
          });
        const names = apps.map((g) => g.name);
        const title =
          names.length === 1
            ? `Updated ${names[0]} on ${srv.label}`
            : `Updated ${names.length} apps on ${srv.label}`;
        const detail = [
          reason?.slice(0, 300) ?? null,
          names.length > 1 ? names.join(', ') : null,
          snapped ? `Snapshot first: ${snapped}` : null,
        ]
          .filter(Boolean)
          .join('\n');
        const one = apps.length === 1 ? (apps[0] as HostGuest) : null;
        const followed = await follow(
          s,
          'app_update',
          args,
          r.task?.id,
          { server: id, label: srv.label, ...(one ? { guest: one.name } : {}) },
          changeOf('app_update', id, one?.id ?? null, title, { ids: idsOf(r), detail: detail || null }),
        );
        return output({
          accepted: true,
          ...(r.task ? { task: r.task.id } : {}),
          ...(snapped ? { snapshot: snapped } : {}),
          next: followed ? FOLLOWED_NOTE : 'app_updates shows how it went once it is done.',
        });
      },
      { server },
    );
  },
};
