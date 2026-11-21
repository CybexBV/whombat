// Errors of the manage endpoints in forms: the field the platform refused
// (problem field_errors) and the answers that mean "look again".

import { ApiError } from '../../api/client';
import { errorText } from '../../components/forms';
import { t } from '../../lib/i18n';

/** key -> message of a 400 invalid_value (PVE's parameter errors, the agent's checks). */
export function fieldErrors(err: unknown): Record<string, string> {
  return err instanceof ApiError ? (err.problem?.field_errors ?? {}) : {};
}

/** 409 digest_mismatch: someone changed it meanwhile; reload and review. */
export function isDigestMismatch(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'digest_mismatch';
}

/** Text for a failed change, with the platform's field messages when they name no form field. */
export function manageErrorText(err: unknown, shownFields: string[] = []): string {
  if (isDigestMismatch(err)) return t('Changed meanwhile — review again.');
  const extra = Object.entries(fieldErrors(err))
    .filter(([k]) => !shownFields.includes(k))
    .map(([k, v]) => `${k}: ${v}`);
  return [errorText(err), ...extra].join(' · ');
}
