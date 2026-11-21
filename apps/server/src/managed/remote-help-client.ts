/**
 * The box's support service as the runtime sees it (docs/decisions/remote-help.md RH-02…RH-09; remote-help-server.md
 * RH-S02): `whombat-support`, a root service separate from the runtime, keeps the grant, judges Forever and the help
 * code, lets support in over the relay and records what they do. It answers a small JSON API on its unix socket
 * (`WHOMBAT_SUPPORT_SOCKET`, `/run/whombat-support/api.sock` on a box; `@whombat/control-contracts/local` support):
 *
 *   GET  /v1/state                                   → SupportState
 *   POST /v1/grant  {v, level, duration, grantedBy}  → SupportState      (`forever_not_allowed`, `unavailable`)
 *   POST /v1/stop   {v, reason, by?}                 → SupportState      (idempotent)
 *   GET  /v1/visits?before=&limit=                   → {v, visits}
 *   GET  /v1/visits/{id}/transcript                  → text/plain stream · 404
 *   GET  /v1/events?after=&waitS=                    → {v, events, next} (long poll, ≤ 25 s)
 *
 * Errors are `{error: {code}}` (`SUPPORT_ERRORS`); a state `supportStateValid` refuses is not the contract.
 * `WHOMBAT_SUPPORT=fake|fake-prod` puts the fake (`fake-support.ts`) in its place for development and the app's e2e
 * (`remote-help.ts` `supportFor`). Only the status and the code of an error are kept.
 */
import type { IncomingMessage } from 'node:http';
import {
  SUPPORT_ANSWER_MAX_BYTES,
  SUPPORT_EVENTS_WAIT_MAX_S,
  SUPPORT_PATHS,
  SupportEventsAnswer,
  SupportGrantRequest,
  type SupportState,
  SupportState as SupportStateSchema,
  SupportStopRequest,
  SupportVisitsAnswer,
  supportStateValid,
  supportTranscriptPath,
} from '@whombat/control-contracts/local';
import { openUnixHttp, requestUnixHttp, UnixHttpError } from '@whombat/node-io/http';
import {
  REMOTE_HELP_VISITS_MAX,
  RemoteHelpStep,
  RemoteHelpVisit,
  RemoteHelpVisitId,
  remoteHelpStepValid,
} from '@whombat/protocol/session';
import { z } from 'zod';

/**
 * The visits page read one visit and one step at a time: a step that isn't the contract's becomes a refusal with bad
 * arguments and a visit that still isn't is left out, so one odd record (support chooses what it types) never hides
 * the rest of the person's list (appliance NX-426; the box cleans steps before it records them).
 */
const LooseVisitsAnswer = z.object({
  v: SupportVisitsAnswer.shape.v,
  visits: z.array(z.unknown()).max(REMOTE_HELP_VISITS_MAX),
});

export function tolerantVisits(raw: readonly unknown[]): SupportVisit[] {
  const out: SupportVisit[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const { steps, startedAt } = item as { steps?: unknown; startedAt?: unknown };
    const cleaned = Array.isArray(steps)
      ? steps.map((step) => {
          const parsed = RemoteHelpStep.safeParse(step);
          if (parsed.success && remoteHelpStepValid(parsed.data)) return parsed.data;
          const at = (step as { at?: unknown } | null)?.at;
          const when = RemoteHelpStep.shape.at.safeParse(at).success ? at : startedAt;
          return { at: when, kind: 'refused', reason: 'bad_arguments' };
        })
      : steps;
    const visit = RemoteHelpVisit.safeParse({ ...item, steps: cleaned });
    if (visit.success) out.push(visit.data);
  }
  return out;
}

/** A visit as the socket lists it. */
export type SupportVisit = SupportVisitsAnswer['visits'][number];

/** The support service: the socket's client, or the fake. Refusals are `SupportCallError`s. */
export interface SupportPort {
  state(): Promise<SupportState>;
  grant(request: Omit<SupportGrantRequest, 'v'>): Promise<SupportState>;
  stop(request: Omit<SupportStopRequest, 'v'>): Promise<SupportState>;
  visits(query: { before?: string; limit?: number }): Promise<SupportVisit[]>;
  /** The visit's command-line output as the service keeps it (raw), or null when it has none. */
  transcript(visitId: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array> | null>;
  /** Events after `after`, waiting up to `waitS` for one. */
  events(after: number, waitS: number, signal?: AbortSignal): Promise<SupportEventsAnswer>;
}

/**
 * A call the service refused (its status and error code), or one it didn't answer (status 0, `unreachable`), or an
 * answer outside the contract (`invalid_answer`).
 */
export class SupportCallError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SupportCallError';
  }
}

/** The service refused it, or nobody listens on its socket: nothing happened (command-safety.md CS-01). */
export function supportRefused(err: unknown): boolean {
  if (!(err instanceof SupportCallError)) return false;
  if (err.status >= 400 && err.status < 500) return true;
  return err.status === 0 && /ENOENT|ECONNREFUSED/.test(err.message);
}

/** How long a call may take: the service answers from memory and its files; a long poll waits at most 25 s more. */
export const SUPPORT_CALL_MS = 3_000;
/** A transcript's headers come within this; then the stream may pause this long between chunks. */
export const SUPPORT_TRANSCRIPT_HEADERS_MS = 5_000;
export const SUPPORT_TRANSCRIPT_IDLE_MS = 30_000;

/** `'GET /v1/state'` or a bare path (the method given) as a method and a path. */
export function supportRoute(value: string, method = 'GET'): { method: string; path: string } {
  const space = value.indexOf(' ');
  return space < 0
    ? { method, path: value }
    : { method: value.slice(0, space), path: value.slice(space + 1) };
}

/** A `{error: {code}}`'s code (at most 64 characters), else `error`. Never the message. */
function errorCode(text: string): string {
  try {
    const code = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code;
    if (typeof code === 'string' && /^[a-z_]{1,64}$/.test(code)) return code;
  } catch {
    /* not an error body */
  }
  return 'error';
}

const isVisitId = (id: string) => RemoteHelpVisitId.safeParse(id).success;

export class SupportSocketClient implements SupportPort {
  constructor(
    private readonly socketPath: string,
    private readonly callMs = SUPPORT_CALL_MS,
  ) {}

  private async call<S extends z.ZodType>(
    route: { method: string; path: string },
    body: unknown,
    answer: S,
    options: { deadlineMs?: number; signal?: AbortSignal } = {},
  ): Promise<z.output<S>> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const label = route.path.split('?')[0] ?? route.path;
    let response: Awaited<ReturnType<typeof requestUnixHttp>>;
    try {
      response = await requestUnixHttp({
        socketPath: this.socketPath,
        path: route.path,
        method: route.method,
        headers:
          payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        ...(payload === undefined ? {} : { body: payload }),
        deadlineMs: options.deadlineMs ?? this.callMs,
        maxResponseBytes: SUPPORT_ANSWER_MAX_BYTES,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      const why = err instanceof UnixHttpError ? err.kind : String(err).slice(0, 120);
      throw new SupportCallError(label, 0, 'unreachable', `support ${label}: ${why}`);
    }
    const status = response.status || 500;
    const text = response.body.toString('utf8');
    if (status >= 300) {
      const code = errorCode(text);
      throw new SupportCallError(label, status, code, `support ${label}: ${status} ${code}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SupportCallError(label, status, 'invalid_answer', `support ${label}: not JSON`);
    }
    const parsed = answer.safeParse(json);
    if (!parsed.success)
      throw new SupportCallError(label, status, 'invalid_answer', `support ${label}: not the contract`);
    return parsed.data;
  }

  /** A state the schema takes and `supportStateValid` too (a help code exactly where needed, no Forever on prod …). */
  private async stateCall(route: { method: string; path: string }, body?: unknown): Promise<SupportState> {
    const state = await this.call(route, body, SupportStateSchema);
    if (!supportStateValid(state))
      throw new SupportCallError(
        route.path,
        200,
        'invalid_answer',
        `support ${route.path}: not a valid state`,
      );
    return state;
  }

  state(): Promise<SupportState> {
    return this.stateCall(supportRoute(SUPPORT_PATHS.state));
  }

  grant(request: Omit<SupportGrantRequest, 'v'>): Promise<SupportState> {
    return this.stateCall(
      supportRoute(SUPPORT_PATHS.grant, 'POST'),
      SupportGrantRequest.parse({ v: 1, ...request }),
    );
  }

  stop(request: Omit<SupportStopRequest, 'v'>): Promise<SupportState> {
    return this.stateCall(
      supportRoute(SUPPORT_PATHS.stop, 'POST'),
      SupportStopRequest.parse({ v: 1, ...request }),
    );
  }

  async visits(query: { before?: string; limit?: number }): Promise<SupportVisit[]> {
    const route = supportRoute(SUPPORT_PATHS.visits);
    const params = new URLSearchParams();
    if (query.before !== undefined) {
      if (!isVisitId(query.before)) throw new SupportCallError(route.path, 400, 'bad_request', 'visit id');
      params.set('before', query.before);
    }
    if (query.limit !== undefined)
      params.set('limit', String(Math.max(1, Math.min(REMOTE_HELP_VISITS_MAX, query.limit))));
    const qs = params.toString();
    const answer = await this.call(
      { method: route.method, path: qs ? `${route.path}?${qs}` : route.path },
      undefined,
      LooseVisitsAnswer,
    );
    return tolerantVisits(answer.visits);
  }

  async transcript(visitId: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array> | null> {
    if (!isVisitId(visitId)) return null;
    let res: IncomingMessage;
    try {
      ({ res } = await openUnixHttp({
        socketPath: this.socketPath,
        path: supportTranscriptPath(visitId),
        method: 'GET',
        deadlineMs: SUPPORT_TRANSCRIPT_HEADERS_MS,
        deadlineUntil: 'headers',
        idleTimeoutMs: SUPPORT_TRANSCRIPT_IDLE_MS,
        ...(signal ? { signal } : {}),
      }));
    } catch (err) {
      const why = err instanceof UnixHttpError ? err.kind : String(err).slice(0, 120);
      throw new SupportCallError('transcript', 0, 'unreachable', `support transcript: ${why}`);
    }
    const status = res.statusCode ?? 500;
    if (status === 404) {
      res.destroy();
      return null;
    }
    if (status >= 300) {
      res.destroy();
      throw new SupportCallError('transcript', status, 'error', `support transcript: ${status}`);
    }
    return res;
  }

  events(after: number, waitS: number, signal?: AbortSignal): Promise<SupportEventsAnswer> {
    const route = supportRoute(SUPPORT_PATHS.events);
    const wait = Math.max(0, Math.min(SUPPORT_EVENTS_WAIT_MAX_S, Math.floor(waitS)));
    const qs = new URLSearchParams({ after: String(Math.max(0, Math.floor(after))), waitS: String(wait) });
    return this.call({ method: route.method, path: `${route.path}?${qs}` }, undefined, SupportEventsAnswer, {
      deadlineMs: wait * 1000 + this.callMs,
      ...(signal ? { signal } : {}),
    });
  }
}
