import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { RunnerApiError } from '../api';
import { createRunnerCommandsApi } from './api';

const base = 'https://runner.example/prefix/';
const lease = { runnerId: 'rnr_test', attempt: 3 };
const keys = { files: [], env: [], mcpServers: [], entries: [] };
const pending = { outcome: 'pending', approvalId: 'apr_test', message: 'Waiting.', open: [] };

describe('the commands’ endpoint calls', () => {
  it('preserves command bodies, GET queries and signals with the current lease', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(pending))
      .mockResolvedValueOnce(Response.json({ outcome: 'run', scope: 'once', message: '', open: [] }))
      .mockResolvedValueOnce(Response.json(keys))
      .mockResolvedValueOnce(Response.json({ dispatchId: 'dsp_woken' }, { status: 201 }));
    const api = createRunnerCommandsApi(base, 'token', fetchImpl);
    const command = {
      ...lease,
      dispatchId: 'dsp_test',
      command: 'deploy',
      category: 'deploy' as const,
      target: null,
    };
    const query = { ...lease, dispatchId: 'dsp_test', waitMs: 25_000 };
    const signal = new AbortController().signal;
    expect(await api.authorizeCommand(command)).toEqual(pending);
    expect(await api.authorizeWait('apr/a', query, signal)).toMatchObject({ outcome: 'run', scope: 'once' });
    expect(await api.turnKeys('dsp/a', lease)).toEqual(keys);
    const notify = { fromDispatchId: 'dsp_test', ...lease, eventId: 'evt_12345678', text: 'build done' };
    expect(await api.notify(notify)).toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const paths = [
      '/commands/authorize',
      '/commands/authorize/apr%2Fa',
      '/dispatches/dsp%2Fa/turn-keys',
      '/notify',
    ];
    fetchImpl.mock.calls.forEach(([input, init], i) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe(`https://runner.example/internal/runner${paths[i]}`);
      if (i === 1 || i === 2) {
        expect(Object.fromEntries(url.searchParams)).toEqual(
          i === 1
            ? { runnerId: 'rnr_test', attempt: '3', dispatchId: 'dsp_test', waitMs: '25000' }
            : { runnerId: 'rnr_test', attempt: '3' },
        );
        expect(init).toEqual({
          method: 'GET',
          headers: { authorization: 'Bearer token' },
          ...(i === 1 ? { signal } : {}),
        });
      } else {
        expect(url.search).toBe('');
        expect(init).toEqual({
          method: 'POST',
          headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
          body: JSON.stringify(i === 0 ? command : notify),
        });
      }
    });
  });

  it.each([
    [409, { error: { message: 'Lease lost.' } }, 'Lease lost.'],
    [403, {}, 'runner.turnKeys answered 403'],
    [503, undefined, 'runner.turnKeys answered 503'],
  ])('keeps the ordinary Error with only a status field for %s', async (status, body, message) => {
    const api = createRunnerCommandsApi(base, 'token', async () =>
      body === undefined ? new Response(null, { status }) : Response.json(body, { status }),
    );
    const error = await api.turnKeys('dsp_test', lease).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RunnerApiError);
    expect(error).toMatchObject({ name: 'Error', status, message });
    expect(Object.keys(error as Error)).toEqual(['status']);
  });

  it('validates 202 responses as before, leaving pending outcomes to their contract', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...pending, scope: null }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ approvalId: 'apr_test' }, { status: 202 }));
    const api = createRunnerCommandsApi(base, 'token', fetchImpl);
    const query = { ...lease, dispatchId: 'dsp_test', waitMs: 0 };
    expect(await api.authorizeWait('apr_test', query)).toEqual({
      outcome: 'pending',
      scope: null,
      message: 'Waiting.',
      open: [],
    });
    await expect(api.authorizeWait('apr_test', query)).rejects.toBeInstanceOf(ZodError);
  });

  it('propagates malformed JSON, invalid replies and cancellation unchanged', async () => {
    const cancelled = new DOMException('Cancelled', 'AbortError');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('not json', { status: 502 }))
      .mockResolvedValueOnce(Response.json({ ...keys, entries: [17] }))
      .mockRejectedValueOnce(cancelled);
    const api = createRunnerCommandsApi(base, 'token', fetchImpl);
    await expect(api.turnKeys('dsp_test', lease)).rejects.toBeInstanceOf(SyntaxError);
    await expect(api.turnKeys('dsp_test', lease)).rejects.toBeInstanceOf(ZodError);
    const controller = new AbortController();
    controller.abort();
    await expect(
      api.authorizeWait('apr_test', { ...lease, dispatchId: 'dsp_test', waitMs: 0 }, controller.signal),
    ).rejects.toBe(cancelled);
    expect(fetchImpl.mock.calls[2]?.[1]?.signal).toBe(controller.signal);
  });
});
