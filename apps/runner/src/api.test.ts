import { SHA256_HEADER } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { createRunnerApi, leaseOf, RunnerApiError } from './api';
import { testContext } from './test-context';

const base = 'https://runner.example/prefix/';
const lease = { runnerId: 'rnr_test', attempt: 3 };
const progressBody = { ...lease, state: 'running' as const };
const claimBody = { runnerId: lease.runnerId, providers: ['claude' as const] };

describe('runner endpoint calls', () => {
  it('sends each JSON endpoint with its lease and returns its validated answer', async () => {
    const replies = [
      { dispatch: null },
      { cancel: true, reason: 'taken_over' },
      { ok: true },
      { cancel: ['dsp_cancel'], recheck: true },
      { token: 'git-token', expiresAt: '2026-10-20T00:00:00.000Z', remoteUrl: '/repo' },
      { outcome: 'done', exitCode: 0, stdout: 'done', stderr: '' },
      { ok: true },
    ];
    const fetchImpl = vi.fn<typeof fetch>();
    for (const reply of replies) fetchImpl.mockResolvedValueOnce(Response.json(reply));
    const api = createRunnerApi(base, 'runner-token', fetchImpl);
    const signal = new AbortController().signal;
    const credentials = { ...lease, repo: 'local/repo', branch: 'feat/test', operation: 'push' as const };
    const gh = { ...lease, args: ['status'], files: [], stdin: null };
    const preview = { ...lease, files: [] };
    const heartbeat = { runnerId: lease.runnerId, active: ['dsp_test'] };
    const complete = { ...lease, outcome: 'cancelled' as const };

    expect(await api.claim(claimBody, signal)).toBeNull();
    expect(await api.progress('dsp/a', progressBody)).toEqual(replies[1]);
    expect(await api.complete('dsp/a', complete)).toBeUndefined();
    expect(await api.heartbeat(heartbeat)).toEqual(replies[3]);
    expect(await api.gitCredentials('dsp/a', credentials)).toEqual(replies[4]);
    expect(await api.ghAuthorize?.('dsp/a', gh, signal)).toEqual(replies[5]);
    expect(await api.submitPreview?.('dsp/a', 'preview/a', preview)).toBeUndefined();

    const expected = [
      ['/claim', claimBody, signal],
      ['/dispatches/dsp%2Fa/progress', progressBody, undefined],
      ['/dispatches/dsp%2Fa/complete', complete, undefined],
      ['/heartbeat', heartbeat, undefined],
      ['/dispatches/dsp%2Fa/git-credentials', credentials, undefined],
      ['/dispatches/dsp%2Fa/gh', gh, signal],
      ['/dispatches/dsp%2Fa/previews/preview%2Fa', preview, undefined],
    ];
    expect(fetchImpl).toHaveBeenCalledTimes(expected.length);
    expected.forEach(([path, body, expectedSignal], i) => {
      const [url, init] = fetchImpl.mock.calls[i] ?? [];
      expect(String(url)).toBe(`https://runner.example/internal/runner${path}`);
      expect(init).toEqual({
        method: 'POST',
        headers: { authorization: 'Bearer runner-token', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(expectedSignal ? { signal: expectedSignal } : {}),
      });
    });
  });

  it('returns the claimed dispatch after applying response defaults', async () => {
    const ctx = testContext();
    const api = createRunnerApi(base, 'token', async () => Response.json({ dispatch: ctx }));
    expect(await api.claim(claimBody)).toMatchObject({ dispatch: ctx.dispatch, agent: ctx.agent });
  });

  it.each([
    [409, { error: { message: 'Lease lost.' } }, 'Lease lost.'],
    [403, { blocked: true }, 'runner.progress answered 403'],
    [503, undefined, 'runner.progress answered 503'],
    [202, { approvalId: 'apr_test' }, 'A person has to approve this first.'],
  ])('keeps RunnerApiError fields for status %s', async (status, body, message) => {
    const api = createRunnerApi(base, 'token', async () =>
      body === undefined ? new Response(null, { status }) : Response.json(body, { status }),
    );
    const error = await api.progress('dsp_test', progressBody).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RunnerApiError);
    expect(error).toMatchObject({ name: 'RunnerApiError', status, body, message });
    expect(Object.keys(error as Error).sort()).toEqual(['body', 'name', 'status']);
  });

  it('rejects malformed JSON and invalid successful replies without converting the errors', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('not json', { status: 500 }))
      .mockResolvedValueOnce(Response.json({ cancel: 'yes' }))
      .mockResolvedValueOnce(new Response(null));
    const api = createRunnerApi(base, 'token', fetchImpl);
    await expect(api.progress('dsp_test', progressBody)).rejects.toBeInstanceOf(SyntaxError);
    await expect(api.progress('dsp_test', progressBody)).rejects.toBeInstanceOf(ZodError);
    await expect(api.complete('dsp_test', { ...lease, outcome: 'done' })).rejects.toBeInstanceOf(ZodError);
  });

  it('only suppresses a failed claim when its signal was aborted', async () => {
    const failure = new Error('connection failed');
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(failure);
    const api = createRunnerApi(base, 'token', fetchImpl);
    await expect(api.claim(claimBody, controller.signal)).rejects.toBe(failure);
    controller.abort();
    expect(await api.claim(claimBody, controller.signal)).toBeNull();
    await expect(api.ghAuthorize?.('dsp_test', { ...lease, args: [] }, controller.signal)).rejects.toBe(
      failure,
    );
    expect(fetchImpl.mock.calls[2]?.[1]?.signal).toBe(controller.signal);
  });

  it('takes the current lease from a claim without inventing a runner or attempt', () => {
    const ctx = testContext();
    expect(leaseOf(ctx)).toEqual({});
    ctx.dispatch.runnerId = lease.runnerId;
    expect(leaseOf(ctx)).toEqual({ runnerId: lease.runnerId });
    ctx.dispatch.attempts = lease.attempt;
    expect(leaseOf(ctx)).toEqual(lease);
  });
});

describe('runner attachment calls', () => {
  it('returns the unread byte stream and its headers with fencing and cancellation on the GET', async () => {
    const bytes = new Uint8Array([0, 128, 255]);
    const response = new Response(bytes, { headers: { 'content-length': '3', [SHA256_HEADER]: 'hash' } });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const signal = new AbortController().signal;
    const api = createRunnerApi(base, 'token', fetchImpl);
    const file = await api.fetchAttachment?.('dsp/a', 'att/a', lease, signal);
    expect(response.bodyUsed).toBe(false);
    expect(file).toEqual({ body: response.body, size: 3, sha256: 'hash' });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://runner.example/internal/runner/dispatches/dsp%2Fa/attachments/att%2Fa?runnerId=rnr_test&attempt=3',
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual({
      method: 'GET',
      headers: { authorization: 'Bearer token' },
      signal,
    });
    const chunks = [];
    if (!file) throw new Error('Missing attachment');
    for await (const chunk of file.body) chunks.push(...chunk);
    expect(chunks).toEqual([...bytes]);
  });

  it('keeps missing metadata defaults and omits absent lease fields', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('bytes'));
    const api = createRunnerApi(base, 'token', fetchImpl);
    expect(await api.fetchAttachment?.('dsp_test', 'att_test', {})).toMatchObject({ size: -1, sha256: '' });
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).search).toBe('');
  });

  it.each([
    [409, '{"error":{"message":"Lease lost."}}', 'Lease lost.'],
    [502, 'upstream failed', 'attachment fetch answered 502'],
    [200, null, 'attachment fetch answered 200'],
  ])('keeps attachment error bodies as text for status %s', async (status, body, message) => {
    const api = createRunnerApi(base, 'token', async () => new Response(body, { status }));
    const error = await api.fetchAttachment?.('dsp_test', 'att_test', lease).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RunnerApiError);
    expect(error).toMatchObject({ status, body: body ?? '', message });
  });
});
