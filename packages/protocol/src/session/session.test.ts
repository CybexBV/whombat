import { deriveSeedKeypair } from '@whombat/core/audit';
import { GATEWAY_REFUSAL_CODES } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { utf8Encode } from '../bytes.js';
import { BACKUP_RECOVERY_MATERIAL_KIND, BackupRecoveryMaterial, Rfc3339 } from './backup.js';
import {
  decodeApplianceMessage,
  decodeClientMessage,
  encodeSessionMessage,
  parseRealtimeEvent,
} from './codec.js';
import { type CommandState, nextCommandState, requestDigest } from './commands.js';
import { normalizeClaimSecret, signRecoveryStatement, verifyRecoveryStatement } from './enrollment.js';
import { APP_ERROR_CODES, whoMustUpdate } from './errors.js';
import type { EventMessage, Hello } from './messages.js';
import {
  API_OPERATIONS,
  createOperationAllowlist,
  type OperationSpec,
  receiptDigest,
  SESSION_EXCLUDED_API_OPS,
  SESSION_OPERATIONS,
} from './operations.js';
import {
  ACCOUNT_PAGES_MINOR,
  BACKGROUND_MODEL_MINOR,
  DISK_USAGE_MINOR,
  FIND_MY_MINOR,
  FIND_MY_TIMELINE_MINOR,
  LOCALE_MINOR,
  negotiateCapabilities,
  negotiateVersion,
  OFFSITE_MINOR,
  ONEPASSWORD_SYNC_MINOR,
  protocolAtLeast,
  SESSION_PROTOCOL,
  T3_REVIEW_MORE_ROUNDS_MINOR,
  VERSION_REFUSAL_COPY,
} from './version.js';

const hello: Hello = {
  t: 'hello',
  versions: [{ major: 3, minor: 3 }],
  capabilities: ['events', 'stream.upload', 'future.thing'],
  client: { build: 'web 2026.09.25', platform: 'web' },
};

describe('session codec', () => {
  it('round-trips client and appliance messages', () => {
    const bytes = encodeSessionMessage(hello);
    expect(decodeClientMessage(bytes)).toEqual({ ok: true, message: hello });
    const result = { t: 'result', id: 'req_0123456789abcdef', kind: 'ok', output: { ok: true } } as const;
    expect(decodeApplianceMessage(encodeSessionMessage(result))).toEqual({ ok: true, message: result });
    const ping = { t: 'ping', n: 3 } as const;
    expect(decodeClientMessage(encodeSessionMessage(ping)).ok).toBe(true);
    expect(decodeApplianceMessage(encodeSessionMessage(ping)).ok).toBe(true);
  });

  it('skips unknown message types and rejects invalid ones', () => {
    expect(decodeClientMessage(utf8Encode('{"t":"teleport","x":1}'))).toEqual({
      ok: false,
      kind: 'unknown_type',
      t: 'teleport',
    });
    expect(decodeClientMessage(utf8Encode('{"t":"welcome"}'))).toMatchObject({ kind: 'unknown_type' });
    expect(decodeClientMessage(utf8Encode('[1]'))).toMatchObject({ kind: 'invalid' });
    expect(decodeClientMessage(new Uint8Array([0xff]))).toMatchObject({ kind: 'invalid' });
    // Forward compatibility (CT-14): unknown members of a newer minor are stripped, not rejected.
    expect(
      decodeClientMessage(
        utf8Encode(JSON.stringify({ ...hello, extra: 1, client: { ...hello.client, os: 'x' } })),
      ),
    ).toEqual({ ok: true, message: hello });
    const request = { t: 'request', id: 'short', op: 'burrows.list', input: {}, deadlineMs: 5000 };
    expect(decodeClientMessage(utf8Encode(JSON.stringify(request)))).toMatchObject({ kind: 'invalid' });
    expect(() => encodeSessionMessage({ ...hello, versions: [] })).toThrowError(/invalid hello/);
  });

  it('bounds control messages at 64 KiB', () => {
    const big = { t: 'result', id: 'req_0123456789abcdef', kind: 'ok', output: 'x'.repeat(70_000) } as const;
    expect(() => encodeSessionMessage(big)).toThrowError(/exceeds/);
  });

  it('types realtime events and skips unknown ones', () => {
    const base = {
      t: 'event',
      ephemeral: false,
      sub: 's1',
      cursor: '1:42',
      topic: 'conv:cnv_general',
    } as const;
    const known: EventMessage = {
      ...base,
      event: { type: 'message.deleted', conversationId: 'cnv_general', messageId: 'msg_1' },
    };
    expect(parseRealtimeEvent(known)?.type).toBe('message.deleted');
    expect(parseRealtimeEvent({ ...base, event: { type: 'future.event' } })).toBeNull();
  });
});

describe('version negotiation', () => {
  it('speaks one major: the box’s, at the lower minor, or nothing (CT-1260, CT-1432, CT-1540, report trackers)', () => {
    expect(SESSION_PROTOCOL).toEqual({ major: 5, minor: OFFSITE_MINOR });
    expect(T3_REVIEW_MORE_ROUNDS_MINOR).toBe(20);
    expect(LOCALE_MINOR).toBe(21);
    expect(OFFSITE_MINOR).toBe(22);
    expect(negotiateVersion([{ major: 5, minor: 99 }])).toEqual({ major: 5, minor: SESSION_PROTOCOL.minor });
    // An app from before a minor's additions talks at its own.
    expect(negotiateVersion([{ major: 5, minor: 0 }])).toEqual({ major: 5, minor: 0 });
    expect(negotiateVersion([{ major: 5, minor: 3 }], { major: 5, minor: 1 })).toEqual({
      major: 5,
      minor: 1,
    });
    // An app of contracts 3.x speaks major 4, of 2.x major 3: refused, and told to update.
    expect(negotiateVersion([{ major: 4, minor: 11 }])).toBeNull();
    expect(negotiateVersion([{ major: 3, minor: 0 }])).toBeNull();
    expect(negotiateVersion([{ major: 6, minor: 0 }])).toBeNull();
    const details = { supported: { min: 5, max: 5 }, appliance: { major: 5, minor: 0 } };
    expect(whoMustUpdate([4], details)).toBe('client');
    expect(whoMustUpdate([6], details)).toBe('appliance');
    expect(Object.keys(VERSION_REFUSAL_COPY)).toEqual(['client', 'appliance']);
  });

  it('intersects capabilities', () => {
    expect(negotiateCapabilities(['events', 'stream.upload', 'enroll'], hello.capabilities)).toEqual([
      'events',
      'stream.upload',
    ]);
  });

  it('checks negotiated minor thresholds for additive features', () => {
    expect(BACKGROUND_MODEL_MINOR).toBe(3);
    expect(DISK_USAGE_MINOR).toBe(3);
    expect(FIND_MY_MINOR).toBe(4);
    expect(protocolAtLeast({ major: 5, minor: 3 }, FIND_MY_MINOR)).toBe(false);
    expect(FIND_MY_TIMELINE_MINOR).toBe(5);
    expect(protocolAtLeast({ major: 5, minor: 4 }, FIND_MY_TIMELINE_MINOR)).toBe(false);
    expect(protocolAtLeast({ major: 5, minor: 5 }, FIND_MY_TIMELINE_MINOR)).toBe(true);
    expect(ACCOUNT_PAGES_MINOR).toBe(7);
    expect(protocolAtLeast({ major: 5, minor: 6 }, ACCOUNT_PAGES_MINOR)).toBe(false);
    expect(ONEPASSWORD_SYNC_MINOR).toBe(8);
    expect(protocolAtLeast({ major: 5, minor: 7 }, ONEPASSWORD_SYNC_MINOR)).toBe(false);
    expect(protocolAtLeast({ major: 5, minor: 8 }, ONEPASSWORD_SYNC_MINOR)).toBe(true);
    expect(protocolAtLeast(null, 3)).toBe(false);
    expect(protocolAtLeast(undefined, 3)).toBe(false);
    expect(protocolAtLeast({ major: 5, minor: 2 }, 3)).toBe(false);
    expect(protocolAtLeast({ major: 5, minor: 3 }, 3)).toBe(true);
    expect(protocolAtLeast({ major: 5, minor: 4 }, 3)).toBe(true);
    expect(protocolAtLeast({ major: 6, minor: 0 }, 3)).toBe(true);
    expect(protocolAtLeast({ major: 4, minor: 11 }, 3)).toBe(false);
  });
});

describe('durable commands', () => {
  it('walks the happy path and the ambiguous path', () => {
    let s: CommandState = 'draft';
    for (const [event, want] of [
      [{ type: 'send' }, 'pending_delivery'],
      [{ type: 'accepted' }, 'accepted'],
      [{ type: 'connection_lost' }, 'accepted'],
      [{ type: 'executing' }, 'executing'],
      [{ type: 'result' }, 'completed'],
      [{ type: 'error' }, 'completed'],
    ] as const) {
      s = nextCommandState(s, event);
      expect(s).toBe(want);
    }
    let a: CommandState = nextCommandState('draft', { type: 'send' });
    a = nextCommandState(a, { type: 'connection_lost' });
    expect(a).toBe('unknown');
    a = nextCommandState(a, { type: 'outcome', receipt: 'not_found' });
    expect(a).toBe('unknown');
    a = nextCommandState(a, { type: 'send' });
    expect(a).toBe('pending_delivery');
    expect(nextCommandState('unknown', { type: 'outcome', receipt: 'completed' })).toBe('completed');
    expect(nextCommandState('unknown', { type: 'outcome', receipt: 'accepted' })).toBe('accepted');
    expect(nextCommandState('rejected', { type: 'send' })).toBe('rejected');
  });

  it('digests op and input canonically', () => {
    const d = requestDigest('messages.send', { params: { burrow: 'x' }, body: { b: 1, a: [1, 'é'] } });
    expect(d).toBe(requestDigest('messages.send', { body: { a: [1, 'é'], b: 1 }, params: { burrow: 'x' } }));
    expect(d).not.toBe(
      requestDigest('messages.edit', { params: { burrow: 'x' }, body: { b: 1, a: [1, 'é'] } }),
    );
    // sha256('{"input":{"a":1},"op":"x.y"}')
    expect(requestDigest('x.y', { a: 1 })).toBe(
      '924070710be2a365a4604d28401bcf27bd2254f378bd51ce8fd51dcff99cbbc5',
    );
  });
});

describe('operation allowlist', () => {
  it('takes every api op, the box’s own Web Push key too (1.1, CT-1307)', () => {
    const allow = createOperationAllowlist();
    expect(SESSION_EXCLUDED_API_OPS).toEqual([]);
    expect(allow.has('devices.vapidKey')).toBe(true);
    expect(allow.has('messages.send')).toBe(true);
    expect(allow.ops.length).toBe(
      API_OPERATIONS.size - SESSION_EXCLUDED_API_OPS.length + SESSION_OPERATIONS.size,
    );
  });

  it('confines unenrolled endpoints to enrollment and recovery', () => {
    const allow = createOperationAllowlist();
    expect(allow.resolve('messages.send', { enrolled: false })).toEqual({
      ok: false,
      code: 'enrollment_required',
    });
    expect(allow.resolve('enroll.claim', { enrolled: false }).ok).toBe(true);
    expect(allow.resolve('enroll.claim.begin', { enrolled: false }).ok).toBe(true);
    expect(allow.resolve('recovery.enroll', { enrolled: false }).ok).toBe(true);
    expect(allow.resolve('enroll.pair.approve', { enrolled: false }).ok).toBe(false);
    expect(allow.resolve('nope.nope', { enrolled: true })).toEqual({ ok: false, code: 'unknown_op' });
    const enrollOnly = [...SESSION_OPERATIONS.values()]
      .filter((s) => s.channel === 'enroll')
      .map((s) => s.op);
    expect(enrollOnly.sort()).toEqual([
      'boxPasskey.enroll',
      'boxPasskey.enroll.begin',
      'enroll.claim',
      'enroll.claim.begin',
      'enroll.claim.local',
      'enroll.claim.local.begin',
      'enroll.claim.local.prove',
      'enroll.claim.local.start',
      'enroll.dev',
      'enroll.display.request',
      'enroll.display.status',
      'enroll.link.accept',
      'enroll.pair.request',
      'enroll.pair.status',
      'enroll.passkey',
      'enroll.screen',
      'enroll.screen.begin',
      'enroll.screen.request',
      'recovery.enroll',
    ]);
  });

  it('opens a screen’s endpoint only to the screen channel, and that channel to nobody else', () => {
    const allow = createOperationAllowlist();
    expect(allow.resolve('screen.state', { enrolled: true, screen: true }).ok).toBe(true);
    expect(allow.resolve('screen.image', { enrolled: true, screen: true }).ok).toBe(true);
    for (const op of ['desk.get', 'messages.send', 'desk.screens', 'enroll.claim', 'endpoints.list'])
      expect(allow.resolve(op, { enrolled: true, screen: true }), op).toEqual({
        ok: false,
        code: 'unknown_op',
      });
    expect(allow.resolve('screen.state', { enrolled: true })).toEqual({ ok: false, code: 'unknown_op' });
    expect(allow.resolve('screen.state', { enrolled: false })).toEqual({ ok: false, code: 'unknown_op' });
    expect(allow.resolve('enroll.display.request', { enrolled: false }).ok).toBe(true);
    const screenOnly = [...SESSION_OPERATIONS.values()]
      .filter((s) => s.channel === 'screen')
      .map((s) => s.op);
    expect(screenOnly.sort()).toEqual(['screen.image', 'screen.lock', 'screen.state', 'screen.unlock']);
  });

  it('narrows with only/exclude and refuses unknown names', () => {
    const allow = createOperationAllowlist({
      only: ['burrows.create', 'burrows.get'],
      exclude: ['endpoints.revoke'],
    });
    expect(allow.has('burrows.get')).toBe(true);
    expect(allow.has('messages.send')).toBe(false);
    expect(allow.has('endpoints.revoke')).toBe(false);
    expect(allow.has('enroll.claim')).toBe(true);
    expect(() => createOperationAllowlist({ only: ['burrows.gte'] })).toThrowError(/unknown operation/);
  });
});

describe('recovery statements', () => {
  it('rotates only with the current key’s signature', () => {
    const current = deriveSeedKeypair('recovery-current');
    const next = deriveSeedKeypair('recovery-next');
    const rotation = {
      purpose: 'whombat-recovery-rotate/1' as const,
      appliance: '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH',
      newRecoveryPublicKey: next.publicKey,
    };
    const sig = signRecoveryStatement(rotation, current.secretKey);
    expect(verifyRecoveryStatement(rotation, sig, current.publicKey)).toBe(true);
    expect(
      verifyRecoveryStatement(rotation, signRecoveryStatement(rotation, next.secretKey), current.publicKey),
    ).toBe(false);
    expect(
      verifyRecoveryStatement(
        { ...rotation, newRecoveryPublicKey: current.publicKey },
        sig,
        current.publicKey,
      ),
    ).toBe(false);
  });

  it('normalizes claim secrets from the card', () => {
    expect(normalizeClaimSecret('abcd-efgh ijkl-mnop qrst-uvwx yz')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  });
});

describe('provider sign-ins (CT-70, CT-71)', () => {
  const allow = createOperationAllowlist();

  it('keeps the console’s input and output secret, and reads it as a query', () => {
    for (const op of ['signins.consoleRead', 'signins.consoleWrite'])
      expect(allow.get(op)?.secret, op).toBe(true);
    expect(allow.get('signins.consoleRead')?.mutating).toBe(false);
    expect(allow.get('signins.consoleWrite')?.mutating).toBe(true);
    expect(allow.get('signins.consoleStart')?.secret).toBe(false);
  });
});

describe('guides and the managed Google connect (CT-81)', () => {
  it('are secret, mutating api ops over the session', () => {
    const allow = createOperationAllowlist();
    for (const op of ['guides.act', 'connections.finishGoogle']) {
      const spec = allow.get(op);
      expect(spec?.source, op).toBe('api');
      expect(spec?.mutating, op).toBe(true);
      expect(spec?.secret, op).toBe(true);
    }
    const act = allow.get('guides.act');
    expect(
      act?.input.safeParse({
        params: { burrow: 'garden', messageId: 'msg_01' },
        body: { actionId: 'client', values: { clientSecret: 'GOCSPX-abcdefgh' } },
      }).success,
    ).toBe(true);
    const finish = allow.get('connections.finishGoogle');
    expect(finish?.input.safeParse({ body: { code: '4/0AbCd', state: 'oas_12345678' } }).success).toBe(true);
    expect(receiptDigest(finish as OperationSpec, { body: { code: 'a', state: 'b' } })).toBe(
      receiptDigest(finish as OperationSpec, { body: { code: 'c', state: 'd' } }),
    );
  });

  it('know the guide refusals as app codes', () => {
    for (const code of ['guide_closed', 'not_yours', 'invalid_values', 'google_unavailable'])
      expect(APP_ERROR_CODES, code).toHaveProperty(code);
  });

  it('know the AI gateway’s refusals as app codes (0.76, CT-332)', () => {
    for (const code of GATEWAY_REFUSAL_CODES) expect(APP_ERROR_CODES, code).toHaveProperty(code);
  });
});

describe('backup recovery material (CT-145)', () => {
  const material = {
    kind: BACKUP_RECOVERY_MATERIAL_KIND,
    applianceId: 'wb-5hr8-v6nc-2d71',
    generation: 2,
    createdAt: '2026-09-28T18:00:00Z',
    repository: 's3:https://s3.example.com/wb-backups/box-1',
    repositoryPassword: 'correct horse battery staple',
    repositoryId: 'a1b2c3d4',
    manifestKey: 'ed25519:AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
  };

  it('carries the newest checkpoint as Go writes it, and works without it', () => {
    expect(BackupRecoveryMaterial.safeParse(material).success).toBe(true);
    const head = { seq: 3, manifestSha256: 'ab'.repeat(32), at: '2026-09-28T18:50:14.123456789Z' };
    expect(BackupRecoveryMaterial.parse({ ...material, head }).head).toEqual(head);
    expect(
      BackupRecoveryMaterial.safeParse({ ...material, head: { ...head, manifestSha256: 'AB'.repeat(32) } })
        .success,
    ).toBe(false);
    expect(BackupRecoveryMaterial.safeParse({ ...material, head: { ...head, seq: -1 } }).success).toBe(false);
  });

  it('reads RFC 3339 times with up to nine fractional digits (Go’s RFC3339Nano)', () => {
    for (const t of [
      '2026-09-28T18:50:14Z',
      '2026-09-28T18:50:14.1Z',
      '2026-09-28T18:50:14.123456789Z',
      '2026-09-28T20:50:14.123456789+02:00',
    ])
      expect(Rfc3339.safeParse(t).success, t).toBe(true);
    for (const t of ['2026-09-28T18:50:14.1234567891Z', '2026-09-28T18:50:14.Z', '2026-09-28 18:50:14Z'])
      expect(Rfc3339.safeParse(t).success, t).toBe(false);
  });
});
