/**
 * The runner's side of `/internal/runner/*`: typed calls over the core `runnerApi` contract with the runner
 * token. Responses are validated against the contract; non-2xx answers throw `RunnerApiError`.
 */

import {
  type DispatchContext,
  PAGES_TRANSFER,
  type RunnerLease,
  type runnerApi,
  runnerAttachmentPath,
  SHA256_HEADER,
} from '@whombat/core';
import type { z } from 'zod';
import { createRunnerEndpointCaller } from './api-transport';

/** The lease this runner got with the claim; sent with every call about the dispatch. */
export function leaseOf(ctx: DispatchContext): RunnerLease {
  const { runnerId, attempts } = ctx.dispatch;
  if (!runnerId) return {};
  return { runnerId, ...(attempts ? { attempt: attempts } : {}) };
}

type Body<E extends keyof typeof runnerApi> = z.input<(typeof runnerApi)[E]['body']>;
type Res<E extends keyof typeof runnerApi> = z.output<(typeof runnerApi)[E]['response']>;

export class RunnerApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'RunnerApiError';
  }
}

export interface RunnerApi {
  claim(body: Body<'claim'>, signal?: AbortSignal): Promise<DispatchContext | null>;
  progress(dispatchId: string, body: Body<'progress'>): Promise<Res<'progress'>>;
  complete(dispatchId: string, body: Body<'complete'>): Promise<void>;
  heartbeat(body: Body<'heartbeat'>): Promise<Res<'heartbeat'>>;
  gitCredentials(dispatchId: string, body: Body<'gitCredentials'>): Promise<Res<'gitCredentials'>>;
  /**
   * One `gh` command of the turn (docs/decisions/agent-gh.md AGH-02): `run` with the token and the exact words, or
   * `done`. Optional for test doubles; a runner whose API lacks it gives no turn a gh.
   */
  ghAuthorize?(
    dispatchId: string,
    body: Body<'ghAuthorize'>,
    signal?: AbortSignal,
  ): Promise<Res<'ghAuthorize'>>;
  /**
   * The Whombat's person (`runner.person`, one-person.md OP-S131): the account that claimed it, null before the claim.
   * Optional for test doubles.
   */
  person?(): Promise<string | null>;
  /** A folder for a `browser_preview` (BT-48). Optional for test doubles. */
  submitPreview?(dispatchId: string, previewId: string, body: Body<'submitPreview'>): Promise<void>;
  /**
   * A page set's bytes for `show_pages` (docs/decisions/page-sets.md, `PAGES_TRANSFER`), streamed from its parts.
   * Optional for test doubles; a runner whose API lacks it says why on `submitPreview`.
   */
  submitPages?(
    dispatchId: string,
    previewId: string,
    lease: RunnerLease,
    parts: readonly Uint8Array[],
  ): Promise<void>;
  /**
   * One login's secret for the turn's Hermes (hermes-engine.md HE-S141), with the live lease. Optional for test doubles;
   * a runner whose API lacks it gives no turn its logins.
   */
  loginSecret?(dispatchId: string, entryId: string, body: Body<'loginSecret'>): Promise<Res<'loginSecret'>>;
  /**
   * Hermes asks the person for a login or a code in their turn (vault-simplify.md VLT-45): the card, then a long poll on
   * it. Optional for test doubles; a runner whose API lacks them lets Hermes hear that nobody can be asked.
   */
  loginAsk?(dispatchId: string, body: Body<'loginAsk'>): Promise<Res<'loginAsk'>>;
  loginAskWait?(
    dispatchId: string,
    messageId: string,
    query: { runnerId: string; attempt: number; waitMs: number },
    signal?: AbortSignal,
  ): Promise<Res<'loginAskWait'>>;
  /**
   * The websites the agent keeps signed in between its turns (kept-sites.md): keep, forget and list in the agent's turn
   * (the live lease); restore into a pod's fresh browser and renew a used one with the runner token only. Optional for
   * test doubles; a runner whose API lacks them keeps no site and restores none. Cookies in their bodies and answers
   * are never logged.
   */
  keptSiteKeep?(dispatchId: string, body: Body<'keptSiteKeep'>): Promise<Res<'keptSiteKeep'>>;
  keptSiteForget?(dispatchId: string, body: Body<'keptSiteForget'>): Promise<Res<'keptSiteForget'>>;
  keptSiteList?(dispatchId: string, body: Body<'keptSiteList'>): Promise<Res<'keptSiteList'>>;
  keptSiteRestore?(): Promise<Res<'keptSiteRestore'>>;
  keptSiteRenew?(siteId: string, body: Body<'keptSiteRenew'>): Promise<Res<'keptSiteRenew'>>;
  /**
   * The bytes of one attachment of the dispatch (Workstream A), streamed; the server re-checks the lease and
   * that the dispatch may use it. Optional so test doubles without attachments need not implement it.
   */
  fetchAttachment?(
    dispatchId: string,
    attachmentId: string,
    lease: RunnerLease,
    signal?: AbortSignal,
  ): Promise<FetchedAttachment>;
}

/** An attachment's bytes as the server sends them, with the size and hash it claims. */
export interface FetchedAttachment {
  body: AsyncIterable<Uint8Array>;
  size: number;
  sha256: string;
}

export function createRunnerApi(
  serverUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): RunnerApi & Required<Pick<RunnerApi, 'person' | 'keptSiteRestore' | 'keptSiteRenew'>> {
  const call = createRunnerEndpointCaller(serverUrl, token, fetchImpl, {
    httpError: (status, body, message) => new RunnerApiError(status, body, message),
    pendingApprovalError: (body) => new RunnerApiError(202, body, 'A person has to approve this first.'),
    alwaysJsonContentType: true,
  });

  return {
    async claim(body, signal) {
      try {
        return (await call('claim', { params: {}, body, signal })).dispatch;
      } catch (err) {
        if (signal?.aborted) return null;
        throw err;
      }
    },
    progress: (dispatchId, body) => call('progress', { params: { dispatchId }, body }),
    complete: async (dispatchId, body) => {
      await call('complete', { params: { dispatchId }, body });
    },
    heartbeat: (body) => call('heartbeat', { params: {}, body }),
    person: async () => (await call('person', { params: {}, body: {} })).accountId,
    gitCredentials: (dispatchId, body) => call('gitCredentials', { params: { dispatchId }, body }),
    ghAuthorize: (dispatchId, body, signal) => call('ghAuthorize', { params: { dispatchId }, body, signal }),
    submitPreview: async (dispatchId, previewId, body) => {
      await call('submitPreview', { params: { dispatchId, previewId }, body });
    },
    async submitPages(dispatchId, previewId, lease, parts) {
      const path = PAGES_TRANSFER.upload.path
        .replace(':dispatchId', encodeURIComponent(dispatchId))
        .replace(':previewId', encodeURIComponent(previewId));
      const url = new URL(`${PAGES_TRANSFER.upload.base}${path}`, serverUrl);
      if (lease.runnerId) url.searchParams.set('runnerId', lease.runnerId);
      if (lease.attempt) url.searchParams.set('attempt', String(lease.attempt));
      let next = 0;
      // The parts one after another, never copied into one buffer.
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const part = parts[next++];
          if (part) controller.enqueue(part);
          else controller.close();
        },
      });
      const res = await fetchImpl(url, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' },
        body,
        duplex: 'half',
      } as RequestInit);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let message = `page set upload answered ${res.status}`;
        try {
          message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
        } catch {}
        throw new RunnerApiError(res.status, text, message);
      }
      await res.body?.cancel().catch(() => {});
    },
    loginSecret: (dispatchId, entryId, body) =>
      call('loginSecret', { params: { dispatchId, entryId }, body }),
    loginAsk: (dispatchId, body) => call('loginAsk', { params: { dispatchId }, body }),
    loginAskWait: (dispatchId, messageId, query, signal) =>
      call('loginAskWait', { params: { dispatchId, messageId }, query, body: undefined, signal }),
    keptSiteKeep: (dispatchId, body) => call('keptSiteKeep', { params: { dispatchId }, body }),
    keptSiteForget: (dispatchId, body) => call('keptSiteForget', { params: { dispatchId }, body }),
    keptSiteList: (dispatchId, body) => call('keptSiteList', { params: { dispatchId }, body }),
    keptSiteRestore: () => call('keptSiteRestore', { params: {}, body: {} }),
    keptSiteRenew: (siteId, body) => call('keptSiteRenew', { params: { siteId }, body }),
    async fetchAttachment(dispatchId, attachmentId, lease, signal) {
      const url = new URL(runnerAttachmentPath(dispatchId, attachmentId), serverUrl);
      if (lease.runnerId) url.searchParams.set('runnerId', lease.runnerId);
      if (lease.attempt) url.searchParams.set('attempt', String(lease.attempt));
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        ...(signal ? { signal } : {}),
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        let message = `attachment fetch answered ${res.status}`;
        try {
          message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
        } catch {}
        throw new RunnerApiError(res.status, text, message);
      }
      return {
        body: res.body,
        size: Number(res.headers.get('content-length') ?? -1),
        sha256: res.headers.get(SHA256_HEADER) ?? '',
      };
    },
  };
}
