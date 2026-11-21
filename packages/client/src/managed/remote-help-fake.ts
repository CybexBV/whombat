/**
 * Remote help without a box (app docs/decisions/remote-help.md AP-4447): the `remoteHelp.*` ops as the runtime and the
 * support service answer them, in memory, for the web's managed fake world, the phone's demo world and tests. It checks
 * what the box checks in the shapes it checks them — Forever only off prod images (RH-03), a passkey
 * assertion bound to the begun choice and this device's key (RH-04; the client data's type and challenge and the
 * credential id, not the signature: the fake trusts the authenticator, a CDP virtual one in the e2e suite) — and keeps
 * the grant, the visits and their command lines. Support's side is driven from outside (`visit`, `step`, `leave`).
 */

import {
  HELP_CODE_LENGTH,
  helpCodeFromBytes,
  REMOTE_HELP_LIMITS,
  remoteHelpDurationSeconds,
} from '@whombat/core/domain';
import { base64urlDecode } from '@whombat/protocol';
import {
  passkeyRemoteHelpChallengeBase64url,
  RemoteHelpConfirmBeginInput,
  type RemoteHelpGrant,
  RemoteHelpStartInput,
  type RemoteHelpState,
  type RemoteHelpStep,
  type RemoteHelpVisit,
  RemoteHelpVisitsInput,
} from '@whombat/protocol/session';

type Environment = 'local' | 'dev' | 'prod';

export interface FakeRemoteHelpSnapshot {
  /** The image's `whombat.environment`: Forever and the help code follow it (RH-03, RH-05). */
  environment: Environment;
  /** A support key is pinned (RH-10); false: “isn’t available on this Whombat yet”. */
  available: boolean;
  grant: (RemoteHelpGrant & { wrongCodes: number }) | null;
  /** Newest first. */
  visits: RemoteHelpVisit[];
  /** Visit id → what its command line showed. */
  transcripts: Record<string, string>;
  /** Visits connected now. */
  connected: string[];
}

/** Who calls (the session's account) and with which device key; their passkeys' credential ids on this Whombat. */
export interface FakeRemoteHelpCaller {
  accountId: string;
  name: string;
  /** The session's PeerId, which the challenge names. */
  endpoint: string;
  passkeys: readonly string[];
}

export interface FakeRemoteHelp {
  /** A `remoteHelp.*` op (not the transcript, an export stream): an HTTP-shaped answer. */
  call(op: string, input: unknown, caller: FakeRemoteHelpCaller): { status: number; body: unknown };
  /** A visit's command line, as the export stream's bytes; null when it has none. */
  transcript(visitId: string): Uint8Array | null;
  snapshot(): FakeRemoteHelpSnapshot;
  /** Support connects (a new certificate, RH-07): a visit with `steps` after its “connected”; its id. */
  visit(input?: { who?: string; steps?: Omit<RemoteHelpStep, 'at'>[]; transcript?: string }): string | null;
  /** One more step in a visit that is connected (the newest by default). */
  step(step: Omit<RemoteHelpStep, 'at'>, visitId?: string): void;
  /** Support leaves (the newest connected visit by default). */
  leave(visitId?: string): void;
  setEnvironment(environment: Environment): void;
  setAvailable(available: boolean): void;
}

/** What a visit by Claude looks like in demos and tests: Look commands, a restart and a command line (Fix). */
export const FAKE_REMOTE_HELP_STEPS: Omit<RemoteHelpStep, 'at'>[] = [
  { kind: 'look', command: 'status' },
  { kind: 'look', command: 'logs', units: ['whombat-voice.service'] },
  { kind: 'restart', units: ['whombat-voice.service'] },
  { kind: 'shell', seconds: 372 },
  { kind: 'exec', line: 'systemctl status whombat-voice' },
];

export const FAKE_REMOTE_HELP_TRANSCRIPT = [
  '\u001b[1;32mroot@whombat\u001b[0m:~# journalctl -u whombat-voice -n 3',
  'Oct 21 14:03:12 whombat whombat-voice[912]: model loaded (kokoro, 82M)',
  'Oct 21 14:03:40 whombat whombat-voice[912]: audio device busy, retrying',
  'Oct 21 14:04:02 whombat whombat-voice[912]: audio device busy, giving up',
  'root@whombat:~# systemctl restart whombat-voice',
  'root@whombat:~# exit',
  '',
].join('\r\n');

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function json(status: number, body: unknown) {
  return { status, body };
}

/**
 * A refusal: the reason (`forever_not_allowed`, …) is the error's code, which the fake appliance carries in
 * `details.code` as the runtime does (AP-19); the protocol's code follows the status.
 */
function refuse(status: number, code: string, message: string, reason?: string) {
  return json(status, {
    error: { code: reason ?? code, message, ...(reason && { details: { code: reason } }) },
  });
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function helpCode(): string {
  return helpCodeFromBytes(globalThis.crypto.getRandomValues(new Uint8Array(HELP_CODE_LENGTH)));
}

/** `clientDataJSON` as a verifier reads it; null when it isn't one. */
function clientData(b64: unknown): { type: string; challenge: string } | null {
  if (typeof b64 !== 'string') return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(base64urlDecode(b64))) as Record<string, unknown>;
    return typeof v.type === 'string' && typeof v.challenge === 'string'
      ? { type: v.type, challenge: v.challenge }
      : null;
  } catch {
    return null;
  }
}

export const EMPTY_REMOTE_HELP: FakeRemoteHelpSnapshot = {
  environment: 'local',
  available: true,
  grant: null,
  visits: [],
  transcripts: {},
  connected: [],
};

export function createFakeRemoteHelp(
  options: {
    initial?: FakeRemoteHelpSnapshot | null;
    now?: () => number;
    /** The WebAuthn RP ID the Whombat names in its options (the hosted UI's host; `localhost` by default). */
    rpId?: () => string;
    /** Called after every change (the world saves). */
    onChange?: (snapshot: FakeRemoteHelpSnapshot) => void;
  } = {},
): FakeRemoteHelp {
  const now = options.now ?? Date.now;
  const s: FakeRemoteHelpSnapshot = structuredClone(options.initial ?? EMPTY_REMOTE_HELP);
  /** Endpoint → the begun confirmation (single use, 300 s). */
  const begun = new Map<string, { nonce: string; level: string; duration: string; at: number }>();
  const changed = () => options.onChange?.(structuredClone(s));

  /** A visit that is still open, by id. */
  const open = (id: string) => s.visits.find((v) => v.id === id && v.endedAt === null) ?? null;

  function end(visitId: string) {
    const v = open(visitId);
    if (!v) return;
    const at = iso(now());
    v.steps = [...v.steps, { at, kind: 'left' as const }].slice(-REMOTE_HELP_LIMITS.stepsShown);
    v.endedAt = at;
    s.connected = s.connected.filter((c) => c !== visitId);
  }

  /** The grant runs out (RH-01: off after every expiry); its connections close. */
  function expire() {
    if (s.grant?.until && Date.parse(s.grant.until) <= now()) {
      s.grant = null;
      for (const id of [...s.connected]) end(id);
      changed();
    }
  }

  function state(): RemoteHelpState {
    expire();
    const { wrongCodes: _w, ...grant } = s.grant ?? { wrongCodes: 0 };
    return {
      available: s.available,
      foreverAllowed: s.environment !== 'prod',
      helpCodeRequired: s.environment === 'prod',
      grant: s.grant ? (grant as RemoteHelpGrant) : null,
      connected: s.connected.flatMap((id) => {
        const v = open(id);
        return v ? [{ visitId: v.id, who: v.who, since: v.startedAt }] : [];
      }),
    };
  }

  function start(input: unknown, caller: FakeRemoteHelpCaller) {
    const parsed = RemoteHelpStartInput.safeParse(input);
    if (!parsed.success) return refuse(400, 'bad_request', 'Not a remote help choice.');
    const { level, duration, passkey } = parsed.data;
    if (!s.available)
      return refuse(409, 'conflict', 'Remote help isn’t available.', 'remote_help_unavailable');
    if (duration === 'forever' && s.environment === 'prod')
      return refuse(403, 'not_allowed', 'Forever is only for test Whombats.', 'forever_not_allowed');
    if (caller.passkeys.length > 0) {
      if (!passkey) return refuse(403, 'forbidden', 'Confirm with your passkey.', 'passkey_required');
      const b = begun.get(caller.endpoint);
      begun.delete(caller.endpoint);
      const data = clientData(passkey.response.clientDataJSON);
      const failed = () => refuse(403, 'forbidden', 'The passkey didn’t confirm it.', 'passkey_failed');
      if (!b || now() - b.at > 300_000 || b.level !== level || b.duration !== duration) return failed();
      if (data?.type !== 'webauthn.get' || !caller.passkeys.includes(passkey.id)) return failed();
      const expected = passkeyRemoteHelpChallengeBase64url({
        nonce: b.nonce,
        endpoint: caller.endpoint,
        level,
        duration,
      });
      if (data.challenge !== expected) return failed();
    }
    const t = now();
    s.grant = {
      level,
      since: s.grant?.since ?? iso(t),
      until: duration === 'forever' ? null : iso(t + (remoteHelpDurationSeconds(duration) ?? 0) * 1000),
      grantedBy: { accountId: caller.accountId, name: caller.name },
      helpCode: s.environment === 'prod' ? (s.grant?.helpCode ?? helpCode()) : null,
      wrongCodes: s.grant?.wrongCodes ?? 0,
    };
    // A lower level closes what it no longer allows (RH-05): here, every connection.
    if (level === 'look') for (const id of [...s.connected]) end(id);
    changed();
    return json(200, state());
  }

  return {
    call(op, input, caller) {
      switch (op) {
        case 'remoteHelp.get':
          return json(200, state());
        case 'remoteHelp.confirmBegin': {
          const parsed = RemoteHelpConfirmBeginInput.safeParse(input);
          if (!parsed.success) return refuse(400, 'bad_request', 'Not a remote help choice.');
          if (caller.passkeys.length === 0) return json(200, { nonce: null, options: null });
          const nonce = randomHex(32);
          begun.set(caller.endpoint, { nonce, ...parsed.data, at: now() });
          return json(200, {
            nonce,
            options: {
              challenge: passkeyRemoteHelpChallengeBase64url({
                nonce,
                endpoint: caller.endpoint,
                ...parsed.data,
              }),
              timeout: 60_000,
              rpId: options.rpId?.() ?? 'localhost',
              allowCredentials: caller.passkeys.map((id) => ({ id, type: 'public-key' })),
              userVerification: 'required',
            },
          });
        }
        case 'remoteHelp.start':
          return start(input, caller);
        case 'remoteHelp.stop':
          if (s.grant) {
            s.grant = null;
            for (const id of [...s.connected]) end(id);
            changed();
          }
          return json(200, state());
        case 'remoteHelp.visits': {
          const parsed = RemoteHelpVisitsInput.safeParse(input ?? {});
          if (!parsed.success) return refuse(400, 'bad_request', 'Bad paging.');
          expire();
          const from = parsed.data.before ? s.visits.findIndex((v) => v.id === parsed.data.before) + 1 : 0;
          return json(200, { visits: s.visits.slice(from, from + (parsed.data.limit ?? 20)) });
        }
        default:
          return refuse(404, 'unknown_op', `Unknown ${op}`);
      }
    },
    transcript(visitId) {
      const text = s.transcripts[visitId];
      return text === undefined ? null : new TextEncoder().encode(text);
    },
    snapshot: () => structuredClone(s),
    visit(input = {}) {
      expire();
      if (!s.grant || s.connected.length >= 8) return null;
      // The visit began a few minutes ago: one step a minute, the newest now.
      const t = now() - (input.steps ?? FAKE_REMOTE_HELP_STEPS).length * 60_000;
      const id = `vis_${randomHex(6)}`;
      const level = s.grant.level;
      const asked = input.steps ?? FAKE_REMOTE_HELP_STEPS;
      // Look can't restart or run anything (RH-02): those come out as refusals.
      const steps: RemoteHelpStep[] = [
        { at: iso(t), kind: 'connected' },
        ...asked.map((step, i) => ({
          ...(level === 'look' && step.kind !== 'look' && step.kind !== 'refused'
            ? { kind: 'refused' as const, reason: 'level' as const }
            : step),
          at: iso(t + (i + 1) * 60_000),
        })),
      ];
      s.visits = [
        {
          id,
          who: (input.who ?? 'Support').slice(0, REMOTE_HELP_LIMITS.nameChars),
          level,
          startedAt: iso(t),
          endedAt: null,
          steps: steps.slice(-REMOTE_HELP_LIMITS.stepsShown),
          truncated: steps.length > REMOTE_HELP_LIMITS.stepsShown,
          transcriptBytes: 0,
        },
        ...s.visits,
      ];
      const transcript = level === 'fix' ? (input.transcript ?? FAKE_REMOTE_HELP_TRANSCRIPT) : '';
      if (transcript) {
        s.transcripts[id] = transcript;
        (s.visits[0] as RemoteHelpVisit).transcriptBytes = new TextEncoder().encode(transcript).byteLength;
      }
      s.connected = [...s.connected, id];
      changed();
      return id;
    },
    step(step, visitId) {
      const v = open(visitId ?? s.connected.at(-1) ?? '');
      if (!v) return;
      v.steps = [...v.steps, { ...step, at: iso(now()) }].slice(-REMOTE_HELP_LIMITS.stepsShown);
      changed();
    },
    leave(visitId) {
      const id = visitId ?? s.connected.at(-1);
      if (!id) return;
      end(id);
      changed();
    },
    setEnvironment(environment) {
      s.environment = environment;
      if (environment === 'prod' && s.grant?.until === null) {
        s.grant = null;
        for (const id of [...s.connected]) end(id);
      }
      changed();
    },
    setAvailable(available) {
      s.available = available;
      changed();
    },
  };
}
