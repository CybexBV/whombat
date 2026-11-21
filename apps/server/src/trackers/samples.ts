/**
 * “Try it on a recent report” (docs/decisions/report-trackers.md TA-19): the connection's newest open reports
 * (`automations.samples`, at most 10, never the reporter), and the report a test run is tried on, read live before the
 * run is made (its scope is what a mirrored report would give).
 */
import type { AutomationReportSample, TrackerItemKind, TrackerTrigger } from '@whombat/core';
import type { CatalogConnectionRow } from '../connections/types';
import { ApiError, badRequest, notFound } from '../lib/errors';
import type { Services } from '../services';
import { tokenRefused } from './connection';
import { SourceProblem, TrackerNotFound } from './errors';
import { addressHost, mirroredReport, type TrackerRunItem } from './items';

/** Statuses someone still waits on: a sample is one of these. */
export const TRACKER_OPEN_STATUSES: readonly string[] = [
  'new',
  'investigating',
  'needs_information',
  'in_progress',
  'planned',
];

/** How many samples “Try it on …” offers. */
export const SAMPLES_MAX = 10;

/** A tracker's failure as the API answers it; a refused token also marks the connection (TA-03). */
async function failure(services: Services, row: CatalogConnectionRow, err: unknown): Promise<never> {
  if (err instanceof ApiError) throw err;
  if (err instanceof TrackerNotFound) throw notFound('Report');
  if (err instanceof SourceProblem && err.code === 'refused') await tokenRefused(services, row.id);
  throw new ApiError('conflict', err instanceof Error ? err.message : String(err));
}

/** The newest open reports of the connection of these kinds, newest first (TA-19). */
export async function reportSamples(
  services: Services,
  row: CatalogConnectionRow,
  kinds: readonly TrackerItemKind[] = ['bug', 'feature'],
): Promise<AutomationReportSample[]> {
  const out: AutomationReportSample[] = [];
  try {
    const read = await services.tracker.driverFor(row).poll({ after: null, watch: [], pages: 3 });
    for (const item of read.items) {
      const m = mirroredReport(item);
      if (!TRACKER_OPEN_STATUSES.includes(m.status) || !kinds.includes(m.type)) continue;
      out.push({
        kind: 'report',
        connectionId: row.id,
        reportId: m.reportId,
        number: m.number,
        title: m.title,
        type: m.type,
        organization: m.organization,
        openedAt: m.reportedAt ?? new Date(0).toISOString(),
      });
      if (out.length >= SAMPLES_MAX) break;
    }
  } catch (err) {
    return failure(services, row, err);
  }
  return out.sort((a, b) => b.number - a.number);
}

/** The report a test run is tried on, read live (TA-19), as a run's item; refused when the trigger doesn't take it. */
export async function sampleReportItem(
  services: Services,
  row: CatalogConnectionRow,
  trigger: TrackerTrigger,
  reportId: string,
): Promise<TrackerRunItem> {
  const driver = (() => {
    try {
      return services.tracker.driverFor(row);
    } catch (err) {
      return err as Error;
    }
  })();
  if (driver instanceof Error) return failure(services, row, driver);
  let item: Awaited<ReturnType<typeof driver.item>>;
  try {
    item = await driver.item(reportId);
  } catch (err) {
    return failure(services, row, err);
  }
  const m = mirroredReport(item);
  const kinds = trigger.itemKinds ?? ['bug', 'feature'];
  if (!kinds.includes(m.type))
    throw badRequest(
      m.type === 'feature'
        ? `#${m.number} is a feature request, and this automation starts from bug reports.`
        : `#${m.number} is a bug report, and this automation starts from feature requests.`,
    );
  const { reportedAt: _reportedAt, ...rest } = m;
  return {
    ...rest,
    connectionId: row.id,
    connection: row.label,
    handle: row.handle,
    host: addressHost(row.baseUrl),
    product: driver.words.product,
  };
}
