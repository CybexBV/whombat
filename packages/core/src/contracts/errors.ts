/**
 * Error and commit-outcome bodies shared by every endpoint.
 *
 * - 4xx/5xx → `ApiErrorBody`.
 * - 403 from the keys engine (`cannot`) → `BlockedBody` (a signed Blocked event was written).
 * - 202 from the keys engine (`ask`) → `ApprovalRequiredBody` (an Approval was created).
 */
import { z } from 'zod';
import { AuditKeyRef } from '../domain/audit.js';
import { JsonValue } from '../domain/common.js';
import { ApprovalId, EventId } from '../ids.js';

export const ErrorCode = z.enum([
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'blocked',
  'approval_required',
  'invalid_code',
  'expired',
  'slug_taken',
  'not_allowed',
  /**
   * An invite link that needs the email proven first: the email already has an account (sign in as it, then
   * open the link again), or this server sends email and the link would make a new account (confirm the
   * email with a code; the invite is accepted then). `details: { email, account }`.
   */
  'sign_in_required',
  /**
   * 413: a file is larger than the upload limit, or the burrow's storage is full (Workstream A;
   * `details: { reason: 'file' | 'quota', limit }`).
   */
  'too_large',
  'internal',
  /** Registered endpoint whose phase has not landed yet (runner, MCP, collab, uploads). */
  'not_implemented',
  /**
   * 503: a service Whombat relies on is down or still starting (0.80.1, CT-346), e.g. the hosts service
   * (`details.code: hosts_unavailable`). Worth trying again later; the session's `unavailable` means the same.
   */
  'unavailable',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    /** Field errors for `validation_failed` (path → messages). */
    fields: z.record(z.string(), z.array(z.string())).optional(),
    details: JsonValue.optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

/** 403: the actor does not hold the key. */
export const BlockedBody = z.object({
  error: z.object({ code: z.literal('blocked'), message: z.string() }),
  blocked: z.literal(true),
  keyNeeded: AuditKeyRef,
  /** The signed Blocked event. */
  eventId: EventId,
});
export type BlockedBody = z.infer<typeof BlockedBody>;

/** 202: the actor holds the key at `ask`; a person has to approve. */
export const ApprovalRequiredBody = z.object({
  approvalRequired: z.literal(true),
  approvalId: ApprovalId,
  approvalNumber: z.number().int().positive(),
  /** The signed Asks event. */
  eventId: EventId,
});
export type ApprovalRequiredBody = z.infer<typeof ApprovalRequiredBody>;

export const OkResponse = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;

/** HTTP status for an error code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  blocked: 403,
  approval_required: 202,
  invalid_code: 400,
  expired: 410,
  slug_taken: 409,
  not_allowed: 403,
  sign_in_required: 409,
  too_large: 413,
  internal: 500,
  not_implemented: 501,
  unavailable: 503,
};

/**
 * Outcome of a command run through the commit pipeline, as MCP tools report it:
 * done, waiting on a person, or blocked.
 */
export function commitOutcome<T extends z.ZodRawShape>(ok: T) {
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), ...ok }),
    z.object({
      status: z.literal('pending_approval'),
      approvalId: ApprovalId,
      approvalNumber: z.number().int().positive(),
      eventId: EventId,
      message: z.string(),
    }),
    z.object({
      status: z.literal('blocked'),
      keyNeeded: AuditKeyRef,
      eventId: EventId,
      message: z.string(),
    }),
  ]);
}
