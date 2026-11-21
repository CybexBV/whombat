import type {
  ApprovalAction,
  ApprovalCondition,
  AuditApprovalState,
  AuditKeyRef,
  Decision,
  EventDraft,
  Grant,
  JsonObject,
  KeyId,
  LinkRef,
  RealtimeEvent,
  RequestScope,
  SignedEvent,
} from '@whombat/core';
import type { z } from 'zod';
import type { Db, Tx } from '../db/client';
import type { burrows } from '../db/schema/index';
import type { ActorInfo } from '../read/principals';
import type { Services } from '../services';

export type BurrowRow = typeof burrows.$inferSelect;

/** Approval details a command supplies for its `ask` outcome (defaults are derived from `attempt`). */
export interface ApprovalDraft {
  title?: string;
  question?: string;
  target?: string;
  whatHappens?: string[];
  explainer?: string;
  summary?: string;
  /** Extra conditions besides "A person says yes". */
  conditions?: ApprovalCondition[];
  involvedIds?: string[];
  /** Text of the approval card message the requester posts. */
  cardText?: string;
}

/** What a command needs from the keys engine. */
export interface KeyRequirement {
  keyId: KeyId;
  scope?: RequestScope;
  /** "merge PR #479 into main" → Blocked text "Tried to merge PR #479 into main. Blocked." */
  attempt: string;
  /** Approval action for `ask` (defaults to a `custom` action that re-runs the command). */
  action?: ApprovalAction;
  /** Audit `where` for Blocked / Asks events. */
  where?: string | null;
  /** Conversation the approval card goes to (`ask`). */
  conversationId?: string | null;
  ref?: LinkRef;
  approval?: ApprovalDraft;
  /**
   * `approval` (default): an `ask` decision creates an Approval and the command waits for a person.
   * `apply`: the command itself handles asking (request_approval), so `ask` runs `apply`.
   */
  onAsk?: 'approval' | 'apply';
  /**
   * With `ask`: a person's yes runs the approval action's executor instead of this command again (`perform_action`:
   * a merge runs as the person who approved, a deploy completes from its workflow; essentials-agents.md EA-02).
   */
  approvalRunsAction?: boolean;
  /**
   * The grants the keys engine decides on instead of the agent's stored ones: a connection tool call counts only the
   * tier of exactly that call (connections/call.ts, connections-catalog.md CX-31).
   */
  grants?: Grant[];
}

export interface RequirementContext {
  db: Db;
  services: Services;
  burrow: BurrowRow;
  actor: ActorInfo;
}

/** Fields of an event the command writes; the pipeline fills id, burrow, actor, time and on-behalf-of. */
export type EmitFields = Omit<EventDraft, 'id' | 'burrowId' | 'actorId' | 'createdAt' | 'payload'> & {
  id?: string;
  createdAt?: string;
  payload?: JsonObject;
  /** Live approval for `approval.requested` events (shown with the `audit.appended` frame). */
  approvalState?: AuditApprovalState | null;
};

export interface PublishOptions {
  eventId?: string | null;
}

export type PostCommitHook = () => Promise<void>;
export type CompletionHook = () => Promise<readonly string[]>;

/** Transaction-scoped writer: signed events, outbox frames and post-commit hooks. */
export interface TxSession {
  readonly tx: Tx;
  readonly services: Services;
  readonly burrowId: string;
  /** Appends a signed event by `actorId` (the caller must be allowed to sign for them: pipeline / seed). */
  append(actorId: string, fields: EmitFields & { createdAt: string }): Promise<SignedEvent>;
  publish(topic: string, event: RealtimeEvent, options?: PublishOptions): void;
  /** Finishes dependent writes in this transaction after the command has stored its result. */
  beforeCommit(hook: PostCommitHook): void;
  /** Required continuation after the lock is released. Its failure is returned to the caller. */
  complete(hook: CompletionHook): void;
  after(hook: PostCommitHook): void;
  /**
   * Work after the commit that the caller's response doesn't wait for (server-efficiency.md SV-02): started once the
   * outbox is published, alongside the `after` hooks, tracked by `services.background`. With `key`, it starts after
   * every earlier work of that key has finished (`BackgroundWork.serial`).
   */
  background(what: string, hook: PostCommitHook, key?: string): void;
  readonly eventIds: readonly string[];
}

export interface ApplyContext extends TxSession {
  burrow: BurrowRow;
  actor: ActorInfo;
  now: Date;
  /** `now` as ISO. */
  at: string;
  decision: Decision | null;
  requirement: KeyRequirement | null;
  /** Set when an approved request is being executed. */
  approvalId: string | null;
  onBehalfOf: { text?: string; principalId?: string };
  /** Signed event by the actor. */
  emit(fields: EmitFields): Promise<SignedEvent>;
}

export interface CommandDef<S extends z.ZodType = z.ZodType, R = unknown> {
  name: string;
  schema: S;
  requiredKey?: (
    input: z.output<S>,
    ctx: RequirementContext,
  ) => KeyRequirement | null | Promise<KeyRequirement | null>;
  /**
   * The appliance licence (LC-10, MR-58), checked before anything else — before the keys engine, so a lapsed box
   * refuses up front instead of asking for an approval. Not checked when executing an approved request: an approved
   * action continues. `'agentTurn'`: the command starts a new agent turn (`licence.lapsed` while lapsed).
   */
  licence?: 'agentTurn';
  apply: (tx: Tx, ctx: ApplyContext, input: z.output<S>) => Promise<R>;
}

export function defineCommand<S extends z.ZodType, R>(def: CommandDef<S, R>): CommandDef<S, R> {
  return def;
}

export interface CommitOptions {
  burrowId: string;
  actorId: string;
  now?: Date;
  onBehalfOf?: { text?: string; principalId?: string };
  /** Executing an approved request: an `ask` decision counts as allowed (a `deny` still blocks). */
  approvalId?: string;
}

export type CommitResult<R> =
  | { status: 'ok'; result: R; eventIds: string[] }
  | {
      status: 'pending_approval';
      approvalId: string;
      approvalNumber: number;
      eventId: string;
      message: string;
    }
  | { status: 'blocked'; keyNeeded: AuditKeyRef; eventId: string; message: string };
