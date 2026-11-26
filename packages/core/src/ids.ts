/**
 * Identifiers. All ids are text: `<prefix>_<body>`.
 *
 * - Generated ids use a 12-character nanoid-style body (`[A-Za-z0-9_-]`).
 * - Audit event ids use 12 lowercase hex characters so the displayed reference (`e-<body>`) stays readable.
 * - The seed uses deterministic readable bodies (`prn_banjo`, `cnv_billing-v2`, `evt_9f31`).
 */
import { randomBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';

export const ID_PREFIXES = {
  account: 'acc',
  burrow: 'bur',
  principal: 'prn',
  conversation: 'cnv',
  message: 'msg',
  attachment: 'att',
  run: 'run',
  approval: 'apr',
  event: 'evt',
  canvas: 'cvs',
  comment: 'cmt',
  plan: 'pln',
  step: 'stp',
  dispatch: 'dsp',
  repo: 'rep',
  pullRequest: 'pr',
  notification: 'ntf',
  device: 'dev',
  // Web sessions and API tokens of the HTTP sign-in (gone in 1.0, CT-1270): the prefixes stay taken.
  session: 'ses',
  token: 'tok',
  // Burrow invites (gone in 3.0, CT-1505): the prefix stays taken.
  invite: 'inv',
  answer: 'ans',
  runner: 'rnr',
  connection: 'con',
  oauthState: 'oas',
  // Durable memory (Workstream B, docs/decisions/bp-memory.md).
  memory: 'mem',
  summary: 'sum',
  agentSession: 'ags',
  memoryJob: 'mjb',
  /** Supervised automations (docs/decisions/bp-automations.md). */
  automation: 'aut',
  automationRun: 'arn',
  // Capability packs: gone (0.113, their last types in 1.0); the prefixes stay taken.
  pack: 'pck',
  packVersion: 'pkv',
  packAttachment: 'pka',
  packToolApproval: 'pkt',
  packSecret: 'pks',
  /** Whombat Feedback (docs/decisions/feedback.md). */
  feedbackIntegration: 'fbi',
  feedbackReport: 'fbr',
  feedbackAssessment: 'fba',
  /** Observed agent activity (work-supervision WS-11). */
  activity: 'act',
  /** The Vault (docs/decisions/vault.md): entries, keys to them, uses, passes and their requests, home networks. */
  vaultEntry: 'vlt',
  vaultKey: 'vlk',
  vaultUse: 'vlu',
  vaultPass: 'vlp',
  vaultPassRequest: 'vlq',
  vaultNetwork: 'vln',
  /** A server an `ssh` entry's key signs in to (vault.md VT-S04, contracts 0.32.0). */
  vaultSshServer: 'vss',
  /** A pack's secret slot bound to a `secret` entry (VT-55). */
  packSecretBinding: 'vlb',
  /** A skill an agent proposed for itself (docs/decisions/skills-library.md SL-06). */
  skillProposal: 'skp',
  /** A command a person always allows an agent (agent-computer.md AC-42, contracts 0.36.0). */
  commandAllowance: 'cma',
  /**
   * Whombat resourceful-agents.md (contracts 0.44.0): an entry of a person's profile (RA-20), an agent's note (RA-21),
   * a schedule an agent made (RA-30) and a fetched skill waiting to be added from a link (RA-54).
   */
  profileEntry: 'pfe',
  agentNote: 'nte',
  agentSchedule: 'sch',
  skillLinkPreview: 'slp',
  /**
   * Skills from an archive or a link, staged for a person's pick (Whombat all-skills.md SK-14, contracts 0.92.0, CT-415):
   * gone with imports (2.0, CT-1403; HSK-08); the prefix stays taken (`skill_imports` stays until a migration drops it).
   */
  skillImport: 'ski',
  /**
   * An agent's own skill, and one version of a skill (Whombat skill-store.md SST-04, SST-06, contracts 0.113.0, CT-809):
   * every change is a version, shipped skills' versions too.
   */
  skill: 'skl',
  skillVersion: 'skv',
  /** A deploy an agent or a deploy job recorded (Whombat improvement-review RF-02, contracts 0.55.0, CT-296). */
  deployment: 'dpl',
  /**
   * Backup files (Whombat backup-file.md, contracts 0.79.0, CT-335): a file being made or ready to download, an uploaded
   * file staged for a restore, and a restore.
   */
  backupFile: 'bkf',
  stagedBackup: 'bku',
  backupRestore: 'bkr',
  /** A backup opened for reading, to bring one thing back from it (Whombat backup-look.md). */
  backupLook: 'bkl',
  /**
   * One Whombat (Whombat one-whombat.md, contracts 0.80.0, CT-336…): a change Whombat made through a tool (Done
   * recently, Undo), a pinned widget, and a device skill Whombat proposed.
   */
  change: 'chg',
  widget: 'wdg',
  deviceSkillProposal: 'dvp',
  /**
   * A server task Whombat follows until it ends (Whombat task-feedback.md TF-10, TF-11, contracts 0.116.0, CT-880): the
   * row its `task` card and the agent's `task_finished` wake are about, not the hub's own task id.
   */
  followedTask: 'ftk',
  /** A task the agent finished, in its own few words (Whombat done-today.md DN-02, `report_done`): one per thread. */
  doneTask: 'dnt',
  /** What the assistant found out about a look (Whombat look-research.md LR-02): one per look while it stays. */
  lookResearch: 'lkr',
  /** An outage or a bad dot of a server, connection or device, kept 90 days. */
  incident: 'inc',
  /** A plan for an automation the agent proposed in Chat, which the person turns on or not (Whombat automation-chat.md). */
  automationPlan: 'apl',
  /** A tracker's feature request put to the person (Whombat report-trackers.md TA-44, contracts 3.12.0, CT-1636). */
  featureRequest: 'tfr',
  /** A council the agent leads: a question or goal put to several AI models on their own (Whombat council.md). */
  council: 'cnl',
  /** One member's thread of one council round, or the council's builder (Whombat council.md). */
  councilMember: 'cnm',
  /** A council the person set up and named in Settings: who sits on it, with which model and effort (council.md). */
  councilSetup: 'cns',
  /** Tasks the agent offers to hand to T3 Code, each in a thread of its own (Whombat delegate.md). */
  delegation: 'dlg',
  /** One task of a delegation (Whombat delegate.md). */
  delegationTask: 'dlt',
  /** A prompt the person keeps to use again (Whombat prompts.md). */
  prompt: 'prm',
  /** A website the agent keeps signed in between its turns, until it expires or is stopped (Whombat kept-sites.md). */
  keptSite: 'kst',
  /** A matched incoming email stored for a mail-triggered automation run. */
  mailTriggerItem: 'mlm',
  /** A one-time watch: tell the person once when someone leaves where they are or arrives somewhere (findmy-watch.md). */
  findMyWatch: 'fmw',
  /** One Looks ahead check of an event (Whombat looks-ahead.md). */
  aheadCheck: 'ahc',
  /** One thing Looks ahead keeps an eye on (“Keeping an eye on”, Whombat looks-ahead.md). */
  aheadMatter: 'ahm',
  thingWatch: 'thw',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

const BODY = '[A-Za-z0-9_-]{1,64}';
const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

/** Zod schema for an id with the given prefix, e.g. `idSchema('prn')` accepts `prn_banjo`. */
export function idSchema<P extends IdPrefix>(prefix: P) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${BODY}$`), { message: `Expected a ${prefix}_ id` })
    .describe(`${prefix}_ id`);
}

export const AccountId = idSchema('acc');
export const BurrowId = idSchema('bur');
export const PrincipalId = idSchema('prn');
export const ConversationId = idSchema('cnv');
export const MessageId = idSchema('msg');
export const AttachmentId = idSchema('att');
export const RunId = idSchema('run');
export const ApprovalId = idSchema('apr');
export const EventId = idSchema('evt');
export const CanvasId = idSchema('cvs');
export const CommentId = idSchema('cmt');
export const PlanId = idSchema('pln');
export const StepId = idSchema('stp');
export const DispatchId = idSchema('dsp');
export const RepoId = idSchema('rep');
export const PullRequestId = idSchema('pr');
export const NotificationId = idSchema('ntf');
export const DeviceId = idSchema('dev');
export const AnswerId = idSchema('ans');
export const RunnerId = idSchema('rnr');
/** A website the agent keeps signed in between its turns (Whombat kept-sites.md KS-01). */
export const KeptSiteId = idSchema('kst');
export type KeptSiteId = z.infer<typeof KeptSiteId>;
/** A person's connected account (docs/decisions/connectors.md CN-04). */
export const ConnectionId = idSchema('con');
/** A pending OAuth sign-in (`oauth_states`, CN-04). */
export const OAuthStateId = idSchema('oas');
/** A feedback integration, a report received through it, and one assessment attempt (docs/decisions/feedback.md). */
export const FeedbackIntegrationId = idSchema('fbi');
export const FeedbackReportId = idSchema('fbr');
export const FeedbackAssessmentId = idSchema('fba');
export const ActivityId = idSchema('act');
/** A Vault entry, one use, a home network. */
export const VaultEntryId = idSchema('vlt');
export const VaultUseId = idSchema('vlu');
export const VaultNetworkId = idSchema('vln');
/** A server of an `ssh` entry (vault.md VT-S04). */
export const VaultSshServerId = idSchema('vss');
/** A command a person always allows an agent (agent-computer.md AC-42). */
export const CommandAllowanceId = idSchema('cma');
/** A turn an agent scheduled for itself (RA-30). */
export const AgentScheduleId = idSchema('sch');
/** A one-time Find My watch (findmy-watch.md). */
export const ThingWatchId = idSchema('thw');
export const FindMyWatchId = idSchema('fmw');
/** A recorded deploy of a service to an environment (improvement-review RF-02, CT-296). */
export const DeploymentId = idSchema('dpl');
/** A backup file an owner made (kept 24 hours for download), an uploaded one staged for a restore, a restore (CT-335). */
export const BackupFileId = idSchema('bkf');
export const StagedBackupId = idSchema('bku');
export const BackupRestoreId = idSchema('bkr');
/** A change Whombat made through a tool, a pinned widget, a proposed device skill (one-whombat.md ONE-08, ONE-09, ONE-16). */
export const ChangeId = idSchema('chg');
export const WidgetId = idSchema('wdg');
export const DeviceSkillProposalId = idSchema('dvp');
export const AutomationPlanId = idSchema('apl');
/** A tracker's feature request put to the person, with its card (TA-44, CT-1636). */
export const FeatureRequestId = idSchema('tfr');
/** A server task Whombat follows until it ends (task-feedback.md TF-11, CT-880). */
export const FollowedTaskId = idSchema('ftk');
/** A council the agent leads (Whombat council.md). */
export const CouncilId = idSchema('cnl');
/** One member's thread of a council round, or its builder (Whombat council.md). */
export const CouncilMemberId = idSchema('cnm');
/** Tasks the agent hands to T3 Code (Whombat delegate.md). */
export const DelegationId = idSchema('dlg');
/** One task of a delegation (Whombat delegate.md). */
export const DelegationTaskId = idSchema('dlt');
/** One Looks ahead check of an event (Whombat looks-ahead.md). */
export const AheadCheckId = idSchema('ahc');
export type AheadCheckId = z.infer<typeof AheadCheckId>;
/** A matched incoming email mirrored for a mail-triggered automation run. */
export const MailTriggerItemId = idSchema('mlm');

/** Random nanoid-style body. Uses `crypto.getRandomValues` (browsers, Node, React Native with polyfill). */
export function randomIdBody(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 63];
  return out;
}

function randomHex(length: number): string {
  const bytes = randomBytes(Math.ceil(length / 2));
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out.slice(0, length);
}

/** New id for an entity kind, e.g. `newId('message')` → `msg_V1StGXR8_Z5j`. Events get a hex body. */
export function newId(kind: IdKind): string {
  const prefix = ID_PREFIXES[kind];
  return kind === 'event' ? `${prefix}_${randomHex(12)}` : `${prefix}_${randomIdBody(12)}`;
}

/** Strip the prefix: `idBody('evt_9f31')` → `9f31`. */
export function idBody(id: string): string {
  const i = id.indexOf('_');
  return i === -1 ? id : id.slice(i + 1);
}

/** The prefix of an id, or null when it has none. */
export function idPrefix(id: string): string | null {
  const i = id.indexOf('_');
  return i === -1 ? null : id.slice(0, i);
}

/** Display reference of an audit event, as shown in the log: `evt_9f31` → `e-9f31`. */
export function formatEventRef(eventId: string): string {
  return `e-${idBody(eventId)}`;
}

/** Inverse of {@link formatEventRef}: `e-9f31` → `evt_9f31`. Returns null for anything else. */
export function parseEventRef(ref: string): string | null {
  const m = /^e-([A-Za-z0-9_-]{1,64})$/.exec(ref.trim());
  return m ? `evt_${m[1]}` : null;
}
