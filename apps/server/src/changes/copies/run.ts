/**
 * Settings copies (docs/decisions/outside-changes.md): every 15 minutes the pass looks for services due a copy — the
 * first within the hour of connecting, then one a night (between 2 and 5 at the box's clock, or any time when the last
 * try is a day and a half old), a failed try again after an hour, three times. A copy the same as the newest only moves
 * when it was checked; one whose settings compare the same replaces the newest; a different one is kept beside it (the
 * newest ten) and what changed between them goes into the change log. Copies are sealed with the master key.
 */
import { createHash } from 'node:crypto';
import { newId, SETTINGS_COPIES_KEPT, thingId } from '@whombat/core';
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { CatalogConnectionRow } from '../../connections/types';
import type { SettingsPartChange } from '../../db/schema/changes';
import {
  burrows,
  catalogConnections,
  type SettingsCopyStateRow,
  settingsCopies,
  settingsCopyStates,
} from '../../db/schema/index';
import { homeAudience, publishHomeChanged } from '../../home/notify';
import type { Services } from '../../services';
import { recordRead } from '../store';
import { COPY_IDS, copyServiceOf } from './index';
import { diffSummaries, type SettingsSummary } from './summary';
import {
  COPY_MAX_BYTES,
  CopyFailed,
  type CopyProblem,
  type CopyService,
  type CopyTaken,
  copyProblemOf,
} from './types';

export const SETTINGS_COPIES_MS = 15 * 60_000;
const H = 60 * 60_000;
/** A failed try is tried again after an hour, this many times in a row; then the next night. */
export const COPY_RETRIES = 3;
/** The night's hours a copy is made in, at the box's clock. */
const NIGHT_FROM = 2;
const NIGHT_TO = 5;

/** The hour at the box's clock. */
function localHour(now: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(now);
  return Number.parseInt(h, 10) % 24;
}

/** Whether a connection is due a copy now. */
export function copyDue(
  state: Pick<SettingsCopyStateRow, 'triedAt' | 'failedSince' | 'failures'> | null,
  now: Date,
  timeZone: string,
): boolean {
  if (!state?.triedAt) return true;
  const since = now.getTime() - state.triedAt.getTime();
  if (state.failedSince && state.failures < COPY_RETRIES && since >= H) return true;
  if (since >= 36 * H) return true;
  const hour = localHour(now, timeZone);
  return since >= 12 * H && hour >= NIGHT_FROM && hour < NIGHT_TO;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** How one try ended, for tests and the log. */
export type CopyOutcome = 'first' | 'same' | 'replaced' | 'kept' | CopyProblem;

/** One try at a connection's copy (`service`: its reader, the catalog's unless a test gives one). */
export async function takeSettingsCopy(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
  service: CopyService | null = copyServiceOf(row.catalogId),
): Promise<CopyOutcome> {
  if (!service) return 'missing';
  let taken: CopyTaken | null = null;
  let problem: CopyProblem | null = null;
  try {
    taken = await service.take(services, row, now);
    if (taken.bytes.length > COPY_MAX_BYTES) throw new CopyFailed('tooLarge');
    if (!taken.bytes.length) throw new CopyFailed('unreadable');
  } catch (err) {
    taken = null;
    problem = copyProblemOf(err);
  }
  const [latest] = await services.db
    .select({
      id: settingsCopies.id,
      sha256: settingsCopies.sha256,
      summary: settingsCopies.summary,
      checkedAt: settingsCopies.checkedAt,
    })
    .from(settingsCopies)
    .where(eq(settingsCopies.connectionId, row.id))
    .orderBy(desc(settingsCopies.madeAt))
    .limit(1);
  let parts: SettingsPartChange[] = [];
  const { result } = await services.pipeline.transact(row.burrowId, async (session) => {
    const tx = session.tx;
    let outcome: CopyOutcome;
    if (taken) {
      const sha = sha256(taken.bytes);
      // A summary that couldn't be read keeps the last one, so the next comparison is with what was known.
      const summary: SettingsSummary = taken.summary ?? latest?.summary ?? {};
      const diff = latest && taken.summary ? diffSummaries(latest.summary, taken.summary) : null;
      if (latest && latest.sha256 === sha) {
        await tx.update(settingsCopies).set({ checkedAt: now }).where(eq(settingsCopies.id, latest.id));
        outcome = 'same';
      } else if (latest && diff && !diff.length) {
        // Different bytes with the same settings (a zip's own times): the newest is replaced, not kept twice.
        await tx
          .update(settingsCopies)
          .set({
            madeAt: now,
            checkedAt: now,
            fileName: taken.fileName,
            contentType: taken.contentType,
            size: taken.bytes.length,
            sha256: sha,
            sealed: services.custody.sealBytes(`settings_copy:${latest.id}`, taken.bytes),
            summary,
          })
          .where(eq(settingsCopies.id, latest.id));
        outcome = 'replaced';
      } else {
        const id = newId('settingsCopy');
        await tx.insert(settingsCopies).values({
          id,
          burrowId: row.burrowId,
          connectionId: row.id,
          madeAt: now,
          checkedAt: now,
          fileName: taken.fileName,
          contentType: taken.contentType,
          size: taken.bytes.length,
          sha256: sha,
          sealed: services.custody.sealBytes(`settings_copy:${id}`, taken.bytes),
          summary,
        });
        const keep = await tx
          .select({ id: settingsCopies.id })
          .from(settingsCopies)
          .where(eq(settingsCopies.connectionId, row.id))
          .orderBy(desc(settingsCopies.madeAt))
          .limit(SETTINGS_COPIES_KEPT);
        await tx.delete(settingsCopies).where(
          and(
            eq(settingsCopies.connectionId, row.id),
            notInArray(
              settingsCopies.id,
              keep.map((k) => k.id),
            ),
          ),
        );
        parts = diff ?? [];
        outcome = latest ? 'kept' : 'first';
      }
    } else outcome = problem ?? 'unreachable';
    const ok = taken !== null;
    await tx
      .insert(settingsCopyStates)
      .values({
        connectionId: row.id,
        burrowId: row.burrowId,
        triedAt: now,
        okAt: ok ? now : null,
        failedSince: ok ? null : now,
        problem: ok ? null : problem,
        failures: ok ? 0 : 1,
      })
      .onConflictDoUpdate({
        target: settingsCopyStates.connectionId,
        set: ok
          ? { triedAt: now, okAt: now, failedSince: null, problem: null, failures: 0 }
          : {
              triedAt: now,
              problem,
              failures: sql`${settingsCopyStates.failures} + 1`,
              failedSince: sql`coalesce(${settingsCopyStates.failedSince}, ${now.toISOString()}::timestamptz)`,
            },
      });
    publishHomeChanged(session, await homeAudience(session, row.burrowId), ['things']);
    return outcome;
  });
  // What changed between the two copies goes into the change log, said as “OPNsense’s settings changed: …”.
  if (parts.length && latest)
    await recordRead(services, {
      burrowId: row.burrowId,
      thing: thingId('connection', row.id),
      source: 'settings',
      state: { sha: sha256(taken?.bytes ?? Buffer.alloc(0)) },
      drafts: [{ kind: 'settings', subject: '', fact: { k: 'settings', service: service.name, parts } }],
      since: latest.checkedAt,
      now,
    });
  return result;
}

/** One pass: each service due a copy gets one try. Returns how many were tried. */
export async function settingsCopyPass(services: Services): Promise<number> {
  const now = services.clock();
  const rows = await services.db
    .select({ row: catalogConnections, timeZone: burrows.timeZone })
    .from(catalogConnections)
    .innerJoin(burrows, eq(burrows.id, catalogConnections.burrowId))
    .where(and(eq(catalogConnections.status, 'active'), inArray(catalogConnections.catalogId, COPY_IDS)));
  if (!rows.length) return 0;
  const states = new Map(
    (
      await services.db
        .select()
        .from(settingsCopyStates)
        .where(
          inArray(
            settingsCopyStates.connectionId,
            rows.map((r) => r.row.id),
          ),
        )
    ).map((s) => [s.connectionId, s]),
  );
  let tried = 0;
  for (const { row, timeZone } of rows) {
    if (!copyDue(states.get(row.id) ?? null, now, timeZone)) continue;
    tried++;
    await takeSettingsCopy(services, row, now).catch((err) =>
      services.log.warn({ err: String(err), connectionId: row.id }, 'settings copy: try failed'),
    );
  }
  return tried;
}
