import { PS5_POWER_HELPER } from '@whombat/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { failureOf } from '../call';
import { ps5PowerArtifact } from '../ps5-power-artifact';
import { ConnectionOutcomeUnknownError } from '../request';
import { adapterFor, callWordsFor } from './index';
import type { AdapterContext } from './types';

vi.mock('../ps5-power-artifact', () => ({ ps5PowerArtifact: vi.fn() }));

const ready = (pid = 101) => `OK pid=${pid} build=${PS5_POWER_HELPER.build}\n`;
const empty = { self: { running_version: '0.6.3' }, items: [] };
const payload = { slot: 'local/whombat-power', filename: '' };
const artifact = Buffer.from('7f454c460102', 'hex');
const run = (name: string, ctx: AdapterContext, args: Record<string, unknown> = {}) => {
  const tool = adapterFor('ps5')?.[name];
  if (!tool) throw new Error(name);
  return tool(ctx, args);
};
function context() {
  const requests: {
    url: string;
    method: string;
    body?: string | Buffer;
    headers?: Record<string, string>;
  }[] = [];
  const commands: { port: number; command: string; idempotent: boolean }[] = [];
  const replies: (string | Error)[] = [];
  let uploaded = false;
  let active = false;
  let corrupt = false;
  let inventories = 0;
  const ctx: AdapterContext = {
    baseUrl: 'http://ps5.home:8084',
    fields: {},
    bases: {},
    send: async (req) => {
      requests.push(req);
      const url = new URL(req.url);
      let body: unknown;
      if (url.pathname === '/list_payloads') {
        inventories++;
        body = {
          ...empty,
          items: uploaded
            ? [{ ...payload, ...(corrupt && inventories >= 3 ? { filename: 'changed.elf' } : {}) }]
            : [],
        };
      } else if (url.pathname === '/manage:upload') {
        uploaded = true;
        payload.filename = url.searchParams.get('filename') ?? '';
        body = 'OK';
      } else if (url.pathname.startsWith('/loadpayload:')) body = 'OK';
      else if (url.pathname === '/history_list') body = { history: [] };
      else if (url.pathname === '/api/v1/games/storage/status')
        body = { status: 0, job_id: 1, operation: 'copy', state: 'running', active };
      return {
        status: body === undefined ? 404 : 200,
        headers: {},
        body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? {})),
      };
    },
    line: async (port, command, idempotent) => {
      commands.push({ port, command, idempotent });
      const reply = replies.shift() ?? ready();
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return {
    ctx,
    requests,
    commands,
    replies,
    busy: () => {
      active = true;
    },
    changeBeforeLaunch: () => {
      corrupt = true;
    },
  };
}
beforeEach(() => {
  vi.mocked(ps5PowerArtifact).mockReset();
});

describe('PS5 remote reboot', () => {
  it('shows readiness without making a change and exposes a missing helper calmly', async () => {
    const t = context();
    expect(JSON.parse((await run('ps5_power_status', t.ctx)).content)).toMatchObject({
      ready: true,
      pid: 101,
    });
    expect(t.commands).toEqual([{ port: 9112, command: 'STATUS\n', idempotent: true }]);
    t.replies.push(new Error('unreachable'));
    expect(JSON.parse((await run('ps5_power_status', t.ctx)).content).ready).toBe(false);
    expect(t.requests).toHaveLength(0);
  });

  it('uploads checked bytes to a new slot and starts only that helper, leaving startup alone', async () => {
    const t = context();
    t.replies.push(new Error('absent'), ready());
    vi.mocked(ps5PowerArtifact).mockResolvedValue(artifact);
    const out = JSON.parse((await run('ps5_enable_remote_reboot', t.ctx)).content);
    expect(out).toMatchObject({ ready: true, pid: 101, slot: payload.slot, version: '1.0.0' });
    const writes = t.requests.filter((req) => req.method === 'POST');
    expect(writes.map((req) => new URL(req.url).pathname)).toEqual([
      '/manage:upload',
      `/loadpayload:${encodeURIComponent(payload.slot)}`,
    ]);
    expect(new URL(writes[0]?.url ?? '').searchParams.get('mode')).toBe('new');
    expect(writes[0]?.body).toEqual(artifact);
    expect(writes[0]?.headers?.['X-PLDMGR-Request']).toBe('1');
    expect(t.commands.every((c) => c.command === 'STATUS\n')).toBe(true);
  });

  it('never uploads after failed verification, nor downloads if the helper is already ready', async () => {
    const t = context();
    await run('ps5_enable_remote_reboot', t.ctx);
    expect(ps5PowerArtifact).not.toHaveBeenCalled();
    t.replies.push(new Error('absent'));
    vi.mocked(ps5PowerArtifact).mockRejectedValue(new Error('checksum'));
    await expect(run('ps5_enable_remote_reboot', t.ctx)).rejects.toThrow('checksum');
    expect(t.requests.every((req) => req.method === 'GET')).toBe(true);
  });

  it('refuses to launch when the uploaded slot changes', async () => {
    const t = context();
    t.replies.push(new Error('absent'));
    t.changeBeforeLaunch();
    vi.mocked(ps5PowerArtifact).mockResolvedValue(artifact);
    await expect(run('ps5_enable_remote_reboot', t.ctx)).rejects.toThrow('changed before launch');
    expect(t.requests.some((req) => req.url.includes('/loadpayload:'))).toBe(false);
  });

  it('does not call an accepted helper launch ready until its service answers', async () => {
    const t = context();
    t.replies.push(new Error('absent'), new Error('not listening yet'));
    vi.mocked(ps5PowerArtifact).mockResolvedValue(artifact);
    const out = JSON.parse((await run('ps5_enable_remote_reboot', t.ctx)).content);
    expect(out.ready).toBe(false);
    expect(out.message).toContain('ps5_power_status');
  });

  it('refuses a changed helper, a missing helper and active storage jobs without sending reboot', async () => {
    for (const scenario of ['changed', 'missing', 'busy']) {
      const t = context();
      if (scenario === 'changed') t.replies.push(ready(102));
      if (scenario === 'missing') t.replies.push(new Error('absent'));
      if (scenario === 'busy') t.busy();
      await expect(run('ps5_reboot', t.ctx, { expectedPid: 101 })).rejects.toThrow();
      expect(t.commands.every((c) => c.command === 'STATUS\n')).toBe(true);
    }
  });

  it('sends reboot once as a write and reports acceptance without completion', async () => {
    const t = context();
    t.replies.push(ready(), 'OK rebooting\n');
    const out = JSON.parse((await run('ps5_reboot', t.ctx, { expectedPid: 101 })).content);
    expect(out).toMatchObject({ accepted: true, completed: false });
    expect(t.commands).toEqual([
      { port: 9112, command: 'STATUS\n', idempotent: true },
      { port: 9112, command: 'REBOOT\n', idempotent: false },
    ]);
  });

  it('keeps a lost reboot reply uncertain and never sends again', async () => {
    const t = context();
    const unknown = new ConnectionOutcomeUnknownError('The reboot reply was lost. Check your PS5.');
    t.replies.push(ready(), unknown);
    await expect(run('ps5_reboot', t.ctx, { expectedPid: 101 })).rejects.toBe(unknown);
    expect(failureOf(unknown)).toMatchObject({ reason: 'timeout', outcome: 'timeout' });
    expect(t.commands.filter((c) => c.command === 'REBOOT\n')).toHaveLength(1);
  });

  it('names the disruption and reopening the autoloader in the approval', () => {
    const words = callWordsFor('ps5');
    expect(words?.ask('ps5_reboot', {})).toContain('reboot');
    expect(words?.note?.('ps5_reboot', {})).toContain('WebKit Autoloader');
    expect(words?.ask('ps5_enable_remote_reboot', {})).toContain('SystemStateManager 1.0.0');
  });
});
