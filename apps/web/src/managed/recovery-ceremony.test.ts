/**
 * The recovery ceremony of `@whombat/client/managed` (AP-41; here because it reads the vectors with Node): the statement a kit signs for `recovery.enroll`, checked against the contract's
 * own schema and strict verifier, and the contracts' canonical-JSON and Ed25519 vectors
 * (the bytes a recovery key signs are the statement's canonical JSON). With the kit no longer the only way back
 * (BX-01), the screen sign-in's exchange is checked here against the release's fixed runs too (CT-621).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  checkDownload,
  checkPreview,
  DiagnosticsIntegrityError,
  kitText,
  newRecoveryKit,
  readKitFile,
  recoveryEnrollRequest,
  recoveryErrorKey,
  screenSignInSubmit,
} from '@whombat/client/managed';
import { type ApplianceSession, OperationError } from '@whombat/client/session';
import {
  canonicalJson,
  deriveSeedKeypair,
  hexToBytes,
  utf8ToBytes,
  verifyEd25519Strict,
} from '@whombat/core/audit';
import {
  DiagnosticBundle,
  diagnosticBundleBytes,
  diagnosticBundleProblems,
  RECOVERY_ENROLL_PURPOSE,
  RecoveryStatement,
  recoverySigningBytes,
  verifyRecoveryStatement,
} from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';

// The contracts' conformance vectors, from this repository's contracts/vectors.
const vectors = (name: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/vectors', name), 'utf8'));
const session = vectors('session.json');
const signed = vectors('signed.json');
const cpace = vectors('cpace.json');

const APPLIANCE = '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH';
const ENDPOINT = '12D3KooWNrPX9JcmH7DQVJDVr2AXRBHGLAE2Bowcs2hFgaBStMDa';
const key = deriveSeedKeypair('recovery-test', 'whombat-app');

describe('the contract vectors the signature rests on', () => {
  it('canonical JSON is the contract’s', () => {
    for (const v of signed.canonical as { value: unknown; canonical: string }[])
      expect(canonicalJson(v.value)).toBe(v.canonical);
  });
  it('Ed25519 verification is the contract’s strict one', () => {
    for (const v of signed.ed25519 as {
      publicKey: string;
      message: string;
      signature: string;
      expect: boolean;
    }[])
      expect(
        verifyEd25519Strict(hexToBytes(v.signature), hexToBytes(v.message), hexToBytes(v.publicKey)),
      ).toBe(v.expect);
  });
});

describe('recovery.enroll request', () => {
  const now = new Date('2026-09-25T20:00:00.000Z');
  const request = () =>
    recoveryEnrollRequest({
      secretKeyHex: key.secretKey,
      appliancePeerId: APPLIANCE,
      endpointPeerId: ENDPOINT,
      accountId: 'acc_mara',
      endpoint: { label: 'Chrome on Linux', platform: 'web' },
      now,
      nonce: '00112233445566778899aabbccddeeff',
    });

  it('builds the contract’s statement and signs its canonical JSON with the kit’s key', () => {
    const r = request();
    expect(RecoveryStatement.parse(r.statement)).toEqual({
      purpose: RECOVERY_ENROLL_PURPOSE,
      appliance: APPLIANCE,
      endpoint: ENDPOINT,
      accountId: 'acc_mara',
      issuedAt: '2026-09-25T20:00:00.000Z',
      nonce: '00112233445566778899aabbccddeeff',
    });
    expect(new TextDecoder().decode(recoverySigningBytes(r.statement as never))).toBe(
      `{"accountId":"acc_mara","appliance":"${APPLIANCE}","endpoint":"${ENDPOINT}","issuedAt":"2026-09-25T20:00:00.000Z","nonce":"00112233445566778899aabbccddeeff","purpose":"whombat-recovery-enroll/v1"}`,
    );
    expect(verifyRecoveryStatement(r.statement as never, r.signature, key.publicKey)).toBe(true);
    expect(
      verifyEd25519Strict(
        hexToBytes(r.signature),
        utf8ToBytes(canonicalJson(r.statement)),
        hexToBytes(key.publicKey),
      ),
    ).toBe(true);
    expect(r.endpoint).toEqual({ label: 'Chrome on Linux', platform: 'web' });
  });

  it('binds every field: another account, device or appliance doesn’t verify', () => {
    const r = request();
    for (const change of [{ accountId: 'acc_hugo' }, { endpoint: APPLIANCE }, { appliance: ENDPOINT }])
      expect(
        verifyRecoveryStatement({ ...r.statement, ...change } as never, r.signature, key.publicKey),
      ).toBe(false);
    expect(
      verifyRecoveryStatement(r.statement as never, r.signature, deriveSeedKeypair('other').publicKey),
    ).toBe(false);
  });

  it('uses a fresh nonce each time', () => {
    const a = recoveryEnrollRequest({
      secretKeyHex: key.secretKey,
      appliancePeerId: APPLIANCE,
      endpointPeerId: ENDPOINT,
      accountId: 'acc_mara',
      endpoint: { label: 'x', platform: 'android' },
    });
    const b = recoveryEnrollRequest({
      secretKeyHex: key.secretKey,
      appliancePeerId: APPLIANCE,
      endpointPeerId: ENDPOINT,
      accountId: 'acc_mara',
      endpoint: { label: 'x', platform: 'android' },
    });
    expect(a.statement.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(a.statement.nonce).not.toBe(b.statement.nonce);
  });
});

describe('the saved kit file', () => {
  it('names the owner account and the Whombat’s identity and reads back what recovery needs', () => {
    const kit = newRecoveryKit({
      applianceName: 'Studio',
      device: 'dev_7KQ2M4XD',
      appliancePeerId: APPLIANCE,
    });
    const text = kitText(kit, null, 'acc_mara');
    expect(text).toContain('Owner account: acc_mara');
    expect(text).toContain(`Appliance identity: ${APPLIANCE}`);
    expect(readKitFile(text)).toEqual({
      ok: true,
      kit: {
        secretKeyHex: kit.secretKeyHex,
        device: 'dev_7KQ2M4XD',
        accountId: 'acc_mara',
        appliancePeerId: APPLIANCE,
        version: 3,
      },
    });
    // A kit saved without the owner line: the key, the appliance and its identity, no account.
    expect(readKitFile(kitText(kit))).toMatchObject({
      ok: true,
      kit: { device: 'dev_7KQ2M4XD', accountId: null, appliancePeerId: APPLIANCE },
    });
    expect(readKitFile('hello')).toEqual({ ok: false, reason: 'not_a_kit' });
  });

  it('words the appliance’s refusals', () => {
    const e = (code: string) => new OperationError('recovery.enroll', 403, code, 'x');
    expect(recoveryErrorKey(e('recovery_not_kit_owner'))).toBe('recovery_not_kit_owner');
    expect(recoveryErrorKey(e('recovery_kit_unverified'))).toBe('recovery_kit_unverified');
    expect(recoveryErrorKey(e('something_new'))).toBe('failed');
    expect(recoveryErrorKey(new Error('offline'))).toBe('failed');
  });
});

describe('diagnostic bundles against the contract vectors (CT-52)', () => {
  const vectors = session.diagnosticBundles as {
    name: string;
    bundle: unknown;
    valid: boolean;
    sha256?: string;
  }[];
  it('a valid bundle hashes to the vector, so the preview check accepts it and a changed byte fails', () => {
    const valid = vectors.filter((v) => v.valid && v.sha256);
    expect(valid.length).toBeGreaterThan(0);
    for (const v of valid) {
      const bytes = diagnosticBundleBytes(v.bundle);
      const summary = {
        bundleId: 'dgb_vector01',
        scopes: ['versions' as const],
        createdAt: '2026-10-04T12:00:00Z',
        expiresAt: '2026-10-11T12:00:00Z',
        createdBy: 'acc_owner',
        size: bytes.byteLength,
        sha256: v.sha256 as string,
        downloads: 0,
        lastDownloadedAt: null,
      };
      expect(checkPreview({ summary, bundle: v.bundle }).bundle).not.toBeNull();
      expect(() => checkDownload(summary, bytes)).not.toThrow();
      const changed = bytes.slice();
      changed.set([(changed.at(-2) ?? 0) ^ 1], changed.length - 2);
      expect(() => checkDownload(summary, changed)).toThrow(DiagnosticsIntegrityError);
    }
  });
  it('the structured view parses exactly the valid vectors (the others are shown raw)', () => {
    for (const v of vectors) {
      const ok =
        DiagnosticBundle.safeParse(v.bundle).success &&
        diagnosticBundleProblems(v.bundle as never).length === 0;
      expect([v.name, ok]).toEqual([v.name, v.valid]);
    }
  });
});

describe('the screen sign-in against the release’s fixed runs (BX-03, CT-621)', () => {
  interface Side {
    password: string;
    deviceId: string;
    appliancePeerId: string;
    clientPeerId: string;
    signinId: string;
  }
  const runs = cpace.screenSignIn as {
    name: string;
    client: Side;
    clientRandom: string;
    clientShare: string;
    applianceShare: string;
    clientTags: { client: string; appliance: string };
    applianceTags: { client: string; appliance: string };
    agree: boolean;
  }[];

  /** A box that answers with the run's share and its own tag, without checking the client's (the worst case). */
  const replay = (run: (typeof runs)[number], sent: Record<string, unknown>[]) =>
    ({
      close() {},
      async invoke(op: string, input: Record<string, unknown>) {
        sent.push({ op, ...input });
        if (op === 'enroll.screen.begin')
          return { status: 200, body: { share: run.applianceShare }, requestId: 'r' };
        return {
          status: 200,
          body: {
            accountId: 'acc_mara',
            name: 'Mara',
            owner: true,
            principals: [],
            endpoint: {
              endpointId: 'end_1',
              peerId: run.client.clientPeerId,
              label: 'Chrome',
              platform: 'web',
              accountId: 'acc_mara',
              createdAt: '2026-10-20T12:00:00Z',
              lastSeenAt: null,
              current: true,
              revokedAt: null,
              revocation: 'none',
            },
            authzGeneration: 1,
            confirm: run.applianceTags.appliance,
          },
          requestId: 'r',
        };
      },
    }) as unknown as ApplianceSession;

  it('this app sends the run’s share and tag, and trusts the box only when the run agrees', async () => {
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) {
      const sent: Record<string, unknown>[] = [];
      const random = hexToBytes(run.clientRandom);
      const step = await screenSignInSubmit(
        {
          session: replay(run, sent),
          device: run.client.deviceId,
          appliancePeerId: run.client.appliancePeerId,
          clientPeerId: run.client.clientPeerId,
          endpoint: { label: 'Chrome', platform: 'web' },
          randomBytes: (n) => random.slice(0, n),
        },
        {
          kind: 'letters',
          signinId: run.client.signinId,
          expiresAt: '2026-10-20T12:05:00Z',
          error: null,
        },
        run.client.password,
      );
      expect([run.name, sent[0]?.share]).toEqual([run.name, run.clientShare]);
      expect([run.name, sent[1]?.confirm]).toEqual([run.name, run.clientTags.client]);
      expect([run.name, step.kind]).toEqual([run.name, run.agree ? 'enrolled' : 'stopped']);
    }
  });
});
