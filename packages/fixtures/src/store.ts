/**
 * Pure derived views over the fixture data: sidebar/bootstrap shape, conversation summaries, the audit chain enriched
 * into `AuditEvent[]`, and the agent's keys summary. `fetch.ts` owns the mutable in-memory world (messages, approvals
 * and the agent change per `createFixtureFetch()` instance); this module only ever reads the fixtures and never mutates
 * them.
 */
import { fingerprintOf } from '@whombat/core/audit';
import type { Bootstrap, BranchRoomSummary, Sidebar } from '@whombat/core/contracts';
import type {
  AuditApprovalState,
  AuditEvent,
  Conversation,
  ConversationSummary,
  Grant,
  SignedEvent,
} from '@whombat/core/domain';
import { conversationLink, PR_STATUS_TONES, prStatus } from '@whombat/core/domain';
import { type KeysSummary, keysSummary } from '@whombat/core/keys';
import { BURROW_ID, burrow } from './burrow.js';
import { CANVASES } from './canvas.js';
import { cnv_dm_dusty, cnv_feedback_mara, cnv_pr482, roomOf } from './conversations.js';
import { AGENT, grantsFor, mara, PRINCIPALS } from './principals.js';
import { SEED_NOW } from './time.js';
import { approval, pr, type run } from './work.js';

/** Whether a principal is the agent (the audit filters' “Agent” side). */
export function isAgent(principalId: string): boolean {
  return principalId === AGENT.id;
}

/** Unread/mentions the sidebar shows: Mara's Chat has Dusty's unread reply; everything else reads as caught up. */
const SIDEBAR_BADGE: Record<string, { unread: number; mentions: number }> = {
  [cnv_pr482.id]: { unread: 0, mentions: 0 },
  [cnv_dm_dusty.id]: { unread: 1, mentions: 0 },
  [cnv_feedback_mara.id]: { unread: 0, mentions: 0 },
};

export function conversationSummary(c: Conversation): ConversationSummary {
  const badge = SIDEBAR_BADGE[c.id] ?? { unread: 0, mentions: 0 };
  const room = roomOf(c);
  return {
    id: c.id,
    kind: c.kind,
    slug: c.slug,
    title: c.title,
    link: conversationLink({ ...c, ...(room ? { room } : {}) }),
    unread: badge.unread,
    mentions: badge.mentions,
    prNumber: c.prNumber,
    lastMessageAt: c.lastMessageAt,
  };
}

/** The one branch room in the fixtures: `feat/invoice-pdf` (`cnv_pr482`), driven by the live `pr`. */
export function branchRoomSummary(): BranchRoomSummary {
  const status = prStatus(pr);
  return {
    ...conversationSummary(cnv_pr482),
    branch: pr.branch,
    prNumber: pr.number,
    prStatus: status,
    dot: PR_STATUS_TONES[status],
  };
}

/** `counts.needsYou` matches `apps/server/src/read/views.ts#bootstrap()`: the count of *pending approvals
 * the viewer can decide* — not a notification count (`ntf_needs_plan` is a second, related notification
 * about the same single decidable approval, not a second one). See `docs/decisions/seed-wiring.md` SW-10. */
export function sidebar(): Sidebar {
  return {
    branchRooms: [branchRoomSummary()],
    dms: [cnv_dm_dusty, cnv_feedback_mara].map(conversationSummary),
    counts: {
      canvases: CANVASES.length,
      needsYou: approval.state === 'pending' ? 1 : 0,
    },
  };
}

/** Bootstrap payload for the signed-in viewer (always Mara in the fixtures — she owns the burrow). */
export function bootstrap(): Bootstrap {
  return {
    burrow,
    me: mara,
    principals: PRINCIPALS,
    sidebar: sidebar(),
    preferences: { theme: 'system', timeZone: null },
    serverTime: SEED_NOW.toISOString(),
    // Matches `apps/server/src/read/views.ts#bootstrap()`'s `realtime.path` exactly (`WS_PATH` +
    // `?burrow=<slug>`); `@whombat/core/contracts`'s `WS_PATH` isn't imported here to avoid a needless
    // cross-module hop for one string literal — see `docs/decisions/seed-wiring.md` SW-10.
    realtime: {
      path: `/ws?burrow=${encodeURIComponent(burrow.slug)}`,
      topics: [`burrow:${BURROW_ID}`, `me:${mara.id}`],
    },
  };
}

/** `KeysSummarySchema` for the agent: its grants (the defaults, unless `fetch.ts`'s world has since changed them). */
export function agentKeysSummary(grants: readonly Grant[] = grantsFor(AGENT.id)): KeysSummary {
  return keysSummary(grants);
}

/** The agent's one live run: `run` (or its current state, passed in). */
export function currentRunFor(liveRun: typeof run) {
  if (liveRun.agentId !== AGENT.id) return null;
  if (liveRun.status !== 'live' && liveRun.status !== 'paused') return null;
  return { number: liveRun.number, status: liveRun.status, title: liveRun.title };
}

/* Audit -------------------------------------------------------------------------------------------- */

/** `AUDIT_CHAIN`'s `evt_9f18` (Dusty's deploy ask) carries its approval's live state (updated as `fetch.ts`
 * decides/undoes it); every other event has no linked approval. `approvalByEventId` maps an event id to
 * its approval's current `AuditApprovalState` — built fresh by the caller from the live approval object. */
export function enrichAuditEvent(
  signed: SignedEvent,
  approvalByEventId: ReadonlyMap<string, AuditApprovalState>,
): AuditEvent {
  return {
    ...signed,
    fingerprint: fingerprintOf(signed.signer),
    verified: true,
    approval: approvalByEventId.get(signed.id) ?? null,
  };
}
