import { z } from 'zod';
import {
  COMMAND_MAX,
  COMMAND_REASON_MAX,
  COMMAND_TARGET_MAX,
  CommandCategory,
  CommandScope,
} from '../commands/commands.js';
import {
  ApprovalId,
  BurrowId,
  ConnectionId,
  ConversationId,
  EventId,
  MessageId,
  PrincipalId,
} from '../ids.js';
import { KeyId } from '../keys/catalog.js';
import { Count, Email, JsonObject, Timestamp } from './common.js';
import {
  CalendarEventInput,
  CalendarEventPatch,
  EventTime,
  MailAddress,
  MailAttachmentDigest,
  ShareRole,
} from './workspace.js';

/** pending → approved | declined; undo returns to pending until the action has executed. */
export const ApprovalState = z.enum(['pending', 'approved', 'declined']);
export type ApprovalState = z.infer<typeof ApprovalState>;

/* ---------------------------------------------------------------------------------------------- */
/* Actions: what happens when the approval goes through. Executors are a registry by `type`.        */
/* ---------------------------------------------------------------------------------------------- */

export const DeployAction = z.object({
  type: z.literal('deploy'),
  params: z.object({
    /** `staging` | `production` (other names allowed for custom environments). */
    environment: z.string().min(1).max(40),
    /** Service being rolled out: `billing-api`. */
    service: z.string().min(1).max(80),
    /** Branch or tag: `feat/invoice-pdf`. */
    ref: z.string().min(1).max(255),
    /** Commit to deploy; null = latest commit on `ref` when executing. */
    sha: z.string().min(4).max(64).nullable(),
    repo: z.string().max(255).optional(),
    prNumber: z.number().int().positive().optional(),
  }),
});

export const RefundAction = z.object({
  type: z.literal('refund'),
  params: z.object({
    accountId: z.string().min(1).max(80),
    amountCents: z.number().int().positive(),
    currency: z.literal('EUR'),
    reason: z.string().max(280).optional(),
  }),
});

export const PushSharedBranchAction = z.object({
  type: z.literal('push_shared_branch'),
  params: z.object({ repo: z.string().min(1), branch: z.string().min(1), sha: z.string().min(4).max(64) }),
});

/** How a pull request is merged: a merge commit, one squashed commit, or rebased onto the base (CT-290). */
export const MergeMethod = z.enum(['merge', 'squash', 'rebase']);
export type MergeMethod = z.infer<typeof MergeMethod>;

export const MergePrAction = z.object({
  type: z.literal('merge_pr'),
  params: z.object({
    prNumber: z.number().int().positive(),
    repo: z.string().optional(),
    base: z.string().min(1),
    /** How the yes merges it: what the agent asked for (CT-290). Absent: squash. */
    method: MergeMethod.optional(),
  }),
});

export const MessageExternalAction = z.object({
  type: z.literal('message_external'),
  params: z.object({
    to: z.string().min(1).max(320),
    subject: z.string().max(200).optional(),
    body: z.string(),
  }),
});

/*
 * The agent's actions on a person's own connected account (docs/decisions/connectors.md "Tools"): sending,
 * invites, sharing and trashing always ask the owner first. The executor runs them as the owner's connection
 * once the owner approves. Only the owner sees these approvals (PA-09).
 */

/** The longest email body an owner approves in one card (connectors.md IN-16): the whole body is shown. */
export const MAIL_SEND_BODY_CAP = 20_000;

/** Send a draft from the owner's mailbox. A full message from `mail_send` is drafted first, so there is always a draft. */
export const MailSendAction = z.object({
  type: z.literal('mail_send'),
  params: z.object({
    /** `imap` (0.97, CT-481; CM-26): sent through the account's SMTP server, approved like Gmail. */
    provider: z.enum(['google', 'microsoft', 'imap']).optional(),
    connectionId: z.string().optional(),
    externalAccountId: z.string().optional(),
    attachments: z.array(MailAttachmentDigest).max(10).optional(),
    /** The mailbox it is sent from (`mara@example.com`). */
    connectionEmail: Email,
    to: z.array(MailAddress).min(1).max(100),
    cc: z.array(MailAddress).max(100).default([]),
    /** Blind copies: shown to the owner too, so nobody is copied without them seeing it. */
    bcc: z.array(MailAddress).max(100).default([]),
    subject: z.string().max(998),
    /** The start of the body (the owner's eyes only). */
    bodyPreview: z.string().max(1000),
    /**
     * The whole body as drafted (IN-16): shown in full on the approval, and the executor sends the draft only
     * while its body is exactly this. Absent on approvals stored before it (they compare `bodyPreview`).
     */
    body: z.string().max(MAIL_SEND_BODY_CAP).optional(),
    draftId: z.string().min(1).max(200),
  }),
});

/** Create, change or cancel an event with guests: the provider emails them. */
export const CalendarInviteAction = z.object({
  type: z.literal('calendar_invite'),
  params: z.object({
    provider: z.enum(['google', 'microsoft']).optional(),
    connectionId: z.string().optional(),
    externalAccountId: z.string().optional(),
    op: z.enum(['create', 'update', 'delete']),
    summary: z.string().max(1000),
    start: EventTime,
    end: EventTime,
    /** Everyone the provider emails (the event's guests after the change; for delete, the ones told). */
    guests: z.array(MailAddress).max(200),
    calendarId: z.string().min(1).max(1024).default('primary'),
    /** The event changed or cancelled (update, delete). */
    eventId: z.string().min(1).max(1024).optional(),
    /** The event to create, or the change to make (create, update). */
    event: z.union([CalendarEventInput, CalendarEventPatch]).optional(),
  }),
});

/** Share a file with someone. */
export const FilesShareAction = z.object({
  type: z.literal('files_share'),
  params: z.object({
    provider: z.enum(['google', 'microsoft']).optional(),
    connectionId: z.string().optional(),
    externalAccountId: z.string().optional(),
    fileId: z.string().min(1).max(200),
    fileName: z.string().max(1000),
    email: MailAddress,
    role: ShareRole,
  }),
});

/** Move a file to the trash. */
export const FilesTrashAction = z.object({
  type: z.literal('files_trash'),
  params: z.object({
    provider: z.enum(['google', 'microsoft']).optional(),
    connectionId: z.string().optional(),
    externalAccountId: z.string().optional(),
    fileId: z.string().min(1).max(200),
    fileName: z.string().max(1000),
  }),
});

/**
 * An agent asks for a key it doesn't hold (docs/decisions/key-requests.md): always for itself, always an
 * approval. Decided by whoever may change the agent's keys; once approved the key is given at `can`, clamped
 * to the key's cap.
 */
export const GrantKeyAction = z.object({
  type: z.literal('grant_key'),
  params: z.object({ keyId: KeyId }),
});

/** Any other keyed action; the executor registry must know `name`. */
export const CustomAction = z.object({
  type: z.literal('custom'),
  params: z.object({ name: z.string().min(1).max(80), keyId: KeyId, data: JsonObject }),
});

/**
 * Run one shell command of the agent's that its keys only allow after the person's yes (agent-computer.md AC-41,
 * 0.36.0): created by the server when the runner's guard (`classifyCommand`) finds a consequential command and the
 * category's key (`commandCategoryKey`) is held at ask, never by an agent. The card shows the exact command; the
 * person allows it once, for the task, or always (`approvals.decide` `scope`). `Approval.keyId` is the category's key.
 */
export const RunCommandAction = z.object({
  type: z.literal('run_command'),
  params: z.object({
    /** As the agent's CLI ran it (not normalised). */
    command: z.string().min(1).max(COMMAND_MAX),
    category: CommandCategory,
    /** `classifyCommand`'s target: the production server, the branch, the other machine, the webhook host. */
    target: z.string().max(COMMAND_TARGET_MAX).nullable(),
    /** Why the agent runs it, when it said (the CLI's command description); null otherwise. */
    reason: z.string().max(COMMAND_REASON_MAX).nullable(),
  }),
});

/** Longest `ConnectionCallAction.params.words` (the approval title holds 160 with its capital and “?”). */
export const CONNECTION_CALL_WORDS_MAX = 150;

/**
 * Call one tool of a connected service once (Whombat connections-catalog.md CX-21, contracts 0.48.0): created by the
 * server when `connection_call` runs at Ask (the agent's key or the tool's tier asks, or the call is sensitive, CX-31),
 * never by an agent. Which connection and tool, bound to the tool's definition (`toolHash`: a changed tool needs a new
 * approval) — never the arguments: they stay with the deferred call, bound by the signed action hash, and deciders see
 * them on `Approval.connection.argumentsPreview` (the pack-tool precedent, BP-D14). Since 3.0 (CT-1550) one kind of
 * connection: no `scope`, every one goes to the person.
 * `Approval.keyId` is the key the call needs (`connections.write`, or `connections.read` for a sensitive read).
 */
export const ConnectionCallAction = z.object({
  type: z.literal('connection_call'),
  params: z.object({
    connectionId: ConnectionId,
    /** The handle the agent named it by (`homeassistant`). */
    handle: z.string().min(1).max(32),
    tool: z.string().min(1).max(200),
    /** sha256 hex of the tool's canonical definition when the approval was asked. */
    toolHash: z.string().regex(/^[0-9a-f]{64}$/),
    /**
     * The call in plain words (0.80.1, CT-347), written by the server from exactly this call's arguments, never by the
     * agent: “restart web on pve-02”. The approval's title, question and WHAT HAPPENS say them (“Restart web on
     * pve-02?”) instead of the generic “Use guest_power on servers”. Absent: the generic words (most connections).
     */
    words: z.string().trim().min(1).max(CONNECTION_CALL_WORDS_MAX).optional(),
    /**
     * The server a Servers call names when only the catalog's sensitive rules made it ask and the server could be set
     * to Never ask (0.86, CT-381; Whombat server-asks.md SA-07): `id` the hosts service's, `name` its display name. The
     * person may answer “Don’t ask again on {name}” (`approvals.decide` `scope: 'agent'`). Absent everywhere else.
     */
    server: z.object({ id: z.string().min(1).max(63), name: z.string().min(1).max(120) }).optional(),
  }),
});
export type ConnectionCallAction = z.infer<typeof ConnectionCallAction>;

/** Every action an agent may ask for or perform (`request_approval`, `perform_action`). */
const AGENT_ACTIONS = [
  DeployAction,
  RefundAction,
  PushSharedBranchAction,
  MergePrAction,
  MessageExternalAction,
  CustomAction,
  MailSendAction,
  CalendarInviteAction,
  FilesShareAction,
  FilesTrashAction,
  GrantKeyAction,
] as const;

export const AgentApprovalAction = z.discriminatedUnion('type', [...AGENT_ACTIONS]);
export type AgentApprovalAction = z.infer<typeof AgentApprovalAction>;

export const ApprovalAction = z.discriminatedUnion('type', [
  ...AGENT_ACTIONS,
  RunCommandAction,
  ConnectionCallAction,
]);
export type ApprovalAction = z.infer<typeof ApprovalAction>;
export type ApprovalActionType = ApprovalAction['type'];
export type RunCommandAction = z.infer<typeof RunCommandAction>;

/** Actions only the server creates (never in an agent's `request_approval` or `perform_action`). */
export const SERVER_ONLY_ACTION_TYPES = [
  'run_command',
  'connection_call',
] as const satisfies readonly ApprovalActionType[];

export function isAgentApprovalAction(action: ApprovalAction): action is AgentApprovalAction {
  return !(SERVER_ONLY_ACTION_TYPES as readonly string[]).includes(action.type);
}

/** Action types the agent asks a person for on their own account (connector tools). */
export const PERSONAL_ACTION_TYPES = ['mail_send', 'calendar_invite', 'files_share', 'files_trash'] as const;
export type PersonalActionType = (typeof PERSONAL_ACTION_TYPES)[number];

export function isPersonalAction(
  action: ApprovalAction,
): action is Extract<ApprovalAction, { type: PersonalActionType }> {
  return (PERSONAL_ACTION_TYPES as readonly string[]).includes(action.type);
}

/* ---------------------------------------------------------------------------------------------- */
/* Conditions                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

export const ChecksState = z.enum(['pending', 'running', 'passed', 'failed']);
export type ChecksState = z.infer<typeof ChecksState>;

const ConditionBase = z.object({
  id: z.string().min(1).max(40),
  /** Desktop label ("Checks pass on the latest commit"). Mobile variants come from `conditionLabel()`. */
  label: z.string().min(1).max(160),
  met: z.boolean(),
});

/** "Checks pass on the latest commit" — `38 of 41 · fixing` / `41 of 41`. */
export const ChecksPassCondition = ConditionBase.extend({
  kind: z.literal('checks_pass'),
  prNumber: z.number().int().positive().nullable(),
  /** Head commit the checks ran on. */
  headSha: z.string().min(4).max(64).nullable(),
  state: ChecksState,
  passed: Count,
  total: Count,
  /** A run is working on the branch right now (adds "· fixing"). */
  fixing: z.boolean(),
});

/** "Waffle approves the PR" — `changes requested` / `approved 11:38`. */
export const ReviewApprovedCondition = ConditionBase.extend({
  kind: z.literal('review_approved'),
  prNumber: z.number().int().positive().nullable(),
  reviewerId: PrincipalId,
  reviewState: z.enum(['pending', 'approved', 'changes_requested', 'commented']),
  reviewedAt: Timestamp.nullable(),
});

/** "You say yes" — `you` / `Mara · just now` / `declined`. Met while the approval is approved. */
export const PersonApprovesCondition = ConditionBase.extend({
  kind: z.literal('person_approves'),
  /** The person (since 3.0 there is one, CT-1517; private approvals went). */
  approverIds: z.array(PrincipalId).min(1),
});

export const ApprovalCondition = z.discriminatedUnion('kind', [
  ChecksPassCondition,
  ReviewApprovedCondition,
  PersonApprovesCondition,
]);
export type ApprovalCondition = z.infer<typeof ApprovalCondition>;
export type ChecksPassCondition = z.infer<typeof ChecksPassCondition>;
export type ReviewApprovedCondition = z.infer<typeof ReviewApprovedCondition>;
export type PersonApprovesCondition = z.infer<typeof PersonApprovesCondition>;

/* ---------------------------------------------------------------------------------------------- */
/* Execution                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

export const ExecutionState = z.enum(['idle', 'running', 'succeeded', 'failed']);
export type ExecutionState = z.infer<typeof ExecutionState>;

export const ApprovalExecution = z.object({
  state: ExecutionState,
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  /** Where to see the result, without protocol in copy: `staging.burrowhq.example/invoices/2026-000142.pdf`. */
  resultUrl: z.string().max(2048).nullable(),
  error: z.string().max(1000).nullable(),
});
export type ApprovalExecution = z.infer<typeof ApprovalExecution>;

export const IDLE_EXECUTION: ApprovalExecution = {
  state: 'idle',
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  resultUrl: null,
  error: null,
};

/* ---------------------------------------------------------------------------------------------- */
/* Approval                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * What the person sees on a `connection_call` approval (CX-21): the connection's label and entry, and the call's
 * arguments as a short preview. Not signed: filled on reads and realtime frames.
 */
export const ApprovalConnectionDetail = z.object({
  label: z.string().max(80),
  catalogId: z.string().max(31),
  /** The arguments, compact JSON cut at 1 000 characters; null when the viewer may not see them. */
  argumentsPreview: z.string().max(1000).nullable(),
});
export type ApprovalConnectionDetail = z.infer<typeof ApprovalConnectionDetail>;

export const Approval = z.object({
  id: ApprovalId,
  /** Burrow-wide number, used in links (`?approval=12`). */
  number: z.number().int().positive(),
  burrowId: BurrowId,
  /** The agent asking ("NEO IS ASKING"). */
  requesterId: PrincipalId,
  /** Key that asked (e.g. `deploy.staging`). */
  keyId: KeyId,
  action: ApprovalAction,
  /** A `connection_call` approval's detail for its deciders (0.48.0, CX-21); null or absent otherwise. */
  connection: ApprovalConnectionDetail.nullable().optional(),
  /** Card title: "Deploy feat/invoice-pdf to staging". */
  title: z.string().min(1).max(160),
  /** Modal / mobile question: "Deploy feat/invoice-pdf to staging?". */
  question: z.string().min(1).max(200),
  /** Card header right side: "staging · billing-api". */
  target: z.string().max(120),
  /** WHAT HAPPENS, numbered 01, 02, … */
  whatHappens: z.array(z.string().min(1).max(280)),
  /** Modal explainer on sf2 ("Neo holds a staging key that only turns when a person approves. …"). */
  explainer: z.string().max(600),
  /** One-paragraph summary shown on the mobile approval while pending. */
  summary: z.string().max(600),
  conditions: z.array(ApprovalCondition).min(1),
  state: ApprovalState,
  decidedById: PrincipalId.nullable(),
  decidedAt: Timestamp.nullable(),
  execution: ApprovalExecution,
  /** Set once the action has executed; Undo is no longer possible. */
  executedAt: Timestamp.nullable(),
  /**
   * “Approve later” (0.80, CT-338; one-whombat.md ONE-10): approved to run at this time (“Tonight at 03:00”) instead of
   * at once. Null or absent: it runs when approved.
   */
  executeAt: Timestamp.nullable().optional(),
  conversationId: ConversationId,
  /** The approval card message. */
  messageId: MessageId.nullable(),
  /** The agent and the people told about a decline (“Dusty and Mara have been told”). */
  involvedIds: z.array(PrincipalId),
  /** The signed `Asks` event that created the approval. */
  eventId: EventId.nullable(),
  /**
   * How long a yes to a `run_command` lasts (agent-computer.md AC-42, 0.36.0): `once`, `task` or `agent`, as the person
   * chose with `approvals.decide`; a risk-row action's `once` or `agent`
   * (“Always allow”, 0.44.0, RA-06). Null while pending, after a decline and for every other action.
   */
  scope: CommandScope.nullable().optional(),
  /**
   * sha256 of the canonical {action, deferred input, binding} (automations/hash.ts `actionHash`), signed in the
   * `approval.requested` event. Execution recomputes it and refuses on any difference, so a changed input,
   * commit or automation version needs a new approval. The server writes it on every approval and refuses to
   * approve or run one without it.
   */
  actionHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .optional(),
  createdAt: Timestamp,
});
export type Approval = z.infer<typeof Approval>;
