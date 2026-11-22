/**
 * The hosts service's events as realtime frames on `hosts:<burrowId>` (contracts CT-339; one-whombat-servers.md
 * ONE-DH07): `hosts.guest`, `hosts.alert`, `hosts.task`, `hosts.enrollment` as they come; `hosts.server` coalesced
 * (every server reports every 10 s) into one fleet read per `SERVER_FLUSH_MS`, sent only when the row changed;
 * maintenance and check changes, and a lost stream, as `hosts.resync`. Ephemeral bus frames (no outbox row); on a
 * managed box the session event log keeps them like every other frame.
 */
import { HostGuestState, type HostServer, type RealtimeEvent } from '@whombat/core';
import type { RealtimeBus } from '../realtime/bus';
import type { Logger } from '../services';
import { obj, toHostAlert } from './map';
import type { HostsChange, HostsService } from './service';

/** How often changed server rows are read and sent. */
export const SERVER_FLUSH_MS = 5_000;

const STATES = new Set<string>(HostGuestState.options);

/** A row's fingerprint without what moves every report anyway (last seen). */
function signature(s: HostServer | null): string {
  if (!s) return 'gone';
  const { lastSeen: _seen, ...rest } = s;
  return JSON.stringify(rest);
}

/** The task frame of an `action.finished` / `task.finished` event. */
export function taskFrame(change: Extract<HostsChange, { kind: 'task' }>): RealtimeEvent | null {
  const d = change.data;
  const result = d.result === 'ok' || d.result === 'warning' || d.result === 'error' ? d.result : 'error';
  const action = d.event === 'action.finished';
  const id = action ? d.action_id : d.task;
  if (typeof id !== 'string' || !id) return null;
  return {
    type: 'hosts.task',
    serverId: change.serverId,
    guestId: change.guestId,
    ...(action ? { actionId: id } : { taskId: id }),
    op: typeof (action ? d.action : d.op) === 'string' ? ((action ? d.action : d.op) as string) : 'task',
    result,
    message: typeof d.message === 'string' && d.message ? d.message.slice(0, 500) : null,
  };
}

export class HostsRealtime {
  #dirty = new Set<string>();
  #sent = new Map<string, string>();
  #timer: NodeJS.Timeout | null = null;
  #off: (() => void) | null = null;
  #flushing: Promise<void> | null = null;

  constructor(
    private readonly hosts: HostsService,
    private readonly bus: RealtimeBus,
    private readonly log: () => Logger,
    private readonly flushMs = SERVER_FLUSH_MS,
  ) {}

  start(): void {
    if (this.#off || !this.hosts.present) return;
    this.#off = this.hosts.onChange((c) => void this.#on(c));
  }

  close(): void {
    this.#off?.();
    this.#off = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #publish(event: RealtimeEvent): Promise<void> {
    const burrowId = await this.hosts.homeBurrowId();
    if (!burrowId) return;
    this.bus.publish({
      topic: `hosts:${burrowId}`,
      event,
      eventId: null,
      at: new Date().toISOString(),
      outboxId: null,
    });
  }

  async #on(c: HostsChange): Promise<void> {
    try {
      switch (c.kind) {
        case 'server':
          if (c.event === 'server.disk_usage') this.#sent.delete(c.serverId);
          this.#dirty.add(c.serverId);
          this.#schedule();
          return;
        case 'guest':
          if (c.state && STATES.has(c.state))
            await this.#publish({
              type: 'hosts.guest',
              serverId: c.serverId,
              guestId: c.guestId,
              state: c.state as HostGuestState,
            });
          this.#dirty.add(c.serverId);
          this.#schedule();
          return;
        case 'alert':
          // With its quiet, as the page reads it (QN-14): “Ignored by Mara until it’s back online”.
          await this.#publish({
            type: 'hosts.alert',
            alert: await this.hosts.withQuiet(toHostAlert(c.alert)),
          });
          if (typeof obj(c.alert).server === 'string' && obj(c.alert).server) {
            this.#dirty.add(obj(c.alert).server as string);
            this.#schedule();
          }
          return;
        case 'task': {
          const frame = taskFrame(c);
          if (frame) await this.#publish(frame);
          return;
        }
        case 'enrollment':
          await this.#publish({
            type: 'hosts.enrollment',
            enrollmentId: c.id,
            hostname: c.hostname,
          });
          return;
        case 'fleet':
        case 'resync':
          this.#sent.clear();
          await this.#publish({ type: 'hosts.resync' });
          return;
      }
    } catch (err) {
      this.log().warn({ err: String(err) }, 'hosts: a realtime frame was not sent');
    }
  }

  #schedule(): void {
    if (this.#timer || !this.#off) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#flushing = this.flush().finally(() => {
        this.#flushing = null;
      });
    }, this.flushMs);
    this.#timer.unref?.();
  }

  /** Reads the fleet once and sends the rows of the servers that changed (tests call it directly). */
  async flush(): Promise<void> {
    if (this.#flushing) await this.#flushing;
    const ids = [...this.#dirty];
    this.#dirty.clear();
    if (ids.length === 0) return;
    try {
      const fleet = await this.hosts.fleet();
      for (const id of ids) {
        const row = fleet.servers.find((s) => s.id === id) ?? null;
        const sig = signature(row);
        if (this.#sent.get(id) === sig) continue;
        this.#sent.set(id, sig);
        await this.#publish({ type: 'hosts.server', serverId: id, server: row });
      }
    } catch (err) {
      // The service didn't answer: these rows go out with the next change.
      for (const id of ids) this.#dirty.add(id);
      this.log().debug({ err: String(err) }, 'hosts: server rows not read for realtime');
    }
  }
}
