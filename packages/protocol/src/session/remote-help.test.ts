/** Contracts 0.120.0: remote help over the session (CT-931…CT-936; Whombat remote-help.md RH-01…RH-09). */
import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalJson } from '@whombat/core/audit';
import { describe, expect, it } from 'vitest';
import { base64urlEncode, utf8Encode } from '../bytes.js';
import { APP_ERROR_CODES } from './errors.js';
import { operationSafety, resendAfterNotFound } from './operation-safety.js';
import { createOperationAllowlist, SESSION_OPERATIONS } from './operations.js';
import {
  PASSKEY_REMOTE_HELP_PURPOSE,
  passkeyEnrollChallengeBase64url,
  passkeyRemoteHelpChallengeBase64url,
  WebAuthnRequestOptions,
} from './passkeys.js';
import { APPLIANCE_EVENT_TYPES, ApplianceEventType } from './providers.js';
import {
  REMOTE_HELP_CONFIRM_TTL_S,
  REMOTE_HELP_TRANSCRIPT_CONTENT_TYPE,
  RemoteHelpConfirmBeginOutput,
  type RemoteHelpGrant,
  RemoteHelpOffAuditPayload,
  RemoteHelpOnAuditPayload,
  RemoteHelpStartInput,
  RemoteHelpState,
  RemoteHelpStep,
  RemoteHelpVisitAuditPayload,
  RemoteHelpVisitsInput,
  RemoteHelpVisitsOutput,
  RemoteHelpWho,
  remoteHelpStateValid,
  remoteHelpStepValid,
  remoteHelpTranscriptName,
  SshEd25519PublicKey,
} from './remote-help.js';
import { decodeTolerant } from './tolerant.js';

const OPS = [
  'remoteHelp.get',
  'remoteHelp.confirmBegin',
  'remoteHelp.start',
  'remoteHelp.stop',
  'remoteHelp.visits',
  'remoteHelp.transcript',
];
const at = '2026-10-21T14:00:00Z';
const owner = { accountId: 'acc_mara0001', name: 'Mara Jansen' };
const grant: RemoteHelpGrant = {
  level: 'fix',
  since: at,
  until: '2026-10-22T14:00:00Z',
  grantedBy: owner,
  helpCode: null,
};
const state: RemoteHelpState = {
  available: true,
  foreverAllowed: true,
  helpCodeRequired: false,
  grant,
  connected: [{ visitId: '12345', who: 'Claude', since: at }],
};
const nonce = '5a'.repeat(32);
const endpoint = '12D3KooWNrPX9JcmH7DQVJDVr2AXRBHGLAE2Bowcs2hFgaBStMDa';
const assertion = {
  id: 'Y3JlZA',
  rawId: 'Y3JlZA',
  type: 'public-key',
  response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'MEUC' },
  clientExtensionResults: {},
};

describe('the ops (CT-933)', () => {
  it('has six owner ops on the app channel', () => {
    const allow = createOperationAllowlist();
    for (const op of OPS) {
      const spec = SESSION_OPERATIONS.get(op);
      expect(spec?.source, op).toBe('session');
      expect(spec?.channel, op).toBe('app');
      // Only turning it on is secret: its answer holds a prod box's help code, which no receipt keeps (CT-44).
      expect(spec?.secret, op).toBe(op === 'remoteHelp.start');
      expect(allow.resolve(op, { enrolled: false }), op).toEqual({ ok: false, code: 'enrollment_required' });
    }
  });

  it('reads get and visits; the begin is ephemeral like passkey.register.begin; the transcript is an export', () => {
    const spec = (op: string) => SESSION_OPERATIONS.get(op);
    expect(spec('remoteHelp.get')?.mutating).toBe(false);
    expect(spec('remoteHelp.visits')?.mutating).toBe(false);
    const begin = spec('remoteHelp.confirmBegin');
    const passkeyBegin = spec('passkey.register.begin');
    expect([begin?.mutating, begin?.ephemeral, begin?.retry]).toEqual([
      passkeyBegin?.mutating,
      passkeyBegin?.ephemeral,
      passkeyBegin?.retry,
    ]);
    expect(begin?.ephemeral).toBe(true);
    const transcript = spec('remoteHelp.transcript');
    expect([transcript?.transfer, transcript?.exportOp]).toEqual(['export', true]);
    expect(REMOTE_HELP_TRANSCRIPT_CONTENT_TYPE).toMatch(/^text\/plain; charset=utf-8$/);
    expect(remoteHelpTranscriptName('12345')).toBe('whombat-remote-help-12345.txt');
    expect(() => remoteHelpTranscriptName('../etc')).toThrow();
  });

  it('never resends turning it on by itself; resends a stop; a person decides on a start', () => {
    expect(operationSafety('remoteHelp.start')).toEqual({ destructive: true, retry: 'never' });
    expect(resendAfterNotFound('remoteHelp.start')).toBe(false);
    expect(operationSafety('remoteHelp.stop')).toEqual({ destructive: false, retry: 'receipt' });
    expect(resendAfterNotFound('remoteHelp.stop')).toBe(true);
    expect(operationSafety('remoteHelp.confirmBegin')?.retry).toBe('never');
    expect(operationSafety('remoteHelp.transcript')?.retry).toBe('never');
  });

  it('names its refusals and its signed events', () => {
    for (const code of [
      'remote_help_unavailable',
      'forever_not_allowed',
      'passkey_required',
      'passkey_failed',
      'remote_help_busy',
    ])
      expect(APP_ERROR_CODES, code).toHaveProperty(code);
    for (const type of ['remote_help.on', 'remote_help.off', 'remote_help.visit'])
      expect(ApplianceEventType.parse(type)).toBe(type);
    const first = APPLIANCE_EVENT_TYPES.indexOf('remote_help.on');
    expect(APPLIANCE_EVENT_TYPES.slice(first, first + 3)).toEqual([
      'remote_help.on',
      'remote_help.off',
      'remote_help.visit',
    ]);
    expect(RemoteHelpOnAuditPayload.parse({ level: 'fix', duration: 'forever' })).toEqual({
      level: 'fix',
      duration: 'forever',
    });
    expect(RemoteHelpOffAuditPayload.safeParse({ reason: 'wrong_codes' }).success).toBe(true);
    expect(RemoteHelpOffAuditPayload.safeParse({ reason: 'support' }).success).toBe(false);
    // A visit's event carries who and how many steps, never a help code (parsing strips it).
    const visit = {
      who: 'Claude',
      level: 'look',
      startedAt: at,
      endedAt: null,
      steps: 0,
      helpCode: 'KQ72MX',
    };
    expect(RemoteHelpVisitAuditPayload.parse(visit)).not.toHaveProperty('helpCode');
  });
});

describe('confirming with a passkey (CT-934)', () => {
  it('binds the nonce, the device, the level and the duration', () => {
    const choice = { nonce, endpoint, level: 'fix', duration: 'day' };
    const expected = base64urlEncode(
      sha256(utf8Encode(canonicalJson({ purpose: 'whombat-remote-help/1', ...choice }))),
    );
    expect(PASSKEY_REMOTE_HELP_PURPOSE).toBe('whombat-remote-help/1');
    expect(passkeyRemoteHelpChallengeBase64url(choice)).toBe(expected);
    const others = [
      { ...choice, level: 'look' },
      { ...choice, duration: 'forever' },
      { ...choice, nonce: 'a5'.repeat(32) },
      { ...choice, endpoint: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH' },
    ].map(passkeyRemoteHelpChallengeBase64url);
    expect(new Set([expected, ...others]).size).toBe(5);
    // Never the same bytes as a sign-in's challenge for the same nonce and device.
    expect(passkeyEnrollChallengeBase64url({ nonce, endpoint })).not.toBe(expected);
    for (const bad of [
      { ...choice, level: 'root' },
      { ...choice, duration: 'month' },
      { ...choice, nonce: 'xyz' },
      { ...choice, endpoint: 'peer' },
    ])
      expect(() => passkeyRemoteHelpChallengeBase64url(bad), JSON.stringify(bad)).toThrow();
  });

  it('begins with the options and a nonce, or neither for an owner without a passkey', () => {
    const options = {
      challenge: passkeyRemoteHelpChallengeBase64url({ nonce, endpoint, level: 'look', duration: 'hour' }),
      rpId: 'dev.whombat.com',
      allowCredentials: [{ id: 'Y3JlZA', type: 'public-key', transports: ['internal', 'hybrid'] }],
      userVerification: 'required',
      timeout: 60_000,
    };
    expect(RemoteHelpConfirmBeginOutput.parse({ nonce, options })).toEqual({ nonce, options });
    expect(RemoteHelpConfirmBeginOutput.parse({ nonce: null, options: null })).toEqual({
      nonce: null,
      options: null,
    });
    // A newer browser's or runtime's members are stripped, never refused.
    expect(WebAuthnRequestOptions.parse({ ...options, hints: ['client-device'] })).toEqual(options);
    expect(WebAuthnRequestOptions.safeParse({ ...options, rpId: 'Dev.Whombat.com' }).success).toBe(false);
    expect(REMOTE_HELP_CONFIRM_TTL_S).toBe(300);
    expect(SESSION_OPERATIONS.get('remoteHelp.confirmBegin')?.input.safeParse({}).success).toBe(false);
  });

  it('starts with the same choice and the assertion, strictly', () => {
    expect(RemoteHelpStartInput.safeParse({ level: 'fix', duration: 'week' }).success).toBe(true);
    expect(
      RemoteHelpStartInput.safeParse({ level: 'fix', duration: 'week', passkey: assertion }).success,
    ).toBe(true);
    for (const bad of [
      { level: 'fix', duration: 'week', helpCode: 'KQ72MX' },
      { level: 'fix', durationS: 3_600 },
      { level: 'admin', duration: 'hour' },
    ])
      expect(RemoteHelpStartInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});

describe('the state and the visits (CT-931, CT-932)', () => {
  it('reads a state on and off, and checks what the schema can’t', () => {
    expect(RemoteHelpState.parse(state)).toEqual(state);
    expect(remoteHelpStateValid(state)).toBe(true);
    const off = { ...state, grant: null, connected: [] };
    expect(remoteHelpStateValid(off)).toBe(true);
    expect(remoteHelpStateValid({ ...off, connected: state.connected })).toBe(false);
    expect(remoteHelpStateValid({ ...state, available: false })).toBe(false);
    expect(remoteHelpStateValid({ ...state, helpCodeRequired: true })).toBe(false);
    expect(
      remoteHelpStateValid({
        ...state,
        foreverAllowed: false,
        helpCodeRequired: true,
        grant: { ...grant, helpCode: 'KQ72MX' },
      }),
    ).toBe(true);
    expect(remoteHelpStateValid({ ...state, foreverAllowed: false, grant: { ...grant, until: null } })).toBe(
      false,
    );
    const twice = [...state.connected, ...state.connected];
    expect(remoteHelpStateValid({ ...state, connected: twice })).toBe(false);
  });

  it('shows who visits by name only, never an id or a second line', () => {
    expect(RemoteHelpWho.safeParse('Claude').success).toBe(true);
    expect(RemoteHelpWho.safeParse('Zoë 🎉').success).toBe(true);
    for (const bad of ['', 'x'.repeat(41), 'Claude\nop_1', ' Claude‮'])
      expect(RemoteHelpWho.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(
      RemoteHelpState.safeParse({ ...state, connected: Array(9).fill(state.connected[0]) }).success,
    ).toBe(false);
  });

  it('pins the host key as an Ed25519 key without a comment', () => {
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINW5nEYpnLC/ggxoMZMtKIrMTB3zH3cpPnngDIgx6CrR';
    expect(SshEd25519PublicKey.safeParse(key).success).toBe(true);
    for (const bad of [`${key} `, `${key} root@box`, key.replace('ed25519', 'rsa'), key.slice(0, -1)])
      expect(SshEd25519PublicKey.safeParse(bad).success, bad).toBe(false);
  });

  it('checks each step kind’s members', () => {
    const ok: RemoteHelpStep[] = [
      { at, kind: 'connected' },
      { at, kind: 'look', command: 'logs', units: ['whombat-voice.service'] },
      { at, kind: 'exec', line: 'journalctl -u whombat-voice -n 50' },
      { at, kind: 'shell', seconds: 0 },
      { at, kind: 'restart', units: ['whombat-voice.service'] },
      { at, kind: 'forward', target: '[::1]:5432', bytes: 0 },
      { at, kind: 'refused', reason: 'unknown_command' },
    ];
    for (const step of ok) expect(remoteHelpStepValid(RemoteHelpStep.parse(step)), step.kind).toBe(true);
    const bad: RemoteHelpStep[] = [
      { at, kind: 'look', command: 'disks', units: ['whombat-voice.service'] },
      { at, kind: 'restart', units: [] },
      { at, kind: 'exec', bytes: 1 },
    ];
    for (const step of bad) expect(remoteHelpStepValid(step), step.kind).toBe(false);
  });

  it('pages visits newest first, at most 20', () => {
    expect(RemoteHelpVisitsInput.safeParse({}).success).toBe(true);
    expect(RemoteHelpVisitsInput.safeParse({ before: '12345', limit: 20 }).success).toBe(true);
    expect(RemoteHelpVisitsInput.safeParse({ limit: 21 }).success).toBe(false);
    expect(RemoteHelpVisitsInput.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('an older app drops a newer step kind and keeps the visit', () => {
    const visit = {
      id: '12345',
      who: 'Claude',
      level: 'fix',
      startedAt: at,
      endedAt: null,
      steps: [
        { at, kind: 'connected' },
        { at, kind: 'upload', target: '/tmp/x' },
      ],
      truncated: false,
      transcriptBytes: 0,
    };
    const decoded = decodeTolerant(RemoteHelpVisitsOutput, { visits: [visit] });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.data.visits[0]?.steps).toEqual([{ at, kind: 'connected' }]);
      expect(decoded.skipped.map((s) => s.action)).toEqual(['dropped']);
    }
  });
});
