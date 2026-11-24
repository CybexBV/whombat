/**
 * The records a backup file holds (contracts 0.79, CT-335; Whombat backup-file.md BF-03, BF-04, BF-05): one JSON object
 * per line in `directory.jsonl` and `<category>.jsonl`, discriminated by `type`. Records, not database rows: each holds
 * what a restore needs to recreate the thing through the normal commands, keyed so it can be found again on another box.
 *
 * **Ids.** A record names things by their ids on the box that made the file (`prn_…`, `cnv_…`, `con_…`). They are
 * opaque labels inside the file: `directory.jsonl` (always written, whatever the categories) maps every id a record of
 * the file refers to onto a portable key — the person's email, the agent's handle, a connection's service
 * and address, an automation's name, a Vault entry's kind and name, a repository's name
 * —, and a restore maps each onto the target's own id (found by that key, or made by restoring its record), remembering
 * the pair in its restore map. A reference the target can't resolve is dropped with a note. Never in a record:
 * signing keys, sealed blobs, device ids, sessions, provider sessions, run history, usage, caches (BF-05).
 *
 * **One person (3.0, CT-1512; Whombat one-person.md OP-01).** Everything in the file is the person's: there are no other
 * people's things to leave out, no people to invite and no roles.
 *
 * **Secrets.** Sign-ins are written unsealed (the file is encrypted, BF-06): `secret`, `token`, `refreshToken`,
 * `clientSecret` fields. A restore seals them again under the target's master key, with the new rows' AADs.
 *
 * **Versions.** `BACKUP_SCHEMA_VERSION` counts record-schema changes (`manifest.json`'s `schemaVersion`). Changes stay
 * additive with defaults, so an older file always parses; a reader refuses a file with a higher schema version than
 * its own (`newer_format`), so a field it doesn't know is never silently dropped. A record that doesn't parse is
 * skipped with a note (`unreadable`), never the whole restore.
 */
import { z } from 'zod';
import { COMMAND_MAX, COMMAND_TARGET_MAX } from '../commands/commands.js';
import { FilesFolder } from '../contracts/files.js';
import { HermesHome } from '../contracts/hermes-home.js';
import { AgentFace, AgentProvider, DEFAULT_AGENT_FACE } from '../domain/agent.js';
import { AutomationId, AutomationStatus } from '../domain/automation.js';
import { CanvasProvenance, CommentAnchor } from '../domain/canvas.js';
import { ChatRuntime } from '../domain/chat-runtime.js';
import { Count, Email, Handle, JsonObject, RepoFullName, Sha256Hex, Timestamp } from '../domain/common.js';
import {
  ConnectionAccessLevel,
  ConnectionToolTier,
  ConnectionTransport,
  TokenAuth,
} from '../domain/connections-catalog.js';
import { ChatSubject, ConversationKind } from '../domain/conversation.js';
import { DeviceActionChoice } from '../domain/devices.js';
import { FeedbackAssessmentMode, FeedbackIntake } from '../domain/feedback.js';
import { HostAsksFirst } from '../domain/hosts.js';
import { LOCAL_MODEL_KEY_MAX, LOCAL_MODEL_LABEL_MAX, LOCAL_MODEL_URL_MAX } from '../domain/local-model.js';
import { AGENT_NOTES_MAX } from '../domain/memory.js';
import { AttachmentKind, MessageProvenance } from '../domain/message.js';
import { AgentEffort, ModelId } from '../domain/models.js';
import { ScheduleWhen } from '../domain/schedules.js';
import { ConnectionToolLimits } from '../domain/tool-limits.js';
import { WEB_SEARCH_KEY_MAX, WebSearchProvider } from '../domain/web-search.js';
import {
  AccountId,
  AgentScheduleId,
  AttachmentId,
  BurrowId,
  CanvasId,
  CommentId,
  ConnectionId,
  ConversationId,
  FeedbackIntegrationId,
  MessageId,
  PrincipalId,
  RepoId,
  VaultEntryId,
  VaultSshServerId,
  WidgetId,
} from '../ids.js';
import { KeyScope, Tier } from '../keys/catalog.js';
import { OnePasswordItemId } from '../vault/onepassword.js';
import {
  VAULT_DESCRIPTION_MAX,
  VAULT_NAME_MAX,
  VAULT_SECRET_MAX,
  VAULT_SSH_HOST_MAX,
  VAULT_SSH_PRIVATE_KEY_MAX,
  VAULT_SSH_SERVER_NAME_MAX,
  VAULT_SSH_SERVER_PASSWORD_MAX,
  VAULT_SSH_SERVERS_MAX,
  VAULT_SSH_USERNAME_MAX,
  VAULT_TOOLS_MAX,
  VAULT_URL_MAX,
  VaultAuth,
  VaultEntryKind,
} from '../vault/schemas.js';
import { utf8ToBytes } from './bytes.js';
import { BACKUP_CATEGORY_IDS, BackupCategoryId } from './categories.js';
import { BackupFileError } from './errors.js';

/**
 * The record schemas' version (`manifest.json` → `schemaVersion`). 2 since 0.113 (CT-815): skills are `skill`,
 * `skill_version` and `skill_state` records instead of packs, so a reader from before refuses the file (`newer_format`)
 * rather than skip every skill as unreadable. 3 since 0.117 (CT-902): the `servers` category and the records and
 * fields of BF-19/BF-20 (an older reader would drop servers, devices, task chats and the rest without a word). 4 since
 * 0.124 (CT-1177): the settings' `localModel`, which an older reader would drop. 5 since 0.125 (CT-1245): Hermes keeps
 * memory and skills, so `memories` and `skills` hold its homes as archives (`hermes_home`, `hermes_skills`) and the
 * agent's notes (`agent_notes`); an older reader refuses the file rather than drop them. An older file still parses,
 * as 0.124 read version 3 (CT-1177): its records of Whombat's own memory and skill store (`memory`, `note`, `profile`,
 * `learning`, `skill`, `skill_version`, `skill_state`, `pack…`, `learned_skill`) no longer exist and are left out as
 * unreadable (HE-27). 6 since 3.0 (CT-1512; Whombat one-person.md OP-11): one person — the `people` category is
 * `settings` (no `person` or `invite` records), no roles, owners, `left` people or the agent's credential source, a
 * `hermes_home` per home (`home` for `person`), and the skills are the profile's `skills/`; an older reader refuses the file. An older
 * file doesn't restore here (its `people` category is unknown, HE-27).
 */
export const BACKUP_SCHEMA_VERSION = 6;
/** Longest line of a `.jsonl` entry, bytes (a message with a big card, an automation definition). */
export const BACKUP_RECORD_MAX_BYTES = 4 * 1024 * 1024;

const rec = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...shape });

/** A display name or label. */
const Name = z.string().min(1).max(200);
/** Free text with a bound. */
const Text = (max: number) => z.string().max(max);
/** A key id of the keys catalog, as text (a grant of a key this Whombat no longer knows is skipped on restore). */
const KeyText = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9_.-]*$/);
/** A catalog id or a sign-in kind, as text (a newer catalog's entries parse; restore checks them). */
const Slug = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/);
/** A task chat's key (`conversations.task_key`): `feedback` for the Feedback room, a task chat's own key otherwise. */
const TaskKeyText = z.string().min(1).max(200);
/**
 * What a task chat or a thread is about (0.117, CT-904): a server (the hosts service's id), a connection (a source id) or
 * a device, with its name then. `ChatSubject`'s shape, an empty name allowed.
 */
export const BackupChatSubject = z.object({
  kind: ChatSubject.shape.kind,
  id: z.string().min(1).max(200),
  name: z.string().max(120).default(''),
});
export type BackupChatSubject = z.infer<typeof BackupChatSubject>;
/** A task chat's own fields (0.117, CT-904), on its directory entry and its `conversation` record. */
const chatFields = {
  /** A task chat with the person's Whombat (a `dm` with a key; the Feedback room is `feedback`); null: no task chat. */
  taskKey: TaskKeyText.nullable().default(null),
  chatTitle: z.string().min(1).max(200).nullable().default(null),
  chatSubject: BackupChatSubject.nullable().default(null),
  chatArchivedAt: Timestamp.nullable().default(null),
};
/** Bytes kept in the file under `files/<sha256>` (`backupEntryName.blob`). */
export const BackupBlobRef = z.object({ sha256: Sha256Hex, size: Count });
export type BackupBlobRef = z.infer<typeof BackupBlobRef>;

/* Directory (`directory.jsonl`, always written) --------------------------------------------------------------- */

/**
 * One id the file refers to, with the key that finds it on another box. The first line is the source `burrow`. The
 * person is matched by email (else the target's own person: the history keeps its author's name), the agent is the
 * target's own, automations by name, conversations by kind and slug (the person's rooms by their kind), connections by
 * service, address or account, repositories by name, Vault entries by kind and name, SSH servers by entry and name,
 * canvases by slug.
 */
export const BackupDirectoryEntry = z.discriminatedUnion('type', [
  rec('burrow', { id: BurrowId, name: Name, slug: Name, timeZone: z.string().min(1).max(64) }),
  rec('person', {
    id: PrincipalId,
    accountId: AccountId.nullable().default(null),
    email: Email,
    name: Name,
    handle: Handle,
  }),
  /** The agent: there is one, so it matches the target's own. */
  rec('agent', { id: PrincipalId, handle: Handle, name: Name }),
  /** A system signer (`github`, `feedback`): matched by `system`. */
  rec('system', { id: PrincipalId, system: Slug, name: Name, handle: Handle }),
  /** An automation and its own principal (what signs its steps). */
  rec('automation', { id: AutomationId, principalId: PrincipalId, name: Name }),
  rec('conversation', {
    id: ConversationId,
    kind: ConversationKind,
    slug: Name,
    title: Name,
    /** A person's room with the agent: whose. */
    dm: z.object({ person: PrincipalId }).nullable().default(null),
    /** 0.117 (CT-904): a DM is matched by its person and task key; a task chat keeps its title and subject. */
    ...chatFields,
  }),
  rec('connection', {
    id: ConnectionId,
    /** `catalog` (catalog_connections) or `connector` (a person's Google or Microsoft account). */
    source: z.enum(['catalog', 'connector']),
    /** The catalog id (`homeassistant`) or the connector provider (`google`). */
    service: Slug,
    handle: Handle.nullable().default(null),
    label: Name,
    /** The base URL a catalog connection reaches (null: none, e.g. a cloud service's fixed address). */
    address: z.string().max(2000).nullable().default(null),
    /** A connector account's own email. */
    account: z.string().max(320).nullable().default(null),
  }),
  rec('repo', { id: RepoId, fullName: RepoFullName, source: z.enum(['github', 'local']) }),
  rec('vault_entry', { id: VaultEntryId, kind: VaultEntryKind, name: Name }),
  rec('vault_ssh_server', { id: VaultSshServerId, entry: VaultEntryId, name: Name }),
  rec('canvas', { id: CanvasId, slug: Name, title: Name }),
]);
export type BackupDirectoryEntry = z.infer<typeof BackupDirectoryEntry>;

/* Agents (`agents.jsonl`) ------------------------------------------------------------------------------------- */

export const BackupAgentRuntime = z.object({
  provider: AgentProvider,
  model: z.string().min(1).max(200).nullable().default(null),
  backgroundModel: z.string().min(1).max(200).nullable().default(null),
  effort: AgentEffort.nullable().default(null),
  /** Fast replies (0.117, CT-904): null as the model says. */
  fast: z.boolean().nullable().default(null),
});
export type BackupAgentRuntime = z.infer<typeof BackupAgentRuntime>;

/** A key the agent holds. `scope.connections` holds source ids. */
export const BackupGrant = z.object({ keyId: KeyText, tier: Tier, scope: KeyScope.nullable().default(null) });
export type BackupGrant = z.infer<typeof BackupGrant>;

export const BackupAgentRecord = rec('agent', {
  id: PrincipalId,
  handle: Handle,
  name: z.string().min(1).max(80),
  face: AgentFace.default(DEFAULT_AGENT_FACE),
  runtime: BackupAgentRuntime,
  grants: z.array(BackupGrant).max(200).default([]),
  createdAt: Timestamp,
});
export type BackupAgentRecord = z.infer<typeof BackupAgentRecord>;

/** A turn an agent scheduled for itself (RA-30). Comes back paused (BF-07). */
export const BackupScheduleRecord = rec('schedule', {
  id: AgentScheduleId,
  agent: PrincipalId,
  conversation: ConversationId,
  /** Its thread's root; restored only together with the message (else it runs at the top level). */
  threadRoot: MessageId.nullable().default(null),
  prompt: Text(4000),
  when: ScheduleWhen,
  /** As it was; a restore pauses an active one. */
  status: z.enum(['active', 'paused']),
  endsAt: Timestamp.nullable().default(null),
  createdAt: Timestamp,
});
export type BackupScheduleRecord = z.infer<typeof BackupScheduleRecord>;

/** The maker's own morning briefing, in files from before the brief was removed. Read and skipped on restore. */
export const BackupBriefingRecord = rec('briefing', {
  agent: PrincipalId,
  cron: z.string().min(1).max(40),
  timeZone: z.string().min(1).max(64),
  enabled: z.boolean(),
});
export type BackupBriefingRecord = z.infer<typeof BackupBriefingRecord>;

/**
 * A command a person always allows an agent (AC-42, “Always allow”; 0.117, CT-904): the key it needs, the normalised
 * command and its target. Restored only for an agent that comes back, by a person who is here.
 */
export const BackupCommandAllowanceRecord = rec('command_allowance', {
  agent: PrincipalId,
  keyId: KeyText,
  command: z.string().min(1).max(COMMAND_MAX),
  target: z.string().max(COMMAND_TARGET_MAX).nullable().default(null),
  createdBy: PrincipalId.nullable().default(null),
  createdAt: Timestamp,
});
export type BackupCommandAllowanceRecord = z.infer<typeof BackupCommandAllowanceRecord>;

export const BackupAgentsLine = z.discriminatedUnion('type', [
  BackupAgentRecord,
  BackupScheduleRecord,
  BackupBriefingRecord,
  BackupCommandAllowanceRecord,
]);
export type BackupAgentsLine = z.infer<typeof BackupAgentsLine>;

/* Memories (`memories.jsonl`) --------------------------------------------------------------------------------- */

/**
 * An archive in the file (`files/<sha256>`, `backupEntryName.blob`): a Hermes home or the shared skills, a gzipped ustar
 * as the runner's Hermes-home service exports it (`home.exportBegin`, `HERMES_HOME_METHODS`), restored with
 * `home.importBegin`…`home.importCommit`.
 */
export const BackupHermesArchive = BackupBlobRef.extend({ files: Count });
export type BackupHermesArchive = z.infer<typeof BackupHermesArchive>;

/**
 * A Hermes home (0.125, CT-1245; Whombat hermes-engine.md HE-38…HE-40; since 3.0 CT-1512): `person` — what the agent
 * remembers about working with the person and about them, and their sessions; `outside` — the outside turns' sessions
 * (OP-17). One archive each (`HermesHomeRef` `{kind: 'profile', home}`, without `skills/`, which is the `skills`
 * category's).
 */
export const BackupHermesHomeRecord = rec('hermes_home', {
  home: HermesHome,
  archive: BackupHermesArchive,
});
export type BackupHermesHomeRecord = z.infer<typeof BackupHermesHomeRecord>;

/** The agent's notes the person writes (0.125, CT-1245; HE-39). */
export const BackupAgentNotesRecord = rec('agent_notes', {
  text: z.string().max(AGENT_NOTES_MAX),
  updatedAt: Timestamp,
});
export type BackupAgentNotesRecord = z.infer<typeof BackupAgentNotesRecord>;

export const BackupMemoriesLine = z.discriminatedUnion('type', [
  BackupHermesHomeRecord,
  BackupAgentNotesRecord,
]);
export type BackupMemoriesLine = z.infer<typeof BackupMemoriesLine>;

/* Automations (`automations.jsonl`) --------------------------------------------------------------------------- */

/** An automation's key, as `AutomationGrant` with text key ids and source connection ids. */
export const BackupAutomationGrant = z.object({
  keyId: KeyText,
  tier: z.enum(['can', 'ask', 'cannot']),
  repos: z.array(z.string().min(3).max(255)).max(20).nullable().default(null),
  connections: z.array(ConnectionId).max(20).nullable().default(null),
});
export type BackupAutomationGrant = z.infer<typeof BackupAutomationGrant>;

/**
 * A not-deleted automation (BF-05). `definition` is the published version's definition and `draft` the saved draft,
 * both as stored (JSON with source ids; a restore remaps them with `remapBackupIds` and validates them with the current
 * rules — a definition that no longer validates comes back as a draft). Never the webhook secret, runs or cursors. A
 * restore brings a published one back switched off (BF-07).
 */
export const BackupAutomationRecord = rec('automation', {
  id: AutomationId,
  principal: PrincipalId,
  name: z.string().min(1).max(80),
  description: Text(500).default(''),
  status: AutomationStatus,
  version: z.number().int().positive().nullable().default(null),
  definition: JsonObject.nullable().default(null),
  draft: JsonObject.nullable().default(null),
  createdBy: PrincipalId,
  publishedBy: PrincipalId.nullable().default(null),
  grants: z.array(BackupAutomationGrant).max(20).default([]),
  /** It had an inbound webhook switched on (a restore makes a new URL and secret only when it is switched on). */
  webhook: z.boolean().default(false),
  /** What it does in one sentence, as the maker's Whombat said it (shown in the preview). */
  summary: Text(500).default(''),
  /** Its list tags (`AutomationDoes` ids), informational. */
  tags: z.array(z.string().min(1).max(40)).max(16).default([]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type BackupAutomationRecord = z.infer<typeof BackupAutomationRecord>;

/** An `http_callback` destination the person approved. */
export const BackupDestinationRecord = rec('destination', {
  url: z.string().min(1).max(2000),
  approvedBy: PrincipalId,
  approvedAt: Timestamp,
});
export type BackupDestinationRecord = z.infer<typeof BackupDestinationRecord>;

export const BackupAutomationsLine = z.discriminatedUnion('type', [
  BackupAutomationRecord,
  BackupDestinationRecord,
]);
export type BackupAutomationsLine = z.infer<typeof BackupAutomationsLine>;

/* Connections (`connections.jsonl`) --------------------------------------------------------------------------- */

/** A catalog connection's sign-in, unsealed. Absent fields: that kind of connection has none. */
export const BackupConnectionCredential = z.object({
  /** A token or app password (`token` sign-in). */
  secret: z.string().min(1).max(8000).nullable().default(null),
  /** Fusebox's client key Whombat made (AIG-02): box-bound in practice; checked after restore. */
  clientSecret: z.string().min(1).max(8000).nullable().default(null),
  refreshToken: z.string().min(1).max(8000).nullable().default(null),
  accessToken: z.string().min(1).max(8000).nullable().default(null),
  accessExpiresAt: Timestamp.nullable().default(null),
  /** The OAuth client registered for MCP sign-in (CX-13), by issuer; null: the admin app. */
  oauthClient: z
    .object({
      issuer: z.string().min(1).max(2000),
      clientId: z.string().min(1).max(500),
      clientSecret: z.string().min(1).max(2000).nullable().default(null),
      redirectUri: z.string().min(1).max(2000),
      method: z.enum(['dcr', 'metadata']),
    })
    .nullable()
    .default(null),
  issuer: z.string().max(2000).nullable().default(null),
  resource: z.string().max(2000).nullable().default(null),
  scopes: z.array(z.string().min(1).max(500)).max(100).default([]),
  externalName: z.string().max(320).nullable().default(null),
});
export type BackupConnectionCredential = z.infer<typeof BackupConnectionCredential>;

/**
 * What a connection runs on (CP-08; 0.117, CT-904): `none`, or a server (the hosts service's id) or one of its guests.
 * Null on the record: Whombat finds it by the address (`auto`).
 */
export const BackupRunsOn = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({
    mode: z.literal('chosen'),
    serverId: z.string().min(1).max(100),
    guestId: z.string().min(1).max(200).nullable().default(null),
  }),
]);
export type BackupRunsOn = z.infer<typeof BackupRunsOn>;

/**
 * A device a connection reads (`device_skills`, ONE-18; 0.117, CT-904): its profile (`DeviceProfile`, validated again
 * on restore), where it is, and the owner's choices per action (tiers and limits). Never its remembered sign-in token
 * (BF-22).
 */
export const BackupDevice = z.object({
  name: Name,
  profile: JsonObject,
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65_535),
  unitId: z.number().int().min(0).max(255).nullable().default(null),
  choices: z.record(z.string().min(1).max(200), DeviceActionChoice).nullable().default(null),
});
export type BackupDevice = z.infer<typeof BackupDevice>;

/**
 * A catalog connection (CX-17; since 3.0 one kind, CT-1550). Matched by service and address, else by handle. Every restored connection is checked afterwards; one that fails
 * shows under Connections → Needs you (BF-06). Built-in ones (`builtin`: the Servers connection `whombat_servers` and
 * devices, 0.117) are never signed in again nor checked (BF-19): Servers is matched with the one this Whombat made (never
 * added), a device comes back with its `device`.
 */
export const BackupConnectionRecord = rec('connection', {
  id: ConnectionId,
  catalogId: Slug,
  connectedBy: PrincipalId.nullable().default(null),
  label: Name,
  handle: Handle,
  transport: ConnectionTransport,
  signIn: Slug,
  baseUrl: z.string().max(2000),
  fields: z.record(z.string().max(80), z.string().max(2000)).default({}),
  auth: TokenAuth.nullable().default(null),
  access: ConnectionAccessLevel.default('manage'),
  /** Tool tiers people chose (by tool name and definition hash), and since 0.117 their limits (CT-904). */
  tools: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        tier: ConnectionToolTier,
        hash: z.string().max(128),
        limits: ConnectionToolLimits.nullable().default(null),
      }),
    )
    .max(256)
    .default([]),
  credential: BackupConnectionCredential.nullable().default(null),
  /** 0.117 (CT-904): what it runs on (null: found by its address). */
  runsOn: BackupRunsOn.nullable().default(null),
  /** 0.117 (CT-904): a built-in connection (`whombat_servers`, `device`), never signed in again (BF-19). */
  builtin: z.boolean().default(false),
  /** 0.117 (CT-904): a `device` connection's device. */
  device: BackupDevice.nullable().default(null),
  /** 0.117 (CT-904): its sign-in couldn't be read when the file was made; it comes back needing one. */
  needsSignIn: z.boolean().default(false),
  createdAt: Timestamp,
});
export type BackupConnectionRecord = z.infer<typeof BackupConnectionRecord>;

/**
 * The person's Google or Microsoft account (CN-04). Google tokens from another OAuth client fail their
 * check after restore (“Sign in again”). Since 0.117 (CT-904) one whose token couldn't be read is in the file too, with
 * `needsSignIn` and no `refreshToken`.
 */
export const BackupConnectorAccountRecord = rec('connector_account', {
  id: ConnectionId,
  provider: Slug,
  externalId: z.string().min(1).max(200),
  email: z.string().min(1).max(320),
  name: Text(200).default(''),
  services: z.array(Slug).max(20).default([]),
  scopes: z.array(z.string().min(1).max(500)).max(100).default([]),
  refreshToken: z.string().min(1).max(8000).nullable().default(null),
  needsSignIn: z.boolean().default(false),
  grantedAt: Timestamp,
});
export type BackupConnectorAccountRecord = z.infer<typeof BackupConnectorAccountRecord>;

/**
 * An OAuth client an admin set up for a provider (CN-02, CX-14), with its secret. Since 0.117 (CT-904) one whose secret
 * couldn't be read has `needsSignIn` and no `clientSecret`.
 */
export const BackupConnectorAppRecord = rec('connector_app', {
  provider: Slug,
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().min(1).max(2000).nullable().default(null),
  userType: z.enum(['external', 'internal']).default('external'),
  needsSignIn: z.boolean().default(false),
});
export type BackupConnectorAppRecord = z.infer<typeof BackupConnectorAppRecord>;

/** A feedback integration (a connected system's source, a tracker's before TA-20), with its API token. */
export const BackupFeedbackSourceRecord = rec('feedback_source', {
  id: FeedbackIntegrationId,
  intake: FeedbackIntake,
  assessment: FeedbackAssessmentMode,
  /** The person's Feedback room it posts in. */
  conversation: ConversationId,
  /** `FeedbackIntegrationSettings` with source ids (validated again on restore). */
  settings: JsonObject,
  token: z.string().min(1).max(8000).nullable().default(null),
  /** 0.117 (CT-904): it had a token that couldn't be read when the file was made. */
  needsSignIn: z.boolean().default(false),
});
export type BackupFeedbackSourceRecord = z.infer<typeof BackupFeedbackSourceRecord>;

/** The burrow's GitHub connection (Settings → Connections → GitHub), with the sign-in only when it is the maker's. */
export const BackupGitHubRecord = rec('github', {
  login: z.string().min(1).max(100).nullable().default(null),
  connectedBy: Email,
  /** The maker's GitHub token (gh's `hosts.yml` `oauth_token`); null when the connection is someone else's. */
  token: z.string().min(1).max(2000).nullable().default(null),
});
export type BackupGitHubRecord = z.infer<typeof BackupGitHubRecord>;

export const BackupConnectionsLine = z.discriminatedUnion('type', [
  BackupConnectionRecord,
  BackupConnectorAccountRecord,
  BackupConnectorAppRecord,
  BackupFeedbackSourceRecord,
  BackupGitHubRecord,
]);
export type BackupConnectionsLine = z.infer<typeof BackupConnectionsLine>;

/* Skills (`skills.jsonl`) ------------------------------------------------------------------------------------- */

/**
 * The skills (0.125, CT-1245; HE-41; since 2.0 Hermes's, HSK-02; since 3.0 the person's profile's `skills/`, OP-08,
 * CT-1512): one archive (`HermesHomeRef` `{kind: 'skills'}`) — what the person installed from Hermes's hub (with
 * Hermes's hub lock), what the agent learned, Hermes's built-ins changed, and which are off or removed (the target's
 * own Hermes brings its built-ins, `skills.sync`). `skills` counts them.
 */
export const BackupHermesSkillsRecord = rec('hermes_skills', {
  skills: Count,
  archive: BackupHermesArchive,
});
export type BackupHermesSkillsRecord = z.infer<typeof BackupHermesSkillsRecord>;

export const BackupSkillsLine = z.discriminatedUnion('type', [BackupHermesSkillsRecord]);
export type BackupSkillsLine = z.infer<typeof BackupSkillsLine>;

/* Settings (`settings.jsonl`; `people.jsonl` until 3.0, CT-1512) -------------------------------------------- */

/**
 * The burrow's settings. Its name and slug are the target's own and never change on restore (shown in the preview
 * only); the rest follows “When something is different”.
 */
export const BackupSettingsRecord = rec('settings', {
  name: Name,
  slug: Name,
  timeZone: z.string().min(1).max(64),
  linkPreviews: z.boolean().default(true),
  agentsReachLan: z.boolean().default(true),
  /** The AI gateway's switches (AIG-05), its connection by source id. */
  aiGateway: z
    .object({ connection: ConnectionId, claude: z.boolean(), codex: z.boolean() })
    .nullable()
    .default(null),
  /**
   * The model on the person's network (0.124, CT-1177): its base URL, model, name and API key (`secret`, unsealed like
   * every secret here). A restore puts it back as it was, untested.
   */
  localModel: z
    .object({
      baseUrl: z.string().min(1).max(LOCAL_MODEL_URL_MAX),
      model: ModelId,
      label: z.string().max(LOCAL_MODEL_LABEL_MAX).nullable().default(null),
      secret: z.string().min(1).max(LOCAL_MODEL_KEY_MAX).nullable().default(null),
    })
    .nullable()
    .default(null),
  /**
   * Web search's Brave Search key (Whombat web-search.md): a restore puts it back untested when the box has none. An
   * older reader leaves it out (it starts without web search), so the schema version stays.
   */
  webSearch: z
    .object({ provider: WebSearchProvider, secret: z.string().min(1).max(WEB_SEARCH_KEY_MAX) })
    .nullable()
    .default(null),
  /** The burrow's backup defaults (null: never set, `BACKUP_DEFAULT_CATEGORIES`). Eleven ids since 0.117. */
  backupDefaults: z.array(BackupCategoryId).max(BACKUP_CATEGORY_IDS.length).nullable().default(null),
  /** This Whombat's home network list (VT-12). */
  homeNetworks: z
    .array(
      z.object({
        cidr: z.string().min(1).max(64),
        ports: z.array(z.number().int().min(1).max(65535)).max(16),
        note: Text(200).default(''),
      }),
    )
    .max(32)
    .default([]),
});
export type BackupSettingsRecord = z.infer<typeof BackupSettingsRecord>;

/** A connected repository's settings (GitHub ones; a local one's history is in `repositories`). Matched by name. */
export const BackupRepoRecord = rec('repo', {
  id: RepoId,
  fullName: RepoFullName,
  source: z.enum(['github', 'local']),
  enabled: z.boolean(),
  defaultBranch: z.string().min(1).max(255).default('main'),
  description: Text(1000).default(''),
  position: z.number().int().default(0),
});
export type BackupRepoRecord = z.infer<typeof BackupRepoRecord>;

/**
 * A widget the person pinned (ONE-09; 0.117, CT-904): where (`thing`: on a thing's page, `connection:con_…` with
 * a source id, `device:…`, `server:<id>`; null on Home), what it reads (`WidgetSource`: a connection's tool, by source
 * id, or a server's metrics) and how it looks. Its points are not kept: it refreshes.
 */
export const BackupWidgetRecord = rec('widget', {
  id: WidgetId,
  thing: z.string().min(3).max(220).nullable().default(null),
  title: z.string().min(1).max(80),
  subtitle: z.string().max(120).nullable().default(null),
  kind: z.string().min(1).max(20).default('line'),
  /** `WidgetSource`, validated again on restore. */
  source: JsonObject,
  /** `WidgetSeries[]`, validated again on restore. */
  series: z.array(JsonObject).min(1).max(3),
  refreshSec: z.number().int().positive().max(86_400).default(300),
  position: z.number().int().default(0),
  fromConversation: ConversationId.nullable().default(null),
  createdAt: Timestamp,
});
export type BackupWidgetRecord = z.infer<typeof BackupWidgetRecord>;

/**
 * The person's account settings (0.117, CT-904; BF-20): their preferences (`Preferences`, validated again on restore)
 * and their photo (bytes under `files/<sha256>`).
 */
export const BackupAccountProfileRecord = rec('account_profile', {
  preferences: JsonObject.nullable().default(null),
  photo: z
    .object({
      sha256: Sha256Hex,
      size: Count,
      contentType: z.string().min(1).max(255),
      width: z.number().int().positive().nullable().default(null),
      height: z.number().int().positive().nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type BackupAccountProfileRecord = z.infer<typeof BackupAccountProfileRecord>;

export const BackupSettingsLine = z.discriminatedUnion('type', [
  BackupSettingsRecord,
  BackupRepoRecord,
  BackupWidgetRecord,
  BackupAccountProfileRecord,
]);
export type BackupSettingsLine = z.infer<typeof BackupSettingsLine>;

/* Your Vault (`vault.jsonl`) ---------------------------------------------------------------------------------- */

/**
 * One of the person's Vault entries with its secret (an `ssh` entry's private key), its tools' on/off (`mcp`), the keys
 * agents hold to it (by agent) and its SSH servers with their trusted host keys. Matched by kind and name. Since 0.117 (CT-904) its bounds are the Vault's own (`VAULT_*`), and its one-time-code secret
 * (`totp`) comes along; since 3.14 that is a login's authenticator key in `vaultTotpCanonical`'s form,
 * and a server's kept password comes too.
 */
export const BackupVaultEntryRecord = rec('vault_entry', {
  id: VaultEntryId,
  kind: VaultEntryKind,
  name: z.string().min(1).max(VAULT_NAME_MAX),
  description: Text(VAULT_DESCRIPTION_MAX).default(''),
  url: z.string().max(VAULT_URL_MAX).nullable().default(null),
  auth: VaultAuth.nullable().default(null),
  secret: z
    .string()
    .min(1)
    .max(Math.max(VAULT_SECRET_MAX, VAULT_SSH_PRIVATE_KEY_MAX))
    .nullable()
    .default(null),
  /** The entry's one-time-code (TOTP) secret, unsealed; null: none. */
  totp: z.string().min(1).max(VAULT_SECRET_MAX).nullable().default(null),
  tools: z
    .array(z.object({ name: z.string().min(1).max(200), enabled: z.boolean(), hash: z.string().max(128) }))
    .max(VAULT_TOOLS_MAX)
    .default([]),
  /** The entry switched on for the agent (CT-1240): null while it is off. */
  key: z
    .object({
      envName: z.string().min(1).max(100).nullable().default(null),
      /** An `ssh` key's servers; null: all of them. */
      servers: z.array(VaultSshServerId).max(VAULT_SSH_SERVERS_MAX).nullable().default(null),
    })
    .nullable()
    .default(null),
  sshServers: z
    .array(
      z.object({
        id: VaultSshServerId,
        name: z.string().min(1).max(VAULT_SSH_SERVER_NAME_MAX),
        host: z.string().min(1).max(VAULT_SSH_HOST_MAX),
        port: z.number().int().min(1).max(65535),
        username: z.string().min(1).max(VAULT_SSH_USERNAME_MAX),
        production: z.boolean().default(false),
        /**
         * The server's kept password, unsealed (3.14; Whombat vault-simplify.md); null: the key alone.
         */
        password: z.string().min(1).max(VAULT_SSH_SERVER_PASSWORD_MAX).nullable().default(null),
        /** The trusted host key (“Trust this server”); null: not trusted yet. */
        hostKey: z
          .object({
            algorithm: z.string().min(1).max(100),
            fingerprint: z.string().min(1).max(200),
            blob: z.string().min(1).max(8000).nullable().default(null),
          })
          .nullable()
          .default(null),
      }),
    )
    .max(VAULT_SSH_SERVERS_MAX)
    .default([]),
  /**
   * The 1Password item the entry was kept in step with (docs/decisions/onepassword-sync.md). Restoring relinks the
   * entry to it, without a base, when the connection is there and the item in its vault, so 1Password's newer version
   * wins at the next pass. Absent: a Whombat-only entry, or a file from before.
   */
  onepasswordItemId: OnePasswordItemId.optional(),
  createdAt: Timestamp,
});
export type BackupVaultEntryRecord = z.infer<typeof BackupVaultEntryRecord>;

export const BackupVaultLine = z.discriminatedUnion('type', [BackupVaultEntryRecord]);
export type BackupVaultLine = z.infer<typeof BackupVaultLine>;

/* Messages (`messages.jsonl`) --------------------------------------------------------------------------------- */

/** A conversation whose messages the file holds (first, before its messages), so the category restores on its own. */
export const BackupConversationRecord = rec('conversation', {
  id: ConversationId,
  kind: ConversationKind,
  slug: Name,
  title: Name,
  topic: Text(500).default(''),
  /** A person's room with the agent: whose. */
  dm: z.object({ person: PrincipalId }).nullable().default(null),
  linkPreviews: z.boolean().nullable().default(null),
  /** A branch room's repository and pull request. */
  repo: RepoId.nullable().default(null),
  prNumber: z.number().int().positive().nullable().default(null),
  archived: z.boolean().default(false),
  /** 0.117 (CT-904): a task chat or the Feedback room, as it was (BF-19). */
  ...chatFields,
  createdAt: Timestamp,
});
export type BackupConversationRecord = z.infer<typeof BackupConversationRecord>;

/** A file on a message: its bytes under `files/<sha256>`. */
export const BackupAttachment = z.object({
  id: AttachmentId,
  name: z.string().min(1).max(255),
  contentType: z.string().min(1).max(255),
  kind: AttachmentKind,
  size: Count,
  sha256: Sha256Hex,
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  /** In the conversation's Files: its folder; null when it isn't in Files. */
  folder: FilesFolder.nullable().default(null),
});
export type BackupAttachment = z.infer<typeof BackupAttachment>;

/**
 * A message (thread roots before their replies; each conversation's messages oldest first). Its author keeps its
 * original id in the directory: mapped by handle or email on restore, an unknown one kept as a name (BF-07). Restored
 * messages keep their time. Matched by the restore map only (a second restore of the same file adds nothing).
 */
export const BackupMessageRecord = rec('message', {
  id: MessageId,
  conversation: ConversationId,
  author: PrincipalId,
  /** The author's name, for an author the target can't map. */
  authorName: Name,
  createdAt: Timestamp,
  editedAt: Timestamp.nullable().default(null),
  text: Text(200_000),
  mentions: z.array(PrincipalId).max(200).default([]),
  /** The stored card (`StoredCard`), validated again on restore (a card about a run or plan that isn't restored is left out). */
  card: JsonObject.nullable().default(null),
  suggestions: z.array(z.string().max(200)).max(10).default([]),
  threadRoot: MessageId.nullable().default(null),
  attachments: z.array(BackupAttachment).max(10).default([]),
  reactions: z
    .array(z.object({ value: z.string().min(1).max(64), by: z.array(PrincipalId).max(500) }))
    .max(100)
    .default([]),
  pinned: z.object({ at: Timestamp, by: PrincipalId }).nullable().default(null),
  /** A deleted thread root kept for its replies (text and files gone). */
  deleted: z.boolean().default(false),
  provenance: MessageProvenance.nullable().default(null),
  /**
   * Posted by a run outsiders' input started (`messages.outsiders_run` on the server). A release before it drops the
   * key, as every record drops a member it doesn't know.
   */
  outsidersRun: z.boolean().default(false),
  /** Link previews as shown (`LinkPreview[]`). */
  previews: z.array(JsonObject).max(3).nullable().default(null),
  /** What a Chat thread is about (0.117, CT-904): its first message's subject chip. */
  subject: BackupChatSubject.nullable().default(null),
});
export type BackupMessageRecord = z.infer<typeof BackupMessageRecord>;

/** A canvas in an included conversation: its Yjs state under `canvases/<id>.yjs` (`ydoc`), else its Markdown. */
export const BackupCanvasRecord = rec('canvas', {
  id: CanvasId,
  slug: Name,
  title: Name,
  conversation: ConversationId.nullable().default(null),
  markdown: Text(1_000_000).default(''),
  ydoc: BackupBlobRef.nullable().default(null),
  provenance: CanvasProvenance,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type BackupCanvasRecord = z.infer<typeof BackupCanvasRecord>;

/**
 * A Chat thread's choice of what answers (CR-02; 0.117, CT-904): its first message (after it in the file), the
 * provider, model, effort and fast replies. A model this Whombat doesn't offer is dropped on restore.
 */
export const BackupChatThreadRuntimeRecord = rec('chat_thread_runtime', {
  root: MessageId,
  conversation: ConversationId,
  runtime: ChatRuntime,
  setBy: PrincipalId.nullable().default(null),
  setAt: Timestamp,
});
export type BackupChatThreadRuntimeRecord = z.infer<typeof BackupChatThreadRuntimeRecord>;

/**
 * A side comment on a canvas of the file (0.117, CT-904; after its canvas): anchored roots, replies by `parent`. Its
 * author is mapped like a message's, else kept as a name.
 */
export const BackupCanvasCommentRecord = rec('canvas_comment', {
  id: CommentId,
  canvas: CanvasId,
  anchor: CommentAnchor.nullable().default(null),
  parent: CommentId.nullable().default(null),
  author: PrincipalId,
  authorName: Name,
  text: z.string().min(1).max(4000),
  resolved: z.boolean().default(false),
  createdAt: Timestamp,
});
export type BackupCanvasCommentRecord = z.infer<typeof BackupCanvasCommentRecord>;

export const BackupMessagesLine = z.discriminatedUnion('type', [
  BackupConversationRecord,
  BackupMessageRecord,
  BackupCanvasRecord,
  BackupChatThreadRuntimeRecord,
  BackupCanvasCommentRecord,
]);
export type BackupMessagesLine = z.infer<typeof BackupMessagesLine>;

/* Files (`files.jsonl`) --------------------------------------------------------------------------------------- */

/**
 * A file in a conversation's Files (saved straight into Files, or a message's file someone saved): its bytes under
 * `files/<sha256>`. One on a message that isn't restored comes back saved straight into Files.
 */
export const BackupFileRecord = rec('file', {
  id: AttachmentId,
  conversation: ConversationId,
  message: MessageId.nullable().default(null),
  name: z.string().min(1).max(255),
  contentType: z.string().min(1).max(255),
  kind: AttachmentKind,
  size: Count,
  sha256: Sha256Hex,
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  folder: FilesFolder.default(''),
  uploadedBy: PrincipalId,
  filedBy: PrincipalId.nullable().default(null),
  addedAt: Timestamp,
});
export type BackupFileRecord = z.infer<typeof BackupFileRecord>;

export const BackupFilesLine = z.discriminatedUnion('type', [BackupFileRecord]);
export type BackupFilesLine = z.infer<typeof BackupFilesLine>;

/* Repositories (`repositories.jsonl`) ------------------------------------------------------------------------- */

/** A repository's name on the Whombat (its bare origin `<name>.git`) and in the file (`repositories/<name>.bundle`). */
export const BackupRepositoryName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/)
  .refine((v) => !v.endsWith('.git') && !v.includes('..'), 'A plain repository name.');

/** A repository hosted on the Whombat: a git bundle of all its refs (`git bundle create --all`). Matched by name. */
export const BackupRepositoryRecord = rec('repository', {
  id: RepoId,
  name: BackupRepositoryName,
  fullName: RepoFullName,
  defaultBranch: z.string().min(1).max(255).default('main'),
  description: Text(1000).default(''),
  bundle: BackupBlobRef,
  refs: Count.default(0),
  createdAt: Timestamp.nullable().default(null),
});
export type BackupRepositoryRecord = z.infer<typeof BackupRepositoryRecord>;

export const BackupRepositoriesLine = z.discriminatedUnion('type', [BackupRepositoryRecord]);
export type BackupRepositoriesLine = z.infer<typeof BackupRepositoriesLine>;

/* Servers (`servers.jsonl`, 0.117, CT-903; Whombat backup-file.md BF-13…BF-15) ------------------------------------ */

/**
 * A server the hosts service watched when the file was made: its id there, name and address (null: unknown), and the
 * name a person gave it in Whombat (null: none; an older file has none).
 */
export const BackupHubServer = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(300).nullable().default(null),
  givenName: z.string().min(1).max(200).nullable().default(null),
});
export type BackupHubServer = z.infer<typeof BackupHubServer>;

/**
 * The hosts service of the file (one, first): its certificate authority's fingerprint (`caSha256`, as the service
 * answers it: the same one means the same fleet), where agents dialled it (`agentUrl`, `wss://…`) and that address as
 * people read it (`address`, `hostsAgentAddress`), when its backup was made, its servers, and its backup's bytes under
 * `servers/hub.tar.gz` (`backupEntryName.hostsBackup`; `sha256` null when the maker didn't know it when the record was
 * written). Counts as its servers (`backupRecordCount`).
 */
export const BackupServersHubRecord = rec('servers_hub', {
  caSha256: z.string().min(1).max(200),
  agentUrl: z.string().min(1).max(300),
  address: z.string().min(1).max(300),
  madeAt: Timestamp,
  servers: z.array(BackupHubServer).max(2000).default([]),
  backup: z.object({ size: Count, sha256: Sha256Hex.nullable().default(null) }),
});
export type BackupServersHubRecord = z.infer<typeof BackupServersHubRecord>;

/** Whombat's “Asks you first” for one server (SA-01; the `server_asks` row): the server's id in lower case. */
export const BackupServerAskRecord = rec('server_ask', {
  server: z.string().min(1).max(200),
  asksFirst: HostAsksFirst,
  changedBy: PrincipalId.nullable().default(null),
  changedAt: Timestamp,
});
export type BackupServerAskRecord = z.infer<typeof BackupServerAskRecord>;

export const BackupServersLine = z.discriminatedUnion('type', [
  BackupServersHubRecord,
  BackupServerAskRecord,
]);
export type BackupServersLine = z.infer<typeof BackupServersLine>;

/* Per category ------------------------------------------------------------------------------------------------ */

/** The line schema of each category's `.jsonl`. */
export const BACKUP_RECORD_SCHEMAS = {
  agents: BackupAgentsLine,
  memories: BackupMemoriesLine,
  automations: BackupAutomationsLine,
  connections: BackupConnectionsLine,
  skills: BackupSkillsLine,
  settings: BackupSettingsLine,
  vault: BackupVaultLine,
  messages: BackupMessagesLine,
  servers: BackupServersLine,
  files: BackupFilesLine,
  repositories: BackupRepositoriesLine,
} as const satisfies Record<BackupCategoryId, z.ZodType>;

export interface BackupCategoryRecords {
  agents: BackupAgentsLine;
  memories: BackupMemoriesLine;
  automations: BackupAutomationsLine;
  connections: BackupConnectionsLine;
  skills: BackupSkillsLine;
  settings: BackupSettingsLine;
  vault: BackupVaultLine;
  messages: BackupMessagesLine;
  servers: BackupServersLine;
  files: BackupFilesLine;
  repositories: BackupRepositoriesLine;
}

/**
 * Which record types count for a category's `count` (manifest, preview): the things the meta line names. The rest are
 * attached details (destinations, invitations, settings, the agent's notes, conversations, canvases, allowances, widgets,
 * comments, thread runtimes, servers' asks). A `servers_hub` counts as its servers and a `hermes_skills` as its skills:
 * count with `backupRecordCount`.
 */
export const BACKUP_COUNTED_TYPES: Readonly<Record<BackupCategoryId, readonly string[]>> = {
  agents: ['agent'],
  memories: ['hermes_home'],
  automations: ['automation'],
  connections: ['connection', 'connector_account', 'feedback_source', 'github'],
  skills: ['hermes_skills'],
  settings: ['settings', 'repo', 'widget'],
  vault: ['vault_entry'],
  messages: ['message'],
  servers: ['servers_hub'],
  files: ['file'],
  repositories: ['repository'],
};

/**
 * How much a record adds to its category's `count` (0.117, CT-903): a `servers_hub` its servers, a `hermes_skills` its
 * skills (0.125, CT-1245), a counted type (`BACKUP_COUNTED_TYPES`) 1, anything else 0.
 */
export function backupRecordCount(
  category: BackupCategoryId,
  record: { type: string; servers?: readonly unknown[]; skills?: unknown },
): number {
  if (!BACKUP_COUNTED_TYPES[category].includes(record.type)) return 0;
  if (record.type === 'servers_hub') return Array.isArray(record.servers) ? record.servers.length : 0;
  if (record.type === 'hermes_skills') return typeof record.skills === 'number' ? record.skills : 0;
  return 1;
}

export type BackupRecordResult<C extends BackupCategoryId> =
  | { ok: true; record: BackupCategoryRecords[C] }
  | { ok: false; problem: string };

/** Parses one record of a category (a value already JSON-parsed). Never throws: a bad record is skipped with a note. */
export function parseBackupRecord<C extends BackupCategoryId>(
  category: C,
  value: unknown,
): BackupRecordResult<C> {
  const r = (BACKUP_RECORD_SCHEMAS[category] as z.ZodType).safeParse(value);
  if (r.success) return { ok: true, record: r.data as BackupCategoryRecords[C] };
  return { ok: false, problem: r.error.issues[0]?.message ?? 'invalid record' };
}

/** Parses one line of `directory.jsonl`. */
export function parseBackupDirectoryEntry(
  value: unknown,
): { ok: true; entry: BackupDirectoryEntry } | { ok: false; problem: string } {
  const r = BackupDirectoryEntry.safeParse(value);
  return r.success
    ? { ok: true, entry: r.data }
    : { ok: false, problem: r.error.issues[0]?.message ?? 'invalid' };
}

/** One record as a `.jsonl` line (UTF-8 JSON and `\n`). Throws `too_large` above `BACKUP_RECORD_MAX_BYTES`. */
export function encodeBackupLine(value: unknown): Uint8Array {
  const bytes = utf8ToBytes(`${JSON.stringify(value)}\n`);
  if (bytes.length > BACKUP_RECORD_MAX_BYTES) throw new BackupFileError('too_large', 'record line');
  return bytes;
}
