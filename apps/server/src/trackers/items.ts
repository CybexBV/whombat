/**
 * A tracker report in an automation run (docs/decisions/report-trackers.md TA-07, TA-08): what the mirror keeps of a new
 * report (never the reporter's name or email), what `{{trigger.*}}` reads for one — the same for a mirrored report and
 * a test run on a sample read live —, the readable `trigger.text` a recipe's prompt embeds, the run's headline and its
 * item key (`tracker:<connectionId>#<number>`: one thread per report). Pure.
 */
import { cleanText, type JsonObject, TrackerItemKind } from '@whombat/core';
import { z } from 'zod';
import type { TrackerItem } from './driver';

/** What the mirror keeps of the description and the expected text (TA-07). */
export const MIRROR_DESCRIPTION_MAX = 8000;
export const MIRROR_EXPECTED_MAX = 3000;
/** What `trigger.text` carries of them (a step's prompt is cut at 3 900 characters, TA-08). */
export const TEXT_DESCRIPTION_MAX = 1500;
export const TEXT_EXPECTED_MAX = 600;

/** A report as a test run's sample hands it to `automation.run_now` (read by the route before the commit, TA-19). */
export const TrackerRunItemSchema = z.object({
  connectionId: z.string().min(1).max(100),
  connection: z.string().max(80),
  handle: z.string().max(40),
  /** The connection address's host (`desk.example.com`; 0.75, `{{trigger.host}}`). */
  host: z.string().max(253).default(''),
  /** What the tracker is called (its driver's `words.product`): “Acme Desk 2.4 (production)”. */
  product: z.string().max(40).default('the tracker'),
  reportId: z.string().min(1).max(100),
  number: z.number().int().positive(),
  type: TrackerItemKind,
  title: z.string().max(300),
  organization: z.string().max(200).nullable(),
  environment: z.string().max(100).nullable(),
  version: z.string().max(64).nullable(),
  page: z.string().max(160).nullable(),
  browser: z.string().max(120).nullable(),
  status: z.string().max(40),
  priority: z.string().max(40).nullable(),
  description: z.string().max(MIRROR_DESCRIPTION_MAX),
  expected: z.string().max(MIRROR_EXPECTED_MAX),
  hasScreenshot: z.boolean(),
  hasDiagnostics: z.boolean(),
});

/** A report as a run sees it: a `tracker_items` row, or a report read live for a test run. */
export interface TrackerRunItem {
  connectionId: string;
  /** The connection's label (“Acme Desk dev”) and handle (`acme`). */
  connection: string;
  handle: string;
  /** The connection address's host (`desk.example.com`): `{{trigger.host}}`. */
  host: string;
  /** What the tracker is called (its driver's `words.product`). */
  product: string;
  /** The tracker's report id. */
  reportId: string;
  number: number;
  type: TrackerItemKind;
  title: string;
  organization: string | null;
  environment: string | null;
  version: string | null;
  page: string | null;
  browser: string | null;
  status: string;
  priority: string | null;
  description: string;
  expected: string;
  hasScreenshot: boolean;
  hasDiagnostics: boolean;
}

/** The fields of a report the mirror keeps (TA-07): no reporter, the long texts cut. */
export type MirroredReport = Omit<
  TrackerRunItem,
  'connectionId' | 'connection' | 'handle' | 'host' | 'product'
> & {
  reportedAt: string | null;
  /** The tracker's id of the reporting organization (TA-60). */
  organizationId?: string | null;
};

/** A stored `kind` as a report kind: anything but `feature` is a bug report. */
export function itemKindOf(kind: string): TrackerItemKind {
  return kind === 'feature' ? 'feature' : 'bug';
}

function opt(value: string | null | undefined, max: number): string | null {
  const text = cleanText(value ?? '', max);
  return text || null;
}

/** What the mirror keeps of a report as its driver read it (TA-07). The reporter's name and email are left out. */
export function mirroredReport(report: TrackerItem): MirroredReport {
  const created = Date.parse(report.createdAt);
  return {
    reportId: report.id,
    number: report.number,
    type: report.kind,
    title: opt(report.title, 300) ?? `Report #${report.number}`,
    organization: opt(report.organization.name, 200),
    organizationId: opt(report.organization.id, 200),
    environment: report.environment,
    version: opt(report.version, 64),
    page: opt(report.page, 160),
    browser: opt(report.browser, 120),
    status: cleanText(report.status, 40) || 'new',
    priority: opt(report.priority, 40),
    description: cleanText(report.description ?? '', MIRROR_DESCRIPTION_MAX),
    expected: cleanText(report.expected ?? '', MIRROR_EXPECTED_MAX),
    hasScreenshot: report.hasScreenshot,
    hasDiagnostics: report.hasDiagnostics,
    reportedAt: Number.isNaN(created) ? null : new Date(created).toISOString(),
  };
}

/** What a run remembers the report by (TA-08): later runs of the automation about it continue its thread. */
export function trackerItemKey(connectionId: string, number: number): string {
  return `tracker:${connectionId}#${number}`;
}

/** `<connection handle>-<number>`: `acme-15` (a fix's branch is `feat/acme-15`, TA-18). */
export function trackerRef(item: Pick<TrackerRunItem, 'handle' | 'number'>): string {
  return `${item.handle}-${item.number}`;
}

function quoted(title: string): string {
  return `“${title.replace(/\s+/g, ' ').trim()}”`;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** “New bug report #15 in Acme Desk dev from HollowMere College: “The rollout never finishes”” (TA-08). */
export function trackerHeadline(item: TrackerRunItem): string {
  const what = item.type === 'feature' ? 'New feature request' : 'New bug report';
  const from = item.organization ? ` from ${item.organization}` : '';
  return `${what} #${item.number} in ${item.connection}${from}: ${quoted(item.title)}`;
}

/** “Seen on: Devices · Chrome 141 · Acme Desk 2.4 (production)”, or null when the tracker said nothing of it. */
export function seenOn(
  item: Pick<TrackerRunItem, 'page' | 'browser' | 'version' | 'environment' | 'product'>,
): string | null {
  const version = item.version
    ? `${item.product} ${item.version}${item.environment ? ` (${item.environment})` : ''}`
    : item.environment
      ? `${item.product} (${item.environment})`
      : null;
  const parts = [item.page, item.browser, version].filter((p): p is string => !!p);
  return parts.length ? `Seen on: ${parts.join(' · ')}` : null;
}

/**
 * `trigger.text` of a report (TA-08): the headline, the description (≤ 1 500), “Expected: …” (≤ 600), where it was seen,
 * and what else it came with — `tracker_item` reads the whole report.
 */
export function trackerTriggerText(item: TrackerRunItem): string {
  const lines = [trackerHeadline(item)];
  const description = item.description.trim();
  if (description) lines.push('', clip(description, TEXT_DESCRIPTION_MAX));
  const expected = item.expected.trim();
  if (expected) lines.push('', `Expected: ${clip(expected, TEXT_EXPECTED_MAX)}`);
  const seen = seenOn(item);
  if (seen) lines.push('', seen);
  const extras = [
    ...(item.hasDiagnostics ? ['diagnostics'] : []),
    ...(item.hasScreenshot ? ['a screenshot'] : []),
  ];
  lines.push(
    extras.length
      ? `It came with ${extras.join(' and ')}: tracker_item reads the whole report.`
      : 'tracker_item reads the whole report.',
  );
  return lines.join('\n');
}

/** How much of the customer's new messages a `reporter_replied` run's `trigger.text` quotes (TA-31). */
export const TEXT_REPLY_MAX = 1500;

/** The host of a connection's address, lowercase (`dev.tracker.com`); '' when it isn't one. */
export function addressHost(address: string): string {
  try {
    return new URL(address).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * `trigger.text` of a customer's answer (TA-31): “The customer wrote back on Acme Desk dev #16 “The rollout never
 * finishes”: “…”” or “The customer says it still happens on …”, their new messages cut to 1 500 characters, and where
 * the rest is.
 */
export function trackerReplyText(
  item: Pick<TrackerRunItem, 'connection' | 'number' | 'title'>,
  reply: { event: 'wrote' | 'reopened'; text: string },
): string {
  const where = `${item.connection} #${item.number} ${quoted(item.title)}`;
  const words = reply.text.trim();
  const said = words ? `: “${clip(words, TEXT_REPLY_MAX)}”` : '.';
  const head =
    reply.event === 'reopened'
      ? `The customer says it still happens on ${where}${said}`
      : `The customer wrote back on ${where}${said}`;
  return [head, '', 'tracker_item reads the whole report and its conversation.'].join('\n');
}

/**
 * What `{{trigger.*}}` reads for a report (TA-08): a new one, or (`reply`, TA-31) the customer's answer on one an
 * automation ran for — the same fields, its `event` and its own `text`. Never the reporter's name or email.
 */
export function trackerItemScope(
  item: TrackerRunItem,
  reply?: { event: 'wrote' | 'reopened'; text: string },
): JsonObject {
  return {
    kind: 'tracker',
    event: reply ? 'reporter_replied' : 'item_opened',
    // Which answer it is: “Still happening” reopened it, or they wrote (report-trackers.md TA-70 reads it).
    ...(reply ? { answer: reply.event } : {}),
    item: 'report',
    connection: item.connection,
    connectionId: item.connectionId,
    host: item.host,
    reportId: item.reportId,
    number: item.number,
    ref: trackerRef(item),
    title: item.title,
    type: item.type,
    organization: item.organization,
    environment: item.environment,
    version: item.version,
    status: item.status,
    priority: item.priority,
    description: item.description,
    expected: item.expected,
    // A customer's report: no author with access to the repository, nobody assigned, no pull request (TA-08, TA-18).
    trusted: false,
    assigned: false,
    linkedPr: false,
    text: reply ? trackerReplyText(item, reply) : trackerTriggerText(item),
  };
}

/** A run's report as its scope has it (null when the run didn't start from a tracker report). */
export function scopeReport(
  scope: unknown,
): { connectionId: string; reportId: string; number: number; connection: string } | null {
  const s = scope as Record<string, unknown> | null;
  if (s?.kind !== 'tracker') return null;
  if (typeof s.connectionId !== 'string' || typeof s.reportId !== 'string') return null;
  return {
    connectionId: s.connectionId,
    reportId: s.reportId,
    number: typeof s.number === 'number' ? s.number : 0,
    connection: typeof s.connection === 'string' ? s.connection : 'the tracker',
  };
}
