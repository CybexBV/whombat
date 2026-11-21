import { describe, expect, it } from 'vitest';
import {
  at,
  auditPrincipal,
  BURROW_ID,
  dusty,
  GRANTS,
  mara,
  NOW,
  principal,
  secretKeyOf,
  TZ,
} from '../__fixtures__/world.js';
import { AuditEvent, EVENT_TYPES, EventEnvelope, GENESIS_HASH, SignedEvent } from '../domain/audit.js';
import { decide } from '../keys/engine.js';
import {
  AUDIT_KIND_FILTER_LABELS,
  AUDIT_KIND_FILTERS,
  appendEvent,
  askEventFields,
  auditCsv,
  auditCsvFileName,
  auditFields,
  auditLinkLabel,
  auditMeta,
  auditPill,
  auditTag,
  blockedEventFields,
  CanonicalJsonError,
  type ChainHead,
  canonicalJson,
  countAuditKinds,
  csvField,
  deriveSeedKeypair,
  type EventDraft,
  envelopeOf,
  filterAuditEvents,
  fingerprintOf,
  formatFingerprint,
  generateKeypair,
  groupAuditByDay,
  hashEnvelope,
  hexToBytes,
  keysEventFields,
  keyUsedFields,
  publicKeyOf,
  sha256Hex,
  signBytes,
  signEnvelope,
  signedByText,
  utf8ToBytes,
  verifyBytes,
  verifyChain,
  verifyEvent,
} from './index.js';

describe('canonical JSON (RFC 8785)', () => {
  it('matches the RFC 8785 §3.2.2 example', () => {
    const input = JSON.parse(
      '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/", "literals": [null, true, false]}',
    );
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts keys by UTF-16 code units (RFC 8785 §3.2.3 example)', () => {
    const input = JSON.parse(
      '{"\\u20ac": "Euro Sign", "\\r": "Carriage Return", "\\ufb33": "Hebrew Letter Dalet With Dagesh", "1": "One", "\\ud83d\\ude00": "Emoji: Grinning Face", "\\u0080": "Control", "\\u00f6": "Latin Small Letter O With Diaeresis"}',
    );
    // (Object.keys would list "1" first; the canonical text is what matters.)
    expect(canonicalJson(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it('serialises numbers like ECMAScript (RFC 8785 appendix B)', () => {
    const cases: [number, string][] = [
      [0, '0'],
      [-0, '0'],
      [5e-324, '5e-324'],
      [1.7976931348623157e308, '1.7976931348623157e+308'],
      [9007199254740992, '9007199254740992'],
      [-9007199254740992, '-9007199254740992'],
      [295147905179352830000, '295147905179352830000'],
      [1e21, '1e+21'],
      [0.000001, '0.000001'],
      [1e-7, '1e-7'],
      [4.5, '4.5'],
      [333333333.3333333, '333333333.3333333'],
    ];
    for (const [n, s] of cases) expect(canonicalJson(n)).toBe(s);
  });

  it('nests, omits undefined members and is key-order independent', () => {
    expect(canonicalJson({ b: [3, { z: 1, a: 2 }], a: 'x', u: undefined })).toBe(
      '{"a":"x","b":[3,{"a":2,"z":1}]}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson('Banjo’s key · −12 €')).toBe('"Banjo’s key · −12 €"');
  });

  it('rejects values JSON cannot represent', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson([1, undefined])).toThrow(CanonicalJsonError);
    expect(() => canonicalJson('\ud800')).toThrow(/Lone surrogate/);
    expect(() => canonicalJson({ '\udc00': 1 })).toThrow(/Lone surrogate/);
    expect(() => canonicalJson(new Date(0))).toThrow(/plain objects/);
    expect(() => canonicalJson(10n)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/at \.f/);
  });
});

describe('hashing and Ed25519', () => {
  it('computes sha256', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches RFC 8032 test vector 1', () => {
    const sk = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
    const pk = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
    const sig =
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
    expect(publicKeyOf(sk)).toBe(pk);
    expect(signBytes(new Uint8Array(0), sk)).toBe(sig);
    expect(verifyBytes(sig, new Uint8Array(0), pk)).toBe(true);
  });

  it('signs and verifies, and rejects tampering or wrong keys', () => {
    const kp = generateKeypair();
    const other = generateKeypair();
    const msg = utf8ToBytes('Pushed 7be20f to feat/invoice-pdf');
    const sig = signBytes(msg, kp.secretKey);
    expect(verifyBytes(sig, msg, kp.publicKey)).toBe(true);
    expect(verifyBytes(sig, utf8ToBytes('Pushed 7be20f to main'), kp.publicKey)).toBe(false);
    expect(verifyBytes(sig, msg, other.publicKey)).toBe(false);
    expect(verifyBytes('00', msg, kp.publicKey)).toBe(false);
    expect(verifyBytes(sig, msg, 'zz')).toBe(false);
  });

  it('derives stable seed keys and fingerprints', () => {
    const a = deriveSeedKeypair('prn_banjo');
    expect(deriveSeedKeypair('prn_banjo')).toEqual(a);
    expect(deriveSeedKeypair('prn_waffle').publicKey).not.toBe(a.publicKey);
    expect(deriveSeedKeypair('prn_banjo', 'other-seed').publicKey).not.toBe(a.publicKey);
    expect(publicKeyOf(a.secretKey)).toBe(a.publicKey);
    expect(fingerprintOf(a.publicKey)).toMatch(/^[0-9a-f]{4} [0-9a-f]{4}$/);
    expect(a.publicKey).toBe('0d40f2570dbd6d04c6633175ab2a7030d9dc6c6106029e015440b612d35e809b');
    for (const [id, fp] of Object.entries(SEED_FINGERPRINTS)) {
      expect(fingerprintOf(deriveSeedKeypair(id).publicKey)).toBe(fp);
    }
    expect(formatFingerprint('3FA9C1D2EE')).toBe('3fa9 c1d2');
  });
});

/** Fingerprints of seed ids (`deriveSeedKeypair(id)`), pinned so they never drift. */
const SEED_FINGERPRINTS: Record<string, string> = {
  prn_mara: '3e47 96d7',
  prn_toffee: '1a56 5c62',
  prn_banjo: '3bc7 859b',
  prn_dusty: '1035 d0ed',
  prn_waffle: '17d3 aed8',
  prn_neo: 'b047 f0ce',
  prn_muffin: 'e172 a583',
};

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    id: 'evt_9f31',
    burrowId: BURROW_ID,
    actorId: dusty.id,
    type: 'branch.pushed',
    kind: 'Code',
    text: 'Pushed 7be20f to feat/invoice-pdf',
    where: 'whombat/billing · PR #482',
    keyUsed: { id: 'branch.feature.readwrite', label: 'Read and write feat/* branches' },
    onBehalfOf: 'Mara’s review on PR #482',
    ref: { type: 'pr', number: 482 },
    payload: { sha: '7be20f', branch: 'feat/invoice-pdf' },
    createdAt: at('11:36'),
    ...overrides,
  };
}

function buildChain(n: number): SignedEvent[] {
  const events: SignedEvent[] = [];
  let head: ChainHead | null = null;
  const actors = [dusty, mara];
  for (let i = 0; i < n; i++) {
    const actor = actors[i % actors.length] ?? dusty;
    const e = appendEvent(
      head,
      draft({ id: `evt_${(0x9e00 + i).toString(16)}`, actorId: actor.id, text: `Event ${i}` }),
      secretKeyOf(actor.id),
    );
    events.push(e);
    head = { seq: e.seq, hash: e.hash };
  }
  return events;
}

const keysOf = (id: string) => principal(id)?.publicKey;

describe('signed events and the hash chain', () => {
  it('signs an envelope that validates against the schema', () => {
    const e = appendEvent(null, draft(), secretKeyOf(dusty.id));
    expect(e.seq).toBe(1);
    expect(e.prevHash).toBe(GENESIS_HASH);
    expect(e.v).toBe(1);
    expect(SignedEvent.parse(e)).toEqual(e);
    expect(EventEnvelope.parse(envelopeOf(e))).toEqual(envelopeOf(e));
    expect(e.hash).toBe(sha256Hex(canonicalJson(envelopeOf(e))));
    expect(e.signer).toBe(dusty.publicKey);
    expect(verifyBytes(e.sig, hexToBytes(e.hash), dusty.publicKey)).toBe(true);
    expect(verifyEvent(e, dusty.publicKey)).toEqual({ ok: true });
  });

  it('hashes only the envelope (read-model fields and undefined members do not count)', () => {
    const e = appendEvent(null, draft(), secretKeyOf(dusty.id));
    const view: AuditEvent = { ...e, fingerprint: dusty.fingerprint, verified: true, approval: null };
    expect(hashEnvelope(view)).toBe(e.hash);
    expect(verifyEvent(view as SignedEvent, dusty.publicKey)).toEqual({ ok: true });
    const withUndefined = { ...envelopeOf(e), keyNote: undefined };
    expect(hashEnvelope(withUndefined)).toBe(e.hash);
  });

  it('verifies a whole chain', () => {
    const chain = buildChain(6);
    expect(chain.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(chain[1]?.prevHash).toBe(chain[0]?.hash);
    const report = verifyChain(chain, { keysOf });
    expect(report).toMatchObject({ ok: true, checked: 6, failures: [] });
    expect(report.head).toEqual({ seq: 6, hash: chain[5]?.hash });
  });

  it('detects an edited event', () => {
    const chain = buildChain(4);
    const tampered = chain.map((e, i) => (i === 1 ? { ...e, text: 'Approved Dusty’s staging deploy' } : e));
    expect(verifyChain(tampered, { keysOf }).failures).toEqual([
      { seq: 2, id: chain[1]?.id, reason: 'hash_mismatch' },
    ]);
  });

  it('detects a re-hashed event without a valid signature', () => {
    const chain = buildChain(3);
    const edited = { ...chain[2], text: 'Nothing happened' } as SignedEvent;
    const rehashed = { ...edited, hash: hashEnvelope(edited) };
    const report = verifyChain([chain[0] as SignedEvent, chain[1] as SignedEvent, rehashed], { keysOf });
    expect(report.failures.map((f) => f.reason)).toEqual(['bad_signature']);
  });

  it('detects an event re-signed with someone else’s key', () => {
    const chain = buildChain(2);
    const forged = signEnvelope(
      { ...envelopeOf(chain[1] as SignedEvent), text: 'Forged' },
      secretKeyOf(dusty.id),
    );
    const report = verifyChain([chain[0] as SignedEvent, forged], { keysOf });
    expect(report.failures.map((f) => f.reason)).toContain('signer_mismatch');
    // A key nobody holds is caught too.
    expect(verifyEvent(forged, [])).toEqual({ ok: false, reason: 'unknown_signer' });
  });

  it('detects deleted, reordered and relinked events', () => {
    const chain = buildChain(5);
    const deleted = chain.filter((_, i) => i !== 2);
    expect(verifyChain(deleted, { keysOf }).failures.map((f) => f.reason)).toEqual(['seq_gap']);
    const reordered = [chain[0], chain[2], chain[1], chain[3], chain[4]] as SignedEvent[];
    expect(verifyChain(reordered, { keysOf }).ok).toBe(false);
    const relinked = chain.map((e, i) => (i === 3 ? { ...e, prevHash: GENESIS_HASH } : e));
    const reasons = verifyChain(relinked, { keysOf }).failures.map((f) => f.reason);
    expect(reasons).toContain('prev_hash_mismatch');
    expect(reasons).toContain('hash_mismatch');
  });

  it('verifies a window from a trusted head and checks the burrow', () => {
    const chain = buildChain(6);
    const head = { seq: 3, hash: chain[2]?.hash as string };
    expect(verifyChain(chain.slice(3), { keysOf, from: head }).ok).toBe(true);
    expect(verifyChain(chain.slice(3), { keysOf }).failures[0]?.reason).toBe('seq_gap');
    const moved = chain.map((e, i) => (i === 4 ? { ...e, burrowId: 'bur_other' } : e));
    expect(verifyChain(moved, { keysOf, burrowId: BURROW_ID }).failures.map((f) => f.reason)).toContain(
      'burrow_mismatch',
    );
  });
});

/* The mock LOG, as signed events (subset with every kind of row). */
function logEvent(
  ref: string,
  hhmm: string,
  actor: { id: string },
  extra: Partial<EventDraft> & Pick<EventDraft, 'kind' | 'text' | 'where' | 'type'>,
  day = 0,
  approval: AuditEvent['approval'] = null,
): AuditEvent {
  const e = signEnvelope(
    {
      v: 1,
      seq: 1,
      prevHash: GENESIS_HASH,
      ...draft({
        id: `evt_${ref}`,
        actorId: actor.id,
        createdAt: at(hhmm, -day),
        payload: {},
        ref: undefined,
        keyUsed: undefined,
        onBehalfOf: undefined,
        ...extra,
      }),
    },
    secretKeyOf(actor.id),
  );
  return { ...e, fingerprint: fingerprintOf(e.signer), verified: true, approval };
}

const LOG: AuditEvent[] = [
  logEvent('9f31', '11:36', dusty, {
    kind: 'Code',
    type: 'branch.pushed',
    text: 'Pushed 7be20f to feat/invoice-pdf',
    where: 'whombat/billing · PR #482',
    keyUsed: { id: 'branch.feature.readwrite', label: 'Read and write feat/* branches' },
    onBehalfOf: 'Mara’s review on PR #482',
    ref: { type: 'pr', number: 482 },
  }),
  logEvent(
    '9f18',
    '11:30',
    dusty,
    {
      kind: 'Asks',
      type: 'approval.requested',
      text: 'Asked to deploy feat/invoice-pdf to staging',
      where: 'Chat',
      keyUsed: { id: 'deploy.staging', label: 'Deploy to staging' },
      keyNote: 'asks a person first',
      onBehalfOf: 'Invoice PDF export plan, step 4',
      approvalId: 'apr_staging-482',
      ref: { type: 'approval', number: 12 },
    },
    0,
    { number: 12, state: 'pending', decidedById: null, decidedAt: null, executedAt: null },
  ),
  logEvent('9ea0', '10:40', mara, {
    kind: 'Messages',
    type: 'message.posted',
    text: 'Reported that customer 8812’s invoice is €0,01 off',
    where: 'Chat',
    ref: { type: 'dm' },
  }),
  logEvent(
    '9d77',
    '17:12',
    dusty,
    {
      kind: 'Asks',
      type: 'approval.requested',
      text: 'Asked to refund €24,00 on account 3310',
      where: 'Help widget',
      keyUsed: { id: 'refunds.issue', label: 'Issue refunds' },
      keyNote: 'asks a person first',
      onBehalfOf: 'Customer conversation #5521',
      decided: { byId: mara.id, at: at('17:20', -1), decision: 'approved' },
    },
    1,
  ),
  logEvent(
    '9d52',
    '16:40',
    mara,
    {
      kind: 'Keys',
      type: 'keys.granted',
      text: 'Gave Dusty a new key: Run tests',
      where: 'Settings · Agent',
      aboutId: dusty.id,
    },
    1,
  ),
  logEvent(
    '9d31',
    '15:08',
    dusty,
    {
      kind: 'Blocked',
      type: 'action.blocked',
      text: 'Tried to merge PR #479 into main. Blocked.',
      where: 'whombat/billing · PR #479',
      keyUsed: { id: 'merge.main', label: 'Merge into main' },
      keyNote: 'not one of Dusty’s keys',
      onBehalfOf: 'Mara’s approval on PR #479',
    },
    1,
  ),
];

const isAgent = (id: string) => principal(id)?.kind === 'agent';
const dctx = { principal: auditPrincipal, now: NOW, timeZone: TZ };

describe('audit log read side', () => {
  it('filters by actor, kind and "Only X", counting over the actor/who base', () => {
    expect(countAuditKinds(LOG, { actor: 'everyone', whoId: null }, isAgent)).toEqual({
      all: 6,
      code: 1,
      asks: 2,
      keys: 1,
      vault: 0,
      messages: 1,
      blocked: 1,
    });
    expect(
      filterAuditEvents(LOG, { actor: 'people', kind: 'all', whoId: null }, isAgent).map((e) => e.id),
    ).toEqual(['evt_9ea0', 'evt_9d52']);
    expect(
      filterAuditEvents(LOG, { actor: 'agents', kind: 'asks', whoId: null }, isAgent).map((e) => e.id),
    ).toEqual(['evt_9f18', 'evt_9d77']);
    // "Only Dusty" matches events by Dusty and about Dusty (Mara's key change).
    expect(
      filterAuditEvents(LOG, { actor: 'everyone', kind: 'all', whoId: dusty.id }, isAgent).map((e) => e.id),
    ).toEqual(['evt_9f31', 'evt_9f18', 'evt_9d77', 'evt_9d52', 'evt_9d31']);
    expect(countAuditKinds(LOG, { actor: 'everyone', whoId: dusty.id }, isAgent).blocked).toBe(1);
    expect(
      filterAuditEvents(LOG, { actor: 'everyone', kind: 'all', whoId: mara.id }, isAgent).map((e) => e.id),
    ).toEqual(['evt_9ea0', 'evt_9d52']);
    const hidden = { ...LOG[0], text: null } as AuditEvent;
    expect(filterAuditEvents([hidden], { actor: 'everyone', kind: 'all', whoId: null }, isAgent)).toEqual([]);
  });

  it('groups by day with the log labels', () => {
    const days = groupAuditByDay(LOG, NOW, TZ);
    expect(days.map((d) => [d.label, d.events.length])).toEqual([
      ['TODAY · 23 SEP', 3],
      ['YESTERDAY · 22 SEP', 3],
    ]);
  });

  it('renders row parts', () => {
    const [push] = LOG;
    const p = auditPrincipal(dusty.id);
    if (!push || !p) throw new Error('fixture');
    expect(auditTag(p)).toBe('AGENT');
    expect(auditTag({ kind: 'person', name: 'Mara Okafor', shortName: 'Mara' })).toBe('PERSON');
    expect(auditMeta(push)).toBe('whombat/billing · PR #482 · e-9f31');
    expect(signedByText(p, '3fa9 c1d2')).toBe('Dusty’s agent key · 3fa9 c1d2');
    expect(signedByText({ kind: 'person', name: 'Mara Okafor', shortName: 'Mara' }, '3fa9 c1d2')).toBe(
      'Mara Okafor · personal key · 3fa9 c1d2',
    );
    expect(auditPill(push, dctx)).toBeNull();
  });

  it('expands a pending ask like the mock (e-9f18)', () => {
    const ask = LOG[1] as AuditEvent;
    expect(auditPill(ask, dctx)).toEqual({ text: 'WAITING ON A PERSON', tone: 'warn' });
    expect(auditFields(ask, dctx).map((f) => [f.label, f.value])).toEqual([
      ['SIGNED BY', `Dusty’s agent key · ${dusty.fingerprint}`],
      ['KEY USED', 'Deploy to staging · asks a person first'],
      ['ON BEHALF OF', 'Invoice PDF export plan, step 4'],
      ['DECIDED', 'Nobody yet. Dusty is holding the deploy.'],
      ['EVENT', 'e-9f18 · signature verified'],
    ]);
    const approved: AuditEvent = {
      ...ask,
      approval: { number: 12, state: 'approved', decidedById: mara.id, decidedAt: NOW, executedAt: null },
    };
    expect(auditPill(approved, dctx)).toEqual({ text: 'APPROVED BY MARA', tone: 'ok' });
    expect(auditFields(approved, dctx).find((f) => f.label === 'DECIDED')?.value).toBe(
      'Mara Okafor approved just now',
    );
    const declined: AuditEvent = {
      ...ask,
      approval: { number: 12, state: 'declined', decidedById: mara.id, decidedAt: NOW, executedAt: null },
    };
    expect(auditPill(declined, dctx)).toEqual({ text: 'DECLINED BY MARA', tone: 'bad' });
  });

  it('expands a decided ask (e-9d77) and a blocked attempt (e-9d31)', () => {
    const refund = LOG[3] as AuditEvent;
    expect(auditPill(refund, dctx)).toEqual({ text: 'APPROVED BY MARA', tone: 'ok' });
    expect(auditFields(refund, dctx).find((f) => f.label === 'DECIDED')?.value).toBe(
      'Mara Okafor approved at 17:20',
    );
    const blocked = LOG[5] as AuditEvent;
    expect(auditPill(blocked, dctx)).toEqual({ text: 'BLOCKED', tone: 'bad' });
    expect(auditFields(blocked, dctx).find((f) => f.label === 'KEY IT NEEDED')).toEqual({
      label: 'KEY IT NEEDED',
      value: 'Merge into main · not one of Dusty’s keys',
      tone: 'bad',
    });
    const person = LOG[2] as AuditEvent;
    expect(auditFields(person, dctx)[0]?.value).toBe(`Mara Okafor · personal key · ${mara.fingerprint}`);
    expect(auditFields({ ...person, verified: false }, dctx).at(-1)).toEqual({
      label: 'EVENT',
      value: 'e-9ea0 · signature does not verify',
      tone: 'bad',
    });
  });

  it('labels deep links', () => {
    expect(auditLinkLabel({ type: 'pr', number: 482 })).toBe('Open PR #482');
    expect(auditLinkLabel({ type: 'run', number: 1907 })).toBe('Open run');
    expect(auditLinkLabel({ type: 'approval', number: 12 }, { approvalPending: true })).toBe(
      'Review the request',
    );
    expect(auditLinkLabel({ type: 'approval', number: 12 })).toBe('Open the request');
    expect(auditLinkLabel({ type: 'dm' })).toBe('Open the chat');
    expect(auditLinkLabel({ type: 'dm', room: 'feedback' })).toBe('Open Feedback');
    expect(auditLinkLabel({ type: 'canvas', slug: 'invoice-pdf-export-plan' })).toBe('Open canvas');
  });

  it('exports CSV with quoting and formula guards', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvField(null)).toBe('');
    expect(csvField(42)).toBe('42');
    const csv = auditCsv(LOG, dctx);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'event,time,actor,actor_type,kind,type,text,where,key,key_note,on_behalf_of,decided,fingerprint,verified,seq,hash,signature,vault',
    );
    expect(lines).toHaveLength(LOG.length + 1);
    expect(lines[1]?.startsWith('e-9f31,2026-09-23T09:36:00.000Z,Dusty,agent,Code,branch.pushed,')).toBe(
      true,
    );
    expect(lines[1]?.endsWith(',')).toBe(true);
    expect(auditCsvFileName('burrow-hq', NOW, TZ)).toBe('burrow-hq-audit-2026-09-23.csv');
  });

  it('files Vault events under their own chip and shows the person’s detail only when it is there (VT-50, VT-52)', () => {
    const used = logEvent('9f50', '11:40', dusty, {
      kind: 'Vault',
      type: 'vault.used',
      text: 'Used a private Vault entry',
      where: 'Chat',
      onBehalfOf: 'Mara',
    });
    const refused = logEvent('9f51', '11:41', dusty, {
      kind: 'Blocked',
      type: 'vault.refused',
      text: 'Couldn’t use a private Vault entry',
      where: 'Chat',
    });
    const log = [used, refused, ...LOG];
    expect(countAuditKinds(log, { actor: 'everyone', whoId: null }, isAgent)).toMatchObject({
      all: 8,
      vault: 1,
      blocked: 2,
    });
    expect(filterAuditEvents(log, { actor: 'everyone', kind: 'vault', whoId: null }, isAgent)).toEqual([
      used,
    ]);
    expect(AUDIT_KIND_FILTER_LABELS.vault).toBe('Vault');
    expect(AUDIT_KIND_FILTERS.indexOf('vault')).toBe(AUDIT_KIND_FILTERS.indexOf('keys') + 1);
    expect(EVENT_TYPES['vault.used']).toBe('Vault');
    expect(EVENT_TYPES['vault.refused']).toBe('Blocked');
    expect(EVENT_TYPES['browser.used']).toBe('System');
    // Without the detail: neutral text, no VAULT field, no detail in the CSV.
    expect(auditFields(used, dctx).map((f) => f.label)).toEqual(['SIGNED BY', 'ON BEHALF OF', 'EVENT']);
    expect(auditPill(used, dctx)).toBeNull();
    expect(auditPill(refused, dctx)).toEqual({ text: 'BLOCKED', tone: 'bad' });
    // The person's view carries the detail.
    const owners = {
      ...used,
      vault: { entryId: 'vlt_ha', entryName: 'Home Assistant', what: 'HassTurnOn', outcome: 'done' as const },
    };
    expect(AuditEvent.parse(owners).vault?.entryName).toBe('Home Assistant');
    expect(auditFields(owners, dctx).find((f) => f.label === 'VAULT')?.value).toBe(
      'Used “Home Assistant” · HassTurnOn · done',
    );
    const csv = auditCsv([owners, used], dctx).trimEnd().split('\r\n');
    expect(csv[1]?.endsWith(',Used “Home Assistant” · HassTurnOn · done')).toBe(true);
    expect(csv[2]?.endsWith(',')).toBe(true);
  });
});

describe('event drafts from keys engine outcomes', () => {
  it('builds Blocked, Asks, Keys and key-used fields like the log', () => {
    // Without the Merge key (the defaults ask before it).
    const blocked = decide({ id: dusty.id, kind: 'agent' }, [], 'merge.main');
    expect(blockedEventFields(blocked, 'Dusty', 'merge PR #479 into main')).toEqual({
      kind: 'Blocked',
      type: 'action.blocked',
      text: 'Tried to merge PR #479 into main. Blocked.',
      keyUsed: { id: 'merge.main', label: 'Merge into main' },
      keyNote: 'not one of Dusty’s keys',
    });
    const ask = decide({ id: dusty.id, kind: 'agent' }, GRANTS, 'deploy.staging');
    expect(
      askEventFields(ask, 'Dusty', {
        type: 'deploy',
        params: { environment: 'staging', service: 'billing-api', ref: 'feat/invoice-pdf', sha: null },
      }),
    ).toEqual({
      kind: 'Asks',
      type: 'approval.requested',
      text: 'Asked to deploy feat/invoice-pdf to staging',
      keyUsed: { id: 'deploy.staging', label: 'Deploy to staging' },
      keyNote: 'asks a person first',
    });
    expect(keysEventFields('Dusty', { keyId: 'tests.run', kind: 'added', from: null, to: 'can' })).toEqual({
      kind: 'Keys',
      type: 'keys.granted',
      text: 'Gave Dusty a new key: Run tests',
    });
    expect(keyUsedFields(decide({ id: dusty.id, kind: 'agent' }, GRANTS, 'tests.run'))).toEqual({
      keyUsed: { id: 'tests.run', label: 'Run tests' },
    });
  });
});
