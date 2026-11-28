/**
 * What a signed event means to triggers (bp-automations BP-C05, automation-recipes.md): its facts, the room, thread and
 * GitHub or tracker item it is about, the run's scope and trigger, and how deep in an automation chain it is.
 */
import {
  FIND_MY_PLACE_CHANGED,
  FindMyPlaceChanged,
  findMyTriggerFacts,
  type GitHubTriggerEvent,
  HOME_STATE_CHANGED,
  HomeStateChanged,
  homeChangeSummary,
  type JsonObject,
  PROTECT_DETECTED,
  ProtectDetected,
  protectSightingSummary,
  THING_INCIDENT_EVENTS,
  ThingIncidentEvent,
  type TriggerFacts,
  thingIncidentDurationWords,
  thingIncidentMinutes,
  thingTriggerFacts,
  thingTriggerSummary,
  thingWatchResultText,
} from '@whombat/core';
import { and, eq, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  automationRunSteps,
  automationRuns,
  automations,
  dispatches,
  type events,
  messages,
  repos,
} from '../../db/schema/index';
import { isFeedbackPrincipal, isReportThread } from '../../feedback/principal';
import { findMyPrincipal, placeChangeScope, placeChangeSummary } from '../../hosts/findmy-places';
import { SYSTEM_SERVERS } from '../../hosts/principal';
import {
  mailHeadline,
  mailItemKey,
  mailItemScope,
  mailTriggerFactsOf,
  mirroredMailItem,
} from '../../mail-triggers/index';
import { actorKind, loadPrincipalRow } from '../../read/principals';
import { decisionNote } from '../../trackers/features';
import { trackerHeadline, trackerItemKey, trackerItemScope } from '../../trackers/items';
import { replyOf } from '../../trackers/replies';
import { mirroredItem } from '../../trackers/store';
import {
  type GitHubItem,
  githubHeadline,
  githubItemScope,
  issueItem,
  itemKeyOf,
  pullRequestItem,
} from '../github-items';
import { smartHomePrincipal } from '../home-triggers';
import { isAutomationPrincipal } from '../principal';
import type { AutomationRunRow } from '../store';

type EventRow = typeof events.$inferSelect;

export const EVENT_TYPES = [
  'message.posted',
  'message.reacted',
  'pr.opened',
  'pr.updated',
  // A draft marked ready for review: `pr_opened` for triggers that leave drafts out (automation-recipes.md).
  'pr.ready',
  'checks.completed',
  'pr.approved',
  'pr.changes_requested',
  'pr.commented',
  'branch.pushed',
  // A new issue on a watched repo (automation-recipes.md).
  'issue.opened',
  // A new report in a tracker connection an automation listens to (report-trackers.md TA-07).
  'tracker.item_opened',
  // The customer wrote back on, or reopened, a report an automation ran for (report-trackers.md TA-31).
  'tracker.reporter_replied',
  // A matching incoming email arrived in a connected mailbox watched by a live automation.
  'mail.received',
  // Someone's place changed on a Find My connection a live automation listens to (findmy-connection.md).
  FIND_MY_PLACE_CHANGED,
  ...THING_INCIDENT_EVENTS,
  // A Home Assistant entity a live automation names changed state, and Protect saw something on a connection one
  // listens to (direct-automations.md).
  HOME_STATE_CHANGED,
  PROTECT_DETECTED,
];

export interface EventFacts {
  facts: TriggerFacts;
  conversationId: string | null;
  threadRootId: string | null;
  /** The GitHub issue or pull request the event is about (`itemKeyOf`), else null. */
  itemKey: string | null;
  /** When an incoming mail message was received by the provider (used to skip pre-existing mail for newer automations). */
  receivedAt?: Date;
  scope: JsonObject;
  info: (e: EventRow) => AutomationRunRow['trigger'];
}

export interface Cause {
  depth: number;
  chain: string[];
}

/** What an event means to triggers (null: nothing a trigger listens to). */
export async function eventFacts(tx: Db, event: EventRow): Promise<EventFacts | null> {
  const payload = event.payload as Record<string, unknown>;
  const actor = await loadPrincipalRow(tx, event.actorId);
  if (!actor) return null;
  // Whombat Feedback's posts carry what website visitors sent: they never start anything (feedback.md FB-15).
  if (isFeedbackPrincipal(actor)) return null;
  const who = actor.shortName ?? actor.name;
  if (event.type === 'message.posted' || event.type === 'message.reacted') {
    const messageId = typeof payload.messageId === 'string' ? payload.messageId : null;
    if (!messageId) return null;
    const [m] = await tx.select().from(messages).where(eq(messages.id, messageId));
    if (!m || m.deletedAt) return null;
    if (event.type === 'message.reacted' && payload.on !== true) return null;
    const threadRootId = m.threadRootId ?? m.id;
    // A Feedback assessment or handoff, or a message an outsiders' run posted (an email's, a tracker customer's): it
    // carries what outsiders wrote onwards, so neither it nor a reaction to it ever starts another automation
    // (docs/decisions/feedback.md, docs/decisions/outsiders-turns.md).
    if (m.provenance || m.outsidersRun) return null;
    // An agent in a feedback report's thread is assessing (or answering about) what a website visitor sent: its
    // messages carry that visitor's words onwards, so they start nothing either (feedback.md FB-21, FB-23).
    if (actorKind(actor.kind) === 'agent' && (await isReportThread(tx, threadRootId))) return null;
    const base = {
      conversationId: m.conversationId,
      threadRootId,
      itemKey: null,
      scope: {
        text: m.text,
        authorId: m.authorId,
        messageId: m.id,
        kind: event.type === 'message.posted' ? 'message' : 'reaction',
      } as JsonObject,
    };
    if (event.type === 'message.posted')
      return {
        ...base,
        facts: {
          kind: 'message',
          conversationId: m.conversationId,
          text: m.text,
          authorKind: actorKind(actor.kind),
          mentions: m.mentions ?? [],
          isReply: !!m.threadRootId,
        },
        info: (e) => ({
          kind: 'message_posted',
          summary: `${who} posted a message`,
          actorId: actor.id,
          eventId: e.id,
          messageId: m.id,
          scheduledFor: null,
        }),
      };
    const value = String(payload.value ?? '');
    return {
      ...base,
      scope: { ...base.scope, reaction: value, reactedById: actor.id },
      facts: { kind: 'reaction', conversationId: m.conversationId, value },
      info: (e) => ({
        kind: 'reaction_added',
        summary: `${who} reacted ${value}`,
        actorId: actor.id,
        eventId: e.id,
        messageId: m.id,
        scheduledFor: null,
      }),
    };
  }
  // A new tracker report (report-trackers.md TA-07, TA-08): its mirrored row is the run's scope.
  if (event.type === 'tracker.item_opened') {
    const rowId = typeof payload.rowId === 'string' ? payload.rowId : null;
    const item = rowId ? await mirroredItem(tx, rowId) : null;
    if (!item) return null;
    return {
      facts: {
        kind: 'tracker',
        event: 'item_opened',
        connectionId: item.connectionId,
        itemKind: item.type,
      },
      conversationId: null,
      threadRootId: null,
      itemKey: trackerItemKey(item.connectionId, item.number),
      scope: trackerItemScope(item),
      info: (e) => ({
        kind: 'tracker',
        summary: trackerHeadline(item).slice(0, 200),
        actorId: actor.id,
        eventId: e.id,
        messageId: null,
        scheduledFor: null,
      }),
    };
  }
  // The customer's answer on a report an automation ran for (report-trackers.md TA-31): the same scope as the
  // report's, with what they wrote as its `text`, in the report's thread (the same item key). “It works” starts nothing.
  if (event.type === 'tracker.reporter_replied') {
    const rowId = typeof payload.rowId === 'string' ? payload.rowId : null;
    const replyId = typeof payload.replyId === 'string' ? payload.replyId : null;
    const reply = replyId ? await replyOf(tx, replyId) : null;
    if (!rowId || !reply || reply.reportRowId !== rowId || reply.event === 'confirmed') return null;
    const item = await mirroredItem(tx, rowId);
    if (!item) return null;
    const scope = trackerItemScope(item, { event: reply.event, text: reply.text });
    // What the person decided on this feature request, so the answer agrees with it (report-trackers.md TA-47).
    const decided = await decisionNote(tx, item.connectionId, item.reportId);
    if (decided) scope.text = `${String(scope.text)}\n\n${decided}`;
    return {
      facts: {
        kind: 'tracker',
        event: 'reporter_replied',
        connectionId: item.connectionId,
        itemKind: item.type,
      },
      conversationId: null,
      threadRootId: null,
      itemKey: trackerItemKey(item.connectionId, item.number),
      scope,
      info: (e) => ({
        kind: 'tracker',
        summary: (String(scope.text).split('\n')[0] ?? '').slice(0, 200),
        actorId: actor.id,
        eventId: e.id,
        messageId: null,
        scheduledFor: null,
      }),
    };
  }
  // A matching incoming email in a watched mailbox: its mirrored row fills the outsider-fenced run scope.
  if (event.type === 'mail.received') {
    const rowId = typeof payload.rowId === 'string' ? payload.rowId : null;
    const item = rowId ? await mirroredMailItem(tx, rowId) : null;
    if (!item) return null;
    return {
      facts: mailTriggerFactsOf(item),
      conversationId: null,
      threadRootId: null,
      itemKey: mailItemKey(item.connectionId, item.externalId),
      receivedAt: item.receivedAt,
      scope: mailItemScope(item),
      info: (e) => ({
        kind: 'mail',
        summary: mailHeadline(item),
        actorId: actor.id,
        eventId: e.id,
        messageId: null,
        scheduledFor: null,
      }),
    };
  }
  // Someone arrived somewhere or left, as Find My showed it (findmy-connection.md): only the Find My signer's count, and
  // someone without a place now neither arrives nor leaves.
  if (event.type === FIND_MY_PLACE_CHANGED) {
    const parsed = FindMyPlaceChanged.safeParse(payload);
    if (!parsed.success || parsed.data.to === null || !findMyPrincipal.is(actor)) return null;
    const change = { ...parsed.data, to: parsed.data.to };
    const scope = placeChangeScope(change);
    return {
      facts: findMyTriggerFacts(change),
      conversationId: null,
      threadRootId: null,
      itemKey: null,
      scope,
      info: (e) => ({
        kind: 'findmy',
        summary: placeChangeSummary(change).slice(0, 200),
        actorId: actor.id,
        eventId: e.id,
        messageId: null,
        scheduledFor: null,
      }),
    };
  }
  // A Home Assistant entity changed state, or Protect saw something (direct-automations.md): only the smart home
  // signer's count.
  if (event.type === HOME_STATE_CHANGED) {
    const parsed = HomeStateChanged.safeParse(payload);
    if (!parsed.success || !smartHomePrincipal.is(actor)) return null;
    const c = parsed.data;
    const summary = homeChangeSummary(c);
    return {
      facts: { kind: 'home_state', connectionId: c.connectionId, entity: c.entity, from: c.from, to: c.to },
      conversationId: null,
      threadRootId: null,
      itemKey: null,
      scope: {
        kind: 'home_state',
        connectionId: c.connectionId,
        entity: c.entity,
        name: c.name ?? c.entity,
        from: c.from,
        to: c.to,
        text: `${summary}.`,
      },
      info: (e) => ({
        kind: 'home_state',
        summary: summary.slice(0, 200),
        actorId: actor.id,
        eventId: e.id,
        messageId: null,
        scheduledFor: null,
      }),
    };
  }
  if (event.type === PROTECT_DETECTED) {
    const parsed = ProtectDetected.safeParse(payload);
    if (!parsed.success || !smartHomePrincipal.is(actor)) return null;
    const d = parsed.data;
    const summary = protectSightingSummary(d);
    return {
      facts: { kind: 'protect', connectionId: d.connectionId, event: d.event, camera: d.camera },
      conversationId: null,
      threadRootId: null,
      itemKey: null,
      scope: {
        kind: 'protect',
        connectionId: d.connectionId,
        event: d.event,
        camera: d.camera,
        name: d.cameraName ?? '',
        text: `${summary}.`,
      },
      info: (e) => ({
        kind: 'protect',
        summary: summary.slice(0, 200),
        actorId: actor.id,
        eventId: e.id,
        messageId: null,
        scheduledFor: null,
      }),
    };
  }
  if ((THING_INCIDENT_EVENTS as readonly string[]).includes(event.type)) {
    const parsed = ThingIncidentEvent.safeParse(payload);
    if (!parsed.success || actor.system !== SYSTEM_SERVERS) return null;
    const incident = parsed.data;
    const facts = thingTriggerFacts(event.type, incident);
    const summary = thingTriggerSummary(facts);
    const minutes = thingIncidentMinutes(incident);
    const text =
      facts.event === 'back'
        ? thingWatchResultText({ name: incident.name, event: 'back' }, incident)
        : `${summary}.`;
    return {
      facts,
      conversationId: null,
      threadRootId: null,
      itemKey: null,
      scope: {
        kind: 'thing',
        event: facts.event,
        thing: incident.thing,
        name: incident.name,
        words: incident.words,
        since: incident.startedAt,
        minutes,
        downFor: minutes === null ? '' : thingIncidentDurationWords(minutes),
        text,
      },
      info: (e) => ({
        kind: 'thing',
        summary: summary.slice(0, 200),
        actorId: actor.id,
        eventId: e.id,
        messageId: null,
        scheduledFor: null,
      }),
    };
  }
  // GitHub (mirrored): only switched-on repos fire.
  if (event.type === 'branch.pushed') {
    const repo = typeof payload.repo === 'string' ? payload.repo : null;
    const branch = typeof payload.branch === 'string' ? payload.branch : null;
    if (!repo || !(await switchedOn(tx, event.burrowId, repo))) return null;
    const text = event.text ?? `branch pushed on ${repo}${branch ? ` · ${branch}` : ''}`;
    return {
      facts: { kind: 'github', event: 'branch_pushed', repo, branch, checksState: null },
      conversationId: null,
      threadRootId: null,
      itemKey: null,
      scope: {
        kind: 'github',
        event: 'branch_pushed',
        repo,
        branch,
        prNumber: null,
        checksState: null,
        sha: typeof payload.sha === 'string' ? payload.sha : null,
        text,
      },
      info: (e) => ({
        kind: 'github',
        summary: (e.text ?? `branch pushed on ${repo}`).slice(0, 200),
        actorId: actor.id,
        eventId: e.id,
        messageId: null,
        scheduledFor: null,
      }),
    };
  }
  let item: GitHubItem | null;
  let kind: GitHubTriggerEvent;
  let readied = false;
  let checksState: string | null = null;
  if (event.type === 'issue.opened') {
    const issueId = typeof payload.issueId === 'string' ? payload.issueId : null;
    item = issueId ? await issueItem(tx, issueId) : null;
    kind = 'issue_opened';
  } else {
    const prId = typeof payload.prId === 'string' ? payload.prId : null;
    item = prId ? await pullRequestItem(tx, prId) : null;
    if (!item) return null;
    if (event.type === 'pr.opened') {
      kind = 'pr_opened';
      // As it was when it opened: a draft marked ready since has its own `pr.ready`.
      if (typeof payload.draft === 'boolean') item = { ...item, draft: payload.draft };
    } else if (event.type === 'pr.ready') {
      kind = 'pr_opened';
      readied = true;
      item = { ...item, draft: false };
    } else if (event.type === 'pr.updated') {
      // New commits: the head moved in this update, or the update that follows a push the poller mirrored first
      // (`synchronize`; the push already moved the head).
      if (payload.headMoved !== true && payload.action !== 'synchronize') return null;
      kind = 'pr_updated';
    } else if (event.type === 'checks.completed') {
      if (event.text === null) return null; // not a finished round
      kind = 'checks_completed';
      checksState = typeof payload.state === 'string' ? payload.state : null;
    } else kind = 'review_submitted';
    if (typeof payload.headSha === 'string') item = { ...item, sha: payload.headSha };
    else if (typeof payload.sha === 'string') item = { ...item, sha: payload.sha };
  }
  if (!item || !(await switchedOn(tx, event.burrowId, item.repo))) return null;
  const found = item;
  const scope = githubItemScope(kind, found, { checksState, readied });
  return {
    facts: {
      kind: 'github',
      event: kind,
      repo: found.repo,
      branch: found.branch,
      checksState,
      draft: found.draft,
      bot: found.bot,
      ...(readied ? { readied: true } : {}),
    },
    conversationId: null,
    threadRootId: null,
    itemKey: itemKeyOf(found.repo, found.number),
    scope,
    info: (e) => ({
      kind: 'github',
      summary: githubHeadline(kind, found, { checksState, readied }).slice(0, 200),
      actorId: actor.id,
      eventId: e.id,
      messageId: null,
      scheduledFor: null,
    }),
  };
}

/**
 * How deep in an automation chain an event is. An automation's own post, or an agent's message in a conversation
 * where one of its automation dispatches was running at the time, is caused by that run: depth + 1.
 */
export async function eventCause(
  tx: Db,
  event: EventRow,
  facts: { conversationId: string | null },
): Promise<Cause> {
  const actor = await loadPrincipalRow(tx, event.actorId);
  // The agent, or one of Whombat's own signers (an automation's is `system`, one-agent.md OA-S01): only the person starts a
  // chain afresh (OA-S102).
  if (!actor || actorKind(actor.kind) !== 'agent') return { depth: 0, chain: [] };
  let run: AutomationRunRow | undefined;
  if (isAutomationPrincipal(actor)) {
    const [a] = await tx
      .select({ id: automations.id })
      .from(automations)
      .where(eq(automations.principalId, actor.id));
    const messageId = (event.payload as { messageId?: unknown }).messageId;
    const [byMessage] =
      typeof messageId === 'string'
        ? await tx
            .select({ run: automationRuns })
            .from(automationRunSteps)
            .innerJoin(automationRuns, eq(automationRuns.id, automationRunSteps.runId))
            .where(
              or(
                eq(automationRunSteps.promptMessageId, messageId),
                sql`${messageId} = any(${automationRunSteps.messageIds})`,
              ),
            )
        : [];
    run = byMessage?.run;
    if (!run && a) return { depth: 1, chain: [a.id] };
  } else if (facts.conversationId) {
    const [found] = await tx
      .select({ run: automationRuns })
      .from(dispatches)
      .innerJoin(automationRunSteps, eq(automationRunSteps.dispatchId, dispatches.id))
      .innerJoin(automationRuns, eq(automationRuns.id, automationRunSteps.runId))
      .where(
        and(
          eq(dispatches.agentId, actor.id),
          eq(dispatches.trigger, 'automation'),
          eq(dispatches.conversationId, facts.conversationId),
          lte(dispatches.createdAt, event.createdAt),
          or(
            sql`${dispatches.finishedAt} is null`,
            sql`${dispatches.finishedAt} >= ${event.createdAt.toISOString()}::timestamptz`,
          ),
        ),
      )
      .limit(1);
    run = found?.run;
  }
  if (!run) return { depth: 0, chain: [] };
  return { depth: run.causalDepth + 1, chain: [...run.causalChain] };
}

/** The repo is one of the burrow's and switched on for agents: only those fire GitHub triggers. */
async function switchedOn(tx: Db, burrowId: string, repo: string): Promise<boolean> {
  const [row] = await tx
    .select({ enabled: repos.enabled })
    .from(repos)
    .where(and(eq(repos.burrowId, burrowId), eq(repos.fullName, repo)));
  return !!row?.enabled;
}
