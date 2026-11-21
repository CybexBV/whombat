/** Shared JSON transport for the runner's core endpoint contracts. */
import {
  type EndpointBody,
  type EndpointParams,
  type EndpointQuery,
  type EndpointResponse,
  endpointUrl,
  runnerApi,
} from '@whombat/core';

type RunnerEndpointName = keyof typeof runnerApi;
type RunnerEndpoint<E extends RunnerEndpointName> = (typeof runnerApi)[E];

interface EndpointRequest<E extends RunnerEndpointName> {
  params: EndpointParams<RunnerEndpoint<E>>;
  query?: EndpointQuery<RunnerEndpoint<E>>;
  body: EndpointBody<RunnerEndpoint<E>>;
  signal?: AbortSignal;
}

interface TransportPolicy {
  httpError(status: number, body: unknown, message: string): Error;
  /** Main runner calls treat an unexpected 202 as a keys-engine approval, before response validation. */
  pendingApprovalError?: (body: unknown) => Error;
  /** Main runner calls have always sent this header, even with an undefined body. */
  alwaysJsonContentType?: boolean;
}

export function createRunnerEndpointCaller(
  serverUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  policy: TransportPolicy,
) {
  return async <E extends RunnerEndpointName>(
    name: E,
    { params, query, body, signal }: EndpointRequest<NoInfer<E>>,
  ): Promise<EndpointResponse<RunnerEndpoint<E>>> => {
    const ep = runnerApi[name];
    const res = await fetchImpl(new URL(endpointUrl(ep, params, query), serverUrl), {
      method: ep.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined || policy.alwaysJsonContentType ? { 'content-type': 'application/json' } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const message =
        (json as { error?: { message?: string } } | undefined)?.error?.message ??
        `${ep.id} answered ${res.status}`;
      throw policy.httpError(res.status, json, message);
    }
    if (res.status === 202 && ep.status !== 202 && policy.pendingApprovalError)
      throw policy.pendingApprovalError(json);
    return ep.response.parse(json) as EndpointResponse<RunnerEndpoint<E>>;
  };
}
