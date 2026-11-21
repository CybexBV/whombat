/**
 * `createClient()` — a typed caller for every endpoint in `api`, built generically from the endpoint
 * definitions: `client.messages.send({ params, body })`. Inputs are validated with the endpoint's Zod
 * schemas before anything is sent (defaults and coercions applied). Responses are decoded tolerantly (AP-255):
 * unknown members stripped, defaults filled, an item carrying an enum member or union kind this app doesn't know left
 * out (`decodeForUi`, counted in `leftOut`); an answer that still doesn't match throws in dev and passes as it came in
 * production. Security views (`strict.ts`, AP-266) are decoded strictly everywhere: a mismatch throws
 * `NeedsNewerAppError`; an agent's profile only in its keys (AP-707).
 *
 * GET endpoints resolve to their data and throw on errors. Mutations resolve to a `CommitResult`:
 * `ok`, `pending_approval` (202 `ApprovalRequiredBody`) or `blocked` (403 `BlockedBody`).
 *
 * Every call goes through the client's `ApplianceSession` (AP-10). No DOM-only APIs.
 */
import {
  type AnyEndpoint,
  ApiErrorBody,
  ApprovalRequiredBody,
  api,
  BlockedBody,
  NoBody,
} from '@whombat/core/contracts';
import { z } from 'zod';
import { isExportFile } from '../session/resources';
import { type ApplianceSession, NotDeliveredError, type OperationResponse } from '../session/types';
import { isStrictEndpoint, strictPartsOf } from '../strict';
import { decodeForUi, noteSkipped, noteStrict } from '../tolerant';
import {
  ApiError,
  ApprovalRequiredError,
  BlockedError,
  ContractError,
  InvalidRequestError,
  issuesToFields,
  NeedsNewerAppError,
  NetworkError,
} from './errors';
import type {
  ApiCallers,
  CallInput,
  CommitResult,
  EndpointCaller,
  EndpointResult,
  RequestOptions,
  ResponseData,
} from './types';

export interface ClientOptions {
  /** The appliance session every call goes through (AP-10). */
  session: ApplianceSession;
  /** Called on every 401 before the `ApiError` is thrown. */
  onUnauthorized?: (info: { endpointId: string; status: number }) => void;
  /**
   * Strict responses: throw `ContractError` when an answer doesn't match the contract even after tolerant decoding.
   * Off (production), such an answer is used as it came and `onContractDrift` hears of it. Every answer is decoded
   * tolerantly either way (AP-255). Defaults to on unless `NODE_ENV === 'production'` or React Native's
   * `__DEV__ === false`. Web apps pass `import.meta.env.DEV`.
   */
  validateResponses?: boolean;
  /** An answer that didn't match the contract, used as it came (production). */
  onContractDrift?: (info: { endpointId: string; fields: Record<string, string[]> }) => void;
}

export type WhombatClient = ApiCallers & {
  /** Call any endpoint definition (including `runnerApi`) and get the full `CommitResult`. */
  request<E extends AnyEndpoint>(endpoint: E, input?: CallInput<E>): Promise<CommitResult<ResponseData<E>>>;
  readonly options: Readonly<ClientOptions>;
  /** The session the client talks through. */
  readonly session: ApplianceSession;
};

export function defaultValidateResponses(): boolean {
  const g = globalThis as { __DEV__?: unknown; process?: { env?: Record<string, string | undefined> } };
  if (typeof g.__DEV__ === 'boolean') return g.__DEV__;
  return g.process?.env?.NODE_ENV !== 'production';
}

/** Answers whose screens show a placeholder row for each item left out, so `leftOut` doesn't count them. */
const OWN_PLACEHOLDERS: ReadonlySet<string> = new Set(['work.overview', 'notifications.inbox']);

export function createClient(options: ClientOptions): WhombatClient {
  const validateResponses = options.validateResponses ?? defaultValidateResponses();
  const { session } = options;

  function parsePart(ep: AnyEndpoint, part: 'params' | 'query' | 'body', value: unknown): unknown {
    // A missing part is an empty object, except a body the endpoint does not take.
    const input = value === undefined && (part !== 'body' || ep.body !== NoBody) ? {} : value;
    const r = ep[part].safeParse(input);
    if (!r.success) throw new InvalidRequestError(ep.id, part, issuesToFields(r.error.issues));
    return r.data;
  }

  async function request<E extends AnyEndpoint>(
    ep: E,
    input: CallInput<E> = {} as CallInput<E>,
  ): Promise<CommitResult<ResponseData<E>>> {
    const raw = input as { params?: unknown; query?: unknown; body?: unknown } & RequestOptions;
    const params = parsePart(ep, 'params', raw.params) as Record<string, unknown>;
    const query = parsePart(ep, 'query', raw.query) as Record<string, unknown>;
    const body = ep.body !== NoBody ? parsePart(ep, 'body', raw.body) : undefined;

    let res: OperationResponse;
    try {
      res = await session.call(
        ep,
        { params, query, body },
        {
          ...(raw.signal && { signal: raw.signal }),
          ...(raw.requestId && { requestId: raw.requestId }),
          ...(raw.deadlineMs && { deadlineMs: raw.deadlineMs }),
          ...(raw.onProgress && { onProgress: raw.onProgress }),
        },
      );
    } catch (error) {
      // Nothing reached the appliance (safe to retry): a network error. Ambiguous outcomes
      // (`OutcomeUnknownError`), closed sessions and aborts propagate as they are.
      if (error instanceof NotDeliveredError) throw new NetworkError(ep.id, error);
      throw error;
    }
    return decode(ep, res, `${ep.id} ${JSON.stringify(params)} ${JSON.stringify(query)}`);
  }

  function decode<E extends AnyEndpoint>(
    ep: E,
    res: OperationResponse,
    /** What the answer counts under in `leftOut` (the endpoint and its parameters). */
    source: string,
  ): CommitResult<ResponseData<E>> {
    const parsed = res.body;
    if (res.status === 202 && isObject(parsed) && parsed.approvalRequired === true) {
      const outcome = validateResponses ? ApprovalRequiredBody.safeParse(parsed) : null;
      if (outcome && !outcome.success)
        throw new ContractError(ep.id, issuesToFields(outcome.error.issues), parsed);
      const b = parsed as ApprovalRequiredBody;
      return {
        status: 'pending_approval',
        approvalId: b.approvalId,
        approvalNumber: b.approvalNumber,
        eventId: b.eventId,
      };
    }
    if (res.status === 403 && isObject(parsed) && parsed.blocked === true) {
      const outcome = validateResponses ? BlockedBody.safeParse(parsed) : null;
      if (outcome && !outcome.success)
        throw new ContractError(ep.id, issuesToFields(outcome.error.issues), parsed);
      const b = parsed as BlockedBody;
      return { status: 'blocked', keyNeeded: b.keyNeeded, eventId: b.eventId, message: b.error.message };
    }
    if (res.status < 200 || res.status >= 300) {
      if (res.status === 401) options.onUnauthorized?.({ endpointId: ep.id, status: res.status });
      throw toApiError(ep.id, res.status, parsed);
    }

    // An export op's file (AP-45): raw bytes, not the contract's JSON body — handed over as the `ExportFile` it is
    // (use `exportPackArchive` for a typed result).
    if (isExportFile(parsed))
      return { status: 'ok', data: parsed as ResponseData<E>, httpStatus: res.status };
    let data: unknown = parsed === undefined && ep.contentType !== 'text/csv' ? undefined : parsed;
    if (isStrictEndpoint(ep.id)) {
      // A security view (AP-266): nothing left out or shown as something else; the screen says it needs an update.
      const r = ep.response.safeParse(data);
      noteStrict(source, !r.success);
      if (!r.success) throw new NeedsNewerAppError(ep.id, issuesToFields(r.error.issues), data);
      return { status: 'ok', data: r.data as ResponseData<E>, httpStatus: res.status };
    }
    // An agent's keys (AP-707): read strictly, the rest of its profile tolerantly.
    const parts = strictPartsOf(ep.id);
    let strict: Record<string, unknown> | null = null;
    if (parts) {
      const p = strictPartSchema(ep.response, parts).safeParse(data);
      noteStrict(source, !p.success);
      if (!p.success) throw new NeedsNewerAppError(ep.id, issuesToFields(p.error.issues), data);
      strict = p.data as Record<string, unknown>;
    }
    const r = decodeForUi(ep.response, data);
    if (r.ok) {
      data = r.data;
      // The work overview and the inbox show their own placeholder rows (AP-255, AP-701).
      if (!OWN_PLACEHOLDERS.has(ep.id)) noteSkipped(source, r.skipped);
    } else {
      const fields = issuesToFields(r.error.issues);
      if (validateResponses) throw new ContractError(ep.id, fields, data);
      options.onContractDrift?.({ endpointId: ep.id, fields });
    }
    // Whatever the tolerant pass made of the rest, the strict members are the ones read strictly.
    if (strict && isObject(data)) data = { ...data, ...strict };
    return { status: 'ok', data: data as ResponseData<E>, httpStatus: res.status };
  }

  function makeCaller<E extends AnyEndpoint>(ep: E): EndpointCaller<E> {
    const call = async (input?: CallInput<E>) => {
      const result = await request(ep, input);
      if (ep.method !== 'GET') return result;
      // Reads never go through the keys engine; treat an outcome as a protocol error.
      if (result.status !== 'ok')
        throw new ContractError(ep.id, { '': [`unexpected ${result.status}`] }, result);
      return result.data;
    };
    return Object.assign(call as (...args: unknown[]) => Promise<EndpointResult<E>>, { endpoint: ep });
  }

  const callers: Record<string, Record<string, unknown>> = {};
  for (const [area, group] of Object.entries(api)) {
    const target: Record<string, unknown> = {};
    for (const [action, ep] of Object.entries(group as Record<string, AnyEndpoint>))
      target[action] = makeCaller(ep);
    callers[area] = target;
  }

  return Object.assign(callers as unknown as ApiCallers, {
    request,
    options: Object.freeze({ ...options }),
    session,
  });
}

/** The members `parts` of an object answer's schema (the whole schema when it isn't an object). */
function strictPartSchema(schema: z.ZodType, parts: readonly string[]): z.ZodType {
  const object = schema as z.ZodType & { pick?: (mask: Record<string, true>) => z.ZodType };
  if (typeof object.pick !== 'function') return schema;
  return object.pick(Object.fromEntries(parts.map((p) => [p, true] as const)));
}

/** Data of an `ok` result; throws `ApprovalRequiredError` / `BlockedError` for the other outcomes. */
export function unwrap<T>(result: CommitResult<T>): T {
  switch (result.status) {
    case 'ok':
      return result.data;
    case 'pending_approval':
      throw new ApprovalRequiredError({
        approvalRequired: true,
        approvalId: result.approvalId,
        approvalNumber: result.approvalNumber,
        eventId: result.eventId,
      });
    case 'blocked':
      throw new BlockedError({
        error: { code: 'blocked', message: result.message },
        blocked: true,
        keyNeeded: result.keyNeeded,
        eventId: result.eventId,
      });
  }
}

/** A non-2xx answer as the typed client throws it (`ApiErrorBody` → `ApiError`). */
export function toApiError(endpointId: string, status: number, body: unknown): ApiError {
  const r = ApiErrorBody.safeParse(body);
  if (r.success) {
    const e = r.data.error;
    return new ApiError(status, e.code, e.message, body, endpointId, e.fields ?? {}, e.details);
  }
  // An application code the contract's list doesn't have (`managed.feedback_intake`, `claim_used`…, AP-19 and AP-290):
  // the server's words, fields and details still stand; only the code falls back to `unknown`.
  const loose = LooseErrorBody.safeParse(body);
  if (loose.success) {
    const e = loose.data.error;
    return new ApiError(status, 'unknown', e.message, body, endpointId, e.fields ?? {}, e.details);
  }
  return new ApiError(status, 'unknown', `Request failed with status ${status}`, body, endpointId);
}

const LooseErrorBody = z.object({
  error: ApiErrorBody.shape.error.extend({ code: z.string(), message: z.string().min(1) }),
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
