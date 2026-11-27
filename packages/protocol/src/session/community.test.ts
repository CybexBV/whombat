/**
 * Contracts 1.1.0: the community edition (CT-1300…CT-1310; Whombat hermes-engine.md HE-58…HE-64) — the edition, the claim
 * on the box's own page, links the box makes, Tailscale's own login server and its signed events, the owner's mail
 * server, the box's own Web Push key.
 */
import { api } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import { DirectIdentity } from '../direct.js';
import { EDITION_PARTS, Edition, editionHas, editionOf } from '../edition.js';
import {
  CLAIM_ACCOUNT_NAME_MAX,
  ClaimAccount,
  claimAccountProblem,
  ENDPOINT_ENROLLED_VIA,
  EnrollClaimLocalInput,
  EnrollClaimLocalProveInput,
  LOCAL_CLAIM_PROVE_MINOR,
} from './enrollment.js';
import { APP_ERROR_CODES } from './errors.js';
import {
  LOCAL_LINK_KINDS,
  LOCAL_LINK_PATHS,
  LocalLink,
  localLinkFor,
  parseLocalLink,
} from './local-links.js';
import {
  HostMailSetInput,
  HostMailTestInput,
  MAIL_ERROR_CODES,
  MAIL_TEST_STATES,
  MAIL_TEST_TEXT,
  MailAuditPayload,
  mailSettingsProblem,
} from './mail.js';
import { Hello, Welcome } from './messages.js';
import { OPERATION_SAFETY } from './operation-safety.js';
import { createOperationAllowlist, SESSION_OPERATIONS } from './operations.js';
import { APPLIANCE_EVENT_TYPES } from './providers.js';
import {
  HostTailscaleOnInput,
  normalizeTailscaleLoginServer,
  TailscaleAuditPayload,
  TailscaleLoginServer,
  tailscaleLoginUrlTrusted,
} from './tailscale.js';
import { LOCALE_MINOR, SESSION_PROTOCOL } from './version.js';

const BOX = '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH';
const SECRET = 'Zm9vYmFyYmF6cXV4cXV1eDEyMzQ';
const routes = [
  { way: 'lan' as const, socket: 'ws://192.168.1.20:4480/v1/direct', web: 'http://192.168.1.20:4480/' },
  { way: 'lan' as const, socket: 'ws://[fd00::20]:4480/v1/direct', web: 'http://[fd00::20]:4480/' },
  {
    way: 'tailscale' as const,
    socket: 'wss://whombat-r7m4.tail1234.ts.net:4480/v1/direct',
    web: 'https://whombat-r7m4.tail1234.ts.net:4480/',
  },
];

describe('the edition (CT-1300, CT-1301)', () => {
  it('is commercial unless the box says community, and only community claims on its own page', () => {
    expect(Edition.options).toEqual(['commercial', 'community']);
    expect(editionOf(undefined)).toBe('commercial');
    for (const part of EDITION_PARTS) {
      expect(editionHas('commercial', part), part).toBe(part !== 'local_claim');
      expect(editionHas(undefined, part), part).toBe(part !== 'local_claim');
      expect(editionHas('community', part), part).toBe(part === 'local_claim');
    }
  });

  it('rides in the welcome and the box’s identity, absent from a 1.0 box', () => {
    expect(Welcome.shape.edition.safeParse(undefined).success).toBe(true);
    expect(Welcome.shape.edition.safeParse('community').success).toBe(true);
    expect(DirectIdentity.parse({ v: 1, appliance: BOX }).edition).toBeUndefined();
    expect(DirectIdentity.safeParse({ v: 1, appliance: BOX, edition: 'home' }).success).toBe(false);
  });

  it('counts the additions in the session minor: 1 is the local claim’s proof round, 2 the hello’s claim link, 3 mail automations, 4 Find My, 5 its timeline, 6 own names, 7 account pages, 8 the 1Password sync', () => {
    expect(SESSION_PROTOCOL).toEqual({ major: 5, minor: LOCALE_MINOR });
    expect(LOCAL_CLAIM_PROVE_MINOR).toBe(1);
    const hello = {
      t: 'hello',
      versions: [SESSION_PROTOCOL],
      capabilities: [],
      client: { build: 'web 1', platform: 'web' },
    };
    // Six letters of the claim link, where a page was opened with it; a box from before reads the hello without it.
    expect(Hello.parse({ ...hello, claimLink: 'abcdef' }).claimLink).toBe('abcdef');
    expect(Hello.parse(hello).claimLink).toBeUndefined();
    expect(Hello.safeParse({ ...hello, claimLink: 'not a link' }).success).toBe(false);
  });
});

describe('the claim on the box’s own page (CT-1302)', () => {
  const LOCAL_OPS = [
    'enroll.claim.local.start',
    'enroll.claim.local.begin',
    'enroll.claim.local.prove',
    'enroll.claim.local',
  ];

  it('is four enrollment-channel ops: three ephemeral, one that makes the owner, none resent', () => {
    for (const op of LOCAL_OPS) {
      expect(SESSION_OPERATIONS.get(op)?.channel, op).toBe('enroll');
      expect(OPERATION_SAFETY[op as keyof typeof OPERATION_SAFETY].retry, op).toBe('never');
      expect(SESSION_OPERATIONS.get(op)?.ephemeral, op).toBe(op !== 'enroll.claim.local');
    }
    for (const code of [
      'claim_local_unavailable',
      'claim_start_missing',
      'claim_proof_missing',
      'claim_update_app',
      'claim_rate_limited',
    ])
      expect(APP_ERROR_CODES).toHaveProperty(code);
  });

  it('proves with the tags alone: nothing about the person fits in that request', () => {
    const proof = { claimId: 'lcl_8Hq2mXk3pZ', confirm: 'A'.repeat(43) };
    expect(EnrollClaimLocalProveInput.safeParse(proof).success).toBe(true);
    for (const extra of [
      { account: { name: 'Mara Okafor', email: 'mara@lumio.example.org' } },
      { endpoint: { label: 'Firefox on Linux', platform: 'web' } },
      { name: 'Mara Okafor' },
      { email: 'mara@lumio.example.org' },
    ])
      expect(EnrollClaimLocalProveInput.safeParse({ ...proof, ...extra }).success).toBe(false);
  });

  it('names the first owner after the proofs, with no tag, method or control claim id', () => {
    const input = {
      claimId: 'lcl_8Hq2mXk3pZ',
      account: { name: 'Mara Okafor', email: 'mara@lumio.example.org' },
      endpoint: { label: 'Firefox on Linux', platform: 'web' },
    };
    expect(EnrollClaimLocalInput.safeParse(input).success).toBe(true);
    expect(EnrollClaimLocalInput.safeParse({ ...input, method: 'code' }).success).toBe(false);
    expect(EnrollClaimLocalInput.safeParse({ ...input, claimId: 'short' }).success).toBe(false);
    // The form before the proof round still parses, so a box can answer it with “update the app”.
    expect(EnrollClaimLocalInput.safeParse({ ...input, confirm: 'A'.repeat(43) }).success).toBe(true);
  });

  it('shares the account’s rules, so an app refuses what the box would before it starts', () => {
    const ok = { name: 'Mara Okafor', email: 'mara@lumio.example.org' };
    expect(claimAccountProblem(ok)).toBeNull();
    expect(claimAccountProblem({ ...ok, name: '   ' })).toBe('name');
    expect(claimAccountProblem({ ...ok, name: 'x'.repeat(CLAIM_ACCOUNT_NAME_MAX + 1) })).toBe('name');
    expect(claimAccountProblem({ ...ok, name: 'x'.repeat(CLAIM_ACCOUNT_NAME_MAX) })).toBeNull();
    for (const email of ['', 'mara', 'mara@', 'mara@lumio', '@lumio.example.org'])
      expect(claimAccountProblem({ ...ok, email }), email).toBe('email');
    // Exactly what the claim's own input takes.
    for (const account of [ok, { ...ok, name: ' ' }, { ...ok, email: 'mara@lumio' }])
      expect(ClaimAccount.safeParse(account).success).toBe(claimAccountProblem(account) === null);
  });
});

describe('links the box makes (CT-1304, CT-1305)', () => {
  it('round-trips every kind on the box’s first way, with the PeerId and the ways in order', () => {
    expect(LOCAL_LINK_KINDS).toEqual(['device']);
    for (const kind of LOCAL_LINK_KINDS) {
      const link = localLinkFor({ kind, appliance: BOX, secret: SECRET, routes });
      expect(link.startsWith(`http://192.168.1.20:4480${LOCAL_LINK_PATHS[kind]}#`), kind).toBe(true);
      expect(parseLocalLink(link)).toEqual({ kind, appliance: BOX, secret: SECRET, routes, own: null });
      expect(LocalLink.safeParse(link).success).toBe(true);
    }
  });

  it('reads a percent-encoded copy, a trailing slash and unknown keys', () => {
    const link = localLinkFor({ kind: 'device', appliance: BOX, secret: SECRET, routes: routes.slice(2) });
    const [base, fragment] = link.split('#') as [string, string];
    const encoded = `${base}/#${fragment.replaceAll(':', '%3A').replaceAll('/', '%2F')}&x=later`;
    expect(parseLocalLink(encoded)?.routes).toEqual(routes.slice(2));
  });

  it('refuses what isn’t one', () => {
    const good = localLinkFor({ kind: 'device', appliance: BOX, secret: SECRET, routes });
    for (const bad of [
      good.replace('/add-device#', '/settings#'),
      good.replace('/add-device#', '/join#'),
      good.replace(`p=${BOX}`, 'p=QmNotAPeerId'),
      good.replace(`s=${SECRET}`, 's=short'),
      good.replace(`s=${SECRET}`, `s=${SECRET}&s=${SECRET}`),
      good.split('&l=')[0] as string,
      good.replace('l=http://192.168.1.20:4480/', 'l=ftp://192.168.1.20/'),
      good.split('#')[0] as string,
    ])
      expect(parseLocalLink(bad), bad).toBeNull();
    expect(() => localLinkFor({ kind: 'device', appliance: BOX, secret: SECRET, routes: [] })).toThrow();
  });

  it('carries the box’s own address first and opens on it (4.3), which an older app ignores', () => {
    const own = 'https://maple-otter-river.box.whombat.app/';
    const link = localLinkFor({ kind: 'device', appliance: BOX, secret: SECRET, routes, own });
    expect(link.startsWith('https://maple-otter-river.box.whombat.app/add-device#')).toBe(true);
    expect(link.indexOf('o=')).toBeLessThan(link.indexOf('l='));
    expect(parseLocalLink(link)).toEqual({ kind: 'device', appliance: BOX, secret: SECRET, routes, own });
    // An app before 4.3 skips the key it doesn't know, as it does any unknown key: the same link on its ways.
    const older = parseLocalLink(link.replace('&o=', '&x='));
    expect(older).toMatchObject({ kind: 'device', appliance: BOX, secret: SECRET, routes, own: null });
    // Only an own address, no way: fine for 4.3 apps.
    const ownOnly = localLinkFor({ kind: 'device', appliance: BOX, secret: SECRET, routes: [], own });
    expect(parseLocalLink(ownOnly)).toEqual({
      kind: 'device',
      appliance: BOX,
      secret: SECRET,
      routes: [],
      own,
    });
    expect(parseLocalLink(ownOnly.replace('&o=', '&x='))).toBeNull();
    for (const bad of [
      'https://maple-otter-river.example.com/',
      'http://maple-otter-river.box.whombat.app/',
      'https://maple-otter-river.box.whombat.app:443/',
      'https://Maple-otter-river.box.whombat.app/',
    ]) {
      expect(
        () => localLinkFor({ kind: 'device', appliance: BOX, secret: SECRET, routes, own: bad }),
        bad,
      ).toThrow();
      expect(parseLocalLink(link.replace(`o=${own}`, `o=${bad}`)), bad).toBeNull();
    }
    expect(parseLocalLink(link.replace(`o=${own}`, `o=${own}&o=${own}`))).toBeNull();
  });

  it('makes device links only: invites and re-enrolments went (3.0, CT-1505)', () => {
    for (const op of ['enroll.invite.create', 'enroll.reenroll.create'])
      expect(SESSION_OPERATIONS.has(op)).toBe(false);
    expect(ENDPOINT_ENROLLED_VIA).not.toContain('invite');
    expect(SESSION_OPERATIONS.get('enroll.link.create')).toMatchObject({ channel: 'app', secret: true });
    expect(SESSION_OPERATIONS.get('enroll.link.accept')).toMatchObject({ channel: 'enroll', secret: true });
    expect(ENDPOINT_ENROLLED_VIA).toContain('link');
    for (const code of ['link_unavailable', 'link_invalid', 'link_expired', 'link_used'])
      expect(APP_ERROR_CODES).toHaveProperty(code);
  });
});

describe('Tailscale’s own login server (CT-1306)', () => {
  it('normalizes what an owner types, or says why not', () => {
    expect(normalizeTailscaleLoginServer(' HTTPS://HS.Example.org:8080/ ')).toEqual({
      ok: true,
      value: 'https://hs.example.org:8080',
    });
    expect(normalizeTailscaleLoginServer('http://10.0.0.5/hs/')).toEqual({
      ok: true,
      value: 'http://10.0.0.5/hs',
    });
    const problems: Record<string, string> = {
      'hs.example.org': 'invalid',
      'ftp://hs.example.org': 'scheme',
      'https://u:p@hs.example.org': 'credentials',
      'https://hs.example.org/?a=1': 'query',
      'https://hs_example.org': 'host',
      'https://hs.example.org:70000': 'port',
      'https://hs.example.org/a b': 'path',
    };
    for (const [raw, problem] of Object.entries(problems))
      expect(normalizeTailscaleLoginServer(raw), raw).toEqual({ ok: false, problem });
  });

  it('keeps, sets or clears it on `host.tailscale.on`', () => {
    expect(HostTailscaleOnInput.safeParse({}).success).toBe(true);
    expect(HostTailscaleOnInput.safeParse({ loginServer: null }).success).toBe(true);
    expect(HostTailscaleOnInput.safeParse({ loginServer: 'https://hs.example.org' }).success).toBe(true);
    expect(HostTailscaleOnInput.safeParse({ loginServer: 'https://hs.example.org/' }).success).toBe(false);
    expect(TailscaleLoginServer.safeParse('https://[fd00::5]:8443').success).toBe(true);
  });

  it('opens login links only on the login server’s origin, or Tailscale’s', () => {
    expect(tailscaleLoginUrlTrusted('https://login.tailscale.com/a/1', undefined)).toBe(true);
    expect(tailscaleLoginUrlTrusted('https://evil.example/a/1', undefined)).toBe(false);
    expect(tailscaleLoginUrlTrusted('https://tailscale.com.evil.example/a', null)).toBe(false);
    expect(tailscaleLoginUrlTrusted('https://hs.example.org:443/register/x', 'https://hs.example.org')).toBe(
      true,
    );
    expect(tailscaleLoginUrlTrusted('http://hs.example.org/register/x', 'https://hs.example.org')).toBe(
      false,
    );
    expect(tailscaleLoginUrlTrusted('https://login.tailscale.com/a/1', 'https://hs.example.org')).toBe(false);
    expect(tailscaleLoginUrlTrusted('https://x@hs.example.org/r', 'https://hs.example.org')).toBe(false);
  });

  it('is in the signed appliance log with the owner and the server, nothing secret', () => {
    for (const type of ['tailscale.on', 'tailscale.off', 'tailscale.sign_in'])
      expect(APPLIANCE_EVENT_TYPES).toContain(type);
    expect(Object.keys(TailscaleAuditPayload.shape).sort()).toEqual(
      ['byAccountId', 'loginServer', 'loginServerChanged', 'signOut'].sort(),
    );
  });
});

describe('the owner’s mail server (CT-1308)', () => {
  const settings = {
    host: 'smtp.example.org',
    port: 587,
    security: 'starttls',
    username: 'whombat@example.org',
    password: 'an app password',
    from: 'whombat@example.org',
  };

  it('has owners’ ops: a read, set and test as secrets never resent, remove for a person to decide', () => {
    expect(SESSION_OPERATIONS.get('host.mail')?.mutating).toBe(false);
    for (const op of ['host.mail.set', 'host.mail.test'] as const) {
      expect(SESSION_OPERATIONS.get(op)?.secret, op).toBe(true);
      expect(OPERATION_SAFETY[op].retry, op).toBe('never');
    }
    expect(OPERATION_SAFETY['host.mail.remove'].destructive).toBe(true);
    for (const code of MAIL_ERROR_CODES) expect(APP_ERROR_CODES).toHaveProperty([code]);
  });

  it('takes no login without encryption, and keeps the stored password when none is sent', () => {
    expect(HostMailSetInput.safeParse(settings).success).toBe(true);
    const { password: _password, ...keep } = settings;
    expect(HostMailSetInput.safeParse(keep).success).toBe(true);
    expect(HostMailSetInput.safeParse({ ...settings, security: 'none' }).success).toBe(false);
    expect(
      HostMailSetInput.safeParse({ ...settings, security: 'none', port: 25, username: null, password: null })
        .success,
    ).toBe(true);
    expect(mailSettingsProblem({ security: 'none', username: 'x' })).toBe('login_without_tls');
    expect(HostMailSetInput.safeParse({ ...settings, host: 'smtp example' }).success).toBe(false);
    expect(HostMailTestInput.safeParse({}).success).toBe(true);
    expect(HostMailTestInput.safeParse({ draft: settings }).success).toBe(true);
    expect(HostMailTestInput.safeParse({ to: 'someone@else.org' }).success).toBe(false);
  });

  it('words every test result, and logs the server without the login', () => {
    for (const state of MAIL_TEST_STATES) expect(MAIL_TEST_TEXT[state], state).toBeTruthy();
    expect(APPLIANCE_EVENT_TYPES).toContain('mail.set');
    expect(APPLIANCE_EVENT_TYPES).toContain('mail.removed');
    const server = MailAuditPayload.shape.server.unwrap();
    expect(Object.keys(server.shape).sort()).toEqual(['from', 'host', 'port', 'security']);
  });
});

describe('the box’s own Web Push key (CT-1307)', () => {
  it('comes over the session for enrolled devices, as a P-256 key', () => {
    const allow = createOperationAllowlist();
    expect(allow.resolve('devices.vapidKey', { enrolled: true }).ok).toBe(true);
    expect(allow.resolve('devices.vapidKey', { enrolled: false }).ok).toBe(false);
    const response = api.devices.vapidKey.response;
    expect(response.safeParse({ publicKey: 'B'.repeat(87) }).success).toBe(true);
    expect(response.safeParse({ publicKey: 'nope' }).success).toBe(false);
    expect(APP_ERROR_CODES).toHaveProperty(['push.web_unavailable']);
    expect(APP_ERROR_CODES).toHaveProperty('passkeys_unavailable_here');
  });
});
