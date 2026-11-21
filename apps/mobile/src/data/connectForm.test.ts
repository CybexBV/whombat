/** Connect {Name}'s model (phone-connect.md PC-03, PC-05; AP-2903…): gates, steps, buttons a refusal brings. */
import { ApiError } from '@whombat/client';
import {
  type ConnectDraft,
  codeShown,
  connectBase,
  connectionWords,
  connectProblem,
  createBody,
  NO_PROBLEM,
  type SignInChoice,
  serviceLoginBody,
  signInChoices,
  signInNote,
  visibleFields,
} from '@whombat/client/connections';
import { type CatalogEntry, catalogEntry } from '@whombat/core';
import type { StartServiceLoginResponse } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import {
  appMissing,
  CONNECT_SCREEN_TEXT,
  catalogConnectErrorText,
  connectGate,
  elsewhereWay,
  fixButtons,
  keptChallenge,
  opensItself,
  opensMore,
  type PendingLogin,
  probedChoice,
  signsInElsewhere,
  stepHeaders,
  submitLabel,
  underLabel,
  waitEnds,
  waitStep,
  waitsHere,
  waitWords,
} from './connectForm';
import { entryOpens } from './connections';

const entry = (id: string): CatalogEntry => {
  const e = catalogEntry(id);
  if (!e) throw new Error(id);
  return e;
};

const apiError = (status: number, code: string, details: unknown, message = '') =>
  new ApiError(status, code as never, message, {}, 'connections.create', {}, details);

const words = connectionWords('Neo');

const FINGERPRINT = Array.from({ length: 32 }, () => 'AB').join(':');

describe('a row of Add a connection opens the phone’s screen (PC-01, PC-02)', () => {
  it('opens a catalog entry’s Connect {Name} and an account’s own screen, never a web page', () => {
    expect(entryOpens('proxmox')).toEqual({ screen: 'Connect', catalogId: 'proxmox' });
    expect(entryOpens('custom_mcp')).toEqual({ screen: 'Connect', catalogId: 'custom_mcp' });
    expect(entryOpens('google')).toEqual({ screen: 'ConnectAccount', page: 'google' });
    expect(entryOpens('imap')).toEqual({ screen: 'ConnectAccount', page: 'imap' });
    expect(entryOpens('github')).toEqual({ screen: 'ConnectAccount', page: 'github' });
    expect(entryOpens('whombat_servers')).toBeNull();
  });
});

describe('whether it can be connected here (ConnectPage’s gates)', () => {
  it('says when it is turned off or its app isn’t set up', () => {
    expect(
      connectGate({
        entry: entry('todoist'),
        status: { catalogId: 'todoist', available: false, reason: 'off' } as never,
      }),
    ).toContain('turned off');
    const dropbox = { catalogId: 'dropbox', available: false, reason: 'app_not_configured' } as never;
    expect(appMissing(entry('dropbox'), dropbox)).toBe(true);
    expect(connectGate({ entry: entry('dropbox'), status: dropbox })).toContain('above first');
    expect(connectGate({ entry: entry('proxmox'), status: undefined })).toBeNull();
  });

  it('says a sign-in needs a secure address before it starts; the iPhone names Tailscale only', () => {
    const status = { catalogId: 'dropbox', available: false, reason: 'needs_secure_address' } as const;
    expect(connectGate({ entry: entry('dropbox'), status })).toContain('Whombat Link');
    const iphone = connectGate({ entry: entry('dropbox'), status, offerLink: false });
    expect(iphone).toContain('Tailscale');
    expect(iphone).not.toContain('Whombat Link');
  });

  it('says a report tracker without a driver here can’t be connected', () => {
    const status = { catalogId: 'tracker', available: false, reason: 'no_driver' } as const;
    expect(connectGate({ entry: entry('tracker'), status })).toContain('can’t be connected');
    expect(
      connectGate({ entry: entry('tracker'), status: { ...status, available: true, reason: null } }),
    ).toBeNull();
  });
});

describe('the steps (CS-50)', () => {
  it('shows Where is it? alone until the address is identified, then the level and the sign-in', () => {
    const proxmox = entry('proxmox');
    const closed = stepHeaders(proxmox, { steps: true, revealed: false, words, identified: null });
    expect(closed.map((h) => h.step)).toEqual(['where']);
    const open = stepHeaders(proxmox, {
      steps: true,
      revealed: true,
      words,
      identified: { reachable: true, catalogId: 'proxmox' },
    });
    expect(open.map((h) => [h.step, h.number])).toEqual([
      ['where', 1],
      ['access', 2],
      ['signIn', 3],
    ]);
    expect(open[0]?.done).toBe(true);
    // The assistant by its name.
    expect(open[1]?.title).toContain('Neo');
    // A cloud service has no address: the level, then the sign-in.
    expect(
      stepHeaders(entry('todoist'), { steps: true, revealed: true, words, identified: null }).map(
        (h) => h.step,
      ),
    ).toEqual(['access', 'signIn']);
    // An older runtime: no steps.
    expect(stepHeaders(proxmox, { steps: false, revealed: true, words, identified: null })).toEqual([]);
  });

  it('says Continue until the address is identified, then the sign-in’s words', () => {
    const proxmox = entry('proxmox');
    const [once] = signInChoices(proxmox);
    if (!once) throw new Error('proxmox');
    expect(submitLabel(proxmox, once, false)).toBe('Continue');
    expect(submitLabel(proxmox, once, true)).toBe('Sign in and connect');
    expect(CONNECT_SCREEN_TEXT.title('Proxmox VE')).toContain('Proxmox VE');
  });
});

describe('what a refusal brings (CX-41, CT-313, CS-09)', () => {
  it('offers Add this network, Use this fingerprint where it can pin, the switch to a token', () => {
    const unifi = entry('unifi_network');
    const choices = signInChoices(unifi);
    const network = connectProblem(
      apiError(403, 'not_allowed', {
        code: 'destination_refused',
        cidr: '192.168.1.0/24',
        port: 443,
      }),
    );
    expect(fixButtons(unifi, network, choices).map((b) => b.kind)).toEqual(['network']);
    const cert = connectProblem(
      apiError(409, 'conflict', { code: 'check_failed', certificateSha256: FINGERPRINT }),
    );
    const hasPin = unifi.fields.some((f) => f.id === 'fingerprint');
    expect(fixButtons(unifi, cert, choices).map((b) => b.kind)).toEqual(hasPin ? ['fingerprint'] : []);
    const sso = connectProblem(
      apiError(409, 'conflict', { code: 'sign_in_refused', reason: 'single_sign_on' }),
    );
    const proxmox = entry('proxmox');
    const toToken = fixButtons(proxmox, sso, signInChoices(proxmox));
    expect(toToken[0]).toMatchObject({ kind: 'switch', index: 1 });
    expect(fixButtons(proxmox, NO_PROBLEM, signInChoices(proxmox))).toEqual([]);
  });

  it('opens More options for a problem with the name or the fingerprint', () => {
    expect(opensMore({ label: 'Too long.' })).toBe(true);
    expect(opensMore({ secret: 'Needed.' })).toBe(false);
  });

  it('says a sign-in elsewhere’s refusal in the web’s words, and something calm for a code it doesn’t know', () => {
    expect(catalogConnectErrorText('access_denied')).toContain('Allow');
    expect(catalogConnectErrorText('nope')).toBe('That didn’t connect. Try again.');
    expect(catalogConnectErrorText(null)).toBeNull();
  });
});

describe('sign-ins elsewhere (PC-05)', () => {
  it('starts over the session on a managed Whombat, opens the web page on a self-hosted one, nothing in the demo', () => {
    expect(elsewhereWay(true, null)).toBe('session');
    expect(elsewhereWay(false, 'https://whombat.lan/')).toBe('web');
    expect(elsewhereWay(false, null)).toBe('none');
    expect(signsInElsewhere({ kind: 'app_oauth' })).toBe(true);
    expect(signsInElsewhere({ kind: 'nextcloud_login' })).toBe(true);
    expect(signsInElsewhere({ kind: 'token' })).toBe(false);
  });

  it('picks the sign-in a Custom MCP server’s probe asks for', () => {
    const choices = signInChoices(entry('custom_mcp'));
    const oauth = probedChoice(choices, { needs: 'oauth', issuer: null, serverName: null, message: null });
    expect(oauth === null ? null : choices[oauth]?.kind).toBe('mcp_oauth');
    expect(
      probedChoice(choices, { needs: 'unreachable', issuer: null, serverName: null, message: null }),
    ).toBeNull();
  });
});

describe('the “‹ …” label when a link opened it', () => {
  it('names the screen under it: a tab, Add a connection, a titled screen, else Back', () => {
    const words = { Dashboard: 'Connections', ChatRoom: 'Chat' };
    expect(underLabel({ name: 'AddConnection' }, words)).toBe('Add a connection');
    expect(
      underLabel(
        { name: 'Tabs', state: { index: 1, routes: [{ name: 'ChatRoom' }, { name: 'Dashboard' }] } },
        words,
      ),
    ).toBe('Connections');
    expect(underLabel({ name: 'Connection', params: { title: 'Home Assistant' } }, words)).toBe(
      'Home Assistant',
    );
    expect(underLabel({ name: 'Connections' }, words)).toBe('Connections');
    expect(underLabel({ name: 'Connect', params: { catalogId: 'proxmox' } }, words)).toContain('Proxmox VE');
    expect(underLabel({ name: 'ConnectAccount', params: { page: 'imap' } }, words)).toBe('Email (IMAP)');
    // Where Back goes isn't known: Back.
    expect(underLabel({ name: 'Thing', params: { thingId: 'connection:con_1' } }, words)).toBe('Back');
    expect(underLabel(undefined, words)).toBe('Back');
  });
});

/* Connections that sign in properly (connection-signin-android.md AP-3950…) -------------------------------------- */

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

const choiceOf = (e: CatalogEntry, kind: string): SignInChoice => {
  const c = signInChoices(e).find((x) => x.kind === kind);
  if (!c) throw new Error(`${e.id} ${kind}`);
  return c;
};

const FLOW: StartServiceLoginResponse = {
  loginUrl: 'https://app.plex.tv/auth#?clientID=c&code=p',
  flowId: 'oas_demo_1',
  pollEveryMs: 2000,
  expiresAt: '2026-10-21T10:10:00Z',
  userCode: null,
};

describe('signing in with Plex on its own page (AP-3950…AP-3953)', () => {
  it('offers Sign in with Plex first, then its token', () => {
    const plex = entry('plex');
    expect(signInChoices(plex).map((c) => c.kind)).toEqual(['service_login', 'token']);
    const login = choiceOf(plex, 'service_login');
    // The card's line is the entry's note; the button its label.
    expect(signInNote(plex, login.method)).toContain('allow Whombat');
    expect(submitLabel(plex, login, true)).toBe('Sign in with Plex');
    expect(submitLabel(plex, login, false)).toBe('Continue');
    // It leaves for the browser and this screen waits for it, on a managed and a self-hosted Whombat alike.
    expect(signsInElsewhere(login)).toBe(true);
    expect(waitsHere(login)).toBe(true);
    expect(waitsHere(choiceOf(entry('nextcloud'), 'nextcloud_login'))).toBe(true);
    expect(waitsHere(choiceOf(entry('homeassistant'), 'ha_oauth'))).toBe(false);
  });

  it('starts with the address and the level, and opens the page by itself except in the demo', () => {
    const plex = entry('plex');
    const login = choiceOf(plex, 'service_login');
    const body = serviceLoginBody(
      plex,
      visibleFields(plex, login),
      draft({ fields: { url: 'http://plex.lan:32400' }, access: 'read' }),
    );
    expect(body).toMatchObject({
      catalogId: 'plex',
      fields: { url: 'http://plex.lan:32400' },
      access: 'read',
    });
    expect(body).not.toHaveProperty('secret');
    expect(opensItself('session')).toBe(true);
    expect(opensItself('web')).toBe(true);
    expect(opensItself('none')).toBe(false);
  });

  it('waits in the service’s name, shows a code to type only when there is one, and gives up at the deadline', () => {
    const plex: PendingLogin = { kind: 'service', flow: FLOW, name: 'Plex' };
    const words = waitWords(plex);
    expect(words.title).toContain('Plex');
    expect(words.open).toContain('Plex');
    expect(words.code).toBeNull();
    const device = waitWords({ ...plex, flow: { ...FLOW, userCode: 'K7QF-2MXP' } });
    expect(device.code?.value).toBe('K7QF-2MXP');
    const nextcloud = waitWords({ kind: 'nextcloud', flow: { ...FLOW } });
    expect(nextcloud.title).toContain('Nextcloud');
    expect(nextcloud.code).toBeNull();
    const now = Date.parse('2026-10-21T10:00:00Z');
    expect(waitEnds(plex, now)).toBe(Date.parse(FLOW.expiresAt));
    expect(waitEnds({ ...plex, flow: { ...FLOW, expiresAt: '2026-10-21T11:00:00Z' } }, now)).toBe(
      now + 10 * 60_000,
    );
  });

  it('reads the poll: wait, connected, failed in the Whombat’s words or the service’s name, expired', () => {
    const plex: PendingLogin = { kind: 'service', flow: FLOW, name: 'Plex' };
    expect(waitStep(plex, { state: 'pending' }).kind).toBe('wait');
    const owner =
      'Plex let Whombat in, but this server didn’t accept your account. Is it the server’s owner?';
    expect(waitStep(plex, { state: 'failed', message: owner })).toEqual({ kind: 'failed', message: owner });
    const silent = waitStep(plex, { state: 'failed', message: '' });
    expect(silent.kind === 'failed' && silent.message).toContain('Plex');
    expect(waitStep(plex, { state: 'expired' })).toEqual({
      kind: 'failed',
      message: waitWords(plex).tooLong,
    });
  });
});

describe('UniFi’s code goes back with its challenge (AP-3955)', () => {
  const unifi = entry('unifi_network');
  const once = choiceOf(unifi, 'password');
  const asked = connectProblem(
    apiError(
      409,
      'second_factor_needed',
      { code: 'second_factor_needed', challenge: 'sealed-1' },
      'Enter it.',
    ),
  );

  it('keeps the challenge the code was asked with, and the new one a refused code came with', () => {
    expect(asked.secondFactor).toBe('Enter it.');
    expect(keptChallenge(asked, null)).toBe('sealed-1');
    const refused = connectProblem(
      apiError(409, 'sign_in_refused', { code: 'sign_in_refused', reason: 'code', challenge: 'sealed-2' }),
    );
    expect(refused.fields.code).toBeTruthy();
    expect(keptChallenge(refused, 'sealed-1')).toBe('sealed-2');
    // A refusal without one keeps what the form holds.
    const plain = connectProblem(
      apiError(409, 'sign_in_refused', { code: 'sign_in_refused', reason: 'code' }),
    );
    expect(keptChallenge(plain, 'sealed-1')).toBe('sealed-1');
    expect(keptChallenge(connectProblem(new Error('offline')), 'sealed-1')).toBe('sealed-1');
  });

  it('sends the code with the challenge, and no challenge without a code', () => {
    const base = { fields: { url: 'https://unifi.lan' }, account: 'mara', password: 'pw', codeAsked: true };
    const sent = createBody(
      unifi,
      once,
      visibleFields(unifi, once),
      draft({ ...base, code: '123456', challenge: keptChallenge(asked, null) }),
    );
    expect(sent.login).toMatchObject({ account: 'mara', code: '123456', challenge: 'sealed-1' });
    const first = createBody(
      unifi,
      once,
      visibleFields(unifi, once),
      draft({ ...base, challenge: 'sealed-1' }),
    );
    expect(first.login).not.toHaveProperty('challenge');
  });
});

describe('Synology’s two-step code, asked once (AP-3956)', () => {
  const synology = entry('synology');
  const session = choiceOf(synology, 'token');

  it('shows the code under the password only once DSM asked, and sends it as code', () => {
    expect(codeShown(session.method, false)).toBe(false);
    expect(codeShown(session.method, true)).toBe(true);
    const typed = draft({
      fields: { url: 'https://nas.lan:5001', username: 'whombat' },
      secret: 'pw',
      code: '123456',
      codeAsked: true,
    });
    const body = createBody(synology, session, visibleFields(synology, session), typed);
    expect(body).toMatchObject({ signIn: 'token', secret: 'pw', code: '123456' });
    expect(body).not.toHaveProperty('login');
    // Plex's token has no two-step code to send.
    const plex = entry('plex');
    const token = choiceOf(plex, 'token');
    expect(createBody(plex, token, visibleFields(plex, token), { ...typed, fields: {} })).not.toHaveProperty(
      'code',
    );
  });
});

describe('fields filled from the check are never asked (AP-3960)', () => {
  it('leaves Nextcloud’s user ID out of every sign-in’s fields and of what is sent', () => {
    const nextcloud = entry('nextcloud');
    const filled = nextcloud.fields.filter((f) => f.fromCheck !== undefined).map((f) => f.id);
    expect(filled).toContain('userId');
    for (const choice of signInChoices(nextcloud)) {
      const shown = visibleFields(nextcloud, choice);
      expect(shown.map((f) => f.id)).not.toContain('userId');
      expect(
        connectBase(nextcloud, shown, draft({ fields: { url: 'https://cloud.lan', userId: 'x' } })).fields,
      ).toEqual({
        url: 'https://cloud.lan',
      });
    }
  });
});
