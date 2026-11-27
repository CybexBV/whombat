/**
 * The person hears when the Whombat's disk fills up (docs/decisions/box-status.md BS-09, BS-D02). Every 10 minutes the
 * runtime reads the data disk from the manager (`host.metrics`, range `hour` from now: no points, just the disks) and
 * runs core's `hostDiskAlertDue` against the level the person last heard (`burrows.host_disk_alert`: 0, 85 or 95). The
 * level is kept in the burrow's transaction through the commit pipeline, without an event or a message when only the
 * level changes; an alert goes to the person's Chat, as the AI gateway's do (AIG-14; one-person.md OP-S74). A manager that doesn't answer changes nothing; no processor or network
 * alerts.
 */
import {
  HOST_DISK_ALERT_LEVELS,
  type HostDiskAlertLevel,
  hostDiskAlertDue,
  hostDiskAlertText,
  hostDiskUsedPct,
} from '@whombat/core';
import type { HostDisks } from '@whombat/protocol/session';
import { asc, eq } from 'drizzle-orm';
import { burrows } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { burrowLocale } from '../i18n/locale';
import { iso } from '../lib/time';
import type { PrincipalRow } from '../read/principals';
import type { Services } from '../services';
import type { HostMetricsService } from './host-metrics';
import { postInPersonalChat } from './tell-person';

/** How often the disk is checked (BS-09). */
export const HOST_DISK_CHECK_MS = 10 * 60_000;

/** What one check did (tests, logs). */
export interface HostDiskCheck {
  usedPct: number;
  /** Alerts posted, one per account told. */
  posted: number;
}

/** A stored level as `hostDiskAlertDue` takes it: anything else counts as none. */
function keptLevel(stored: number): 0 | HostDiskAlertLevel {
  return (HOST_DISK_ALERT_LEVELS as readonly number[]).includes(stored) ? (stored as HostDiskAlertLevel) : 0;
}

/** What takes the most space, when the parts are known (the alert names it). */
export function largestPart(parts: HostDisks['data']['parts']) {
  let biggest: NonNullable<HostDisks['data']['parts']>[number] | null = null;
  for (const p of parts ?? []) if (p.bytes > 0 && (!biggest || p.bytes > biggest.bytes)) biggest = p;
  return biggest;
}

export class HostDiskAlerts {
  #ticker: (() => void) | null = null;
  #closed = false;

  constructor(
    private readonly services: Services,
    private readonly host: HostMetricsService,
  ) {}

  /** Checks on the housekeeping tick: soon after the start, then every 10 minutes. */
  start(): void {
    if (this.#ticker || this.#closed) return;
    this.#ticker = this.services.housekeeping.add('host disk', HOST_DISK_CHECK_MS, () => this.check(), {
      first: 'tick',
    });
  }

  close(): void {
    this.#closed = true;
    this.#ticker?.();
    this.#ticker = null;
  }

  /** One check: reads the disk, keeps each burrow's level and posts the alerts due. Null when it read nothing. */
  async check(): Promise<HostDiskCheck | null> {
    if (this.#closed || this.services.maintenance.paused) return null;
    const { metrics } = await this.host.read({ range: 'hour', since: iso(this.services.clock()) }, 'UTC');
    if (!metrics) return null;
    const disk = metrics.disks.data;
    const usedPct = hostDiskUsedPct(disk);
    const biggest = largestPart(disk.parts);
    const told = new Set<string>();
    let posted = 0;
    const rows = await this.services.db
      .select({ id: burrows.id })
      .from(burrows)
      .orderBy(asc(burrows.createdAt), asc(burrows.id));
    for (const { id } of rows) {
      const level = await this.keep(id, usedPct);
      if (!level) continue;
      const locale = await burrowLocale(this.services, id);
      const text = hostDiskAlertText({ level, usedPct, freeBytes: disk.freeBytes, biggest, locale });
      const thePersonHere = await thePerson(this.services.db, id);
      for (const person of thePersonHere ? [thePersonHere] : []) {
        if (!person.accountId || told.has(person.accountId)) continue;
        try {
          if (!(await this.post(id, person, text))) continue;
          told.add(person.accountId);
          posted++;
        } catch (err) {
          this.services.log.warn({ err: String(err), burrowId: id }, 'host disk: alert not posted');
        }
      }
    }
    return { usedPct, posted };
  }

  /** The burrow's level after this reading, kept in its transaction; the level to alert now, or null. */
  async keep(burrowId: string, usedPct: number): Promise<HostDiskAlertLevel | null> {
    const { result } = await this.services.pipeline.transact(burrowId, async ({ tx }) => {
      const [row] = await tx
        .select({ level: burrows.hostDiskAlert })
        .from(burrows)
        .where(eq(burrows.id, burrowId));
      if (!row) return null;
      const due = hostDiskAlertDue(usedPct, keptLevel(row.level));
      if (due.keep !== row.level)
        await tx.update(burrows).set({ hostDiskAlert: due.keep }).where(eq(burrows.id, burrowId));
      return due.alert;
    });
    return result;
  }

  /** Posts the alert in the person's DM with their assistant. False when they have none. */
  post(burrowId: string, person: PrincipalRow, text: string): Promise<boolean> {
    return postInPersonalChat(this.services, burrowId, person, text);
  }
}
