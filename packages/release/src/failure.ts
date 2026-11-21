/**
 * Why an update failed, as structured fields (CT-137, UP-E3): what the manager puts in `status.report` and
 * `update.progress` (`@whombat/control-contracts/device` `UpdateFailureReport`), in its facts to the runtime
 * (`UpdateFacts.failureDetail`) and what control keeps with a paused rollout. Codes, ids and numbers only — the device
 * report allowlist (assignment §12): no free text, paths or messages leave the box. `describeUpdateFailure` renders
 * it for people; the box keeps its full local message (journal, `whombat-manager status`).
 */
import { z } from 'zod';
import { HEALTH_CHECKS, UpdateJournalState } from './journal.js';
import { EpochSeconds, Ident, IntRange, ReleaseId } from './primitives.js';

const Schema = z.number().int().min(0).max(1_000_000);

/** The schema facts behind a `schema_incompatible` failure. */
export const UpdateFailureSchema = z.object({
  /** The live database's schema. */
  database: Schema,
  /** The schema the candidate would migrate it to; null when it had nothing to migrate (its check answered exit 0). */
  target: Schema.nullable(),
  /** The candidate's own schema (`runtime.schemaWrites`) and what its tuple says it reads. */
  candidateWrites: Schema,
  candidateReads: IntRange,
});
export type UpdateFailureSchema = z.infer<typeof UpdateFailureSchema>;

/**
 * One update failure. Tolerant (`z.object`): it travels in facts, session answers and control responses that an
 * older reader may get from a newer writer. Device request bodies carry the strict copy (`UpdateFailureReport`).
 */
export const UpdateFailureDetail = z.object({
  /** The journal state the attempt failed in (`Staged` for a schema check, `Verifying` for health). */
  stage: UpdateJournalState,
  /** The manager's failure code (`schema_incompatible`, `unhealthy`, `download_corrupt`, …). */
  code: Ident,
  /** The activation check's reasons (`candidate_cannot_read_schema`, `protocol_no_overlap`, …). */
  reasons: z.array(Ident).max(8),
  /** The candidate release. */
  release: ReleaseId,
  schema: UpdateFailureSchema.optional(),
  /** What the installed runtime could do on the database the candidate would leave (CT-134, CT-135). */
  rollbackAccess: z.enum(['read-write', 'read-only', 'none']).optional(),
  /** Failed local health checks by name. */
  failedChecks: z.array(z.enum(HEALTH_CHECKS)).max(8),
  at: EpochSeconds,
});
export type UpdateFailureDetail = z.infer<typeof UpdateFailureDetail>;

/**
 * Manager failure codes that mean “this box can’t right now; it retries by itself” and never a bad release (CT-147):
 * they count no attempt, so they never quarantine a release, and control shouldn't pause a rollout or hold a device
 * for them. From `manager/internal/update/engine.go` (failures without `CountsAttempt`, with their own retry time).
 */
export const RETRYABLE_UPDATE_FAILURES = [
  /** Not enough free space to download or stage; retried after the no-space interval. */
  'no_space',
  /** The helper doesn't have the assignment yet (it reads the signed metadata itself); retried shortly. */
  'not_assigned',
  /** The helper has nothing staged for the release (e.g. after a restart); staged again. */
  'not_staged',
  /** Work started after the drain, so the safe boundary was lost before activation; retried at once. */
  'boundary_lost',
  /** The pre-migration checkpoint may miss writes accepted since; a new one is taken at once. */
  'checkpoint_stale',
  /** The runtime asked for a verified checkpoint first (a contract migration); retried once one can be taken. */
  'checkpoint_required',
  /** The helper or the metadata was unavailable for longer than the drain window; the drain is released, rechecked. */
  'activation_deferred',
] as const;
export type RetryableUpdateFailure = (typeof RETRYABLE_UPDATE_FAILURES)[number];

/** Whether a failure code is one the box retries by itself, never a verdict on the release (CT-147). */
export function isRetryableUpdateFailure(code: string): code is RetryableUpdateFailure {
  return (RETRYABLE_UPDATE_FAILURES as readonly string[]).includes(code);
}

const BEFORE_ACTIVATION: ReadonlySet<string> = new Set([
  'Assigned',
  'Downloading',
  'Verified',
  'Staged',
  'WaitingForSafeBoundary',
]);

const CHECK_NAMES: Record<string, string> = {
  runtime: 'the Whombat service',
  database: 'the database',
  session_endpoint: 'app connections',
  runner: 'the agent runner',
  relay_control: 'the connection to Whombat’s servers',
  boot: 'startup',
  manager: 'the update manager',
};

const list = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] as string}`;

const reads = (r: IntRange) => (r.min === r.max ? `schema ${r.min} only` : `schemas ${r.min} to ${r.max}`);

const UNCHANGED = 'Nothing was changed.';
const WENT_BACK = 'This Whombat went back to the release it ran before.';

/** One sentence per activation-check reason (`schema_incompatible`). */
function reasonSentence(reason: string, d: UpdateFailureDetail): string | null {
  const r = d.release;
  const s = d.schema;
  switch (reason) {
    case 'candidate_cannot_read_schema':
      if (!s) return `${r} couldn’t start on this Whombat’s database: it can’t read it.`;
      if (s.target !== null && s.target !== s.database)
        return `${r} couldn’t start on this Whombat’s database: it would move it from schema ${s.database} to ${s.target} but reads ${reads(s.candidateReads)}.`;
      if (s.candidateWrites < s.database)
        return `${r} couldn’t start on this Whombat’s database: the database is at schema ${s.database} and ${r} (schema ${s.candidateWrites}) can’t read it.`;
      return `${r} couldn’t start on this Whombat’s database: it reads ${reads(s.candidateReads)} and the database is at ${s.database}.`;
    case 'candidate_read_only':
      return s
        ? `${r} could only read this Whombat’s database, not write it: the database is at schema ${s.database} and ${r} at ${s.candidateWrites}.`
        : `${r} could only read this Whombat’s database, not write it.`;
    case 'schema_downgrade':
      return s
        ? `${r} is older than this Whombat’s database: it writes schema ${s.candidateWrites} and the database is at ${s.database}.`
        : `${r} is older than this Whombat’s database.`;
    case 'schema_target_mismatch':
      return s && s.target !== null
        ? `${r} would move the database to schema ${s.target}, but its release says it writes ${s.candidateWrites}.`
        : `${r} doesn’t agree with its own release about the database it writes.`;
    case 'host_abi_unsupported':
      return `${r} doesn’t support this Whombat’s system.`;
    case 'protocol_no_overlap':
      return `${r} doesn’t speak the protocol the apps use with this Whombat.`;
    default:
      return null;
  }
}

/** One or two sentences per failure code; `null` falls back to the generic text. */
function codeText(code: string, d: UpdateFailureDetail): string | null {
  const r = d.release;
  switch (code) {
    case 'schema_incompatible': {
      const first = d.reasons.map((x) => reasonSentence(x, d)).find((x) => x !== null);
      return `${first ?? `${r} couldn’t start on this Whombat’s database (${d.reasons.join(', ') || code}).`} ${UNCHANGED}`;
    }
    case 'unhealthy': {
      const names = d.failedChecks.map((c) => CHECK_NAMES[c] ?? c);
      return names.length
        ? `${r} started but failed its health checks (${list(names)}). ${WENT_BACK}`
        : `${r} started but failed its health checks. ${WENT_BACK}`;
    }
    case 'boot_fallback':
      return `${r} didn’t boot. This Whombat started the release it ran before.`;
    case 'reboot_timeout':
      return `This Whombat didn’t restart into ${r} in time. It went back to the release it ran before.`;
    case 'manager_recovery':
      return `The update manager stopped while installing ${r}. ${WENT_BACK}`;
    case 'download_corrupt':
      return `The download of ${r} was damaged. ${UNCHANGED}`;
    case 'verification_failed':
      return `${r} didn’t pass signature verification, so it wasn’t installed. ${UNCHANGED}`;
    case 'no_space':
      return `There isn’t enough free space on this Whombat to install ${r}. ${UNCHANGED}`;
    case 'incompatible':
      return `${r} isn’t compatible with this Whombat. ${UNCHANGED}`;
    case 'downgrade':
      return `${r} is older than what this Whombat runs, and going back wasn’t allowed. ${UNCHANGED}`;
    case 'not_assigned':
    case 'not_staged':
      return `${r} wasn’t ready to install yet. ${UNCHANGED}`;
    case 'activation_failed':
      return `${r} couldn’t be switched on. ${WENT_BACK}`;
    case 'activation_deferred':
      return `Installing ${r} waits until this Whombat isn’t busy.`;
    case 'boundary_lost':
      return `Installing ${r} was put off because work started; it will try again.`;
    case 'checkpoint_required':
      return `${r} needs a verified backup before it changes the database, and none could be made. ${UNCHANGED}`;
    case 'checkpoint_stale':
      return `The backup taken before installing ${r} was out of date; a new one is taken first.`;
    case 'checkpoint_failed':
      return `The backup before installing ${r} failed. ${UNCHANGED}`;
    case 'migrate_failed':
      return `${r} couldn’t update the database. ${WENT_BACK}`;
    case 'forward_repair_required':
      return `${r} changed the database and the release before it can’t use it, so ${r} keeps running until a fixed release arrives.`;
    default:
      return null;
  }
}

/**
 * Plain English for operators and owners (one or two sentences) from a failure's code and reasons (CT-137): the
 * manager's codes (`schema_incompatible` with its reasons, `unhealthy`, `boot_fallback`, `download_corrupt`, …; a
 * helper's `helper_<code>` reads as `<code>`). An unknown code renders generically, with the code.
 */
export function describeUpdateFailure(detail: UpdateFailureDetail): string {
  const code = detail.code.startsWith('helper_') ? detail.code.slice('helper_'.length) : detail.code;
  const known = codeText(code, detail);
  if (known) return known;
  const after = BEFORE_ACTIVATION.has(detail.stage)
    ? ` ${UNCHANGED}`
    : detail.stage === 'Activating' || detail.stage === 'Verifying' || detail.stage === 'RolledBack'
      ? ` ${WENT_BACK}`
      : '';
  return `${detail.release} couldn’t be installed (${detail.code}).${after}`;
}
