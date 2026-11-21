/**
 * Whombat Link's pure parts on the runtime (docs/decisions/whombat-link.md): the box's origin from `device.json`, the
 * content proof it signs for `link.begin`, what the session and the screen say about Link, the Inbox items of grace
 * and ended, the refusals' codes, and where a connection sign-in may come back to (LNK-16).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registrationSigningBytes, verifyRegistration } from '@whombat/control-contracts/device';
import { generateKeypair, signBytes } from '@whombat/core';
import { TAILSCALE_OFF } from '@whombat/protocol/session';
import { generateIdentity } from '@whombat/secure-channel';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { useBoxPageAsApp } from '../../config';
import { RETURN_ADDRESS_WORDS, returnAddressProblem } from '../../connections/redirect';
import { ManagerCallError } from '../ports';
import { LINK_WORDS, linkItems } from './notices';
import { contentProofSigner, deviceFileOf, registeredAtControl } from './origin';
import {
  consoleReach,
  LINK_ENDED_POLL_MS,
  LINK_STARTING_POLL_MS,
  LINK_UNANSWERED_POLL_MS,
  LinkService,
  type LinkView,
  linkSummary,
  refusalOf,
} from './service';

const dir = mkdtempSync(join(tmpdir(), 'wb-link-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const view = (state: LinkView['link']['state'], extra: Partial<LinkView['link']> = {}): LinkView => ({
  enabled: true,
  assumed: false,
  link: { state, since: '2026-11-18T10:00:00.000Z', ...extra },
});

async function deviceFile(route: string | undefined) {
  const identity = await generateIdentity();
  const management = generateKeypair();
  const device = {
    deviceId: 'dev-0001',
    env: 'dev',
    ...(route ? { applianceRoute: route } : {}),
    model: 'wb-mini-1',
    serial: 'BOX12345',
    contentPeerId: identity.peerId,
    contentPublicKey: Buffer.from(identity.publicKey).toString('hex'),
    managementPublicKey: management.publicKey,
    provisionedAt: 1_795_000_000,
  };
  const file = join(dir, `device-${route ?? 'none'}.json`);
  writeFileSync(file, JSON.stringify(device));
  return {
    identity,
    management,
    device,
    config: { WHOMBAT_DEVICE_FILE: file, WHOMBAT_EDITION: 'commercial' as const },
  };
}

describe('the box’s origin (LNK-01)', () => {
  it('device.json decides; development and tests fall back to the old switch', async () => {
    expect(registeredAtControl((await deviceFile('local')).config)).toBe(false);
    expect(registeredAtControl((await deviceFile('rt-0042')).config)).toBe(true);
    // Not the edition: a box that made its identity itself is local even where the image says commercial.
    expect(
      registeredAtControl({ ...(await deviceFile('local')).config, WHOMBAT_EDITION: 'commercial' }),
    ).toBe(false);
    expect(registeredAtControl({ WHOMBAT_DEVICE_FILE: undefined, WHOMBAT_EDITION: 'community' })).toBe(false);
    expect(registeredAtControl({ WHOMBAT_DEVICE_FILE: undefined, WHOMBAT_EDITION: 'commercial' })).toBe(true);
    // An unreadable file reads as none.
    expect(deviceFileOf({ WHOMBAT_DEVICE_FILE: join(dir, 'missing.json') })).toBeNull();
  });

  it('signs the registration with the content key, so control can check both proofs (LNK-03)', async () => {
    const { identity, management, device, config } = await deviceFile('local');
    const contentProof = await contentProofSigner(config, identity)();
    expect(contentProof).toMatch(/^[0-9a-f]{128}$/);
    const unsigned = {
      env: 'dev' as const,
      hardwareSerial: device.serial,
      model: device.model,
      managementPublicKey: device.managementPublicKey,
      contentPeerId: device.contentPeerId,
      contentPublicKey: device.contentPublicKey,
      provisionedAt: device.provisionedAt,
    };
    // The manager adds the management key's proof over the same bytes.
    const proof = signBytes(registrationSigningBytes(unsigned), management.secretKey);
    expect(verifyRegistration({ ...unsigned, proof, contentProof: contentProof as string })).toBe(true);
    // Another content key than device.json names: no proof at all.
    expect(await contentProofSigner(config, await generateIdentity())()).toBeNull();
  });
});

describe('what the session and the screen say', () => {
  it('linkSummary keeps the code only while it starts, and grace’s end only in grace', () => {
    const pending = {
      code: 'ABCD-EFGH',
      url: 'https://app.whombat.com/link',
      expiresAt: '2026-11-18T10:15:00.000Z',
    };
    expect(linkSummary(view('starting', { pending, label: 'quiet-otter-lamp' }).link)).toEqual({
      state: 'starting',
      since: '2026-11-18T10:00:00.000Z',
      pending,
    });
    expect(linkSummary(view('on', { graceEndsAt: '2026-11-25T10:00:00.000Z' }).link)).not.toHaveProperty(
      'graceEndsAt',
    );
    expect(linkSummary(view('grace', { graceEndsAt: '2026-11-25T10:00:00.000Z' }).link).graceEndsAt).toBe(
      '2026-11-25T10:00:00.000Z',
    );
  });

  it('consoleReach: Link’s code while it starts, Tailscale’s sign-in link, HTTPS off, nothing when there’s nothing', () => {
    const pending = {
      code: 'ABCD-EFGH',
      url: 'https://app.whombat.com/link',
      expiresAt: '2026-11-18T10:15:00.000Z',
    };
    expect(consoleReach(view('starting', { pending, waitingForAddress: true }), null)).toEqual({
      link: {
        state: 'starting',
        code: 'ABCD-EFGH',
        url: 'https://app.whombat.com/link',
        expiresAt: '2026-11-18T10:15:00.000Z',
        waitingForAddress: true,
      },
    });
    const signIn = {
      ...TAILSCALE_OFF,
      state: 'needs_sign_in' as const,
      loginUrl: 'https://login.tailscale.com/a/1',
    };
    expect(consoleReach({ ...view('off'), enabled: false }, signIn)).toEqual({
      tailscale: { loginUrl: 'https://login.tailscale.com/a/1' },
    });
    const noHttps = { ...TAILSCALE_OFF, state: 'on' as const, name: 'box.tail0000.ts.net', https: false };
    expect(consoleReach({ ...view('off'), assumed: true }, noHttps)).toEqual({
      tailscale: { needsHttps: true, name: 'box.tail0000.ts.net' },
    });
    expect(consoleReach({ ...view('off'), enabled: false }, TAILSCALE_OFF)).toBeUndefined();
  });

  it('refusals carry the session’s codes', () => {
    const err = (status: number, code: string) => new ManagerCallError('/v1/link/on', status, code, code);
    expect(refusalOf(err(404, 'link.unavailable')).code).toBe('whombat_link_unavailable');
    expect(refusalOf(err(409, 'link.busy')).code).toBe('whombat_link_busy');
    expect(refusalOf(err(409, 'link.device_exists')).code).toBe('whombat_link_unavailable');
    expect(refusalOf(err(429, 'link.rate_limited')).code).toBe('whombat_link_rate_limited');
    expect(refusalOf(err(503, 'control_unreachable')).code).toBe('control_unreachable');
    expect(refusalOf(new Error('socket')).code).toBe('control_unreachable');
  });
});

describe('the Inbox (LNK-06)', () => {
  it('one item in grace, one once ended, none otherwise or without Link routes', () => {
    const grace = linkItems(view('grace', { graceEndsAt: '2026-11-25T10:00:00.000Z' }));
    expect(grace).toHaveLength(1);
    expect(grace[0]).toMatchObject({
      title: LINK_WORDS.graceTitle,
      severity: 'warn',
      nature: 'you',
      actions: [{ label: LINK_WORDS.graceTailscale }, { label: LINK_WORDS.graceBackup }],
    });
    expect(grace[0]?.body).toContain('25 November 2026');
    const ended = linkItems(view('ended'));
    expect(ended).toMatchObject([{ title: LINK_WORDS.endedTitle }]);
    // Shown as it is on an iPhone too (LNK-44): no price, no sign-up, no place to buy.
    for (const item of [...grace, ...ended])
      expect(item.body).not.toMatch(/subscribe|sign up|whombat\.com|€|\$/i);
    for (const state of ['off', 'starting', 'on'] as const) expect(linkItems(view(state))).toEqual([]);
    expect(linkItems({ ...view('grace'), assumed: true })).toEqual([]);
  });
});

describe('where a sign-in comes back to (LNK-16)', () => {
  const box = (app?: string) => ({ WHOMBAT_APP_URL: app, NODE_ENV: 'production' as const });

  it('a box claimed through control: the hosted page, for every client', () => {
    expect(returnAddressProblem(box('https://app.whombat.com'))).toBeNull();
    expect(returnAddressProblem(box('https://app.whombat.com'), true)).toBeNull();
  });

  it('a box on its own pages: its secure page, never plain HTTP; a client set in the image can’t come back', () => {
    const own = box('https://app.whombat.com');
    let page: string | null = 'http://192.168.1.20:4480/';
    useBoxPageAsApp(own, () => page);
    expect(returnAddressProblem(own)).toBe(RETURN_ADDRESS_WORDS.noSecure);
    page = 'https://quiet-otter-lamp.box.whombat.app/';
    expect(returnAddressProblem(own)).toBeNull();
    expect(returnAddressProblem(own, true)).toBe(RETURN_ADDRESS_WORDS.hostedOnly);
    expect(returnAddressProblem(box())).toBe(RETURN_ADDRESS_WORDS.noSecure);
  });
});

describe('how often the runtime reads the manager’s Link state (LNK-13)', () => {
  it('every few seconds while it starts, every minute once it ended, every 5 minutes otherwise', async () => {
    vi.useFakeTimers();
    try {
      let state: LinkView['link']['state'] = 'starting';
      let reads = 0;
      const services = {
        clock: () => new Date(),
        log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
      };
      const link = new LinkService({
        services: services as never,
        registeredAtControl: false,
        manager: {
          linkState: async () => {
            reads++;
            return { v: 1, enabled: true, link: { state, since: '2026-11-18T17:00:00Z' } };
          },
        } as never,
      });
      // The owner's own changes are recorded elsewhere; nothing here records a change control made.
      (link as unknown as { record: () => Promise<void> }).record = async () => {};
      await link.start();
      expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(LINK_STARTING_POLL_MS);
      expect(reads).toBe(2);
      state = 'on'; // confirmed on the account site
      await vi.advanceTimersByTimeAsync(LINK_STARTING_POLL_MS);
      expect(reads).toBe(3);
      expect(link.state).toBe('on');
      await vi.advanceTimersByTimeAsync(LINK_STARTING_POLL_MS * 5);
      expect(reads).toBe(3);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(reads).toBe(4);
      state = 'ended'; // the plan stopped and grace ran out
      await vi.advanceTimersByTimeAsync(300_000);
      expect(reads).toBe(5);
      expect(link.state).toBe('ended');
      await vi.advanceTimersByTimeAsync(LINK_ENDED_POLL_MS);
      expect(reads).toBe(6);
      link.stop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(reads).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('after the owner turns Link on, the confirmed code is read within seconds, not at the read planned before', async () => {
    vi.useFakeTimers();
    try {
      let state: LinkView['link']['state'] = 'off';
      let reads = 0;
      const since = '2026-11-18T17:00:00Z';
      const services = {
        clock: () => new Date(),
        log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
      };
      const link = new LinkService({
        services: services as never,
        registeredAtControl: false,
        contentProof: async () => 'ab'.repeat(64),
        manager: {
          linkState: async () => {
            reads++;
            return { v: 1, enabled: true, link: { state, since } };
          },
          linkOn: async () => {
            state = 'starting';
            return { v: 1, enabled: true, link: { state, since } };
          },
        } as never,
      });
      (link as unknown as { record: () => Promise<void> }).record = async () => {};
      // Link is off: the next read is five minutes away.
      await link.start();
      expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await link.turnOn({ accountId: 'acc_1', endpointId: null });
      expect(link.state).toBe('starting');
      expect(reads).toBe(1);
      state = 'on'; // confirmed on the account site
      await vi.advanceTimersByTimeAsync(LINK_STARTING_POLL_MS);
      expect(reads).toBe(2);
      expect(link.state).toBe('on');
      // And from then on at the pace of a Link that is on: one timer, not the old one beside the new.
      await vi.advanceTimersByTimeAsync(300_000 - 1);
      expect(reads).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads).toBe(3);
      link.stop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(reads).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('every few seconds until the manager first answers, which the listeners hear even when nothing changed', async () => {
    vi.useFakeTimers();
    try {
      const services = {
        clock: () => new Date(),
        log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
      };
      // The box restarted before it was linked: the manager is still starting, then answers the code it kept.
      let up = false;
      let reads = 0;
      const link = new LinkService({
        services: services as never,
        registeredAtControl: false,
        manager: {
          linkState: async () => {
            reads++;
            if (!up) throw new Error('connect ENOENT /run/whombat-manager/api.sock');
            return {
              v: 1,
              enabled: true,
              link: {
                state: 'starting',
                since: '2026-11-20T15:00:00Z',
                pending: {
                  code: 'BPXQPCDD',
                  url: 'https://app.whombat.com/link',
                  expiresAt: '2026-11-20T15:15:00Z',
                },
              },
            };
          },
        } as never,
      });
      const heard: string[] = [];
      link.onChange((after) => heard.push(after.link.state));
      await link.start();
      expect(link.answered).toBe(false);
      expect(link.view().assumed).toBe(true);
      await vi.advanceTimersByTimeAsync(LINK_UNANSWERED_POLL_MS);
      expect(reads).toBe(2);
      up = true;
      await vi.advanceTimersByTimeAsync(LINK_UNANSWERED_POLL_MS);
      expect(reads).toBe(3);
      expect(link.answered).toBe(true);
      expect(link.state).toBe('starting');
      expect(heard).toEqual(['starting']);
      // From now on, Link's own pace.
      await vi.advanceTimersByTimeAsync(LINK_UNANSWERED_POLL_MS);
      expect(reads).toBe(3);
      await vi.advanceTimersByTimeAsync(LINK_STARTING_POLL_MS);
      expect(reads).toBe(4);
      link.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a manager without Link routes is an answer too: the listeners hear it once', async () => {
    const services = {
      clock: () => new Date(),
      log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    };
    const link = new LinkService({
      services: services as never,
      registeredAtControl: false,
      manager: {
        linkState: async () => {
          throw new ManagerCallError('/v1/link/state', 404, 'not_found', 'no');
        },
      } as never,
      timers: false,
    });
    let heard = 0;
    link.onChange(() => heard++);
    await link.start();
    expect(link.answered).toBe(true);
    expect(heard).toBe(1);
    await link.refresh();
    expect(heard).toBe(1);
  });
});

describe('the box’s name reaches control while Link runs (LNK-56)', () => {
  it('a name the manager wasn’t given goes once Link is on, a rename goes again, nothing while Link starts', async () => {
    const services = {
      clock: () => new Date(),
      log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    };
    let state: LinkView['link']['state'] = 'starting';
    let name: string | null = null;
    const sent: (string | undefined)[] = [];
    const link = new LinkService({
      services: services as never,
      registeredAtControl: false,
      manager: {
        linkState: async () => ({ v: 1, enabled: true, link: { state, since: '2026-11-20T17:00:00Z' } }),
        linkOn: async (body: { name?: string }) => {
          sent.push(body.name);
          return { v: 1, enabled: true, link: { state, since: '2026-11-20T17:00:00Z' } };
        },
      } as never,
      contentProof: async () => 'ab'.repeat(64),
      name: async () => name,
      timers: false,
    });
    (link as unknown as { record: () => Promise<void> }).record = async () => {};
    await link.start();
    // Starting: a call now would mean a new code; and the box has no name yet anyway.
    name = 'Home';
    await link.tellName();
    expect(sent).toEqual([]);
    // Confirmed on the account site: the next read gives the name.
    state = 'on';
    await link.refresh();
    await link.tellName();
    expect(sent).toEqual(['Home']);
    // The same name again (every read, every commit that names something): nothing.
    await link.refresh();
    await link.tellName();
    expect(sent).toEqual(['Home']);
    // Renamed.
    name = 'Garden shed';
    await link.tellName();
    expect(sent).toEqual(['Home', 'Garden shed']);
    // Link ended: nothing goes.
    state = 'ended';
    await link.refresh();
    name = 'Cabin';
    await link.tellName();
    expect(sent).toEqual(['Home', 'Garden shed']);
  });
});
