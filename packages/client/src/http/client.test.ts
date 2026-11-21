import { API_ENDPOINTS, api } from '@whombat/core/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeSession } from '../session/fake-session';
import type { ApplianceSession } from '../session/types';
import { message } from '../test/fixtures';
import { createClient, unwrap } from './client';
import {
  ApiError,
  ApprovalRequiredError,
  BlockedError,
  ContractError,
  InvalidRequestError,
  isApiError,
  NetworkError,
} from './errors';

/** What reached the box: the operation and its parsed parts. */
interface Call {
  op: string;
  input: { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };
}

const live: ApplianceSession[] = [];
afterEach(() => {
  for (const s of live.splice(0)) s.close();
});

/** A client whose box answers every operation with `answer` (HTTP terms), recording what arrived. */
function over(
  answer: (call: Call) => { status: number; body?: unknown },
  options: {
    validateResponses?: boolean;
    onUnauthorized?: (info: { endpointId: string; status: number }) => void;
  } = {},
) {
  const calls: Call[] = [];
  const { session, appliance } = createFakeSession({
    account: { id: 'acc_mara', name: 'Mara' },
    sendsNewer: true,
    handle: async (op, input) => {
      const call = { op, input: input as Call['input'] };
      calls.push(call);
      const r = answer(call);
      return { status: r.status, body: r.body };
    },
    session: { deadlineMs: 100, backoff: { initialMs: 2, maxMs: 5 } },
  });
  live.push(session);
  const client = createClient({
    session,
    validateResponses: options.validateResponses ?? true,
    ...(options.onUnauthorized && { onUnauthorized: options.onUnauthorized }),
  });
  return { client, calls, appliance };
}

const sent = { message: message('msg_1', { text: 'Ship it' }), dispatches: [] };

describe('createClient: inputs', () => {
  it('exposes a caller for every endpoint in api', () => {
    const { client } = over(() => ({ status: 200, body: {} }));
    const callers = Object.values(client)
      .filter((g) => typeof g === 'object' && g !== null && !Object.isFrozen(g))
      .flatMap((g) => Object.values(g as Record<string, { endpoint?: { id: string } }>))
      .map((c) => c.endpoint?.id)
      .filter(Boolean);
    expect(callers.sort()).toEqual(API_ENDPOINTS.map((e) => e.id).sort());
    expect(client.messages.send.endpoint).toBe(api.messages.send);
  });

  it('checks path params before sending, and sends them parsed', async () => {
    const { client, calls } = over(() => ({ status: 200, body: { plan: null } }), {
      validateResponses: false,
    });
    await client.plans.get({ params: { burrow: 'burrow-hq', planId: 'pln_a b' as 'pln_x' } }).catch(() => {});
    expect(calls).toHaveLength(0); // invalid id rejected before sending
    await client.runs.get({ params: { burrow: 'burrow-hq', number: '1907' } });
    expect(calls[0]).toMatchObject({
      op: 'runs.get',
      input: { params: { burrow: 'burrow-hq', number: 1907 } },
    });
  });

  it('sends queries with defaults applied and without undefined', async () => {
    const { client, calls } = over(() => ({ status: 200, body: {} }), { validateResponses: false });
    await client.messages.list({
      params: { burrow: 'burrow-hq', conversationId: 'cnv_chat' },
      query: { before: undefined },
    });
    expect(calls[0]?.input.query).toEqual({ limit: 50 });
    await client.audit.list({ params: { burrow: 'burrow-hq' }, query: { who: 'banjo', kind: 'code' } });
    expect(calls[1]?.input.query).toMatchObject({
      actor: 'everyone',
      kind: 'code',
      who: 'banjo',
      limit: 100,
    });
  });

  it('validates and sends bodies', async () => {
    const { client, calls } = over(() => ({ status: 201, body: sent }));
    const result = await client.messages.send({
      params: { burrow: 'burrow-hq', conversationId: 'cnv_chat' },
      body: { text: '  Ship it  ', clientId: 'c1' },
    });
    expect(result).toMatchObject({ status: 'ok', data: { message: { text: 'Ship it' } } });
    expect(calls[0]?.input.body).toEqual({ text: 'Ship it', clientId: 'c1' });
  });

  it('rejects invalid input with field errors and sends nothing', async () => {
    const { client, calls } = over(() => ({ status: 201, body: sent }));
    const error = await client.messages
      .send({ params: { burrow: 'burrow-hq', conversationId: 'cnv_chat' }, body: { text: '   ' } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect((error as InvalidRequestError).part).toBe('body');
    expect(Object.keys((error as InvalidRequestError).fields)).toEqual(['text']);
    expect(calls).toHaveLength(0);
  });

  it('calls endpoints without input', async () => {
    const { client } = over(() => ({
      status: 200,
      body: { ok: true, service: 'whombat-server', db: 'up', time: 't' },
    }));
    await expect(client.health.get()).resolves.toMatchObject({ ok: true, db: 'up' });
  });

  it('calls onUnauthorized on 401 and throws a typed ApiError', async () => {
    const onUnauthorized = vi.fn();
    const { client } = over(
      () => ({ status: 401, body: { error: { code: 'unauthorized', message: 'Sign in' } } }),
      {
        onUnauthorized,
      },
    );
    const error = await client.health.get().catch((e: unknown) => e);
    expect(onUnauthorized).toHaveBeenCalledWith({ endpointId: 'health.get', status: 401 });
    expect(isApiError(error, 'unauthorized')).toBe(true);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe('Sign in');
  });
});

describe('createClient: keys-engine outcomes', () => {
  const approvalBody = {
    approvalRequired: true,
    approvalId: 'apr_12',
    approvalNumber: 12,
    eventId: 'evt_9f31',
  };
  const blockedBody = {
    error: { code: 'blocked', message: 'Banjo does not hold “Deploy to production”' },
    blocked: true,
    keyNeeded: { id: 'deploy.production', label: 'Deploy to production' },
    eventId: 'evt_9d77',
  };

  it('returns an approval as pending_approval', async () => {
    const { client } = over(() => ({ status: 202, body: approvalBody }));
    const result = await client.prs.merge({ params: { burrow: 'burrow-hq', number: 482 } });
    expect(result).toEqual({
      status: 'pending_approval',
      approvalId: 'apr_12',
      approvalNumber: 12,
      eventId: 'evt_9f31',
    });
    expect(() => unwrap(result)).toThrow(ApprovalRequiredError);
  });

  it('returns a block as blocked', async () => {
    const { client } = over(() => ({ status: 403, body: blockedBody }));
    const result = await client.prs.merge({ params: { burrow: 'burrow-hq', number: 482 } });
    expect(result).toEqual({
      status: 'blocked',
      keyNeeded: { id: 'deploy.production', label: 'Deploy to production' },
      eventId: 'evt_9d77',
      message: 'Banjo does not hold “Deploy to production”',
    });
    const error = (() => {
      try {
        unwrap(result);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(BlockedError);
    expect((error as BlockedError).keyNeeded.id).toBe('deploy.production');
  });

  it('treats a 202 success (search.ask) as ok, not as an approval', async () => {
    const answer = {
      id: 'ans_1',
      burrowId: 'bur_burrow-hq',
      query: 'q',
      agentId: 'prn_dusty',
      status: 'pending',
      text: '',
      citations: [],
      durationMs: null,
      actions: [],
      createdAt: '2026-09-23T09:22:00.000Z',
    };
    const { client } = over(() => ({ status: 202, body: { answer } }));
    const result = await client.search.ask({ params: { burrow: 'burrow-hq' }, body: { q: 'why' } });
    expect(result.status).toBe('ok');
  });

  it('throws ApiError for a plain refusal (not the keys engine)', async () => {
    const { client } = over(() => ({
      status: 403,
      body: { error: { code: 'not_allowed', message: 'Owners only' } },
    }));
    await expect(client.burrows.update({ params: { burrow: 'burrow-hq' }, body: {} })).rejects.toMatchObject({
      name: 'ApiError',
      code: 'not_allowed',
      status: 403,
    });
  });

  it('carries validation field errors on ApiError', async () => {
    const { client } = over(() => ({
      status: 400,
      body: { error: { code: 'validation_failed', message: 'Bad', fields: { name: ['Too long'] } } },
    }));
    const error = (await client.burrows.create({ body: { name: 'x' } }).catch((e: unknown) => e)) as ApiError;
    expect(error.fields).toEqual({ name: ['Too long'] });
  });
});

describe('createClient: responses', () => {
  it('validates responses in dev and throws ContractError on drift', async () => {
    const strict = over(() => ({ status: 200, body: { ok: 'yes' } }), { validateResponses: true }).client;
    await expect(strict.health.get()).rejects.toBeInstanceOf(ContractError);
    const lax = over(() => ({ status: 200, body: { ok: 'yes' } }), { validateResponses: false }).client;
    await expect(lax.health.get()).resolves.toEqual({ ok: 'yes' });
  });

  it('a call the Whombat never got is a NetworkError', async () => {
    const { client, appliance } = over(() => ({ status: 200, body: {} }));
    appliance.faults.offline(true);
    await expect(client.health.get()).rejects.toBeInstanceOf(NetworkError);
  });

  it('request() works for any endpoint definition', async () => {
    const { client, calls } = over(() => ({ status: 200, body: { ok: true } }), { validateResponses: false });
    const result = await client.request(api.me.get);
    expect(result).toMatchObject({ status: 'ok', data: { ok: true } });
    expect(calls[0]?.op).toBe('me.get');
  });

  it('ApiError with an application code keeps the Whombat’s message, fields and details (AP-290)', async () => {
    const body = {
      error: {
        code: 'managed.feedback_intake',
        message: 'Feedback needs an update of this Whombat’s cloud connection.',
        details: { code: 'managed.feedback_intake', managed: true },
      },
    };
    const { client } = over(() => ({ status: 403, body }));
    const error = (await client.health.get().catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 403,
      code: 'unknown',
      message: 'Feedback needs an update of this Whombat’s cloud connection.',
      details: { code: 'managed.feedback_intake', managed: true },
    });
  });
});
