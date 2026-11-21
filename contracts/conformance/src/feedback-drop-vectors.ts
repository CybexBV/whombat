/**
 * `vectors/feedback-drop.json` (CT-91): RFC 9180 A.1.1 (the drop's suite, base mode), envelopes sealed with a fixed
 * ephemeral key in every padding class, tampered envelopes, signed site cards (with the ones a lax verifier would
 * accept), `feedbackReferenceFor` and `padLength`. Checked by Vitest; the Go module doesn't open drops (FD-13), so
 * nothing in Go reads this file.
 */
import { canonicalJson, sha256Hex } from '@whombat/core/audit';
import type { FeedbackPublicConfig, FeedbackSiteCard } from '@whombat/core/domain';
import {
  deriveKeyPair,
  dropKeyId,
  encodeDropHeader,
  FEEDBACK_CARD_MAX_LIFETIME_S,
  FEEDBACK_DROP_SUITE,
  FEEDBACK_SITE_CARD_PURPOSE,
  feedbackReferenceFor,
  padLength,
  parseDropHeader,
  type SiteCardError,
  sealDropEnvelope,
  signSiteCard,
  siteSigningKeyOf,
  verifySiteCard,
} from '@whombat/core/feedback/drop';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const seed = (n: number) => new Uint8Array(32).fill(n);

/** RFC 9180 Appendix A.1.1, transcribed once. */
export const RFC9180_A11 = {
  mode: 0,
  kemId: 32,
  kdfId: 1,
  aeadId: 1,
  info: '4f6465206f6e2061204772656369616e2055726e',
  ikmE: '7268600d403fce431561aef583ee1613527cff655c1343f29812e66706df3234',
  pkEm: '37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431',
  skEm: '52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736',
  ikmR: '6db9df30aa07dd42ee5e8181afdb977e538f5e1fec8a06223f33f7013e525037',
  pkRm: '3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d',
  skRm: '4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8',
  enc: '37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431',
  sharedSecret: 'fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc',
  keyScheduleContext:
    '00725611c9d98c07c03f60095cd32d400d8347d45ed67097bbad50fc56da742d07cb6cffde367bb0565ba28bb02c90744a20f5ef37f30523526106f637abb05449',
  secret: '12fff91991e93b48de37e7daddb52981084bd8aa64289c3788471d9a9712f397',
  key: '4531685d41d65f03dc48f6b8302c05b0',
  baseNonce: '56d890e5accaaf011cff4b7d',
  exporterSecret: '45ff1c2e220db587171952c0592d5f5ebe103f1561a2614e38f2ffd47e99e3f8',
  encryptions: [
    {
      seq: 0,
      pt: '4265617574792069732074727574682c20747275746820626561757479',
      aad: '436f756e742d30',
      nonce: '56d890e5accaaf011cff4b7d',
      ct: 'f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a',
    },
    {
      seq: 1,
      pt: '4265617574792069732074727574682c20747275746820626561757479',
      aad: '436f756e742d31',
      nonce: '56d890e5accaaf011cff4b7c',
      ct: 'af2d7e9ac9ae7e270f46ba1f975be53c09f8d875bdc8535458c2494e8a6eab251c03d0c22a56b8ca42c2063b84',
    },
    {
      seq: 2,
      pt: '4265617574792069732074727574682c20747275746820626561757479',
      aad: '436f756e742d32',
      nonce: '56d890e5accaaf011cff4b7f',
      ct: '498dfcabd92e8acedc281e85af1cb4e3e31c7dc394a1ca20e173cb72516491588d96a19ad4a683518973dcc180',
    },
    {
      seq: 4,
      pt: '4265617574792069732074727574682c20747275746820626561757479',
      aad: '436f756e742d34',
      nonce: '56d890e5accaaf011cff4b79',
      ct: '583bd32bc67a5994bb8ceaca813d369bca7b2a42408cddef5e22f880b631215a09fc0012bc69fccaa251c0246d',
    },
    {
      seq: 255,
      pt: '4265617574792069732074727574682c20747275746820626561757479',
      aad: '436f756e742d323535',
      nonce: '56d890e5accaaf011cff4b82',
      ct: '7175db9717964058640a3a11fb9007941a5d1757fda1a6935c805c21af32505bf106deefec4a49ac38d71c9e0a',
    },
    {
      seq: 256,
      pt: '4265617574792069732074727574682c20747275746820626561757479',
      aad: '436f756e742d323536',
      nonce: '56d890e5accaaf011cff4a7d',
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

const SITE = 'fbs_Q3v9xLpA0dZkT7mW2bNcYe12';
const ISSUED = 1_790_467_200;
export const VECTOR_SIGNING = siteSigningKeyOf(seed(0x51));
export const VECTOR_RECIPIENT = deriveKeyPair(seed(0x52));

const CONFIG: FeedbackPublicConfig = {
  productLabel: 'Café “Lumio” <b>&amp;</b> 😀',
  reportTypes: ['bug', 'feature'],
  theme: 'auto',
  position: 'bottom-right',
  launcher: 'floating',
  launcherLabel: 'Feedback',
  privacyUrl: 'https://lumio.example/privacy',
  contactFields: { name: 'optional', email: 'off' },
  attachments: { max: 3, maxBytes: 3_145_728, types: ['image/png', 'image/jpeg'] },
  text: { description: 5000, expected: 3000, steps: 3000 },
  redactPaths: ['/customers/*'],
  contextKeys: ['plan'],
};

/** A well-formed card for the vectors (deterministic keys). */
export function vectorCard(over: Partial<FeedbackSiteCard> = {}): FeedbackSiteCard {
  return {
    purpose: FEEDBACK_SITE_CARD_PURPOSE,
    v: 1,
    site: SITE,
    seq: 17,
    issuedAt: ISSUED,
    expiresAt: ISSUED + FEEDBACK_CARD_MAX_LIFETIME_S,
    allowedOrigins: ['https://billing.lumio.example', 'http://localhost:5173'],
    config: CONFIG,
    limits: { maxEnvelopeBytes: 13_107_200, reportsPerHour: 30, reportsPerDay: 200, perSourcePerHour: 5 },
    encryption: {
      suite: FEEDBACK_DROP_SUITE,
      kid: dropKeyId(VECTOR_RECIPIENT.publicKey),
      publicKey: b64(VECTOR_RECIPIENT.publicKey),
    },
    signingKey: VECTOR_SIGNING.publicKey,
    ...over,
  };
}

function plaintextOf(descriptionLength: number): string {
  return JSON.stringify({
    v: 1,
    submission: {
      submissionId: 'q3Vx9LpA0dZkT7mW2bNcYe',
      parentOrigin: 'https://billing.lumio.example',
      type: 'bug',
      description: 'x'.repeat(descriptionLength),
      reporter: { name: 'Zoë', email: '' },
    },
    frame: {
      bridgeOrigin: 'https://billing.lumio.example',
      ancestorOrigins: ['https://billing.lumio.example'],
      widget: '1.1.0',
      cardSeq: 17,
    },
  });
}

const L_ED = 2n ** 252n + 27742317777372353535851937790883648493n;
function nonCanonicalS(sig: Uint8Array): Uint8Array {
  const out = Uint8Array.from(sig);
  let S = 0n;
  for (let i = 63; i >= 32; i--) S = (S << 8n) | BigInt(out[i] as number);
  S += L_ED;
  for (let i = 32; i < 64; i++) {
    out[i] = Number(S & 0xffn);
    S >>= 8n;
  }
  return out;
}

export async function feedbackDropVectors() {
  const ikmE = seed(0x53);
  const card = vectorCard();
  const signed = signSiteCard(card, VECTOR_SIGNING.seed);

  // One envelope per padding class; the small ones in full, the large ones by length and digest.
  const envelopes = [];
  for (const [name, descriptionLength, full] of [
    ['4 KiB', 100, true],
    ['16 KiB', 10_000, true],
    ['64 KiB', 60_000, false],
    ['256 KiB', 100_000, false],
  ] as const) {
    const plaintextJson = plaintextOf(descriptionLength);
    const envelope = await sealDropEnvelope(card, plaintextJson, ikmE);
    envelopes.push({
      name,
      descriptionLength,
      plaintextLength: Buffer.byteLength(plaintextJson),
      paddedLength: padLength(4 + Buffer.byteLength(plaintextJson)),
      length: envelope.length,
      sha256: sha256Hex(envelope),
      ...(full ? { envelope: b64(envelope) } : {}),
    });
  }

  // Tampered variants of the 4 KiB envelope, and what opening them must say.
  const base = await sealDropEnvelope(card, plaintextOf(100), ikmE);
  const H = (base[0] as number) * 256 + (base[1] as number);
  const header = parseDropHeader(base).header;
  const flip = (i: number) => {
    const t = Uint8Array.from(base);
    t[i] = (t[i] as number) ^ 1;
    return t;
  };
  const withHeader = (bytes: Uint8Array) =>
    Uint8Array.from([bytes.length >> 8, bytes.length & 255, ...bytes, ...base.subarray(2 + H)]);
  const text = (s: string) => new TextEncoder().encode(s);
  const tampered: { name: string; envelope: Uint8Array; expect: string }[] = [
    { name: 'intact', envelope: base, expect: 'ok' },
    { name: 'enc flipped', envelope: flip(2 + H), expect: 'undecryptable' },
    { name: 'ciphertext flipped', envelope: flip(2 + H + 32 + 10), expect: 'undecryptable' },
    { name: 'tag flipped', envelope: flip(base.length - 1), expect: 'undecryptable' },
    {
      name: 'header names another site',
      envelope: withHeader(encodeDropHeader({ ...header, site: 'fbs_AAAAAAAAAAAAAAAAAAAAAAAA' })),
      expect: 'undecryptable',
    },
    {
      name: 'header names an unknown kid',
      envelope: withHeader(encodeDropHeader({ ...header, kid: 'fdk_AAAAAAAAAAAAAAAA' })),
      expect: 'unknown_key',
    },
    {
      name: 'header not canonical',
      envelope: withHeader(
        text(JSON.stringify({ v: 1, suite: header.suite, site: header.site, kid: header.kid })),
      ),
      expect: 'malformed',
    },
    {
      name: 'header version 2',
      envelope: withHeader(text(canonicalJson({ ...header, v: 2 }))),
      expect: 'malformed',
    },
    {
      name: 'unknown suite',
      envelope: withHeader(
        text(canonicalJson({ ...header, suite: 'hpke-base-x25519-sha256-chacha20poly1305' })),
      ),
      expect: 'malformed',
    },
    { name: 'truncated', envelope: base.subarray(0, base.length - 1), expect: 'malformed' },
    {
      name: 'header length 15',
      envelope: Uint8Array.from([0, 15, ...base.subarray(2)]),
      expect: 'malformed',
    },
  ];

  // Cards.
  const other = siteSigningKeyOf(seed(0x54));
  const identity = Uint8Array.from([1, ...new Uint8Array(31)]);
  const smallOrderCard = vectorCard({ signingKey: b64(identity) });
  const cardCases: {
    name: string;
    signed: unknown;
    expectedKey: string | null;
    expect: 'ok' | SiteCardError;
  }[] = [
    { name: 'valid, pinned', signed, expectedKey: VECTOR_SIGNING.fingerprint, expect: 'ok' },
    { name: 'valid, unpinned', signed, expectedKey: null, expect: 'ok' },
    { name: 'another pin', signed, expectedKey: other.fingerprint, expect: 'wrong_key' },
    {
      name: 'swapped encryption key, re-signed by another key',
      signed: signSiteCard(
        vectorCard({
          encryption: {
            suite: FEEDBACK_DROP_SUITE,
            kid: dropKeyId(deriveKeyPair(seed(0x55)).publicKey),
            publicKey: b64(deriveKeyPair(seed(0x55)).publicKey),
          },
          signingKey: other.publicKey,
        }),
        other.seed,
      ),
      expectedKey: VECTOR_SIGNING.fingerprint,
      expect: 'wrong_key',
    },
    {
      name: 'seq changed',
      signed: { ...signed, card: { ...card, seq: 18 } },
      expectedKey: null,
      expect: 'bad_signature',
    },
    {
      name: 'origin added',
      signed: {
        ...signed,
        card: { ...card, allowedOrigins: [...card.allowedOrigins, 'https://evil.example'] },
      },
      expectedKey: null,
      expect: 'bad_signature',
    },
    {
      name: 'non-canonical S (S + L)',
      signed: { ...signed, sig: b64(nonCanonicalS(Buffer.from(signed.sig, 'base64url'))) },
      expectedKey: null,
      expect: 'bad_signature',
    },
    {
      name: 'small-order key, identity R, S = 0 (ZIP-215 accepts)',
      signed: { card: smallOrderCard, sig: b64(Uint8Array.from([...identity, ...new Uint8Array(32)])) },
      expectedKey: null,
      expect: 'bad_signature',
    },
    {
      name: 'extra member',
      signed: { ...signed, card: { ...card, extra: 1 } },
      expectedKey: null,
      expect: 'bad_card',
    },
    {
      name: 'lives longer than 14 days',
      signed: { ...signed, card: { ...card, expiresAt: card.expiresAt + 1 } },
      expectedKey: null,
      expect: 'bad_card',
    },
    {
      name: 'kid of another key',
      signed: {
        ...signed,
        card: { ...card, encryption: { ...card.encryption, kid: 'fdk_AAAAAAAAAAAAAAAA' } },
      },
      expectedKey: null,
      expect: 'bad_card',
    },
    {
      name: 'origin not canonical',
      signed: { ...signed, card: { ...card, allowedOrigins: ['https://Billing.lumio.example'] } },
      expectedKey: null,
      expect: 'bad_card',
    },
    {
      name: 'over 16 KiB',
      signed: { ...signed, card: { ...card, config: { ...CONFIG, productLabel: 'x'.repeat(17_000) } } },
      expectedKey: null,
      expect: 'too_large',
    },
  ];
  for (const c of cardCases) {
    const got = verifySiteCard(c.signed, c.expectedKey);
    if ((got.ok ? 'ok' : got.error) !== c.expect)
      throw new Error(`card vector ${c.name}: ${JSON.stringify(got)}`);
  }

  return {
    description:
      'The encrypted feedback drop (CT-91, Whombat FD-13 … FD-16): RFC 9180 A.1.1, envelopes sealed with the fixed `ikmE` (base64url, or length + sha256 for the large classes; the plaintext is `plaintextOf(descriptionLength)` in conformance/src/feedback-drop-vectors.ts), tampered envelopes with the error opening them must give (`privateKeyFor` knows only the recipient), signed site cards with `verifySiteCard`’s answer, references and padding.',
    rfc9180: RFC9180_A11,
    suite: FEEDBACK_DROP_SUITE,
    recipient: { privateKey: hex(VECTOR_RECIPIENT.privateKey), publicKey: hex(VECTOR_RECIPIENT.publicKey) },
    ikmE: hex(ikmE),
    card: signed,
    cardSigningBytes: canonicalJson(card),
    fingerprint: VECTOR_SIGNING.fingerprint,
    kid: card.encryption.kid,
    envelopes,
    tampered: tampered.map((t) => ({ name: t.name, envelope: b64(t.envelope), expect: t.expect })),
    cards: cardCases,
    references: [
      ['q3Vx9LpA0dZkT7mW2bNcYe', SITE],
      ['q3Vx9LpA0dZkT7mW2bNcYf', SITE],
      ['q3Vx9LpA0dZkT7mW2bNcYe', 'fbs_AAAAAAAAAAAAAAAAAAAAAAAA'],
      ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', SITE],
    ].map(([submissionId, site]) => ({
      site,
      submissionId,
      reference: feedbackReferenceFor(site as string, submissionId as string),
    })),
    padLength: [0, 4096, 4097, 16_384, 16_385, 65_536, 65_537, 262_144, 262_145].map((n) => ({
      n,
      padded: padLength(n),
    })),
  };
}

export { plaintextOf as feedbackVectorPlaintext };
