import * as nodeCrypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DeviceRegistration,
  verifyDeviceRequest,
  verifyRegistration,
} from '@whombat/control-contracts/device';
import {
  ClaimLookupLeaseRequest,
  CONSOLE_DISPLAY_TEXT_RE,
  ConsoleDisplayText,
  ConsoleState,
  claimLookupLeaseValid,
  consoleDisplayUrl,
  consoleStateValid,
  DESK_TEXT_RES,
  DeskState,
  DeskTalkRequest,
  DeskTalkSession,
  deskStateValid,
  deskTalkRequestValid,
  deskTalkSessionValid,
  deskTextSchema,
  revocationRef,
  SupportEvent,
  SupportState,
  summarizeBackup,
  supportEventValid,
  supportStateValid,
} from '@whombat/control-contracts/local';
import { canonicalJson, hexToBytes, sha256Hex, verifyEd25519Strict } from '@whombat/core/audit';
import {
  BackupFileEncoder,
  BackupFileReader,
  backupChunkIetfNonce,
  backupChunkSubkey,
  backupPasswordBytes,
  createBackupFileKeys,
  isBackupFileError,
  nobleBackupKdf,
  TarReader,
} from '@whombat/core/backup';
import {
  formatHelpCode,
  HELP_CODE_RE,
  helpCodeFromBytes,
  normalizeHelpCode,
  remoteHelpDurationSeconds,
  remoteHelpWho,
} from '@whombat/core/domain';
import {
  deriveKeyPair,
  dropKeyId,
  FeedbackDropError,
  feedbackReferenceFor,
  hpkeContextOpen,
  hpkeContextSeal,
  hpkeExport,
  hpkeSetupBaseR,
  hpkeSetupBaseS,
  openDropEnvelope,
  padLength,
  sealDropEnvelope,
  siteKeyFingerprint,
  verifySiteCard,
} from '@whombat/core/feedback/drop';
import {
  ADMISSION_ERROR_CLOSE,
  type AdmissionJwks,
  appErrorCode,
  BackupScope,
  CollabMessageDecoder,
  claimConfirmEqual,
  claimPakeCi,
  claimPakeInitiator,
  claimPakeInitiatorFinish,
  claimPakeResponder,
  claimSecretHash,
  claimVerifier,
  collabDataPayloads,
  cpaceGenerator,
  cpaceGeneratorString,
  cpaceInitiatorFinish,
  cpaceInitiatorStart,
  cpaceIsk,
  cpaceLvCat,
  cpacePrependLen,
  cpaceResponderRespond,
  cpaceScalarMultVfy,
  cpaceTranscriptIr,
  createOperationAllowlist,
  DiagnosticBundle,
  decodeApplianceMessage,
  decodeClientMessage,
  diagnosticBundleBytes,
  diagnosticBundleProblems,
  encodeCollabMessages,
  encodeFrame,
  type Frame,
  FrameDecoder,
  FrameError,
  formatClaimCode,
  formatScreenSignInLetters,
  generateClaimLetters,
  generateScreenSignInLetters,
  isClaimSecret,
  type LicenceKeySet,
  type LicenceStatusParams,
  LicenceStatusResult,
  licenceStatus,
  localClaimPakeCi,
  localClaimPakeInitiator,
  localClaimPakeInitiatorFinish,
  localClaimPakeResponder,
  normalizeClaimCode,
  normalizeClaimSecret,
  normalizeScreenSignInLetters,
  pairingFingerprint,
  parsePasskeyUserHandle,
  passkeyEnrollChallengeBase64url,
  passkeyRegisterChallengeBase64url,
  passkeyUserHandleBase64url,
  peerIdFromEd25519PublicKey,
  receiptDigest,
  screenSignInPakeCi,
  screenSignInPakeInitiator,
  screenSignInPakeInitiatorFinish,
  screenSignInPakeResponder,
  UnsupportedVersionDetails,
  utf8Encode,
  verifyAdmissionTicket,
  verifyLicenceToken,
  whoMustUpdate,
} from '@whombat/protocol';
import {
  BluetoothPairing,
  BluetoothState,
  bluetoothPairingValid,
  bluetoothSignalFromDbm,
  bluetoothStateValid,
  HOST_TEXT_RES,
  HostNetwork,
  hostNetworkValid,
  hostText,
  hostTextSchema,
  NetworkChange,
  networkChangeValid,
  passkeyRemoteHelpChallengeBase64url,
  RemoteHelpStep,
  RemoteHelpWho,
  remoteHelpStepValid,
  ssidValid,
  wifiSignalFromDbm,
} from '@whombat/protocol/session';
import {
  assignmentKeyMap,
  type ClientBundle,
  checkActivation,
  checkCompatibleActivation,
  checkMigratingActivation,
  clientBelowFloor,
  clientBundleTarget,
  compareVersions,
  protocolOverlap,
  RETRYABLE_UPDATE_FAILURES,
  ReleaseTuple,
  selectClientBundle,
  servesClient,
  tupleDigest,
  updateClass,
  verifyAssignment,
  verifyClientChannel,
} from '@whombat/release';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { backupVectorPlaintext } from './backup-file-vectors.ts';
import { feedbackVectorPlaintext } from './feedback-drop-vectors.ts';
import { generate, ROOT } from './gen-cross-language.ts';
import { REGISTRY, registryEntry } from './registry.ts';
import { checkPattern, checkSubset } from './subset.ts';

const load = (name: string) => JSON.parse(readFileSync(join(ROOT, 'vectors', name), 'utf8'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('cross-language subset', () => {
  it('holds for every registry schema', () => {
    for (const e of REGISTRY) expect(checkSubset(e.schema, e.name), e.name).toEqual([]);
  });

  it('rejects what it must', () => {
    const bad: [z.ZodType, RegExp][] = [
      [z.looseObject({ a: z.string().regex(/^a$/) }), /z.strictObject or z.object/],
      [z.strictObject({ a: z.string() }), /ASCII pattern/],
      [z.strictObject({ a: z.email() }), /format email/],
      [z.strictObject({ a: z.number() }), /non-integer/],
      [z.strictObject({ a: z.number().int() }), /min and max/],
      [z.strictObject({ a: z.number().int().positive().max(3) }), /greater_than|min and max/],
      [z.strictObject({ a: z.array(z.boolean()) }), /maxItems/],
      [
        z.strictObject({
          a: z
            .string()
            .regex(/^a$/)
            .transform((s) => s.length),
        }),
        /unsupported pipe/,
      ],
      [
        z.strictObject({
          a: z
            .string()
            .regex(/^a$/)
            .refine(() => true),
        }),
        /custom/,
      ],
      [z.strictObject({ a: z.string().regex(/^a$/).default('a') }), /unsupported default/],
      [z.strictObject({ a: z.union([z.boolean(), z.strictObject({})]) }), /discriminator/],
      [z.strictObject({ a: z.boolean().nullable().optional() }), /optional of nullable/],
      [z.strictObject({ a: z.record(z.string(), z.boolean()) }), /record values/],
    ];
    for (const [schema, message] of bad) expect(checkSubset(schema).join('\n')).toMatch(message);
    expect(checkPattern(/^[^a]$/)).toBe('negated class');
    expect(checkPattern(/^\s$/)).toMatch(/escape/);
    expect(checkPattern(/^a.b$/)).toBe('unescaped .');
    expect(checkPattern(/^(?=a)a$/)).toMatch(/group/);
    expect(checkPattern(/a/)).toBe('not anchored');
    expect(checkPattern(/^a$/i)).toMatch(/flags/);
    expect(checkPattern(/^é$/)).toMatch(/non-ASCII/);
    expect(checkPattern(/^[\x21-\x7e]+\.x$/)).toBeNull();
    // The one admitted Unicode pattern (CT-116), only as itself and only without .min/.max.
    expect(checkPattern(CONSOLE_DISPLAY_TEXT_RE)).toBeNull();
    expect(checkPattern(new RegExp(CONSOLE_DISPLAY_TEXT_RE.source))).not.toBeNull();
    expect(checkPattern(/^[^\p{Cc}]$/u)).toMatch(/flags/);
    expect(checkSubset(z.strictObject({ a: ConsoleDisplayText })).join('\n')).toBe('');
    expect(checkSubset(z.strictObject({ a: ConsoleDisplayText.max(10) })).join('\n')).toMatch(
      /carries its length/,
    );
    // The desk's display text (CT-529): admitted by name, each at its own length.
    for (const re of DESK_TEXT_RES) expect(checkPattern(re), re.source).toBeNull();
    expect(checkPattern(/^(?:[^\p{Cc}\p{Cf}\p{Cs}\p{Z}]| ){1,41}$/u)).not.toBeNull();
    expect(checkSubset(z.strictObject({ a: deskTextSchema(40) })).join('\n')).toBe('');
    expect(() => deskTextSchema(41)).toThrow();
    // The hardware report's and the network's display text (CT-560): the same form at their own lengths.
    for (const re of HOST_TEXT_RES) expect(checkPattern(re), re.source).toBeNull();
    expect(checkSubset(z.strictObject({ a: hostTextSchema(240) })).join('\n')).toBe('');
    expect(() => hostTextSchema(241)).toThrow();
  });
});

describe('generated artifacts', () => {
  it('schema/ and vectors/ match the contracts (run `pnpm gen`)', async () => {
    for (const [path, text] of await generate()) {
      if (path.endsWith('.go')) continue;
      expect(readFileSync(join(ROOT, path), 'utf8'), path).toBe(text);
    }
  });
});

describe('backup file vectors (CT-335)', () => {
  const v = load('backup-file.json');
  const bytesOf = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));
  const p = v.params;
  const keysFor = (password: string) =>
    createBackupFileKeys(password, {
      params: p.kdf,
      chunkBytes: p.chunkBytes,
      salt: bytesOf(p.salt),
      noncePrefix: bytesOf(p.noncePrefix),
    });
  const open = async (file: Uint8Array, password: string) => {
    const reader = new BackupFileReader();
    const out: Uint8Array[] = [...reader.push(file)];
    out.push(...(await reader.unlock(password)));
    out.push(...reader.finish());
    return new Uint8Array(Buffer.concat(out));
  };

  it('derive keys with Argon2id, @noble/hashes and Node’s native one alike', async () => {
    for (const c of v.kdf) {
      const ikm = await nobleBackupKdf(backupPasswordBytes(c.password), bytesOf(c.salt), c.params);
      expect(hex(ikm), c.name ?? 'small').toBe(c.ikm);
      const native = (nodeCrypto as { argon2Sync?: (a: string, o: object) => Uint8Array }).argon2Sync;
      if (native)
        expect(
          hex(
            native('argon2id', {
              message: backupPasswordBytes(c.password),
              nonce: bytesOf(c.salt),
              parallelism: c.params.parallelism,
              tagLength: 32,
              memory: c.params.memoryKiB,
              passes: c.params.passes,
            }),
          ),
        ).toBe(c.ikm);
    }
  });

  it('seal every file byte for byte, and open it again', async () => {
    const keys = await keysFor(p.password);
    for (const f of v.files) {
      expect(hex(keys.streamKey)).toBe(f.streamKey);
      expect(hex(keys.header.bytes)).toBe(f.header);
      expect(hex(backupChunkSubkey(keys.streamKey, keys.header.noncePrefix))).toBe(f.subkey);
      const enc = new BackupFileEncoder(keys);
      const plain = backupVectorPlaintext(f.plaintextSize);
      expect(hex(new Uint8Array(Buffer.concat([...enc.push(plain), ...enc.finish()]))), f.name).toBe(f.file);
      expect(await open(bytesOf(f.file), p.password), f.name).toEqual(plain);
    }
  });

  it('match Node’s native ChaCha20-Poly1305 under the HChaCha20 subkey', () => {
    const f = v.files[3];
    const file = bytesOf(f.file);
    const chunk = p.chunkBytes + 16;
    const body = file.subarray(110);
    const chunks = Math.ceil(body.length / chunk);
    const plain: Buffer[] = [];
    for (let i = 0; i < chunks; i++) {
      const c = body.subarray(i * chunk, Math.min((i + 1) * chunk, body.length));
      const d = nodeCrypto.createDecipheriv(
        'chacha20-poly1305',
        bytesOf(f.subkey),
        backupChunkIetfNonce(i, i === chunks - 1),
        {
          authTagLength: 16,
        },
      );
      d.setAAD(bytesOf(f.headerHash), { plaintextLength: c.length - 16 });
      d.setAuthTag(c.subarray(c.length - 16));
      plain.push(d.update(c.subarray(0, c.length - 16)), d.final());
    }
    expect(new Uint8Array(Buffer.concat(plain))).toEqual(backupVectorPlaintext(f.plaintextSize));
  });

  it('refuse every altered file with its code', async () => {
    for (const t of v.tampered) {
      let code = 'ok';
      try {
        await open(bytesOf(t.file), t.password);
      } catch (e) {
        code = isBackupFileError(e) ? e.code : String(e);
      }
      expect(code, t.name).toBe(t.expect);
    }
  });

  it('read the tar body', () => {
    const reader = new TarReader();
    const entries = reader
      .push(bytesOf(v.tar.archive))
      .filter((e) => e.type === 'entry')
      .map((e) => (e.type === 'entry' ? e.entry : null));
    reader.finish();
    expect(entries).toEqual(v.tar.entries);
  });
});

describe('feedback drop vectors (CT-91)', () => {
  const v = load('feedback-drop.json');
  const r = v.rfc9180;
  const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

  it('match RFC 9180 A.1.1', async () => {
    expect([r.mode, r.kemId, r.kdfId, r.aeadId]).toEqual([0, 0x20, 1, 1]);
    const e = deriveKeyPair(hexToBytes(r.ikmE));
    const k = deriveKeyPair(hexToBytes(r.ikmR));
    expect([hex(e.privateKey), hex(e.publicKey), hex(k.privateKey), hex(k.publicKey)]).toEqual([
      r.skEm,
      r.pkEm,
      r.skRm,
      r.pkRm,
    ]);
    const s = hpkeSetupBaseS(hexToBytes(r.pkRm), hexToBytes(r.info), hexToBytes(r.ikmE));
    const o = hpkeSetupBaseR(hexToBytes(r.enc), hexToBytes(r.skRm), hexToBytes(r.info));
    expect(hex(s.enc)).toBe(r.enc);
    for (const ctx of [s, o])
      expect([hex(ctx.sharedSecret), hex(ctx.key), hex(ctx.baseNonce), hex(ctx.exporterSecret)]).toEqual([
        r.sharedSecret,
        r.key,
        r.baseNonce,
        r.exporterSecret,
      ]);
    for (const c of r.encryptions) {
      expect(hex(await hpkeContextSeal(s, c.seq, hexToBytes(c.aad), hexToBytes(c.pt)))).toBe(c.ct);
      expect(hex(await hpkeContextOpen(o, c.seq, hexToBytes(c.aad), hexToBytes(c.ct)))).toBe(c.pt);
    }
    for (const x of r.exports) expect(hex(hpkeExport(o, hexToBytes(x.context), x.length))).toBe(x.value);
  });

  const recipient = hexToBytes(v.recipient.privateKey);
  const keyFor = (kid: string) => (kid === v.kid ? recipient : null);

  it('seal to the same bytes and open', async () => {
    expect(dropKeyId(hexToBytes(v.recipient.publicKey))).toBe(v.kid);
    for (const c of v.envelopes) {
      const plaintext = feedbackVectorPlaintext(c.descriptionLength);
      expect(padLength(4 + Buffer.byteLength(plaintext)), c.name).toBe(c.paddedLength);
      const sealed = await sealDropEnvelope(v.card.card, plaintext, hexToBytes(v.ikmE));
      expect([sealed.length, sha256Hex(sealed)], c.name).toEqual([c.length, c.sha256]);
      if (c.envelope) expect(Buffer.from(sealed).toString('base64url')).toBe(c.envelope);
      expect((await openDropEnvelope(sealed, keyFor, { site: v.card.card.site })).plaintextJson).toBe(
        plaintext,
      );
    }
  });

  it('refuse tampered envelopes', async () => {
    for (const c of v.tampered) {
      const got = await openDropEnvelope(b64(c.envelope), keyFor).then(
        () => 'ok',
        (e: unknown) => (e instanceof FeedbackDropError ? e.code : String(e)),
      );
      expect(got, c.name).toBe(c.expect);
    }
  });

  it('verify cards', () => {
    expect(canonicalJson(v.card.card)).toBe(v.cardSigningBytes);
    expect(siteKeyFingerprint(v.card.card.signingKey)).toBe(v.fingerprint);
    for (const c of v.cards) {
      const got = verifySiteCard(c.signed, c.expectedKey);
      expect(got.ok ? 'ok' : got.error, c.name).toBe(c.expect);
    }
  });

  it('derive references and padding', () => {
    for (const c of v.references) expect(feedbackReferenceFor(c.site, c.submissionId)).toBe(c.reference);
    for (const c of v.padLength) expect(padLength(c.n)).toBe(c.padded);
  });
});

describe('schema vectors', () => {
  it('agree with Zod', () => {
    const { cases } = load('schemas.json');
    expect(cases.length).toBeGreaterThan(50);
    for (const c of cases)
      expect(registryEntry(c.schema).schema.safeParse(c.value).success, `${c.schema}/${c.name}`).toBe(
        c.valid,
      );
  });
});

describe('admission vectors', () => {
  it('verify as expected', () => {
    type Case = {
      name: string;
      token: string;
      now: number;
      audience: string;
      issuer?: string;
      role?: 'client' | 'appliance';
      worker?: string;
      expect: string;
      close?: number;
    };
    const { jwks, cases } = load('admission.json') as { jwks: AdmissionJwks; cases: Case[] };
    for (const c of cases) {
      // Default (strict) Ed25519 verification.
      const r = verifyAdmissionTicket(c.token, {
        jwks,
        now: c.now,
        audience: c.audience,
        ...(c.issuer ? { issuer: c.issuer } : {}),
        ...(c.role ? { role: c.role } : {}),
        ...(c.worker ? { worker: c.worker } : {}),
      });
      expect(r.ok ? 'ok' : r.error, c.name).toBe(c.expect);
      if (!r.ok) expect(ADMISSION_ERROR_CLOSE[r.error], c.name).toBe(c.close);
    }
  });
});

describe('licence vectors (CT-76)', () => {
  type Case = {
    name: string;
    token: string;
    device: string;
    now: number;
    keySet?: LicenceKeySet;
    expect: string;
  };
  const v = load('licence.json') as {
    keySet: LicenceKeySet;
    cases: Case[];
    status: { name: string; input: LicenceStatusParams; expect: unknown }[];
  };

  it('verify as expected', () => {
    expect(v.cases.length).toBeGreaterThan(25);
    for (const c of v.cases) {
      const r = verifyLicenceToken(c.token, { keySet: c.keySet ?? v.keySet, device: c.device, now: c.now });
      expect(r.ok ? 'ok' : r.error, c.name).toBe(c.expect);
    }
  });

  it('compute the licence state (LC-09)', () => {
    const reasons = new Set<string>();
    for (const c of v.status) {
      const got = licenceStatus(c.input);
      expect(got, c.name).toEqual(c.expect);
      if (got) {
        expect(LicenceStatusResult.parse(got), c.name).toEqual(got);
        reasons.add(`${got.state}/${got.reason}`);
      }
    }
    // Every branch of LC-09 has a vector.
    expect([...reasons].sort()).toEqual(
      [
        'grace/no_licence',
        'grace/not_renewed',
        'grace/payment',
        'lapsed/cancelled',
        'lapsed/expired',
        'lapsed/no_licence',
        'licensed/active',
        'licensed/past_due',
        'licensed/trial',
      ].sort(),
    );
  });
});

describe('frame vectors', () => {
  const toJson = (f: Frame) =>
    f.type === 'control' || f.type === 'data'
      ? { type: f.type, streamId: f.streamId, payloadHex: hex(f.payload) }
      : f;
  it('decode and re-encode', () => {
    const { cases } = load('frames.json');
    for (const c of cases) {
      const decoder = new FrameDecoder();
      const bytes = Uint8Array.from(Buffer.from(c.hex, 'hex'));
      if (c.error) {
        expect(() => decoder.push(bytes), c.name).toThrowError(FrameError);
        try {
          decoder.push(bytes);
        } catch {}
        try {
          new FrameDecoder().push(bytes);
        } catch (e) {
          expect((e as FrameError).code, c.name).toBe(c.error);
        }
        continue;
      }
      const frames = decoder.push(bytes);
      expect(frames.map(toJson), c.name).toEqual(c.frames);
      expect(decoder.pending, c.name).toBe(c.pending);
      if (c.pending === 0) expect(frames.map((f) => hex(encodeFrame(f))).join(''), c.name).toBe(c.hex);
    }
  });
});

describe('signed-document vectors', () => {
  const v = load('signed.json');

  it('device requests', () => {
    for (const c of v.deviceRequests.cases) {
      const r = verifyDeviceRequest(c.envelope, {
        audience: c.audience ?? v.deviceRequests.audience,
        now: c.now,
        publicKeyOf: (d) => v.deviceRequests.publicKeys[d],
        claimNonce: () => true,
      });
      expect(r.ok ? 'ok' : r.error, c.name).toBe(c.expect);
    }
  });

  it('registrations', () => {
    for (const c of v.registrations)
      expect(verifyRegistration(DeviceRegistration.parse(c.registration)), c.name).toBe(c.expect);
  });

  it('assignments', () => {
    for (const c of v.assignments.cases) {
      const r = verifyAssignment(c.doc, {
        keys: v.assignments.keys,
        env: c.env,
        device: c.device,
        now: c.now,
        lastSequence: c.lastSequence,
      });
      expect(r.ok ? 'ok' : r.error, c.name).toBe(c.expect);
    }
  });

  it('strict Ed25519', () => {
    for (const c of v.ed25519)
      expect(
        verifyEd25519Strict(hexToBytes(c.signature), hexToBytes(c.message), hexToBytes(c.publicKey)),
        c.name,
      ).toBe(c.expect);
  });

  it('PeerIds of Ed25519 keys', () => {
    for (const c of v.peerIds) expect(peerIdFromEd25519PublicKey(hexToBytes(c.publicKey))).toBe(c.peerId);
  });

  it('tuple digest and canonical JSON', () => {
    expect(tupleDigest(v.tupleDigest.tuple)).toBe(v.tupleDigest.digest);
    for (const c of v.canonical) expect(canonicalJson(c.value)).toBe(c.canonical);
  });
});

describe('session vectors (forward compatibility)', () => {
  const v = load('session.json');

  it('strip unknown members, skip unknown types, reject invalid messages', () => {
    for (const c of v.messages) {
      const bytes = utf8Encode(JSON.stringify(c.json));
      const r = c.direction === 'client' ? decodeClientMessage(bytes) : decodeApplianceMessage(bytes);
      expect(r.ok ? 'ok' : r.kind, c.name).toBe(c.expect);
      if (r.ok) expect(r.message, c.name).toEqual(c.output ?? c.json);
    }
  });

  it('diagnostic bundles: allowlisted fields only, hashed as canonical JSON', () => {
    for (const c of v.diagnosticBundles) {
      const parsed = DiagnosticBundle.safeParse(c.bundle);
      const valid = parsed.success && diagnosticBundleProblems(parsed.data).length === 0;
      expect(valid, c.name).toBe(c.valid);
      if (c.valid) expect(sha256Hex(diagnosticBundleBytes(c.bundle)), c.name).toBe(c.sha256);
    }
  });

  it('pairing fingerprints', () => {
    for (const c of v.pairingFingerprints) expect(pairingFingerprint(c.peerId)).toBe(c.fingerprint);
  });

  it('passkey user handles and challenges (PK-01, PK-03)', () => {
    for (const c of v.passkeys.userHandles) {
      expect(passkeyUserHandleBase64url(c.appliance)).toBe(c.userHandle);
      expect(parsePasskeyUserHandle(c.userHandle)).toBe(c.appliance);
    }
    for (const c of v.passkeys.enroll) expect(passkeyEnrollChallengeBase64url(c)).toBe(c.challenge);
    for (const c of v.passkeys.register) expect(passkeyRegisterChallengeBase64url(c)).toBe(c.challenge);
    // Remote help (0.120, CT-934): each choice is its own challenge.
    expect(v.passkeys.remoteHelp.length).toBeGreaterThan(1);
    for (const c of v.passkeys.remoteHelp) expect(passkeyRemoteHelpChallengeBase64url(c)).toBe(c.challenge);
    const challenges = v.passkeys.remoteHelp.map((c: { challenge: string }) => c.challenge);
    expect(new Set(challenges).size).toBe(challenges.length);
  });

  it('keep command inputs strict', () => {
    const allow = createOperationAllowlist();
    for (const c of v.inputs) {
      const spec = allow.get(c.op);
      expect(spec, c.op).toBeDefined();
      expect(spec?.input.safeParse(c.input).success, c.name).toBe(c.valid);
    }
  });
});

describe('collab vectors', () => {
  const v = load('collab.json');
  const bytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));

  it('encode, split and reassemble', () => {
    for (const c of v.cases) {
      if (c.encoded) {
        const encoded = encodeCollabMessages(c.messages.map(bytes));
        expect(hex(encoded), c.name).toBe(c.encoded);
        expect(collabDataPayloads(encoded, c.maxData).map(hex), c.name).toEqual(c.payloads);
      }
      const decoder = new CollabMessageDecoder();
      if (c.error) {
        expect(() => {
          for (const p of c.payloads) decoder.push(bytes(p));
        }, c.name).toThrowError(expect.objectContaining({ code: c.error }));
        continue;
      }
      const out = c.payloads.flatMap((p: string) => decoder.push(bytes(p)));
      expect(out.map(hex), c.name).toEqual(c.messages);
      expect(decoder.pending, c.name).toBe(c.pending);
    }
  });
});

describe('local IPC vectors', () => {
  const v = load('local.json');

  it('revocation refs', () => {
    for (const c of v.revocationRefs) expect(revocationRef(c.peerId)).toBe(c.ref);
  });

  it('display text: the refused code points', () => {
    expect(v.displayText.pattern).toBe(CONSOLE_DISPLAY_TEXT_RE.source);
    const refused = (cp: number) =>
      v.displayText.rejected.some(([lo, hi]: [number, number]) => lo <= cp && cp <= hi);
    for (const cp of [0x1b, 0x7f, 0x85, 0xa0, 0x200b, 0x202e, 0x2028, 0x2029, 0x3000, 0xfeff, 0xd800])
      expect(refused(cp), cp.toString(16)).toBe(true);
    for (const cp of [0x41, 0x2019, 0x5de2, 0x1f43b, 0xe000])
      expect(refused(cp), cp.toString(16)).toBe(false);
  });

  it('console states and lookup leases', () => {
    for (const c of v.consoleStates) {
      expect(ConsoleState.safeParse(c.state).success).toBe(true);
      expect(consoleStateValid(c.state), JSON.stringify(c.state)).toBe(c.valid);
      expect(consoleDisplayUrl(c.state.url)).toBe(c.display);
    }
    for (const c of v.claimLookupLeases) {
      expect(ClaimLookupLeaseRequest.safeParse(c.request).success).toBe(true);
      expect(claimLookupLeaseValid(c.request), JSON.stringify(c.request)).toBe(c.valid);
    }
  });

  it('desk states and talk requests (CT-530, CT-531)', () => {
    expect(v.deskStates.some((c: { valid: boolean }) => c.valid)).toBe(true);
    expect(v.deskStates.some((c: { valid: boolean }) => !c.valid)).toBe(true);
    for (const c of v.deskStates) {
      expect(DeskState.safeParse(c.state).success, JSON.stringify(c.state)).toBe(true);
      expect(deskStateValid(c.state), JSON.stringify(c.state)).toBe(c.valid);
    }
    for (const c of v.deskTalkRequests) {
      expect(DeskTalkRequest.safeParse(c.request).success).toBe(true);
      expect(deskTalkRequestValid(c.request), JSON.stringify(c.request)).toBe(c.valid);
    }
    // 0.108 (CT-664).
    expect(v.deskTalkSessions.some((c: { valid: boolean }) => !c.valid)).toBe(true);
    for (const c of v.deskTalkSessions) {
      expect(DeskTalkSession.safeParse(c.session).success, JSON.stringify(c.session)).toBe(true);
      expect(deskTalkSessionValid(c.session), JSON.stringify(c.session)).toBe(c.valid);
    }
  });

  it('the box’s network and display text (CT-560, CT-564…CT-567)', () => {
    expect(v.hostNetworks.some((c: { valid: boolean }) => c.valid)).toBe(true);
    expect(v.hostNetworks.some((c: { valid: boolean }) => !c.valid)).toBe(true);
    for (const c of v.hostNetworks) {
      expect(HostNetwork.safeParse(c.network).success, JSON.stringify(c.network)).toBe(true);
      expect(hostNetworkValid(c.network), JSON.stringify(c.network)).toBe(c.valid);
    }
    expect(v.networkChanges.some((c: { valid: boolean }) => !c.valid)).toBe(true);
    for (const c of v.networkChanges) {
      expect(NetworkChange.safeParse(c.change).success).toBe(true);
      expect(networkChangeValid(c.change), JSON.stringify(c.change)).toBe(c.valid);
    }
    for (const c of v.hostTexts) {
      expect(hostText(c.input, c.max), c.input).toBe(c.output);
      // What comes out fits the pattern of its length (empty only where the length allows none).
      if (c.output !== '') expect(hostTextSchema(c.max).safeParse(c.output).success, c.output).toBe(true);
    }
    for (const c of v.ssids) expect(ssidValid(c.ssid), c.ssid).toBe(c.valid);
    for (const c of v.wifiSignals) expect(wifiSignalFromDbm(c.dbm), String(c.dbm)).toBe(c.signal);
  });

  it('the box’s Bluetooth (CT-670, CT-672, CT-673)', () => {
    expect(v.bluetoothStates.some((c: { valid: boolean }) => c.valid)).toBe(true);
    expect(v.bluetoothStates.some((c: { valid: boolean }) => !c.valid)).toBe(true);
    for (const c of v.bluetoothStates) {
      expect(BluetoothState.safeParse(c.state).success, JSON.stringify(c.state)).toBe(true);
      expect(bluetoothStateValid(c.state), JSON.stringify(c.state)).toBe(c.valid);
    }
    expect(v.bluetoothPairings.some((c: { valid: boolean }) => !c.valid)).toBe(true);
    for (const c of v.bluetoothPairings) {
      expect(BluetoothPairing.safeParse(c.pairing).success).toBe(true);
      expect(bluetoothPairingValid(c.pairing), JSON.stringify(c.pairing)).toBe(c.valid);
    }
    for (const c of v.bluetoothSignals) expect(bluetoothSignalFromDbm(c.dbm), String(c.dbm)).toBe(c.signal);
  });

  it('remote help: the help code, who visits, durations, steps, the support state and events (CT-930…CT-941)', () => {
    expect(v.helpCodes.some((c: { code: string | null }) => c.code === null)).toBe(true);
    for (const c of v.helpCodes) {
      expect(normalizeHelpCode(c.input), c.input).toBe(c.code);
      if (c.code !== null) expect(c.code).toMatch(HELP_CODE_RE);
    }
    for (const c of v.helpCodeFormats) expect(formatHelpCode(c.code)).toBe(c.shown);
    for (const c of v.helpCodeBytes) expect(helpCodeFromBytes(hexToBytes(c.random))).toBe(c.code);
    for (const c of v.remoteHelpWhos) {
      expect(remoteHelpWho(c.keyId), c.keyId).toBe(c.who);
      expect(RemoteHelpWho.safeParse(c.who).success, c.who).toBe(true);
    }
    for (const c of v.remoteHelpDurations) expect(remoteHelpDurationSeconds(c.duration)).toBe(c.seconds);
    const sides = (cases: { valid: boolean }[]) => [cases.some((c) => c.valid), cases.some((c) => !c.valid)];
    for (const list of [v.remoteHelpSteps, v.supportStates, v.supportEvents])
      expect(sides(list)).toEqual([true, true]);
    for (const c of v.remoteHelpSteps) {
      expect(RemoteHelpStep.safeParse(c.step).success, JSON.stringify(c.step)).toBe(true);
      expect(remoteHelpStepValid(c.step), JSON.stringify(c.step)).toBe(c.valid);
    }
    for (const c of v.supportStates) {
      expect(SupportState.safeParse(c.state).success, JSON.stringify(c.state)).toBe(true);
      expect(supportStateValid(c.state), JSON.stringify(c.state)).toBe(c.valid);
    }
    for (const c of v.supportEvents) {
      expect(SupportEvent.safeParse(c.event).success, JSON.stringify(c.event)).toBe(true);
      expect(supportEventValid(c.event), JSON.stringify(c.event)).toBe(c.valid);
    }
  });

  it('backup summaries', () => {
    for (const c of v.backupSummaries)
      expect(summarizeBackup(c.status, BackupScope.options), c.name).toEqual(c.summary);
  });
});

describe('session error vectors', () => {
  const v = load('session.json');

  it('carry application codes in details and version ranges', () => {
    for (const c of v.errors) {
      const r = decodeApplianceMessage(utf8Encode(JSON.stringify(c.json)));
      expect(r.ok, c.name).toBe(true);
      if (!r.ok || r.message.t !== 'error') continue;
      if (c.appCode) expect(appErrorCode(r.message.details), c.name).toBe(c.appCode);
      if (c.mustUpdate)
        expect(
          whoMustUpdate(c.clientMajors, UnsupportedVersionDetails.parse(r.message.details)),
          c.name,
        ).toBe(c.mustUpdate);
    }
  });
});

describe('claim secret vectors', () => {
  const v = load('claim.json');

  it('normalize exactly like provisioning and hash', () => {
    for (const c of v.normalize) {
      expect(normalizeClaimSecret(c.input), c.name).toBe(c.normalized);
      expect(isClaimSecret(c.normalized), c.name).toBe(c.valid);
    }
    for (const c of v.hashes) {
      expect(claimSecretHash(c.deviceId, c.secret)).toBe(c.hash);
      expect(claimVerifier(c.deviceId, c.secret)).toBe(c.verifier);
      expect(c.verifier).not.toBe(c.hash);
    }
  });

  it('normalize, format and draw console claim codes', () => {
    for (const c of v.codes) expect(normalizeClaimCode(c.input), JSON.stringify(c.input)).toEqual(c.expect);
    for (const c of v.formats) {
      if (c.code === null) expect(() => formatClaimCode(c.letters, c.lookup)).toThrow();
      else expect(formatClaimCode(c.letters, c.lookup)).toBe(c.code);
    }
    for (const c of v.letters) {
      const bytes = hexToBytes(c.random);
      let o = 0;
      const letters = generateClaimLetters((n) => {
        const out = bytes.slice(o, o + n);
        o += n;
        return out;
      });
      expect(letters).toBe(c.letters);
      expect(o).toBe(bytes.length);
    }
  });

  it('normalize, format and draw the screen sign-in’s letters (CT-620)', () => {
    expect(v.screenCodes.some((c: { letters: string | null }) => c.letters === null)).toBe(true);
    for (const c of v.screenCodes)
      expect(normalizeScreenSignInLetters(c.input), JSON.stringify(c.input)).toBe(c.letters);
    for (const c of v.screenFormats) {
      if (c.shown === null) expect(() => formatScreenSignInLetters(c.letters)).toThrow();
      else expect(formatScreenSignInLetters(c.letters)).toBe(c.shown);
    }
    for (const c of v.screenLetters) {
      const bytes = hexToBytes(c.random);
      let o = 0;
      const letters = generateScreenSignInLetters((n) => {
        const out = bytes.slice(o, o + n);
        o += n;
        return out;
      });
      expect(letters).toBe(c.letters);
      expect(o).toBe(bytes.length);
    }
  });
});

describe('cpace vectors', () => {
  const v = load('cpace.json');
  const d = v.draft;
  const once = (b: Uint8Array) => () => b;

  it('match draft-irtf-cfrg-cpace-21 Appendix A and B.3', () => {
    for (const c of d.prependLen) expect(hex(cpacePrependLen(hexToBytes(c.data)))).toBe(c.out);
    expect(hex(cpaceLvCat(...d.lvCat.parts.map(hexToBytes)))).toBe(d.lvCat.out);
    for (const c of d.transcriptIrCases)
      expect(
        hex(
          cpaceTranscriptIr(
            ...([c.ya, c.adA, c.yb, c.adB].map(hexToBytes) as [
              Uint8Array,
              Uint8Array,
              Uint8Array,
              Uint8Array,
            ]),
          ),
        ),
      ).toBe(c.out);
    const [prs, ci, sid] = [d.prs, d.ci, d.sid].map(hexToBytes) as [Uint8Array, Uint8Array, Uint8Array];
    expect(hex(cpaceGeneratorString(utf8Encode('CPaceRistretto255'), prs, ci, sid))).toBe(d.generatorString);
    expect(hex(cpaceGenerator(prs, ci, sid))).toBe(d.generator);
    const a = cpaceInitiatorStart({ prs, ci, sid }, once(hexToBytes(d.ya)), hexToBytes(d.adA));
    expect(hex(a.share)).toBe(d.Ya);
    const b = cpaceResponderRespond(
      { prs, ci, sid },
      a.share,
      once(hexToBytes(d.yb)),
      hexToBytes(d.adA),
      hexToBytes(d.adB),
    );
    expect(hex(b.share)).toBe(d.Yb);
    expect(hex(cpaceScalarMultVfy(hexToBytes(d.ya), hexToBytes(d.Yb)))).toBe(d.K);
    expect(hex(cpaceScalarMultVfy(hexToBytes(d.yb), hexToBytes(d.Ya)))).toBe(d.K);
    expect(hex(b.transcript)).toBe(d.transcriptIr);
    expect(hex(b.isk)).toBe(d.iskIr);
    expect(hex(cpaceIsk(sid, hexToBytes(d.K), b.transcript))).toBe(d.iskIr);
    expect(hex(cpaceInitiatorFinish(a, b.share, hexToBytes(d.adB)).isk)).toBe(d.iskIr);
    const s = hexToBytes(d.scalarMult.s);
    expect(hex(cpaceScalarMultVfy(s, hexToBytes(d.scalarMult.X)))).toBe(d.scalarMult.result);
    for (const p of d.invalidPoints) {
      expect(hex(cpaceScalarMultVfy(s, hexToBytes(p.point))), p.name).toBe('00'.repeat(32));
      expect(() => cpaceInitiatorFinish(a, hexToBytes(p.point)), p.name).toThrow();
      expect(
        () => cpaceResponderRespond({ prs, ci, sid }, hexToBytes(p.point), once(hexToBytes(d.yb))),
        p.name,
      ).toThrow();
    }
  });

  it('claim PAKE: shares, CI and tags; agreement only with identical inputs', () => {
    for (const c of v.pake) {
      expect(hex(claimPakeCi(c.client)), c.name).toBe(c.clientCi);
      expect(hex(claimPakeCi(c.appliance)), c.name).toBe(c.applianceCi);
      const client = claimPakeInitiator(c.client, once(hexToBytes(c.clientRandom)));
      expect(client.share, c.name).toBe(c.clientShare);
      const appliance = claimPakeResponder(c.appliance, c.clientShare, once(hexToBytes(c.applianceRandom)));
      expect(appliance.share, c.name).toBe(c.applianceShare);
      expect(appliance.tags, c.name).toEqual(c.applianceTags);
      const tags = claimPakeInitiatorFinish(client.state, c.applianceShare);
      expect(tags, c.name).toEqual(c.clientTags);
      expect(claimConfirmEqual(appliance.tags.client, tags.client), c.name).toBe(c.agree);
      expect(claimConfirmEqual(tags.appliance, appliance.tags.appliance), c.name).toBe(c.agree);
    }
    expect(v.pake.filter((c: { agree: boolean }) => c.agree).map((c: { name: string }) => c.name)).toEqual([
      'code, same inputs',
      'card, same inputs',
    ]);
    const base = v.pake[0].appliance;
    for (const c of v.invalidShares) {
      expect(c.refused, c.name).toBe(true);
      expect(
        () => claimPakeResponder(base, c.share, once(hexToBytes(v.pake[0].applianceRandom))),
        c.name,
      ).toThrow();
    }
  });

  it('screen sign-in PAKE (CT-621): shares, CI and tags; agreement only with identical inputs', () => {
    for (const c of v.screenSignIn) {
      expect(hex(screenSignInPakeCi(c.client)), c.name).toBe(c.clientCi);
      expect(hex(screenSignInPakeCi(c.appliance)), c.name).toBe(c.applianceCi);
      const client = screenSignInPakeInitiator(c.client, once(hexToBytes(c.clientRandom)));
      expect(client.share, c.name).toBe(c.clientShare);
      const appliance = screenSignInPakeResponder(
        c.appliance,
        c.clientShare,
        once(hexToBytes(c.applianceRandom)),
      );
      expect(appliance.share, c.name).toBe(c.applianceShare);
      expect(appliance.tags, c.name).toEqual(c.applianceTags);
      const tags = screenSignInPakeInitiatorFinish(client.state, c.applianceShare);
      expect(tags, c.name).toEqual(c.clientTags);
      expect(claimConfirmEqual(appliance.tags.client, tags.client), c.name).toBe(c.agree);
      expect(claimConfirmEqual(tags.appliance, appliance.tags.appliance), c.name).toBe(c.agree);
    }
    expect(
      v.screenSignIn.filter((c: { agree: boolean }) => c.agree).map((c: { name: string }) => c.name),
    ).toEqual(['same inputs']);
    const base = v.screenSignIn[0].appliance;
    for (const c of v.invalidShares)
      expect(
        () => screenSignInPakeResponder(base, c.share, once(hexToBytes(v.screenSignIn[0].applianceRandom))),
        c.name,
      ).toThrow();
  });

  it('local claim PAKE (CT-1302): shares, CI and tags; agreement only with identical inputs', () => {
    for (const c of v.localClaim) {
      expect(hex(localClaimPakeCi(c.client)), c.name).toBe(c.clientCi);
      expect(hex(localClaimPakeCi(c.appliance)), c.name).toBe(c.applianceCi);
      const client = localClaimPakeInitiator(c.client, once(hexToBytes(c.clientRandom)));
      expect(client.share, c.name).toBe(c.clientShare);
      const appliance = localClaimPakeResponder(
        c.appliance,
        c.clientShare,
        once(hexToBytes(c.applianceRandom)),
      );
      expect(appliance.share, c.name).toBe(c.applianceShare);
      expect(appliance.tags, c.name).toEqual(c.applianceTags);
      const tags = localClaimPakeInitiatorFinish(client.state, c.applianceShare);
      expect(tags, c.name).toEqual(c.clientTags);
      expect(claimConfirmEqual(appliance.tags.client, tags.client), c.name).toBe(c.agree);
    }
    expect(
      v.localClaim.filter((c: { agree: boolean }) => c.agree).map((c: { name: string }) => c.name),
    ).toEqual(['same inputs']);
    // Domain-separated from the claim through control and the screen sign-in: the same letters and keys never agree.
    const same = v.localClaim[0];
    expect(hex(localClaimPakeCi(same.client))).not.toBe(v.screenSignIn[0].clientCi);
  });
});

describe('compat vectors', () => {
  const v = load('compat.json');

  it('agree with the release helpers', () => {
    for (const c of v.activation)
      expect(checkActivation(v.tuples[c.current], v.tuples[c.candidate], c.dbSchema), c.name).toEqual(
        c.expect,
      );
    expect(v.migrating.length).toBeGreaterThan(0);
    for (const c of v.migrating)
      expect(
        checkMigratingActivation(v.tuples[c.current], v.tuples[c.candidate], c.dbSchema, c.migration),
        c.name,
      ).toEqual(c.expect);
    expect(v.compatible.length).toBeGreaterThan(0);
    for (const c of v.compatible)
      expect(
        checkCompatibleActivation(v.tuples[c.current], v.tuples[c.candidate], c.dbSchema, c.floors),
        c.name,
      ).toEqual(c.expect);
    expect(v.versions.length).toBeGreaterThan(0);
    for (const c of v.versions) expect(compareVersions(c.a, c.b), c.name).toBe(c.expect);
    for (const c of v.classes) expect(updateClass(v.tuples[c.current], v.tuples[c.candidate])).toBe(c.expect);
    for (const c of v.overlaps) expect(protocolOverlap(c.client, c.runtime)).toBe(c.expect);
    for (const c of v.serves) expect(servesClient(v.tuples.base, c.version)).toBe(c.expect);
    for (const [name, digest] of Object.entries(v.digests)) expect(tupleDigest(v.tuples[name])).toBe(digest);
    expect(v.retryable).toEqual([...RETRYABLE_UPDATE_FAILURES]);
    for (const c of v.floors)
      expect(clientBelowFloor(v.tuples[c.tuple].clientFloor, c), c.name).toBe(c.expect);
    for (const c of v.assignmentKeys) {
      let got: { keys: Record<string, string> } | { error: string };
      try {
        got = { keys: assignmentKeyMap(c.doc, c.env, c.now) };
      } catch (e) {
        got = { error: (e as { code: string }).code };
      }
      expect(got, c.name).toEqual(c.expect);
    }
    for (const t of Object.values(v.tuples)) expect(ReleaseTuple.safeParse(t).success).toBe(true);
  });
});

describe('secret ops', () => {
  it('keep no input digest in receipts', () => {
    const allow = createOperationAllowlist();
    const secretOps = allow.ops.filter((op) => allow.get(op)?.secret);
    expect(secretOps.sort()).toEqual([...load('session.json').secretOps].sort());
    const spec = allow.get('signins.loginSubmit');
    if (!spec) throw new Error('missing');
    expect(receiptDigest(spec, { body: { secret: 'a' } })).toBe(
      receiptDigest(spec, { body: { secret: 'b' } }),
    );
  });
});

describe('client channel vectors (CT-74)', () => {
  const v = load('clients.json');

  it('verify channels', () => {
    for (const c of v.channels) {
      const r = verifyClientChannel(c.doc, {
        keys: v.keys,
        env: c.env,
        now: c.now,
        lastSequence: c.lastSequence,
      });
      expect(r.ok ? 'ok' : r.error, c.name).toBe(c.expect);
    }
  });

  it('name bundle targets and select bundles', () => {
    for (const t of v.targets) expect(clientBundleTarget(t.bundle)).toBe(t.target);
    for (const c of v.selection)
      expect(selectClientBundle(v.bundles as ClientBundle[], c.want)?.version ?? null, c.name).toBe(c.expect);
  });
});
