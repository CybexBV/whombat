import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SubmissionBody } from './draft';
import { type FetchLike, type Outcome, postReport, SUBMIT_TIMEOUT_MS, Submitter } from './submit';

const BODY = { submissionId: 'abcdefghijklmnopqrstuv' } as SubmissionBody;
const URL_ = 'https://whombat.example.com/embed/v1/sites/fbs_abcdefghijklmnopqrstuvwx/reports';

function answer(status: number, body: unknown, headers: Record<string, string> = {}): FetchLike {
  return vi.fn(
    async () =>
      new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
  );
}

afterEach(() => vi.useRealTimers());

describe('postReport', () => {
  it('posts JSON same-origin without credentials', async () => {
    const fetch = answer(201, { reference: 'FB-7K3Q-9M2X', receivedAt: '2026-09-25T10:00:00.000Z' });
    const outcome = await postReport(fetch, URL_, BODY);
    expect(outcome).toEqual({
      kind: 'received',
      receipt: { reference: 'FB-7K3Q-9M2X', receivedAt: '2026-09-25T10:00:00.000Z' },
    });
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL_);
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      mode: 'same-origin',
    });
    expect(JSON.parse(String(init.body))).toEqual(BODY);
  });

  it('maps every answer', async () => {
    const cases: [FetchLike, Outcome][] = [
      [
        answer(200, { reference: 'FB-7K3Q-9M2X', receivedAt: 'x' }),
        { kind: 'received', receipt: { reference: 'FB-7K3Q-9M2X', receivedAt: 'x' } },
      ],
      [answer(201, { reference: 'nope', receivedAt: 'x' }), { kind: 'server' }],
      [answer(201, 'not json'), { kind: 'server' }],
      [
        answer(400, {
          error: { code: 'invalid', message: 'x', fields: ['description', 'attachments.1', 3] },
        }),
        { kind: 'invalid', fields: ['description', 'attachments.1'] },
      ],
      [answer(404, { error: { code: 'unavailable', message: 'x' } }), { kind: 'unavailable' }],
      [answer(409, { error: { code: 'conflict', message: 'x' } }), { kind: 'conflict' }],
      [
        answer(413, { error: { code: 'too_large', message: 'x' } }),
        { kind: 'attachments', reason: 'too_large', fields: [] },
      ],
      [
        answer(415, { error: { code: 'unsupported_attachment', message: 'x' } }),
        { kind: 'attachments', reason: 'unsupported', fields: [] },
      ],
      [
        answer(422, { error: { code: 'unsupported_attachment', message: 'x', fields: ['attachments.0'] } }),
        { kind: 'attachments', reason: 'unsupported', fields: ['attachments.0'] },
      ],
      [
        answer(429, { error: { code: 'rate_limited', message: 'x', retryAfter: 90 } }),
        { kind: 'rate_limited', retryAfter: 90 },
      ],
      [answer(429, undefined, { 'retry-after': '30' }), { kind: 'rate_limited', retryAfter: 30 }],
      [answer(429, {}), { kind: 'rate_limited', retryAfter: null }],
      [answer(500, { error: { code: 'internal', message: 'x' } }), { kind: 'server' }],
      [answer(503, '<html>'), { kind: 'server' }],
      [answer(302, {}), { kind: 'server' }],
      [vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))), { kind: 'network' }],
    ];
    for (const [fetch, expected] of cases) expect(await postReport(fetch, URL_, BODY)).toEqual(expected);
  });

  it('gives up after the timeout', async () => {
    vi.useFakeTimers();
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const pending = postReport(fetch, URL_, BODY);
    await vi.advanceTimersByTimeAsync(SUBMIT_TIMEOUT_MS);
    expect(await pending).toEqual({ kind: 'network' });
  });
});

describe('Submitter', () => {
  it('keeps the submission id across retries and sends once at a time', async () => {
    const outcomes: Outcome[] = [
      { kind: 'network' },
      { kind: 'server' },
      { kind: 'received', receipt: { reference: 'FB-7K3Q-9M2X', receivedAt: 'x' } },
    ];
    const seen: string[] = [];
    let release: () => void = () => {};
    const send = vi.fn(async (body: SubmissionBody) => {
      seen.push(body.submissionId);
      await new Promise<void>((r) => {
        release = r;
      });
      return outcomes.shift() as Outcome;
    });
    let n = 0;
    const s = new Submitter(send, () => `id-${++n}`);
    const build = async (submissionId: string) => ({ submissionId }) as SubmissionBody;
    const first = s.submit(build, 'draft');
    expect(s.state).toBe('sending');
    // A double click while sending sends nothing.
    expect(await s.submit(build, 'draft')).toBeNull();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    release();
    expect(await first).toEqual({ kind: 'network' });
    expect(s.state).toBe('editing');
    const second = s.submit(build, 'draft');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    release();
    await second;
    const third = s.submit(build, 'draft');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    release();
    expect((await third)?.kind).toBe('received');
    expect(seen).toEqual(['id-1', 'id-1', 'id-1']);
    expect(s.state).toBe('done');
    expect(await s.submit(build, 'draft')).toBeNull();
    s.newDraft();
    expect(s.submissionId).toBe('id-2');
    expect(s.state).toBe('editing');
  });

  it('a file that can’t be read sends nothing', async () => {
    const send = vi.fn();
    const s = new Submitter(send);
    expect(await s.submit(async () => Promise.reject(new Error('gone')), 'draft')).toEqual({
      kind: 'unreadable',
    });
    expect(send).not.toHaveBeenCalled();
    expect(s.state).toBe('editing');
  });

  it('a retry of the same draft resends the body built for it; an edited draft is built again (R1-2)', async () => {
    const sent: SubmissionBody[] = [];
    const outcomes: Outcome[] = [{ kind: 'network' }, { kind: 'server' }, { kind: 'network' }];
    const s = new Submitter(async (body) => {
      sent.push(body);
      return (
        outcomes.shift() ?? { kind: 'received', receipt: { reference: 'FB-7K3Q-9M2X', receivedAt: 'x' } }
      );
    });
    let builds = 0;
    const build = (description: string) => async (submissionId: string) =>
      ({
        submissionId,
        description,
        context: { sentAt: new Date(Date.UTC(2026, 8, 25, 10, 0, ++builds)).toISOString() },
      }) as SubmissionBody;
    await s.submit(build('first'), 'draft-a');
    // “Try again”: the same draft, seconds later.
    await s.submit(build('first'), 'draft-a');
    expect(builds).toBe(1);
    expect(sent[1]).toBe(sent[0]);
    expect(sent[1]?.context.sentAt).toBe('2026-09-25T10:00:01.000Z');
    // The visitor edits and sends again: a new body (same id, as before).
    await s.submit(build('edited'), 'draft-b');
    expect(builds).toBe(2);
    expect(sent[2]).toMatchObject({ description: 'edited', context: { sentAt: '2026-09-25T10:00:02.000Z' } });
    expect(sent[2]?.submissionId).toBe(sent[0]?.submissionId);
    // A new submission id (“Send as a new report”) builds again even for the same draft.
    s.newDraft();
    await s.submit(build('edited'), 'draft-b');
    expect(builds).toBe(3);
    expect(sent[3]?.submissionId).not.toBe(sent[0]?.submissionId);
  });
});
