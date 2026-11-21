/**
 * The application's own error code of a failed `signins.*` / `clients.*` call, the same on both transports: over REST
 * the body is `{error: {code: 'conflict', details: {code: 'provider.console_input_gap', …}}}`, over the session the
 * app code is lifted into `error.code` (AP-19), which the typed client can't parse as a core `ErrorCode` — so this
 * reads the raw body, not `ApiError.code`.
 */
import { ApiError, NetworkError } from '../http/errors';
import {
  DeadlineExceededError,
  NotDeliveredError,
  OutcomeRedactedError,
  OutcomeUnknownError,
} from '../session/types';

export interface AppError {
  /** `provider.console_input_gap`, `client.busy`, `forbidden`, … (`unknown` when nothing says). */
  code: string;
  /** The server's explanation, meant for people; null when it gave none. */
  message: string | null;
  status: number | null;
  details: Record<string, unknown> | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function appErrorOf(error: unknown): AppError {
  if (error instanceof ApiError) {
    const body = isRecord(error.body) && isRecord(error.body.error) ? error.body.error : null;
    const details =
      body && isRecord(body.details) ? body.details : isRecord(error.details) ? error.details : null;
    const code =
      (typeof details?.code === 'string' && details.code) ||
      (typeof body?.code === 'string' && body.code) ||
      error.code;
    const message = typeof body?.message === 'string' ? body.message : null;
    return { code, message, status: error.status, details };
  }
  if (isRecord(error) && typeof error.code === 'string')
    return {
      code: error.code,
      message: typeof error.message === 'string' ? error.message : null,
      status: null,
      details: isRecord(error.details) ? error.details : null,
    };
  return { code: 'unknown', message: null, status: null, details: null };
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRY_CODES = new Set(['unavailable', 'rate_limited', 'internal', 'too_many', 'unknown_outcome']);

/**
 * Nothing (or nothing known) happened, so sending the same thing again is right: the network failed, the answer was
 * lost, the server was busy. A write resends its `seq`, which the server applies at most once (CT-71).
 */
export function isRetryable(error: unknown): boolean {
  if (
    error instanceof NetworkError ||
    error instanceof NotDeliveredError ||
    error instanceof OutcomeUnknownError ||
    error instanceof DeadlineExceededError
  )
    return true;
  if (error instanceof OutcomeRedactedError) return error.state !== 'rejected';
  if (error instanceof TypeError) return true; // fetch's own network failure
  if (error instanceof ApiError) {
    const { code } = appErrorOf(error);
    return RETRY_STATUS.has(error.status) || RETRY_CODES.has(code);
  }
  return false;
}

/** The answer was lost but the server says the call went through (a redacted outcome, CT-195). */
export { wentThrough } from '../session/types';
