import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeskState } from '@whombat/control-contracts/local';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Services } from '../services';
import { DeskRemoteHelpRoutes } from './remote-help';
import { remoteHelpLine } from './service';
import { type DeskPort, DeskSocket } from './socket';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const state = (on: boolean): DeskState =>
  ({
    v: 1,
    now: '2026-10-21T12:00:00.000Z',
    paired: null,
    pairing: null,
    lock: { state: 'locked' },
    glance: null,
    power: null,
    talk: null,
    ...(on ? { remoteHelp: { level: 'fix', until: null, connected: 'Claude' } } : {}),
  }) as DeskState;

async function socket(stop: () => Promise<void>, present = true) {
  const dir = mkdtempSync(join(tmpdir(), 'desk-rh-'));
  const path = join(dir, 'desk.sock');
  let on = true;
  const log = { warn: vi.fn() };
  const services = {
    config: { NODE_ENV: 'test', WHOMBAT_CONSOLE_GROUP: 'nobody-group-here' },
    log: { ...log, info: vi.fn(), error: vi.fn() },
  } as unknown as Services;
  const routes = new DeskRemoteHelpRoutes(
    {
      remoteHelp: present
        ? {
            stopAtDesk: async () => {
              await stop();
              on = false;
            },
          }
        : null,
      state: async () => state(on),
    },
    log,
  );
  const desk = { state: async () => state(on) } as unknown as DeskPort;
  const server = new DeskSocket(services, desk, [routes]);
  await server.listen(path);
  cleanups.push(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (method: string, url: string, body: unknown = { v: 1 }) =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = request({ socketPath: path, path: url, method }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (p: Buffer) => parts.push(p));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(parts).toString() || '{}') }),
        );
      });
      req.on('error', reject);
      req.end(method === 'POST' ? JSON.stringify(body) : undefined);
    });
  return { call, log };
}

describe('remote help on the desk (RH-S08)', () => {
  it('stops without unlocking and answers the state without the line', async () => {
    const stop = vi.fn(async () => {});
    const { call } = await socket(stop);
    expect((await call('GET', '/v1/desk/state')).body).toHaveProperty('remoteHelp');
    const answer = await call('POST', '/v1/desk/remote-help/stop');
    expect(answer.status).toBe(200);
    expect(answer.body).not.toHaveProperty('remoteHelp');
    expect(stop).toHaveBeenCalledTimes(1);
    expect((await call('GET', '/v1/desk/remote-help/stop')).status).toBe(404);
    expect((await call('POST', '/v1/desk/remote-help/stop', { v: 2 })).status).toBe(400);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('says unavailable when the support service didn’t answer; without one it answers the state', async () => {
    const { call } = await socket(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await call('POST', '/v1/desk/remote-help/stop')).toMatchObject({
      status: 503,
      body: { error: { code: 'unavailable' } },
    });
    const none = await socket(async () => {}, false);
    expect((await none.call('POST', '/v1/desk/remote-help/stop')).status).toBe(200);
  });

  it('adds the line to the state only while it is on', () => {
    const line = { level: 'look' as const, until: '2026-10-21T13:00:00.000Z', connected: null };
    expect(remoteHelpLine({ deskView: () => line })).toEqual({ remoteHelp: line });
    expect(remoteHelpLine({ deskView: () => undefined })).toEqual({});
    expect(remoteHelpLine(null)).toEqual({});
  });
});
