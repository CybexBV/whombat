/**
 * An op refusal with a session error code the REST vocabulary doesn't have (`unavailable`, …), and the application
 * code in `details.code` (CT-21). `errorAnswer` answers it as it is.
 */
import type { SessionErrorCode } from '@whombat/protocol/session';

export class SessionOpError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SessionOpError';
  }
}
