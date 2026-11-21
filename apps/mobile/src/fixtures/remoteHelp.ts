/**
 * Remote help in the demo world (app docs/decisions/remote-help.md AP-4478): the shared fake
 * (`createFakeRemoteHelp`, `@whombat/client/remote-help/fake`) answering `remoteHelp.*` for the demo's person on a test
 * Whombat, as the box and its support service would. Turned on, Whombat support (“Support”) connects a few seconds
 * later with the fake's steps (a status, the voice's logs, a restart, a command line), so “What support did” fills in
 * as it would. With a passkey you confirm with the demo's own authenticator, which signs the challenge it is
 * given as the fake reads it (nothing is asked of Android's passkeys: the demo Whombat isn't a real relying party).
 *
 * Settings → This Whombat takes `?help=<state>` in the demo world (`whombat://settings/whombat?help=customer`) to start
 * over in another state, for checks on the emulator: `REMOTE_HELP_DEMO_STATES`. Pure TypeScript.
 */
import type {
  PasskeyAssertionJSON,
  PasskeyPlatform,
  RemoteHelpApi,
  RemoteHelpStep,
  RemoteHelpVisit,
} from '@whombat/client/managed';
import { remoteHelpTranscriptOf } from '@whombat/client/managed';
import {
  createFakeRemoteHelp,
  EMPTY_REMOTE_HELP,
  FAKE_REMOTE_HELP_TRANSCRIPT,
  type FakeRemoteHelp,
  type FakeRemoteHelpCaller,
  type FakeRemoteHelpSnapshot,
} from '@whombat/client/remote-help/fake';
import { OperationError } from '@whombat/client/session';
import { base64urlEncode } from '@whombat/protocol';

export const REMOTE_HELP_DEMO_STATES = [
  /** A test Whombat, off, nobody has used it; you have no passkey, so turning on asks in a dialog (the start). */
  'off',
  /** The same with your passkey: “You’ll confirm with your passkey.” */
  'passkey',
  /** On: Look and fix, forever, Support connected now, with a command line to show. */
  'on',
  /** A customer's Whombat: Look for an hour, the help code, Support connected; what needs Look and fix was stopped. */
  'customer',
  /** Off again, with what support did on two earlier visits (the older one longer than is shown). */
  'history',
  /** No support key on this Whombat yet. */
  'unavailable',
] as const;
export type RemoteHelpDemoState = (typeof REMOTE_HELP_DEMO_STATES)[number];

export function isRemoteHelpDemoState(value: unknown): value is RemoteHelpDemoState {
  return typeof value === 'string' && (REMOTE_HELP_DEMO_STATES as readonly string[]).includes(value);
}

/** The demo phone's key, which the challenge names. */
export const REMOTE_HELP_DEMO_ENDPOINT = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';
/** The demo person's passkey (its credential id). */
export const REMOTE_HELP_DEMO_PASSKEY = base64urlEncode(new TextEncoder().encode('whombat-demo-passkey'));
/** The demo person's account on the Whombat (the grant names an account, `acc_…`; the demo's people are `prn_…`). */
export const REMOTE_HELP_DEMO_ACCOUNT = 'acc_demo_person';
/** Who connects from Whombat support. */
export const REMOTE_HELP_DEMO_WHO = 'Support';

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** A finished visit `at` ms ago: `connected`, the steps a minute apart, `left`. */
function pastVisit(
  id: string,
  at: number,
  level: RemoteHelpVisit['level'],
  steps: Omit<RemoteHelpStep, 'at'>[],
  extra: Partial<RemoteHelpVisit> = {},
): RemoteHelpVisit {
  const all: RemoteHelpStep[] = [
    { at: iso(at), kind: 'connected' },
    ...steps.map((s, i) => ({ ...s, at: iso(at + (i + 1) * MIN) })),
    { at: iso(at + (steps.length + 1) * MIN), kind: 'left' },
  ];
  return {
    id,
    who: REMOTE_HELP_DEMO_WHO,
    level,
    startedAt: iso(at),
    endedAt: iso(at + (steps.length + 1) * MIN),
    steps: all,
    truncated: false,
    transcriptBytes: 0,
    ...extra,
  };
}

/** The fake's start for a state at `now` (null: as a new box, then turned on by the demo itself). */
export function remoteHelpDemoSeed(state: RemoteHelpDemoState, now: number): FakeRemoteHelpSnapshot {
  const empty: FakeRemoteHelpSnapshot = { ...EMPTY_REMOTE_HELP, environment: 'local' };
  switch (state) {
    case 'off':
    case 'passkey':
    case 'on':
      return empty;
    case 'customer':
      return { ...empty, environment: 'prod' };
    case 'unavailable':
      return { ...empty, available: false };
    case 'history': {
      const yesterday = pastVisit(
        'vis_demo_fix',
        now - 26 * HOUR,
        'fix',
        [
          { kind: 'look', command: 'status' },
          { kind: 'look', command: 'logs', units: ['whombat-voice.service'] },
          { kind: 'shell', seconds: 372 },
          { kind: 'restart', units: ['whombat-voice.service'] },
        ],
        { transcriptBytes: new TextEncoder().encode(FAKE_REMOTE_HELP_TRANSCRIPT).byteLength },
      );
      const older = pastVisit(
        'vis_demo_look',
        now - 5 * 24 * HOUR,
        'look',
        [
          { kind: 'look', command: 'network' },
          { kind: 'look', command: 'disks' },
          { kind: 'look', command: 'report' },
        ],
        { truncated: true },
      );
      return {
        ...empty,
        visits: [yesterday, older],
        transcripts: { vis_demo_fix: FAKE_REMOTE_HELP_TRANSCRIPT },
      };
    }
  }
}

export interface DemoRemoteHelpOptions {
  me: { name: string };
  state?: RemoteHelpDemoState;
  /** The clock (epoch ms; default `Date.now`): real time, as the shared helpers count “until” with it. */
  now?: () => number;
  /** Support connects this long after remote help is turned on; null: never. */
  visitAfterMs?: number | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface DemoRemoteHelp {
  /** `remoteHelp.*` for the demo's viewer. */
  api: RemoteHelpApi;
  /** The demo's authenticator: signs the challenge it is given, a moment later. */
  platform: PasskeyPlatform;
  /** The demo phone's key. */
  endpoint: string;
  /** Support's side (`visit`, `step`, `leave`). */
  support(): FakeRemoteHelp;
  /** Start over in a state. */
  reset(state: RemoteHelpDemoState): void;
  /** After a change on support's side (someone connected): the screen reads again. */
  onChange(listener: () => void): () => void;
}

export function createDemoRemoteHelp(options: DemoRemoteHelpOptions): DemoRemoteHelp {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const visitAfterMs = options.visitAfterMs === undefined ? 5_000 : options.visitAfterMs;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of [...listeners]) l();
  };
  let fake!: FakeRemoteHelp;
  let caller!: FakeRemoteHelpCaller;
  let timer: unknown = null;
  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const reset = (state: RemoteHelpDemoState) => {
    stopTimer();
    fake = createFakeRemoteHelp({ now, initial: remoteHelpDemoSeed(state, now()) });
    caller = {
      accountId: REMOTE_HELP_DEMO_ACCOUNT,
      name: options.me.name,
      endpoint: REMOTE_HELP_DEMO_ENDPOINT,
      passkeys: state === 'passkey' || state === 'customer' ? [REMOTE_HELP_DEMO_PASSKEY] : [],
    };
    // On and customer start as you left them: turned on, Support there already.
    if (state === 'on' || state === 'customer') {
      fake.call(
        'remoteHelp.start',
        state === 'on' ? { level: 'fix', duration: 'forever' } : { level: 'look', duration: 'hour' },
        { ...caller, passkeys: [] },
      );
      fake.visit({ who: REMOTE_HELP_DEMO_WHO });
    }
    emit();
  };
  reset(options.state ?? 'off');

  const call = async (op: string, input: unknown = {}) => {
    const r = fake.call(op, input, caller);
    if (r.status >= 300) {
      const e = (r.body as { error: { code: string; message: string; details?: unknown } }).error;
      throw new OperationError(op, r.status, e.code, e.message, e.details);
    }
    return r.body as never;
  };

  const api: RemoteHelpApi = {
    get: () => call('remoteHelp.get'),
    confirmBegin: (choice) => call('remoteHelp.confirmBegin', choice),
    async start(input) {
      const state = await call('remoteHelp.start', input);
      // Support comes a few seconds after you let them in (once per grant).
      if (visitAfterMs !== null && timer === null && fake.snapshot().connected.length === 0)
        timer = setTimer(() => {
          timer = null;
          if (fake.visit({ who: REMOTE_HELP_DEMO_WHO })) emit();
        }, visitAfterMs);
      return state;
    },
    async stop() {
      stopTimer();
      return call('remoteHelp.stop');
    },
    visits: async (input) =>
      ((await call('remoteHelp.visits', input ?? {})) as { visits: RemoteHelpVisit[] }).visits,
    async transcript(visitId) {
      const bytes = fake.transcript(visitId);
      if (!bytes) throw new OperationError('remoteHelp.transcript', 404, 'not_found', 'No command line.');
      return remoteHelpTranscriptOf(visitId, bytes);
    },
    hasPasskey: async () => caller.passkeys.length > 0,
  };

  const text = (v: unknown) => base64urlEncode(new TextEncoder().encode(JSON.stringify(v)));
  const platform: PasskeyPlatform = {
    isAvailable: async () => true,
    supportsConditional: async () => false,
    create: async () => {
      throw new Error('The demo makes no passkeys.');
    },
    get: (requested) =>
      new Promise<PasskeyAssertionJSON>((resolve) => {
        const assertion: PasskeyAssertionJSON = {
          id: REMOTE_HELP_DEMO_PASSKEY,
          rawId: REMOTE_HELP_DEMO_PASSKEY,
          type: 'public-key',
          response: {
            clientDataJSON: text({
              type: 'webauthn.get',
              challenge: requested.challenge,
              origin: 'android:demo',
            }),
            authenticatorData: 'AAAA',
            signature: 'AAAA',
          },
          clientExtensionResults: {},
        };
        // As long as a fingerprint takes.
        setTimer(() => resolve(assertion), 600);
      }),
  };

  return {
    api,
    platform,
    endpoint: REMOTE_HELP_DEMO_ENDPOINT,
    support: () => fake,
    reset,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let demo: DemoRemoteHelp | null = null;

/** The demo world's one remote help, made on first use; it keeps its state while the app runs. */
export function demoRemoteHelp(options: DemoRemoteHelpOptions): DemoRemoteHelp {
  demo ??= createDemoRemoteHelp(options);
  return demo;
}
