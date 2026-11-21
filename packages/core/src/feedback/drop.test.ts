import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../audit/canonical.js';
import {
  FEEDBACK_DROP_TEXT,
  FEEDBACK_MAX_BODY_BYTES,
  FeedbackIntegrationHealth,
  feedbackDropExpiredText,
  feedbackDropNotFiledText,
} from '../contracts/feedback.js';
import {
  FeedbackDropHeader,
  FeedbackDropOutcome,
  FeedbackDropPlaintext,
  type FeedbackPublicConfig,
  FeedbackReference,
  type FeedbackSiteCard,
  FeedbackSiteKey,
  SignedFeedbackSiteCard,
} from '../domain/feedback.js';
import {
  decodeDropPlaintext,
  deriveKeyPair,
  dropEnvelopeCap,
  dropKeyId,
  dropPublicKeyOf,
  encodeDropHeader,
  encodeDropPlaintext,
  FEEDBACK_CARD_MAX_LIFETIME_S,
  FEEDBACK_DROP_INFO,
  FEEDBACK_DROP_KID_PATTERN,
  FEEDBACK_DROP_MAX_ENVELOPE_BYTES,
  FEEDBACK_DROP_SUITE,
  FEEDBACK_SITE_CARD_PURPOSE,
  FEEDBACK_SITE_KEY_PATTERN,
  FeedbackDropError,
  feedbackReferenceFor,
  generateDropKeyPair,
  generateSiteSigningKey,
  HpkeError,
  hpkeContextOpen,
  hpkeContextSeal,
  hpkeExport,
  hpkeOpenBase,
  hpkeSealBase,
  hpkeSetupBaseR,
  hpkeSetupBaseS,
  openDropEnvelope,
  padLength,
  parseDropHeader,
  sealDropEnvelope,
  signSiteCard,
  siteCardSigningBytes,
  siteKeyFingerprint,
  siteSigningKeyOf,
  verifySiteCard,
} from './drop.js';
import { basicSnippet, cspAdvice, customLauncherSnippet, snippetBase, WIDGET_ATTRIBUTES } from './install.js';

const h = hexToBytes;
/** Test-side base64url (bit by bit, independent of the module's codec). */
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const b64 = (bytes: Uint8Array) => {
  const bits = [...bytes].map((b) => b.toString(2).padStart(8, '0')).join('');
  let out = '';
  for (let i = 0; i < bits.length; i += 6)
    out += ALPHA[Number.parseInt(bits.slice(i, i + 6).padEnd(6, '0'), 2)];
  return out;
};
const unb64 = (text: string) => {
  const bits = [...text].map((c) => ALPHA.indexOf(c).toString(2).padStart(6, '0')).join('');
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
};

/** RFC 9180 Appendix A.1.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode. */
const A11 = {
  info: '4f6465206f6e2061204772656369616e2055726e',
  ikmE: '7268600d403fce431561aef583ee1613527cff655c1343f29812e66706df3234',
  pkEm: '37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431',
  skEm: '52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736',
  ikmR: '6db9df30aa07dd42ee5e8181afdb977e538f5e1fec8a06223f33f7013e525037',
  pkRm: '3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d',
  skRm: '4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8',
  enc: '37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431',
  sharedSecret: 'fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc',
  key: '4531685d41d65f03dc48f6b8302c05b0',
  baseNonce: '56d890e5accaaf011cff4b7d',
  exporterSecret: '45ff1c2e220db587171952c0592d5f5ebe103f1561a2614e38f2ffd47e99e3f8',
  pt: '4265617574792069732074727574682c20747275746820626561757479',
  encryptions: [
    {
      seq: 0,
      aad: '436f756e742d30',
      ct: 'f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a',
    },
    {
      seq: 1,
      aad: '436f756e742d31',
      ct: 'af2d7e9ac9ae7e270f46ba1f975be53c09f8d875bdc8535458c2494e8a6eab251c03d0c22a56b8ca42c2063b84',
    },
    {
      seq: 2,
      aad: '436f756e742d32',
      ct: '498dfcabd92e8acedc281e85af1cb4e3e31c7dc394a1ca20e173cb72516491588d96a19ad4a683518973dcc180',
    },
    {
      seq: 4,
      aad: '436f756e742d34',
      ct: '583bd32bc67a5994bb8ceaca813d369bca7b2a42408cddef5e22f880b631215a09fc0012bc69fccaa251c0246d',
    },
    {
      seq: 255,
      aad: '436f756e742d323535',
      ct: '7175db9717964058640a3a11fb9007941a5d1757fda1a6935c805c21af32505bf106deefec4a49ac38d71c9e0a',
    },
    {
      seq: 256,
      aad: '436f756e742d323536',
      ct: '957f9800542b0b8891badb026d79cc54597cb2d225b54c00c5238c25d05c30e3fbeda97d2e0e1aba483a2df9f2',
    },
  ],
  exports: [
    { context: '', length: 32, value: '3853fe2b4035195a573ffc53856e77058e15d9ea064de3e59f4961d0095250ee' },
    { context: '00', length: 32, value: '2e8f0b54673c7029649d4eb9d5e33bf1872cf76d623ff164ac185da9e88c21a5' },
    {
      context: '54657374436f6e74657874',
      length: 32,
      value: 'e9e43065102c3836401bed8c3c3c75ae46be1639869391d62c61f1ec7af54931',
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A `crypto` with randomness (noble needs it) but without `subtle`, like a runtime without WebCrypto. */
const realCrypto = (globalThis as unknown as { crypto: { getRandomValues(a: Uint8Array): Uint8Array } })
  .crypto;
const withoutSubtle = () =>
  vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => realCrypto.getRandomValues(a) });

describe('HPKE (RFC 9180 A.1.1)', () => {
  it('derives the key pairs', () => {
    const e = deriveKeyPair(h(A11.ikmE));
    const r = deriveKeyPair(h(A11.ikmR));
    expect(bytesToHex(e.privateKey)).toBe(A11.skEm);
    expect(bytesToHex(e.publicKey)).toBe(A11.pkEm);
    expect(bytesToHex(r.privateKey)).toBe(A11.skRm);
    expect(bytesToHex(r.publicKey)).toBe(A11.pkRm);
  });

  it('sets up both sides with the key schedule values', () => {
    const s = hpkeSetupBaseS(h(A11.pkRm), h(A11.info), h(A11.ikmE));
    expect(bytesToHex(s.enc)).toBe(A11.enc);
    const r = hpkeSetupBaseR(h(A11.enc), h(A11.skRm), h(A11.info));
    for (const ctx of [s, r]) {
      expect(bytesToHex(ctx.sharedSecret)).toBe(A11.sharedSecret);
      expect(bytesToHex(ctx.key)).toBe(A11.key);
      expect(bytesToHex(ctx.baseNonce)).toBe(A11.baseNonce);
      expect(bytesToHex(ctx.exporterSecret)).toBe(A11.exporterSecret);
    }
  });

  it('seals and opens every listed sequence number', async () => {
    const s = hpkeSetupBaseS(h(A11.pkRm), h(A11.info), h(A11.ikmE));
    const r = hpkeSetupBaseR(h(A11.enc), h(A11.skRm), h(A11.info));
    for (const c of A11.encryptions) {
      expect(bytesToHex(await hpkeContextSeal(s, c.seq, h(c.aad), h(A11.pt))), `seq ${c.seq}`).toBe(c.ct);
      expect(bytesToHex(await hpkeContextOpen(r, c.seq, h(c.aad), h(c.ct)))).toBe(A11.pt);
    }
  });

  it('exports the listed values', () => {
    const r = hpkeSetupBaseR(h(A11.enc), h(A11.skRm), h(A11.info));
    for (const x of A11.exports) expect(bytesToHex(hpkeExport(r, h(x.context), x.length))).toBe(x.value);
  });

  it('single-shot seal and open are sequence 0', async () => {
    const first = A11.encryptions[0] as (typeof A11.encryptions)[number];
    const sealed = await hpkeSealBase(h(A11.pkRm), h(A11.info), h(first.aad), h(A11.pt), h(A11.ikmE));
    expect(bytesToHex(sealed.enc)).toBe(A11.enc);
    expect(bytesToHex(sealed.ciphertext)).toBe(first.ct);
    expect(
      bytesToHex(await hpkeOpenBase(h(A11.enc), h(A11.skRm), h(A11.info), h(first.aad), h(first.ct))),
    ).toBe(A11.pt);
  });

  it('draws a fresh ephemeral key without ikmE', async () => {
    const a = await hpkeSealBase(h(A11.pkRm), h(A11.info), new Uint8Array(0), h(A11.pt));
    const b = await hpkeSealBase(h(A11.pkRm), h(A11.info), new Uint8Array(0), h(A11.pt));
    expect(bytesToHex(a.enc)).not.toBe(bytesToHex(b.enc));
    expect(
      bytesToHex(await hpkeOpenBase(a.enc, h(A11.skRm), h(A11.info), new Uint8Array(0), a.ciphertext)),
    ).toBe(A11.pt);
  });

  it('refuses tampering, wrong keys and low-order points', async () => {
    const first = A11.encryptions[0] as (typeof A11.encryptions)[number];
    const ct = h(first.ct);
    const open = (enc: Uint8Array, sk: Uint8Array, aad: Uint8Array, c: Uint8Array, info = h(A11.info)) =>
      hpkeOpenBase(enc, sk, info, aad, c);
    const code = async (p: Promise<unknown>) => p.then(() => 'ok').catch((e: HpkeError) => e.code);
    const flipped = ct.slice();
    flipped[0] = (flipped[0] as number) ^ 1;
    const tag = ct.slice();
    tag[tag.length - 1] = (tag[tag.length - 1] as number) ^ 0x80;
    expect(await code(open(h(A11.enc), h(A11.skRm), h(first.aad), flipped))).toBe('open_failed');
    expect(await code(open(h(A11.enc), h(A11.skRm), h(first.aad), tag))).toBe('open_failed');
    expect(await code(open(h(A11.enc), h(A11.skRm), h('00'), ct))).toBe('open_failed');
    expect(await code(open(h(A11.enc), h(A11.skRm), h(first.aad), ct, h('00')))).toBe('open_failed');
    expect(await code(open(h(A11.enc), h(A11.skEm), h(first.aad), ct))).toBe('open_failed');
    expect(await code(open(h(A11.enc), h(A11.skRm), h(first.aad), ct.subarray(0, 15)))).toBe('open_failed');
    // Low-order public keys: 0 and 1 (u-coordinates), whose shared secret is all zero.
    for (const low of [new Uint8Array(32), concatBytes(h('01'), new Uint8Array(31))]) {
      expect(() => hpkeSetupBaseS(low, h(A11.info))).toThrow(HpkeError);
      expect(() => hpkeSetupBaseR(low, h(A11.skRm), h(A11.info))).toThrow(/invalid_key/);
    }
    expect(() => hpkeSetupBaseS(new Uint8Array(31), h(A11.info))).toThrow(/invalid_key/);
    expect(() => hpkeSetupBaseR(h(A11.enc), new Uint8Array(16), h(A11.info))).toThrow(/invalid_key/);
    expect(() => deriveKeyPair(new Uint8Array(31))).toThrow(/invalid_key/);
    const s = hpkeSetupBaseS(h(A11.pkRm), h(A11.info), h(A11.ikmE));
    await expect(hpkeContextSeal(s, -1, h('00'), h('00'))).rejects.toThrow(RangeError);
    await expect(hpkeContextSeal(s, 0.5, h('00'), h('00'))).rejects.toThrow(RangeError);
  });

  it('computes nonces for large sequence numbers', async () => {
    const s = hpkeSetupBaseS(h(A11.pkRm), h(A11.info), h(A11.ikmE));
    const r = hpkeSetupBaseR(h(A11.enc), h(A11.skRm), h(A11.info));
    const seq = 2 ** 40 + 3;
    const ct = await hpkeContextSeal(s, seq, h('aa'), h(A11.pt));
    expect(bytesToHex(await hpkeContextOpen(r, seq, h('aa'), ct))).toBe(A11.pt);
    await expect(hpkeContextOpen(r, seq + 1, h('aa'), ct)).rejects.toThrow(/open_failed/);
  });

  it('says so when WebCrypto is missing', async () => {
    withoutSubtle();
    const s = hpkeSetupBaseS(h(A11.pkRm), h(A11.info), h(A11.ikmE));
    await expect(hpkeContextSeal(s, 0, h('00'), h('00'))).rejects.toMatchObject({ code: 'unsupported' });
    await expect(hpkeContextOpen(s, 0, h('00'), new Uint8Array(32))).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

// ---------------------------------------------------------------------------------------------------------

const signing = siteSigningKeyOf(new Uint8Array(32).fill(7));
const recipient = deriveKeyPair(new Uint8Array(32).fill(9));
const SITE = 'fbs_Q3v9xLpA0dZkT7mW2bNcYe12';
const ISSUED = 1_790_467_200;

const config: FeedbackPublicConfig = {
  productLabel: 'Lumio',
  reportTypes: ['bug', 'feature'],
  theme: 'auto',
  position: 'bottom-right',
  launcher: 'floating',
  launcherLabel: 'Feedback',
  privacyUrl: null,
  contactFields: { name: 'optional', email: 'optional' },
  attachments: { max: 3, maxBytes: 3_145_728, types: ['image/png', 'image/jpeg'] },
  text: { description: 5000, expected: 3000, steps: 3000 },
  redactPaths: [],
  contextKeys: [],
};

function cardOf(over: Partial<FeedbackSiteCard> = {}): FeedbackSiteCard {
  return {
    purpose: FEEDBACK_SITE_CARD_PURPOSE,
    v: 1,
    site: SITE,
    seq: 17,
    issuedAt: ISSUED,
    expiresAt: ISSUED + FEEDBACK_CARD_MAX_LIFETIME_S,
    allowedOrigins: ['https://billing.lumio.example'],
    config,
    limits: { maxEnvelopeBytes: 13_107_200, reportsPerHour: 30, reportsPerDay: 200, perSourcePerHour: 5 },
    encryption: {
      suite: FEEDBACK_DROP_SUITE,
      kid: dropKeyId(recipient.publicKey),
      publicKey: b64(recipient.publicKey),
    },
    signingKey: signing.publicKey,
    ...over,
  };
}

const plaintextOf = (description: string) =>
  JSON.stringify({
    v: 1,
    submission: {
      submissionId: 'q3Vx9LpA0dZkT7mW2bNcYe',
      parentOrigin: 'https://billing.lumio.example',
      type: 'bug',
      description,
    },
    frame: {
      bridgeOrigin: 'https://billing.lumio.example',
      ancestorOrigins: ['https://billing.lumio.example'],
      widget: '1.1.0',
      cardSeq: 17,
    },
  });

const keyFor = (kid: string) => (kid === dropKeyId(recipient.publicKey) ? recipient.privateKey : null);
const errorCode = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof FeedbackDropError ? e.code : String(e)),
  );

describe('padding', () => {
  it.each([
    [0, 4096],
    [4, 4096],
    [4096, 4096],
    [4097, 16_384],
    [16_384, 16_384],
    [16_385, 32_768],
    [65_536, 65_536],
    [65_537, 262_144],
    [262_144, 262_144],
    [262_145, 524_288],
    [33_558_532, 33_816_576],
  ])('padLength(%i) = %i', (n, out) => expect(padLength(n)).toBe(out));

  it('takes non-negative integers only', () => {
    expect(() => padLength(-1)).toThrow(RangeError);
    expect(() => padLength(1.5)).toThrow(RangeError);
  });

  it('caps envelopes by the body cap', () => {
    expect(FEEDBACK_DROP_MAX_ENVELOPE_BYTES).toBe(dropEnvelopeCap(FEEDBACK_MAX_BODY_BYTES));
    expect(FEEDBACK_DROP_MAX_ENVELOPE_BYTES).toBe(33_817_138);
    expect(dropEnvelopeCap(64 * 1024)).toBe(562 + 262_144);
    expect(dropEnvelopeCap(0)).toBe(562 + 16_384);
  });

  it('encodes and decodes the padded plaintext strictly', () => {
    const padded = encodeDropPlaintext('{"a":"é"}');
    expect(padded.length).toBe(4096);
    expect([...padded.subarray(0, 4)]).toEqual([0, 0, 0, 10]);
    expect(decodeDropPlaintext(padded)).toBe('{"a":"é"}');
    const dirty = padded.slice();
    dirty[4095] = 1;
    expect(() => decodeDropPlaintext(dirty)).toThrow(/padding not zero/);
    expect(() => decodeDropPlaintext(padded.subarray(0, 4000))).toThrow(/padding length/);
    expect(() => decodeDropPlaintext(padded.subarray(0, 3))).toThrow(FeedbackDropError);
    const long = padded.slice();
    long[0] = 0xff;
    expect(() => decodeDropPlaintext(long)).toThrow(/padding length/);
    const bad = padded.slice();
    bad.set([0xc0, 0x80], 4);
    expect(() => decodeDropPlaintext(bad)).toThrow(/UTF-8/);
    // Exactly one bucket: a 16 KiB buffer for a short text is refused.
    const wide = new Uint8Array(16_384);
    wide.set(padded.subarray(0, 14));
    expect(() => decodeDropPlaintext(wide)).toThrow(/padding length/);
  });
});

describe('envelope v1', () => {
  const ikmE = new Uint8Array(32).fill(3);

  it.each([
    ['4 KiB', 100],
    ['16 KiB', 10_000],
    ['64 KiB', 60_000],
    ['256 KiB', 100_000],
    ['512 KiB', 300_000],
  ])('seals and opens a %s bucket', async (_, size) => {
    const json = plaintextOf('x'.repeat(size));
    const card = cardOf();
    const envelope = await sealDropEnvelope(card, json, ikmE);
    const parts = parseDropHeader(envelope);
    expect(parts.header).toEqual({ kid: card.encryption.kid, site: SITE, suite: FEEDBACK_DROP_SUITE, v: 1 });
    expect(parts.headerBytes).toEqual(utf8ToBytes(canonicalJson(parts.header)));
    expect(envelope.length).toBe(2 + parts.headerBytes.length + 32 + padLength(4 + json.length) + 16);
    expect(parts.enc).toEqual(deriveKeyPair(ikmE).publicKey);
    const opened = await openDropEnvelope(envelope, keyFor, { site: SITE });
    expect(opened.plaintextJson).toBe(json);
    expect(opened.header).toEqual(parts.header);
    expect(JSON.parse(opened.plaintextJson).frame.cardSeq).toBe(17);
    // Deterministic with a fixed ephemeral key, fresh without.
    expect(await sealDropEnvelope(card, json, ikmE)).toEqual(envelope);
    expect(await sealDropEnvelope(card, json)).not.toEqual(envelope);
  });

  it('accepts an async key lookup and names a missing key', async () => {
    const envelope = await sealDropEnvelope(cardOf(), plaintextOf('hi'));
    expect((await openDropEnvelope(envelope, async (kid) => keyFor(kid))).plaintextJson).toBe(
      plaintextOf('hi'),
    );
    expect(await errorCode(openDropEnvelope(envelope, () => null))).toBe('unknown_key');
    expect(await errorCode(openDropEnvelope(envelope, () => undefined))).toBe('unknown_key');
  });

  it('refuses tampering', async () => {
    const card = cardOf();
    const envelope = await sealDropEnvelope(card, plaintextOf('hi'), ikmE);
    const H = (envelope[0] as number) * 256 + (envelope[1] as number);
    const at = (i: number) => {
      const t = envelope.slice();
      t[i] = (t[i] as number) ^ 1;
      return t;
    };
    const open = (e: Uint8Array, opts: { site?: string } = {}) =>
      errorCode(openDropEnvelope(e, (kid) => keyFor(kid) ?? recipient.privateKey, opts));
    expect(await open(at(2 + H))).toBe('undecryptable'); // enc
    expect(await open(at(2 + H + 40))).toBe('undecryptable'); // ciphertext
    expect(await open(at(envelope.length - 1))).toBe('undecryptable'); // tag
    // Another (valid) site or kid in the header: the AAD no longer matches.
    const other = 'fbs_AAAAAAAAAAAAAAAAAAAAAAAA';
    const moved = concatBytes(
      envelope.subarray(0, 2),
      encodeDropHeader({ ...parts(envelope).header, site: other }),
      envelope.subarray(2 + H),
    );
    expect(parseDropHeader(moved).header.site).toBe(other);
    expect(await open(moved)).toBe('undecryptable');
    const rekeyed = concatBytes(
      envelope.subarray(0, 2),
      encodeDropHeader({ ...parts(envelope).header, kid: 'fdk_AAAAAAAAAAAAAAAA' }),
      envelope.subarray(2 + H),
    );
    expect(await open(rekeyed)).toBe('undecryptable');
    expect(await errorCode(openDropEnvelope(rekeyed, keyFor))).toBe('unknown_key');
    // Opened fine, but it names another site than the drop's.
    expect(await open(envelope, { site: other })).toBe('malformed');
    expect(await open(envelope, { site: SITE })).toBe('ok');
  });

  const parts = (e: Uint8Array) => parseDropHeader(e);

  it('refuses malformed framing and headers', async () => {
    const envelope = await sealDropEnvelope(cardOf(), plaintextOf('hi'), ikmE);
    const H = (envelope[0] as number) * 256 + (envelope[1] as number);
    const rest = envelope.subarray(2 + H);
    const withHeader = (text: string) => {
      const bytes = utf8ToBytes(text);
      return concatBytes(new Uint8Array([bytes.length >> 8, bytes.length & 255]), bytes, rest);
    };
    const header = parts(envelope).header;
    const malformed = [
      new Uint8Array(0),
      new Uint8Array(1),
      envelope.subarray(0, envelope.length - 1),
      concatBytes(envelope, new Uint8Array(1)),
      concatBytes(new Uint8Array([0, 15]), new Uint8Array(15), rest),
      concatBytes(new Uint8Array([2, 1]), new Uint8Array(513), rest),
      withHeader(JSON.stringify({ v: 1, suite: header.suite, site: header.site, kid: header.kid })),
      withHeader(`${canonicalJson(header)} `),
      withHeader(canonicalJson({ ...header, v: 2 })),
      withHeader(canonicalJson({ ...header, suite: 'hpke-base-x25519-sha256-chacha20poly1305' })),
      withHeader(canonicalJson({ ...header, extra: 1 })),
      withHeader(canonicalJson({ ...header, kid: 'fdk_short' })),
      withHeader(canonicalJson({ ...header, site: 'fbs_nope' })),
      withHeader('{"kid":'.padEnd(40, ' ')),
      withHeader('é'.repeat(10)),
      concatBytes(new Uint8Array([0, 20]), new Uint8Array([0xff]).fill(0xc0), new Uint8Array(19), rest),
    ];
    for (const [i, e] of malformed.entries()) {
      expect(() => parseDropHeader(e), `case ${i}`).toThrow(FeedbackDropError);
      expect(await errorCode(openDropEnvelope(e, keyFor)), `case ${i}`).toBe('malformed');
    }
    expect(() => encodeDropHeader({ ...header, v: 2 } as never)).toThrow(/header/);
  });

  it('refuses non-zero padding and a bad length inside a valid AEAD', async () => {
    const header = encodeDropHeader({
      kid: dropKeyId(recipient.publicKey),
      site: SITE,
      suite: FEEDBACK_DROP_SUITE,
      v: 1,
    });
    const envelopeOf = async (padded: Uint8Array) => {
      const { enc, ciphertext } = await hpkeSealBase(
        recipient.publicKey,
        utf8ToBytes(FEEDBACK_DROP_INFO),
        header,
        padded,
      );
      return concatBytes(new Uint8Array([0, header.length]), header, enc, ciphertext);
    };
    const padded = encodeDropPlaintext('{}');
    const dirty = padded.slice();
    dirty[100] = 7;
    expect(await errorCode(openDropEnvelope(await envelopeOf(dirty), keyFor))).toBe('malformed');
    const overlong = padded.slice();
    overlong[1] = 1;
    expect(await errorCode(openDropEnvelope(await envelopeOf(overlong), keyFor))).toBe('malformed');
    expect(await errorCode(openDropEnvelope(await envelopeOf(padded), keyFor))).toBe('ok');
  });

  it('refuses to seal beyond the card’s cap or to a bad card', async () => {
    const small = cardOf({ limits: { ...cardOf().limits, maxEnvelopeBytes: 5000 } });
    expect(await errorCode(sealDropEnvelope(small, plaintextOf('hi')))).toBe('ok');
    expect(await errorCode(sealDropEnvelope(small, plaintextOf('x'.repeat(5000))))).toBe('too_large');
    const badKey = cardOf({ encryption: { ...cardOf().encryption, publicKey: 'x' } });
    expect(await errorCode(sealDropEnvelope(badKey, '{}'))).toBe('malformed');
    const badSuite = cardOf({ encryption: { ...cardOf().encryption, suite: 'other' as never } });
    expect(await errorCode(sealDropEnvelope(badSuite, '{}'))).toBe('malformed');
  });

  it('passes WebCrypto’s absence through instead of calling it undecryptable', async () => {
    const envelope = await sealDropEnvelope(cardOf(), plaintextOf('hi'));
    withoutSubtle();
    await expect(openDropEnvelope(envelope, keyFor)).rejects.toBeInstanceOf(HpkeError);
  });
});

describe('site cards', () => {
  const signed = signSiteCard(cardOf(), signing.seed);

  it('pins the signing key with data-key', () => {
    const fp = siteKeyFingerprint(signing.publicKey);
    expect(fp).toMatch(FEEDBACK_SITE_KEY_PATTERN);
    expect(FeedbackSiteKey.safeParse(fp).success).toBe(true);
    const pub = unb64(signing.publicKey);
    expect(fp).toBe(`fbk_${b64(sha256(pub).subarray(0, 16))}`);
    expect(siteKeyFingerprint(pub)).toBe(fp);
    expect(signing.fingerprint).toBe(fp);
    expect(() => siteKeyFingerprint('nope')).toThrow(TypeError);
    expect(() => siteKeyFingerprint(new Uint8Array(31))).toThrow(TypeError);
  });

  it('names encryption keys', () => {
    const kid = dropKeyId(recipient.publicKey);
    expect(kid).toMatch(FEEDBACK_DROP_KID_PATTERN);
    expect(kid).toBe(`fdk_${b64(sha256(recipient.publicKey).subarray(0, 12))}`);
    expect(dropKeyId(b64(recipient.publicKey))).toBe(kid);
    expect(dropPublicKeyOf(recipient.privateKey)).toBe(b64(recipient.publicKey));
    expect(() => dropKeyId('AAAA')).toThrow(TypeError);
    expect(() => dropPublicKeyOf(new Uint8Array(3))).toThrow(TypeError);
    const fresh = generateDropKeyPair();
    expect(fresh.kid).toBe(dropKeyId(fresh.publicKey));
    expect(fresh.publicKeyB64).toBe(dropPublicKeyOf(fresh.privateKey));
    const s = generateSiteSigningKey();
    expect(s.fingerprint).toBe(siteKeyFingerprint(s.publicKey));
    expect(() => siteSigningKeyOf(new Uint8Array(3))).toThrow(TypeError);
  });

  it('signs canonical JSON and verifies it strictly', () => {
    expect(signed.card).toEqual(cardOf());
    expect(
      ed25519.verify(unb64(signed.sig), utf8ToBytes(canonicalJson(cardOf())), unb64(signing.publicKey)),
    ).toBe(true);
    expect(siteCardSigningBytes(cardOf())).toEqual(utf8ToBytes(canonicalJson(cardOf())));
    expect(verifySiteCard(signed, signing.fingerprint)).toEqual({ ok: true, card: cardOf() });
    expect(verifySiteCard(signed)).toMatchObject({ ok: true });
    expect(verifySiteCard(signed, null, { site: SITE, now: ISSUED })).toMatchObject({ ok: true });
    // Member order doesn't matter: the signature covers the canonical form.
    const reordered = JSON.parse(
      JSON.stringify({
        sig: signed.sig,
        card: {
          ...[...Object.entries(signed.card)]
            .reverse()
            .reduce((o, [k, v]) => Object.assign(o, { [k]: v }), {}),
        },
      }),
    );
    expect(verifySiteCard(reordered, signing.fingerprint)).toMatchObject({ ok: true });
    expect(SignedFeedbackSiteCard.safeParse(signed).success).toBe(true);
  });

  it('refuses the wrong pin, site, signature or time', () => {
    const other = siteSigningKeyOf(new Uint8Array(32).fill(8));
    expect(verifySiteCard(signed, other.fingerprint)).toEqual({ ok: false, error: 'wrong_key' });
    expect(verifySiteCard(signed, null, { site: 'fbs_AAAAAAAAAAAAAAAAAAAAAAAA' })).toEqual({
      ok: false,
      error: 'wrong_site',
    });
    const tampered = { ...signed, card: { ...signed.card, seq: 18 } };
    expect(verifySiteCard(tampered, signing.fingerprint)).toEqual({ ok: false, error: 'bad_signature' });
    const swapped = { ...signed, card: { ...signed.card, allowedOrigins: ['https://evil.example'] } };
    expect(verifySiteCard(swapped)).toEqual({ ok: false, error: 'bad_signature' });
    // Control swapping the encryption key must also swap the signing key, which the pin catches.
    const attacker = siteSigningKeyOf(new Uint8Array(32).fill(66));
    const evil = generateDropKeyPair();
    const forged = signSiteCard(
      cardOf({
        encryption: { suite: FEEDBACK_DROP_SUITE, kid: evil.kid, publicKey: evil.publicKeyB64 },
        signingKey: attacker.publicKey,
      }),
      attacker.seed,
    );
    expect(verifySiteCard(forged)).toMatchObject({ ok: true });
    expect(verifySiteCard(forged, signing.fingerprint)).toEqual({ ok: false, error: 'wrong_key' });
    const expiresAt = signed.card.expiresAt;
    expect(verifySiteCard(signed, null, { now: expiresAt })).toEqual({ ok: false, error: 'expired' });
    expect(verifySiteCard(signed, null, { now: expiresAt - 1 })).toMatchObject({ ok: true });
  });

  it('refuses ZIP-215-only signatures (small-order key, identity R, S = 0)', () => {
    const identity = concatBytes(h('01'), new Uint8Array(31));
    const card = cardOf({ signingKey: b64(identity) });
    const sig = concatBytes(identity, new Uint8Array(32));
    expect(ed25519.verify(sig, siteCardSigningBytes(card), identity, { zip215: true })).toBe(true);
    expect(verifySiteCard({ card, sig: b64(sig) })).toEqual({ ok: false, error: 'bad_signature' });
    // A non-canonical S (S + L) is refused too.
    const L = 2n ** 252n + 27742317777372353535851937790883648493n;
    const raw = unb64(signed.sig);
    let s = 0n;
    for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(raw[32 + i] as number);
    s += L;
    const big = new Uint8Array(raw);
    for (let i = 0; i < 32; i++) big[32 + i] = Number((s >> BigInt(8 * i)) & 255n);
    expect(verifySiteCard({ ...signed, sig: b64(big) })).toEqual({ ok: false, error: 'bad_signature' });
  });

  it('refuses malformed cards', () => {
    const cases: unknown[] = [
      null,
      [],
      'card',
      { card: signed.card },
      { ...signed, extra: 1 },
      { ...signed, sig: 'short' },
      { ...signed, sig: `${signed.sig.slice(0, 85)}B` }, // non-canonical trailing bits
      { ...signed, card: { ...signed.card, extra: 1 } },
      { ...signed, card: { ...signed.card, purpose: 'whombat-device-request/v1' } },
      { ...signed, card: { ...signed.card, v: 2 } },
      { ...signed, card: { ...signed.card, site: 'fbs_x' } },
      { ...signed, card: { ...signed.card, seq: 0 } },
      { ...signed, card: { ...signed.card, seq: 1.5 } },
      { ...signed, card: { ...signed.card, expiresAt: ISSUED } },
      { ...signed, card: { ...signed.card, expiresAt: ISSUED + FEEDBACK_CARD_MAX_LIFETIME_S + 1 } },
      { ...signed, card: { ...signed.card, allowedOrigins: [] } },
      { ...signed, card: { ...signed.card, allowedOrigins: ['https://A.example'] } },
      { ...signed, card: { ...signed.card, allowedOrigins: ['https://a.example', 'https://a.example'] } },
      {
        ...signed,
        card: {
          ...signed.card,
          allowedOrigins: Array.from({ length: 21 }, (_, i) => `https://s${i}.example`),
        },
      },
      { ...signed, card: { ...signed.card, config: [] } },
      { ...signed, card: { ...signed.card, limits: { ...signed.card.limits, extra: 1 } } },
      {
        ...signed,
        card: {
          ...signed.card,
          limits: { ...signed.card.limits, maxEnvelopeBytes: FEEDBACK_DROP_MAX_ENVELOPE_BYTES + 1 },
        },
      },
      { ...signed, card: { ...signed.card, limits: { ...signed.card.limits, reportsPerHour: 0 } } },
      { ...signed, card: { ...signed.card, encryption: { ...signed.card.encryption, suite: 'x' } } },
      {
        ...signed,
        card: { ...signed.card, encryption: { ...signed.card.encryption, kid: 'fdk_AAAAAAAAAAAAAAAA' } },
      },
      { ...signed, card: { ...signed.card, encryption: { ...signed.card.encryption, publicKey: 'AAAA' } } },
      { ...signed, card: { ...signed.card, encryption: { ...signed.card.encryption, extra: 1 } } },
      { ...signed, card: { ...signed.card, signingKey: `${signed.card.signingKey.slice(0, 42)}B` } },
      { ...signed, card: { ...signed.card, config: { ...config, productLabel: '\ud800' } } },
    ];
    for (const [i, c] of cases.entries())
      expect(verifySiteCard(c), `case ${i}`).toEqual({ ok: false, error: 'bad_card' });
    const big = {
      ...signed,
      card: { ...signed.card, config: { ...config, productLabel: 'x'.repeat(17_000) } },
    };
    expect(verifySiteCard(big)).toEqual({ ok: false, error: 'too_large' });
  });

  it('signs only well-formed cards with the matching seed', () => {
    const other = siteSigningKeyOf(new Uint8Array(32).fill(8));
    expect(() => signSiteCard(cardOf(), other.seed)).toThrow(/not the public key/);
    expect(() => signSiteCard(cardOf({ seq: 0 }), signing.seed)).toThrow(/Malformed/);
    expect(() =>
      signSiteCard(cardOf({ config: { ...config, productLabel: 'x'.repeat(17_000) } }), signing.seed),
    ).toThrow(/too large/);
  });

  it('parses with the Zod schemas', () => {
    expect(
      SignedFeedbackSiteCard.safeParse({ ...signed, card: { ...signed.card, expiresAt: ISSUED } }).success,
    ).toBe(false);
    expect(
      SignedFeedbackSiteCard.safeParse({
        ...signed,
        card: { ...signed.card, allowedOrigins: ['https://A.example'] },
      }).success,
    ).toBe(false);
    expect(SignedFeedbackSiteCard.safeParse({ ...signed, extra: 1 }).success).toBe(false);
  });
});

describe('schemas of the drop', () => {
  it('bounds the plaintext frame evidence', () => {
    const base = JSON.parse(plaintextOf('hi'));
    expect(FeedbackDropPlaintext.safeParse(base).success).toBe(true);
    expect(FeedbackDropPlaintext.parse(base).submission.expected).toBe('');
    expect(FeedbackDropPlaintext.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(
      FeedbackDropPlaintext.safeParse({ ...base, frame: { ...base.frame, ancestorOrigins: null } }).success,
    ).toBe(true);
    expect(
      FeedbackDropPlaintext.safeParse({
        ...base,
        frame: { ...base.frame, ancestorOrigins: Array(9).fill('https://a.example') },
      }).success,
    ).toBe(false);
    expect(
      FeedbackDropPlaintext.safeParse({ ...base, frame: { ...base.frame, widget: '1 0' } }).success,
    ).toBe(false);
    // The wrapper stays well within FEEDBACK_DROP_WRAPPER_BYTES at its largest.
    const widest = {
      v: 1,
      submission: {},
      frame: {
        bridgeOrigin: 'x'.repeat(255),
        ancestorOrigins: Array(8).fill('x'.repeat(255)),
        widget: 'x'.repeat(32),
        cardSeq: Number.MAX_SAFE_INTEGER,
      },
    };
    expect(JSON.stringify(widest).length).toBeLessThan(4096);
  });

  it('describes headers and outcomes', () => {
    expect(
      FeedbackDropHeader.safeParse({
        kid: dropKeyId(recipient.publicKey),
        site: SITE,
        suite: FEEDBACK_DROP_SUITE,
        v: 1,
      }).success,
    ).toBe(true);
    expect(FeedbackDropOutcome.safeParse({ outcome: 'refused', code: 'undecryptable' }).success).toBe(true);
    expect(FeedbackDropOutcome.safeParse({ outcome: 'refused' }).success).toBe(false);
    expect(FeedbackDropOutcome.safeParse({ outcome: 'filed' }).success).toBe(true);
  });

  it('keeps health readable from older servers and words the warnings', () => {
    const health = FeedbackIntegrationHealth.parse({
      publicUrl: null,
      reportsLast24h: 0,
      lastReportAt: null,
      assessments: { queued: 0, running: 0, failed: 0, blocked: 0 },
      warnings: [{ code: 'drop_expired', message: feedbackDropExpiredText(2) }],
    });
    expect(health.delivery).toBeNull();
    expect(feedbackDropNotFiledText(1)).toBe('1 report from the last 7 days couldn’t be filed.');
    expect(feedbackDropNotFiledText(3)).toBe('3 reports from the last 7 days couldn’t be filed.');
    expect(feedbackDropExpiredText(1)).toMatch(/^1 report waited .* was deleted .* collected it\.$/);
    expect(feedbackDropExpiredText(4)).toMatch(/^4 reports waited .* were deleted .* collected them\.$/);
    expect(FEEDBACK_DROP_TEXT.unsupported).toBe(
      'Feedback needs an update of this Whombat’s cloud connection.',
    );
  });
});

describe('feedbackReferenceFor', () => {
  it('derives FB-XXXX-XXXX from the site and the submission id', () => {
    const ref = feedbackReferenceFor(SITE, 'q3Vx9LpA0dZkT7mW2bNcYe');
    expect(FeedbackReference.safeParse(ref).success).toBe(true);
    const digest = sha256(
      utf8ToBytes(`whombat-feedback-reference/1\u0000${SITE}\u0000q3Vx9LpA0dZkT7mW2bNcYe`),
    );
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const body = [...digest.subarray(0, 8)].map((b) => alphabet[b & 31]).join('');
    expect(ref).toBe(`FB-${body.slice(0, 4)}-${body.slice(4)}`);
    expect(feedbackReferenceFor(SITE, 'q3Vx9LpA0dZkT7mW2bNcYe')).toBe(ref);
    expect(feedbackReferenceFor(SITE, 'q3Vx9LpA0dZkT7mW2bNcYf')).not.toBe(ref);
    expect(feedbackReferenceFor('fbs_AAAAAAAAAAAAAAAAAAAAAAAA', 'q3Vx9LpA0dZkT7mW2bNcYe')).not.toBe(ref);
  });
});

describe('snippets with the embed origin and data-key', () => {
  const input = {
    publicUrl: 'https://app.whombat.com',
    embedUrl: 'https://embed.whombat.com/',
    siteId: SITE,
    siteKey: signing.fingerprint,
    theme: 'auto' as const,
    position: 'bottom-right' as const,
    launcher: 'floating' as const,
    launcherLabel: 'Feedback',
  };

  it('loads from the embed origin and pins the key', () => {
    expect(WIDGET_ATTRIBUTES.key).toBe('data-key');
    expect(snippetBase(input)).toBe('https://embed.whombat.com');
    expect(snippetBase({ publicUrl: 'https://w.example/', embedUrl: null })).toBe('https://w.example');
    expect(basicSnippet(input)).toBe(
      [
        '<script',
        '  src="https://embed.whombat.com/embed/v1/widget.js"',
        `  data-site="${SITE}"`,
        `  data-key="${signing.fingerprint}"`,
        '  data-theme="auto"',
        '  data-position="bottom-right"',
        '  defer',
        '></script>',
      ].join('\n'),
    );
    const custom = customLauncherSnippet(input);
    expect(custom).toContain('  src="https://embed.whombat.com/embed/v1/widget.js"');
    expect(custom).toContain(
      `  data-site="${SITE}"\n  data-key="${signing.fingerprint}"\n  data-theme="auto"`,
    );
    expect(cspAdvice(input)).toBe(
      'script-src https://embed.whombat.com; frame-src https://embed.whombat.com;',
    );
    expect(cspAdvice('https://w.example/')).toBe(
      'script-src https://w.example; frame-src https://w.example;',
    );
  });

  it('stays the self-hosted snippet without them', () => {
    const plain = basicSnippet({ ...input, embedUrl: undefined, siteKey: null });
    expect(plain).toContain('src="https://app.whombat.com/embed/v1/widget.js"');
    expect(plain).not.toContain('data-key');
  });
});
