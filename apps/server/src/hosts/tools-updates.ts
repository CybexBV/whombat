/**
 * The Servers tools for a server's operating-system updates (server-updates.md; contracts 0.98.0 `SERVERS_TOOLS`;
 * server-updates-server.md SWU-S01…): `server_updates` reads what waits — the server's report (the package manager, the
 * counts, when they were checked, an error, a restart and why, the running package task and the last result) and the
 * agent's list (security first, at most 500) — and `server_update` checks for updates or installs them (everything
 * waiting, or the packages named) as a task on the server, which never restarts it (SWU-05).
 *
 * Install asks a person first through the catalog's sensitive rule unless the server is set not to ask, and always on
 * the server this Whombat runs on (`serverAsksApply`: an upgrade there can restart Whombat's own database); Check never
 * asks. The hub runs Check as operator and Install as admin (SWU-07), with `confirm` (the yes already happened). The
 * task is followed: the chat gets one plain message when it ends (`follow.ts`), and the change is in Done recently
 * without Undo.
 *
 * `canInstall` comes from the server's detail read as admin, the switches the install meets (task-feedback.md TF-01);
 * when they look off, `next` leaves the last word to the install itself (TF-03).
 */

import type { Adapter } from '../connections/adapters/types';
import { ConnectionArgumentError } from '../connections/request';
import { keepQuietForWork, updateWork } from '../things/quiet/window-work';
import { HostsError } from './client';
import { hostsErrorText } from './errors';
import { camel, obj, remoteControl, remoteControlFromAgent, toHostInspect, toHostManageResult } from './map';
import {
  call,
  changeOf,
  FOLLOWED_NOTE,
  follow,
  idsOf,
  oneOf,
  output,
  req,
  resolveServer,
  S,
  scope,
  send,
  serverDetailRaw,
} from './tools-shared';
import {
  listWords,
  noteWaitingUpdates,
  packagesArg,
  restartWords,
  UPDATES_LIST_MAX,
  type UpdatesReport,
  updateChangeText,
} from './updates';

/** The arguments each of these tools takes (`checkArgs`, PX-08). */
export const UPDATE_TOOL_ARGS: Readonly<Record<string, readonly string[]>> = {
  server_updates: ['server'],
  server_update: ['server', 'action', 'packages', 'reason'],
};

/** A waiting package as the agent lists it (hosts `pkgs`). */
interface Waiting {
  name: string;
  current?: string;
  new: string;
  security?: boolean;
  source?: string;
}

/** The waiting packages for an agent: security first, then by name, at most `UPDATES_LIST_MAX`. */
export function waitingList(items: readonly Waiting[]): {
  packages: Record<string, unknown>[];
  more: number;
} {
  const sorted = [...items].sort(
    (a, b) => Number(b.security === true) - Number(a.security === true) || a.name.localeCompare(b.name),
  );
  return {
    packages: sorted.slice(0, UPDATES_LIST_MAX).map((p) => ({
      name: p.name,
      ...(p.current ? { now: p.current } : {}),
      new: p.new,
      ...(p.security ? { security: true } : {}),
      ...(p.source ? { source: p.source } : {}),
    })),
    more: Math.max(0, sorted.length - UPDATES_LIST_MAX),
  };
}

/**
 * What the server's report says about its updates, for an agent (pure). `personInstalls`: Whombat never installs
 * them there (a Windows PC), so no hint points at `server_update install`.
 */
export function updatesSummary(
  serverId: string,
  r: UpdatesReport,
  canInstall: boolean | null,
  personInstalls = false,
): Record<string, unknown> {
  const last = r.packageLast;
  const running = r.packageTask;
  const why =
    last?.code === 'busy'
      ? 'Another program was installing packages.'
      : last?.code === 'timeout'
        ? 'It ran out of time.'
        : null;
  const next = running
    ? 'A package task is running there; wait for it before starting another.'
    : personInstalls
      ? null
      : canInstall === false
        ? // A reading never decides that the install is impossible (task-feedback.md TF-03): the hub checks it live.
          `Full control looks off on ${serverId}; server_update install says for sure, in plain words when it can’t.`
        : r.updates
          ? 'server_update install installs them (all, or the packages you name). It asks a person first unless the server is set not to ask, and never restarts the server.'
          : null;
  return {
    server: serverId,
    manager: r.packageManager ?? null,
    waiting: r.updates ?? null,
    security: r.securityUpdates ?? null,
    checked: r.updatesCheckedAt ?? null,
    ...(r.updatesError ? { error: r.updatesError } : {}),
    restart: r.rebootRequired
      ? { needed: true, why: r.rebootReason ?? null, words: restartWords(r.rebootReason) }
      : { needed: false },
    ...(running ? { running: { task: running.id, action: running.op, since: running.startedAt } } : {}),
    ...(last
      ? {
          last: {
            action: last.op,
            result: last.status,
            at: last.finishedAt,
            ...(typeof last.installed === 'number' ? { installed: last.installed } : {}),
            ...(last.message ? { message: last.message } : {}),
            ...(why ? { why } : {}),
          },
        }
      : {}),
    ...(canInstall !== null ? { canInstall } : {}),
    ...(next ? { next } : {}),
  };
}

/**
 * Why Whombat leaves a Windows PC's updates alone (docs/decisions/windows-servers.md): Windows Update restarts the
 * person's own computer at times it picks, and installing them from outside goes round what the person set there.
 */
export const WINDOWS_UPDATES_NOTE =
  'Whombat doesn’t install Windows updates: tell the person what waits and that they install it in Settings → Windows Update.';

export const UPDATE_TOOLS: Adapter = {
  async server_updates(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const { id } = srv;
        const [raw, agent] = await Promise.all([serverDetailRaw(s, id), s.hosts.agentOf(id)]);
        const report = obj(camel(obj(raw).system)) as UpdatesReport;
        noteWaitingUpdates(id, report.updates);
        // The detail's effective switches, else the agents row's (SWU-07: Full control installs).
        const switches = obj(obj(raw).server).remote_control;
        const rc = switches ? remoteControl(switches) : agent ? remoteControlFromAgent(agent) : null;
        // Whombat only reads a Windows PC's updates; the person installs them.
        const canInstall = srv.kind === 'windows' ? false : rc ? rc.manage === true : null;
        // The list is the agent's, read now (diagnose or console on, SWU-11); nothing to list when nothing waits.
        let list: ReturnType<typeof waitingList> | null = null;
        let listError: string | null = null;
        if (report.updates !== 0) {
          try {
            const inspected = toHostInspect(
              await s.hosts.call<unknown>({ path: `${S(id)}/inspect/updates`, actor: s.actor('operator') }),
              'updates',
              s.call.services.clock(),
            );
            list = waitingList(inspected.items as Waiting[]);
          } catch (err) {
            if (!(err instanceof HostsError)) throw err;
            listError = hostsErrorText(err, { server: id });
          }
        }
        return output({
          ...updatesSummary(id, report, canInstall, srv.kind === 'windows'),
          ...(srv.kind === 'windows' ? { note: WINDOWS_UPDATES_NOTE } : {}),
          ...(srv.runsThisWhombat ? { thisWhombat: true } : {}),
          ...(list ? { packages: list.packages, ...(list.more ? { more: list.more } : {}) } : {}),
          ...(listError ? { packagesError: listError } : {}),
        });
      },
      { server },
    );
  },

  async server_update(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const action = oneOf(args, 'action', ['check', 'install'] as const);
    const packages = packagesArg(args.packages);
    if (packages && action === 'check')
      throw new ConnectionArgumentError('packages: only with install (a check reads every package).');
    const reason = req(args, 'reason');
    const op = action === 'install' ? 'packages.install' : 'packages.check';
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const { id } = srv;
        if (srv.kind === 'windows')
          return output(
            { error: `${srv.label} is a Windows PC. ${WINDOWS_UPDATES_NOTE}`, code: 'unsupported' },
            true,
          );
        const r = toHostManageResult(
          await send<unknown>(s, action === 'install' ? 'admin' : 'operator', {
            method: 'POST',
            path: `${S(id)}/packages/${action}`,
            // A person said yes where the call asked (Install asks unless the server is set not to).
            body: action === 'install' ? { ...(packages ? { packages } : {}), confirm: true } : {},
          }),
        );
        // The report gains the running package task.
        s.hosts.forget('fleet');
        // Installing updates is Whombat's planned work: the server is kept quiet until 15 minutes after its task ends
        // (the task's end moves it, `workEnded`).
        if (action === 'install' && r.task?.id)
          await keepQuietForWork(s.call.services, {
            burrowId: s.call.burrowId,
            serverId: id,
            work: updateWork(id, r.task.id),
          });
        const detail = [reason.slice(0, 300), packages ? `Only ${listWords(packages, 10)}` : null]
          .filter(Boolean)
          .join('\n');
        const followed = await follow(
          s,
          'server_update',
          args,
          r.task?.id,
          { server: id, label: srv.label },
          changeOf('server_update', id, null, updateChangeText(op, id), {
            ids: idsOf(r),
            detail: detail || null,
          }),
        );
        return output({
          accepted: true,
          ...(r.task ? { task: r.task.id } : {}),
          next: followed
            ? FOLLOWED_NOTE
            : action === 'check'
              ? 'server_updates shows what waits once the check is done.'
              : 'server_updates shows how it went once it is done.',
          ...(action === 'install'
            ? {
                note: `${srv.label} isn’t restarted. If it needs a restart afterwards, offer to restart it (server_power reboot).`,
              }
            : {}),
        });
      },
      { server, op },
    );
  },
};
