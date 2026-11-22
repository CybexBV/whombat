import { normalizeHelpCode, REMOTE_HELP_WORDS } from '@whombat/core/domain';
import { base64urlEncode } from '@whombat/protocol';
import { passkeyRemoteHelpChallengeBase64url } from '@whombat/protocol/session';
import { describe, expect, it, vi } from 'vitest';
import { OperationError } from '../session/managed-ops';
import { PasskeyCancelled, type PasskeyPlatform, type PasskeyRequestOptionsJSON } from './passkeys';
import {
  cleanTranscript,
  REMOTE_HELP_TEXT,
  type RemoteHelpApi,
  RemoteHelpError,
  type RemoteHelpState,
  type RemoteHelpVisit,
  remoteHelpCard,
  remoteHelpChoice,
  remoteHelpErrorText,
  remoteHelpPasskeyOptions,
  remoteHelpPollMs,
  remoteHelpVisitRows,
  turnOnRemoteHelp,
} from './remote-help';
import { createFakeRemoteHelp, type FakeRemoteHelpCaller } from './remote-help-fake';

const ME = '12D3KooWNrPX9JcmH7DQVJDVr2AXRBHGLAE2Bowcs2hFgaBStMDa';
const OTHER = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
const NONCE = 'a'.repeat(64);
const TZ = 'Europe/Amsterdam';
// Wednesday 21 October 2026, 11:22 in Amsterdam.
const NOW = new Date('2026-10-21T09:22:00Z');

/* The confirmation (RH-04) ---------------------------------------------------------------------------------------- */

/** An authenticator that signs whatever challenge it's given, as client data the fake reads. */
function platform(id = 'cred-1'): PasskeyPlatform & { seen: PasskeyRequestOptionsJSON[] } {
  const seen: PasskeyRequestOptionsJSON[] = [];
  const text = (v: unknown) => base64urlEncode(new TextEncoder().encode(JSON.stringify(v)));
  return {
    seen,
    isAvailable: async () => true,
    supportsConditional: async () => false,
    create: async () => {
      throw new Error('not here');
    },
    get: async (options) => {
      seen.push(options);
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: text({ type: 'webauthn.get', challenge: options.challenge, origin: 'https://x' }),
          authenticatorData: 'AAAA',
          signature: 'AAAA',
        },
        clientExtensionResults: {},
      };
    },
  };
}

/** The fake's ops as a `RemoteHelpApi` for `caller`. */
function fakeApi(fake: ReturnType<typeof createFakeRemoteHelp>, caller: FakeRemoteHelpCaller) {
  const call = async (op: string, input: unknown = {}) => {
    const r = fake.call(op, input, caller);
    if (r.status >= 300) {
      const e = (r.body as { error: { code: string; message: string; details?: unknown } }).error;
      throw new OperationError(op, r.status, e.code, e.message, e.details);
    }
    return r.body as never;
  };
  const api: Pick<RemoteHelpApi, 'confirmBegin' | 'start' | 'stop' | 'get'> = {
    confirmBegin: (choice) => call('remoteHelp.confirmBegin', choice),
    start: (input) => call('remoteHelp.start', input),
    stop: () => call('remoteHelp.stop'),
    get: () => call('remoteHelp.get'),
  };
  return api;
}

const mara = (passkeys: string[] = []): FakeRemoteHelpCaller => ({
  accountId: 'acc_mara',
  name: 'Mara',
  endpoint: ME,
  passkeys,
});

describe('the passkey request is checked before anything is signed', () => {
  const choice = { level: 'fix', duration: 'day' } as const;
  const begin = (over: Partial<Parameters<typeof passkeyRemoteHelpChallengeBase64url>[0]> = {}) => ({
    nonce: NONCE,
    options: {
      challenge: passkeyRemoteHelpChallengeBase64url({ nonce: NONCE, endpoint: ME, ...choice, ...over }),
      rpId: 'dev.whombat.com',
      allowCredentials: [{ id: 'cred-1', type: 'public-key' as const }],
      userVerification: 'preferred' as const,
    },
  });

  it('takes the challenge of this choice on this device, with user verification', () => {
    const options = remoteHelpPasskeyOptions(begin(), ME, choice);
    expect(options.userVerification).toBe('required');
    expect(options.rpId).toBe('dev.whombat.com');
  });

  it('refuses one for another level, time, device or nonce', () => {
    for (const over of [{ level: 'look' }, { duration: 'forever' }, { endpoint: OTHER }] as const)
      expect(() => remoteHelpPasskeyOptions(begin(over), ME, choice)).toThrow(RemoteHelpError);
    expect(() => remoteHelpPasskeyOptions({ ...begin(), nonce: 'b'.repeat(64) }, ME, choice)).toThrow(
      RemoteHelpError,
    );
    expect(() => remoteHelpPasskeyOptions({ ...begin(), nonce: null }, ME, choice)).toThrow(RemoteHelpError);
  });
});

describe('turning it on', () => {
  it('with a passkey: the begun choice, the assertion, and the box takes it', async () => {
    const fake = createFakeRemoteHelp({ now: () => NOW.getTime() });
    const api = fakeApi(fake, mara(['cred-1']));
    const p = platform();
    const confirm = vi.fn(async () => true);
    const r = await turnOnRemoteHelp(
      { api, platform: p, endpoint: ME, confirm },
      { level: 'fix', duration: 'week' },
    );
    expect(r.kind).toBe('on');
    expect(confirm).not.toHaveBeenCalled();
    expect(p.seen[0]?.allowCredentials?.map((c) => c.id)).toEqual(['cred-1']);
    expect(fake.snapshot().grant).toMatchObject({
      level: 'fix',
      until: '2026-10-28T09:22:00Z',
      helpCode: null,
    });
  });

  it('without a passkey: the dialog, and nothing when it is cancelled', async () => {
    const fake = createFakeRemoteHelp({ now: () => NOW.getTime() });
    const api = fakeApi(fake, mara());
    const p = platform();
    const no = await turnOnRemoteHelp(
      { api, platform: p, endpoint: ME, confirm: async () => false },
      { level: 'look', duration: 'hour' },
    );
    expect(no.kind).toBe('cancelled');
    expect(fake.snapshot().grant).toBeNull();
    const yes = await turnOnRemoteHelp(
      { api, platform: p, endpoint: ME, confirm: async () => true },
      { level: 'look', duration: 'hour' },
    );
    expect(yes.kind).toBe('on');
    expect(p.seen).toHaveLength(0);
    expect(fake.snapshot().grant?.grantedBy).toEqual({ accountId: 'acc_mara', name: 'Mara' });
  });

  it('a dismissed passkey prompt changes nothing; a device without passkeys says so', async () => {
    const fake = createFakeRemoteHelp({ now: () => NOW.getTime() });
    const api = fakeApi(fake, mara(['cred-1']));
    const dismissed: PasskeyPlatform = {
      ...platform(),
      get: async () => {
        throw new PasskeyCancelled();
      },
    };
    const deps = { api, endpoint: ME, confirm: async () => true };
    expect(
      (await turnOnRemoteHelp({ ...deps, platform: dismissed }, { level: 'look', duration: 'day' })).kind,
    ).toBe('cancelled');
    const none = turnOnRemoteHelp({ ...deps, platform: null }, { level: 'look', duration: 'day' });
    await expect(none).rejects.toMatchObject({ code: 'passkey_here' });
    expect(remoteHelpErrorText(await none.catch((e) => e))).toContain('This device can’t use your passkey');
    expect(fake.snapshot().grant).toBeNull();
  });

  it('the box refuses another device’s assertion, a wrong credential, and Forever on a customer box', async () => {
    const fake = createFakeRemoteHelp({ now: () => NOW.getTime() });
    // The Whombat began it for this device; an assertion made for another key doesn't confirm it.
    const lying = { ...fakeApi(fake, mara(['cred-1'])) };
    await lying.confirmBegin({ level: 'fix', duration: 'day' });
    const other = platform();
    const wrong = await other.get({
      challenge: passkeyRemoteHelpChallengeBase64url({
        nonce: NONCE,
        endpoint: OTHER,
        level: 'fix',
        duration: 'day',
      }),
    });
    const refused = lying.start({ level: 'fix', duration: 'day', passkey: wrong });
    await expect(refused).rejects.toMatchObject({ details: { code: 'passkey_failed' } });
    expect(remoteHelpErrorText(await refused.catch((e) => e))).toBe(
      REMOTE_HELP_WORDS.refusals.passkey_failed,
    );
    // Another credential than the person's.
    const api = fakeApi(fake, mara(['cred-1']));
    const r = turnOnRemoteHelp(
      { api, platform: platform('cred-9'), endpoint: ME, confirm: async () => true },
      { level: 'fix', duration: 'day' },
    );
    await expect(r).rejects.toMatchObject({ details: { code: 'passkey_failed' } });
    // No assertion at all from someone who has a passkey.
    await expect(api.start({ level: 'look', duration: 'day' })).rejects.toMatchObject({
      details: { code: 'passkey_required' },
    });
    fake.setEnvironment('prod');
    const forever = turnOnRemoteHelp(
      { api: fakeApi(fake, mara()), platform: null, endpoint: ME, confirm: async () => true },
      { level: 'look', duration: 'forever' },
    );
    expect(remoteHelpErrorText(await forever.catch((e) => e))).toBe('Forever is only for test Whombats.');
    expect(fake.snapshot().grant).toBeNull();
  });

  it('a customer box hands out a help code', async () => {
    const fake = createFakeRemoteHelp({ now: () => NOW.getTime() });
    fake.setEnvironment('prod');
    await fakeApi(fake, mara()).start({ level: 'look', duration: 'hour' });
    const state = await fakeApi(fake, mara()).get();
    expect(state.helpCodeRequired).toBe(true);
    expect(normalizeHelpCode(state.grant?.helpCode ?? '')).toBe(state.grant?.helpCode);
  });
});

describe('refusals in words', () => {
  const op = (code: string) => new OperationError('remoteHelp.start', 409, 'conflict', 'no', { code });
  it('says the brief’s words, nothing for a dismissed prompt', () => {
    expect(remoteHelpErrorText(op('remote_help_busy'))).toBe(
      'Remote help didn’t answer. Try again in a moment.',
    );
    expect(remoteHelpErrorText(op('remote_help_unavailable'))).toBe(REMOTE_HELP_WORDS.notAvailable);
    expect(remoteHelpErrorText(op('passkey_required'))).toBe(REMOTE_HELP_WORDS.refusals.passkey_failed);
    // The box's own page can't run the passkey's ceremony: it says where to turn it on instead.
    expect(remoteHelpErrorText(op('passkeys_unavailable_here'))).toBe(REMOTE_HELP_TEXT.passkeyPage);
    expect(remoteHelpErrorText(new RemoteHelpError('challenge_mismatch'))).toBe(
      REMOTE_HELP_WORDS.refusals.passkey_failed,
    );
    expect(remoteHelpErrorText(new PasskeyCancelled())).toBeNull();
    expect(remoteHelpErrorText(new Error('x'))).toBe('That didn’t work. Try again.');
  });
});

/* What the card shows --------------------------------------------------------------------------------------------- */

const OFF: RemoteHelpState = {
  available: true,
  foreverAllowed: false,
  helpCodeRequired: true,
  grant: null,
  connected: [],
};

describe('the card', () => {
  it('is not available on a box without a support key', () => {
    expect(remoteHelpCard({ state: { ...OFF, available: false }, hasPasskey: null, now: NOW })).toMatchObject(
      { kind: 'unavailable', text: 'Remote help isn’t available on this Whombat yet.' },
    );
    expect(remoteHelpCard({ state: null, hasPasskey: null, now: NOW }).kind).toBe('loading');
  });

  it('off: both levels, Forever only where it’s allowed, the passkey hint for someone with one', () => {
    const card = remoteHelpCard({ state: OFF, hasPasskey: true, now: NOW });
    if (card.kind !== 'off') throw new Error(card.kind);
    expect(card.levels.map((l) => l.label)).toEqual(['Look', 'Look and fix']);
    expect(card.durations.map((d) => d.label)).toEqual(['1 hour', '1 day', '1 week']);
    expect(card.hint).toBe('You’ll confirm with your passkey.');
    const dev = remoteHelpCard({ state: { ...OFF, foreverAllowed: true }, hasPasskey: false, now: NOW });
    if (dev.kind !== 'off') throw new Error(dev.kind);
    expect(dev.durations.map((d) => d.value)).toContain('forever');
    expect(dev.hint).toBeNull();
    expect(remoteHelpChoice({ level: 'fix', duration: 'forever' }, OFF)).toEqual({
      level: 'fix',
      duration: 'day',
    });
  });

  it('on: the state line, the help code in halves, who is connected, and it asks again', () => {
    const on: RemoteHelpState = {
      ...OFF,
      grant: {
        level: 'fix',
        since: '2026-10-21T09:00:00Z',
        until: '2026-10-22T12:00:00Z',
        grantedBy: { accountId: 'acc_mara', name: 'Mara' },
        helpCode: 'KQ72MX',
      },
      connected: [{ visitId: 'vis_1', who: 'John', since: '2026-10-21T09:02:00Z' }],
    };
    const card = remoteHelpCard({ state: on, hasPasskey: true, now: NOW, timeZone: TZ });
    expect(card).toMatchObject({
      kind: 'on',
      line: 'On · Look and fix · until tomorrow 14:00',
      helpCode: { code: 'KQ7·2MX' },
      connected: [{ text: 'John is connected now' }],
    });
    expect(remoteHelpPollMs(on)).toBe(10_000);
    expect(remoteHelpPollMs(OFF)).toBeNull();
  });
});

describe('what support did', () => {
  const visit = (over: Partial<RemoteHelpVisit> = {}): RemoteHelpVisit => ({
    id: 'vis_1',
    who: 'John',
    level: 'fix',
    startedAt: '2026-10-21T08:02:00Z',
    endedAt: '2026-10-21T08:15:00Z',
    steps: [
      { at: '2026-10-21T08:02:00Z', kind: 'connected' },
      { at: '2026-10-21T08:03:00Z', kind: 'look', command: 'logs', units: ['whombat-voice.service'] },
      { at: '2026-10-21T08:05:00Z', kind: 'exec', line: 'systemctl restart whombat-voice' },
      { at: '2026-10-21T08:09:00Z', kind: 'shell', seconds: 360 },
      { at: '2026-10-21T08:15:00Z', kind: 'left' },
    ],
    truncated: false,
    transcriptBytes: 120,
    ...over,
  });

  it('lists each visit’s steps in order, the newest visit first, with Show on its first command', () => {
    const rows = remoteHelpVisitRows(
      [visit({ id: 'vis_2', startedAt: '2026-10-21T09:00:00Z', transcriptBytes: 0 }), visit()],
      { now: NOW, timeZone: TZ },
    );
    expect(rows.map((r) => r.key.split(':')[0])).toEqual([
      ...Array(5).fill('vis_2'),
      ...Array(5).fill('vis_1'),
    ]);
    const first = rows.slice(5);
    expect(first.map((r) => r.time)).toEqual(['10:02', '10:03', '10:05', '10:09', '10:15']);
    expect(first[1]?.text).toBe('Read the logs of voice');
    expect(first[2]).toMatchObject({
      text: 'Ran',
      code: 'systemctl restart whombat-voice',
      transcript: 'vis_1',
    });
    expect(first.filter((r) => r.transcript)).toHaveLength(1);
    expect(rows.slice(0, 5).some((r) => r.transcript)).toBe(false);
  });

  it('dates steps of another day, and says when older steps were left out', () => {
    const rows = remoteHelpVisitRows([visit({ truncated: true })], {
      now: new Date('2026-10-23T09:00:00Z'),
      timeZone: TZ,
    });
    expect(rows[0]).toMatchObject({ muted: true, text: 'Earlier steps aren’t shown.' });
    expect(rows[1]?.time).toBe('21 Oct 10:02');
  });
});

describe('the command line’s record', () => {
  it('keeps text, new lines and tabs only', () => {
    expect(cleanTranscript('\u001b[1;32mroot\u001b[0m:~# ls\r\na\tb\u0007\r\n\u001b]0;title\u0007done')).toBe(
      'root:~# ls\na\tb\ndone',
    );
  });
});

describe('support’s side of the fake', () => {
  it('records a visit, closes it on Stop, and Look can’t restart', async () => {
    let t = NOW.getTime();
    const fake = createFakeRemoteHelp({ now: () => t });
    const api = fakeApi(fake, mara());
    await api.start({ level: 'look', duration: 'hour' });
    const id = fake.visit({ who: 'Claude' }) as string;
    const state = await api.get();
    expect(state.connected.map((c) => c.who)).toEqual(['Claude']);
    const steps = fake.snapshot().visits[0]?.steps ?? [];
    expect(steps.filter((s) => s.kind === 'refused')).toHaveLength(3);
    expect(fake.snapshot().visits[0]?.transcriptBytes).toBe(0);
    await api.stop();
    expect(fake.snapshot().visits.find((v) => v.id === id)?.endedAt).not.toBeNull();
    // It runs out by itself (RH-01).
    await api.start({ level: 'fix', duration: 'hour' });
    t += 3_600_000;
    expect((await api.get()).grant).toBeNull();
  });
});
