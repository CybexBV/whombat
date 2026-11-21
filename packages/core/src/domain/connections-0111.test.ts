/**
 * Contracts 0.111.0 (Whombat connection-signin.md SG-01…SG-16; CT-730…CT-744): signing in on the service's own page,
 * a challenge handed back, a session's two-step code asked once, refusals in the entry's words (a session failure's
 * status, a check's failures), a check per secret shape, fields filled from the check, and the entries built on them.
 */
import { describe, expect, it } from 'vitest';
import {
  ConnectionErrorDetails,
  CreateConnectionBody,
  PollNextcloudLoginResponse,
  PollServiceLoginResponse,
  SetConnectionSecretBody,
  StartServiceLoginBody,
  StartServiceLoginResponse,
} from '../contracts/connections.js';
import { api } from '../contracts/index.js';
import {
  CATALOG,
  CatalogCheck,
  CatalogEntry,
  type CatalogEntryInput,
  CatalogField,
  CatalogSignIn,
  catalogCheckFor,
  catalogEntry,
  checkAnswerOk,
  checkFailure,
  fieldProblem,
  fieldsFor,
  fieldsFromCheck,
  fieldsProblems,
  resolveCheckPath,
  SERVICE_LOGIN_USER_CODE_MAX,
  SESSION_TWO_STEP_AGAIN_WORDS,
  SessionFailure,
  SessionTwoStep,
  SIGN_IN_KINDS,
  sessionLoginFailure,
  sessionLoginRequest,
  sessionRememberedToken,
  sessionTwoStepAgainText,
  sessionTwoStepAsk,
  sessionTwoStepValues,
  storedTokenSignIn,
  TokenAuth,
  tokenAuthProblem,
} from './connections-catalog.js';

const must = (id: string): CatalogEntry => {
  const e = catalogEntry(id);
  if (!e) throw new Error(id);
  return e;
};
type Session = Extract<TokenAuth, { type: 'session' }>;
const sessionOf = (id: string): Session => {
  const m = must(id).signIn.find((s) => s.kind === 'token');
  if (m?.kind !== 'token' || m.auth.type !== 'session') throw new Error(`${id} session`);
  return m.auth;
};
const session = (input: unknown): Session => {
  const a = TokenAuth.parse(input);
  if (a.type !== 'session') throw new Error('session');
  return a;
};

describe('signing in on the service’s own page (CT-730, CT-738; SG-01…SG-04)', () => {
  it('is a sign-in kind with a sentence and the token sign-in it is stored as', () => {
    expect(SIGN_IN_KINDS).toContain('service_login');
    const m = CatalogSignIn.parse({
      kind: 'service_login',
      label: 'Sign in with Plex',
      note: 'Sign in there.',
    });
    expect(m).toMatchObject({ kind: 'service_login', tokenMethod: 0 });
    expect(CatalogSignIn.safeParse({ kind: 'service_login', label: 'Sign in' }).success).toBe(false);
    expect(
      CatalogSignIn.safeParse({ kind: 'service_login', label: 'Sign in', note: 'x'.repeat(201) }).success,
    ).toBe(false);
    expect(
      CatalogSignIn.safeParse({ kind: 'service_login', label: 'Sign in', note: 'Go.', tokenMethod: 4 })
        .success,
    ).toBe(false);
  });

  it('signs Plex in on its PIN page first, stored as the Plex token, without a password sign-in', () => {
    const plex = must('plex');
    expect(plex.signIn.map((m) => m.kind)).toEqual(['service_login', 'token']);
    const first = plex.signIn[0];
    if (first?.kind !== 'service_login') throw new Error('service_login');
    expect(first.label).toBe('Sign in with Plex');
    expect(first.note).toContain('new tab');
    const token = storedTokenSignIn(plex, first);
    expect(token?.auth).toMatchObject({ type: 'header', name: 'X-Plex-Token' });
    expect(fieldsFor(plex, 'service_login').map((f) => f.id)).toEqual(['url', 'fingerprint']);
  });

  it('points every service sign-in at one of its entry’s token sign-ins, in curly-quoted words', () => {
    for (const e of CATALOG)
      for (const m of e.signIn) {
        if (m.kind !== 'service_login') continue;
        expect(storedTokenSignIn(e, m), e.id).not.toBeNull();
        expect(`${m.label} ${m.note}`, e.id).not.toMatch(/'/);
      }
  });

  it('starts with the entry and the fields, and answers the page, the flow and a code', () => {
    expect(StartServiceLoginBody.parse({ catalogId: 'plex' })).toEqual({
      catalogId: 'plex',
      fields: {},
      access: 'manage',
    });
    expect(
      StartServiceLoginBody.parse({
        catalogId: 'plex',
        fields: { url: 'http://192.168.1.20:32400' },
        access: 'read',
        connectionId: 'con_0123456789abcdef',
      }).access,
    ).toBe('read');
    const start = {
      loginUrl: 'https://app.plex.tv/auth#?clientID=abc&code=XYZ1',
      flowId: 'oas_0123456789abcdef',
      pollEveryMs: 2000,
      expiresAt: '2026-10-21T10:10:00.000Z',
      userCode: null,
    };
    expect(StartServiceLoginResponse.parse(start).userCode).toBeNull();
    expect(StartServiceLoginResponse.parse({ ...start, userCode: 'WDJB-MJHT' }).userCode).toBe('WDJB-MJHT');
    expect(
      StartServiceLoginResponse.safeParse({ ...start, userCode: 'x'.repeat(SERVICE_LOGIN_USER_CODE_MAX + 1) })
        .success,
    ).toBe(false);
    // `userCode` is always there (null for Plex).
    const { userCode: _, ...withoutCode } = start;
    expect(StartServiceLoginResponse.safeParse(withoutCode).success).toBe(false);
  });

  it('polls exactly as Nextcloud’s, on its own endpoints', () => {
    expect(PollServiceLoginResponse).toBe(PollNextcloudLoginResponse);
    expect(PollServiceLoginResponse.parse({ state: 'pending' })).toEqual({ state: 'pending' });
    expect(PollServiceLoginResponse.parse({ state: 'failed', message: 'No.' }).state).toBe('failed');
    const start = api.connections.startServiceLogin;
    expect([start.id, start.method, start.path]).toEqual([
      'connections.startServiceLogin',
      'POST',
      '/burrows/:burrow/connections/service-login/start',
    ]);
    expect(start.body).toBe(StartServiceLoginBody);
    const poll = api.connections.pollServiceLogin;
    expect([poll.id, poll.method, poll.path]).toEqual([
      'connections.pollServiceLogin',
      'POST',
      '/connections/service-login/:flowId/poll',
    ]);
    expect(poll.response).toBe(PollServiceLoginResponse);
  });
});

describe('a challenge handed back (CT-731; SG-06)', () => {
  it('goes out in the refusal’s details and comes back with the code', () => {
    const challenge = 'v1.'.padEnd(4096, 'a');
    expect(ConnectionErrorDetails.parse({ code: 'second_factor_needed', challenge }).challenge).toBe(
      challenge,
    );
    expect(
      ConnectionErrorDetails.parse({ code: 'sign_in_refused', reason: 'code', challenge: 'c' }).challenge,
    ).toBe('c');
    expect(
      ConnectionErrorDetails.safeParse({ code: 'second_factor_needed', challenge: `${challenge}a` }).success,
    ).toBe(false);
    const body = CreateConnectionBody.parse({
      catalogId: 'unifi_network',
      signIn: 'password',
      login: { account: 'mara@example.com', password: 'pw', code: ' 123456 ', challenge },
    });
    expect([body.login?.code, body.login?.challenge]).toEqual(['123456', challenge]);
    expect(
      CreateConnectionBody.safeParse({
        catalogId: 'unifi_network',
        login: { account: 'm', password: 'pw', challenge: '' },
      }).success,
    ).toBe(false);
  });
});

describe('a two-step code asked once (CT-732, CT-733; SG-09)', () => {
  const synology = must('synology');
  const auth = sessionOf('synology');
  const fields = { url: 'https://nas.lan:5001', username: 'whombat' };
  // A form's names and values (core has no URLSearchParams: it stays pure).
  const form = (body: string | null | undefined): Record<string, string> =>
    Object.fromEntries(
      (body ?? '')
        .split('&')
        .filter(Boolean)
        .map((pair) => pair.split('=').map((x) => decodeURIComponent(x)) as [string, string]),
    );

  it('says how DSM asks for a code and remembers Whombat', () => {
    expect(auth.twoStep).toEqual({
      asked: { json: 'error.code', values: ['403'] },
      wrongCode: { json: 'error.code', values: ['404'] },
      code: { name: 'otp_code' },
      remember: {
        body: { enable_device_token: 'yes', device_name: 'Whombat' },
        tokenJsonPaths: ['data.device_id', 'data.did'],
        name: 'device_id',
        with: { device_name: 'Whombat' },
      },
      again: expect.stringContaining('Replace the password and enter a code'),
    });
    expect(tokenAuthProblem(synology, auth)).toBeNull();
  });

  it('signs in with the code and asks DSM to trust Whombat, then with the device token', () => {
    const plain = sessionLoginRequest(synology, auth, 'pw', fields);
    expect(form(plain?.body)).toEqual({ account: 'whombat', passwd: 'pw', session: 'webui', format: 'sid' });
    const withCode = sessionLoginRequest(synology, auth, 'pw', fields, { code: ' 123456 ' });
    expect(withCode?.path).toBe(plain?.path);
    expect(form(withCode?.body)).toEqual({
      account: 'whombat',
      passwd: 'pw',
      session: 'webui',
      format: 'sid',
      otp_code: '123456',
      enable_device_token: 'yes',
      device_name: 'Whombat',
    });
    const later = sessionLoginRequest(synology, auth, 'pw', fields, { remembered: 'dev-1' });
    expect(form(later?.body)).toMatchObject({ device_id: 'dev-1', device_name: 'Whombat' });
    expect(form(later?.body).otp_code).toBeUndefined();
    // A code replaces a token that no longer works.
    const both = form(
      sessionLoginRequest(synology, auth, 'pw', fields, { code: '654321', remembered: 'old' })?.body,
    );
    expect([both.otp_code, both.device_id]).toEqual(['654321', undefined]);
    expect(sessionTwoStepValues(auth, { remembered: 'bad\ntoken' })).toEqual({});
  });

  it('tells a code asked from a code refused, and reads the device token', () => {
    const answer = (code: number) =>
      `{"error":{"code":${code},"errors":{"types":[{"type":"otp"}]}},"success":false}`;
    expect(sessionTwoStepAsk(auth, answer(403))).toBe('asked');
    expect(sessionTwoStepAsk(auth, answer(404))).toBe('wrong_code');
    expect(sessionTwoStepAsk(auth, answer(400))).toBeNull();
    expect(sessionLoginFailure(synology, auth, answer(406))?.text).toContain('DSM requires two-step sign-in');
    expect(sessionRememberedToken(auth, '{"data":{"sid":"s","device_id":"dev-7"},"success":true}')).toBe(
      'dev-7',
    );
    expect(sessionRememberedToken(auth, '{"data":{"sid":"s","did":"dev-6"},"success":true}')).toBe('dev-6');
    expect(sessionRememberedToken(auth, '{"data":{"sid":"s"},"success":true}')).toBeNull();
    expect(sessionTwoStepAgainText(synology, auth)).toBe(auth.twoStep?.again);
  });

  it('leaves sessions without twoStep as they were', () => {
    const pihole = must('pihole');
    const a = sessionOf('pihole');
    const req = sessionLoginRequest(pihole, a, 'app-pw', {}, { code: '123456', remembered: 'x' });
    expect(req?.body).toBe('{"password":"app-pw"}');
    expect(sessionTwoStepAsk(a, '{"error":{"code":403}}')).toBeNull();
    expect(sessionRememberedToken(a, '{"data":{"device_id":"d"}}')).toBeNull();
    expect(sessionTwoStepAgainText(pihole, a)).toBe(
      SESSION_TWO_STEP_AGAIN_WORDS.replaceAll('{name}', 'Pi-hole'),
    );
  });

  it('puts the code in the query of a GET sign-in, and refuses names that clash or values that fill in', () => {
    const base: CatalogEntryInput = {
      id: 'sample',
      name: 'Sample',
      category: 'infrastructure',
      description: 'A sample.',
      signIn: [],
      fields: [
        { id: 'url', label: 'Address', kind: 'url', required: true },
        { id: 'username', label: 'Account', kind: 'text', required: true },
      ],
      transport: 'rest',
      baseUrl: '{url}',
      mcpPath: null,
      mcpMissingHint: null,
      check: { kind: 'reach' },
      tools: [],
      request: { prefixes: ['/'] },
      guide: 'A sample entry for the tests.',
      sensitive: [],
      docsUrl: null,
      tokenUrl: null,
      handle: 'sample',
    };
    const entry = CatalogEntry.parse(base);
    const twoStep = { asked: { json: 'code', values: ['2'] }, code: { name: 'otp' } };
    const get = session({
      type: 'session',
      login: { method: 'GET', path: '/login', body: {}, query: { user: '{username}', pass: '{secret}' } },
      tokenJsonPath: 'sid',
      apply: { type: 'query', name: 'sid' },
      twoStep,
    });
    expect(tokenAuthProblem(entry, get)).toBeNull();
    expect(
      sessionLoginRequest(entry, get, 'pw', { url: 'https://x.lan', username: 'w' }, { code: '1234' }),
    ).toEqual({
      method: 'GET',
      path: '/login?user=w&pass=pw&otp=1234',
      headers: { accept: 'application/json' },
      body: null,
    });
    const clash = session({ ...get, twoStep: { ...twoStep, code: { name: 'pass' } } });
    expect(tokenAuthProblem(entry, clash)).toContain('names of their own');
    const templated = session({
      ...get,
      twoStep: {
        ...twoStep,
        remember: { body: { trust: '{username}' }, tokenJsonPaths: ['did'], name: 'did' },
      },
    });
    expect(tokenAuthProblem(entry, templated)).toContain('as they are');
    expect(
      SessionTwoStep.safeParse({ ...twoStep, remember: { body: {}, tokenJsonPaths: [], name: 'd' } }).success,
    ).toBe(false);
  });

  it('takes a code on connect and on Replace password', () => {
    const create = CreateConnectionBody.parse({
      catalogId: 'synology',
      fields: { url: 'https://nas.lan:5001', username: 'whombat' },
      secret: 'pw',
      code: ' 123456 ',
    });
    expect(create.code).toBe('123456');
    expect(SetConnectionSecretBody.parse({ secret: 'pw', code: '123456' })).toEqual({
      secret: 'pw',
      code: '123456',
    });
    expect(SetConnectionSecretBody.parse({ secret: 'pw' })).toEqual({ secret: 'pw' });
    for (const code of ['123', 'x'.repeat(65)])
      expect(SetConnectionSecretBody.safeParse({ secret: 'pw', code }).success, code).toBe(false);
  });
});

describe('refusals in the entry’s words (CT-734, CT-735, CT-743; SG-10, SG-11)', () => {
  it('lets a session failure name its statuses', () => {
    const f = SessionFailure.parse({ status: [200], json: 'a', values: ['1'], reason: 'denied' });
    expect(f.status).toEqual([200]);
    expect(SessionFailure.safeParse({ status: [], json: 'a', values: ['1'], reason: 'denied' }).success).toBe(
      false,
    );
    expect(
      SessionFailure.safeParse({ status: [99], json: 'a', values: ['1'], reason: 'denied' }).success,
    ).toBe(false);
  });

  it('reads Pi-hole’s two-step, seats and no-password answers', () => {
    const pihole = must('pihole');
    const a = sessionOf('pihole');
    const err = (key: string, message: string) => JSON.stringify({ error: { key, message, hint: null } });
    for (const message of ['No 2FA token found in JSON payload', 'Invalid 2FA token', 'Reused 2FA token']) {
      const r = sessionLoginFailure(pihole, a, err('bad_request', message), 400);
      expect(r?.reason, message).toBe('two_step');
      expect(r?.text, message).toContain('Configure app password');
    }
    expect(sessionLoginFailure(pihole, a, err('api_seats_exceeded', 'API seats exceeded'), 429)?.reason).toBe(
      'locked',
    );
    const noPassword =
      '{"session":{"valid":true,"totp":false,"sid":null,"validity":-1,"message":"no password set"}}';
    expect(sessionLoginFailure(pihole, a, noPassword, 200)).toMatchObject({ reason: 'denied' });
    expect(sessionLoginFailure(pihole, a, noPassword, 200)?.text).toContain('sudo pihole setpassword');
    // A wrong password carries the same validity with a 401: the server's own reading decides it.
    const wrong =
      '{"session":{"valid":false,"totp":false,"sid":null,"validity":-1,"message":"password incorrect"}}';
    expect(sessionLoginFailure(pihole, a, wrong, 401)).toBeNull();
    // Without the status a status rule never holds.
    expect(sessionLoginFailure(pihole, a, noPassword)).toBeNull();
    const ok =
      '{"session":{"valid":true,"totp":false,"sid":"abc","validity":1800,"message":"app-password correct"}}';
    expect(sessionLoginFailure(pihole, a, ok, 200)).toBeNull();
  });

  it('lets a request check name its refusals', () => {
    const check = CatalogCheck.parse({
      kind: 'request',
      method: 'GET',
      path: '/x',
      failures: [{ status: [403], refused: true, text: 'No.' }],
    });
    expect(check.kind === 'request' && check.failures?.[0]?.bodyPattern).toBeUndefined();
    const bad = (failures: unknown) =>
      CatalogCheck.safeParse({ kind: 'request', method: 'GET', path: '/x', failures }).success;
    expect(bad([{ status: [], refused: true, text: 'No.' }])).toBe(false);
    expect(bad([{ status: [403], refused: true, text: '' }])).toBe(false);
    expect(bad(Array.from({ length: 9 }, () => ({ status: [403], refused: true, text: 'No.' })))).toBe(false);
    expect(checkFailure(null, 403, '')).toBeNull();
    expect(checkFailure({ kind: 'reach' }, 403, '')).toBeNull();
  });

  it('tells SABnzbd’s refusals apart', () => {
    const check = must('sabnzbd').check;
    expect(
      checkFailure(
        check,
        403,
        'Access denied - Hostname verification failed: https://sabnzbd.org/hostname-check',
      ),
    ).toMatchObject({
      refused: false,
      text: expect.stringContaining('host_whitelist'),
    });
    expect(
      checkFailure(check, 403, 'External internet access denied - https://sabnzbd.org/access-denied'),
    ).toMatchObject({
      refused: false,
    });
    for (const body of ['API Key Incorrect', 'API Key Required'])
      expect(checkFailure(check, 403, body), body).toMatchObject({
        refused: true,
        text: expect.stringContaining('NZB Key'),
      });
    // With api_warnings off the body is empty: the server's own reading (a refused key).
    expect(checkFailure(check, 403, '')).toBeNull();
    expect(checkFailure(check, 200, 'API Key Incorrect')).toBeNull();
  });

  it('reads NZBHydra2’s empty 404 as a refused key and Plausible’s 402 as the plan', () => {
    const hydra = must('nzbhydra').check;
    expect(checkFailure(hydra, 404, '')).toMatchObject({
      refused: true,
      text: expect.stringContaining('version 9'),
    });
    expect(checkFailure(hydra, 404, '<html>Whitelabel Error Page</html>')).toBeNull();
    expect(
      checkFailure(must('plausible').check, 402, '{"error":"…does not have access to Stats API…"}'),
    ).toMatchObject({
      refused: false,
      text: expect.stringContaining('Business plan'),
    });
  });

  it('compiles every check failure’s and forSecret’s pattern', () => {
    for (const e of CATALOG) {
      if (e.check?.kind !== 'request') continue;
      for (const f of e.check.failures ?? [])
        if (f.bodyPattern) expect(() => new RegExp(f.bodyPattern as string, 'i'), e.id).not.toThrow();
      for (const f of e.check.forSecret ?? []) expect(() => new RegExp(f.pattern, 'i'), e.id).not.toThrow();
    }
  });
});

describe('a check per secret shape (CT-736, CT-743; SG-12)', () => {
  const mollie = must('mollie');

  it('checks Mollie’s access tokens with their permissions and its API keys with the methods', () => {
    const forToken = catalogCheckFor(mollie, 'access_abc123');
    expect(forToken).toEqual({ kind: 'request', method: 'GET', path: '/v2/permissions', headers: {} });
    expect(catalogCheckFor(mollie, `live_${'a'.repeat(30)}`)).toBe(mollie.check);
    expect(catalogCheckFor(mollie, '')).toBe(mollie.check);
    expect(resolveCheckPath(mollie, {}, 'access_abc123')).toBe('/v2/permissions');
    expect(resolveCheckPath(mollie, {}, `test_${'a'.repeat(30)}`)).toBe('/v2/methods');
    expect(resolveCheckPath(mollie, {})).toBe('/v2/methods');
  });

  it('keeps the check’s headers and failures, and takes the other request’s own answer rules', () => {
    const entry = {
      check: CatalogCheck.parse({
        kind: 'request',
        method: 'GET',
        path: '/a',
        body: 'x',
        okStatus: [200],
        okJsonPath: 'a',
        headers: { Accept: 'application/json' },
        failures: [{ status: [402], refused: false, text: 'Plan.' }],
        forSecret: [
          { pattern: '^tok_', method: 'POST', path: '/b', okAnswer: { json: 'ok', values: ['true'] } },
          { pattern: '^key_', method: 'GET', path: '/c', headers: {}, okJsonPath: 'c' },
        ],
      }),
    };
    expect(catalogCheckFor(entry, 'TOK_1')).toEqual({
      kind: 'request',
      method: 'POST',
      path: '/b',
      headers: { Accept: 'application/json' },
      okAnswer: { json: 'ok', values: ['true'] },
      failures: [{ status: [402], refused: false, text: 'Plan.' }],
    });
    const c = catalogCheckFor(entry, 'key_1');
    expect(c?.kind === 'request' && [c.path, c.headers, c.okJsonPath]).toEqual(['/c', {}, 'c']);
    expect(
      CatalogCheck.safeParse({
        kind: 'request',
        method: 'GET',
        path: '/a',
        forSecret: Array.from({ length: 5 }, () => ({ pattern: 'x', method: 'GET', path: '/b' })),
      }).success,
    ).toBe(false);
  });

  it('tells how to make a Mollie key or token on its one page', () => {
    const m = mollie.signIn.find((x) => x.kind === 'token');
    if (m?.kind !== 'token') throw new Error('mollie token');
    const steps = m.steps.map((s) => s.text).join(' ');
    for (const words of ['+ Create access token', 'Standard API key', 'Advanced access token', 'once'])
      expect(steps, words).toContain(words);
  });
});

describe('fields filled from the check (CT-737, CT-741; SG-15)', () => {
  const nextcloud = must('nextcloud');

  it('is a field nobody is asked for', () => {
    expect(
      CatalogField.parse({
        id: 'userId',
        label: 'User ID',
        kind: 'text',
        required: false,
        fromCheck: 'ocs.data.id',
      }).fromCheck,
    ).toBe('ocs.data.id');
    expect(
      CatalogField.safeParse({
        id: 'userId',
        label: 'User ID',
        kind: 'text',
        required: false,
        fromCheck: 'a..b',
      }).success,
    ).toBe(false);
    for (const kind of ['nextcloud_login', 'password', 'token'] as const)
      expect(
        fieldsFor(nextcloud, kind).map((f) => f.id),
        kind,
      ).not.toContain('userId');
    expect(
      fieldsProblems(nextcloud, 'token', { url: 'https://cloud.example.com', username: 'mara' }),
    ).toEqual({});
    // A value a client sends back (the edit form) is no unknown field.
    expect(
      fieldsProblems(nextcloud, 'token', {
        url: 'https://cloud.example.com',
        username: 'mara',
        userId: 'u-1',
      }),
    ).toEqual({});
    expect(
      fieldProblem({ id: 'x', label: 'X', kind: 'text', required: true, fromCheck: 'a' }, ''),
    ).toBeNull();
  });

  it('reads Nextcloud’s user id from its check', () => {
    const check = nextcloud.check;
    expect(check).toMatchObject({
      kind: 'request',
      method: 'GET',
      path: '/ocs/v2.php/cloud/user?format=json',
      headers: { 'OCS-APIRequest': 'true', Accept: 'application/json' },
      okJsonPath: 'ocs.data.id',
    });
    const answer = { ocs: { meta: { status: 'ok' }, data: { id: ' 5c1d-uuid ', displayname: 'Mara' } } };
    expect(fieldsFromCheck(nextcloud, answer)).toEqual({ userId: '5c1d-uuid' });
    expect(fieldsFromCheck(nextcloud, { ocs: { data: { id: 42 } } })).toEqual({ userId: '42' });
    expect(fieldsFromCheck(nextcloud, { ocs: { data: {} } })).toEqual({});
    expect(fieldsFromCheck(nextcloud, { ocs: { data: { id: 'a\nb' } } })).toEqual({});
    expect(fieldsFromCheck(nextcloud, null)).toEqual({});
    expect(fieldsFromCheck(must('plex'), answer)).toEqual({});
    expect(nextcloud.guide).toContain('/remote.php/dav/files/<user id>/');
    expect(nextcloud.guide).not.toContain('<username>');
  });

  it('offers Nextcloud’s own login page first', () => {
    expect(nextcloud.signIn.map((m) => m.kind)).toEqual(['nextcloud_login', 'password', 'token']);
  });

  it('keeps every filled field optional and apart from the service’s choices', () => {
    for (const e of CATALOG)
      for (const f of e.fields) {
        if (f.fromCheck === undefined) continue;
        expect(f.required, `${e.id}.${f.id}`).toBe(false);
        expect(f.fromService, `${e.id}.${f.id}`).toBeUndefined();
        expect(e.check?.kind, e.id).toBe('request');
      }
  });
});

describe('Immich’s check (CT-742; SG-16)', () => {
  it('asks whether the key is valid, whatever its permissions', () => {
    const check = must('immich').check;
    expect(check).toMatchObject({ kind: 'request', method: 'POST', path: '/api/auth/validateToken' });
    if (!check) throw new Error('check');
    expect(checkAnswerOk(check, '{"authStatus":true}')).toBe(true);
    expect(checkAnswerOk(check, '{"authStatus":false}')).toBe(false);
    expect(checkAnswerOk(check, '{}')).toBe(false);
  });
});
