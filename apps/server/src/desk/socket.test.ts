import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DESK_AUDIO_BASE64_MAX,
  DESK_HEAR_BASE64_MAX,
  type DeskServer,
  type DeskServerPage,
  type DeskState,
} from '@whombat/control-contracts/local';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Services } from '../services';
import { DeskRefused } from './service';
import { DESK_MAX_BODY, type DeskPort, DeskSocket } from './socket';

const dir = mkdtempSync(join(tmpdir(), 'desk-sock-'));
const path = join(dir, 'desk.sock');
const calls: string[] = [];
let unlocked = false;

const state: DeskState = {
  v: 1,
  now: '2026-10-20T12:34:00.000Z',
  paired: null,
  pairing: { code: 'KXQM', expiresAt: '2026-10-20T12:44:00.000Z' },
  lock: { state: 'locked' },
  glance: null,
  power: null,
  talk: null,
};

const locked = () => new DeskRefused(409, 'locked', 'Unlock the screen first.');
/** The screen shows only the time while locked (DK-84): no servers. */
let onlyTime = false;

const card: DeskServer = { id: 'pve-01', name: 'pve-01', mark: 'proxmox', state: 'ok', note: 'up 41 d' };

/** A server's screen: the card with the id asked for, nothing measured yet. */
const page = (id: string): DeskServerPage => ({
  v: 1,
  now: '2026-10-20T12:34:00.000Z',
  server: { ...card, id },
  os: 'Proxmox VE 9',
  up: 'up 41 d',
  cpu: null,
  memory: null,
  disk: null,
  temp: null,
  history: { range: '24h', stepS: 900, cpu: [], memory: [], cpuPeak: null, memoryAvg: null },
  volumes: [],
  guests: null,
  network: null,
  alerts: { count: 0, items: [] },
});

const fake: DeskPort = {
  state: async () => state,
  unlock: async (pin) => {
    calls.push(`unlock ${pin}`);
    if (pin === '000000') throw new DeskRefused(409, 'no_pin', 'This screen has no PIN yet.');
    return pin === '123456' ? { v: 1, result: 'unlocked' } : { v: 1, result: 'wrong', triesLeft: 4 };
  },
  unlockPhone: async () => ({ v: 1, expiresAt: '2026-10-20T12:36:00.000Z' }),
  lockNow: async () => ({ v: 1 }),
  touch: () => {
    if (!unlocked) throw locked();
    return { v: 1, until: '2026-10-20T12:36:00.000Z' };
  },
  decide: async (number, decision, pin) => {
    calls.push(`decide ${number} ${decision}${pin ? ` ${pin}` : ''}`);
    if (number === 12) throw new DeskRefused(403, 'on_phone', 'Answer this on your phone.');
    if (number === 13 && !pin) throw new DeskRefused(403, 'pin_needed', 'Type your PIN to approve this.');
    return { v: 1, result: 'decided' };
  },
  lookQuiet: async (key, notice, how) => {
    calls.push(`look ${key} ${notice.check}${notice.subject ? `/${notice.subject}` : ''} ${how}`);
    if (notice.check === 'conn.signin') throw new DeskRefused(403, 'not_allowed', 'Only you can quiet it.');
    return { v: 1 };
  },
  lookFix: async (key) => {
    calls.push(`fix ${key}`);
    if (key === 'server:gone') throw new DeskRefused(404, 'not_found', 'This doesn’t need a look any more.');
    return { v: 1 };
  },
  talkStart: async (input) => {
    calls.push(
      `talk ${input.text ?? `audio ${input.audioWav?.length}`} ${input.continue}${input.server ? ` about ${input.server}` : ''}${input.spoken ? ' spoken' : ''}`,
    );
    return { v: 1, id: 'dtk_0001' };
  },
  talkGet: () => ({ id: 'dtk_0001', state: 'thinking', thing: null, audio: false }),
  talkAudio: () => Buffer.from('RIFF'),
  talkSession: async () => {
    if (!unlocked) throw locked();
    return { v: 1, open: false, messages: [], earlier: 0 };
  },
  talkClose: () => {
    if (!unlocked) throw locked();
    calls.push('close');
    return { v: 1 };
  },
  hear: async (audio, signal) => {
    if (!unlocked) throw locked();
    calls.push(`hear ${audio.length}${signal ? ' (stoppable)' : ''}`);
    if (audio.length > 1000) throw new DeskRefused(409, 'busy', 'Busy.');
    return { v: 1, text: 'Is pve-02 okay?' };
  },
  // Locked or not (DF-04): only nobody paired refuses.
  foundDismiss: async () => {
    calls.push('found dismiss');
    return { v: 1 };
  },
  servers: async () => {
    if (onlyTime) throw locked();
    return { v: 1, servers: [card], more: 0 };
  },
  server: async (id, range) => {
    calls.push(`server ${id} ${range}`);
    if (onlyTime) throw locked();
    if (id === 'gone') throw new DeskRefused(404, 'not_found', 'There is no such server.');
    if (id === 'down') throw new DeskRefused(503, 'unavailable', 'I can’t reach your servers right now.');
    // A runtime bug: the page of another server.
    return page(id === 'mixed-up' ? 'pve-02' : id);
  },
  image: async (thing, ref) => {
    calls.push(`image ${thing} ${ref.slice(0, 4)}`);
    if (thing !== 'connection:con_plex') throw new DeskRefused(404, 'not_found', 'There is no such picture.');
    return { type: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) };
  },
  size: async (outputs) => {
    calls.push(
      `size ${outputs.map((o) => `${o.key}${o.main ? '*' : ''} ${o.size.width}x${o.size.height}`).join(', ')}`,
    );
    return { v: 1 };
  },
};

const services = {
  config: { WHOMBAT_CONSOLE_GROUP: 'whombat-console-test-none', NODE_ENV: 'test' },
  log: { warn: () => {}, error: () => {}, info: () => {} },
} as unknown as Services;
const socket = new DeskSocket(services, fake);

function call(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; type: string; json: unknown; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const req = request(
      {
        socketPath: path,
        method,
        path: url,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          const type = String(res.headers['content-type'] ?? '');
          resolve({
            status: res.statusCode ?? 0,
            type,
            json: type.includes('json') ? JSON.parse(bytes.toString('utf8')) : null,
            bytes,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

beforeAll(() => socket.listen(path));
afterAll(async () => {
  await socket.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the desk socket (§2.3, DK-S18)', () => {
  it('is a 0660 socket only the console’s group reaches', () => {
    expect(statSync(path).mode & 0o777).toBe(0o660);
  });

  it('answers the state', async () => {
    const res = await call('GET', '/v1/desk/state');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ v: 1, pairing: { code: 'KXQM' }, lock: { state: 'locked' } });
  });

  it('passes typed requests on, checked', async () => {
    expect((await call('POST', '/v1/desk/unlock', { v: 1, pin: '123456' })).json).toEqual({
      v: 1,
      result: 'unlocked',
    });
    // 4 to 6 digits (DK-26); a short PIN the runtime checks like any other.
    expect((await call('POST', '/v1/desk/unlock', { v: 1, pin: '2580' })).json).toMatchObject({
      result: 'wrong',
    });
    for (const pin of ['258', '2580417'])
      expect((await call('POST', '/v1/desk/unlock', { v: 1, pin })).status).toBe(400);
    expect((await call('POST', '/v1/desk/unlock', { v: 2, pin: '123456' })).status).toBe(400);
    expect((await call('POST', '/v1/desk/decide', { v: 1, number: 3, decision: 'approve' })).status).toBe(
      200,
    );
    expect((await call('POST', '/v1/desk/decide', { v: 1, number: 3, decision: 'always' })).status).toBe(400);
    expect(
      (await call('POST', '/v1/desk/talk', { v: 1, text: 'is pve-02 okay?', continue: false })).json,
    ).toEqual({
      v: 1,
      id: 'dtk_0001',
    });
    expect((await call('POST', '/v1/desk/talk', { v: 1, continue: false })).status).toBe(400);
    expect(calls).toEqual(['unlock 123456', 'unlock 2580', 'decide 3 approve', 'talk is pve-02 okay? false']);
  });

  it('says why it refuses, with the runtime’s status and code', async () => {
    const touch = await call('POST', '/v1/desk/touch', { v: 1 });
    expect(touch.status).toBe(409);
    expect(touch.json).toMatchObject({ error: { code: 'locked' } });
    const phone = await call('POST', '/v1/desk/decide', { v: 1, number: 12, decision: 'approve' });
    expect(phone.status).toBe(403);
    expect(phone.json).toMatchObject({ error: { code: 'on_phone' } });
    // A PIN on a screen without one (DK-18).
    const noPin = await call('POST', '/v1/desk/unlock', { v: 1, pin: '000000' });
    expect(noPin.status).toBe(409);
    expect(noPin.json).toMatchObject({ error: { code: 'no_pin' } });
    unlocked = true;
    expect((await call('POST', '/v1/desk/touch', { v: 1 })).status).toBe(200);
  });

  it('passes Ignore and Not now on a look on, strictly (quiet-notices.md QN-20)', async () => {
    calls.length = 0;
    const key = 'connection:con_unifi';
    const notice = { check: 'unifi.device_offline', subject: 'device:aa' };
    expect((await call('POST', '/v1/desk/look/quiet', { v: 1, key, notice, how: 'ignore' })).json).toEqual({
      v: 1,
    });
    expect((await call('POST', '/v1/desk/look/quiet', { v: 1, key, notice, how: 'snooze' })).status).toBe(
      200,
    );
    expect((await call('POST', '/v1/desk/look/quiet', { v: 1, key, notice, how: 'undo' })).status).toBe(400);
    expect(
      (await call('POST', '/v1/desk/look/quiet', { v: 1, key, notice, how: 'ignore', x: 1 })).status,
    ).toBe(400);
    const refused = await call('POST', '/v1/desk/look/quiet', {
      v: 1,
      key,
      notice: { check: 'conn.signin' },
      how: 'ignore',
    });
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ error: { code: 'not_allowed' } });
    expect(calls).toEqual([
      `look ${key} unifi.device_offline/device:aa ignore`,
      `look ${key} unifi.device_offline/device:aa snooze`,
      `look ${key} conn.signin ignore`,
    ]);
  });

  it('passes the step on a look on, strictly (look-research.md LR-08)', async () => {
    calls.length = 0;
    expect((await call('POST', '/v1/desk/look/fix', { v: 1, key: 'connection:con_ha' })).json).toEqual({
      v: 1,
    });
    expect((await call('POST', '/v1/desk/look/fix', { v: 1, key: 'connection:con_ha', x: 1 })).status).toBe(
      400,
    );
    const gone = await call('POST', '/v1/desk/look/fix', { v: 1, key: 'server:gone' });
    expect(gone.status).toBe(404);
    expect(gone.json).toMatchObject({ error: { code: 'not_found' } });
    expect(calls).toEqual(['fix connection:con_ha', 'fix server:gone']);
  });

  it('takes Deny and a PIN, and has the conversation only unlocked (DK-S60, DK-S61, DK-T14, DK-T15)', async () => {
    calls.length = 0;
    expect((await call('POST', '/v1/desk/decide', { v: 1, number: 3, decision: 'deny' })).json).toEqual({
      v: 1,
      result: 'decided',
    });
    const needs = await call('POST', '/v1/desk/decide', { v: 1, number: 13, decision: 'approve' });
    expect(needs.status).toBe(403);
    expect(needs.json).toMatchObject({ error: { code: 'pin_needed' } });
    expect(
      (await call('POST', '/v1/desk/decide', { v: 1, number: 13, decision: 'approve', pin: '2580' })).status,
    ).toBe(200);
    expect(
      (await call('POST', '/v1/desk/decide', { v: 1, number: 13, decision: 'approve', pin: '25' })).status,
    ).toBe(400);
    unlocked = false;
    expect((await call('POST', '/v1/desk/talk/session', { v: 1 })).status).toBe(409);
    expect((await call('POST', '/v1/desk/talk/close', { v: 1 })).status).toBe(409);
    unlocked = true;
    expect((await call('POST', '/v1/desk/talk/session', { v: 1 })).json).toEqual({
      v: 1,
      open: false,
      messages: [],
      earlier: 0,
    });
    expect((await call('POST', '/v1/desk/talk/close', { v: 1 })).json).toEqual({ v: 1 });
    expect((await call('POST', '/v1/desk/talk/session', { v: 1, all: true })).status).toBe(400);
    expect(calls).toEqual(['decide 3 deny', 'decide 13 approve', 'decide 13 approve 2580', 'close']);
  });

  it('puts found on your network away while locked (DF-04)', async () => {
    calls.length = 0;
    unlocked = false;
    expect((await call('POST', '/v1/desk/found/dismiss', { v: 1 })).json).toEqual({ v: 1 });
    expect((await call('POST', '/v1/desk/found/dismiss', { v: 2 })).status).toBe(400);
    expect((await call('GET', '/v1/desk/found/dismiss')).status).toBe(404);
    expect(calls).toEqual(['found dismiss']);
    unlocked = true;
  });

  it('shows the servers and a server’s screen, with the runtime’s refusals (DK-83, DK-86)', async () => {
    calls.length = 0;
    expect((await call('POST', '/v1/desk/servers', { v: 1 })).json).toEqual({
      v: 1,
      servers: [card],
      more: 0,
    });
    const shown = await call('POST', '/v1/desk/server', { v: 1, id: 'pve-01', range: '24h' });
    expect(shown.status).toBe(200);
    expect(shown.json).toMatchObject({ server: { id: 'pve-01' }, os: 'Proxmox VE 9' });
    // Short slugs are server ids too; a range or an id the contract doesn't have is refused before the runtime.
    expect((await call('POST', '/v1/desk/server', { v: 1, id: 'nas', range: '7d' })).status).toBe(200);
    for (const bad of [
      { v: 1, id: 'pve-01', range: '30d' },
      { v: 1, id: '../fleet', range: '1h' },
      { v: 1, id: 'pve-01' },
      { v: 1, id: 'pve-01', range: '1h', all: true },
    ])
      expect((await call('POST', '/v1/desk/server', bad)).status).toBe(400);
    const gone = await call('POST', '/v1/desk/server', { v: 1, id: 'gone', range: '24h' });
    expect([gone.status, gone.json]).toMatchObject([404, { error: { code: 'not_found' } }]);
    const down = await call('POST', '/v1/desk/server', { v: 1, id: 'down', range: '24h' });
    expect([down.status, down.json]).toMatchObject([503, { error: { code: 'unavailable' } }]);
    // Outside production a page for another server than the one asked for is the runtime's bug, not an answer.
    expect((await call('POST', '/v1/desk/server', { v: 1, id: 'mixed-up', range: '24h' })).status).toBe(500);
    onlyTime = true;
    for (const [url, body] of [
      ['/v1/desk/servers', { v: 1 }],
      ['/v1/desk/server', { v: 1, id: 'pve-01', range: '24h' }],
    ] as const) {
      const res = await call('POST', url, body);
      expect([res.status, res.json]).toMatchObject([409, { error: { code: 'locked' } }]);
    }
    onlyTime = false;
    expect(calls).toEqual([
      'server pve-01 24h',
      'server nas 7d',
      'server gone 24h',
      'server down 24h',
      'server mixed-up 24h',
      'server pve-01 24h',
    ]);
  });

  it('asks about the server on the screen (DK-85)', async () => {
    calls.length = 0;
    const body = { v: 1, text: 'why is it busy?', continue: false, server: 'pve-01' };
    expect((await call('POST', '/v1/desk/talk', body)).status).toBe(200);
    expect((await call('POST', '/v1/desk/talk', { ...body, server: 'not a server' })).status).toBe(400);
    expect(calls).toEqual(['talk why is it busy? false about pve-01']);
  });

  it('hears Talk’s mic as voice typing: words for the box, nothing sent', async () => {
    calls.length = 0;
    const audioWav = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
    expect((await call('POST', '/v1/desk/hear', { v: 1, audioWav })).json).toEqual({
      v: 1,
      text: 'Is pve-02 okay?',
    });
    expect((await call('POST', '/v1/desk/hear', { v: 1 })).status).toBe(400);
    expect((await call('POST', '/v1/desk/hear', { v: 1, audioWav, text: 'hi' })).status).toBe(400);
    const busy = await call('POST', '/v1/desk/hear', { v: 1, audioWav: 'A'.repeat(4000) });
    expect([busy.status, (busy.json as { error: { code: string } }).error.code]).toEqual([409, 'busy']);
    // The words come back as a typed question that says it came by voice.
    const words = { v: 1, text: 'Is pve-02 okay?', continue: true, spoken: true };
    expect((await call('POST', '/v1/desk/talk', words)).status).toBe(200);
    expect(calls).toEqual([
      'hear 44 (stoppable)',
      'hear 3000 (stoppable)',
      'talk Is pve-02 okay? true spoken',
    ]);
  });

  it('takes voice typing’s five minutes to hear, and no more', async () => {
    calls.length = 0;
    const audioWav = 'A'.repeat(DESK_HEAR_BASE64_MAX);
    // The fake refuses anything this long as busy: the body got through to it.
    expect((await call('POST', '/v1/desk/hear', { v: 1, audioWav })).status).toBe(409);
    expect(calls).toEqual([`hear ${(DESK_HEAR_BASE64_MAX / 4) * 3} (stoppable)`]);
    expect((await call('POST', '/v1/desk/hear', { v: 1, audioWav: `${audioWav}AAAA` })).status).toBe(400);
    expect((await call('POST', '/v1/desk/hear', { v: 1, audioWav, pad: 'x'.repeat(2_000) })).status).toBe(
      413,
    );
  });

  it('sends the answer’s sound as WAV', async () => {
    const res = await call('POST', '/v1/desk/talk/audio', { v: 1, id: 'dtk_0001' });
    expect(res.status).toBe(200);
    expect(res.type).toBe('audio/wav');
    expect(res.bytes.toString('latin1')).toBe('RIFF');
  });

  it('sends a widget’s picture as it is, and refuses any other the same way (DK-142)', async () => {
    calls.length = 0;
    const ref = `${'a'.repeat(20)}.${'b'.repeat(22)}`;
    const res = await call('POST', '/v1/desk/image', { v: 1, thing: 'connection:con_plex', ref });
    expect(res.status).toBe(200);
    expect(res.type).toBe('image/png');
    expect([...res.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const refused = await call('POST', '/v1/desk/image', { v: 1, thing: 'connection:con_other', ref });
    expect(refused.status).toBe(404);
    expect((refused.json as { error: { code: string } }).error.code).toBe('not_found');
    // Not a signed ref's shape, or not a thing: never reaches the runtime.
    expect(
      (await call('POST', '/v1/desk/image', { v: 1, thing: 'connection:con_plex', ref: 'short' })).status,
    ).toBe(400);
    expect((await call('POST', '/v1/desk/image', { v: 1, thing: 'plex', ref })).status).toBe(400);
    expect(calls).toEqual(['image connection:con_plex aaaa', 'image connection:con_other aaaa']);
  });

  it('takes the outputs and their sizes (DK-129, DK-147)', async () => {
    calls.length = 0;
    const outputs = [
      { key: 'edp-1', main: true, name: null, size: { width: 1280, height: 800 } },
      { key: 'hdmi-a-1', main: false, name: 'DELL U2720Q', size: { width: 1920, height: 1080 } },
    ];
    expect((await call('POST', '/v1/desk/size', { v: 1, outputs })).status).toBe(200);
    expect(calls).toEqual(['size edp-1* 1280x800, hdmi-a-1 1920x1080']);
    expect((await call('POST', '/v1/desk/size', { v: 1, outputs: [] })).status).toBe(400);
    const odd = [{ ...outputs[0], key: 'HDMI A 1' }];
    expect((await call('POST', '/v1/desk/size', { v: 1, outputs: odd })).status).toBe(400);
  });

  it('refuses what isn’t its: other paths, other methods, bodies too large or not JSON', async () => {
    expect((await call('GET', '/v1/desk/unlock')).status).toBe(404);
    expect((await call('POST', '/v1/desk/state', { v: 1 })).status).toBe(404);
    expect((await call('POST', '/health', { v: 1 })).status).toBe(404);
    expect((await call('POST', '/v1/desk/lock', 'not json')).status).toBe(400);
    expect((await call('POST', '/v1/desk/lock', { v: 1, pad: 'x'.repeat(DESK_MAX_BODY) })).status).toBe(413);
    // 30 s of audio in base64 is welcome; the same size anywhere else isn't.
    const audioWav = 'A'.repeat(DESK_AUDIO_BASE64_MAX);
    expect((await call('POST', '/v1/desk/talk', { v: 1, audioWav, continue: true })).status).toBe(200);
    expect(calls.at(-1)).toBe(`talk audio ${(DESK_AUDIO_BASE64_MAX / 4) * 3} true`);
    await expect(
      call('POST', '/v1/desk/talk/get', { v: 1, id: audioWav.slice(0, 600_000) }),
    ).rejects.toThrow();
  });
});
