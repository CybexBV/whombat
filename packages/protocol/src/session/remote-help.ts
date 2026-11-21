/**
 * Remote help over the session (0.120, CT-931…CT-936; Whombat docs/decisions/remote-help.md RH-01…RH-09): owners turn
 * it on for a level and a time, see who is connected, stop it, and read what support did. The support service on the
 * box (`whombat-support`) is the only judge: it answers the same shapes on its socket (`@whombat/control-contracts/local`
 * `SUPPORT_PATHS`, Go `protocol.RemoteHelpGrant`, `protocol.RemoteHelpVisit`, …), and the runtime hands them to owners.
 *
 * | Op | Input | Output | |
 * |---|---|---|---|
 * | `remoteHelp.get` | `{}` | `RemoteHelpState` | read |
 * | `remoteHelp.confirmBegin` | `{level, duration}` | `{nonce, options}` (both null: the owner has no passkey) | ephemeral |
 * | `remoteHelp.start` | `{level, duration, passkey?}` | `RemoteHelpState` | |
 * | `remoteHelp.stop` | `{}` | `RemoteHelpState` | idempotent |
 * | `remoteHelp.visits` | `{before?, limit?}` | `{visits}` | read |
 * | `remoteHelp.transcript` | `{visitId}` | export, `text/plain; charset=utf-8` | |
 *
 * Owners only (`not_owner`). Refusals (`error.details.code`): `remote_help_unavailable`, `forever_not_allowed`,
 * `passkey_required`, `passkey_failed`, `remote_help_busy`. The feature is `remote_help`.
 *
 * Display strings — who visits, the owner's name, a command line — may be any script on one line (`HOST_TEXT_RES`, the
 * hardware report's form): producers clean them (`hostText`, Go `local.HostText`) rather than fail.
 */
import {
  HelpCode,
  LookCommand,
  REMOTE_HELP_LIMITS,
  REMOTE_HELP_UNIT_RE,
  RemoteHelpDuration,
  RemoteHelpLevel,
  RemoteHelpRefusal,
  RemoteHelpStepKind,
} from '@whombat/core/domain';
import { AccountId } from '@whombat/core/ids';
import { z } from 'zod';
import { AsciiText, Rfc3339 } from './backup.js';
import { hostTextSchema } from './hardware.js';
import { PasskeyNonce, WebAuthnAuthenticationResponse, WebAuthnRequestOptions } from './passkeys.js';

export { HelpCode, LookCommand, RemoteHelpDuration, RemoteHelpLevel, RemoteHelpRefusal, RemoteHelpStepKind };

/* Names, ids and keys (CT-931) ----------------------------------------------------------------------------------- */

/**
 * Who visits, as the owner reads it (`Claude`): display text of 1…40 code points, never an id. The support service takes
 * it from the certificate's key id with `remoteHelpWho` (Go `local.RemoteHelpWho`).
 */
export const RemoteHelpWho = hostTextSchema(REMOTE_HELP_LIMITS.nameChars);
/** A person's name as the Whombat has it (the owner who turned remote help on): display text of 1…120. */
export const RemoteHelpPersonName = hostTextSchema(120);
/** A visit's id (the certificate's serial, or the service's own id): safe in a socket path. */
export const RemoteHelpVisitId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export type RemoteHelpVisitId = z.infer<typeof RemoteHelpVisitId>;
/** A systemd unit a step names (`whombat-voice.service`), Look's grammar. */
export const RemoteHelpUnit = z.string().regex(REMOTE_HELP_UNIT_RE);

/**
 * An Ed25519 OpenSSH public key without a comment (`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI…`, 80 characters): the support
 * service's host key, so support tools pin the box without trusting the relay (RH-09).
 */
export const SSH_ED25519_PUBLIC_KEY_RE = /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/;
export const SshEd25519PublicKey = z.string().regex(SSH_ED25519_PUBLIC_KEY_RE);
export type SshEd25519PublicKey = z.infer<typeof SshEd25519PublicKey>;

/* What support did (CT-932) -------------------------------------------------------------------------------------- */

/** The longest `seconds` a step says (ten years: a command line on a Forever grant). */
export const REMOTE_HELP_STEP_SECONDS_MAX = 315_360_000;

/**
 * A step of a visit (RH-07), the support service's record: `command` (a `look`, or what was `refused`), `units` (≤ 8:
 * `logs` of those parts, the part a `restart` restarted), `line` (an `exec`'s Fix command line, cleaned to one line of
 * at most 500 code points), `seconds` (how long a `shell` lasted), `target` (a `forward`'s `127.0.0.1:8123`,
 * `[::1]:5432` or socket path) with `bytes` (both ways), `reason` (a `refused`). Typed input is never recorded.
 * `remoteHelpStepValid` checks what one schema can't; core's `remoteHelpStepText` says it.
 */
export const RemoteHelpStep = z.object({
  at: Rfc3339,
  kind: RemoteHelpStepKind,
  command: LookCommand.optional(),
  units: z.array(RemoteHelpUnit).max(8).optional(),
  line: hostTextSchema(REMOTE_HELP_LIMITS.commandLineChars).optional(),
  seconds: z.number().int().min(0).max(REMOTE_HELP_STEP_SECONDS_MAX).optional(),
  target: AsciiText(200).optional(),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  reason: RemoteHelpRefusal.optional(),
});
export type RemoteHelpStep = z.infer<typeof RemoteHelpStep>;

/**
 * What the schema can't say of a step (Go `local.RemoteHelpStepValid`): a `look` names its `command`, and only `logs`
 * names `units`; an `exec` has its `line`; a `shell` its `seconds`; a `restart` exactly one unit; a `forward` its
 * `target`; a `refused` its `reason`; `bytes` only on a `forward`.
 */
export function remoteHelpStepValid(step: RemoteHelpStep): boolean {
  const units = step.units?.length ?? 0;
  if (step.bytes !== undefined && step.kind !== 'forward') return false;
  switch (step.kind) {
    case 'look':
      return step.command !== undefined && (units === 0 || step.command === 'logs');
    case 'exec':
      return step.line !== undefined;
    case 'shell':
      return step.seconds !== undefined;
    case 'restart':
      return units === 1;
    case 'forward':
      return step.target !== undefined;
    case 'refused':
      return step.reason !== undefined;
    default:
      return true;
  }
}

/** The newest steps a visit shows (`REMOTE_HELP_LIMITS.stepsShown`). */
export const REMOTE_HELP_STEPS_SHOWN = REMOTE_HELP_LIMITS.stepsShown;

/**
 * A visit (RH-07): one certificate, from its first connection until it expires or 15 minutes pass without one
 * (`endedAt` null while it lasts). `steps` the newest `REMOTE_HELP_STEPS_SHOWN`, oldest first; `truncated` when there
 * were more. `transcriptBytes` the command-line output kept (`remoteHelp.transcript`; 0: none).
 */
export const RemoteHelpVisit = z.object({
  id: RemoteHelpVisitId,
  who: RemoteHelpWho,
  level: RemoteHelpLevel,
  startedAt: Rfc3339,
  endedAt: Rfc3339.nullable(),
  steps: z.array(RemoteHelpStep).max(REMOTE_HELP_STEPS_SHOWN),
  truncated: z.boolean(),
  transcriptBytes: z.number().int().min(0).max(REMOTE_HELP_LIMITS.transcriptBytesPerVisit),
});
export type RemoteHelpVisit = z.infer<typeof RemoteHelpVisit>;

/* The state (CT-931) --------------------------------------------------------------------------------------------- */

/** The owner who turned it on (or last changed it). */
export const RemoteHelpGrantedBy = z.object({ accountId: AccountId, name: RemoteHelpPersonName });
export type RemoteHelpGrantedBy = z.infer<typeof RemoteHelpGrantedBy>;

/**
 * The grant: its level, since when, until when (null: Forever, test Whombats only, RH-03), who granted it, and the help
 * code support needs to connect — only where `helpCodeRequired` (prod images, RH-05), normalized (`formatHelpCode` shows
 * `KQ7·2MX`).
 */
export const RemoteHelpGrant = z.object({
  level: RemoteHelpLevel,
  since: Rfc3339,
  until: Rfc3339.nullable(),
  grantedBy: RemoteHelpGrantedBy,
  helpCode: HelpCode.nullable(),
});
export type RemoteHelpGrant = z.infer<typeof RemoteHelpGrant>;

/** Someone connected now: their visit, who, and since when. */
export const RemoteHelpConnected = z.object({
  visitId: RemoteHelpVisitId,
  who: RemoteHelpWho,
  since: Rfc3339,
});
export type RemoteHelpConnected = z.infer<typeof RemoteHelpConnected>;

/**
 * `remoteHelp.get` (and every change's answer): whether remote help works on this Whombat (`available`: the image pins
 * a support CA; false says “isn’t available … yet”), whether it offers Forever (`foreverAllowed`, RH-03) and needs a help
 * code (`helpCodeRequired`), the grant (null: off), and who is connected (≤ 8). `remoteHelpStateValid` checks the rest.
 */
export const RemoteHelpState = z.object({
  available: z.boolean(),
  foreverAllowed: z.boolean(),
  helpCodeRequired: z.boolean(),
  grant: RemoteHelpGrant.nullable(),
  connected: z.array(RemoteHelpConnected).max(REMOTE_HELP_LIMITS.connectedMax),
});
export type RemoteHelpState = z.infer<typeof RemoteHelpState>;

/**
 * What the schema can't say of a state (Go `local.SupportStateValid` for the socket's): nobody connected without a
 * grant; a grant only where it is `available`; a help code exactly when one is required; Forever only where allowed;
 * each visit connected once.
 */
export function remoteHelpStateValid(s: {
  available: boolean;
  foreverAllowed: boolean;
  helpCodeRequired: boolean;
  grant: { until: string | null; helpCode: string | null } | null;
  connected: readonly { visitId: string }[];
}): boolean {
  if (new Set(s.connected.map((c) => c.visitId)).size !== s.connected.length) return false;
  if (s.grant === null) return s.connected.length === 0;
  if (!s.available) return false;
  if ((s.grant.helpCode !== null) !== s.helpCodeRequired) return false;
  return s.grant.until !== null || s.foreverAllowed;
}

/* Session ops (CT-933) ------------------------------------------------------------------------------------------- */

export const RemoteHelpGetInput = z.strictObject({});

/** A `confirmBegin` nonce lives this long in the session, for one `start` (RH-04). */
export const REMOTE_HELP_CONFIRM_TTL_S = 300;

/**
 * Step 1 of turning it on (RH-04), for the choice the owner is about to confirm. With a passkey of this owner on this
 * Whombat: a nonce the session keeps for `REMOTE_HELP_CONFIRM_TTL_S` (a new begin replaces it) and the options for
 * `navigator.credentials.get`, `options.challenge` = `passkeyRemoteHelpChallengeBase64url({nonce, endpoint: the
 * caller's session PeerId, level, duration})` — the client recomputes it and refuses another. Without one, both null:
 * the client confirms in a dialog. Ephemeral: no receipt, never resent.
 */
export const RemoteHelpConfirmBeginInput = z.strictObject({
  level: RemoteHelpLevel,
  duration: RemoteHelpDuration,
});
export const RemoteHelpConfirmBeginOutput = z.object({
  nonce: PasskeyNonce.nullable(),
  options: WebAuthnRequestOptions.nullable(),
});
export type RemoteHelpConfirmBeginOutput = z.infer<typeof RemoteHelpConfirmBeginOutput>;

/**
 * Turn it on, or change its level or time (RH-03, RH-04). `passkey`: the assertion over the begin's challenge for this
 * same `level` and `duration`, from a passkey of this owner on this Whombat; it consumes the begin. An owner without a
 * passkey sends none. Refusals: `passkey_required` (the owner has one and sent none), `passkey_failed` (it didn't
 * verify, or no live begin), `forever_not_allowed`, `remote_help_unavailable`, `remote_help_busy`.
 */
export const RemoteHelpStartInput = z.strictObject({
  level: RemoteHelpLevel,
  duration: RemoteHelpDuration,
  passkey: WebAuthnAuthenticationResponse.optional(),
});

/** Turn it off now, closing every connection (never asks; already off answers the state). */
export const RemoteHelpStopInput = z.strictObject({});

/** At most this many visits a page. */
export const REMOTE_HELP_VISITS_MAX = 20;

/** “What support did”, newest first: `limit` (default and at most 20) visits older than `before`. */
export const RemoteHelpVisitsInput = z.strictObject({
  before: RemoteHelpVisitId.optional(),
  limit: z.number().int().min(1).max(REMOTE_HELP_VISITS_MAX).optional(),
});
export const RemoteHelpVisitsOutput = z.object({
  visits: z.array(RemoteHelpVisit).max(REMOTE_HELP_VISITS_MAX),
});
export type RemoteHelpVisitsOutput = z.infer<typeof RemoteHelpVisitsOutput>;

/**
 * A visit's command-line output: an export op, read only through `open{spec: {kind: 'export', op, input}}`:
 * `opened.meta {contentType: REMOTE_HELP_TRANSCRIPT_CONTENT_TYPE, name: remoteHelpTranscriptName(visitId), size}`, DATA
 * the text with ANSI and control characters stripped but newlines and tabs. `not_found` when the visit has none.
 */
export const RemoteHelpTranscriptInput = z.strictObject({ visitId: RemoteHelpVisitId });
/** The transcript's text (the export's bytes as UTF-8). */
export const RemoteHelpTranscript = z.string().max(REMOTE_HELP_LIMITS.transcriptBytesPerVisit);
export const REMOTE_HELP_TRANSCRIPT_CONTENT_TYPE = 'text/plain; charset=utf-8';

/** `whombat-remote-help-<visitId>.txt`. */
export function remoteHelpTranscriptName(visitId: string): string {
  return `whombat-remote-help-${RemoteHelpVisitId.parse(visitId)}.txt`;
}

/* Audit (signed appliance log; CT-936) --------------------------------------------------------------------------- */

/** Why remote help went off: an owner, the desk's Stop, the time ran out, or five wrong help codes. */
export const REMOTE_HELP_OFF_REASONS = ['owner', 'desk', 'expired', 'wrong_codes'] as const;
export const RemoteHelpOffReason = z.enum(REMOTE_HELP_OFF_REASONS);
export type RemoteHelpOffReason = z.infer<typeof RemoteHelpOffReason>;

/** Payload of `remote_help.on`: turned on, or its level or time changed. */
export const RemoteHelpOnAuditPayload = z.object({ level: RemoteHelpLevel, duration: RemoteHelpDuration });
export type RemoteHelpOnAuditPayload = z.infer<typeof RemoteHelpOnAuditPayload>;

/** Payload of `remote_help.off`. */
export const RemoteHelpOffAuditPayload = z.object({ reason: RemoteHelpOffReason });
export type RemoteHelpOffAuditPayload = z.infer<typeof RemoteHelpOffAuditPayload>;

/** Payload of `remote_help.visit`: who, at which level, when, and how many steps (`endedAt` null while it lasts). */
export const RemoteHelpVisitAuditPayload = z.object({
  visitId: RemoteHelpVisitId.optional(),
  who: RemoteHelpWho,
  level: RemoteHelpLevel,
  startedAt: Rfc3339,
  endedAt: Rfc3339.nullable(),
  steps: z.number().int().min(0).max(1_000_000),
});
export type RemoteHelpVisitAuditPayload = z.infer<typeof RemoteHelpVisitAuditPayload>;
