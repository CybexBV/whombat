import { describe, expect, it } from 'vitest';
import { FakeServer } from './commands/fakes';
import { askTarget, toolAsker } from './tool-asks';

const lease = { runnerId: 'rnr_1', attempt: 1 };
const log = () => {};

describe('a key at Ask asks the turn’s person through the command path (HE-44, HE-S150)', () => {
  it('sends the tool as a web or browser command with the host as target and the detail as reason', async () => {
    const server = new FakeServer();
    const ask = toolAsker({ api: server, dispatchId: 'dsp_1', lease, log });
    expect(
      await ask(
        { keyId: 'web.browse', tool: 'web_extract', detail: 'https://Example.com/a?b=1 https://x.org' },
        new AbortController().signal,
      ),
    ).toMatchObject({ allow: true });
    await ask({ keyId: 'browser.use', tool: 'browser_click', detail: '' }, new AbortController().signal);
    expect(server.authorized).toEqual([
      {
        dispatchId: 'dsp_1',
        ...lease,
        command: 'web_extract',
        category: 'web',
        target: 'example.com',
        reason: 'https://Example.com/a?b=1 https://x.org',
      },
      {
        dispatchId: 'dsp_1',
        ...lease,
        command: 'browser_click',
        category: 'browser',
        target: null,
        reason: null,
      },
    ]);
  });

  it('waits for the answer: a yes runs, a no doesn’t, Off is no at once', async () => {
    const server = new FakeServer();
    server.reply = { outcome: 'pending', approvalId: 'apr_1', message: 'waiting', open: [] };
    server.waits = [
      { outcome: 'pending', scope: null, message: '', open: [] },
      { outcome: 'run', scope: 'task', message: 'Allowed for this task by Mara.', open: [] },
    ];
    const ask = toolAsker({ api: server, dispatchId: 'dsp_1', lease, log });
    const signal = new AbortController().signal;
    expect(await ask({ keyId: 'web.browse', tool: 'web_search', detail: 'q' }, signal)).toEqual({
      allow: true,
      reason: 'Allowed for this task by Mara.',
    });
    server.waits = [
      { outcome: 'declined', scope: null, message: 'Mara said no; it didn’t happen.', open: [] },
    ];
    expect((await ask({ keyId: 'web.browse', tool: 'web_search', detail: 'q' }, signal)).allow).toBe(false);
    server.reply = { outcome: 'blocked', approvalId: null, message: 'This needs the key', open: [] };
    expect(await ask({ keyId: 'web.browse', tool: 'web_search', detail: 'q' }, signal)).toEqual({
      allow: false,
      reason: 'Off',
      message: 'This needs the key',
    });
  });

  it('gives up when nobody answers in time, or the turn stops', async () => {
    const server = new FakeServer();
    server.reply = { outcome: 'pending', approvalId: 'apr_1', message: 'waiting', open: [] };
    let t = 0;
    const ask = toolAsker({
      api: server,
      dispatchId: 'dsp_1',
      lease,
      log,
      approvalWaitMs: 50,
      now: () => (t += 30),
    });
    const late = await ask(
      { keyId: 'web.browse', tool: 'web_search', detail: 'q' },
      new AbortController().signal,
    );
    expect(late).toMatchObject({ allow: false, reason: 'nobody answered in time' });
    expect(late.message).toContain('Nobody answered in 1 minute');
    const stop = new AbortController();
    const waiting = toolAsker({ api: server, dispatchId: 'dsp_1', lease, log })(
      { keyId: 'web.browse', tool: 'web_search', detail: 'q' },
      stop.signal,
    );
    setTimeout(() => stop.abort(), 30);
    expect(await waiting).toEqual({ allow: false, reason: 'the turn stopped' });
  });

  it('takes the host only from a web address', () => {
    expect(askTarget('https://a.example.org/x')).toBe('a.example.org');
    expect(askTarget('best pizza')).toBeNull();
    expect(askTarget('file:///etc/passwd')).toBeNull();
  });
});
