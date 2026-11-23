/**
 * The session protocol's version and capability negotiation (MA-08; contracts 1.0, CT-1260, Whombat hermes-engine.md
 * HE-52): one rule — a client and a box speak the same major, or they don't talk.
 *
 * `hello.versions` names the majors a client speaks (one); the box answers `welcome` with its version when it speaks
 * that major, and otherwise `error{unsupported_version}` with `UnsupportedVersionDetails` and closes. `whoMustUpdate`
 * says which side is behind, and the client says so in plain words (`VERSION_REFUSAL_COPY`). Within a major, minors
 * differ freely: a newer minor only adds (CT-14), and an op a box doesn't have yet is `unknown_op`. There are no
 * feature lists, API levels or windows.
 */
import { z } from 'zod';
import { SESSION_MAX_CAPABILITIES } from '../limits.js';

export const ProtocolVersion = z.object({
  major: z.number().int().min(1).max(65_535),
  minor: z.number().int().min(0).max(65_535),
});
export type ProtocolVersion = z.infer<typeof ProtocolVersion>;

/**
 * This package's session protocol version: major 5 since contracts 4.0 (Whombat report-trackers.md): one tracker's
 * operations, kinds and tools became every report tracker's (`tracker.item`, `tracker.update`, `tracker.decide`, the
 * `tracker` trigger and steps, `tracker_item` and `tracker_read`), and the feedback's connected-system source went
 * (`feedback.moveSource`, `feedback.setSourceToken`, `feedback.replyToReporter`, a report's `external`). A 3.x app or box
 * (major 4) and a 4.0 one refuse each other with `unsupported_version`. Major 4 was contracts 3.x (CT-1540; Whombat one-person.md OP-14): a
 * Whombat is one person's and the agent has no computer, so session operations went (`enroll.invite.*`,
 * `enroll.reenroll.*`, `admins.*`, `presence.*`, `members.*`, `computers.*`, `agent.setCredentialSource`,
 * `signins.org*`, the skills' share ops), others changed meaning (the screen sign-in without an email, the backup's
 * `settings` category, `HostInfo.services`) and `services.*` came. A 2.x app or box (major 3) and a 3.0 one refuse each
 * other with `unsupported_version`. Major 3 was contracts 2.x (CT-1432; Whombat hermes-skills.md HSK-14):
 * Settings → Skills runs on Hermes's own skills, hub and scanner, so session operations went (`skills.importPreview`,
 * `skills.importCommit`, `skills.stage` and its `skill-archive` upload, Whombat's own `skills.hubSearch`) and the
 * library's answer changed meaning. A 1.x app or box (major 2) and a 2.0 one refuse each other with
 * `unsupported_version` and say who must update, through the same check as any other mismatch. Major 2 was contracts
 * 1.x (CT-1260; its minor 1 since 1.1, CT-1310), major 1 contracts 0.x. The minor counts additions within the major:
 * minor 1 (contracts 3.1) brought voice typing (`voice.*`, the `dictation` upload); minor 2 (contracts 3.7) the screens'
 * `photo` and `board` views and widgets of the person's own accounts (`account:` refs), which a box sends only to a
 * session at minor 2 or later (Whombat desk-display.md DK-161); minor 3 (contracts 3.8) settling threads
 * (`chats.settle`, `chats.settleFinished`, the `chat.settled` frame) and the Hermes version in the appliance's status;
 * minor 4 (contracts 3.9) automations made by talking to the agent: the `automation_plan` card and
 * `automations.acceptPlan` / `declinePlan` (Whombat automation-chat.md); minor 5 (contracts 3.10) a thread that settled
 * when the problem the assistant looked into went away (`ThreadSettle.how` `resolved`, Whombat look-research.md); minor 6
 * (contracts 3.12) tracker feature requests put to the person: the `feature_request` card and `tracker.decide` (Whombat
 * report-trackers.md TA-44, TA-45); minor 7 backups v2: `backup.overview`, a paged `backup.checkpoints`,
 * `backup.letAssistantSetUp`, and a backup file's upload without the whole file's sha256 up front, which an app leaves
 * out only for a box at minor 7 or later (Whombat backup-options.md CT-1690…CT-1699); the passkey as the key to the
 * backups (`backup.passkeyKey.set` / `remove`, `backup.paperCopy.confirm`, `backup.findKits`, the summary's
 * `bringBack`; backup-passkey.md CT-1670…); what a backup left out and why a restore stopped (the summary's and a
 * backup's `incomplete`, the restore state's `reason`; CT-1700…); and getting one thing back from a backup
 * (`backup.look`, `backup.lookContents`, `backup.lookBring`, `backup.lookClose`; backup-look.md BKO-40…); minor 8
 * (contracts 3.16) the restore state's `newPassword` (who can change the backups' password after a lost or stolen
 * Whombat) and names of up to 80 characters on a kit found on the network (Whombat backup-passkey.md BPK-15…);
 * minor 10 (contracts 3.18) shared links: `shares.preview`, `shares.create`, `shares.list`, `shares.stop` and
 * `shares.stopAll` (Whombat share-links.md); minor 11 (contracts 3.20) Code, the place for software work: `chats.place`,
 * the `chat.placed` frame and a thread's `place`, `code` and `work` (Whombat one-chat.md). In major 5, minor 1 is the
 * local claim's proof round (`enroll.claim.local.prove`): an app names the person only to a box that proved it knows
 * the letters on its screen, and a box refuses an app below it (`claim_update_app`; Whombat whombat-link.md); minor 2 is
 * the claim link in a page's `hello` at the box's own address (`hello.claimLink`), for the places an unclaimed box keeps
 * for the visitor who has it (Whombat own-address.md); minor 3 is automations started by incoming mail: the `mail` trigger,
 * run trigger and list source, the `connection_actions` step and an agent step's `proposeActions`, which a box sends as
 * they are only to a session at minor 3 or later (Whombat automation-recipes.md), plus the agent's optional
 * `backgroundModel` (`agent.update` `runtime.backgroundModel`, Whombat model-effort.md), on-request server disk
 * usage (`hosts.diskUsage`), and the opt-in Dutch voice plus `removing` voice model state (Whombat desk-display-talk.md);
 * minor 4 is Find My as a connection of its own: the `findmy` trigger, run trigger and list source, which a box sends as
 * they are only to a session at minor 4 or later, the catalog's `needs_mac` reason, a select field's own `options` and
 * a page tab's `server` (docs/implementation/macos/findmy-connection.md); minor 5 is a Find My timeline: the
 * `connections.findMyTimeline…` operations and a Find My connection's Timeline tab, which a box shows only to a session
 * at minor 5 or later (docs/implementation/macos/findmy-timeline.md); minor 6 (contracts 4.16) is own names: an address
 * the person chose or changed (`ownAddress.check`, `ownAddress.rename`, the summary's `leaving`, `address_moved`), and
 * own-address hosts outside the three-word `box.`/`dev.` shape, which a box names only to a session at minor 6 or later
 * (Whombat own-address.md); minor 7 is a page for each account (Google, Microsoft 365, Email, GitHub, Website
 * feedback): `things.page` answers for them and their things open it, which a box says only to a session at minor 7 or
 * later (Whombat connection-dashboards.md).
 */
export const SESSION_PROTOCOL: ProtocolVersion = { major: 5, minor: 7 };

/**
 * Session protocol minor (major 5) that opens an account's own page (`things.page` for Google, Microsoft 365, Email,
 * GitHub and Website feedback); an older session's account things open their page on the Connections tab.
 */
export const ACCOUNT_PAGES_MINOR = 7;

/**
 * Session protocol minor (major 5) that reads own-address names of the person's choosing and hosts under `whombat.app`;
 * a box leaves such an address out of its answers to an older session.
 */
export const OWN_ADDRESS_NAMES_MINOR = 6;

/** Session protocol minor (major 5) that reads automations started by Find My (the `findmy` trigger and source). */
export const FIND_MY_MINOR = 4;

/** Session protocol minor (major 5) that draws a Find My connection's Timeline tab (`connections.findMyTimeline…`). */
export const FIND_MY_TIMELINE_MINOR = 5;

/** Session protocol minor (major 5) where `agent.update` stores `runtime.backgroundModel`. */
export const BACKGROUND_MODEL_MINOR = 3;

/** Session protocol minor (major 5) where `hosts.diskUsage` is supported. */
export const DISK_USAGE_MINOR = 3;

/** Session protocol minor (major 5) whose `VoiceModelState` accepts `removing`. */
export const VOICE_REMOVING_MINOR = 3;

/** Whether a negotiated session protocol is at least `{ major, minor }` (false before `welcome`). */
export function protocolAtLeast(
  protocol: ProtocolVersion | null | undefined,
  minor: number,
  major: number = SESSION_PROTOCOL.major,
): boolean {
  if (!protocol) return false;
  return protocol.major > major || (protocol.major === major && protocol.minor >= minor);
}

/** `stream.download`, `events`, … */
export const Capability = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_.-]*$/);
export const Capabilities = z.array(Capability).max(SESSION_MAX_CAPABILITIES);

/** Capabilities of the session protocol. Unknown capabilities are ignored, never an error. */
export const CAPABILITIES = {
  events: 'events',
  download: 'stream.download',
  upload: 'stream.upload',
  export: 'stream.export',
  collab: 'stream.collab',
  /** Consoles through the session (0.80.1, CT-350): `open{spec: {kind: 'console'}}`. */
  console: 'stream.console',
  enroll: 'enroll',
  recovery: 'recovery',
} as const;
export const ALL_CAPABILITIES: readonly string[] = Object.values(CAPABILITIES);

/**
 * The version a session runs at: the box's major when the client offered it, at the lower of the two minors; null
 * when the client didn't (`unsupported_version`).
 */
export function negotiateVersion(
  offered: readonly ProtocolVersion[],
  ours: ProtocolVersion = SESSION_PROTOCOL,
): ProtocolVersion | null {
  const theirs = offered.find((v) => v.major === ours.major);
  return theirs ? { major: ours.major, minor: Math.min(ours.minor, theirs.minor) } : null;
}

/** Capabilities both sides announced (order of `ours`, duplicates removed). */
export function negotiateCapabilities(ours: readonly string[], theirs: readonly string[]): string[] {
  const set = new Set(theirs);
  return [...new Set(ours.filter((c) => set.has(c)))];
}

/**
 * What a person sees when the app and the box don't speak the same major (`whoMustUpdate`): `client`, the app is behind;
 * `appliance`, the box is.
 */
export const VERSION_REFUSAL_COPY = {
  client: 'Update the app to use this Whombat.',
  appliance: 'This Whombat needs an update to work with this app.',
} as const;
