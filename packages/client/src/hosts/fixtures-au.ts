/**
 * Server agents keeping themselves up to date in the fixture worlds (Whombat agent-updates.md AU-03…AU-08; app
 * agent-updates-app.md AP-2990): pve-02 kept up to date (updated 3 hours ago); blackbox without the update key, where
 * Whombat may run the last install (Update the agent); pve-01 without the key where it may not (the install command);
 * thetitan with the new version waiting until its updates are installed (as the updates world installs them, about two
 * minutes), then updating by itself; the-falcon whose update went back (Try again). “Keep server agents up to date” is
 * on; off, thetitan's waits for Update now. A press updates for 8 seconds, then the agent runs the new version.
 *
 * `createAgentUpdatesFixtureWorld` is the state, shared by the web's layer (`withAgentUpdatesFixtures`, around the hosts
 * routes) and the phone's demo world. Not imported by production code.
 */
import type { HostAgentSettings, HostAgentUpdate, HostServerSettings } from '@whombat/core/domain';
import type { HostsFixtureAnswer, HostsFixtureRequest } from './fixtures';

const MIN = 60_000;
/** An update takes this long here (the hub waits for the agent to come back on the new version). */
const UPDATE_MS = 8000;
/** thetitan waits this long for its updates to be installed (the updates world's install, AP-2878). */
const WAIT_MS = 2 * MIN;

export const FIXTURE_AGENT_OLD = '0.0.0-20261018094703.5394c53';
export const FIXTURE_AGENT_NEW = '0.0.0-20261020081500.7c1e2a9';

interface AgentState {
  version: string;
  /** Built with the update key (else it needs one more install). */
  keyed: boolean;
  /** Whombat may run commands as root there (AU-07). */
  shell: boolean;
  failed: boolean;
  /** Busy with a package task until then (AU-04). */
  waitUntil: number | null;
  /** Updating since then, ends `UPDATE_MS` later. */
  updatingSince: number | null;
  updatedAt: number | null;
}

export interface AgentUpdatesFixtureWorld {
  has(serverId: string): boolean;
  /** `hosts.agentSettings`. */
  settings(): HostAgentSettings;
  /** `hosts.updateAgentSettings`. */
  patchSettings(body: Record<string, unknown>): HostAgentSettings;
  /** A server's settings with its agent's version and update. */
  serverSettings(s: HostServerSettings): HostServerSettings;
  /** The agent's version (the server's page shows it). */
  version(serverId: string): string | null;
  /** `hosts.updateAgent`: Update now, Try again, Update the agent. */
  start(serverId: string): HostsFixtureAnswer;
}

export function createAgentUpdatesFixtureWorld(opts: {
  now: number;
  clock?: () => number;
}): AgentUpdatesFixtureWorld {
  const clock = opts.clock ?? (() => Date.now());
  const start = clock();
  let autoUpdate = true;
  const agent = (over: Partial<AgentState>): AgentState => ({
    version: FIXTURE_AGENT_NEW,
    keyed: true,
    shell: true,
    failed: false,
    waitUntil: null,
    updatingSince: null,
    updatedAt: null,
    ...over,
  });
  const agents = new Map<string, AgentState>([
    ['pve-02', agent({ updatedAt: opts.now - 3 * 60 * MIN })],
    // pve-01 blocks the shell on itself (the PX-04 world): the install command; blackbox lets Whombat run it.
    ['pve-01', agent({ version: FIXTURE_AGENT_OLD, keyed: false, shell: false })],
    ['blackbox', agent({ version: FIXTURE_AGENT_OLD, keyed: false })],
    ['thetitan', agent({ version: FIXTURE_AGENT_OLD, waitUntil: start + WAIT_MS })],
    ['the-falcon', agent({ version: FIXTURE_AGENT_OLD, failed: true })],
  ]);

  /** Where an agent is now: an update that ran its time is done; a wait that ended starts the round's update. */
  const advance = (a: AgentState) => {
    const now = clock();
    if (a.updatingSince !== null && now - a.updatingSince >= UPDATE_MS) {
      a.version = FIXTURE_AGENT_NEW;
      a.keyed = true;
      a.failed = false;
      a.updatedAt = a.updatingSince + UPDATE_MS;
      a.updatingSince = null;
    }
    if (a.waitUntil !== null && now >= a.waitUntil) {
      a.waitUntil = null;
      if (autoUpdate && a.keyed && !a.failed && a.version !== FIXTURE_AGENT_NEW) a.updatingSince = now;
    }
  };

  const update = (a: AgentState): HostAgentUpdate => {
    advance(a);
    const available = a.version !== FIXTURE_AGENT_NEW;
    const base = {
      available: available && a.keyed,
      ...(a.updatedAt !== null ? { updatedAt: new Date(a.updatedAt).toISOString() } : {}),
    };
    if (a.updatingSince !== null)
      return { ...base, version: FIXTURE_AGENT_NEW, state: 'updating', auto: false };
    if (!a.keyed)
      return {
        ...base,
        reasonCode: 'no_key',
        reason: 'This agent was built without the update key.',
        canInstall: a.shell,
        auto: false,
        ...(a.failed ? { state: 'failed' as const, failedVersion: FIXTURE_AGENT_NEW } : {}),
      };
    if (!available) return { ...base, reasonCode: 'up_to_date', auto: false };
    if (a.failed)
      return {
        ...base,
        version: FIXTURE_AGENT_NEW,
        state: 'failed',
        failedVersion: FIXTURE_AGENT_NEW,
        message: 'The new version didn’t connect within 5 minutes, so the agent went back to the one it had.',
        auto: false,
      };
    if (a.waitUntil !== null && autoUpdate)
      return { ...base, version: FIXTURE_AGENT_NEW, state: 'waiting', waitingFor: 'packages', auto: true };
    return { ...base, version: FIXTURE_AGENT_NEW, auto: autoUpdate };
  };

  return {
    has: (id) => agents.has(id),
    settings: () => ({ autoUpdate, halted: false }),
    patchSettings(body) {
      if (typeof body.autoUpdate === 'boolean') autoUpdate = body.autoUpdate;
      return { autoUpdate, halted: false };
    },
    serverSettings(s) {
      const a = agents.get(s.id);
      if (!a) return s;
      // Whombat may run the last install where the shell is allowed on both sides (AU-07); pve-01 blocks it on
      // itself in every world (the PX-04 world's).
      a.shell = s.id !== 'pve-01' && s.remoteControl.hostShell === true && s.agentPolicy.hostShell !== false;
      const u = update(a);
      return {
        ...s,
        agent: {
          arch: 'amd64',
          install: s.id === 'blackbox' ? 'unraid' : 'systemd',
          ...s.agent,
          version: a.version,
          update: u,
        },
      };
    },
    version(serverId) {
      const a = agents.get(serverId);
      if (!a) return null;
      advance(a);
      return a.version;
    },
    start(serverId) {
      const a = agents.get(serverId);
      if (!a)
        return { status: 404, body: { error: { code: 'not_found', message: 'That server isn’t there.' } } };
      advance(a);
      if (a.updatingSince !== null)
        return {
          status: 409,
          body: {
            error: {
              code: 'conflict',
              message: 'Another update is already running. Try again in a few minutes.',
              details: { code: 'update_running' },
            },
          },
        };
      if (!a.keyed && !a.shell)
        return {
          status: 409,
          body: {
            error: {
              code: 'conflict',
              message: `Whombat may not run commands on ${serverId}: run its install command there once.`,
              details: { code: 'needs_install' },
            },
          },
        };
      const installing = !a.keyed;
      a.updatingSince = clock();
      a.waitUntil = null;
      return { status: 202, body: { state: installing ? 'installing' : 'updating' } };
    },
  };
}

/**
 * The web's layer around the hosts routes: “Keep server agents up to date” (`agents/settings`), a server's settings
 * and page with its agent's version and update, and `servers/<id>/agent/update`.
 */
export function withAgentUpdatesFixtures(
  next: (req: HostsFixtureRequest) => HostsFixtureAnswer | null,
  opts: { now: number; clock?: () => number },
): (req: HostsFixtureRequest) => HostsFixtureAnswer | null {
  const world = createAgentUpdatesFixtureWorld(opts);
  return (req) => {
    const seg = req.path.split('/').filter(Boolean).map(decodeURIComponent);
    if (seg[0] === 'agents' && seg[1] === 'settings' && seg.length === 2) {
      if (req.method === 'GET') return { status: 200, body: world.settings() };
      if (req.method === 'PATCH') return { status: 200, body: world.patchSettings(req.body) };
    }
    const id = seg[0] === 'servers' ? (seg[1] ?? '') : '';
    if (!id || !world.has(id)) return next(req);
    if (req.method === 'POST' && seg[2] === 'agent' && seg[3] === 'update' && seg.length === 4)
      return world.start(id);
    const out = next(req);
    if (req.method !== 'GET' || out?.status !== 200) return out;
    if (seg.length === 3 && seg[2] === 'settings')
      return { ...out, body: world.serverSettings(out.body as HostServerSettings) };
    if (seg.length === 2) {
      const d = out.body as { server: { agent: Record<string, unknown> } };
      return {
        ...out,
        body: { ...d, server: { ...d.server, agent: { ...d.server.agent, version: world.version(id) } } },
      };
    }
    return out;
  };
}
