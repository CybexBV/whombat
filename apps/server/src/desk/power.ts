/**
 * The battery as a UPS (docs/decisions/desk-display.md DK-10; desk-display-server.md DK-S12, DK-S13). The manager
 * measures the power with the rest of the box (`HostNow.power`, absent without a battery); the runtime asks it every
 * minute (range `hour` from now: no points) and tells the person in their Chat, as the disk alerts do (one-person.md
 * OP-S74): once when the box has run on its battery for a minute, once when the battery reaches 15 %, once when the
 * power is back. What each burrow last heard is kept in `burrows.host_power_alert`, so a box that shut itself down at
 * 10 % and starts again on mains still says the power is back; an alert that reached nobody because posting failed is
 * due again at the next check (DK-S23). The latest reading is the screen's power line, and with the hour's points the
 * screen's *This Whombat* panel (DK-22, DK-S31): the same call, with the points since the last read while the panel shows.
 */
import { DeskPower as DeskPowerSchema } from '@whombat/control-contracts/local';
import { DESK_BATTERY_LOW_PERCENT, hostPowerText } from '@whombat/core';
import type { HostMetrics } from '@whombat/protocol/session';
import { and, asc, eq } from 'drizzle-orm';
import { burrows } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { iso } from '../lib/time';
import type { HostMetricsService } from '../managed/host-metrics';
import type { Services } from '../services';
import { type BoxReading, HostSeriesWindow } from './box';
import type { DeskPower } from './shapes';
import { tellPerson } from './tell';

/** How often the power is checked (DK-10). */
export const POWER_CHECK_MS = 60_000;
/** How long on battery before the person hears of it: a flicker says nothing. */
export const POWER_OUT_AFTER_MS = 60_000;
/** The battery level the person hears about (DK-10). */
export const POWER_LOW_PCT = DESK_BATTERY_LOW_PERCENT;
/** A reading the screen may use without asking again. */
export const POWER_FRESH_MS = 10_000;
/** After the manager didn't answer, ask it again only after this long. */
export const POWER_RETRY_MS = 5 * 60_000;
/** The panel's points are read while the screen asked for them this recently (it asks every second while shown). */
export const BOX_WANTED_MS = 60_000;

/** What the person last heard: nothing, the power is out, the battery is low. */
export type PowerAlertLevel = 0 | 1 | 2;
export type PowerAlert = 'out' | 'back' | 'low';

/** `HostNow.power` as the screen's `DeskPower`, or null (no battery, a manager before 0.100). */
export function powerOf(metrics: Pick<HostMetrics, 'now'> | null | undefined): DeskPower | null {
  const raw = metrics?.now.power;
  if (!raw) return null;
  const parsed = DeskPowerSchema.safeParse({
    ...raw,
    percent: Math.round(raw.percent),
    minutesLeft: raw.minutesLeft === null ? null : Math.round(raw.minutesLeft),
    since: raw.since ?? null,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * What to tell the person now (pure): `out` after a minute on battery, then `low` at 15 % or less, `back` once
 * the box is on mains again after either. `onBatteryMs` is how long it has been on battery (0 on mains).
 */
export function powerAlertDue(
  reading: DeskPower | null,
  kept: PowerAlertLevel,
  onBatteryMs: number,
): { keep: PowerAlertLevel; alert: PowerAlert | null } {
  if (!reading) return { keep: kept, alert: null };
  if (reading.source === 'ac') return kept > 0 ? { keep: 0, alert: 'back' } : { keep: 0, alert: null };
  if (kept === 0)
    return onBatteryMs >= POWER_OUT_AFTER_MS ? { keep: 1, alert: 'out' } : { keep: 0, alert: null };
  if (kept === 1 && reading.percent <= POWER_LOW_PCT) return { keep: 2, alert: 'low' };
  return { keep: kept, alert: null };
}

export function powerAlertText(alert: PowerAlert, reading: DeskPower | null): string {
  if (alert === 'out') return hostPowerText.out({ minutesLeft: reading?.minutesLeft ?? null });
  if (alert === 'low') return hostPowerText.low({ percent: reading?.percent ?? POWER_LOW_PCT });
  return hostPowerText.back();
}

const keptLevel = (stored: number): PowerAlertLevel => (stored === 1 || stored === 2 ? stored : 0);

/** Posts a message from the person's assistant (`tellPerson`): false when they have none here. */
export type PowerTell = (
  services: Services,
  burrowId: string,
  personId: string,
  text: string,
) => Promise<boolean>;

/** A burrow's level moved by a reading, and the alert that says so. */
export interface PowerKept {
  alert: PowerAlert;
  from: PowerAlertLevel;
  to: PowerAlertLevel;
}

/** The latest reading's figures for the panel (`deskBox`'s input but the series). */
type BoxNow = Pick<BoxReading, 'now' | 'disks'>;

export class HostPower {
  #ticker: (() => void) | null = null;
  #closed = false;
  #latest: { power: DeskPower | null; box: BoxNow | null; at: number } | null = null;
  #reading: Promise<DeskPower | null> | null = null;
  /** The last hour of points, while the panel shows (DK-22). */
  readonly #window = new HostSeriesWindow();
  /** Until when the screen wants the panel's points. */
  #boxWantedUntil = 0;
  /** When this process first saw the box on battery, for a manager that doesn't say since when. */
  #batterySeen: number | null = null;
  /** Until when a manager that didn't answer isn't asked again (its warning is logged once a minute at most). */
  #quietUntil = 0;

  constructor(
    private readonly services: Services,
    private readonly host: HostMetricsService,
    /** How an alert is posted (tests make it fail). */
    private readonly tell: PowerTell = tellPerson,
  ) {}

  /** Checks on the housekeeping tick: soon after the start, then every minute. */
  start(): void {
    if (this.#ticker || this.#closed) return;
    this.#ticker = this.services.housekeeping.add('host power', POWER_CHECK_MS, () => this.check(), {
      first: 'tick',
    });
  }

  close(): void {
    this.#closed = true;
    this.#ticker?.();
    this.#ticker = null;
  }

  /**
   * Reads the power from the manager now (one read at a time); null without a battery or an answer. A manager that
   * doesn't answer is left alone for 5 minutes.
   */
  read(): Promise<DeskPower | null> {
    if (this.services.clock().getTime() < this.#quietUntil) return Promise.resolve(this.latest);
    this.#reading ??= (async () => {
      const now = this.services.clock();
      // The panel's points: the whole hour first, then those since the last; none while it doesn't show.
      const points = now.getTime() < this.#boxWantedUntil;
      const since = points ? this.#window.since(now.getTime()) : iso(now);
      const { metrics, reason } = await this.host.read({ range: 'hour', ...(since ? { since } : {}) }, 'UTC');
      // A manager that answered but hasn't measured yet (it just started with the box) is asked again soon.
      if (reason === 'unavailable')
        this.#quietUntil = now.getTime() + (this.host.unmeasured ? POWER_FRESH_MS : POWER_RETRY_MS);
      const power = powerOf(metrics);
      if (metrics && points) this.#window.add(metrics.series, now.getTime());
      this.#latest = {
        power,
        box: metrics ? { now: metrics.now, disks: { data: metrics.disks.data } } : null,
        at: this.services.clock().getTime(),
      };
      if (power?.source === 'battery') this.#batterySeen ??= now.getTime();
      else if (power) this.#batterySeen = null;
      return power;
    })().finally(() => {
      this.#reading = null;
    });
    return this.#reading;
  }

  /** The latest reading when fresh enough, else a new one. */
  async current(maxAgeMs = POWER_FRESH_MS): Promise<DeskPower | null> {
    const latest = this.#latest;
    if (latest && this.services.clock().getTime() - latest.at < maxAgeMs) return latest.power;
    return this.read();
  }

  /** The latest reading at once; a stale one is read again in the background (the screen asks every second). */
  peek(maxAgeMs = POWER_FRESH_MS): DeskPower | null {
    const latest = this.#latest;
    if (!latest || this.services.clock().getTime() - latest.at >= maxAgeMs)
      void this.read().catch(() => null);
    return latest?.power ?? null;
  }

  /** The last reading without asking (null before the first). */
  get latest(): DeskPower | null {
    return this.#latest?.power ?? null;
  }

  /**
   * The panel's input at once, for the screen (DK-22): the latest reading with the last hour's points (none yet on a
   * box just started), or null when the manager didn't answer (no panel then). Asking keeps the points coming for a
   * minute; the first ask reads the hour now, a stale reading is read again in the background. `at` says when it was
   * read, so the panel is made once per read.
   */
  peekBox(maxAgeMs = POWER_FRESH_MS): { input: BoxReading; at: number } | null {
    const now = this.services.clock().getTime();
    const first = now >= this.#boxWantedUntil;
    this.#boxWantedUntil = now + BOX_WANTED_MS;
    const latest = this.#latest;
    // Wanted just now: the hour's points at once, after a read without them that may be going on.
    if (first) void (this.#reading ?? Promise.resolve()).then(() => this.read()).catch(() => null);
    else if (!latest || now - latest.at >= maxAgeMs) void this.read().catch(() => null);
    if (!latest?.box) return null;
    const series = this.#window.series() ?? {
      start: new Date(latest.at).toISOString(),
      stepS: 10,
      points: [],
    };
    return { input: { ...latest.box, series }, at: latest.at };
  }

  /** How long the box has been on battery by this reading. */
  onBatteryMs(power: DeskPower | null, now: number): number {
    if (power?.source !== 'battery') return 0;
    const since = power.since ? Date.parse(power.since) : (this.#batterySeen ?? now);
    return Math.max(0, now - since);
  }

  /**
   * One check: reads the power, keeps each burrow's level and posts what is due. An alert that reached nobody because
   * every post (or finding who to tell) failed puts the level back, so the next check posts it again; one with nobody
   * to tell (no person with a Chat) stays told. Null when it read nothing.
   */
  async check(): Promise<{ posted: number; alerts: PowerAlert[] } | null> {
    if (this.#closed || this.services.maintenance.paused) return null;
    const power = await this.read();
    if (!power) return null;
    const now = this.services.clock().getTime();
    const onBattery = this.onBatteryMs(power, now);
    const told = new Set<string>();
    const alerts: PowerAlert[] = [];
    let posted = 0;
    const rows = await this.services.db
      .select({ id: burrows.id })
      .from(burrows)
      .orderBy(asc(burrows.createdAt), asc(burrows.id));
    for (const { id } of rows) {
      const kept = await this.keep(id, power, onBattery);
      if (!kept) continue;
      alerts.push(kept.alert);
      const text = powerAlertText(kept.alert, power);
      // Reached: told now or earlier in this check (an account in two burrows hears it once).
      let reached = false;
      let failed = false;
      try {
        const thePersonHere = await thePerson(this.services.db, id);
        for (const person of thePersonHere ? [thePersonHere] : []) {
          const key = `${person.accountId}:${kept.alert}`;
          if (!person.accountId) continue;
          if (told.has(key)) {
            reached = true;
            continue;
          }
          try {
            if (!(await this.tell(this.services, id, person.id, text))) continue;
            told.add(key);
            reached = true;
            posted++;
          } catch (err) {
            failed = true;
            this.services.log.warn({ err: String(err), burrowId: id }, 'host power: alert not posted');
          }
        }
      } catch (err) {
        failed = true;
        this.services.log.warn({ err: String(err), burrowId: id }, 'host power: nobody found to tell');
      }
      if (failed && !reached) await this.#unkeep(id, kept);
    }
    return { posted, alerts };
  }

  /** The burrow's level after this reading, kept in its transaction; the level's move and its alert, or null. */
  async keep(burrowId: string, power: DeskPower, onBatteryMs: number): Promise<PowerKept | null> {
    const { result } = await this.services.pipeline.transact(burrowId, async ({ tx }) => {
      const [row] = await tx
        .select({ level: burrows.hostPowerAlert })
        .from(burrows)
        .where(eq(burrows.id, burrowId));
      if (!row) return null;
      const from = keptLevel(row.level);
      const due = powerAlertDue(power, from, onBatteryMs);
      if (due.keep !== row.level)
        await tx.update(burrows).set({ hostPowerAlert: due.keep }).where(eq(burrows.id, burrowId));
      return due.alert ? { alert: due.alert, from, to: due.keep } : null;
    });
    return result;
  }

  /** Puts the level back after an alert nobody heard (unless something moved it since), so it is due again. */
  async #unkeep(burrowId: string, kept: PowerKept): Promise<void> {
    try {
      await this.services.pipeline.transact(burrowId, async ({ tx }) => {
        await tx
          .update(burrows)
          .set({ hostPowerAlert: kept.from })
          .where(and(eq(burrows.id, burrowId), eq(burrows.hostPowerAlert, kept.to)));
      });
    } catch (err) {
      this.services.log.warn({ err: String(err), burrowId }, 'host power: the alert wasn’t put back');
    }
  }
}
