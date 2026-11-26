/**
 * The support socket (0.120, CT-938…CT-942; Whombat docs/decisions/remote-help.md RH-02…RH-09): the appliance's support
 * service `whombat-support` (root) ⇄ the runtime and the manager, HTTP/1.1 JSON over a unix socket at
 * `WHOMBAT_SUPPORT_SOCKET` (`SUPPORT_SOCKET_DEFAULT`; unset: no remote help, the runtime advertises no `remote_help`).
 * The service is the only judge of remote help: it keeps the grant, decides Forever (`foreverAllowed`, RH-03) and the
 * help code (RH-05), dials the relay only while a grant is active (RH-06), runs every visit and records what it did
 * (RH-07). The runtime only asks and shows.
 *
 * Callers by peer uid (`SO_PEERCRED`): the runtime everything, the manager `state` only (for `status.report.support`),
 * root everything; anyone else 403 `forbidden`.
 *
 * | Path | Request | Answer |
 * |---|---|---|
 * | `GET /v1/state` | — | `SupportState` |
 * | `POST /v1/grant` | `SupportGrantRequest {v, level, duration, grantedBy}` | `SupportState`; 403 `forever_not_allowed`, 503 `unavailable` |
 * | `POST /v1/stop` | `SupportStopRequest {v, reason, by?}` | `SupportState` (already off: the state) |
 * | `GET /v1/visits?before=&limit=` | — | `SupportVisitsAnswer {v, visits}` (newest first, `limit` 1…20, default 20) |
 * | `GET /v1/visits/{id}/transcript` | — | `text/plain; charset=utf-8`, the raw command-line output; 404 `not_found` |
 * | `GET /v1/events?after=&waitS=` | — | `SupportEventsAnswer {v, events, next}` (long poll, `waitS` 0…25) |
 *
 * Errors are `LocalError` with the codes of `SUPPORT_ERRORS` at `SUPPORT_ERROR_STATUS`'s HTTP status. Requests are
 * strict and at most `SUPPORT_REQUEST_MAX_BYTES`; answers tolerant and at most `SUPPORT_ANSWER_MAX_BYTES`. Never logs a
 * help code or a certificate.
 */
import {
  RemoteHelpConnected,
  RemoteHelpDuration,
  RemoteHelpGrant,
  RemoteHelpGrantedBy,
  RemoteHelpLevel,
  RemoteHelpOffReason,
  RemoteHelpVisit,
  RemoteHelpVisitId,
  RemoteHelpWho,
  Rfc3339,
  SshEd25519PublicKey,
} from '@whombat/protocol/session';
import { z } from 'zod';

const V = z.literal(1);

export const SUPPORT_SOCKET_ENV = 'WHOMBAT_SUPPORT_SOCKET';
export const SUPPORT_SOCKET_DEFAULT = '/run/whombat-support/api.sock';

export const SUPPORT_PATHS = {
  /** GET: whether remote help works here, the grant, who is connected. Runtime, manager, root. */
  state: '/v1/state',
  /** Turn it on, or change its level or time. Runtime, root. */
  grant: '/v1/grant',
  /** Turn it off now, closing every connection. Runtime, root. */
  stop: '/v1/stop',
  /** GET `?before=<visit id>&limit=<1…20>`: the visits, newest first. Runtime, root. */
  visits: '/v1/visits',
  /** GET: a visit's command-line output (`supportTranscriptPath`). Runtime, root. */
  transcript: '/v1/visits/{id}/transcript',
  /** GET `?after=<seq>&waitS=<0…25>`: what happened since `after` (long poll). Runtime, root. */
  events: '/v1/events',
} as const;

/** `/v1/visits/<id>/transcript` (the id checked first: it lands in a path). */
export function supportTranscriptPath(visitId: string): string {
  return SUPPORT_PATHS.transcript.replace('{id}', RemoteHelpVisitId.parse(visitId));
}

/** The largest request body. */
export const SUPPORT_REQUEST_MAX_BYTES = 1_024;
/** The largest JSON answer a caller reads (20 visits of 200 steps of the longest lines are about 12 MiB). */
export const SUPPORT_ANSWER_MAX_BYTES = 16 * 2 ** 20;
/** `GET /v1/events` waits at most this long for something to happen. */
export const SUPPORT_EVENTS_WAIT_MAX_S = 25;
/** `GET /v1/events` answers at most this many events (the oldest after `after`); ask again from `next`. */
export const SUPPORT_EVENTS_MAX = 100;

/**
 * The `LocalError` codes of the support socket: `bad_request` (schema, or a query outside its bounds), `too_large`
 * (body), `forbidden` (a caller its uid doesn't allow), `not_found` (no such visit, or no transcript),
 * `forever_not_allowed` (`forever` on a prod image, RH-03), `unavailable` (no support CA pinned: remote help can't work
 * here).
 */
export const SUPPORT_ERRORS = [
  'bad_request',
  'too_large',
  'forbidden',
  'not_found',
  'forever_not_allowed',
  'unavailable',
] as const;
export type SupportError = (typeof SUPPORT_ERRORS)[number];

/** The HTTP status each code is answered with (Go `local.SupportErrorStatus`). */
export const SUPPORT_ERROR_STATUS: Readonly<Record<SupportError, number>> = {
  bad_request: 400,
  too_large: 413,
  forbidden: 403,
  not_found: 404,
  forever_not_allowed: 403,
  unavailable: 503,
};

/** The image's `whombat.environment`: John's DEV boxes are `local`, dev.whombat.com's `dev`, customers' `prod`. */
export const SUPPORT_ENVIRONMENTS = ['local', 'dev', 'prod'] as const;
export const SupportEnvironment = z.enum(SUPPORT_ENVIRONMENTS);
export type SupportEnvironment = z.infer<typeof SupportEnvironment>;

/** The grant as the service keeps it: the session's grant and the wrong help codes typed so far (5 end it). */
export const SupportGrant = z.object({
  ...RemoteHelpGrant.shape,
  wrongCodes: z.number().int().min(0).max(100),
});
export type SupportGrant = z.infer<typeof SupportGrant>;

/**
 * `GET /v1/state`: the session's `RemoteHelpState` and what the manager reports to control (RH-09) — the image's
 * `environment` and the service's SSH host key (`hostKey`, null before its first start made one). `available` false
 * when the image pins no support CA. `supportStateValid` checks what one schema can't.
 */
export const SupportState = z.object({
  v: V,
  available: z.boolean(),
  foreverAllowed: z.boolean(),
  helpCodeRequired: z.boolean(),
  environment: SupportEnvironment,
  hostKey: SshEd25519PublicKey.nullable(),
  grant: SupportGrant.nullable(),
  connected: z.array(RemoteHelpConnected).max(8),
});
export type SupportState = z.infer<typeof SupportState>;

/**
 * Turn it on, or change it (the person's `remoteHelp.start`, after the runtime checked the person and the passkey): the
 * level, the duration (`forever` refused on prod, 403 `forever_not_allowed`) and who granted it (kept for the record). A change keeps the help
 * code and the connections a level still allows; a lower level closes the others at once.
 */
export const SupportGrantRequest = z.strictObject({
  v: V,
  level: RemoteHelpLevel,
  duration: RemoteHelpDuration,
  grantedBy: RemoteHelpGrantedBy,
});
export type SupportGrantRequest = z.infer<typeof SupportGrantRequest>;

/**
 * Who stops it: the person in the app (`owner`, with `by`; the wire value is older than one person per Whombat) or
 * someone at the box's screen (`desk`, nobody named).
 */
export const SUPPORT_STOP_REASONS = ['owner', 'desk'] as const;
export const SupportStopReason = z.enum(SUPPORT_STOP_REASONS);
export type SupportStopReason = z.infer<typeof SupportStopReason>;
export const SupportStopRequest = z.strictObject({
  v: V,
  reason: SupportStopReason,
  by: RemoteHelpGrantedBy.optional(),
});
export type SupportStopRequest = z.infer<typeof SupportStopRequest>;

/** `GET /v1/visits`: newest first. */
export const SupportVisitsAnswer = z.object({ v: V, visits: z.array(RemoteHelpVisit).max(20) });
export type SupportVisitsAnswer = z.infer<typeof SupportVisitsAnswer>;

/**
 * What happened, for the runtime to tell the person (RH-08) and sign (`remote_help.*`): it was turned on or changed
 * (`grant`: `level`, `duration`, `by`), it was stopped (`stop`: `reason` `owner` with `by`, or `desk`), the time ran out
 * (`expired`), a visit started (`visit_start`: `visitId`, `who`, `level`) or ended (`visit_end`: also `startedAt` and
 * `steps`, how many it recorded), or five wrong help codes ended it (`locked_out`).
 */
export const SUPPORT_EVENT_KINDS = [
  'grant',
  'stop',
  'expired',
  'visit_start',
  'visit_end',
  'locked_out',
] as const;
export const SupportEventKind = z.enum(SUPPORT_EVENT_KINDS);
export type SupportEventKind = z.infer<typeof SupportEventKind>;

/** An event: `seq` grows by one from 1, survives restarts and is never reused. `supportEventValid` checks the members. */
export const SupportEvent = z.object({
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  at: Rfc3339,
  kind: SupportEventKind,
  level: RemoteHelpLevel.optional(),
  duration: RemoteHelpDuration.optional(),
  reason: RemoteHelpOffReason.optional(),
  visitId: RemoteHelpVisitId.optional(),
  who: RemoteHelpWho.optional(),
  startedAt: Rfc3339.optional(),
  steps: z.number().int().min(0).max(1_000_000).optional(),
  by: RemoteHelpGrantedBy.optional(),
});
export type SupportEvent = z.infer<typeof SupportEvent>;

/**
 * `GET /v1/events?after=<seq>&waitS=<s>`: the events after `after` (oldest first, at most `SUPPORT_EVENTS_MAX`),
 * answered at once when there are any, else after the first one or `waitS` (0…`SUPPORT_EVENTS_WAIT_MAX_S`). `next` is
 * the service's newest seq (0 before the first event), not an echo of `after`: ask again with `after=next`. A `next`
 * below the caller's `after` means the service's log started again (its state was reset): read from 0.
 */
export const SupportEventsAnswer = z.object({
  v: V,
  events: z.array(SupportEvent).max(SUPPORT_EVENTS_MAX),
  next: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type SupportEventsAnswer = z.infer<typeof SupportEventsAnswer>;

/**
 * What the schema can't say of an event (Go `local.SupportEventValid`): a `grant` has `level`, `duration` and `by`; a
 * `stop` a `reason` of `owner` (with `by`) or `desk`; a `visit_start` its `visitId`, `who` and `level`, a `visit_end`
 * also `startedAt` and `steps`; `duration` only on a grant, `reason` only on a stop, `startedAt` and `steps` only on a
 * visit's end.
 */
export function supportEventValid(e: SupportEvent): boolean {
  const visit = e.kind === 'visit_start' || e.kind === 'visit_end';
  if ((e.duration !== undefined) !== (e.kind === 'grant')) return false;
  if ((e.reason !== undefined) !== (e.kind === 'stop')) return false;
  if ((e.startedAt !== undefined || e.steps !== undefined) && e.kind !== 'visit_end') return false;
  switch (e.kind) {
    case 'grant':
      return e.level !== undefined && e.by !== undefined;
    case 'stop':
      return e.reason === 'desk' ? e.by === undefined : e.reason === 'owner' && e.by !== undefined;
    default:
      if (!visit) return true;
      return (
        e.visitId !== undefined &&
        e.who !== undefined &&
        e.level !== undefined &&
        (e.kind === 'visit_start' || (e.startedAt !== undefined && e.steps !== undefined))
      );
  }
}

/**
 * What the schema can't say of a state (Go `local.SupportStateValid`), as `remoteHelpStateValid`: nobody connected
 * without a grant, a grant only where `available`, a help code exactly when required, Forever only where allowed, each
 * visit connected once; on `prod` exactly a help code required (RH-05), elsewhere Forever always allowed (RH-03). A prod
 box may allow Forever too: one root marked as a maintainer's test Whombat (RH-17).
 */
export function supportStateValid(s: SupportState): boolean {
  const prod = s.environment === 'prod';
  if (s.helpCodeRequired !== prod || (!prod && !s.foreverAllowed)) return false;
  if (new Set(s.connected.map((c) => c.visitId)).size !== s.connected.length) return false;
  if (s.grant === null) return s.connected.length === 0;
  if (!s.available) return false;
  if ((s.grant.helpCode !== null) !== s.helpCodeRequired) return false;
  return s.grant.until !== null || s.foreverAllowed;
}
