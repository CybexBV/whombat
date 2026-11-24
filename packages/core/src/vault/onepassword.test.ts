/**
 * The 1Password sync's pure parts (docs/decisions/onepassword-sync.md): reading items, comparing by meaning, writing a
 * change into an item without losing what only 1Password holds, the marker, deciding a pair, the guard and the limit's
 * wait.
 */
import { describe, expect, it } from 'vitest';
import {
  applyOnePasswordProjection,
  decideOnePasswordPair,
  newOnePasswordItem,
  ONEPASSWORD_GUARD_MAX_REMOVALS,
  ONEPASSWORD_LIMIT_WAIT_MAX_MS,
  ONEPASSWORD_SYNC_FIELDS,
  type OnePasswordDigests,
  OnePasswordItem,
  type OnePasswordProjection,
  onePasswordAddress,
  onePasswordCanonical,
  onePasswordChangedFields,
  onePasswordEntryAuth,
  onePasswordEntryEligible,
  onePasswordEntryName,
  onePasswordEntryProjection,
  onePasswordItemMarker,
  onePasswordItemProjection,
  onePasswordLimitWaitMs,
  onePasswordRemovalGuard,
  onePasswordTotpFieldId,
  onePasswordTotpValue,
  writeOnePasswordItem,
} from './onepassword.js';
import { parseVaultTotp, vaultTotpCanonical } from './totp.js';

const KEY = 'JBSWY3DPEHPK3PXP';
const KEY2 = 'KRSXG5CTMVRXEZLUKN2XAZLSKNSWG4TF';
const ENTRY = 'vlt_entry1';
const canonicalKey = (k: string) => {
  const parsed = parseVaultTotp(k);
  if (!parsed.ok) throw new Error('key');
  return vaultTotpCanonical(parsed.totp);
};

function login(over: Partial<OnePasswordItem> = {}): OnePasswordItem {
  return OnePasswordItem.parse({
    id: 'fmx3tsd5v5bew74o3v2z2a7wf4',
    title: 'Grafana',
    category: 'Login',
    vaultId: 'v4ultv4ultv4ultv4ultv4ultv',
    fields: [
      { id: 'username', title: 'username', fieldType: 'Text', value: 'mara@example.com' },
      { id: 'password', title: 'password', fieldType: 'Concealed', value: 'hunter2' },
      {
        id: 'otp1',
        title: 'one-time password',
        sectionId: 'add more',
        fieldType: 'Totp',
        value: `otpauth://totp/Grafana:mara?secret=${KEY}&issuer=Grafana`,
        details: { type: 'Otp', content: { code: '123456' } },
      },
      {
        id: 'recovery',
        title: 'recovery codes',
        sectionId: 'add more',
        fieldType: 'Concealed',
        value: 'a b c',
      },
    ],
    sections: [{ id: 'add more', title: '' }],
    notes: 'kept in 1Password only',
    tags: ['work'],
    websites: [
      { url: 'https://grafana.example.com/login', label: 'website', autofillBehavior: 'AnywhereOnWebsite' },
      { url: 'https://other.example.com', label: 'other', autofillBehavior: 'Never' },
    ],
    version: 7,
    files: [{ attributes: { id: 'f1', name: 'a.txt', size: 3 }, sectionId: 'add more', fieldId: 'file1' }],
    createdAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-24T09:00:00.000Z',
    ...over,
  });
}

function apiCredential(over: Partial<OnePasswordItem> = {}): OnePasswordItem {
  return OnePasswordItem.parse({
    id: 'apicredapicredapicredapicr',
    title: 'Hetzner API',
    category: 'ApiCredentials',
    vaultId: 'v4ultv4ultv4ultv4ultv4ultv',
    fields: [
      { id: 'credential', title: 'credential', fieldType: 'Concealed', value: 'tok_123' },
      { id: 'hostname', title: 'hostname', fieldType: 'Text', value: 'api.example.com' },
      { id: 'type', title: 'type', fieldType: 'Menu', value: 'bearer' },
    ],
    sections: [],
    notes: '',
    tags: [],
    websites: [],
    version: 2,
    files: [],
    createdAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-24T09:00:00.000Z',
    ...over,
  });
}

const projectionOf = (item: OnePasswordItem): OnePasswordProjection => {
  const reading = onePasswordItemProjection(item);
  if (!reading.ok) throw new Error(reading.reason);
  return reading.projection;
};

const field = (item: Pick<OnePasswordItem, 'fields'>, id: string) => item.fields.find((f) => f.id === id);

describe('reading an item', () => {
  it('reads a Login: first website, username, password, the first one-time password as the Vault seals it', () => {
    const reading = onePasswordItemProjection(login());
    expect(reading).toEqual({
      ok: true,
      projection: {
        kind: 'login',
        name: 'Grafana',
        url: 'https://grafana.example.com/login',
        username: 'mara@example.com',
        secret: 'hunter2',
        totp: canonicalKey(KEY),
      },
      nameShortened: false,
    });
  });

  it('reads an API Credential: hostname with https://, credential, bearer without a username, basic with one', () => {
    expect(projectionOf(apiCredential())).toEqual({
      kind: 'http',
      name: 'Hetzner API',
      url: 'https://api.example.com',
      username: null,
      secret: 'tok_123',
      totp: null,
    });
    const basic = apiCredential({
      fields: [
        ...apiCredential().fields,
        { id: 'username', title: 'username', fieldType: 'Text', value: 'ops' },
      ],
    });
    expect(projectionOf(basic).username).toBe('ops');
  });

  it('keeps SSH keys and other kinds in 1Password, and says why each item that doesn’t fit stays out', () => {
    const reason = (item: OnePasswordItem) => {
      const r = onePasswordItemProjection(item);
      return r.ok ? null : r.reason;
    };
    expect(reason(login({ category: 'SshKey' }))).toBe('ssh_key');
    expect(reason(login({ category: 'SecureNote' }))).toBe('other_kind');
    expect(reason(login({ category: 'Password' }))).toBe('other_kind');
    expect(reason(login({ websites: [] }))).toBe('no_website');
    expect(reason(login({ websites: [{ url: ' ', label: 'website', autofillBehavior: 'Never' }] }))).toBe(
      'no_website',
    );
    expect(reason(apiCredential({ fields: apiCredential().fields.filter((f) => f.id !== 'hostname') }))).toBe(
      'no_hostname',
    );
    expect(reason(login({ fields: login().fields.filter((f) => f.id !== 'password') }))).toBe('no_password');
    expect(
      reason(apiCredential({ fields: apiCredential().fields.filter((f) => f.id !== 'credential') })),
    ).toBe('no_credential');
    expect(reason(login({ fields: login().fields.filter((f) => f.id !== 'username') }))).toBe('no_username');
    expect(
      reason(login({ websites: [{ url: 'ftp://files.example.com', label: '', autofillBehavior: '' }] })),
    ).toBe('bad_address');
    const withField = (id: string, value: string) =>
      login({ fields: login().fields.map((f) => (f.id === id ? { ...f, value } : f)) });
    expect(reason(withField('otp1', 'not a key!'))).toBe('bad_totp');
    expect(reason(withField('password', 'x'.repeat(8001)))).toBe('too_long');
    expect(reason(withField('password', 'two\nlines'))).toBe('bad_value');
    expect(reason(withField('username', 'mara:admin'))).toBe('bad_value');
    expect(reason(withField('username', 'm'.repeat(201)))).toBe('too_long');
  });

  it('gives a bare host https://, leaves ?… and #… out, and keeps a website with only a scheme of its own', () => {
    expect(onePasswordAddress('grafana.example.com')).toBe('https://grafana.example.com');
    expect(onePasswordAddress(' https://x.example.com/login?next=/home#top ')).toBe(
      'https://x.example.com/login',
    );
    expect(onePasswordAddress('http://192.168.1.10:3000')).toBe('http://192.168.1.10:3000');
    expect(onePasswordAddress('  ')).toBeNull();
  });

  it('shortens a title past 60 characters with “…” and says so; an untitled item takes its host', () => {
    const long = 'A'.repeat(70);
    expect(onePasswordEntryName(long)).toEqual({ name: `${'A'.repeat(59)}…`, shortened: true });
    expect(onePasswordEntryName(` ${'B'.repeat(60)} `)).toEqual({ name: 'B'.repeat(60), shortened: false });
    // Never cut inside a character.
    const emoji = `${'C'.repeat(58)}😀😀`;
    expect(onePasswordEntryName(emoji).name).toBe(`${'C'.repeat(58)}…`);
    const reading = onePasswordItemProjection(login({ title: long }));
    expect(reading.ok && reading.nameShortened).toBe(true);
    expect(projectionOf(login({ title: '  ' })).name).toBe('grafana.example.com');
  });
});

describe('comparing by meaning', () => {
  it('reads Whombat’s and 1Password’s normal forms of the same values as the same', () => {
    const a = projectionOf(login());
    const b: OnePasswordProjection = {
      ...a,
      name: '  Grafana ',
      url: 'HTTPS://Grafana.Example.com:443/login/',
      totp: `otpauth://totp/Whombat?secret=${KEY.toLowerCase()}&algorithm=SHA1&digits=6&period=30`,
    };
    expect(onePasswordChangedFields(onePasswordCanonical(a), onePasswordCanonical(b))).toEqual([]);
    expect(
      onePasswordChangedFields(
        onePasswordCanonical(a),
        onePasswordCanonical({ ...a, username: 'Mara@example.com' }),
      ),
    ).toEqual(['username']);
    expect(
      onePasswordChangedFields(
        onePasswordCanonical(a),
        onePasswordCanonical({ ...a, totp: null, secret: 'x' }),
      ),
    ).toEqual(['secret', 'totp']);
  });

  it('gives an absent username or key the empty text and keeps every field in order', () => {
    const c = onePasswordCanonical(projectionOf(apiCredential()));
    expect(Object.keys(c)).toEqual([...ONEPASSWORD_SYNC_FIELDS]);
    expect(c.username).toBe('');
    expect(c.totp).toBe('');
    expect(c.url).toBe('https://api.example.com');
  });
});

describe('reading an entry', () => {
  it('syncs website logins and API tokens with bearer or basic; nothing else', () => {
    expect(onePasswordEntryEligible({ kind: 'login', auth: { type: 'form' } })).toBe(true);
    expect(onePasswordEntryEligible({ kind: 'http', auth: { type: 'bearer' } })).toBe(true);
    expect(onePasswordEntryEligible({ kind: 'http', auth: { type: 'basic' } })).toBe(true);
    expect(onePasswordEntryEligible({ kind: 'http', auth: { type: 'header' } })).toBe(false);
    expect(onePasswordEntryEligible({ kind: 'http', auth: { type: 'query' } })).toBe(false);
    expect(onePasswordEntryEligible({ kind: 'ssh', auth: { type: 'ssh_key' } })).toBe(false);
    expect(onePasswordEntryEligible({ kind: 'mcp', auth: { type: 'bearer' } })).toBe(false);
    expect(onePasswordEntryEligible({ kind: 'secret', auth: null })).toBe(false);
  });

  it('projects a login with its key and a basic token with its username; without a secret it doesn’t sync', () => {
    expect(
      onePasswordEntryProjection({
        kind: 'login',
        name: ' Grafana ',
        url: 'https://grafana.example.com/login',
        auth: { type: 'form', username: 'mara@example.com' },
        secret: 'hunter2',
        totp: canonicalKey(KEY),
      }),
    ).toEqual(projectionOf(login()));
    expect(
      onePasswordEntryProjection({
        kind: 'http',
        name: 'NAS',
        url: 'http://192.168.1.10',
        auth: { type: 'basic', username: 'admin' },
        secret: 'pw',
        totp: null,
      }),
    ).toMatchObject({ kind: 'http', username: 'admin', totp: null });
    expect(
      onePasswordEntryProjection({
        kind: 'http',
        name: 'NAS',
        url: 'http://192.168.1.10',
        auth: { type: 'bearer' },
        secret: null,
        totp: null,
      }),
    ).toBeNull();
  });

  it('signs a projection in as a login’s form, basic with a username or bearer without', () => {
    expect(onePasswordEntryAuth(projectionOf(login()))).toEqual({
      type: 'form',
      username: 'mara@example.com',
    });
    expect(onePasswordEntryAuth(projectionOf(apiCredential()))).toEqual({ type: 'bearer' });
    expect(onePasswordEntryAuth({ ...projectionOf(apiCredential()), username: 'ops' })).toEqual({
      type: 'basic',
      username: 'ops',
    });
  });
});

describe('writing a change into an item', () => {
  it('writes only what differs and keeps everything else 1Password holds', () => {
    const item = login();
    const p = { ...projectionOf(item), secret: 'new-password' };
    const out = applyOnePasswordProjection(item, p);
    expect(field(out, 'password')?.value).toBe('new-password');
    expect(out.title).toBe('Grafana');
    expect(out.websites).toEqual(item.websites);
    expect(field(out, 'otp1')).toEqual(field(item, 'otp1'));
    expect(field(out, 'recovery')).toEqual(field(item, 'recovery'));
    expect(out.notes).toBe(item.notes);
    expect(out.tags).toEqual(item.tags);
    expect(out.files).toEqual(item.files);
    expect(out.version).toBe(7);
    expect(out.sections).toEqual(item.sections);
    // The item read is never changed in place.
    expect(field(item, 'password')?.value).toBe('hunter2');
  });

  it('writes nothing when only Whombat’s normal forms differ', () => {
    const item = login();
    const p = { ...projectionOf(item), url: 'https://grafana.example.com/login/', name: 'Grafana ' };
    expect(applyOnePasswordProjection(item, p)).toEqual(item);
  });

  it('changes a login’s first website only, and an API Credential’s hostname', () => {
    const out = applyOnePasswordProjection(login(), {
      ...projectionOf(login()),
      url: 'https://grafana2.example.com/login',
    });
    expect(out.websites.map((w) => [w.url, w.label])).toEqual([
      ['https://grafana2.example.com/login', 'website'],
      ['https://other.example.com', 'other'],
    ]);
    const api = applyOnePasswordProjection(apiCredential(), {
      ...projectionOf(apiCredential()),
      url: 'https://api.example.com/v2',
    });
    expect(field(api, 'hostname')?.value).toBe('https://api.example.com/v2');
    expect(field(api, 'type')).toEqual(field(apiCredential(), 'type'));
  });

  it('keeps a title Whombat shortened, and writes the name once it is renamed in Whombat', () => {
    const long = `${'Dashboard '.repeat(8)}end`;
    const item = login({ title: long });
    const kept = applyOnePasswordProjection(item, { ...projectionOf(item), secret: 'changed' });
    expect(kept.title).toBe(long);
    const renamed = applyOnePasswordProjection(item, { ...projectionOf(item), name: 'Dashboards' });
    expect(renamed.title).toBe('Dashboards');
  });

  it('keeps a key’s label and issuer when only the secret changes, removes it, or adds one', () => {
    const item = login();
    const changed = applyOnePasswordProjection(item, { ...projectionOf(item), totp: canonicalKey(KEY2) });
    expect(field(changed, 'otp1')?.value).toBe(`otpauth://totp/Grafana:mara?secret=${KEY2}&issuer=Grafana`);
    expect(field(changed, 'otp1')?.details).toEqual(field(item, 'otp1')?.details);
    const removed = applyOnePasswordProjection(item, { ...projectionOf(item), totp: null });
    expect(field(removed, 'otp1')).toBeUndefined();
    expect(field(removed, 'recovery')).toBeDefined();
    const without = login({ fields: item.fields.filter((f) => f.id !== 'otp1') });
    const added = applyOnePasswordProjection(without, { ...projectionOf(without), totp: canonicalKey(KEY) });
    const otp = added.fields.find((f) => f.fieldType === 'Totp');
    expect(otp).toMatchObject({ id: 'onetimepassword', sectionId: 'add more' });
    expect(otp?.value).toBe(`otpauth://totp/Grafana?secret=${KEY}`);
    // An item without an untitled section gets the Whombat section for it.
    const bare = login({ fields: without.fields.filter((f) => f.id !== 'recovery'), sections: [] });
    const into = applyOnePasswordProjection(bare, { ...projectionOf(bare), totp: canonicalKey(KEY) });
    expect(into.sections).toEqual([{ id: 'whombat', title: 'Whombat' }]);
    expect(into.fields.find((f) => f.fieldType === 'Totp')?.sectionId).toBe('whombat');
  });

  it('follows one one-time password field: never another in its place, and removing the key removes only it', () => {
    const second = {
      id: 'otp2',
      title: 'backup',
      sectionId: 'add more',
      fieldType: 'Totp',
      value: KEY2,
    };
    const item = login({ fields: [...login().fields, second] });
    // Following none yet: the first with a value is taken, and remembered.
    expect(onePasswordTotpFieldId(item, null)).toBe('otp1');
    expect(onePasswordTotpFieldId(item, 'otp2')).toBe('otp2');
    expect(onePasswordTotpFieldId(apiCredential(), null)).toBeNull();
    expect(projectionOf(item).totp).toBe(canonicalKey(KEY));
    const followSecond = onePasswordItemProjection(item, 'otp2');
    expect(followSecond.ok && followSecond.projection.totp).toBe(canonicalKey(KEY2));
    // The followed field gone: no key, and the other field isn't taken instead.
    const withoutFirst = login({ fields: item.fields.filter((f) => f.id !== 'otp1') });
    const gone = onePasswordItemProjection(withoutFirst, 'otp1');
    expect(gone.ok && gone.projection.totp).toBeNull();
    // Writing goes into the followed field only.
    const p = projectionOf(item);
    const changed = writeOnePasswordItem(item, { ...p, totp: canonicalKey(KEY) }, 'otp2');
    expect(field(changed.item, 'otp2')?.value).toBe(KEY);
    expect(field(changed.item, 'otp1')?.value).toBe(field(item, 'otp1')?.value);
    expect(changed.totpFieldId).toBe('otp2');
    // Removing the key removes the followed field only, and it is still the one followed.
    const removed = writeOnePasswordItem(item, { ...p, totp: null }, 'otp1');
    expect(field(removed.item, 'otp1')).toBeUndefined();
    expect(field(removed.item, 'otp2')?.value).toBe(KEY2);
    expect(removed.totpFieldId).toBe('otp1');
    // A key set again after its field was removed comes back under the same id.
    const back = writeOnePasswordItem(withoutFirst, { ...p, totp: canonicalKey(KEY) }, 'otp1');
    expect(field(back.item, 'otp1')?.fieldType).toBe('Totp');
    expect(field(back.item, 'otp2')?.value).toBe(KEY2);
    expect(back.totpFieldId).toBe('otp1');
  });

  it('writes a key’s own parameters into its link, and keeps a bare key bare', () => {
    const sha256 = `otpauth://totp/Whombat?secret=${KEY2}&algorithm=SHA256&digits=8&period=30`;
    expect(onePasswordTotpValue(`otpauth://totp/Site:me?issuer=Site&secret=${KEY}`, sha256, 'x')).toBe(
      `otpauth://totp/Site:me?issuer=Site&secret=${KEY2}&algorithm=SHA256&digits=8`,
    );
    expect(onePasswordTotpValue(KEY, canonicalKey(KEY2), 'x')).toBe(KEY2);
    expect(onePasswordTotpValue(KEY, sha256, 'My site')).toBe(
      `otpauth://totp/My%20site?secret=${KEY2}&algorithm=SHA256&digits=8`,
    );
  });

  it('clears a bearer token’s username and never adds an empty one', () => {
    const basic = apiCredential({
      fields: [
        ...apiCredential().fields,
        { id: 'username', title: 'username', fieldType: 'Text', value: 'ops' },
      ],
    });
    const cleared = applyOnePasswordProjection(basic, { ...projectionOf(basic), username: null });
    expect(field(cleared, 'username')?.value).toBe('');
    expect(
      field(applyOnePasswordProjection(apiCredential(), projectionOf(apiCredential())), 'username'),
    ).toBe(undefined);
  });
});

describe('a new item', () => {
  it('makes a Login with its website, username, password, key and the Whombat entry marker', () => {
    const p = projectionOf(login());
    const made = newOnePasswordItem({ vaultId: 'v4ultv4ultv4ultv4ultv4ultv', entryId: ENTRY, projection: p });
    expect(made.category).toBe('Login');
    expect(made.title).toBe('Grafana');
    expect(made.websites).toEqual([
      { url: 'https://grafana.example.com/login', label: 'website', autofillBehavior: 'AnywhereOnWebsite' },
    ]);
    expect(made.sections).toEqual([{ id: 'whombat', title: 'Whombat' }]);
    expect(made.fields.map((f) => [f.id, f.fieldType, f.sectionId ?? null])).toEqual([
      ['username', 'Text', null],
      ['password', 'Concealed', null],
      ['onetimepassword', 'Totp', 'whombat'],
      ['whombatentry', 'Text', 'whombat'],
    ]);
    expect(onePasswordItemMarker(made)).toBe(ENTRY);
    // What it makes reads back as what it was made from.
    const back = login({ ...made, fields: made.fields, sections: made.sections, websites: made.websites });
    expect(projectionOf(back)).toEqual(p);
  });

  it('makes an API Credential with credential and hostname, and a username only for basic', () => {
    const made = newOnePasswordItem({
      vaultId: 'v4ultv4ultv4ultv4ultv4ultv',
      entryId: ENTRY,
      projection: projectionOf(apiCredential()),
    });
    expect(made.category).toBe('ApiCredentials');
    expect(made.websites).toEqual([]);
    expect(made.fields.map((f) => f.id)).toEqual(['credential', 'hostname', 'whombatentry']);
    expect(field(made, 'hostname')?.value).toBe('https://api.example.com');
  });

  it('finds the marker by its id, or by its title in the Whombat section; none or a stray value is no marker', () => {
    expect(onePasswordItemMarker(login())).toBeNull();
    const renamedId = {
      fields: [{ id: 'x9', title: 'Whombat entry', sectionId: 's1', fieldType: 'Text', value: ENTRY }],
      sections: [{ id: 's1', title: 'Whombat' }],
    };
    expect(onePasswordItemMarker(renamedId)).toBe(ENTRY);
    expect(onePasswordItemMarker({ ...renamedId, sections: [{ id: 's1', title: 'Other' }] })).toBeNull();
    expect(
      onePasswordItemMarker({
        fields: [{ id: 'whombatentry', title: 'Whombat entry', fieldType: 'Text', value: 'not an id' }],
        sections: [],
      }),
    ).toBeNull();
  });
});

describe('deciding a pair', () => {
  const d = (
    over: Partial<Record<(typeof ONEPASSWORD_SYNC_FIELDS)[number], string>> = {},
  ): OnePasswordDigests => ({
    name: 'n',
    url: 'u',
    username: 'a',
    secret: 's',
    totp: '',
    ...over,
  });

  it('does nothing when neither side changed, and takes the one side that did, whole', () => {
    expect(decideOnePasswordPair({ base: d(), whombat: d(), onepassword: d() })).toBe('nothing');
    expect(decideOnePasswordPair({ base: d(), whombat: d(), onepassword: d({ secret: 's2' }) })).toBe(
      'take_onepassword',
    );
    expect(decideOnePasswordPair({ base: d(), whombat: d({ name: 'n2' }), onepassword: d() })).toBe(
      'take_whombat',
    );
  });

  it('renews the base when both changed to the same, and lets Whombat win when they changed differently', () => {
    expect(
      decideOnePasswordPair({ base: d(), whombat: d({ secret: 'x' }), onepassword: d({ secret: 'x' }) }),
    ).toBe('renew_base');
    expect(
      decideOnePasswordPair({ base: d(), whombat: d({ secret: 'x' }), onepassword: d({ username: 'b' }) }),
    ).toBe('take_whombat');
  });

  it('lets 1Password win without a base, unless both already agree', () => {
    expect(decideOnePasswordPair({ base: null, whombat: d({ secret: 'old' }), onepassword: d() })).toBe(
      'take_onepassword',
    );
    expect(decideOnePasswordPair({ base: null, whombat: d(), onepassword: d() })).toBe('renew_base');
  });
});

describe('the guard', () => {
  const guard = (removals: number, linked: number, listingFailed = false) =>
    onePasswordRemovalGuard({ removals, linked, listingFailed });

  it('removes up to 3 entries and up to a quarter of the linked ones', () => {
    expect(ONEPASSWORD_GUARD_MAX_REMOVALS).toBe(3);
    expect(guard(0, 10)).toBe('none');
    expect(guard(1, 4)).toBe('remove');
    expect(guard(3, 12)).toBe('remove');
    expect(guard(3, 40)).toBe('remove');
  });

  it('pauses past 3, past a quarter, for all of them, and after any error while listing', () => {
    expect(guard(4, 100)).toBe('pause');
    expect(guard(1, 3)).toBe('pause');
    expect(guard(3, 11)).toBe('pause');
    expect(guard(2, 2)).toBe('pause');
    expect(guard(1, 1)).toBe('pause');
    expect(guard(1, 40, true)).toBe('pause');
    expect(guard(0, 40, true)).toBe('none');
  });
});

describe('1Password’s limit', () => {
  it('waits 15 minutes, doubling up to 2 hours, shortened by at most a tenth', () => {
    const min = 60_000;
    expect([0, 1, 2, 3, 4, 20].map((a) => onePasswordLimitWaitMs(a, 0) / min)).toEqual([
      15, 30, 60, 120, 120, 120,
    ]);
    expect(onePasswordLimitWaitMs(0, 0.999)).toBeGreaterThanOrEqual(13.5 * min);
    expect(onePasswordLimitWaitMs(9, 0.5)).toBeLessThanOrEqual(ONEPASSWORD_LIMIT_WAIT_MAX_MS);
  });
});

describe('the item shape', () => {
  it('keeps what it doesn’t name of an item, so a put loses nothing', () => {
    const parsed = OnePasswordItem.parse({ ...login(), document: { id: 'd' }, futureMember: 1 });
    expect(parsed.document).toEqual({ id: 'd' });
    expect(parsed.futureMember).toBe(1);
    expect(field(parsed, 'otp1')?.details).toEqual({ type: 'Otp', content: { code: '123456' } });
  });
});
