/**
 * Refusals of the connections endpoints (contracts `CONNECTION_ERROR_CODES`, CT-269): the code goes in
 * `error.details.code` with what the form needs to explain itself (the network to add, the choices of a `fromService`
 * field, the limit), REST and session alike.
 */
import {
  CONNECTION_ERROR_MESSAGES,
  CONNECTION_ERROR_STATUS,
  type ConnectionErrorCode,
  type ConnectionErrorDetails,
} from '@whombat/core';
import { ApiError } from '../lib/errors';

export function connectionError(
  code: ConnectionErrorCode,
  extra: Omit<ConnectionErrorDetails, 'code'> = {},
  message: string = CONNECTION_ERROR_MESSAGES[code],
): ApiError {
  return new ApiError(CONNECTION_ERROR_STATUS[code], message, { details: { code, ...extra } as never });
}

/** A form's field errors (`validation_failed`): the entry's fields as `fields.<id>`, the token as `secret`. */
export function connectionFieldError(
  fields: Record<string, string>,
  message = 'Some fields are not valid.',
): ApiError {
  return new ApiError('validation_failed', message, {
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, [v]])),
  });
}

/** `fieldsProblems` as `fields.<id>` keys (the body's path). */
export function fieldProblemsError(problems: Record<string, string>): ApiError {
  const first = Object.values(problems)[0] ?? 'Some fields are not valid.';
  return connectionFieldError(
    Object.fromEntries(Object.entries(problems).map(([id, m]) => [`fields.${id}`, m])),
    first,
  );
}
