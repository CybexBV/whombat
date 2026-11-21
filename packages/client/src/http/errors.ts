/**
 * Typed errors of the HTTP client. Keys-engine outcomes (202 approval required, 403 blocked) are not
 * errors: mutations return them as `CommitResult` variants. `unwrap()` turns them into
 * `ApprovalRequiredError` / `BlockedError` when a caller prefers throwing.
 */
import type { ApprovalRequiredBody, BlockedBody, ErrorCode } from '@whombat/core/contracts';
import type { AuditKeyRef } from '@whombat/core/domain';

export class WhombatClientError extends Error {
  override name = 'WhombatClientError';
}

/** A non-2xx answer (other than the keys-engine outcomes of a mutation). */
export class ApiError extends WhombatClientError {
  override name = 'ApiError';
  constructor(
    /** HTTP status. */
    readonly status: number,
    /** `ApiErrorBody.error.code`, or `unknown` when the body did not follow the contract. */
    readonly code: ErrorCode | 'unknown',
    message: string,
    /** Parsed response body (JSON when possible, otherwise text). */
    readonly body: unknown,
    /** Endpoint id (`messages.send`). */
    readonly endpointId: string,
    /** Field errors for `validation_failed`. */
    readonly fields: Record<string, string[]> = {},
    readonly details: unknown = undefined,
  ) {
    super(message);
  }
}

/** The request never produced a response (offline, DNS, CORS, connection reset). */
export class NetworkError extends WhombatClientError {
  override name = 'NetworkError';
  constructor(
    readonly endpointId: string,
    cause: unknown,
  ) {
    super(`Network request for ${endpointId} failed`, { cause });
  }
}

/** Input did not match the endpoint's params / query / body schema; nothing was sent. */
export class InvalidRequestError extends WhombatClientError {
  override name = 'InvalidRequestError';
  constructor(
    readonly endpointId: string,
    readonly part: 'params' | 'query' | 'body',
    /** Path → messages, like `ApiErrorBody.error.fields`. */
    readonly fields: Record<string, string[]>,
  ) {
    super(`Invalid ${part} for ${endpointId}: ${formatFields(fields)}`);
  }
}

/** The server answered with a body that does not match the contract (response validation, dev). */
export class ContractError extends WhombatClientError {
  override name = 'ContractError';
  constructor(
    readonly endpointId: string,
    readonly fields: Record<string, string[]>,
    readonly body: unknown,
  ) {
    super(`Response of ${endpointId} does not match the contract: ${formatFields(fields)}`);
  }
}

/**
 * An answer a security view reads that doesn't match this app's contract (AP-266): endpoints and devices, approvals,
 * grants and keys, pack tools and permissions, members and their roles, recovery and enrollment. These are decoded
 * strictly — a device, an approval or a grant this app can't read is never left out or shown as something else — so
 * the screen says it needs a newer version of the app instead.
 */
export class NeedsNewerAppError extends ContractError {
  override name = 'NeedsNewerAppError';
}

/** Thrown by `unwrap()` for a 202: a person has to approve first. */
export class ApprovalRequiredError extends WhombatClientError {
  override name = 'ApprovalRequiredError';
  readonly approvalId: string;
  readonly approvalNumber: number;
  readonly eventId: string;
  constructor(readonly body: ApprovalRequiredBody) {
    super(`Approval #${body.approvalNumber} is needed first`);
    this.approvalId = body.approvalId;
    this.approvalNumber = body.approvalNumber;
    this.eventId = body.eventId;
  }
}

/** Thrown by `unwrap()` for a keys-engine 403: the actor does not hold the key. */
export class BlockedError extends WhombatClientError {
  override name = 'BlockedError';
  readonly keyNeeded: AuditKeyRef;
  readonly eventId: string;
  constructor(readonly body: BlockedBody) {
    super(body.error.message);
    this.keyNeeded = body.keyNeeded;
    this.eventId = body.eventId;
  }
}

export function isApiError(error: unknown, code?: ErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

function formatFields(fields: Record<string, string[]>): string {
  return Object.entries(fields)
    .map(([path, messages]) => `${path || '(root)'}: ${messages.join(', ')}`)
    .join('; ');
}

/** Zod issues → `{ "path.to.field": [messages] }`. */
export function issuesToFields(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.');
    const list = fields[key] ?? [];
    list.push(issue.message);
    fields[key] = list;
  }
  return fields;
}
