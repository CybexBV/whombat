/**
 * A server's updates in the demo world (server-updates-app.md AP-2886): the web's fixture world of updates
 * (`createUpdatesFixtureWorld` in `@whombat/client/hosts/fixtures`) behind the phone's endpoints — pve-02 with updates
 * waiting, thetitan installing them since the world started, the-falcon done and waiting for its restart. A server's
 * page carries its updates, `packages.check` and `packages.install` start a `pkg:` task whose log grows with the clock,
 * `hosts.inspect` lists the packages, and Restart clears the restart need. When a task ends its `hosts.task` frame is
 * sent. Pure TypeScript.
 */
import { createUpdatesFixtureWorld } from '@whombat/client/hosts/fixtures';
import type { HostServerDetail, RealtimeEvent } from '@whombat/core';

export interface UpdatesFixtureDeps {
  now: () => Date;
  emit: (topic: string, event: RealtimeEvent) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  hostsTopic: string;
  json: (body: unknown, status?: number) => Response;
  bodyOf: <T>(init: RequestInit | undefined) => Promise<T>;
}

export function createUpdatesFixtures(deps: UpdatesFixtureDeps) {
  // The demo world's clock (it starts at mock 4's moment and runs): tasks move with it.
  const world = createUpdatesFixtureWorld({ now: deps.now().getTime(), clock: () => deps.now().getTime() });
  /** Tell the ended tasks, as the hub's `task.finished` does: every second while one started here runs. */
  let watching = false;
  const tell = () => {
    for (const e of world.ended())
      deps.emit(deps.hostsTopic, {
        type: 'hosts.task',
        serverId: e.serverId,
        taskId: e.taskId,
        op: `packages.${e.op}`,
        result: e.result,
        message: e.message,
      } as RealtimeEvent);
  };
  const watch = () => {
    if (watching) return;
    watching = true;
    const tick = () => {
      tell();
      if (world.running()) deps.setTimer(tick, 1000);
      else watching = false;
    };
    deps.setTimer(tick, 1000);
  };
  const answer = (a: { status: number; body: unknown } | null) => (a ? deps.json(a.body, a.status) : null);

  return {
    /** A server's page with its updates. */
    detail: (d: HostServerDetail): HostServerDetail => world.detail(d),

    async handle(
      id: string,
      params: Record<string, string>,
      init: RequestInit | undefined,
      url: URL,
    ): Promise<Response | null> {
      const serverId = params.serverId ?? '';
      if (!world.has(serverId)) return null;
      switch (id) {
        case 'hosts.manage': {
          const body = await deps.bodyOf<Record<string, unknown>>(init);
          const out = world.manage(serverId, body);
          if (out) watch();
          return answer(out);
        }
        case 'hosts.getTask':
          return params.taskId?.startsWith('pkg:')
            ? answer(world.task(serverId, params.taskId, Number(url.searchParams.get('logStart') ?? 0)))
            : null;
        case 'hosts.inspect':
          return params.kind === 'updates' ? answer({ status: 200, body: world.inspect(serverId) }) : null;
        case 'hosts.serverAction': {
          const body = await deps.bodyOf<{ action?: string }>(init);
          if (body.action === 'host_reboot') world.restarted(serverId);
          return deps.json({ actionId: `act_${serverId}_${body.action ?? 'power'}` }, 202);
        }
        default:
          return null;
      }
    },
  };
}
