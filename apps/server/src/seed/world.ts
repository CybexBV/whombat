/**
 * `SeedWorld` — the input of `pnpm db:seed`. The mock world (`@whombat/fixtures`) is mapped to this shape;
 * the loader (`seed/load.ts`) writes it through the commit pipeline's session so every seeded event is
 * signed with the actor's deterministic seed key and chained.
 *
 * Shape rules (see docs/decisions/server-core.md "Seed"):
 * - Entities use the `@whombat/core` domain schemas. `burrowId` is optional everywhere (the loader sets it).
 * - Keys are derived: `publicKey` / `fingerprint` may be omitted; when given they must equal
 *   `deriveSeedKeypair(id, keySeed)`.
 * - Messages hold `StoredCard`s (plan / run / approval by id). Thread replies set `threadRootId`; reply counts,
 *   last reply and participants are computed. `mentions` default to `@Name` resolution.
 * - Reactions are `{ value, principalIds }` (count = principalIds.length).
 * - Read markers: `lastReadMessageId: null` = nothing read. Members without a marker start fully read.
 * - `events` is the explicit audit history (the mock LOG): each is signed by its `actorId` at `createdAt`.
 *   The loader adds hidden internal events (`burrow.created`, one `message.posted` per message) and appends
 *   everything in time order.
 * - `searchDocuments` are search-only history items (threads from March, PR #311, Run #1882, old canvases).
 * - `--relative` shifts every ISO timestamp by (now − `now`) and calendar dates by whole days.
 */
import {
  Agent,
  Approval,
  Burrow,
  Canvas,
  CanvasComment,
  Conversation,
  EventEnvelope,
  GrantInput,
  LinkRef,
  Notification,
  Person,
  Plan,
  PrincipalId,
  PullRequest,
  ReactionValue,
  Repo,
  Run,
  RunLogLine,
  SearchAnswer,
  SearchResultType,
  StoredCard,
  Timestamp,
} from '@whombat/core';
import { z } from 'zod';

const opt = { burrowId: true } as const;

export const SeedPerson = Person.omit({ ...opt, publicKey: true, fingerprint: true, accountId: true }).extend(
  {
    burrowId: z.string().optional(),
    publicKey: z.string().optional(),
    fingerprint: z.string().optional(),
    accountId: z.string().optional(),
  },
);
export type SeedPerson = z.input<typeof SeedPerson>;

export const SeedAgent = Agent.omit({ ...opt, publicKey: true, fingerprint: true }).extend({
  burrowId: z.string().optional(),
  publicKey: z.string().optional(),
  fingerprint: z.string().optional(),
  grants: z.array(GrantInput),
});
export type SeedAgent = z.input<typeof SeedAgent>;

export const SeedConversation = Conversation.omit({ ...opt, lastMessageAt: true }).extend({
  burrowId: z.string().optional(),
  lastMessageAt: Timestamp.nullable().optional(),
  /** A Chat's or Feedback room's person (`dm_person_id`), the seed's own: contracts 3.0 conversations don't carry it. */
  dmPersonId: PrincipalId.nullable().default(null),
  /** Sidebar order within its kind (defaults to input order). */
  position: z.number().int().optional(),
  /** A person's room with the agent: their Chat (default) or their Feedback room (CHT-03); the fixtures' slug says so. */
  room: z.enum(['chat', 'feedback']).optional(),
});
export type SeedConversation = z.input<typeof SeedConversation>;

export const SeedReadMarker = z.object({
  conversationId: z.string(),
  principalId: PrincipalId,
  lastReadMessageId: z.string().nullable(),
});

export const SeedMessage = z.object({
  id: z.string(),
  conversationId: z.string(),
  authorId: PrincipalId,
  createdAt: Timestamp,
  text: z.string(),
  card: StoredCard.nullable().optional(),
  threadRootId: z.string().nullable().optional(),
  mentions: z.array(PrincipalId).optional(),
  reactions: z
    .array(z.object({ value: ReactionValue, principalIds: z.array(PrincipalId).min(1) }))
    .optional(),
  editedAt: Timestamp.nullable().optional(),
});
export type SeedMessage = z.input<typeof SeedMessage>;

export const SeedRun = Run.omit({ ...opt, logCount: true }).extend({
  burrowId: z.string().optional(),
  logCount: z.number().int().optional(),
  log: z.array(RunLogLine.omit({ seq: true })).default([]),
});
export type SeedRun = z.input<typeof SeedRun>;

export const SeedCanvas = Canvas.omit(opt).extend({
  burrowId: z.string().optional(),
  /** Initial body (Markdown) until the Yjs document takes over. */
  markdown: z.string().default(''),
  comments: z.array(CanvasComment).default([]),
});
export type SeedCanvas = z.input<typeof SeedCanvas>;

export const SeedSearchDocument = z.object({
  id: z.string().min(1).max(80),
  type: SearchResultType,
  /** Conversation that gates visibility; null = the whole burrow. */
  conversationId: z.string().nullable(),
  where: z.string(),
  authorId: PrincipalId,
  text: z.string(),
  link: LinkRef,
  createdAt: Timestamp,
});

export const SeedEvent = EventEnvelope.omit({ v: true, seq: true, prevHash: true, burrowId: true }).extend({
  payload: EventEnvelope.shape.payload.default({}),
});
export type SeedEvent = z.input<typeof SeedEvent>;

export const SeedWorld = z.object({
  /** The moment the world captures (the mock: 2026-09-23T09:22:00.000Z = 11:22 Amsterdam). */
  now: Timestamp,
  /** Seed for `deriveSeedKeypair`. */
  keySeed: z.string().default('whombat-demo'),
  burrow: Burrow.extend({ onboardingCompletedAt: Timestamp.nullable().optional() }),
  people: z.array(SeedPerson).min(1),
  agents: z.array(SeedAgent).default([]),
  conversations: z.array(SeedConversation).default([]),
  readMarkers: z.array(SeedReadMarker).default([]),
  repos: z.array(Repo.omit(opt).extend({ burrowId: z.string().optional() })).default([]),
  pullRequests: z
    .array(PullRequest.omit({ repoFullName: true }).extend({ repoFullName: z.string().optional() }))
    .default([]),
  plans: z
    .array(
      Plan.omit({ ...opt, canvasSlug: true }).extend({
        burrowId: z.string().optional(),
        canvasSlug: z.string().nullable().optional(),
      }),
    )
    .default([]),
  runs: z.array(SeedRun).default([]),
  approvals: z.array(Approval.omit(opt).extend({ burrowId: z.string().optional() })).default([]),
  messages: z.array(SeedMessage).default([]),
  canvases: z.array(SeedCanvas).default([]),
  notifications: z.array(Notification.omit(opt).extend({ burrowId: z.string().optional() })).default([]),
  searchDocuments: z.array(SeedSearchDocument).default([]),
  searchAnswers: z
    .array(SearchAnswer.omit(opt).extend({ burrowId: z.string().optional(), askedById: PrincipalId }))
    .default([]),
  events: z.array(SeedEvent).default([]),
});
/** What fixtures provide (defaults applied by the loader). */
export type SeedWorld = z.input<typeof SeedWorld>;
/** After parsing. */
export type ParsedSeedWorld = z.output<typeof SeedWorld>;
