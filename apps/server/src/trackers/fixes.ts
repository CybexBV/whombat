/**
 * Following a tracker report's fix until the customer can try it (docs/decisions/report-trackers.md TA-29…TA-33,
 * TA-36): a `tracker_fixes` row when a tracker run's pull request step opens a pull request (or finds one open), and
 * for a person's merged pull request whose description names a report an automation ran for (Whombat's marker, or a
 * line its tracker's driver reads). The tracker service's tick moves the rows along — merged (the mirror, else GitHub),
 * live where the customer is (the installation's `/v1/health` runs a clean revision that has the merge commit: GitHub's
 * compare says `ahead` or `identical`), the customer told (`trackerFixNotice`, signed, with the tracker's release
 * record for `available`) only when the automation's “Reply to customers” is at Can —, and each step says so in the
 * run's thread as the automation. Network outside any transaction; every change commits through the pipeline
 * (`tracker.fix_update`).
 */
import { randomUUID } from 'node:crypto';
import {
  type AutomationDefinition,
  customerSignature,
  type FixOutcome,
  fixOutcomeOf,
  guessLanguage,
  type JsonObject,
  noticeLanguage,
  randomIdBody,
  signedReply,
  type TrackerEnvironment,
  type TrackerFixState,
  type TrackerFixView,
  trackerAgentFixNotice,
  trackerEnvironmentOf,
  trackerFixNotice,
  trackerStatusLabel,
} from '@whombat/core';
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { reportedAssessment } from '../automations/assessment';
import { keyDecision, publisherCheck } from '../automations/authority';
import { postInRunThread } from '../automations/steps';
import { withStepMessages } from '../automations/steps/state';
import { type AutomationRunRow, loadRunRow, publishRun } from '../automations/store';
import { loadBurrowRow } from '../commit/pipeline';
import { defineCommand } from '../commit/types';
import type { CatalogConnectionRow } from '../connections/types';
import type { Db } from '../db/client';
import {
  automationRunSteps,
  automationRuns,
  automations,
  automationVersions,
  catalogConnections,
  pullRequests,
  repos,
  type TrackerFixRelease,
  trackerCursors,
  trackerFixes,
  trackerItems,
} from '../db/schema/index';
import { linkOfMessage } from '../domain/links';
import { notify as notifyPeople } from '../domain/notify';
import { threadPushGroup } from '../domain/push-preview';
import { thePerson } from '../domain/the-person';
import { forbidden, notFound } from '../lib/errors';
import { iso } from '../lib/time';
import { githubScope } from '../managed/providers/github-adapter';
import { loadConversationRow } from '../read/conversations';
import { loadMessageRow } from '../read/messages';
import { loadAgentRow } from '../read/principals';
import type { Services } from '../services';
import { TRACKER_CATALOG_ID, tokenRefused, trackerConnectionRow, trackerWords } from './connection';
import { type BoundDriver, driverIdOf } from './drivers';
import { SourceProblem, TrackerConflict, TrackerNotFound, TrackerRefusal } from './errors';
import { scopeReport, trackerItemKey } from './items';
import {
  nudgeRelease,
  RELEASE_ATTEMPTS,
  RELEASE_HOLD_MS,
  RELEASE_LAST_RETRY_MS,
  RELEASE_NUDGE_ANSWER_MS,
  RELEASE_QUIET_MS,
  RELEASE_SAME_RETRY_MS,
  RELEASE_SLOW_MS,
  RELEASE_SLOW_TOTAL_MS,
  RELEASE_START_RETRY_MS,
  ReleaseProblem,
  releaseEnded,
  releaseReporters,
  releaseRevived,
  releaseState,
  releasesStraightAway,
  releaseUnderWay,
  reportsBeingFixed,
  settleReleaseThread,
  startRelease,
} from './release';
import { otherOrganizations } from './reply';

/** A fix not live this long after its merge (or, still open, after it was opened) is no longer followed (TA-33). */
export const FIX_STOP_AFTER_MS = 90 * 86_400_000;
/** How often an installation's `/v1/health` is read at most (TA-30). */
export const HEALTH_EVERY_MS = 60_000;
/** How far back a person's merged pull request is looked at for a line naming a report (TA-29). */
export const PEOPLE_PR_WINDOW_MS = 7 * 86_400_000;
/** Fixes one pass looks at (a fix waiting for a new revision costs a few reads). */
const FIX_BATCH = 500;
/** People's merged pull requests one pass looks at. */
const PEOPLE_BATCH = 50;
/** Statuses after which the customer isn't told anything any more: someone closed it, or they said it works. */
const RESOLVED_STATUSES = ['closed', 'not_planned', 'duplicate', 'confirmed'];
/** States Whombat still moves along. */
export const FOLLOWED_STATES: readonly TrackerFixState[] = ['open', 'merged', 'development'];

type FixRow = typeof trackerFixes.$inferSelect;

/** A `tracker_fixes` row's id: core has no id kind for it, so `newId`'s shape with its own prefix. */
function fixRowId(): string {
  return `tfx_${randomIdBody(12)}`;
}

/** The host of a connection's address (`dev.tracker.com`), lowercase. */
export function hostOf(address: string): string {
  try {
    return new URL(address).hostname.toLowerCase();
  } catch {
    return (
      address
        .replace(/^https?:\/\//i, '')
        .split(/[/:]/)[0]
        ?.toLowerCase() ?? address
    );
  }
}

/* What people read ------------------------------------------------------------------------------------------ */

/** A fix as `tracker.item` gives it (TA-29). */
export function fixView(row: FixRow): TrackerFixView {
  const live = (host: string | null, version: string | null, at: Date | null) =>
    host && at ? { host: host.slice(0, 253), version: (version ?? '').slice(0, 100), at: iso(at) } : null;
  return {
    state: row.state,
    repo: row.repo.slice(0, 255),
    prNumber: Math.max(1, row.prNumber),
    prUrl: row.prUrl?.slice(0, 2048) ?? null,
    mergedAt: row.mergedAt ? iso(row.mergedAt) : null,
    development: live(row.developmentHost, row.developmentVersion, row.developmentAt),
    production: live(row.productionHost, row.productionVersion, row.productionAt),
    note: row.note?.slice(0, 500) ?? null,
  };
}

/** The latest fix Whombat follows for a report (null: none). */
export async function latestFix(
  db: Db,
  connectionId: string,
  reportId: string,
): Promise<TrackerFixView | null> {
  const [row] = await db
    .select()
    .from(trackerFixes)
    .where(and(eq(trackerFixes.connectionId, connectionId), eq(trackerFixes.reportId, reportId)))
    .orderBy(desc(trackerFixes.createdAt))
    .limit(1);
  return row ? fixView(row) : null;
}

/* Which installation (TA-32) --------------------------------------------------------------------------------- */

/** Which installation a connection is: what its health said, else its address. */
export async function connectionEnvironment(
  db: Db,
  row: Pick<CatalogConnectionRow, 'id' | 'baseUrl'>,
): Promise<TrackerEnvironment> {
  const [cursor] = await db
    .select({ environment: trackerCursors.healthEnvironment })
    .from(trackerCursors)
    .where(eq(trackerCursors.connectionId, row.id));
  return trackerEnvironmentOf(cursor?.environment ?? null, row.baseUrl);
}

/** The repositories a definition fixes in: its pull request steps' and its recipe's. */
function definitionRepos(definition: AutomationDefinition | null | undefined): string[] {
  if (!definition) return [];
  const recipe = (definition as { recipe?: { repo?: unknown } | null }).recipe;
  return [
    ...definition.steps.flatMap((s) => (s.kind === 'open_pull_request' ? [s.repo.toLowerCase()] : [])),
    ...(typeof recipe?.repo === 'string' ? [recipe.repo.toLowerCase()] : []),
  ];
}

/**
 * Where a report's fix goes live first (TA-32): its own connection when that is development; for a production report
 * the burrow's development tracker connection — when there are several, the one an automation fixing in the same
 * repository listens to —; null without one (the merge then counts as “fixed in development”).
 */
export async function developmentConnection(
  db: Db,
  report: CatalogConnectionRow,
  repo: string,
): Promise<CatalogConnectionRow | null> {
  if ((await connectionEnvironment(db, report)) === 'development') return report;
  const others = (
    await db
      .select()
      .from(catalogConnections)
      .where(
        and(
          eq(catalogConnections.burrowId, report.burrowId as string),
          eq(catalogConnections.catalogId, TRACKER_CATALOG_ID),
          ne(catalogConnections.id, report.id),
        ),
      )
  ).sort((a, b) => a.label.localeCompare(b.label));
  const development: CatalogConnectionRow[] = [];
  for (const c of others) if ((await connectionEnvironment(db, c)) === 'development') development.push(c);
  if (development.length <= 1) return development[0] ?? null;
  const live = await db
    .select({ definition: automationVersions.definition })
    .from(automations)
    .innerJoin(
      automationVersions,
      and(
        eq(automationVersions.automationId, automations.id),
        eq(automationVersions.n, automations.currentVersion),
      ),
    )
    .where(
      and(
        eq(automations.burrowId, report.burrowId as string),
        eq(automations.status, 'published'),
        isNull(automations.deletedAt),
      ),
    );
  for (const { definition } of live) {
    if (!definitionRepos(definition).includes(repo.toLowerCase())) continue;
    const listens = definition.triggers.flatMap((t) => (t.kind === 'tracker' ? [t.connectionId] : []));
    const found = development.find((c) => listens.includes(c.id));
    if (found) return found;
  }
  return development[0] ?? null;
}

/* Whether the automation tells the customer (TA-30, TA-36) ------------------------------------------------- */

/**
 * How an automation answers a connection's customers now: `can` — its current version has a `tracker_reply` step for
 * the connection and its “Reply to customers” is at Can (the customer is told); `ask` — at Asks; `off` — no reply step,
 * the key says No, or its publisher may no longer act.
 */
export async function replyKey(
  db: Db,
  automationId: string | null,
  connectionId: string,
): Promise<'can' | 'ask' | 'off'> {
  if (!automationId) return 'off';
  const [found] = await db
    .select({ a: automations, v: automationVersions })
    .from(automations)
    .innerJoin(
      automationVersions,
      and(
        eq(automationVersions.automationId, automations.id),
        eq(automationVersions.n, automations.currentVersion),
      ),
    )
    .where(eq(automations.id, automationId));
  if (!found || found.a.deletedAt) return 'off';
  const replies = found.v.definition.steps.some(
    (s) => s.kind === 'tracker_reply' && s.connectionId === connectionId,
  );
  if (!replies) return 'off';
  const who = await publisherCheck(db, found.a.burrowId, found.v.publishedById);
  if (!who.ok) return 'off';
  const decision = await keyDecision(db, found.a.principalId, who.publisher, 'report.reply', {
    connection: connectionId,
  });
  return decision.outcome === 'allow' ? 'can' : decision.outcome === 'ask' ? 'ask' : 'off';
}

/* The thread's words (TA-36; RN-S4, RN-S5 without replies) -------------------------------------------------- */

/** “[PR #52](…)”, or “PR #52” without its address. */
export function prLink(prNumber: number, url: string | null): string {
  return url ? `[PR #${prNumber}](${url})` : `PR #${prNumber}`;
}

/** “Acme Desk 2.4” in brackets, when the version is known. */
function versionOf(version: string | null, product: string): string {
  return version?.trim() ? ` (${product} ${version.trim()})` : '';
}

/** Why the customer wasn't told, in the thread's words (TA-36). */
export type NotTold =
  | { why: 'asks' }
  | { why: 'off' }
  | { why: 'resolved'; label: string; product: string }
  | { why: 'refused'; text: string; product: string };

function notToldText(n: NotTold): string {
  switch (n.why) {
    case 'asks':
      return 'The customer wasn’t told: this automation asks before replying to customers, so tell them on the run page.';
    case 'off':
      return 'The customer wasn’t told: this automation doesn’t reply to customers, so tell them on the run page.';
    case 'resolved':
      return `The customer wasn’t told: the report is ${n.label} in ${n.product}.`;
    case 'refused':
      return `The customer wasn’t told: ${n.product} refused it (${n.text.replace(/[.\s]+$/, '')}), so tell them on the run page.`;
  }
}

export const FIX_WORDS = {
  /** RN-S4 with replies: “Opened [PR #52](…). The customer hears once the fix is live on dev.tracker.com.” */
  opened(link: string, alreadyOpen: boolean, developmentHost: string | null): string {
    const where = alreadyOpen ? `${link} was already open.` : `Opened ${link}.`;
    return developmentHost
      ? `${where} The customer hears once the fix is live on ${developmentHost}.`
      : `${where} The customer hears once it’s merged.`;
  },
  /** RN-S5 with replies: “[PR #52](…) was merged. The customer hears once it’s live on dev.tracker.com.” */
  merged(link: string, developmentHost: string): string {
    return `${link} was merged. The customer hears once it’s live on ${developmentHost}.`;
  },
  /** RN-S5 without replies: “… set Acme Desk #16 to …”. */
  mergedQuiet(link: string, number: number, product: string): string {
    return `${link} was merged. If the customer should hear, set ${product} #${number} to “Fixed, waiting for a release” on the run page.`;
  },
  /**
   * Where the fix went live and what the customer heard: “The fix is live on dev.tracker.com (Acme Desk 0.1.176), so
   * the customer was told and asked to try it.” (`where` is a merge for a production report without development).
   */
  live(
    where: { host: string; version: string | null; product: string } | { merged: string },
    told: 'try' | 'coming' | NotTold,
    ready = false,
  ): string {
    const head =
      'merged' in where
        ? `${where.merged} was merged`
        : ready
          ? `The fix is ready for customers’ computers on ${where.host}${versionOf(where.version, where.product)}`
          : `The fix is live on ${where.host}${versionOf(where.version, where.product)}`;
    if (told === 'try')
      return ready
        ? `${head}, so the customer was told how to get it and asked to try it.`
        : `${head}, so the customer was told and asked to try it.`;
    if (told === 'coming')
      return `${head}, so the customer was told it’s fixed and comes with the next update.`;
    return `${head}. ${notToldText(told)}`;
  },
  closed(link: string, replies: boolean): string {
    return replies
      ? `${link} was closed without merging, so the customer isn’t told it’s fixed.`
      : `${link} was closed without merging.`;
  },
  deviceAgent(link: string, told: 'told' | NotTold): string {
    const head = `${link} changes what reaches customers with a release of its own`;
    return told === 'told'
      ? `${head}, so the customer was told it’s fixed and comes with a coming update.`
      : `${head}. ${notToldText(told)}`;
  },
  stopped(connection: string, number: number): string {
    return `Stopped waiting for the fix of ${connection} #${number} to go live after 90 days: tell the customer on the run page once it is.`;
  },
  /** A fix that went live with another fix of the same report: the customer heard about both in that one's notice. */
  toldWith(
    where: { host: string; version: string | null; product: string },
    other: string,
    ready: boolean,
  ): string {
    const what = ready ? 'ready for customers’ computers' : 'live';
    return `The fix is ${what} on ${where.host}${versionOf(where.version, where.product)}. The customer was told once, with ${other}’s fix.`;
  },
  /** A fix told at its merge that it comes with a release of its own, now in such a release. */
  separateArrived(host: string, version: string | null, product: string): string {
    return `The fix is ready for customers’ computers on ${host}${versionOf(version, product)}. The customer heard at its merge that it comes with an update, so the report was only marked as released.`;
  },
  /** TA-136: “The fix is live on dev.tracker.com (Acme Desk 0.1.176). This reporter's fixes go straight to production, …” */
  releasing(host: string, version: string | null, product: string): string {
    return `The fix is live on ${host}${versionOf(version, product)}. This reporter’s fixes go straight to production, so T3 Code is releasing it now. The customer hears once it’s live there.`;
  },
  /** A chosen reporter's fix live on development while another release of the repository is under way. */
  releaseWaits(host: string, version: string | null, product: string): string {
    return `The fix is live on ${host}${versionOf(version, product)}. Another production release is under way, so T3 Code releases this one once that’s done. The customer hears once it’s live there.`;
  },
  /** A chosen reporter's fix live on development while other reports going straight to production are being fixed. */
  releaseHeld(host: string, version: string | null, product: string, numbers: number[]): string {
    const which =
      numbers.length === 1
        ? `Report #${numbers[0]} also goes straight to production and is`
        : `Reports ${numbers
            .slice(0, -1)
            .map((n) => `#${n}`)
            .join(', ')} and #${numbers.at(-1)} also go straight to production and are`;
    // Two hours: RELEASE_HOLD_MS.
    return `The fix is live on ${host}${versionOf(version, product)}. ${which} still being fixed, so T3 Code releases them together, or this one alone after two hours. The customer hears once it’s live there.`;
  },
  /** A held fix the release for another such report takes along. */
  releaseJoins(number: number): string {
    return `T3 Code is releasing report #${number}’s fix to production now, and this one goes along.`;
  },
  /** A held fix whose release starts: nothing else is being fixed, or the others took too long. */
  releasingAfterHold(late: boolean): string {
    return late
      ? 'The other reports are taking longer than two hours, so T3 Code is releasing this fix to production now. Theirs follow in a later release.'
      : 'No other report that goes straight to production is being fixed now, so T3 Code is releasing this fix.';
  },
  /** The release it waited for is done and production still lacks this fix. */
  releasingAfterWait(): string {
    return 'The other production release is done and production doesn’t have this fix yet, so T3 Code is releasing it now.';
  },
  /** A stopped release goes again for what development runs now. */
  releasingAgain(host: string, version: string | null, product: string): string {
    return `${host} now runs a newer version with the fix${versionOf(version, product)}, so T3 Code is trying the production release again.`;
  },
  /** A stopped release's thread went on after the stop. */
  releaseGoesOn(): string {
    return 'The production release went on in T3 Code after it stopped, so Whombat follows it again.';
  },
  /** The release stopped, and what the customer heard instead. */
  releaseStopped(why: string, told: 'told' | NotTold): string {
    const head = `The production release stopped before production ran the fix: ${why}.`;
    return told === 'told'
      ? `${head} The customer was told it’s fixed and comes with the next update.`
      : `${head} ${notToldText(told)}`;
  },
};

/** The RN-S4 line of a tracker run's pull request (TA-36 when the automation replies at Can, else RN-S4's words). */
export async function openedLine(
  db: Db,
  run: Pick<AutomationRunRow, 'burrowId' | 'automationId' | 'scope'>,
  repo: string,
  link: string,
  alreadyOpen: boolean,
): Promise<string | null> {
  const report = scopeReport(run.scope);
  if (!report) return null;
  if ((await replyKey(db, run.automationId, report.connectionId)) !== 'can') return null;
  const connection = await trackerConnectionRow(db, run.burrowId, report.connectionId);
  if (!connection) return null;
  const development = await developmentConnection(db, connection, repo);
  return FIX_WORDS.opened(link, alreadyOpen, development ? hostOf(development.baseUrl) : null);
}

/* Starting to follow a fix (TA-29) -------------------------------------------------------------------------- */

/** How the fix's notices are signed and in which language: the replying (else assessing) agent's, from its run. */
async function noticeVoice(
  db: Db,
  run: Pick<AutomationRunRow, 'id' | 'burrowId' | 'definition' | 'scope'>,
  connectionId: string,
): Promise<{ signature: string; language: string }> {
  const steps = run.definition.steps;
  const reply = steps.find((s) => s.kind === 'tracker_reply' && s.connectionId === connectionId);
  const fromId =
    reply?.kind === 'tracker_reply'
      ? reply.from
      : steps.find((s) => s.kind === 'dispatch_agent' && s.assessment)?.id;
  const from = steps.find((s) => s.id === fromId);
  // The agent's voice (one-agent.md OA-15): every agent step is its turn.
  const agent = from?.kind === 'dispatch_agent' ? await loadAgentRow(db, run.burrowId) : undefined;
  const [kept] = fromId
    ? await db
        .select({ output: automationRunSteps.output })
        .from(automationRunSteps)
        .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.stepId, fromId)))
    : [];
  const said = reportedAssessment(
    (kept?.output as { assessment?: unknown } | undefined)?.assessment,
  ).language;
  const scope = run.scope as { title?: unknown; description?: unknown };
  const language =
    said ||
    guessLanguage(
      `${typeof scope.title === 'string' ? scope.title : ''} ${typeof scope.description === 'string' ? scope.description : ''}`,
    );
  return {
    signature: agent ? customerSignature(agent.name) : '',
    language,
  };
}

/**
 * Starts following the fix of a run's report (TA-29), inside the commit that settled its pull request step or found a
 * person's pull request: once per report and pull request. Null when the run didn't start from a tracker report.
 */
export async function followFix(
  tx: Db,
  run: AutomationRunRow,
  pr: { repo: string; number: number; url: string | null; stepIdx: number | null; now: Date },
): Promise<string | null> {
  const report = scopeReport(run.scope);
  if (!report) return null;
  const scope = run.scope as { type?: unknown };
  const voice = await noticeVoice(tx, run, report.connectionId);
  const id = fixRowId();
  const [made] = await tx
    .insert(trackerFixes)
    .values({
      id,
      burrowId: run.burrowId,
      connectionId: report.connectionId,
      reportId: report.reportId,
      number: report.number,
      runId: run.id,
      stepIdx: pr.stepIdx,
      automationId: run.automationId,
      repo: pr.repo,
      prNumber: pr.number,
      prUrl: pr.url,
      kind: scope.type === 'feature' ? 'feature' : 'bug',
      language: voice.language,
      signature: voice.signature,
      state: 'open',
      createdAt: pr.now,
      updatedAt: pr.now,
    })
    .onConflictDoNothing()
    .returning({ id: trackerFixes.id });
  return made?.id ?? null;
}

/** The fix rows of a run's pull request (the branch cleanup leaves its merged line to them). */
export async function fixOf(db: Db, runId: string, repo: string, prNumber: number): Promise<FixRow | null> {
  const [row] = await db
    .select()
    .from(trackerFixes)
    .where(
      and(
        eq(trackerFixes.runId, runId),
        sql`lower(${trackerFixes.repo}) = ${repo.toLowerCase()}`,
        eq(trackerFixes.prNumber, prNumber),
      ),
    );
  return row ?? null;
}

/* The command ------------------------------------------------------------------------------------------------ */

/** The most earlier release threads kept for settling (three tries, and a few that couldn't start between them). */
const EARLIER_MAX = 10;

const FixPatch = z
  .object({
    state: z.enum(['open', 'merged', 'development', 'live', 'confirmed', 'reopened', 'closed', 'stopped']),
    mergeSha: z.string().max(64).nullable(),
    mergedAt: z.string().nullable(),
    prUrl: z.string().max(2048).nullable(),
    developmentHost: z.string().max(253).nullable(),
    developmentVersion: z.string().max(100).nullable(),
    developmentAt: z.string().nullable(),
    productionHost: z.string().max(253).nullable(),
    productionVersion: z.string().max(100).nullable(),
    productionAt: z.string().nullable(),
    developmentChecked: z.string().max(64).nullable(),
    productionChecked: z.string().max(64).nullable(),
    developmentRequestId: z.string().max(100).nullable(),
    productionRequestId: z.string().max(100).nullable(),
    note: z.string().max(500).nullable(),
    separate: z.enum(['only', 'also', 'none']).nullable(),
    release: z
      .object({
        t3ConnectionId: z.string().max(100).optional(),
        threadId: z.string().max(500).optional(),
        revision: z.string().max(64),
        startedAt: z.string().max(40),
        stoppedAt: z.string().max(40).optional(),
        why: z.string().max(300).optional(),
        attempt: z.number().int().min(1).max(100).optional(),
        seenItems: z.number().int().min(0).optional(),
        seenAt: z.string().max(40).optional(),
        nudgedAt: z.string().max(40).optional(),
        slowToldAt: z.string().max(40).optional(),
        devChecked: z.string().max(64).optional(),
        stoppedRun: z.string().max(500).optional(),
        revivals: z.number().int().min(0).max(1000).optional(),
        behind: z.string().max(100).optional(),
        held: z.boolean().optional(),
        settledAt: z.string().max(40).optional(),
        earlier: z
          .array(
            z.object({
              t3ConnectionId: z.string().max(100),
              threadId: z.string().max(500),
              from: z.string().max(40),
            }),
          )
          .max(EARLIER_MAX)
          .optional(),
      })
      .nullable(),
  })
  .partial();

const DATES = new Set(['mergedAt', 'developmentAt', 'productionAt']);

/**
 * `tracker.fix_update` (the automation of the run whose thread hears about the fix): moves a fix along — only from the
 * states it expects, so a pass that raced another changes nothing — and posts its line in the run's thread, once. With
 * `mergedNotice` the pull request step is marked as having said its merge (the branch cleanup's RN-S5 line, AR-42). A
 * line without a fix (`fixId` null) is the customer's “It works” on a report Whombat followed no fix for (TA-31). A
 * changed state is signed as `tracker.fix_changed` (ids and the state only).
 */
export const updateFix = defineCommand({
  name: 'tracker.fix_update',
  schema: z.object({
    runId: z.string(),
    fixId: z.string().nullable(),
    from: z.array(
      z.enum(['open', 'merged', 'development', 'live', 'confirmed', 'reopened', 'closed', 'stopped']),
    ),
    set: FixPatch.default({}),
    line: z.string().max(4000).nullable().default(null),
    mergedNotice: z.boolean().default(false),
  }),
  async apply(tx, ctx, input) {
    const run = await loadRunRow(tx, input.runId);
    if (run.burrowId !== ctx.burrow.id) throw notFound('Automation run');
    const [automation] = await tx.select().from(automations).where(eq(automations.id, run.automationId));
    if (!automation || automation.principalId !== ctx.actor.id)
      throw forbidden('Only the automation of the run says how its fix goes.');
    let fix: FixRow | null = null;
    if (input.fixId) {
      const [row] = await tx
        .select()
        .from(trackerFixes)
        .where(eq(trackerFixes.id, input.fixId))
        .for('update');
      if (!row || row.burrowId !== ctx.burrow.id) throw notFound('Fix');
      if (!input.from.includes(row.state)) return { status: 'unchanged' as const, messageId: null };
      fix = row;
      const values: Record<string, unknown> = { updatedAt: ctx.now };
      for (const [k, v] of Object.entries(input.set))
        values[k] = DATES.has(k) && typeof v === 'string' ? new Date(v) : v;
      await tx.update(trackerFixes).set(values).where(eq(trackerFixes.id, row.id));
      if (input.set.state && input.set.state !== row.state)
        await ctx.emit({
          type: 'tracker.fix_changed',
          kind: 'System',
          text: `The fix of report #${row.number} is ${input.set.state} now`,
          where: row.repo,
          payload: {
            fixId: row.id,
            runId: run.id,
            number: row.number,
            repo: row.repo,
            prNumber: row.prNumber,
            from: row.state,
            state: input.set.state,
          },
        });
    }
    const said = input.line ? await postInRunThread(ctx, run, input.line) : null;
    if (input.mergedNotice && fix?.stepIdx !== null && fix?.stepIdx !== undefined) {
      const [step] = await tx
        .select()
        .from(automationRunSteps)
        .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.idx, fix.stepIdx)));
      if (step)
        await tx
          .update(automationRunSteps)
          .set({
            output: { ...(step.output as JsonObject), mergedNotice: true },
            ...(said ? { messageIds: withStepMessages([said]) } : {}),
            updatedAt: ctx.now,
          })
          .where(and(eq(automationRunSteps.runId, run.id), eq(automationRunSteps.idx, step.idx)));
    }
    await publishRun(ctx, run.id);
    return { status: 'ok' as const, messageId: said };
  },
});

/* The pass ---------------------------------------------------------------------------------------------------- */

/** What an installation runs, as last read (at most once a minute). */
interface Health {
  environment: TrackerEnvironment;
  version: string | null;
  /** A clean revision it runs, else null (doesn't count, TA-30). */
  revision: string | null;
  /** What it offers of the part released on its own, when it says. */
  separate: { version: string | null; revision: string | null } | null;
}

/**
 * An installation's health (TA-30, TA-32): read now by its driver unless it was read in the last minute; a failure keeps
 * what was read before (and waits a minute too). Stored on the connection's cursor — the connection page shows it.
 */
export async function healthOf(
  services: Services,
  row: CatalogConnectionRow,
  driver: () => BoundDriver,
  force = false,
): Promise<Health> {
  const db = services.db;
  const now = services.clock();
  await db
    .insert(trackerCursors)
    .values({ connectionId: row.id, burrowId: row.burrowId as string, updatedAt: now })
    .onConflictDoNothing();
  const [cursor] = await db.select().from(trackerCursors).where(eq(trackerCursors.connectionId, row.id));
  const known = (): Health => ({
    environment: trackerEnvironmentOf(cursor?.healthEnvironment ?? null, row.baseUrl),
    version: cursor?.healthVersion ?? null,
    revision: cursor?.healthRevision ?? null,
    separate: cursor?.healthSeparate ?? null,
  });
  if (!force && cursor?.healthCheckedAt && now.getTime() - cursor.healthCheckedAt.getTime() < HEALTH_EVERY_MS)
    return known();
  try {
    const health = await driver().health();
    const version = health.version?.trim().slice(0, 100) || null;
    // Only a revision makes it count; a version alone says nothing about which fixes it has.
    const separate = health.separate?.revision
      ? { version: health.separate.version?.trim().slice(0, 100) || null, revision: health.separate.revision }
      : null;
    await db
      .update(trackerCursors)
      .set({
        healthEnvironment: health.environment,
        healthVersion: version,
        healthRevision: health.revision,
        healthSeparate: separate,
        healthCheckedAt: now,
        updatedAt: now,
      })
      .where(eq(trackerCursors.connectionId, row.id));
    return {
      environment: trackerEnvironmentOf(health.environment, row.baseUrl),
      version,
      revision: health.revision,
      separate,
    };
  } catch (err) {
    services.log.info(
      { connectionId: row.id, err: String(err).slice(0, 200) },
      'tracker: the installation’s health couldn’t be read',
    );
    await db
      .update(trackerCursors)
      .set({ healthCheckedAt: now, updatedAt: now })
      .where(eq(trackerCursors.connectionId, row.id));
    return known();
  }
}

/** One pass's view of a fix's surroundings. */
interface Context {
  services: Services;
  now: Date;
  driverFor: (row: CatalogConnectionRow) => BoundDriver;
}

/** Whether the fix's run merged its pull request itself and said so in its thread (the merge step's line). */
async function runSaidMerge(db: Db, fix: FixRow): Promise<boolean> {
  if (!fix.runId) return false;
  const rows = await db
    .select({ output: automationRunSteps.output, messageIds: automationRunSteps.messageIds })
    .from(automationRunSteps)
    .where(
      and(
        eq(automationRunSteps.runId, fix.runId),
        eq(automationRunSteps.prNumber, fix.prNumber),
        eq(automationRunSteps.state, 'succeeded'),
      ),
    );
  return rows.some(
    (r) => (r.output as { merged?: unknown } | null)?.merged === true && r.messageIds.length > 0,
  );
}

/** Commits a fix's change as its automation. */
async function change(
  c: Context,
  fix: FixRow,
  from: readonly TrackerFixState[],
  set: z.input<typeof FixPatch>,
  line: string | null = null,
  mergedNotice = false,
): Promise<void> {
  const [automation] = fix.automationId
    ? await c.services.db
        .select({ principalId: automations.principalId })
        .from(automations)
        .where(eq(automations.id, fix.automationId))
    : [];
  if (!fix.runId || !automation) {
    // Nobody to say it as (the automation is gone): only where the fix is changes, so it isn't followed forever, and
    // what its release did, so a thread settled isn't settled again.
    if (set.state || set.release !== undefined)
      await c.services.db
        .update(trackerFixes)
        .set({
          ...(set.state ? { state: set.state, note: set.note ?? fix.note } : {}),
          ...(set.release !== undefined ? { release: set.release } : {}),
          updatedAt: c.now,
        })
        .where(and(eq(trackerFixes.id, fix.id), inArray(trackerFixes.state, [...from])));
    return;
  }
  const res = await c.services.pipeline.commit(
    updateFix,
    { runId: fix.runId, fixId: fix.id, from: [...from], set, line, mergedNotice },
    { burrowId: fix.burrowId, actorId: automation.principalId },
  );
  if (res.status !== 'ok') throw new Error(`tracker.fix_update: ${res.status}`);
}

/** Whether the fix's repository is on GitHub (not one kept on this Whombat, repositories.md RP-01). */
async function onGitHub(c: Context, fix: FixRow): Promise<boolean> {
  const [repo] = await c.services.db
    .select({ source: repos.source })
    .from(repos)
    .where(and(eq(repos.burrowId, fix.burrowId), sql`lower(${repos.fullName}) = ${fix.repo.toLowerCase()}`));
  return (repo?.source ?? 'github') === 'github';
}

/** The pull request as the mirror has it, else as GitHub says (a pull request the mirror doesn't have). */
async function pullRequestNow(
  c: Context,
  fix: FixRow,
): Promise<{ state: 'open' | 'merged' | 'closed'; url: string | null; mergedAt: Date | null } | null> {
  const [mirrored] = await c.services.db
    .select({ state: pullRequests.state, url: pullRequests.url, mergedAt: pullRequests.mergedAt })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(pullRequests.burrowId, fix.burrowId),
        sql`lower(${repos.fullName}) = ${fix.repo.toLowerCase()}`,
        eq(pullRequests.number, fix.prNumber),
      ),
    );
  if (mirrored)
    return {
      state: mirrored.state === 'merged' ? 'merged' : mirrored.state === 'closed' ? 'closed' : 'open',
      url: mirrored.url,
      mergedAt: mirrored.mergedAt,
    };
  const adapter = c.services.github.adapter;
  if (!adapter || !(await onGitHub(c, fix))) return null;
  const pr = await githubScope.run({ burrowId: fix.burrowId }, () =>
    adapter.getPullRequest(fix.repo, fix.prNumber),
  );
  return {
    state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
    url: pr.url,
    mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : null,
  };
}

/** Whether the revision an installation runs has the merge commit (TA-30): `ahead` or `identical`; null: unknown. */
async function contains(c: Context, fix: FixRow, revision: string): Promise<boolean | null> {
  const adapter = c.services.github.adapter;
  if (!adapter || !fix.mergeSha || !(await onGitHub(c, fix))) return null;
  const status = await githubScope.run({ burrowId: fix.burrowId }, () =>
    adapter.compareStatus(fix.repo, fix.mergeSha as string, revision),
  );
  if (status === 'ahead' || status === 'identical') return true;
  return status === 'unknown' ? null : false;
}

/** Whether a file of a fix is under one of a driver's paths (`agent/`: `agent` and below). */
function under(file: string, path: string): boolean {
  const p = path.replace(/\/+$/, '');
  return file === p || file.startsWith(`${p}/`);
}

/** Whether a fix changes what its tracker releases on its own. */
export type Separate = 'only' | 'also' | 'none';

/**
 * Whether a fix's files change what the tracker releases on its own (`releasedSeparately`): `only` that — docs and the
 * paths the driver says reach no customer (`reachesNoCustomer`, the repository's own checks) aside —, `also` that and
 * what the tracker itself runs, or `none`.
 */
export function separateOf(
  files: readonly { path: string }[],
  info: { releasedSeparately?: readonly string[]; reachesNoCustomer?: readonly string[] },
): Separate {
  const apart = (path: string) => (info.releasedSeparately ?? []).some((p) => under(path, p));
  const nobody = (path: string) =>
    /\.md$/i.test(path) || (info.reachesNoCustomer ?? []).some((p) => under(path, p));
  if (!files.some((f) => apart(f.path))) return 'none';
  return files.every((f) => apart(f.path) || nobody(f.path)) ? 'only' : 'also';
}

/** The note of a fix told at its merge that it comes with a release of its own, and not followed further (TA-59). */
export const SEPARATE_NOTE = 'It changes what reaches customers with a release of its own.';

/**
 * What a fix needs an installation to run before it counts as there: its source revision, and — where
 * the customer is, for a fix to the part the tracker releases on its own — the revision of that part it offers. Null:
 * it can't be seen there yet (a revision it doesn't say). Elsewhere, and where the tracker doesn't say what it offers of
 * that part, a fix that also changes what the tracker runs counts by the source revision alone.
 */
export function neededRevisions(
  separate: Separate,
  health: Pick<Health, 'revision' | 'separate'>,
  customer: boolean,
): { revision: string | null; separate: string | null } | null {
  const apart = health.separate?.revision ?? null;
  if (!customer || separate === 'none')
    return health.revision ? { revision: health.revision, separate: null } : null;
  if (separate === 'only') return apart ? { revision: null, separate: apart } : null;
  return health.revision ? { revision: health.revision, separate: apart } : null;
}

/** What a stage keeps as checked without the fix (at most 64 characters): the revisions it needed. */
function checkedKey(need: { revision: string | null; separate: string | null }): string {
  if (!need.separate) return need.revision ?? '';
  return need.revision ? `${need.revision.slice(0, 31)}:${need.separate.slice(0, 32)}` : `s:${need.separate}`;
}

/**
 * Whether a fix changes what its tracker releases on its own, as kept on it; a fix merged before that was kept is read
 * from its files on GitHub once (and kept). `none` where that can't be read.
 */
async function separateKind(c: Context, fix: FixRow, connection: CatalogConnectionRow): Promise<Separate> {
  if (fix.separate) return fix.separate;
  const adapter = c.services.github.adapter;
  if (!adapter || !(await onGitHub(c, fix))) return 'none';
  const files = await githubScope.run({ burrowId: fix.burrowId }, () =>
    adapter.listPullRequestFiles(fix.repo, fix.prNumber),
  );
  const separate = separateOf(files, c.driverFor(connection).info);
  await change(c, fix, [fix.state], { separate });
  fix.separate = separate;
  return separate;
}

/**
 * What the fix did for the customer (TA-55): the outcome line (“For the customer (partly fixed): …”) of the last agent
 * reply before the run's pull request step that has one; null for a person's own pull request or a reply without it.
 */
/** What the fix's report's tracker is called, as it was mirrored with the report (else its driver's words). */
async function productOf(c: Context, fix: FixRow, connection: CatalogConnectionRow): Promise<string> {
  const [row] = await c.services.db
    .select({ product: trackerItems.product })
    .from(trackerItems)
    .where(and(eq(trackerItems.connectionId, fix.connectionId), eq(trackerItems.externalId, fix.reportId)));
  return row?.product && row.product !== 'the tracker'
    ? row.product
    : trackerWords(c.services, connection).product;
}

async function fixOutcome(db: Db, fix: FixRow, origin: string): Promise<FixOutcome | null> {
  if (!fix.runId || fix.stepIdx === null) return null;
  // Checked as any reply to the customer is (TA-28): no other organization of the installation named.
  const [report] = await db
    .select({ organization: trackerItems.organization })
    .from(trackerItems)
    .where(and(eq(trackerItems.connectionId, fix.connectionId), eq(trackerItems.externalId, fix.reportId)));
  const organizations = await otherOrganizations(db, fix.connectionId, report?.organization ?? null);
  const rows = await db
    .select({ idx: automationRunSteps.idx, output: automationRunSteps.output })
    .from(automationRunSteps)
    .where(eq(automationRunSteps.runId, fix.runId));
  for (const row of rows.filter((r) => r.idx < (fix.stepIdx as number)).sort((a, b) => b.idx - a.idx)) {
    const reply = (row.output as { reply?: unknown } | null)?.reply;
    const outcome = typeof reply === 'string' ? fixOutcomeOf(reply, { origin, organizations }) : null;
    if (outcome) return outcome;
  }
  return null;
}

/**
 * Tells the customer (TA-30): `trackerFixNotice`'s words in their language, signed, with the status it gives (and
 * the tracker's release record for `available`), under the stage's request id — kept on the fix before it is sent, so a
 * pass that dies halfway sends the same one again and the tracker replays it. Only at Can; a report someone closed (or
 * the customer confirmed) isn't told. Throws when the tracker couldn't be reached (the next pass tries again).
 */
async function notify(
  c: Context,
  fix: FixRow,
  connection: CatalogConnectionRow,
  stage: 'development' | 'production',
  notice: { text: string | null; status: 'available' | 'awaiting_release'; evidence: string | null },
  version: string | null,
): Promise<'told' | NotTold> {
  const key = await replyKey(c.services.db, fix.automationId, fix.connectionId);
  if (key === 'ask') return { why: 'asks' };
  if (key === 'off') return { why: 'off' };
  let requestId = stage === 'development' ? fix.developmentRequestId : fix.productionRequestId;
  if (!requestId) {
    requestId = randomUUID();
    await change(c, fix, [fix.state], {
      [stage === 'development' ? 'developmentRequestId' : 'productionRequestId']: requestId,
    });
  }
  // No text: only the status and the release record (the customer heard the news before).
  const message = notice.text
    ? signedReply(notice.text, fix.signature || customerSignature('Whombat'))
    : undefined;
  try {
    // A report someone closed (or the customer confirmed) isn't told (TA-D24): decided against the report as the
    // tracker has it then. The release record goes with `available` (the tracker's own words for its component).
    const sent = await c.driverFor(connection).send(fix.reportId, {
      requestId,
      ...(message ? { message } : {}),
      status: (now) => (RESOLVED_STATUSES.includes(now) ? { skip: trackerStatusLabel(now) } : notice.status),
      ...(notice.status === 'available' && notice.evidence
        ? { release: { version: version || 'unknown', evidence: notice.evidence } }
        : {}),
    });
    if ('skipped' in sent)
      return { why: 'resolved', label: sent.skipped, product: await productOf(c, fix, connection) };
    return 'told';
  } catch (err) {
    if (err instanceof SourceProblem && err.code === 'refused') await tokenRefused(c.services, connection.id);
    // The report changed under it twice in a row: a busy moment, so the next pass tries again with the same request id.
    if (err instanceof TrackerConflict) throw err;
    if (err instanceof TrackerRefusal || err instanceof TrackerNotFound) {
      const text = err.message.slice(0, 200);
      // Nobody else would tell the customer: the person hears it, once for this stage.
      await tellPerson(
        c,
        fix,
        `${connection.label} #${fix.number}’s customer wasn’t told about the fix: ${trackerWords(c.services, connection).product} refused it (${text.replace(/[.\s]+$/, '')}). It needs you.`,
        `tracker_not_told:${fix.id}:${stage}`,
      );
      return { why: 'refused', text, product: await productOf(c, fix, connection) };
    }
    throw err;
  }
}

/** Since when telling a fix's customer has been failing, by `<fix>:<stage>` (in this process). */
const NOTICE_FAILING_SINCE = new Map<string, number>();
/** How long telling the customer may keep failing before the person hears (once; the passes keep trying). */
const NOTICE_FAILING_MS = 60 * 60_000;

/**
 * `notify`, and when it keeps failing — the tracker erring or unreachable, the report changing under it every pass —
 * for an hour, the person hears once (TA-66's Inbox item), while the next passes keep trying under the same request id.
 */
async function notifyOrTell(
  c: Context,
  fix: FixRow,
  connection: CatalogConnectionRow,
  stage: 'development' | 'production',
  notice: { text: string; status: 'available' | 'awaiting_release'; evidence: string | null },
  version: string | null,
): Promise<'told' | NotTold> {
  const key = `${fix.id}:${stage}`;
  try {
    const told = await notify(c, fix, connection, stage, notice, version);
    NOTICE_FAILING_SINCE.delete(key);
    return told;
  } catch (err) {
    const now = c.now.getTime();
    // A fix that stopped being followed leaves its entry behind: old ones go once there are many.
    if (NOTICE_FAILING_SINCE.size > 500)
      for (const [k, at] of NOTICE_FAILING_SINCE)
        if (now - at > 7 * 86_400_000) NOTICE_FAILING_SINCE.delete(k);
    const since = NOTICE_FAILING_SINCE.get(key) ?? now;
    NOTICE_FAILING_SINCE.set(key, since);
    // An hour of it in this process; for development, also hours after the merge (kept on the fix, so a restart that
    // forgot the hour doesn't keep the person from hearing).
    const late =
      stage === 'development' && !!fix.mergedAt && now - fix.mergedAt.getTime() > NOT_LIVE_AFTER_MS;
    // Late, it still has to fail on two passes: one hiccup a minute before it goes through isn't “keeps failing”.
    if (now - since >= NOTICE_FAILING_MS || (late && since < now))
      await tellPerson(
        c,
        fix,
        `The fix for ${connection.label} #${fix.number} is ready for the customer, but telling them keeps failing in ${await productOf(c, fix, connection)}, so they haven’t heard yet. Whombat keeps trying.`,
        `tracker_not_told:${fix.id}:${stage}`,
      );
    throw err;
  }
}

/** What the customer is told when the fix goes live somewhere, and the thread's words for it. */
function stageWords(
  told: 'told' | NotTold,
  where: { host: string; version: string | null; product: string } | { merged: string },
  reportEnv: TrackerEnvironment,
  live: TrackerEnvironment,
  ready = false,
): string {
  if (told !== 'told') return FIX_WORDS.live(where, told, ready);
  return FIX_WORDS.live(
    where,
    reportEnv === 'production' && live === 'development' ? 'coming' : 'try',
    ready,
  );
}

/** The driver's words for getting the separately released part right away, in the customer's language (null: none). */
function separateNow(c: Context, connection: CatalogConnectionRow, language: string): string | null {
  const words = c.driverFor(connection).info.separateNow ?? {};
  return words[noticeLanguage(language)] ?? null;
}

/** The note a fix keeps when the customer wasn't told (the run page shows it). */
function noteOf(told: 'told' | NotTold): string | null {
  return told === 'told' ? null : notToldText(told);
}

/**
 * How long after one fix of a report told the customer it is live somewhere that another fix of the same report, live
 * there at the same version, counts as told by that notice.
 */
export const ONE_NOTICE_MS = 2 * 60 * 60_000;

/**
 * Another fix of the same report that told the customer about this stage in this pass, or shortly before at the same
 * version (null: none). Several fixes of one report that reach the customer in one release are one piece of news.
 */
async function toldBy(
  c: Context,
  fix: FixRow,
  stage: 'development' | 'production',
  version: string | null,
  ready: (separate: Separate | null) => boolean,
): Promise<FixRow | null> {
  const t = trackerFixes;
  const [at, ver, request] =
    stage === 'development'
      ? [t.developmentAt, t.developmentVersion, t.developmentRequestId]
      : [t.productionAt, t.productionVersion, t.productionRequestId];
  // Without a version only the same pass counts: nothing else says it is the same release.
  const when = version
    ? and(
        eq(ver, version),
        sql`${at} >= ${new Date(c.now.getTime() - ONE_NOTICE_MS).toISOString()}::timestamptz`,
      )
    : eq(at, c.now);
  const rows = await c.services.db
    .select()
    .from(t)
    .where(
      and(
        eq(t.connectionId, fix.connectionId),
        eq(t.reportId, fix.reportId),
        ne(t.id, fix.id),
        // Told: the notice went under its request id, and no note says the customer wasn't told.
        isNotNull(request),
        isNull(t.note),
        when,
      ),
    )
    .orderBy(desc(at))
    .limit(10);
  // A notice that it is live doesn't tell that it is ready for their computers, nor the other way round.
  const mine = ready(fix.separate as Separate | null);
  return rows.find((row) => ready(row.separate as Separate | null) === mine) ?? null;
}

/** When GitHub last couldn't say whether a revision holds a fix (`<fix>:<revision>`): asked again after a while. */
const UNSURE_AT = new Map<string, number>();
const UNSURE_RETRY_MS = 10 * 60_000;

/** How long a merged fix may take to run on development before the person hears (TA-61). */
const NOT_LIVE_AFTER_MS = 6 * 60 * 60_000;
/** The same for a bug fix of a production connection that sends fixes straight to production. */
const NOT_LIVE_STRAIGHT_MS = 90 * 60_000;

/** How long `fix` may take to run on development before the person hears: soon where it goes straight on. */
function notLiveAfter(fix: FixRow, connection: CatalogConnectionRow, reportEnv: TrackerEnvironment): number {
  return reportEnv === 'production' && fix.kind === 'bug' && releaseReporters(connection.fields).length
    ? NOT_LIVE_STRAIGHT_MS
    : NOT_LIVE_AFTER_MS;
}

/**
 * A merged fix development still doesn't run hours later (TA-61): the person's Inbox says so once (its key), pointing at
 * the run's thread, so a broken development deploy doesn't keep a customer waiting unseen.
 */
async function tellNotLive(c: Context, fix: FixRow, host: string): Promise<void> {
  const label =
    (await trackerConnectionRow(c.services.db, fix.burrowId, fix.connectionId))?.label ?? 'the tracker';
  await tellPerson(
    c,
    fix,
    `The fix for ${label} #${fix.number} was merged over an hour ago, but as far as Whombat can see ${host} doesn’t run it yet, so the customer hasn’t heard. It needs you.`,
    `tracker_not_live:${fix.id}`,
  );
}

/** The person's Inbox item about a fix (`needs_you`, once per `dedupKey`), pointing at its run's thread. */
async function tellPerson(c: Context, fix: FixRow, text: string, dedupKey: string): Promise<void> {
  if (!fix.runId) return;
  const db = c.services.db;
  const run = await loadRunRow(db, fix.runId).catch(() => null);
  if (!run?.threadRootId) return;
  const [conversation, message, person, burrow] = await Promise.all([
    loadConversationRow(db, run.conversationId),
    loadMessageRow(db, run.threadRootId),
    thePerson(db, run.burrowId),
    loadBurrowRow(db, run.burrowId),
  ]);
  if (!conversation || !message || !person || !burrow) return;
  const connection = await trackerConnectionRow(db, fix.burrowId, fix.connectionId);
  // Said by the automation, as its own principal.
  const [automation] = await db
    .select({ principalId: automations.principalId })
    .from(automations)
    .where(eq(automations.id, run.automationId));
  await notifyPeople(c.services, [
    {
      burrowId: burrow.id,
      burrowSlug: burrow.slug,
      principalId: person.id,
      kind: 'needs_you',
      actorId: automation?.principalId ?? run.automationId,
      where: connection?.label ?? 'the tracker',
      text,
      link: await linkOfMessage(db, conversation, message.id, message.threadRootId),
      messageId: message.id,
      createdAt: c.now,
      dedupKey,
      group: threadPushGroup(conversation.id, message.threadRootId),
    },
  ]);
}

/**
 * Starts the production release of a chosen reporter's bug fix that development runs now (TA-135, TA-136) and moves the
 * fix on to wait for production, saying so in the run's thread. While another release of the repository is under way,
 * or the chosen reporters' other reports are still being fixed, the fix moves on all the same but its release waits
 * (`releaseBehind`), so one release takes them together. False when it isn't such a fix, or when the release couldn't
 * start: then the person hears why once, the try is kept (tried again later), and the fix goes on as any other (the
 * customer hears it's coming). `again` is a later start: a try after a stopped one, numbered, or the one that waited.
 */
async function releaseStarts(
  c: Context,
  fix: FixRow,
  connection: CatalogConnectionRow,
  reportEnv: TrackerEnvironment,
  host: string,
  health: Health,
  again: { attempt: number; after: 'stop' | 'wait' | 'held' | 'late' } | null = null,
): Promise<boolean> {
  if (!health.revision || (reportEnv !== 'production' && reportEnv !== 'development')) return false;
  const driver = c.driverFor(connection);
  if (!(await releasesStraightAway(driver, connection, fix, reportEnv, !!again))) return false;
  const attempt = again?.attempt ?? 1;
  const earlier = replacedThreads(fix.release, c.now);
  const product = await productOf(c, fix, connection);
  const other = again ? null : await releaseUnderWay(c.services.db, fix);
  // Other chosen reporters' reports still being fixed: one release later takes them all, rather than one each now.
  const pending = again || other ? [] : await reportsBeingFixed(c.services.db, driver, connection, fix);
  if (other || pending.length) {
    const at = c.now.toISOString();
    await change(
      c,
      fix,
      [fix.state],
      {
        state: 'development',
        developmentHost: host,
        developmentVersion: health.version,
        developmentAt: at,
        release: {
          revision: health.revision,
          startedAt: at,
          attempt,
          ...(other ? { behind: other.id } : { held: true }),
          ...earlier,
        },
        note: null,
      },
      other
        ? FIX_WORDS.releaseWaits(host, health.version, product)
        : FIX_WORDS.releaseHeld(host, health.version, product, pending),
    );
    return true;
  }
  let release: TrackerFixRelease;
  try {
    release = await startRelease(c.services, fix, {
      label: connection.label,
      product,
      host,
      version: health.version,
      revision: health.revision,
      separate: fix.separate === 'only' || fix.separate === 'also' ? driver.info.releasedSeparately : null,
    });
  } catch (err) {
    const why = err instanceof ReleaseProblem ? err.message : 'it couldn’t start';
    c.services.log.warn(
      { fixId: fix.id, attempt, err: String(err).slice(0, 300) },
      'tracker: a production release didn’t start',
    );
    const at = c.now.toISOString();
    await change(c, fix, [fix.state], {
      release: {
        revision: health.revision,
        startedAt: at,
        stoppedAt: at,
        why: `it couldn’t start: ${why}`,
        attempt,
        ...earlier,
      },
    });
    await tellPerson(
      c,
      fix,
      `${connection.label} #${fix.number}’s fix is live on ${host}, but its production release couldn’t start: ${why}. Whombat tries again every half hour; if it keeps failing, it needs you.`,
      `tracker_release_start:${fix.id}:${attempt}`,
    );
    return false;
  }
  await change(
    c,
    fix,
    [fix.state],
    {
      state: 'development',
      developmentHost: host,
      developmentVersion: health.version,
      developmentAt: c.now.toISOString(),
      release: { ...release, attempt, ...earlier },
      note: null,
    },
    again?.after === 'wait'
      ? FIX_WORDS.releasingAfterWait()
      : again?.after === 'held' || again?.after === 'late'
        ? FIX_WORDS.releasingAfterHold(again.after === 'late')
        : again
          ? FIX_WORDS.releasingAgain(host, health.version, product)
          : FIX_WORDS.releasing(host, health.version, product),
  );
  return true;
}

/**
 * A chosen reporter's fix whose release waits: for another release of the repository, or for the chosen reporters' other
 * reports still being fixed (`RELEASE_HOLD_MS` at most since it reached development). A release that starts for one of
 * those takes this one along (it releases what development runs, which has this fix). Once no release is under way,
 * nothing else is being fixed or the wait is over, and production still lacks this fix (a pass that finds it there ends
 * the fix first), this fix's release starts for what development runs then.
 */
async function releaseBehind(
  c: Context,
  fix: FixRow,
  connection: CatalogConnectionRow,
  reportEnv: TrackerEnvironment,
): Promise<void> {
  const before = fix.release;
  if (!before?.behind && !before?.held) return;
  const other = await releaseUnderWay(c.services.db, fix);
  if (other) {
    if (!before.behind)
      await change(
        c,
        fix,
        ['development'],
        { release: { ...before, behind: other.id } },
        FIX_WORDS.releaseJoins(other.number),
      );
    return;
  }
  const pending = await reportsBeingFixed(c.services.db, c.driverFor(connection), connection, fix);
  const late = c.now.getTime() - Date.parse(before.startedAt) >= RELEASE_HOLD_MS;
  if (pending.length && !late) return;
  const where = await developmentConnection(c.services.db, connection, fix.repo);
  if (!where) return;
  const health = await healthOf(c.services, where, () => c.driverFor(where));
  if (!health.revision || health.environment !== 'development' || health.revision === before.devChecked)
    return;
  if (!(await holdsFix(c, fix, before, health.revision))) return;
  await releaseStarts(c, fix, connection, reportEnv, hostOf(where.baseUrl), health, {
    attempt: before.attempt ?? 1,
    after: before.behind ? 'wait' : pending.length ? 'late' : 'held',
  });
}

/**
 * Whether a development revision holds the fix: the release's own does; another is asked of GitHub. GitHub not knowing
 * yet is asked again after a while, as for the fix itself; a revision without it is kept on the release (`devChecked`).
 */
async function holdsFix(
  c: Context,
  fix: FixRow,
  release: TrackerFixRelease,
  revision: string,
): Promise<boolean> {
  if (revision === release.revision) return true;
  const unsure = `${fix.id}:${revision}`;
  if (c.now.getTime() - (UNSURE_AT.get(unsure) ?? Number.NEGATIVE_INFINITY) < UNSURE_RETRY_MS) return false;
  const has = await contains(c, fix, revision).catch(() => null);
  if (has === null) {
    UNSURE_AT.set(unsure, c.now.getTime());
    return false;
  }
  UNSURE_AT.delete(unsure);
  if (!has) await change(c, fix, ['development'], { release: { ...release, devChecked: revision } });
  return has;
}

/**
 * The release threads a new try of a fix replaces: those of earlier tries still waiting to be settled, and the last
 * try's own. Each is settled in T3 Code once quiet (`settleReleases`).
 */
function replacedThreads(before: TrackerFixRelease | null, now: Date): Pick<TrackerFixRelease, 'earlier'> {
  const earlier = [...(before?.earlier ?? [])];
  if (before?.t3ConnectionId && before.threadId && !before.settledAt)
    earlier.push({
      t3ConnectionId: before.t3ConnectionId,
      threadId: before.threadId,
      from: now.toISOString(),
    });
  return earlier.length ? { earlier: earlier.slice(-EARLIER_MAX) } : {};
}

/** At most this many fixes have their release threads looked at in one pass. */
const RELEASE_SETTLES_PER_PASS = 20;
/** When a release thread that couldn't be settled yet is looked at again, by fix and thread (this process only). */
const SETTLE_NEXT = new Map<string, number>();

/**
 * Settles the release threads that are over in T3 Code: a live fix's own (production runs it, however it got there),
 * and those of tries a newer one replaced. Each once it is quiet and waits for nothing (`settleReleaseThread`); a
 * thread that stopped while its fix isn't live stays, as the person may need it.
 */
async function settleReleases(c: Context): Promise<void> {
  const rows = await c.services.db
    .select()
    .from(trackerFixes)
    .where(
      or(
        and(
          inArray(trackerFixes.state, ['live', 'confirmed']),
          sql`${trackerFixes.release}->>'threadId' is not null`,
          sql`${trackerFixes.release}->>'settledAt' is null`,
        ),
        sql`jsonb_array_length(coalesce(${trackerFixes.release}->'earlier', '[]'::jsonb)) > 0`,
      ),
    )
    .orderBy(trackerFixes.updatedAt)
    .limit(RELEASE_SETTLES_PER_PASS);
  for (const fix of rows) {
    const release = fix.release;
    if (!release) continue;
    const own =
      (fix.state === 'live' || fix.state === 'confirmed') &&
      release.t3ConnectionId &&
      release.threadId &&
      !release.settledAt
        ? {
            t3ConnectionId: release.t3ConnectionId,
            threadId: release.threadId,
            from: (fix.productionAt ?? fix.updatedAt).toISOString(),
          }
        : null;
    const done = new Set<string>();
    for (const thread of [...(release.earlier ?? []), ...(own ? [own] : [])]) {
      const key = `${fix.id}:${thread.threadId}`;
      if ((SETTLE_NEXT.get(key) ?? 0) > c.now.getTime()) continue;
      const settled = await settleReleaseThread(c.services, thread, c.now);
      if ('later' in settled) {
        SETTLE_NEXT.set(key, settled.later.getTime());
        continue;
      }
      SETTLE_NEXT.delete(key);
      done.add(thread.threadId);
    }
    if (!done.size) continue;
    const earlier = release.earlier?.filter((t) => !done.has(t.threadId));
    await change(c, fix, [fix.state], {
      release: {
        ...release,
        earlier: earlier?.length ? earlier : undefined,
        ...(own && done.has(own.threadId) ? { settledAt: c.now.toISOString() } : {}),
      },
    });
  }
}

/**
 * A started release that production doesn't run yet (TA-138): while it goes, Whombat watches that its thread moves
 * (`watchMovement`); once it stopped, the person hears first, then the customer hears what any
 * production report hears when development runs its fix (it's fixed and comes with the next update), and the run's
 * thread says why it stopped. A pass that couldn't tell the customer tries again; the person isn't told twice.
 */
async function followRelease(
  c: Context,
  fix: FixRow,
  connection: CatalogConnectionRow,
  reportEnv: TrackerEnvironment,
): Promise<void> {
  const release = fix.release;
  if (!release || release.stoppedAt) return;
  const state = await releaseState(c.services, release, c.now);
  const stopped =
    'stopped' in state ? state.stopped : await watchMovement(c, fix, connection, release, state);
  if (!stopped) return;
  const attempt = release.attempt ?? 1;
  // A thread that went on after a stop and stopped again reaches the person again.
  await tellPerson(
    c,
    fix,
    `The production release of ${connection.label} #${fix.number}’s fix stopped: ${stopped}. ${attempt < RELEASE_ATTEMPTS ? 'Whombat tries again later if what stopped it is mended; until then it needs you.' : 'Whombat doesn’t try again: it needs you to release it.'}`,
    `tracker_release:${fix.id}:${attempt}${release.revivals ? `.${release.revivals}` : ''}`,
  );
  const product = await productOf(c, fix, connection);
  const notice = trackerFixNotice({
    report: reportEnv,
    live: 'development',
    kind: fix.kind === 'feature' ? 'feature' : 'bug',
    language: fix.language,
    host: fix.developmentHost ?? hostOf(connection.baseUrl),
    at: c.now,
    outcome: await fixOutcome(c.services.db, fix, connection.baseUrl),
    product,
  });
  const told = await notifyOrTell(c, fix, connection, 'development', notice, fix.developmentVersion);
  await change(
    c,
    fix,
    ['development'],
    {
      release: { ...release, stoppedAt: c.now.toISOString(), why: stopped, stoppedRun: state.run },
      note: noteOf(told),
    },
    FIX_WORDS.releaseStopped(stopped, told),
  );
}

/**
 * A going release's thread, watched for moving: its timeline's length is kept with when it last grew. A thread whose turn
 * ended without “Released:” or “Stopped:” and that hasn't moved for `RELEASE_QUIET_MS` is asked where it stands (T3
 * Code can't say from outside whether a thread between turns still waits for something); the question is counted in,
 * so only the thread's own answer counts as moving. One that was asked and didn't move for `RELEASE_NUDGE_ANSWER_MS`,
 * whatever T3 Code says it is doing, has stopped: the reason is returned. One that hasn't moved for `RELEASE_SLOW_MS`
 * (or couldn't be read or asked for as long), or that production doesn't run `RELEASE_SLOW_TOTAL_MS` after it started,
 * tells the person once and is followed on.
 */
async function watchMovement(
  c: Context,
  fix: FixRow,
  connection: CatalogConnectionRow,
  release: TrackerFixRelease,
  state: { items: number | null; quiet: boolean },
): Promise<string | null> {
  const now = c.now.getTime();
  const still = now - Date.parse(release.seenAt ?? release.startedAt);
  const old = now - Date.parse(release.startedAt) >= RELEASE_SLOW_TOTAL_MS;
  // Told whether or not the thread moves: one that keeps polling something stuck moves all the time.
  if ((still >= RELEASE_SLOW_MS || old) && !release.slowToldAt) {
    await tellPerson(
      c,
      fix,
      old
        ? `The production release of ${connection.label} #${fix.number}’s fix has been going for three hours. Whombat keeps following it; look at its T3 Code thread if that seems wrong.`
        : `The production release of ${connection.label} #${fix.number}’s fix hasn’t moved for an hour and a half. Whombat keeps following it; look at its T3 Code thread if that seems wrong.`,
      `tracker_release_slow:${fix.id}:${release.attempt ?? 1}`,
    );
    release = { ...release, slowToldAt: c.now.toISOString() };
    await change(c, fix, ['development'], { release });
  }
  // T3 Code not answering is no answer: only what it shows decides.
  if (state.items === null) return null;
  if (release.seenItems === undefined || state.items > release.seenItems) {
    await change(c, fix, ['development'], {
      release: { ...release, seenItems: state.items, seenAt: c.now.toISOString(), nudgedAt: undefined },
    });
    return null;
  }
  if (release.nudgedAt)
    return now - Date.parse(release.nudgedAt) >= RELEASE_NUDGE_ANSWER_MS
      ? 'its T3 Code thread was asked where it stands and didn’t answer'
      : null;
  if (state.quiet && still >= RELEASE_QUIET_MS) {
    const asked = await nudgeRelease(c.services, release, state.items);
    if (asked !== null)
      await change(c, fix, ['development'], {
        release: { ...release, seenItems: asked, nudgedAt: c.now.toISOString() },
      });
  }
  return null;
}

/**
 * A chosen reporter's fix whose release stopped or couldn't start. A stopped release whose thread went on after the stop
 * (someone wrote to it) is followed again. Otherwise Whombat starts the release again once the stopped release's thread
 * has ended, no other release of the repository is under way, and development runs a revision with the fix — a newer one
 * (someone mended what stopped it), or the same one `RELEASE_SAME_RETRY_MS` after the stop (mended outside the code: the
 * person decided, a check passes now). At most `RELEASE_ATTEMPTS` releases for one fix; a try that couldn't start (T3
 * Code away) doesn't count and is tried again after `RELEASE_START_RETRY_MS`. Never two releases of one fix at once.
 */
async function releaseAgain(
  c: Context,
  fix: FixRow,
  connection: CatalogConnectionRow,
  reportEnv: TrackerEnvironment,
): Promise<void> {
  const before = fix.release;
  if (!before?.stoppedAt) return;
  const revived = await releaseRevived(c.services, before, c.now);
  if (revived) {
    await change(
      c,
      fix,
      ['development'],
      {
        release: {
          ...before,
          stoppedAt: undefined,
          why: undefined,
          stoppedRun: undefined,
          nudgedAt: undefined,
          seenItems: revived.items,
          seenAt: c.now.toISOString(),
          revivals: (before.revivals ?? 0) + 1,
        },
      },
      FIX_WORDS.releaseGoesOn(),
    );
    return;
  }
  const started = !!before.threadId;
  const attempt = before.attempt ?? 1;
  if (started && attempt >= RELEASE_ATTEMPTS) return;
  const where = await developmentConnection(c.services.db, connection, fix.repo);
  if (!where) return;
  const health = await healthOf(c.services, where, () => c.driverFor(where));
  if (!health.revision || health.environment !== 'development' || health.revision === before.devChecked)
    return;
  // A try that couldn't start goes again after a short while. After a stop, the second try goes at once for a newer
  // revision (someone mended main), else three hours on; the last waits half a day, so unrelated merges reaching
  // development don't use up the tries before the person could act on what stopped it.
  const since = c.now.getTime() - Date.parse(before.stoppedAt);
  const wait = !started
    ? RELEASE_START_RETRY_MS
    : attempt >= 2
      ? RELEASE_LAST_RETRY_MS
      : health.revision !== before.revision
        ? 0
        : RELEASE_SAME_RETRY_MS;
  if (since < wait) return;
  if (!(await holdsFix(c, fix, before, health.revision))) return;
  if (started && !(await releaseEnded(c.services, before))) return;
  if (await releaseUnderWay(c.services.db, fix)) return;
  await releaseStarts(c, fix, connection, reportEnv, hostOf(where.baseUrl), health, {
    attempt: started ? attempt + 1 : attempt,
    after: 'stop',
  });
}

/** One fix, one step further where it can go (TA-29…TA-33). */
async function followOne(c: Context, fix: FixRow): Promise<void> {
  const db = c.services.db;
  const connection = await trackerConnectionRow(db, fix.burrowId, fix.connectionId);
  if (!connection) {
    await change(c, fix, FOLLOWED_STATES, { state: 'stopped', note: 'Its tracker connection is gone.' });
    return;
  }
  const since = fix.mergedAt ?? fix.createdAt;
  if (c.now.getTime() - since.getTime() > FIX_STOP_AFTER_MS) {
    await change(
      c,
      fix,
      FOLLOWED_STATES,
      { state: 'stopped', note: 'It wasn’t live after 90 days.' },
      FIX_WORDS.stopped(connection.label, fix.number),
    );
    return;
  }
  const reportEnv = await connectionEnvironment(db, connection);
  if (fix.state === 'open') {
    const pr = await pullRequestNow(c, fix);
    if (!pr || pr.state === 'open') return;
    const link = prLink(fix.prNumber, pr.url ?? fix.prUrl);
    const key = await replyKey(db, fix.automationId, fix.connectionId);
    if (pr.state === 'closed') {
      await change(
        c,
        fix,
        ['open'],
        { state: 'closed', prUrl: pr.url ?? fix.prUrl },
        FIX_WORDS.closed(link, key === 'can'),
      );
      return;
    }
    // Merged: its merge commit and files from GitHub (TA-30, TA-33); a repository kept on this Whombat has neither, so
    // its fix can't be seen going live (it stops after 90 days).
    const adapter = (await onGitHub(c, fix)) ? c.services.github.adapter : null;
    let mergeSha: string | null = null;
    let mergedAt = pr.mergedAt;
    let separate: Separate | null = null;
    let deviceAgent = false;
    if (adapter) {
      try {
        const gh = await githubScope.run({ burrowId: fix.burrowId }, () =>
          adapter.getPullRequest(fix.repo, fix.prNumber),
        );
        mergeSha = gh.mergeCommitSha;
        mergedAt = mergedAt ?? (gh.mergedAt ? new Date(gh.mergedAt) : null);
        const files = await githubScope.run({ burrowId: fix.burrowId }, () =>
          adapter.listPullRequestFiles(fix.repo, fix.prNumber),
        );
        // A change to only what reaches customers with a release of its own (the driver's `releasedSeparately`, a
        // device agent) is seen going live only where the tracker says what it offers of that part; elsewhere
        // it is told at its merge and followed no further (TA-59). One that also changes what the tracker itself runs
        // is followed like any fix.
        separate = separateOf(files, c.driverFor(connection).info);
        deviceAgent =
          separate === 'only' &&
          !(await healthOf(c.services, connection, () => c.driverFor(connection))).separate?.revision;
      } catch (err) {
        // GitHub keeps erring about a pull request the mirror says merged a while ago: the person hears, as for a fix not
        // live on development (TA-61, the same item), and the next pass tries again.
        const since = pr.mergedAt ?? fix.createdAt;
        if (c.now.getTime() - since.getTime() > notLiveAfter(fix, connection, reportEnv))
          await tellPerson(
            c,
            fix,
            `The fix for ${connection.label} #${fix.number} was merged over an hour ago, but GitHub keeps not answering about it, so the customer hasn’t heard. It needs you.`,
            `tracker_not_live:${fix.id}`,
          );
        throw err;
      }
    }
    const merged = {
      mergeSha,
      mergedAt: (mergedAt ?? c.now).toISOString(),
      prUrl: pr.url ?? fix.prUrl,
      ...(separate ? { separate } : {}),
    };
    if (deviceAgent) {
      // A chosen reporter's fix goes straight to production, but Whombat doesn't follow a release of its own: the
      // person hears first (before the customer's notice and the fix's end, so neither can lose it) and it doesn't wait
      // unseen for whenever that release comes.
      if (await releasesStraightAway(c.driverFor(connection), connection, fix, reportEnv))
        await tellPerson(
          c,
          fix,
          `${connection.label} #${fix.number}’s fix changes only what reaches customers with a release of its own, so Whombat starts no production release for it. It needs you to release it.`,
          `tracker_release_apart:${fix.id}`,
        );
      // It reaches computers with the agent's own release, which Whombat doesn't follow: the customer hears once that
      // it's fixed and comes with a coming update (TA-59).
      const fresh = { ...fix, ...merged, mergedAt: new Date(merged.mergedAt) };
      const notice = trackerAgentFixNotice({
        kind: fix.kind === 'feature' ? 'feature' : 'bug',
        language: fix.language,
        outcome: await fixOutcome(db, fix, connection.baseUrl),
        product: await productOf(c, fix, connection),
      });
      const told = await notifyOrTell(c, fresh, connection, 'development', notice, null);
      await change(
        c,
        fix,
        ['open'],
        {
          ...merged,
          state: 'stopped',
          note: told === 'told' ? SEPARATE_NOTE : noteOf(told),
        },
        FIX_WORDS.deviceAgent(link, told),
        true,
      );
      return;
    }
    const development = await developmentConnection(db, connection, fix.repo);
    if (!development && key !== 'can') {
      // A production report without a development tracker, and nobody tells the customer: RN-S5's words (TA-36).
      await change(
        c,
        fix,
        ['open'],
        {
          ...merged,
          state: 'development',
          note: noteOf(key === 'ask' ? { why: 'asks' } : { why: 'off' }),
        },
        FIX_WORDS.mergedQuiet(link, fix.number, await productOf(c, fix, connection)),
        true,
      );
      return;
    }
    if (!development) {
      // A production report without a development tracker: the merge counts as “fixed in development” (TA-32).
      const notice = trackerFixNotice({
        report: reportEnv,
        live: 'development',
        kind: fix.kind === 'feature' ? 'feature' : 'bug',
        language: fix.language,
        host: hostOf(connection.baseUrl),
        at: c.now,
        outcome: await fixOutcome(db, fix, connection.baseUrl),
        product: await productOf(c, fix, connection),
      });
      const fresh = { ...fix, ...merged, mergedAt: new Date(merged.mergedAt) };
      const told = await notifyOrTell(c, fresh, connection, 'development', notice, null);
      await change(
        c,
        fix,
        ['open'],
        { ...merged, state: 'development', note: noteOf(told) },
        stageWords(told, { merged: link }, reportEnv, 'development'),
        true,
      );
      return;
    }
    // The run's own merge step said “Merged PR #10 into main.”, and its pull request step that the customer hears once
    // it's live: a third line would only say that again.
    const line =
      key !== 'can'
        ? FIX_WORDS.mergedQuiet(link, fix.number, await productOf(c, fix, connection))
        : (await runSaidMerge(db, fix))
          ? null
          : FIX_WORDS.merged(link, hostOf(development.baseUrl));
    await change(c, fix, ['open'], { ...merged, state: 'merged' }, line, true);
    return;
  }
  if (fix.state === 'merged' || fix.state === 'development') {
    const stage = fix.state === 'merged' ? 'development' : 'production';
    const where =
      stage === 'development' ? await developmentConnection(db, connection, fix.repo) : connection;
    if (!where) return;
    // Development deploys a merged fix by itself (TA-35): hours later still without it, once what development runs
    // was looked at, the person hears once (TA-61).
    const stale =
      stage === 'development' &&
      !!fix.mergedAt &&
      c.now.getTime() - fix.mergedAt.getTime() > notLiveAfter(fix, connection, reportEnv);
    const notLive = async () => {
      if (stale) await tellNotLive(c, fix, hostOf(where.baseUrl));
      // Production doesn't run it yet: a release that waits for another may start, one Whombat started may have
      // stopped, or one that stopped may go on or go again.
      if (stage === 'production' && fix.release)
        await (fix.release.behind || fix.release.held
          ? releaseBehind
          : fix.release.stoppedAt
            ? releaseAgain
            : followRelease)(c, fix, connection, reportEnv);
    };
    const health = await healthOf(c.services, where, () => c.driverFor(where));
    const live = stage === 'development' ? health.environment : reportEnv;
    // Where the customer is: the last stage, after which the fix isn't followed any more.
    const final = reportEnv === 'development' || stage === 'production' || live === 'production';
    // There, a fix to what the tracker releases on its own counts once the tracker offers it. Development's
    // own such release isn't made for every merge: the source revision says the fix is on its way there.
    const separate =
      final && health.separate?.revision
        ? await separateKind(c, fix, connection)
        : ((fix.separate as Separate | null) ?? 'none');
    const need = neededRevisions(separate, health, final);
    if (!need) return notLive();
    const key = checkedKey(need);
    const checked = stage === 'development' ? fix.developmentChecked : fix.productionChecked;
    if (checked === key) return notLive();
    // GitHub not knowing yet is asked again (every ten minutes), never kept as “not in it” (TA-61).
    const unsure = `${fix.id}:${key}`;
    if (c.now.getTime() - (UNSURE_AT.get(unsure) ?? Number.NEGATIVE_INFINITY) < UNSURE_RETRY_MS)
      return notLive();
    // GitHub erring is as unsure as GitHub not knowing: asked again later, and the 6-hour net still holds.
    const holds: (boolean | null)[] = [];
    for (const revision of [need.revision, need.separate])
      if (revision)
        holds.push(
          await contains(c, fix, revision).catch((err: unknown) => {
            c.services.log.warn(
              { fixId: fix.id, err: String(err).slice(0, 200) },
              'tracker: GitHub couldn’t say whether a revision holds a fix',
            );
            return null;
          }),
        );
    const has = holds.includes(false) ? false : holds.includes(null) ? null : true;
    if (has === null) {
      UNSURE_AT.set(unsure, c.now.getTime());
      return notLive();
    }
    UNSURE_AT.delete(unsure);
    if (has !== true) {
      // Not there yet: looked at again once the installation runs (or offers) another.
      await change(c, fix, [fix.state], {
        [stage === 'development' ? 'developmentChecked' : 'productionChecked']: key,
      });
      return notLive();
    }
    const host = hostOf(where.baseUrl);
    // Ready for the customer's computers: the notice says so, with the tracker's words for getting it right away.
    const ready = !!need.separate;
    // A chosen reporter's bug fix on development goes straight to production (TA-135): the release starts, and the
    // customer hears once production runs it instead of “comes with the next update” now.
    if (
      stage === 'development' &&
      live === 'development' &&
      (await releaseStarts(c, fix, connection, reportEnv, host, health))
    )
      return;
    const at = c.now.toISOString();
    // Another fix of the report told the customer about this release already: this one went with it.
    const sibling = await toldBy(
      c,
      fix,
      stage,
      health.version,
      (s) => final && !!health.separate?.revision && (s === 'only' || s === 'also'),
    );
    if (sibling) {
      await change(
        c,
        fix,
        [fix.state],
        {
          state: final ? 'live' : 'development',
          ...(stage === 'development'
            ? {
                developmentHost: host,
                developmentVersion: health.version,
                developmentAt: at,
                developmentRequestId: sibling.developmentRequestId,
              }
            : {
                productionHost: host,
                productionVersion: health.version,
                productionAt: at,
                productionRequestId: sibling.productionRequestId,
              }),
          note: null,
        },
        FIX_WORDS.toldWith(
          { host, version: health.version, product: await productOf(c, fix, connection) },
          prLink(sibling.prNumber, sibling.prUrl),
          ready,
        ),
      );
      return;
    }
    const notice = trackerFixNotice({
      report: reportEnv,
      live,
      kind: fix.kind === 'feature' ? 'feature' : 'bug',
      language: fix.language,
      host,
      at: c.now,
      outcome: await fixOutcome(db, fix, connection.baseUrl),
      product: await productOf(c, fix, connection),
      separate: ready ? { how: separateNow(c, connection, fix.language) } : null,
    });
    const told = await notifyOrTell(c, fix, connection, stage, notice, health.version);
    await change(
      c,
      fix,
      [fix.state],
      {
        state: final ? 'live' : 'development',
        ...(stage === 'development'
          ? { developmentHost: host, developmentVersion: health.version, developmentAt: at }
          : { productionHost: host, productionVersion: health.version, productionAt: at }),
        note: noteOf(told),
      },
      stageWords(
        told,
        { host, version: health.version, product: await productOf(c, fix, connection) },
        reportEnv,
        live,
        ready,
      ),
    );
  }
}

/**
 * A fix told at its merge that it comes with a release of its own and not followed since (TA-59), once its report's
 * tracker says what it offers of that part: when that has the fix, the report is marked released (the status
 * and the tracker's release record) without a message — the customer heard long ago it comes with an update — and the
 * fix is live. Looked at again only once the tracker offers another revision.
 */
async function reviveSeparate(c: Context, fix: FixRow): Promise<void> {
  const db = c.services.db;
  const connection = await trackerConnectionRow(db, fix.burrowId, fix.connectionId);
  if (!connection || !fix.mergeSha) return;
  const health = await healthOf(c.services, connection, () => c.driverFor(connection));
  const apart = health.separate?.revision;
  if (!apart) return;
  const reportEnv = await connectionEnvironment(db, connection);
  const key = checkedKey({ revision: null, separate: apart });
  const field = reportEnv === 'production' ? 'productionChecked' : 'developmentChecked';
  if (fix[field] === key) return;
  const unsure = `${fix.id}:${key}`;
  if (c.now.getTime() - (UNSURE_AT.get(unsure) ?? Number.NEGATIVE_INFINITY) < UNSURE_RETRY_MS) return;
  const has = await contains(c, fix, apart).catch(() => null);
  if (has === null) {
    UNSURE_AT.set(unsure, c.now.getTime());
    return;
  }
  UNSURE_AT.delete(unsure);
  if (!has) {
    await change(c, fix, ['stopped'], { [field]: key });
    return;
  }
  const host = hostOf(connection.baseUrl);
  const product = await productOf(c, fix, connection);
  const { evidence } = trackerFixNotice({
    report: reportEnv,
    live: reportEnv,
    kind: fix.kind === 'feature' ? 'feature' : 'bug',
    language: fix.language,
    host,
    at: c.now,
    product,
    separate: { how: null },
  });
  // The merge's notice went under the development request id: this one is the fix's last.
  await notify(
    c,
    fix,
    connection,
    'production',
    { text: null, status: 'available', evidence },
    health.version,
  );
  const at = c.now.toISOString();
  await change(
    c,
    fix,
    ['stopped'],
    {
      state: 'live',
      separate: 'only',
      ...(reportEnv === 'production'
        ? { productionHost: host, productionVersion: health.version, productionAt: at }
        : { developmentHost: host, developmentVersion: health.version, developmentAt: at }),
      note: null,
    },
    FIX_WORDS.separateArrived(host, health.version, product),
  );
}

/** The fixes `reviveSeparate` looks at: told at their merge, within the 90 days a fix is followed. */
async function separateStopped(c: Context): Promise<FixRow[]> {
  return c.services.db
    .select()
    .from(trackerFixes)
    .where(
      and(
        eq(trackerFixes.state, 'stopped'),
        eq(trackerFixes.note, SEPARATE_NOTE),
        isNotNull(trackerFixes.mergeSha),
        sql`${trackerFixes.mergedAt} > ${new Date(c.now.getTime() - FIX_STOP_AFTER_MS).toISOString()}::timestamptz`,
      ),
    )
    .orderBy(trackerFixes.updatedAt)
    .limit(FIX_BATCH);
}

/** The marker a tracker fix's pull request names its report by (`TRACKER_PR_MARKER` rendered). */
const MARKER_RE = /<!--\s*whombat-tracker:([A-Za-z0-9_-]{1,100}):(\d{1,12})\s*-->/g;

/** A `like` pattern of a literal: its `%`, `_` and `\` taken as themselves. */
function likeLiteral(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * The reports a merged pull request's description names: by Whombat's marker (a connection and a number), or by a line
 * a tracker's driver reads (`prMatch`: the tracker's host and a number), on the burrow's tracker connections.
 */
async function namedReports(
  c: Context,
  burrowId: string,
  body: string,
): Promise<{ connection: CatalogConnectionRow; number: number }[]> {
  const connections = await c.services.db
    .select()
    .from(catalogConnections)
    .where(
      and(eq(catalogConnections.burrowId, burrowId), eq(catalogConnections.catalogId, TRACKER_CATALOG_ID)),
    );
  const out: { connection: CatalogConnectionRow; number: number }[] = [];
  const add = (connection: CatalogConnectionRow | undefined, number: number) => {
    if (!connection || !Number.isSafeInteger(number) || number < 1) return;
    if (!out.some((o) => o.connection.id === connection.id && o.number === number))
      out.push({ connection, number });
  };
  for (const m of body.matchAll(MARKER_RE))
    add(
      connections.find((x) => x.id === m[1]),
      Number(m[2]),
    );
  for (const driver of c.services.tracker.drivers.list()) {
    if (!driver.prMatch) continue;
    let named: { host: string; number: number }[] = [];
    try {
      named = driver.prMatch(body);
    } catch {
      continue;
    }
    for (const n of Array.isArray(named) ? named : [])
      add(
        connections.find(
          (x) =>
            driverIdOf(x) === driver.info.id && hostOf(x.baseUrl) === String(n?.host ?? '').toLowerCase(),
        ),
        Number(n?.number),
      );
  }
  return out;
}

/**
 * People's own fixes (TA-29, best effort): a merged pull request of the last week, in the mirror, whose description
 * names a report of one of the burrow's tracker connections an automation ran for (Whombat's marker, or the tracker's
 * own line its driver reads), and that no fix follows yet. Followed from the latest such run (its thread hears about it).
 */
async function findPeoplesFixes(c: Context): Promise<number> {
  const db = c.services.db;
  const since = new Date(c.now.getTime() - PEOPLE_PR_WINDOW_MS);
  // A cheap filter first: the marker, or a driver's literal prefix of its own line.
  const prefixes = [
    '<!-- whombat-tracker:',
    ...c.services.tracker.drivers
      .list()
      .map((d) => d.info.prPrefix)
      .filter((p): p is string => !!p),
  ];
  const prs = await db
    .select({
      burrowId: pullRequests.burrowId,
      repo: repos.fullName,
      number: pullRequests.number,
      url: pullRequests.url,
      body: pullRequests.body,
    })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(pullRequests.state, 'merged'),
        sql`${pullRequests.mergedAt} > ${since.toISOString()}::timestamptz`,
        or(...prefixes.map((p) => sql`${pullRequests.body} like ${likeLiteral(p)}`)),
        sql`not exists (select 1 from ${trackerFixes} f where f.burrow_id = ${pullRequests.burrowId}
          and lower(f.repo) = lower(${repos.fullName}) and f.pr_number = ${pullRequests.number})`,
      ),
    )
    .orderBy(desc(pullRequests.mergedAt))
    .limit(PEOPLE_BATCH);
  let found = 0;
  for (const pr of prs) found += await followNamed(c, pr.burrowId, pr);
  return found;
}

/**
 * A merged pull request whose description names reports an automation ran for (`namedReports`): followed from each
 * report's latest run, as a person's fix (TA-29). Answers how many fixes it started following.
 */
async function followNamed(
  c: Context,
  burrowId: string,
  pr: { repo: string; number: number; url: string | null; body: string | null },
): Promise<number> {
  const db = c.services.db;
  let found = 0;
  for (const { connection, number } of await namedReports(c, burrowId, pr.body ?? '')) {
    const [run] = await db
      .select()
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.burrowId, burrowId),
          eq(automationRuns.itemKey, trackerItemKey(connection.id, number)),
          eq(automationRuns.test, false),
          // A run skipped at a limit has no thread to follow a fix in.
          ne(automationRuns.status, 'skipped'),
        ),
      )
      .orderBy(desc(automationRuns.createdAt))
      .limit(1);
    if (!run) continue;
    const [report] = await db
      .select({ id: trackerItems.id })
      .from(trackerItems)
      .where(and(eq(trackerItems.connectionId, connection.id), eq(trackerItems.number, number)));
    if (!report) continue;
    const [automation] = await db
      .select({ principalId: automations.principalId })
      .from(automations)
      .where(eq(automations.id, run.automationId));
    if (!automation) continue;
    const res = await c.services.pipeline.commit(
      foundFix,
      { runId: run.id, repo: pr.repo, number: pr.number, url: pr.url },
      { burrowId, actorId: automation.principalId },
    );
    if (res.status === 'ok' && res.result.fixId) found++;
  }
  return found;
}

/** How often a repository's latest closed pull requests are read for fixes the mirror never saw, at most. */
export const CLOSED_EVERY_MS = 60_000;
/** Each repository's last read of its closed pull requests, by `<burrow>:<repo>` (in this process): ETag and when. */
const CLOSED_READ = new Map<string, { etag: string | null; at: number }>();

/**
 * Report fixes merged between two reads of the open pull requests: the mirror reads only open pull requests, so
 * one opened and merged in between never reaches it. The repositories that report automations fix in have their latest
 * closed pull requests read once a minute at most (with an ETag: an unchanged list costs GitHub nothing). A pull request
 * merged in the last week that the mirror doesn't have and no fix follows yet is followed from its report's run when its
 * description names the report (`followNamed`) or it comes from a report run's branch — then like any fix: GitHub says
 * it is merged, its files and its merge commit.
 */
async function findMissedFixes(c: Context): Promise<number> {
  const adapter = c.services.github.adapter;
  if (!adapter) return 0;
  const db = c.services.db;
  const live = await db
    .select({ burrowId: automations.burrowId, definition: automationVersions.definition })
    .from(automations)
    .innerJoin(
      automationVersions,
      and(
        eq(automationVersions.automationId, automations.id),
        eq(automationVersions.n, automations.currentVersion),
      ),
    )
    .where(and(eq(automations.status, 'published'), isNull(automations.deletedAt)));
  const targets = new Map<string, { burrowId: string; repo: string }>();
  for (const { burrowId, definition } of live) {
    if (!definition.triggers.some((t) => t.kind === 'tracker')) continue;
    for (const repo of definitionRepos(definition)) targets.set(`${burrowId}:${repo}`, { burrowId, repo });
  }
  let found = 0;
  const now = c.now.getTime();
  for (const [key, t] of targets) {
    const last = CLOSED_READ.get(key);
    if (last && now - last.at < CLOSED_EVERY_MS) continue;
    const [repo] = await db
      .select({ fullName: repos.fullName, source: repos.source })
      .from(repos)
      .where(and(eq(repos.burrowId, t.burrowId), sql`lower(${repos.fullName}) = ${t.repo}`));
    // Only a repository the burrow has on GitHub is mirrored, so only there can one be missed.
    if (!repo || (repo.source ?? 'github') !== 'github') continue;
    CLOSED_READ.set(key, { etag: last?.etag ?? null, at: now });
    const res = await githubScope.run({ burrowId: t.burrowId }, () =>
      adapter.closedPullRequests(repo.fullName, last?.etag ?? null),
    );
    if (!res.modified) continue;
    CLOSED_READ.set(key, { etag: res.etag, at: now });
    const merged = res.data.filter(
      (pr) => pr.merged && pr.mergedAt && now - Date.parse(pr.mergedAt) < PEOPLE_PR_WINDOW_MS,
    );
    if (!merged.length) continue;
    const numbers = merged.map((pr) => pr.number);
    const known = new Set(
      [
        ...(await db
          .select({ number: pullRequests.number })
          .from(pullRequests)
          .innerJoin(repos, eq(repos.id, pullRequests.repoId))
          .where(
            and(
              eq(pullRequests.burrowId, t.burrowId),
              sql`lower(${repos.fullName}) = ${t.repo}`,
              inArray(pullRequests.number, numbers),
            ),
          )),
        ...(await db
          .select({ number: trackerFixes.prNumber })
          .from(trackerFixes)
          .where(
            and(
              eq(trackerFixes.burrowId, t.burrowId),
              sql`lower(${trackerFixes.repo}) = ${t.repo}`,
              inArray(trackerFixes.prNumber, numbers),
            ),
          )),
      ].map((r) => r.number),
    );
    for (const pr of merged) {
      if (known.has(pr.number)) continue;
      const named = await followNamed(c, t.burrowId, {
        repo: repo.fullName,
        number: pr.number,
        url: pr.url,
        body: pr.body,
      });
      found += named || (await followRunBranch(c, t.burrowId, repo.fullName, pr));
    }
  }
  return found;
}

/** A merged pull request from a report run's branch (`feat/<the report's ref>`): followed from the latest such run. */
async function followRunBranch(
  c: Context,
  burrowId: string,
  repo: string,
  pr: { number: number; url: string; headRef: string; fork: string | null },
): Promise<number> {
  if (pr.fork) return 0;
  const [row] = await c.services.db
    .select({ runId: automationRuns.id, principalId: automations.principalId })
    .from(automationRunSteps)
    .innerJoin(automationRuns, eq(automationRuns.id, automationRunSteps.runId))
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(
      and(
        eq(automationRuns.burrowId, burrowId),
        eq(automationRunSteps.kind, 'open_pull_request'),
        sql`${automationRunSteps.output}->>'branch' = ${pr.headRef}`,
        sql`${automationRuns.itemKey} like 'tracker:%'`,
        eq(automationRuns.test, false),
        ne(automationRuns.status, 'skipped'),
      ),
    )
    .orderBy(desc(automationRuns.createdAt))
    .limit(1);
  if (!row) return 0;
  const res = await c.services.pipeline.commit(
    foundFix,
    { runId: row.runId, repo, number: pr.number, url: pr.url },
    { burrowId, actorId: row.principalId },
  );
  return res.status === 'ok' && res.result.fixId ? 1 : 0;
}

/**
 * A report run's own pull request finished outside the run: merged in the last week from the branch the run's pull
 * request step opens, by a person or an agent after the step stopped (a restart, a failure), without a line that names
 * the report. Followed from that run, as a person's fix. The branch (`feat/<the report's ref>`) names one report.
 */
async function findRunBranchFixes(c: Context): Promise<number> {
  const db = c.services.db;
  const since = new Date(c.now.getTime() - PEOPLE_PR_WINDOW_MS);
  const rows = await db
    .select({
      runId: automationRuns.id,
      burrowId: automationRuns.burrowId,
      principalId: automations.principalId,
      repo: repos.fullName,
      number: pullRequests.number,
      url: pullRequests.url,
    })
    .from(automationRunSteps)
    .innerJoin(automationRuns, eq(automationRuns.id, automationRunSteps.runId))
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .innerJoin(
      pullRequests,
      and(
        eq(pullRequests.burrowId, automationRuns.burrowId),
        sql`${pullRequests.branch} = ${automationRunSteps.output}->>'branch'`,
      ),
    )
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(automationRunSteps.kind, 'open_pull_request'),
        sql`${automationRuns.itemKey} like 'tracker:%'`,
        eq(automationRuns.test, false),
        ne(automationRuns.status, 'skipped'),
        eq(pullRequests.state, 'merged'),
        sql`${pullRequests.mergedAt} > ${since.toISOString()}::timestamptz`,
        sql`not exists (select 1 from ${trackerFixes} f where f.burrow_id = ${pullRequests.burrowId}
          and lower(f.repo) = lower(${repos.fullName}) and f.pr_number = ${pullRequests.number})`,
      ),
    )
    .orderBy(desc(automationRuns.createdAt))
    .limit(PEOPLE_BATCH);
  const seen = new Set<string>();
  let found = 0;
  for (const row of rows) {
    // The latest run of the report follows it, as for a person's fix.
    const key = `${row.burrowId}:${row.repo.toLowerCase()}#${row.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const res = await c.services.pipeline.commit(
      foundFix,
      { runId: row.runId, repo: row.repo, number: row.number, url: row.url },
      { burrowId: row.burrowId, actorId: row.principalId },
    );
    if (res.status === 'ok' && res.result.fixId) found++;
  }
  return found;
}

/** `tracker.fix_found` (the automation of the report's latest run): a person's merged fix is followed from now (TA-29). */
export const foundFix = defineCommand({
  name: 'tracker.fix_found',
  schema: z.object({
    runId: z.string(),
    repo: z.string().max(255),
    number: z.number().int().positive(),
    url: z.string().max(2048).nullable(),
  }),
  async apply(tx, ctx, input) {
    const run = await loadRunRow(tx, input.runId);
    if (run.burrowId !== ctx.burrow.id) throw notFound('Automation run');
    const [automation] = await tx.select().from(automations).where(eq(automations.id, run.automationId));
    if (!automation || automation.principalId !== ctx.actor.id)
      throw forbidden('Only the automation of the run follows its report’s fix.');
    const fixId = await followFix(tx, run, {
      repo: input.repo,
      number: input.number,
      url: input.url,
      stepIdx: null,
      now: ctx.now,
    });
    return { fixId };
  },
});

/**
 * One pass over the fixes Whombat follows (TA-29…TA-33): people's new fixes first, then each followed fix one step
 * further. A fix that couldn't be moved (the tracker or GitHub didn't answer) is tried again next pass.
 */
export async function followFixes(
  services: Services,
  driverFor: (row: CatalogConnectionRow) => BoundDriver,
): Promise<number> {
  const c: Context = { services, now: services.clock(), driverFor };
  let moved = 0;
  try {
    moved += await findPeoplesFixes(c);
    moved += await findRunBranchFixes(c);
  } catch (err) {
    services.log.warn({ err: String(err).slice(0, 300) }, 'tracker: looking for people’s fixes failed');
  }
  try {
    moved += await findMissedFixes(c);
  } catch (err) {
    services.log.warn(
      { err: String(err).slice(0, 300) },
      'tracker: looking for fixes merged between two reads of GitHub failed',
    );
  }
  const rows = await services.db
    .select()
    .from(trackerFixes)
    .where(inArray(trackerFixes.state, [...FOLLOWED_STATES]))
    .orderBy(trackerFixes.updatedAt)
    .limit(FIX_BATCH);
  for (const fix of rows) {
    try {
      await followOne(c, fix);
      moved++;
    } catch (err) {
      services.log.warn(
        { fixId: fix.id, err: String(err).slice(0, 300) },
        'tracker: following a fix failed; trying again later',
      );
    }
  }
  try {
    await settleReleases(c);
  } catch (err) {
    services.log.warn(
      { err: String(err).slice(0, 300) },
      'tracker: settling release threads that are over failed; trying again later',
    );
  }
  for (const fix of await separateStopped(c)) {
    try {
      await reviveSeparate(c, fix);
    } catch (err) {
      services.log.warn(
        { fixId: fix.id, err: String(err).slice(0, 300) },
        'tracker: looking whether a fix released on its own is out failed; trying again later',
      );
    }
  }
  return moved;
}

/**
 * The customer's answer about a fix (TA-31), as the report's automation: “It works” confirms the report's latest fix
 * and says so in the thread (“The customer says the fix works.”), even without one; “Still happening” reopens it.
 */
export async function customerSaid(
  services: Services,
  report: { connectionId: string; reportId: string; number: number; burrowId: string },
  event: 'confirmed' | 'reopened',
): Promise<void> {
  const db = services.db;
  const [run] = await db
    .select()
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.burrowId, report.burrowId),
        eq(automationRuns.itemKey, trackerItemKey(report.connectionId, report.number)),
        eq(automationRuns.test, false),
        ne(automationRuns.status, 'skipped'),
      ),
    )
    .orderBy(desc(automationRuns.createdAt))
    .limit(1);
  const [fix] = await db
    .select()
    .from(trackerFixes)
    .where(
      and(eq(trackerFixes.connectionId, report.connectionId), eq(trackerFixes.reportId, report.reportId)),
    )
    .orderBy(desc(trackerFixes.createdAt))
    .limit(1);
  const runId = fix?.runId ?? run?.id;
  const automationId = fix?.automationId ?? run?.automationId;
  if (!runId || !automationId) return;
  const moving: TrackerFixState[] = ['merged', 'development', 'live', 'confirmed', 'reopened'];
  const fixId = fix && moving.includes(fix.state) ? fix.id : null;
  // “Still happening” without a fix: the run it starts says so (TA-31).
  if (event === 'reopened' && !fixId) return;
  const [automation] = await db
    .select({ principalId: automations.principalId })
    .from(automations)
    .where(eq(automations.id, automationId));
  if (!automation) return;
  const res = await services.pipeline.commit(
    updateFix,
    {
      runId,
      fixId,
      from: moving,
      set: { state: event },
      line: event === 'confirmed' ? 'The customer says the fix works.' : null,
    },
    { burrowId: report.burrowId, actorId: automation.principalId },
  );
  if (res.status !== 'ok') throw new Error(`tracker.fix_update: ${res.status}`);
}
