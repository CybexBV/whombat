/**
 * The servers move with the box (docs/decisions/network-move.md NM-05, NM-07; network-move-server.md NM-S02…NM-S05):
 *
 * - **Wi-Fi only** asks the hosts service to move every connected agent to the Wi-Fi's address
 *   (`POST /hub/agents/move`) before the manager switches the cable off. A hosts service that can't (absent, older,
 *   refusing) doesn't stop the switch: agents find the box themselves once the cable is off (HS-174).
 * - **The cable again** is followed (the manager asked about every 2 s) until it is done; once committed, the agents are
 *   asked to move to the cable's address.
 * - Each move is kept 24 hours (`box_network.move`, through the pipeline) and `host.network` shows how far the servers
 *   got: those the hosts service knows, those connected through the new address (`via`). Without a move Whombat
 *   recorded, an agents' address change the hosts service reports in that time stands for it.
 *
 * The progress is read at most every 5 s (the app polls `host.network` every 2 s while it shows), so the hosts service
 * sees one fleet read and one hub read per 5 s at most. Nothing here throws at the caller: a failure is logged.
 */
import {
  type CableChange,
  type HostNetwork,
  networkChangeDone,
  type ServerMove,
} from '@whombat/protocol/session';
import { toHubInfo } from '../hosts/hub';
import { arr } from '../hosts/map';
import { hostsFor } from '../hosts/service';
import type { Services } from '../services';
import {
  agentPortOf,
  agentUrlAt,
  boxAddress,
  cableInUse,
  currentMove,
  type MoveRecord,
  moveProgress,
  plainIp,
  wifiAddress,
} from './network-move';
import { loadBoxNetwork, updateBoxNetwork } from './network-move-store';

/** How often a cable change is followed (as the app polls `host.network`). */
export const FOLLOW_MS = 2_000;
/**
 * A followed change that hasn't ended this long after it began is given up on: the guard's 2 minutes, applying and
 * reverting. Counted on this process's clock, not the manager's deadline (the two clocks needn't agree).
 */
const FOLLOW_MAX_MS = 4 * 60_000;
/** How long the servers' progress is reused. */
export const PROGRESS_MS = 5_000;

/** What a move's progress is made of: the kept state, the hosts service's agents' address, its servers. */
interface MoveReads {
  kept: Awaited<ReturnType<typeof loadBoxNetwork>> | null;
  hub: ReturnType<typeof toHubInfo> | null;
  servers: unknown[];
}

export class ServerMoves {
  #progress: { at: number; value: Promise<MoveReads | null> } | null = null;
  #closed = false;
  /** Tests shorten the follow's beat. */
  followMs = FOLLOW_MS;

  constructor(
    private readonly services: Services,
    private readonly state: () => Promise<HostNetwork | null>,
  ) {}

  close(): void {
    this.#closed = true;
  }

  /**
   * Before Wi-Fi only (NM-05): the agents are asked to move to the Wi-Fi's address. Returns the move to record once the
   * manager took the change, or null when Wi-Fi has no address.
   */
  async beforeWifiOnly(before: HostNetwork | null): Promise<MoveRecord | null> {
    const to = before ? plainIp(wifiAddress(before)) : null;
    if (!before || !to) return null;
    const from = boxAddress(before);
    const since = this.services.clock().toISOString();
    await this.ask(to);
    return { ...(from && from !== to ? { from } : {}), to, since };
  }

  /**
   * Asks the hosts service to move its agents to `address` at the hub's agent port. Whether it asked them (false: no
   * hosts service, an older one, or a refusal; logged).
   */
  async ask(address: string): Promise<boolean> {
    try {
      const hosts = hostsFor(this.services);
      if (!hosts.present) return false;
      const hub = toHubInfo(await hosts.hubLive());
      const url = agentUrlAt(address, agentPortOf(hub.agentUrl));
      const answer = await hosts.moveAgents(url);
      if (!answer) {
        this.services.log.info(
          'network: the hosts service can’t move its agents; they find the box themselves',
        );
        return false;
      }
      this.services.log.info({ ...answer, url }, 'network: asked the servers to move with the box');
      return true;
    } catch (err) {
      this.services.log.warn(
        { err: String(err).slice(0, 200) },
        'network: the servers weren’t asked to move',
      );
      return false;
    }
  }

  /** Keeps the move for 24 hours (NM-07). */
  async record(move: MoveRecord): Promise<void> {
    await updateBoxNetwork(this.services, (s) => ({ ...s, move }));
    this.#progress = null;
  }

  /**
   * Follows the cable again until it is done (in the background); once committed, the agents are asked to move to the
   * cable's address and the move is kept.
   */
  followCable(change: CableChange, before: HostNetwork | null): void {
    const from = before ? boxAddress(before) : null;
    const giveUpAt = this.services.clock().getTime() + FOLLOW_MAX_MS;
    this.services.background.run('network: follow the cable', async () => {
      while (!this.#closed && this.services.clock().getTime() < giveUpAt) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.followMs).unref?.());
        if (this.#closed) return;
        const n = await this.state();
        if (!n) continue;
        const seen = n.cableChange?.id === change.id ? n.cableChange : null;
        // A change that left the state (an older manager keeps it shorter) is judged by the cable itself.
        if (seen && !networkChangeDone(seen.phase)) continue;
        if (seen && seen.phase !== 'committed') return;
        // The cable's address comes from its network a few seconds after the change (DHCP): wait for it.
        const to = plainIp(cableInUse(n)?.address);
        if (!to) continue;
        await this.ask(to);
        await this.record({
          ...(from && from !== to ? { from } : {}),
          to,
          since: this.services.clock().toISOString(),
        });
        return;
      }
    });
  }

  /**
   * The servers following the box's address now (NM-07), or null, with the box's network as `host.network` read it
   * (the move follows the address the box uses). What the hosts service and the kept state say is reused for 5 s.
   */
  async progress(network: Promise<HostNetwork | null> | HostNetwork | null): Promise<ServerMove | null> {
    const now = Date.now();
    if (!this.#progress || now - this.#progress.at >= PROGRESS_MS)
      this.#progress = { at: now, value: this.#read().catch(() => null) };
    const [reads, n] = await Promise.all([this.#progress.value, Promise.resolve(network).catch(() => null)]);
    if (!reads) return null;
    const move = currentMove(reads.kept?.move, reads.hub, this.services.clock(), n);
    return move ? moveProgress(move, reads.servers) : null;
  }

  async #read(): Promise<MoveReads | null> {
    const hosts = hostsFor(this.services);
    if (!hosts.present) return null;
    const now = this.services.clock();
    const [kept, hubRaw] = await Promise.all([
      loadBoxNetwork(this.services.db).catch(() => null),
      hosts.hubLive().catch(() => null),
    ]);
    const hub = hubRaw ? toHubInfo(hubRaw) : null;
    // The fleet only when there is a move to count (as recorded: the box's network may still say there is none).
    if (!currentMove(kept?.move, hub, now)) return null;
    const fleet = await hosts.fleetRaw();
    return { kept, hub, servers: arr(fleet.servers) };
  }
}
