/**
 * Servers in Whombat (one-whombat-servers.md): what the rest of the server wires in.
 *
 * - `setUpHosts()` (from `createServices`): the Servers tools' adapter, the Home sources, what a chat about a server is
 *   called, the reader of server-metric widgets and the undoers — module-level
 *   registrations, safe to repeat.
 * - `startHosts(services)` (the server's start, not a read-only one): the event stream, its realtime frames, the
 *   follow-up of tasks Whombat started (proxmox.md PX-05; task-feedback.md TF-10…TF-13: kept in the database and asked
 *   about at start, after a `resync` and every 5 minutes), finished agent updates for Done recently (agent-updates.md
 *   AU-08), the pass that ends quiet hint rows (quiet-notices.md QN-S56) and the built-in Servers connection.
 *   `stopHosts` on close.
 */
import {
  registerBuiltinAdapter,
  registerCallReaches,
  registerCallWords,
} from '../connections/adapters/index';
import { registerWidgetReader } from '../home/widgets';
import type { Services } from '../services';
import { agentUpdatesFor } from './agent-signing';
import { registerAsksUndoer } from './asks';
import { taskFollowFor } from './follow';
import { registerRenameUndoer } from './names';
import { startServersConnection } from './provision';
import { quietServerPass } from './quiet';
import { HostsRealtime } from './realtime';
import { hostsFor } from './service';
import { registerHostsSources } from './sources';
import { SERVERS_ADAPTER } from './tools';
import { serversReach } from './tools-backup-places';
import { registerHostsUndoers } from './undo';
import { readServerMetric } from './widget-reader';
import {
  serversAskWords,
  serversDoneWords,
  serversNoteWords,
  serversSaysItself,
  serversStartsTask,
} from './words';

export function setUpHosts(): void {
  registerBuiltinAdapter('whombat_servers', SERVERS_ADAPTER);
  registerCallWords('whombat_servers', {
    ask: serversAskWords,
    done: serversDoneWords,
    note: serversNoteWords,
    startsTask: serversStartsTask,
    saysItself: serversSaysItself,
  });
  // A backup place on a TrueNAS acts through that connection too: a yes is bound to where it goes as well.
  registerCallReaches('whombat_servers', serversReach);
  registerHostsSources();
  // A pinned widget of a server's metrics reads them here (home/widgets.ts).
  registerWidgetReader('server_metric', readServerMetric);
  registerHostsUndoers();
  registerAsksUndoer();
  registerRenameUndoer();
}

/** How often hint rows that end by themselves are looked at: the connections' health pass's 5 minutes. */
export const QUIET_PASS_MS = 5 * 60_000;

const running = new WeakMap<
  Services,
  { realtime: HostsRealtime; stopConnection: () => void; stopFollow: () => void }
>();

/**
 * Starts following the hosts service (when it is configured). `serverFlushMs`: how long server reports are batched
 * into one `hosts.server` frame (default `SERVER_FLUSH_MS`; tests shorten it, test-speed.md TS-S08). `followRetryMs`:
 * how long a followed task's message waits for a server's report from after the task (default `AFTER_RETRY_MS`).
 */
export function startHosts(
  services: Services,
  options: { serverFlushMs?: number; followRetryMs?: number } = {},
): void {
  if (running.has(services)) return;
  const hosts = hostsFor(services);
  const realtime = new HostsRealtime(hosts, services.bus, () => services.log, options.serverFlushMs);
  let stopFollow = () => {};
  if (hosts.present) {
    hosts.start();
    realtime.start();
    const follow = taskFollowFor(services, { retryMs: options.followRetryMs });
    const updates = agentUpdatesFor(services);
    const stopChanges = hosts.onChange((c) => {
      follow.onChange(c);
      // A finished agent update goes in Done recently (agent-updates.md AU-08).
      if (c.kind === 'fleet' && c.event === 'agent.update' && c.data) void updates.heard(c.data);
    });
    // The tasks followed before this start are asked about now, the long ones every 5 minutes (task-feedback.md TF-11).
    const stopAsking = follow.start();
    // Hint rows that end by themselves end here (quiet-notices.md QN-11; QN-S56), as the connections' health pass.
    const stopQuiet = services.housekeeping.add('hosts.quiet-pass', QUIET_PASS_MS, async () => {
      if (services.maintenance.held) return;
      await quietServerPass(services).catch((err: unknown) =>
        services.log.warn({ err: String(err) }, 'hosts: the quiet pass failed'),
      );
    });
    stopFollow = () => {
      stopChanges();
      stopAsking();
      stopQuiet();
    };
    services.log.info({ socket: hosts.client?.socket }, 'hosts: following the hosts service');
  }
  // Also without the service: an earlier Servers connection is marked not connected.
  const stopConnection = startServersConnection(services);
  running.set(services, { realtime, stopConnection, stopFollow });
}

export function stopHosts(services: Services): void {
  const r = running.get(services);
  r?.realtime.close();
  r?.stopConnection();
  r?.stopFollow();
  running.delete(services);
  hostsFor(services).close();
}
