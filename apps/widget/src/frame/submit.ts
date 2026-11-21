/**
 * Sending a report (docs/decisions/feedback.md FB-09 … FB-11): one JSON POST, same-origin, no credentials, a
 * 30 s timeout, and every answer mapped to what the visitor can do next. The `submissionId` is made once per
 * draft and reused on every retry, so a report that reached the server before a failure is stored once.
 */
import { REFERENCE, randomToken } from '../shared/protocol';
import type { SubmissionBody } from './draft';

export const SUBMIT_TIMEOUT_MS = 30_000;

export interface Receipt {
  reference: string;
  receivedAt: string;
}

export type Outcome =
  | { kind: 'received'; receipt: Receipt }
  /** 400: these fields were refused (server names, `attachments.1`). */
  | { kind: 'invalid'; fields: string[] }
  /** 409: this submission id was already used for a different report. */
  | { kind: 'conflict' }
  /** 413 / 415 / 422: the screenshots (all, or the listed ones). */
  | { kind: 'attachments'; reason: 'too_large' | 'unsupported'; fields: string[] }
  | { kind: 'rate_limited'; retryAfter: number | null }
  /** 404: the site isn't accepting reports (unknown, disabled, origin not allowed). */
  | { kind: 'unavailable' }
  /** 5xx or an answer we don't understand. */
  | { kind: 'server' }
  /** No answer: offline, blocked, or the timeout. */
  | { kind: 'network' }
  /** A chosen screenshot couldn't be read any more (nothing was sent). */
  | { kind: 'unreadable' };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function fieldsOf(body: unknown): string[] {
  const error = (body as { error?: { fields?: unknown } } | null)?.error;
  const fields = error?.fields;
  return Array.isArray(fields) ? fields.filter((f): f is string => typeof f === 'string').slice(0, 50) : [];
}

function retryAfterOf(body: unknown, header: string | null): number | null {
  const fromBody = (body as { error?: { retryAfter?: unknown } } | null)?.error?.retryAfter;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody > 0) return Math.ceil(fromBody);
  const n = Number(header);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

function isReceipt(value: unknown): value is Receipt {
  const v = value as Receipt | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.reference === 'string' &&
    REFERENCE.test(v.reference) &&
    typeof v.receivedAt === 'string'
  );
}

/**
 * Posts the report and says what happened. Never throws. Signed in, the reporter session goes along as a bearer token
 * (the runtime marks the report verified; an unknown token is ignored, CT-162).
 */
export async function postReport(
  fetchImpl: FetchLike,
  url: string,
  body: SubmissionBody,
  timeoutMs = SUBMIT_TIMEOUT_MS,
  token: string | null = null,
): Promise<Outcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  let json: unknown = null;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    try {
      json = await res.json();
    } catch {
      json = null;
    }
  } catch {
    return { kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
  const s = res.status;
  if (s === 200 || s === 201)
    return isReceipt(json) ? { kind: 'received', receipt: json } : { kind: 'server' };
  if (s === 400) return { kind: 'invalid', fields: fieldsOf(json) };
  if (s === 404) return { kind: 'unavailable' };
  if (s === 409) return { kind: 'conflict' };
  if (s === 413) return { kind: 'attachments', reason: 'too_large', fields: fieldsOf(json) };
  if (s === 415 || s === 422) return { kind: 'attachments', reason: 'unsupported', fields: fieldsOf(json) };
  if (s === 429)
    return { kind: 'rate_limited', retryAfter: retryAfterOf(json, res.headers.get('retry-after')) };
  return { kind: 'server' };
}

/** A new idempotency key: 16 random bytes, base64url (FB-10). */
export function newSubmissionId(): string {
  return randomToken(16);
}

export type SubmitterState = 'editing' | 'sending' | 'done';

/** Thrown by a `build` that already knows the outcome without sending (drop mode's own checks, FD-28 (4)). */
export class OutcomeError extends Error {
  constructor(readonly outcome: Outcome) {
    super(outcome.kind);
  }
}

export interface SubmitterOptions {
  /**
   * Drop mode (FD-28 (5)): an edit after an attempt makes a new `submissionId`, since a drop can't answer 409 and
   * a changed report under the id of one that may already be stored would be refused later, unseen.
   */
  newIdOnEdit?: boolean;
}

/**
 * One draft's sending: at most one request at a time, the same `submissionId` for every retry, a new one only
 * after a receipt (`newDraft`) or when the visitor chooses to send a conflicting draft as a new report.
 *
 * The body is built once per draft (R1-2): a retry of an unchanged draft (same `draftKey`) sends exactly the same
 * body again, `context.sentAt` and the context included, so a report that reached the server before the failure
 * gets its receipt instead of a 409. An edited draft is built again. In drop mode the body is the sealed envelope:
 * sealed once per draft, the identical bytes on every retry.
 */
export class Submitter<B = SubmissionBody> {
  submissionId: string;
  state: SubmitterState = 'editing';
  last: Outcome | null = null;
  /** The body last built, for which draft and id. */
  private built: { draftKey: string; submissionId: string; body: B } | null = null;

  constructor(
    private readonly send: (body: B) => Promise<Outcome>,
    private readonly makeId: () => string = newSubmissionId,
    private readonly options: SubmitterOptions = {},
  ) {
    this.submissionId = makeId();
  }

  /**
   * Sends this draft: the body `build` makes for this draft's id, or the one already built for the same
   * `draftKey`. Null (and nothing sent) while sending or done.
   */
  async submit(build: (submissionId: string) => Promise<B>, draftKey: string): Promise<Outcome | null> {
    if (this.state !== 'editing') return null;
    this.state = 'sending';
    const outcome = await this.attempt(build, draftKey);
    this.last = outcome;
    this.state = outcome.kind === 'received' ? 'done' : 'editing';
    return outcome;
  }

  private async attempt(build: (submissionId: string) => Promise<B>, draftKey: string): Promise<Outcome> {
    const built = this.built;
    let body: B;
    if (built && built.draftKey === draftKey && built.submissionId === this.submissionId) body = built.body;
    else {
      if (this.options.newIdOnEdit && built && built.submissionId === this.submissionId)
        this.submissionId = this.makeId();
      try {
        body = await build(this.submissionId);
      } catch (err) {
        return err instanceof OutcomeError ? err.outcome : { kind: 'unreadable' };
      }
      this.built = { draftKey, submissionId: this.submissionId, body };
    }
    try {
      return await this.send(body);
    } catch {
      return { kind: 'network' };
    }
  }

  /** A fresh draft: a new id, nothing sent yet. */
  newDraft(): void {
    this.submissionId = this.makeId();
    this.state = 'editing';
    this.last = null;
    this.built = null;
  }
}
