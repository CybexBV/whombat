import { catalogEntry, fieldsFor } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  authNameOf,
  type ConnectDraft,
  cardOAuthStartBody,
  codeShown,
  connectReturnTo,
  connectsHere,
  createBody,
  draftAuth,
  draftProblems,
  fixedAccountOf,
  initialFields,
  oauthStartBody,
  ownsAuth,
  reconnectServiceLoginBody,
  serviceLoginBody,
  setSecretBody,
} from './draft';
import { asksTwoStepCode, signInChoices, visibleFields } from './form';

const entry = (id: string) => {
  const e = catalogEntry(id);
  if (!e) throw new Error(id);
  return e;
};

const guidedOf = (id: string) => entry(id).signIn.find((m) => m.kind === 'token');

const draft = (over: Partial<ConnectDraft> = {}): ConnectDraft => ({
  fields: {},
  secret: '',
  account: '',
  password: '',
  code: '',
  codeAsked: false,
  authName: '',
  label: '',
  access: 'manage',
  ...over,
});

describe('the connect form’s draft (CS-50, PC-04)', () => {
  it('starts with the entry’s defaults and an address a link filled in', () => {
    const proxmox = entry('proxmox');
    expect(initialFields(proxmox, 'https://pve.lan:8006').url).toBe('https://pve.lan:8006');
    // A cloud service has no address to fill in.
    expect(initialFields(entry('todoist'), 'https://x.example')).not.toHaveProperty('url');
  });

  it('refuses an empty password, account and secret before asking, and a code that is too short', () => {
    const proxmox = entry('proxmox');
    const [once, token] = signInChoices(proxmox);
    if (!once || !token) throw new Error('proxmox sign-ins');
    expect(once.kind).toBe('password');
    const shown = visibleFields(proxmox, once);
    const p = draftProblems(proxmox, once, shown, draft({ fields: { url: 'https://pve.lan:8006' } }));
    expect(Object.keys(p).sort()).toEqual(['account', 'password']);
    expect(
      draftProblems(proxmox, once, shown, {
        ...draft({ fields: { url: 'https://pve.lan:8006' }, account: 'root@pam', password: 'x' }),
        codeAsked: true,
      }),
    ).toHaveProperty('code');
    expect(
      draftProblems(proxmox, once, shown, {
        ...draft({ fields: { url: 'https://pve.lan:8006' }, account: 'root@pam', password: 'x', code: '12' }),
      }),
    ).toHaveProperty('code');
    expect(draftProblems(proxmox, token, visibleFields(proxmox, token), draft())).toHaveProperty('secret');
  });

  it('asks a Custom entry for its header or parameter name', () => {
    const api = entry('custom_api');
    const header = signInChoices(api).find(
      (c) => c.method.kind === 'token' && c.method.auth.type === 'header',
    );
    if (!header) throw new Error('custom_api header');
    expect(ownsAuth(api, header.method)).toBe(true);
    expect(authNameOf(header)).not.toBe('');
    const problems = draftProblems(api, header, visibleFields(api, header), draft({ authName: 'bad name' }));
    expect(problems).toHaveProperty('authName');
    expect(draftAuth(api, header.method, 'X-Api-Key')).toMatchObject({ type: 'header', name: 'X-Api-Key' });
    expect(ownsAuth(entry('homeassistant'), entry('homeassistant').signIn[0] as never)).toBe(false);
  });

  it('sends sign in once’s login with the level, and a token with its secret and which one', () => {
    const proxmox = entry('proxmox');
    const [once, token] = signInChoices(proxmox);
    if (!once || !token) throw new Error('proxmox sign-ins');
    const body = createBody(
      proxmox,
      once,
      visibleFields(proxmox, once),
      draft({ fields: { url: 'https://pve.lan:8006' }, account: 'root@pam', password: 'pw', access: 'read' }),
    );
    expect(body).toMatchObject({
      catalogId: 'proxmox',
      signIn: 'password',
      access: 'read',
      login: { account: 'root@pam', password: 'pw' },
      fields: { url: 'https://pve.lan:8006' },
    });
    expect(body).not.toHaveProperty('secret');
    const tokenBody = createBody(
      proxmox,
      token,
      visibleFields(proxmox, token),
      draft({ fields: { url: 'https://pve.lan:8006' }, secret: '  abc  ', label: ' Lab ' }),
    );
    expect(tokenBody).toMatchObject({ signIn: 'token', method: 0, secret: 'abc', label: 'Lab' });
    expect(tokenBody).not.toHaveProperty('login');
  });

  it('sends no level for a connection only automations use', () => {
    const tracker = entry('tracker');
    const [token] = signInChoices(tracker);
    if (!token) throw new Error('tracker sign-in');
    expect(
      createBody(tracker, token, visibleFields(tracker, token), draft({ secret: 's' })),
    ).not.toHaveProperty('access');
  });

  it('shows the code where it’s optional, or once asked; knows a fixed account', () => {
    const proxmox = entry('proxmox');
    const once = proxmox.signIn.find((m) => m.kind === 'password');
    if (once?.kind !== 'password') throw new Error('proxmox sign in once');
    if (!once.account) throw new Error('proxmox account');
    expect(fixedAccountOf(once)).toBe(once.account.fixed ?? null);
    expect(fixedAccountOf({ ...once, account: { ...once.account, fixed: 'plex.tv' } })).toBe('plex.tv');
    expect(codeShown(once, true)).toBe(true);
    expect(codeShown(entry('todoist').signIn[0] as never, true)).toBe(false);
  });

  it('sends the challenge back with the code, and only with a code (CT-731, SG-06)', () => {
    const unifi = entry('unifi_network');
    const once = signInChoices(unifi).find((c) => c.kind === 'password');
    if (!once) throw new Error('unifi sign in once');
    const shown = visibleFields(unifi, once);
    const typed = { fields: { url: 'https://unifi.lan' }, account: 'mara@example.com', password: 'pw' };
    const answered = createBody(
      unifi,
      once,
      shown,
      draft({ ...typed, code: ' 123456 ', codeAsked: true, challenge: 'sealed-1' }),
    );
    expect(answered.login).toMatchObject({ code: '123456', challenge: 'sealed-1' });
    const first = createBody(unifi, once, shown, draft({ ...typed, challenge: 'sealed-1' }));
    expect(first.login).not.toHaveProperty('challenge');
    expect(first.login).not.toHaveProperty('code');
    expect(createBody(unifi, once, shown, draft({ ...typed, code: '123456' })).login).not.toHaveProperty(
      'challenge',
    );
  });

  it('asks a session’s two-step code once the service does, and sends it as `code` (CT-733, SG-09)', () => {
    const synology = entry('synology');
    const [password] = signInChoices(synology);
    if (!password) throw new Error('synology sign-in');
    expect(asksTwoStepCode(password.method)).toBe(true);
    expect(asksTwoStepCode(guidedOf('pihole'))).toBe(false);
    expect(asksTwoStepCode(entry('proxmox').signIn[0])).toBe(false);
    expect(codeShown(password.method, false)).toBe(false);
    expect(codeShown(password.method, true)).toBe(true);
    const shown = visibleFields(synology, password);
    const typed = { fields: { url: 'https://nas.lan:5001', username: 'whombat' }, secret: 'pw' };
    expect(draftProblems(synology, password, shown, draft({ ...typed, codeAsked: true }))).toHaveProperty(
      'code',
    );
    expect(draftProblems(synology, password, shown, draft(typed))).toEqual({});
    const body = createBody(
      synology,
      password,
      shown,
      draft({ ...typed, code: ' 654321 ', codeAsked: true }),
    );
    expect(body).toMatchObject({ signIn: 'token', secret: 'pw', code: '654321' });
    expect(body).not.toHaveProperty('login');
    expect(createBody(synology, password, shown, draft(typed))).not.toHaveProperty('code');
    // Replace password: the code beside the secret, never for a sign-in without two-step.
    expect(setSecretBody(password.method, 'pw', ' 654321 ')).toEqual({ secret: 'pw', code: '654321' });
    expect(setSecretBody(password.method, 'pw')).toEqual({ secret: 'pw' });
    expect(setSecretBody(guidedOf('pihole'), 'pw', '654321')).toEqual({ secret: 'pw' });
  });

  it('starts the service’s own page with the level, and signs a connection in again by its id (CT-738)', () => {
    const plex = entry('plex');
    const [service] = signInChoices(plex);
    if (service?.kind !== 'service_login') throw new Error('plex service login');
    expect(connectsHere(service)).toBe(false);
    const body = serviceLoginBody(
      plex,
      visibleFields(plex, service),
      draft({ fields: { url: 'http://plex.lan:32400' }, access: 'read', label: ' Living room ' }),
    );
    expect(body).toEqual({
      catalogId: 'plex',
      label: 'Living room',
      fields: { url: 'http://plex.lan:32400' },
      access: 'read',
    });
    expect(
      reconnectServiceLoginBody({
        id: 'con_1',
        catalogId: 'plex',
        fields: { url: 'http://plex.lan:32400' },
        access: 'read',
      }),
    ).toMatchObject({ connectionId: 'con_1', access: 'read' });
  });

  it('connects token, none, sign in once and an OAuth client here; the rest sign in elsewhere', () => {
    expect(
      ['token', 'none', 'password', 'client_credentials'].every((k) => connectsHere({ kind: k as never })),
    ).toBe(true);
    expect(connectsHere({ kind: 'ha_oauth' })).toBe(false);
    expect(connectsHere({ kind: 'nextcloud_login' })).toBe(false);
  });

  it('comes back to the entry’s form in its burrow, or keeps a valid return path', () => {
    expect(connectReturnTo('dropbox', 'burrow-hq')).toContain('connection=dropbox');
    expect(connectReturnTo('dropbox', 'burrow-hq')).toContain('burrow-hq');
    const thread = '/burrow-hq/chat?thread=msg_1&guide=msg_2';
    expect(connectReturnTo('custom_mcp', 'burrow-hq', thread)).toBe(thread);
    expect(connectReturnTo('custom_mcp', 'burrow-hq', 'https://evil.example/x')).toContain(
      'connection=custom_mcp',
    );
    expect(fieldsFor(entry('dropbox'), 'app_oauth')).toBeDefined();
    const mcp = entry('custom_mcp');
    const oauth = signInChoices(mcp).find((c) => c.kind === 'mcp_oauth');
    if (!oauth) throw new Error('custom_mcp oauth');
    expect(
      oauthStartBody(
        mcp,
        visibleFields(mcp, oauth),
        draft({ fields: { url: 'https://mcp.example.com/mcp' }, access: 'read', label: ' Docs ' }),
        'mcp_oauth',
        thread,
      ),
    ).toEqual({
      catalogId: 'custom_mcp',
      label: 'Docs',
      fields: { url: 'https://mcp.example.com/mcp' },
      method: 'mcp_oauth',
      access: 'read',
      returnTo: thread,
    });
    expect(
      cardOAuthStartBody({
        catalogId: 'custom_mcp',
        method: 'mcp_oauth',
        label: 'Docs',
        url: 'https://mcp.example.com/mcp',
        access: 'read',
        returnTo: thread,
      }),
    ).toEqual({
      catalogId: 'custom_mcp',
      method: 'mcp_oauth',
      label: 'Docs',
      fields: { url: 'https://mcp.example.com/mcp' },
      access: 'read',
      returnTo: thread,
    });
  });
});
