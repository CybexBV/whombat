import { type ApiErrorBody, ERROR_STATUS, type ErrorCode, type JsonValue } from '@whombat/core';
import type { z } from 'zod';

/** An error with a contract error code. Route handlers and commands throw these; the app maps them to HTTP. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: {
      fields?: Record<string, string[]>;
      details?: JsonValue;
      status?: number;
      /** The same failure without what the provider said, for texts the whole burrow reads (IN-21). */
      logMessage?: string;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get status(): number {
    return this.extra.status ?? ERROR_STATUS[this.code];
  }

  toBody(): ApiErrorBody {
    const error: ApiErrorBody['error'] = { code: this.code, message: this.message };
    if (this.extra.fields) error.fields = this.extra.fields;
    if (this.extra.details !== undefined) error.details = this.extra.details;
    return { error };
  }
}

export const notFound = (what: string) => new ApiError('not_found', `${what} not found.`);
export const forbidden = (message = 'You don’t have access to this.') => new ApiError('forbidden', message);
export const conflict = (message: string) => new ApiError('conflict', message);
export const badRequest = (message: string) => new ApiError('bad_request', message);
export const notAllowed = (message: string) => new ApiError('not_allowed', message);
export const unauthorized = (message = 'Sign in to continue.') => new ApiError('unauthorized', message);

/** An external action may have succeeded. A caller must inspect it before issuing a new request. */
export class UnknownOutcomeError extends ApiError {
  constructor(message: string) {
    super('conflict', message);
    this.name = 'UnknownOutcomeError';
  }
}

/** Field errors from a Zod error: `{ "text": ["Too small"] }`. */
export function zodFields(error: z.ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || '_';
    const list = fields[key] ?? [];
    list.push(issue.message);
    fields[key] = list;
  }
  return fields;
}

export function validationError(error: z.ZodError, message = 'Some fields are not valid.'): ApiError {
  return new ApiError('validation_failed', message, { fields: zodFields(error) });
}
