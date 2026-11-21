/**
 * `seedWorld()` — maps the mock world onto `SeedWorld` (`apps/server/src/seed/world.ts`'s input shape) so
 * `pnpm db:reset && pnpm db:seed` loads "Burrow HQ" exactly as `Whombat Desktop.dc.html`/`Whombat
 * Mobile.dc.html` show it. Picked up automatically by `apps/server/src/seed/source.ts` (it looks for this
 * function first). Not typed against `@whombat/core`'s or the server's `SeedWorld` schema on purpose —
 * `packages/fixtures` must not depend on `apps/server` (see ARCHITECTURE.md's dependency direction); the
 * loader validates the shape at parse time (`SeedWorld.parse()`).
 *
 * See `docs/decisions/seed-wiring.md` for every mapping decision referenced below (SW-01..SW-06).
 */
import type { Message } from '@whombat/core/domain';
import { AUDIT_DRAFTS } from './audit.js';
import { burrow, REPOS } from './burrow.js';
import { CANVAS_COMMENTS, CANVAS_MARKDOWN, CANVASES } from './canvas.js';
import { CONVERSATIONS, cnv_dm_dusty } from './conversations.js';
import { BASE_LOG_LINES } from './live.js';
import { ALL_MESSAGES } from './messages.js';
import { NOTIFICATIONS } from './notifications.js';
import { AGENT, GRANTS, mara, PEOPLE } from './principals.js';
import { searchAnswer, sr_patch_311, sr_run_1882, sr_thread_incidents } from './search.js';
import { SEED_NOW } from './time.js';
import { approval, plan, pr, run } from './work.js';

/** `SeedWorld.events` stops right after the approval-request event: everything later in `AUDIT_CHAIN`
 * (`evt_9f2c`, `evt_9f31`) postdates the seeded "now" and belongs only to `createFixtureFetch()`'s
 * post-decision simulation. See `docs/decisions/seed-wiring.md` SW-02. */
const LAST_SEED_EVENT_ID = 'evt_9f18';

function seedEvents() {
  const cutoff = AUDIT_DRAFTS.findIndex((d) => d.id === LAST_SEED_EVENT_ID);
  const drafts = cutoff === -1 ? AUDIT_DRAFTS : AUDIT_DRAFTS.slice(0, cutoff + 1);
  return drafts.map(({ burrowId: _burrowId, ...rest }) => rest);
}

/** Storage form of a message's card: plan/run/approval hold full live objects in `Message['card']`
 * (`MessageCard`); `SeedMessage.card` (`StoredCard`) wants id references instead. Every other card kind is
 * already `StoredCard`-shaped. */
function storedCard(card: Message['card']) {
  if (!card) return null;
  if (card.kind === 'plan') return { kind: 'plan' as const, planId: card.plan.id };
  if (card.kind === 'run') return { kind: 'run' as const, runId: card.run.id };
  if (card.kind === 'approval') return { kind: 'approval' as const, approvalId: card.approval.id };
  return card;
}

/** `SeedMessage.reactions` is `{value, principalIds}[]`; `messages.ts` also carries `count`/`mine`, which
 * are read-model conveniences the loader recomputes itself. */
function seedReactions(reactions: Message['reactions']) {
  return reactions.map(({ value, principalIds }) => ({ value, principalIds }));
}

function toSeedMessage(m: Message) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    authorId: m.authorId,
    createdAt: m.createdAt,
    text: m.text,
    card: storedCard(m.card),
    threadRootId: m.threadRootId,
    mentions: m.mentions,
    reactions: seedReactions(m.reactions),
    editedAt: m.editedAt,
  };
}

function toSeedCanvas(c: (typeof CANVASES)[number]) {
  return {
    ...c,
    markdown: CANVAS_MARKDOWN[c.id] ?? '',
    comments: CANVAS_COMMENTS.filter((cm) => cm.canvasId === c.id),
  };
}

/** Read markers: everything is read except Mara's Chat (1 unread — Dusty's last reply), matching
 * `store.ts#SIDEBAR_BADGE`. Every other conversation gets no explicit marker, so the loader marks it fully read by
 * default. */
function readMarkers() {
  return [
    { conversationId: cnv_dm_dusty.id, principalId: mara.id, lastReadMessageId: 'msg_dm-dusty-mara-1404' },
  ];
}

/** `SeedWorld.searchDocuments`: search-only history that isn't a real domain row in this seed — the March
 * credit-note thread, PR #311 and Run #1882, none of them in a conversation of this seed. `sr_canvas_rules_v3` isn't included here: it's now a real seeded
 * canvas (`canvasInvoicingRulesV3`) and gets indexed from that instead. See
 * `docs/decisions/seed-wiring.md` SW-06. */
function searchDocuments() {
  return [sr_thread_incidents, sr_patch_311, sr_run_1882].map((r) => ({
    id: r.id,
    type: r.type,
    conversationId: null,
    where: r.where,
    authorId: r.authorId,
    text: r.snippet,
    link: r.link,
    createdAt: r.createdAt,
  }));
}

export function seedWorld() {
  return {
    now: SEED_NOW.toISOString(),
    burrow,
    people: PEOPLE,
    // The one agent, as a list of one so the loader inserts it like any principal.
    agents: [{ ...AGENT, grants: GRANTS.map(({ agentId: _agentId, ...g }) => g) }],
    conversations: CONVERSATIONS,
    readMarkers: readMarkers(),
    repos: REPOS,
    pullRequests: [pr],
    plans: [plan],
    runs: [{ ...run, log: BASE_LOG_LINES.map(({ seq: _seq, ...l }) => l) }],
    approvals: [approval],
    messages: ALL_MESSAGES.map(toSeedMessage),
    canvases: CANVASES.map(toSeedCanvas),
    notifications: NOTIFICATIONS,
    searchDocuments: searchDocuments(),
    searchAnswers: [{ ...searchAnswer, askedById: mara.id }],
    events: seedEvents(),
  };
}
