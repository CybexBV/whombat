/**
 * The Servers tools for Docker Compose apps (app-updates.md): `app_updates` reads which apps have a newer version, which
 * ask first and why, and how each one's last update went; `app_update` updates up to ten apps of one server as one task
 * on it — the agent pulls each app's image, restarts only that app, and puts the previous image back by itself when it
 * doesn't come up.
 *
 * Asking: like a container update, it asks unless the server is set not to; a database's update and a new major version
 * always ask (`ask: true` makes the catalog's rule apply on every server, `serverAsksApply`), and the call refuses to run
 * them without a person's yes. What the card says comes from the call's `reasons`, so a yes always covers what it said:
 * a run whose apps ask for more than the card said refuses and asks again. Unattended runs (the care plan's) pass
 * `hold_major`: an app whose update turns out to be a new major version stays as it is.
 *
 * A snapshot first (`snapshot: true`): when the server is a Proxmox VM or container Whombat watches, Whombat takes a
 * snapshot of it and waits for it before the update starts. The task is followed: one plain line in the chat when it
 * ends (`appsOutcomeText`), Done recently records it, and the server stays quiet while it runs (planned work).
 */
import {
  APP_UPDATE_MAX,
  type AppAskReason,
  agentReportsApps,
  appUpdateRisk,
  appUpdateState,
  type HostGuest,
  versionWords,
} from '@whombat/core';
import type { Adapter } from '../connections/adapters/types';
import { ConnectionArgumentError } from '../connections/request';
import { keepQuietForWork, updateWork } from '../things/quiet/window-work';
import { type AddressIndex, addressIndex } from '../things/runs-on';
import { HOSTS_API, type HostsActor, seg } from './client';
import { arr, obj, str, toHostGuest, toHostManageResult } from './map';
import type { HostsService } from './service';
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

/** The arguments each of these tools takes (`checkArgs`, PX-08). */
export const APP_TOOL_ARGS: Readonly<Record<string, readonly string[]>> = {
  app_updates: ['server'],
  app_update: ['server', 'apps', 'ask', 'reasons', 'snapshot', 'hold_major', 'reason'],
};

/** What the card may say before the yes: the ask-first reasons and that the version isn't known. */
export const APP_CARD_REASONS = ['database', 'major', 'version_unknown'] as const;
export type AppCardReason = (typeof APP_CARD_REASONS)[number];

/** How long Whombat waits for the snapshot before the update. */
const SNAPSHOT_WAIT_MS = 3 * 60_000;

/** A container's name without its platform: `docker:immich_server` → `immich_server`. */
export const appName = (guestId: string) => guestId.replace(/^docker:/, '');

/** One app as an agent reads it (pure). */
export function appFacts(g: HostGuest, agentHasApps: boolean): Record<string, unknown> {
  const state = appUpdateState(g, agentHasApps);
  const risk = appUpdateRisk(g);
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
    ...(risk.reasons.length ? { asksFirst: risk.reasons } : {}),
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

/** What a card must say for these apps: their ask-first reasons and whether a version isn't known (pure). */
export function cardReasons(guests: readonly HostGuest[]): AppCardReason[] {
  const out = new Set<AppCardReason>();
  for (const g of guests) {
    for (const r of appUpdateRisk(g).reasons) out.add(r);
    if (!versionWords(g.app?.newVersion)) out.add('version_unknown');
  }
  return APP_CARD_REASONS.filter((r) => out.has(r));
}

/** The ask-first reasons of these apps (pure). */
export function askReasons(guests: readonly HostGuest[]): AppAskReason[] {
  return [...new Set(guests.flatMap((g) => appUpdateRisk(g).reasons))];
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
async function dockerGuests(hosts: HostsService, actor: HostsActor, serverId: string) {
  const page = await hosts.call<unknown>({
    path: `${S(serverId)}/guests`,
    query: { platform: 'docker', limit: 500 },
    actor,
  });
  return arr(obj(page).guests).map((g) => toHostGuest(g, serverId));
}

/** Waits for a hub action to finish; its result, or null when it didn't say in time. */
function actionFinished(
  hosts: HostsService,
  actionId: string,
  ms: number,
): Promise<{ result: string; message: string | null } | null> {
  return new Promise((resolve) => {
    let stop = () => {};
    const timer = setTimeout(() => {
      stop();
      resolve(null);
    }, ms);
    stop = hosts.onChange((c) => {
      if (c.kind !== 'task' || obj(c.data).action_id !== actionId) return;
      clearTimeout(timer);
      stop();
      const d = obj(c.data);
      resolve({ result: str(d.result) ?? 'error', message: str(d.message) });
    });
  });
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
        const servers = [...byServer.entries()].map(([serverId, list]) => {
          const hasApps = agentReportsApps(list);
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
            apps,
            ...(list.some((g) => !g.app && !g.project)
              ? { notCompose: list.filter((g) => !g.app && !g.project).map((g) => g.id) }
              : {}),
          };
        });
        return output({
          servers,
          next: 'app_update updates them. A database or a new major version asks the person first (ask: true with its reasons). Containers docker run started can’t be updated: Whombat can update apps started with Docker Compose.',
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
    const holdMajor = optBool(args, 'hold_major') === true;
    const reason = opt(args, 'reason');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const { id } = srv;
        const all = await dockerGuests(s.hosts, s.actor('viewer'), id);
        const hasApps = agentReportsApps(all);
        const picked: HostGuest[] = [];
        for (const raw of named) {
          const want = raw.trim().toLowerCase();
          const g =
            all.find((x) => x.id.toLowerCase() === want) ??
            all.find((x) => x.name.toLowerCase() === want || appName(x.id).toLowerCase() === want);
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
        // A database or a new major version never updates without a person's yes, and the yes must have said so.
        const asks = askReasons(picked);
        const uncovered = asks.filter((r) => !said.includes(r));
        if (asks.length && (!s.call.approvalId || uncovered.length))
          return output(
            {
              error: s.call.approvalId
                ? 'These apps changed since the person was asked; ask again.'
                : `${picked.map((g) => g.name).join(', ')} ask the person first.`,
              code: 'asks_first',
              next: `Call app_update again with ask: true and reasons: ${JSON.stringify(cardReasons(picked))}; a card asks the person.`,
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
          const started = obj(
            await send<unknown>(s, 'operator', {
              method: 'POST',
              path: `${S(vm.serverId)}/guests/${seg(vm.guestId)}/actions`,
              body: { action: 'snapshot_create', snapshot: name, description: 'Before Whombat updated apps' },
            }),
          );
          const actionId = str(started.action_id);
          const done = actionId ? await actionFinished(s.hosts, actionId, SNAPSHOT_WAIT_MS) : null;
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
              apps: picked.map((g) => g.id),
              ...(holdMajor ? { hold_major: true } : {}),
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
        const names = picked.map((g) => g.name);
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
        const one = picked.length === 1 ? (picked[0] as HostGuest) : null;
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
