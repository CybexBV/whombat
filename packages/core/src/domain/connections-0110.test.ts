/**
 * Contracts 0.110.0 (Whombat desk-found.md DF-08, NS-01…NS-08; CT-702…CT-710): taglines, the session sign-in grown for
 * Synology and QNAP (a form or a query, base64 templates, a token from XML, stale answers, refusals in the person's
 * words), and the found-on-your-network events.
 */
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from './audit.js';
import {
  CATALOG,
  CATALOG_IDS,
  CATALOG_TAGLINE_MAX,
  CatalogEntry,
  type CatalogEntryInput,
  callAccess,
  catalogEntry,
  checkAnswerOk,
  fillSessionTemplate,
  isReadRequest,
  probeMatches,
  probeVersion,
  REQUEST_TOOL_NAME,
  requestAllowed,
  SESSION_LOGIN_FAILURE_WORDS,
  SESSION_LOGIN_FAILURES,
  SessionAnswerMatch,
  sensitiveReason,
  sessionAnswerExpiresAt,
  sessionAnswerToken,
  sessionIsStale,
  sessionLoginFailure,
  sessionLoginFailureText,
  sessionLoginRequest,
  sessionLogoutRequest,
  sessionTemplateFields,
  sessionToken,
  TokenAuth,
  tokenAuthProblem,
  xmlElementText,
} from './connections-catalog.js';

const base: CatalogEntryInput = {
  id: 'sample',
  name: 'Sample NAS',
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
const fields = { url: 'https://nas.lan:5001/', username: 'whombat' };
type Session = Extract<TokenAuth, { type: 'session' }>;
const session = (input: unknown): Session => {
  const a = TokenAuth.parse(input);
  if (a.type !== 'session') throw new Error('session');
  return a;
};

// Shaped like Synology's (JSON answers with `error.code`, the session as `_sid`).
const jsonForm = session({
  type: 'session',
  login: {
    path: '/webapi/entry.cgi',
    encoding: 'form',
    body: {
      api: 'SYNO.API.Auth',
      version: '6',
      method: 'login',
      account: '{username}',
      passwd: '{secret}',
      format: 'sid',
    },
  },
  tokenJsonPath: 'data.sid',
  apply: { type: 'query', name: '_sid' },
  logout: {
    method: 'GET',
    path: '/webapi/entry.cgi',
    query: { api: 'SYNO.API.Auth', version: '6', method: 'logout' },
  },
  stale: [{ json: 'error.code', values: ['106', '107', '119'] }],
  failures: [
    { json: 'error.code', values: ['400'], reason: 'refused' },
    { json: 'error.code', values: ['403', '406'], reason: 'two_step' },
    { json: 'error.code', values: ['407'], reason: 'locked', text: 'Unblock it under Security.' },
  ],
});

// Shaped like QNAP's (XML answers, a base64 password, the session as `sid`).
const xmlForm = session({
  type: 'session',
  login: {
    path: '/cgi-bin/authLogin.cgi',
    encoding: 'form',
    body: { user: '{username}', pwd: '{secret:base64}' },
  },
  tokenXmlTag: 'authSid',
  apply: { type: 'query', name: 'sid' },
  stale: [
    { xml: 'authPassed', values: ['0'] },
    { json: 'status', values: ['3'], path: '^/cgi-bin/filemanager/' },
  ],
  failures: [
    { xml: 'need_2sv', values: ['1'], reason: 'two_step' },
    { xml: 'authPassed', values: ['0'], reason: 'refused' },
  ],
});

const qnapAnswer = (passed: string, sid = '') =>
  `<?xml version="1.0" encoding="UTF-8" ?>\n<QDocRoot version="1.0">\n<authPassed><![CDATA[${passed}]]></authPassed>\n<authSid><![CDATA[${sid}]]></authSid>\n<username><![CDATA[whombat]]></username>\n</QDocRoot>`;

describe('taglines (CT-702, DF-08)', () => {
  it('gives every entry a scan can find a short line on what it is', () => {
    const findable = CATALOG.filter((e) => e.discovery !== null);
    expect(findable.length).toBeGreaterThanOrEqual(25);
    for (const e of findable) {
      expect(e.tagline, e.id).toBeTruthy();
      expect([...(e.tagline ?? '')].length, e.id).toBeLessThanOrEqual(CATALOG_TAGLINE_MAX);
      expect(e.tagline, e.id).not.toMatch(/[.']$|'/);
    }
    expect(CATALOG.find((e) => e.id === 'homeassistant')?.tagline).toBe('Lights, heating and sensors');
  });

  it('refuses a full stop at the end, a second line and more than 40 characters', () => {
    expect(CatalogEntry.safeParse({ ...base, tagline: 'Storage and snapshots' }).success).toBe(true);
    expect(CatalogEntry.safeParse({ ...base, tagline: 'Storage and snapshots.' }).success).toBe(false);
    expect(CatalogEntry.safeParse({ ...base, tagline: 'Storage\nand snapshots' }).success).toBe(false);
    expect(CatalogEntry.safeParse({ ...base, tagline: 'x'.repeat(41) }).success).toBe(false);
    expect(CatalogEntry.parse(base).tagline).toBeUndefined();
  });
});

describe('the session sign-in grown for Synology and QNAP (CT-703…CT-707, NS-03)', () => {
  it('keeps a JSON sign-in as it was: Pi-hole’s request is the same JSON as before 0.110', () => {
    const pihole = session({
      type: 'session',
      login: { method: 'POST', path: '/api/auth', body: { password: '{secret}' } },
      tokenJsonPath: 'session.sid',
      apply: { type: 'header', name: 'X-FTL-SID' },
    });
    expect(pihole.login.encoding).toBeUndefined();
    expect(pihole.login.query).toBeUndefined();
    expect(pihole.stale).toBeUndefined();
    expect(pihole.failures).toBeUndefined();
    expect(sessionLoginRequest(entry, pihole, 'p"w', fields)).toEqual({
      method: 'POST',
      path: '/api/auth',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{"password":"p\\"w"}',
    });
  });

  it('sends a form, or a GET with the values in the query', () => {
    const form = sessionLoginRequest(entry, jsonForm, 'p&ss wörd', fields);
    expect(form?.method).toBe('POST');
    expect(form?.path).toBe('/webapi/entry.cgi');
    expect(form?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(form?.body).toBe(
      'api=SYNO.API.Auth&version=6&method=login&account=whombat&passwd=p%26ss%20w%C3%B6rd&format=sid',
    );
    const get = session({
      type: 'session',
      login: {
        method: 'GET',
        path: '/cgi-bin/authLogin.cgi',
        body: {},
        query: { user: '{username}', pwd: '{secret:base64}' },
      },
      tokenXmlTag: 'authSid',
      apply: { type: 'query', name: 'sid' },
    });
    expect(sessionLoginRequest(entry, get, 'pässword', fields)).toEqual({
      method: 'GET',
      path: '/cgi-bin/authLogin.cgi?user=whombat&pwd=cMOkc3N3b3Jk',
      headers: { accept: 'application/xml, text/xml' },
      body: null,
    });
    expect(sessionLoginRequest(entry, jsonForm, '', fields)).toBeNull();
    expect(sessionLoginRequest(entry, jsonForm, 'pw', { url: 'https://nas.lan' })).toBeNull();
  });

  it('fills base64 templates from the secret or a field, in one pass', () => {
    expect(fillSessionTemplate(entry, '{secret:base64}', 'admin', fields)).toBe('YWRtaW4=');
    expect(fillSessionTemplate(entry, '{username:base64}-{url}', 's', fields)).toBe(
      'd2hvbWJhdA==-https://nas.lan:5001',
    );
    expect(fillSessionTemplate(entry, '{secret}', '{username}', fields)).toBe('{username}');
    expect(sessionTemplateFields('{user}:{secret:base64}{x:b64}')).toEqual(['user', 'secret']);
    expect(xmlForm.login.body.pwd).toBe('{secret:base64}');
  });

  it('signs out with a fixed query and the session where it goes', () => {
    expect(sessionLogoutRequest(jsonForm, 'sid+1')).toEqual({
      method: 'GET',
      path: '/webapi/entry.cgi?api=SYNO.API.Auth&version=6&method=logout&_sid=sid%2B1',
      headers: { accept: 'application/json' },
    });
    expect(sessionLogoutRequest(xmlForm, 't')).toBeNull();
  });

  it('reads the token from JSON or from XML, exactly one of them', () => {
    expect(sessionAnswerToken(jsonForm, '{"data":{"sid":"abc","did":"d"},"success":true}')).toBe('abc');
    expect(sessionAnswerToken(jsonForm, '{"error":{"code":400},"success":false}')).toBeNull();
    expect(sessionAnswerToken(jsonForm, 'not json')).toBeNull();
    expect(sessionAnswerToken(xmlForm, qnapAnswer('1', 'x1y2z3'))).toBe('x1y2z3');
    expect(sessionAnswerToken(xmlForm, qnapAnswer('0'))).toBeNull();
    expect(sessionAnswerToken(xmlForm, '<authSid>a\r\nb</authSid>')).toBeNull();
    expect(sessionToken(xmlForm, qnapAnswer('1', 'x1'))).toBe('x1');
    expect(sessionToken(xmlForm, { authSid: 'x1' })).toBeNull();
    expect(sessionAnswerExpiresAt(xmlForm, qnapAnswer('1', 'x1'), 0)).toBe(1_800_000);
    const both = { ...jsonForm, tokenXmlTag: 'authSid' };
    expect(TokenAuth.safeParse(both).success).toBe(false);
    expect(TokenAuth.safeParse({ ...jsonForm, tokenJsonPath: undefined }).success).toBe(false);
    expect(tokenAuthProblem(entry, both as Session)).toContain('one of them');
  });

  it('reads XML elements: CDATA, entities, attributes, empty ones', () => {
    expect(xmlElementText('<a><b x="1"> v &amp; w </b></a>', 'b')).toBe('v & w');
    expect(xmlElementText('<version><![CDATA[5.2.4]]></version>', 'version')).toBe('5.2.4');
    expect(xmlElementText('<authSid/>', 'authSid')).toBe('');
    expect(xmlElementText('<authSidx>1</authSidx>', 'authSid')).toBeNull();
    expect(xmlElementText('<n>&#x41;&#66;&bogus;</n>', 'n')).toBe('AB&bogus;');
  });

  it('knows a 2xx answer that means the session ended, by JSON, XML or a path', () => {
    expect(sessionIsStale(jsonForm, 200, '{"error":{"code":119},"success":false}')).toBe(true);
    expect(sessionIsStale(jsonForm, 200, '{"error":{"code":105},"success":false}')).toBe(false);
    expect(sessionIsStale(jsonForm, 401, '{"error":{"code":119},"success":false}')).toBe(false);
    expect(sessionIsStale(jsonForm, 200, '{"data":{},"success":true}')).toBe(false);
    expect(sessionIsStale(xmlForm, 200, qnapAnswer('0'))).toBe(true);
    expect(sessionIsStale(xmlForm, 200, qnapAnswer('1', 's'))).toBe(false);
    expect(
      sessionIsStale(xmlForm, 200, '{"status":3}', '/cgi-bin/filemanager/utilRequest.cgi?func=get_tree'),
    ).toBe(true);
    expect(sessionIsStale(xmlForm, 200, '{"status":3}', '/cgi-bin/application/appRequest.cgi')).toBe(false);
    expect(SessionAnswerMatch.safeParse({ values: ['1'] }).success).toBe(false);
    expect(SessionAnswerMatch.safeParse({ json: 'a', xml: 'b', values: ['1'] }).success).toBe(false);
  });

  it('says why a sign-in was refused, in the entry’s words or the reason’s', () => {
    expect(sessionLoginFailure(entry, jsonForm, '{"error":{"code":400},"success":false}')).toEqual({
      reason: 'refused',
      text: 'Sample NAS refused the account name or password. Check them and try again.',
    });
    expect(sessionLoginFailure(entry, jsonForm, '{"error":{"code":406},"success":false}')?.text).toContain(
      'Turn off two-step sign-in for the user Whombat signs in as',
    );
    expect(sessionLoginFailure(entry, jsonForm, '{"error":{"code":407},"success":false}')).toEqual({
      reason: 'locked',
      text: 'Unblock it under Security.',
    });
    expect(sessionLoginFailure(entry, jsonForm, '{"data":{"sid":"x"},"success":true}')).toBeNull();
    // The first that matches decides: two-step before a plain refusal.
    expect(
      sessionLoginFailure(entry, xmlForm, `${qnapAnswer('0')}<need_2sv><![CDATA[1]]></need_2sv>`)?.reason,
    ).toBe('two_step');
    expect(sessionLoginFailure(entry, xmlForm, qnapAnswer('0'))?.reason).toBe('refused');
    expect(sessionLoginFailure(entry, xmlForm, qnapAnswer('1', 's'))).toBeNull();
    for (const r of SESSION_LOGIN_FAILURES) {
      expect(SESSION_LOGIN_FAILURE_WORDS[r]).not.toMatch(/'/);
      expect(sessionLoginFailureText(entry, r)).not.toContain('{name}');
    }
  });

  it('refuses a session shape that can’t work', () => {
    expect(tokenAuthProblem(entry, jsonForm)).toBeNull();
    expect(tokenAuthProblem(entry, xmlForm)).toBeNull();
    const noSecret = session({ ...xmlForm, login: { ...xmlForm.login, body: { user: '{username}' } } });
    expect(tokenAuthProblem(entry, noSecret)).toContain('{secret}');
    const unknown = session({ ...xmlForm, login: { ...xmlForm.login, query: { x: '{nope:base64}' } } });
    expect(tokenAuthProblem(entry, unknown)).toContain('{nope}');
    const getBody = session({ ...xmlForm, login: { ...xmlForm.login, method: 'GET' } });
    expect(tokenAuthProblem(entry, getBody)).toContain('query');
    const leaky = session({
      ...jsonForm,
      logout: { method: 'GET', path: '/webapi/entry.cgi', query: { passwd: '{secret}' } },
    });
    expect(tokenAuthProblem(entry, leaky)).toContain('sign-out');
  });
});

const must = (id: string) => {
  const e = catalogEntry(id);
  if (!e) throw new Error(id);
  return e;
};
const sessionOf = (id: string): Session => {
  const m = must(id).signIn[0];
  if (m?.kind !== 'token' || m.auth.type !== 'session') throw new Error(`${id} has no session`);
  return m.auth;
};
const answer = (body: string, status = 200) => ({ status, headers: {}, body });
const call = (id: string, query: Record<string, string>, path: string) => {
  const args = { method: 'GET', path, query };
  const access = callAccess(must(id), REQUEST_TOOL_NAME, args);
  return { access, asks: sensitiveReason(must(id), REQUEST_TOOL_NAME, args, { access }) };
};

describe('Synology DSM (CT-708, NS-01…NS-07)', () => {
  const auth = sessionOf('synology');
  const fields = { url: 'https://nas.lan:5001', username: 'whombat' };

  it('is findable, after TrueNAS, with a tagline', () => {
    expect(CATALOG_IDS.indexOf('synology')).toBe(CATALOG_IDS.indexOf('truenas') + 1);
    expect(must('synology').discovery?.targets).toEqual([
      { port: 5001, scheme: 'https' },
      { port: 5000, scheme: 'http' },
    ]);
    const probe = must('synology').discovery?.probes[0];
    if (!probe) throw new Error('probe');
    expect(probe.path).toContain('api=SYNO.API.Info');
    const info =
      '{"data":{"SYNO.API.Auth":{"path":"entry.cgi","minVersion":1,"maxVersion":7}},"success":true}';
    expect(probeMatches(probe, answer(info))).toBe(true);
    expect(probeMatches(probe, answer('{"data":{},"success":true}'))).toBe(false);
    expect(probeMatches(probe, answer(info, 404))).toBe(false);
  });

  it('signs in with a form, the routing in the query, and sends the session as _sid', () => {
    const req = sessionLoginRequest(must('synology'), auth, 'pw', fields);
    expect(req?.method).toBe('POST');
    expect(req?.path).toBe('/webapi/entry.cgi?api=SYNO.API.Auth&version=6&method=login');
    expect(req?.body).toBe('account=whombat&passwd=pw&session=webui&format=sid');
    expect(req?.body).not.toContain('api=');
    const ok = '{"data":{"did":"d","is_portal_port":false,"sid":"s1d","synotoken":"t"},"success":true}';
    expect(sessionAnswerToken(auth, ok)).toBe('s1d');
    expect(sessionLogoutRequest(auth, 's1d')?.path).toBe(
      '/webapi/entry.cgi?api=SYNO.API.Auth&version=6&method=logout&_sid=s1d',
    );
  });

  it('says why DSM refused, and signs in again when a session ended', () => {
    const refusal = (code: number) =>
      sessionLoginFailure(must('synology'), auth, `{"error":{"code":${code}},"success":false}`)?.reason;
    // 403 and 404 belong to `twoStep` since 0.111 (CT-740; SG-09).
    expect([400, 401, 402, 403, 404, 406, 407, 408, 409, 410, 411].map(refusal)).toEqual([
      'refused',
      'disabled',
      'denied',
      undefined,
      undefined,
      'two_step',
      'locked',
      'expired',
      'expired',
      'expired',
      'locked',
    ]);
    expect(refusal(100)).toBeUndefined();
    for (const code of [106, 107, 119, 150])
      expect(sessionIsStale(auth, 200, `{"error":{"code":${code}},"success":false}`), String(code)).toBe(
        true,
      );
    expect(sessionIsStale(auth, 200, '{"error":{"code":105},"success":false}')).toBe(false);
  });

  it('reads by its method, only with GET, and asks for power, deleting, users, storage and updates', () => {
    const path = '/webapi/entry.cgi';
    const q = (api: string, method: string, more: Record<string, string> = {}) => ({
      api,
      version: '1',
      method,
      ...more,
    });
    expect(call('synology', q('SYNO.Core.System', 'info'), path)).toEqual({ access: 'read', asks: null });
    expect(call('synology', q('SYNO.Storage.CGI.Storage', 'load_info'), path).access).toBe('read');
    expect(call('synology', q('SYNO.Core.User', 'list'), path)).toEqual({ access: 'read', asks: null });
    expect(call('synology', q('SYNO.Docker.Container', 'start', { name: 'plex' }), path)).toEqual({
      access: 'write',
      asks: null,
    });
    expect(call('synology', q('SYNO.Core.System', 'shutdown'), path).asks).toContain('Shuts down');
    expect(call('synology', q('SYNO.Core.System', 'reboot'), path).asks).toContain('restarts');
    expect(call('synology', q('SYNO.Core.Share', 'delete', { name: 'photos' }), path).asks).toContain(
      'Deletes',
    );
    expect(call('synology', q('SYNO.Core.Share.Snapshot', 'delete'), path).asks).toContain('Deletes');
    expect(call('synology', q('SYNO.Core.User', 'set'), path).asks).toContain('users');
    expect(call('synology', q('SYNO.Core.Share.Permission', 'set'), path).asks).toContain('permissions');
    expect(call('synology', q('SYNO.Storage.CGI.Pool', 'create'), path).asks).toContain('storage');
    expect(call('synology', q('SYNO.Storage.CGI.Smart', 'secure_erase'), path).asks).toBeTruthy();
    expect(call('synology', q('SYNO.Core.Upgrade', 'start'), path).asks).toContain('update');
    expect(call('synology', q('SYNO.Core.Upgrade.Server', 'check'), path)).toEqual({
      access: 'read',
      asks: null,
    });
    // Without a method nothing reads; a POST isn't allowed at all.
    expect(isReadRequest(must('synology'), 'GET', path, undefined, { api: 'SYNO.Core.System' })).toBe(false);
    expect(requestAllowed(must('synology'), {}, 'POST', path)).toBe(false);
    expect(requestAllowed(must('synology'), {}, 'GET', path)).toBe(true);
    expect(requestAllowed(must('synology'), {}, 'GET', '/webman/index.cgi')).toBe(false);
  });

  it('checks the session with File Station’s information', () => {
    const check = must('synology').check;
    expect(check?.kind === 'request' && check.path).toContain('SYNO.FileStation.Info');
    expect(check?.kind === 'request' && check.okJsonPath).toBe('data');
  });
});

describe('QNAP (CT-709, NS-01…NS-07)', () => {
  const auth = sessionOf('qnap');
  const fields = { url: 'https://qnap.lan', username: 'whombat' };
  const discovery = (version: string) =>
    `<?xml version="1.0" encoding="UTF-8" ?><QDocRoot version="1.0"><authPassed><![CDATA[0]]></authPassed><model><modelName><![CDATA[TS-X53B]]></modelName><displayModelName><![CDATA[TS-453B]]></displayModelName></model><firmware><version><![CDATA[${version}]]></version><number><![CDATA[2782]]></number></firmware></QDocRoot>`;

  it('is findable, after Synology, with its firmware as the version', () => {
    expect(CATALOG_IDS.indexOf('qnap')).toBe(CATALOG_IDS.indexOf('synology') + 1);
    const probe = must('qnap').discovery?.probes[0];
    if (!probe) throw new Error('probe');
    expect(probeMatches(probe, answer(discovery('5.2.4')))).toBe(true);
    expect(probeVersion(probe, answer(discovery('5.2.4')))).toBe('5.2.4');
    expect(probeVersion(probe, answer(discovery('h5.2.0.2782')))).toBe('h5.2.0.2782');
    expect(
      probeVersion(probe, answer('<QDocRoot version="1.0"><firmware><version>4.5.4</version></firmware>')),
    ).toBe('4.5.4');
    expect(probeMatches(probe, answer('<html>QNAP</html>'))).toBe(false);
  });

  it('signs in with a form and a base64 password, and reads the session from XML', () => {
    const req = sessionLoginRequest(must('qnap'), auth, 'admin', fields);
    expect(req).toEqual({
      method: 'POST',
      path: '/cgi-bin/authLogin.cgi',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/xml, text/xml' },
      body: 'user=whombat&pwd=YWRtaW4%3D&serviceKey=1',
    });
    expect(sessionAnswerToken(auth, qnapAnswer('1', 'ral08opo'))).toBe('ral08opo');
    expect(sessionLogoutRequest(auth, 'ral08opo')?.path).toBe(
      '/cgi-bin/authLogout.cgi?logout=1&sid=ral08opo',
    );
  });

  it('says why QTS refused, two-step first, and signs in again when a session ended', () => {
    const fail = (body: string) => sessionLoginFailure(must('qnap'), auth, body)?.reason;
    expect(fail(`${qnapAnswer('0')}<errorValue><![CDATA[-1]]></errorValue>`)).toBe('refused');
    expect(fail(`${qnapAnswer('0')}<need_2sv><![CDATA[1]]></need_2sv>`)).toBe('two_step');
    expect(fail(`${qnapAnswer('0')}<PermissionDeny><![CDATA[1]]></PermissionDeny>`)).toBe('denied');
    expect(fail(qnapAnswer('1', 's'))).toBeUndefined();
    expect(sessionIsStale(auth, 200, qnapAnswer('0'), '/cgi-bin/management/manaRequest.cgi')).toBe(true);
    expect(sessionIsStale(auth, 200, '{"status":3}', '/cgi-bin/filemanager/utilRequest.cgi')).toBe(true);
    expect(sessionIsStale(auth, 200, '{"status":4}', '/cgi-bin/filemanager/utilRequest.cgi')).toBe(false);
    const check = must('qnap').check;
    if (!check) throw new Error('check');
    expect(checkAnswerOk(check, '{"status":1,"success":"true"}')).toBe(true);
    expect(checkAnswerOk(check, '{"status":3}')).toBe(false);
    expect(checkAnswerOk(must('synology').check ?? check, 'anything')).toBe(true);
  });

  it('reads by its function parameters, and asks for power, deleting, storage, users and firmware', () => {
    expect(
      call('qnap', { subfunc: 'sysinfo', hd: 'no', multicpu: '1' }, '/cgi-bin/management/manaRequest.cgi'),
    ).toEqual({ access: 'read', asks: null });
    expect(call('qnap', { func: 'all_hd_data' }, '/cgi-bin/disk/qsmart.cgi').access).toBe('read');
    expect(
      call('qnap', { chart_func: 'disk_usage', disk_select: 'all' }, '/cgi-bin/management/chartReq.cgi')
        .access,
    ).toBe('read');
    expect(
      call('qnap', { subfunc: 'qpkg', apply: '10', action: 'reload' }, '/cgi-bin/application/appRequest.cgi'),
    ).toEqual({ access: 'read', asks: null });
    expect(
      call('qnap', { subfunc: 'qpkg', apply: '3', name: 'Plex' }, '/cgi-bin/application/appRequest.cgi'),
    ).toEqual({
      access: 'write',
      asks: null,
    });
    expect(call('qnap', { subfunc: 'firm_update' }, '/cgi-bin/sys/sysRequest.cgi')).toEqual({
      access: 'read',
      asks: null,
    });
    expect(
      call('qnap', { subfunc: 'power_mgmt', apply: 'shutdown' }, '/cgi-bin/sys/sysRequest.cgi').asks,
    ).toContain('Shuts down');
    expect(
      call('qnap', { func: 'delete', path: '/Public' }, '/cgi-bin/filemanager/utilRequest.cgi').asks,
    ).toContain('Deletes');
    expect(
      call('qnap', { func: 'del_snapshots', snapshotID: '3' }, '/cgi-bin/disk/snapshot.cgi').asks,
    ).toContain('Deletes');
    expect(
      call('qnap', { func: 'volume_mgmt', vol_remove: '1', volumeID: '2' }, '/cgi-bin/disk/disk_manage.cgi')
        .asks,
    ).toContain('volume');
    expect(call('qnap', { subfunc: 'user', apply: '1' }, '/cgi-bin/priv/privRequest.cgi').asks).toContain(
      'users',
    );
    expect(call('qnap', { wiz_func: 'user_create' }, '/cgi-bin/wizReq.cgi').asks).toContain('users');
    expect(
      call('qnap', { subfunc: 'firm_update', apply: '1' }, '/cgi-bin/sys/sysRequest.cgi').asks,
    ).toBeTruthy();
    // A call that names no function is a change; sign-in and sign-out are out of reach.
    expect(call('qnap', { wiz_func: 'share_property' }, '/cgi-bin/wizReq.cgi').access).toBe('write');
    expect(requestAllowed(must('qnap'), {}, 'GET', '/cgi-bin/authLogin.cgi')).toBe(false);
    expect(requestAllowed(must('qnap'), {}, 'GET', '/cgi-bin/authLogout.cgi')).toBe(false);
    expect(requestAllowed(must('qnap'), {}, 'POST', '/cgi-bin/disk/qsmart.cgi')).toBe(false);
  });
});

describe('found on your network in the log (CT-710, CS-D47)', () => {
  it('names hiding and showing a found service again', () => {
    expect(EVENT_TYPES['connection.found_hidden']).toBe('System');
    expect(EVENT_TYPES['connection.found_shown']).toBe('System');
  });
});
