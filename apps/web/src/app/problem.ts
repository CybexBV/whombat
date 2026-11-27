import { problemText } from '@whombat/client';
import { currentLocale } from '../i18n/provider';

/**
 * What a refused write says: the server's sentence (`validation_failed` with `details.reason`, …), a plain one for what
 * only a developer could read (a bare status, an endpoint's id), else a plain retry.
 */
export function writeProblem(e: unknown): string {
  return problemText(e, undefined, currentLocale());
}
