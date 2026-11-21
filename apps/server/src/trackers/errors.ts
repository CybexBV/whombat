/**
 * How a tracker's failures reach the workflow (docs/decisions/report-trackers.md): a driver's `TrackerFailure`, a call
 * that took too long or a driver that isn't installed become one of these, which the poller, the steps and the people's
 * routes already handle.
 */

/** Why the connection can't be read or written right now: stops the cycle; the next one tries again. */
export class SourceProblem extends Error {
  constructor(
    readonly code: 'refused' | 'unreachable' | 'invalid_answer',
    message: string,
  ) {
    super(message);
    this.name = 'SourceProblem';
  }
}

/** The report changed under the write twice in a row: a busy moment, sent again later with the same request id. */
export class TrackerConflict extends Error {
  override name = 'TrackerConflict';
}

/** The tracker refused this write; `message` is its text. Repeating it won't help. */
export class TrackerRefusal extends Error {
  override name = 'TrackerRefusal';
}

/** The tracker has no such report (any more), or no such package of it. */
export class TrackerNotFound extends Error {
  override name = 'TrackerNotFound';
}

/** The tracker didn't grant the organization's access: `message` says why, in plain words. */
export class AccessRefused extends Error {
  override name = 'AccessRefused';
}
