/**
 * Running a service's test (docs/decisions/service-works.md): its steps as the connection, under one deadline, then its
 * result kept. And the health pass's part: a watched test runs when it is due, and its line joins the connection's
 * other lines, so the dot, the Inbox, the incident and its push, Keep quiet and one cause all treat it as any other.
 */
import { hasServiceTest, SERVICE_TEST_CHECK, type ServiceTestBy, type ServiceTestKind } from '@whombat/core';
import { externalEffect } from '../commit/scope';
import { signedConnectionFetch } from '../connections/http';
import type { CatalogConnectionRow } from '../connections/types';
import type { ServiceTestRunRow } from '../db/schema/index';
import type { Services } from '../services';
import { KIND_DEADLINE_MS, KIND_MAX_BYTES } from '../things/kinds/read';
import { urlOf } from '../things/kinds/storage/net';
import { displayName } from '../things/part-of';
import { checkWatched } from '../things/quiet/defaults';
import type { ThingQuiet } from '../things/quiet/store';
import type { KindNotice } from '../things/quiet/types';
import { holdOf } from '../things/quiet/windows';
import { due, fresh, worksNotice } from './rules';
import { lastChangedAt, recentRuns, recordRun } from './store';
import { runSteps, SERVICE_TESTS, StepFailed, type TestFetch, type TestResult, testTools } from './tests';

/** A whole test's deadline: a few steps, each with a read's own. */
export const TEST_DEADLINE_MS = 30_000;

/** Requests as the connection: its address, its sign-in and its rules, as a page's reads. */
export function connectionFetch(services: Services, row: CatalogConnectionRow): TestFetch {
  return async (req) => {
    const res = await externalEffect(
      'things.read',
      () =>
        signedConnectionFetch(
          services,
          row,
          {
            method: req.method ?? 'GET',
            url: urlOf(row, req.path, req.query),
            headers: req.headers ?? {},
            ...(req.body !== undefined ? { body: req.body } : {}),
          },
          {
            maxBytes: req.maxBytes ?? KIND_MAX_BYTES,
            deadlineMs: KIND_DEADLINE_MS,
            ...(req.firstBytes !== undefined ? { truncateAt: req.firstBytes } : {}),
          },
        ),
      { idempotent: true },
    );
    return { status: res.status, body: res.body, headers: res.headers };
  };
}

/** A test's steps under one deadline; past it, the step it was at didn't answer in time. */
export async function testOnce(
  kind: ServiceTestKind,
  fetch: TestFetch,
  row: Pick<CatalogConnectionRow, 'baseUrl' | 'fields'>,
  now: Date,
  deadlineMs = TEST_DEADLINE_MS,
): Promise<TestResult> {
  let step: string | undefined;
  const tools = testTools(
    (req) => fetch(req),
    row,
    now,
    (s) => {
      step = s;
    },
  );
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<TestResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ outcome: 'broken', ...(step ? { step } : {}), reason: 'timeout', facts: {} }),
      deadlineMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([runSteps(SERVICE_TESTS[kind], tools), late]);
  } catch (err) {
    // A test that broke on something it didn't expect counts as an answer it couldn't read, at the step it was at.
    const failed =
      err instanceof StepFailed ? err : new StepFailed(step ?? 'unknown', 'broken', 'unreadable');
    return { outcome: failed.outcome, step: failed.step, reason: failed.reason, facts: {} };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs a connection's test now and keeps its result; null for a service Whombat has no test for. */
export async function runServiceTest(
  services: Services,
  row: CatalogConnectionRow,
  opts: { by: ServiceTestBy; now?: Date; fetch?: TestFetch },
): Promise<ServiceTestRunRow | null> {
  if (!hasServiceTest(row.catalogId)) return null;
  const at = opts.now ?? services.clock();
  const started = Date.now();
  const result = await testOnce(row.catalogId, opts.fetch ?? connectionFetch(services, row), row, at);
  return recordRun(services, row, { ...result, at, ms: Date.now() - started, by: opts.by });
}

/** What a health pass adds for a connection that answered: the test's line, or that its result says nothing now. */
export interface WorksPass {
  lines: KindNotice[];
  /** No fresh result: an Ignore of its line doesn't end now. */
  skipped: boolean;
}

/**
 * The test's part of a connection's health pass: only while its check is watched and the thing isn't held quiet, it
 * runs when due (`rules.ts`), and its line shows while the last two runs failed.
 */
export async function worksPass(
  services: Services,
  row: CatalogConnectionRow,
  quiet: ThingQuiet | null | undefined,
  now: Date,
  timeZone: string,
  fetch?: TestFetch,
): Promise<WorksPass> {
  if (!hasServiceTest(row.catalogId)) return { lines: [], skipped: false };
  // What it watches couldn't be read: whether the test is on is unknown, so an Ignore of its line doesn't end.
  if (!quiet) return { lines: [], skipped: true };
  if (!checkWatched(quiet, SERVICE_TEST_CHECK)) return { lines: [], skipped: false };
  // Kept quiet or down because of something else: the service is left alone until that ends.
  if (holdOf(quiet, now)) return { lines: [], skipped: true };
  let runs: ServiceTestRunRow[] = await recentRuns(services.db, row.id, 4);
  if (due(runs, now, await lastChangedAt(services.db, row))) {
    const made = await runServiceTest(services, row, { by: 'watch', now, ...(fetch ? { fetch } : {}) });
    if (made) runs = [made, ...runs];
  }
  if (!fresh(runs, now)) return { lines: [], skipped: true };
  const line = worksNotice(row.catalogId, displayName(row), runs, timeZone);
  return { lines: line ? [line] : [], skipped: false };
}
