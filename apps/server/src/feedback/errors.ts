/**
 * Why a report can't be filed (docs/decisions/feedback.md): a closed set of codes, carried with the field names or the
 * wait that go with them. The drop worker turns a code into its answer to the drop, the tests read it as it is.
 */
import type { FeedbackPublicErrorCode } from '@whombat/core';

/**
 * `retryAfter` of a refusal for the daily cap, in seconds: a fixed value, so an answer reveals neither the
 * integration's limits nor when other reports arrived.
 */
export const PUBLIC_RETRY_AFTER = {
  /** The integration's daily cap is reached. */
  daily: 3600,
} as const;

/** Thrown anywhere on the path that files a report; its caller decides what the code becomes. */
export class FeedbackPublicFailure extends Error {
  constructor(
    readonly code: FeedbackPublicErrorCode,
    readonly extra: { fields?: string[]; retryAfter?: number } = {},
  ) {
    super(`feedback public ${code}`);
    this.name = 'FeedbackPublicFailure';
  }
}

export const unavailable = () => new FeedbackPublicFailure('unavailable');
