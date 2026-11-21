/** Types derived from the endpoint definitions in `@whombat/core/contracts`. */
import type { AnyEndpoint, api } from '@whombat/core/contracts';
import type { AuditKeyRef } from '@whombat/core/domain';
import type { z } from 'zod';

export type Api = typeof api;
export type ApiArea = keyof Api;

/** `z.coerce.*` fields have `unknown` input; callers pass numbers or strings there. */
type Coerced<T> = T extends object ? { [K in keyof T]: unknown extends T[K] ? string | number : T[K] } : T;

export type ParamsInput<E extends AnyEndpoint> = Coerced<z.input<E['params']>>;
export type QueryInput<E extends AnyEndpoint> = Coerced<z.input<E['query']>>;
export type BodyInput<E extends AnyEndpoint> = z.input<E['body']>;
/** Parsed success body of an endpoint. */
export type ResponseData<E extends AnyEndpoint> = z.output<E['response']>;

/** The empty object type, for "is every field optional?" checks. */
type Empty = Record<never, never>;

/** A part is omitted when the schema is `undefined`, optional when every field is optional. */
type Part<K extends string, T> = [T] extends [undefined]
  ? { [P in K]?: undefined }
  : Empty extends T
    ? { [P in K]?: T }
    : { [P in K]: T };

export interface RequestOptions {
  signal?: AbortSignal;
  /**
   * Idempotency key (MA-09): reuse it to retry the same logical request; generated when omitted. The appliance
   * refuses a reused id with a different payload.
   */
  requestId?: string;
  /** Deadline for delivery and acceptance, ms. */
  deadlineMs?: number;
  /** A durable command was accepted / started executing. */
  onProgress?: (state: 'accepted' | 'executing') => void;
}

/** Argument of an endpoint call: `{ params, query, body }` typed by the endpoint, plus request options. */
export type CallInput<E extends AnyEndpoint> = Part<'params', ParamsInput<E>> &
  Part<'query', QueryInput<E>> &
  Part<'body', BodyInput<E>> &
  RequestOptions;

/** The input argument is optional when nothing in it is required. */
export type CallArgs<E extends AnyEndpoint> =
  Empty extends CallInput<E> ? [input?: CallInput<E>] : [input: CallInput<E>];

/**
 * Outcome of a mutation. The keys engine can answer any mutation with "a person has to approve"
 * (202 `ApprovalRequiredBody`) or "blocked" (403 `BlockedBody`); both are results, not errors.
 * Mirrors the MCP `commitOutcome()` union.
 */
export type CommitResult<T> =
  | { status: 'ok'; data: T; httpStatus: number }
  | {
      status: 'pending_approval';
      approvalId: string;
      approvalNumber: number;
      /** The signed Asks event. */
      eventId: string;
    }
  | {
      status: 'blocked';
      keyNeeded: AuditKeyRef;
      /** The signed Blocked event. */
      eventId: string;
      message: string;
    };

export type IsQueryEndpoint<E extends AnyEndpoint> = E['method'] extends 'GET' ? true : false;

/** GET endpoints resolve to their data; mutations to a `CommitResult`. */
export type EndpointResult<E extends AnyEndpoint> =
  IsQueryEndpoint<E> extends true ? ResponseData<E> : CommitResult<ResponseData<E>>;

export type EndpointCaller<E extends AnyEndpoint> = ((...args: CallArgs<E>) => Promise<EndpointResult<E>>) & {
  readonly endpoint: E;
};

export type ApiCallers = {
  readonly [A in ApiArea]: {
    readonly [K in keyof Api[A]]: Api[A][K] extends AnyEndpoint ? EndpointCaller<Api[A][K]> : never;
  };
};

/** `area.action` of every GET endpoint in `api`. */
export type ReadEndpointOf<A extends ApiArea> = {
  [K in keyof Api[A]]: Api[A][K] extends { method: 'GET' } ? K : never;
}[keyof Api[A]];
