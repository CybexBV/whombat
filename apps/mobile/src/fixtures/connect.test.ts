/** The demo world's connect answers (phone-connect.md AP-2916) parse with their endpoints' schemas and refuse as the web's. */

import { Connection, catalogEntry } from '@whombat/core';
import {
  ConnectionDiscovery,
  ConnectionErrorDetails,
  ConnectionWriteResponse,
  IdentifyConnectionResponse,
  ImapDiscoverResponse,
  PollServiceLoginResponse,
  StartServiceLoginResponse,
} from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import {
  createConnectFixtures,
  DEMO_CERTIFICATE,
  DEMO_SERVICE_LOGIN_POLLS,
  DEMO_USER_CODE,
  demoIdentify,
} from './connect';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const now = () => new Date('2026-10-19T10:00:00Z');
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

describe('the demo world connects (AP-2916)', () => {
  it('identifies pve as Proxmox VE on its own certificate, down as nothing answering', () => {
    const pve = IdentifyConnectionResponse.parse(demoIdentify(catalogEntry('proxmox'), 'pve.lan'));
    expect(pve).toMatchObject({ reachable: true, catalogId: 'proxmox', version: '9.0.10' });
    expect(pve.url).toContain('8006');
    expect(pve.certificate).toEqual({ sha256: DEMO_CERTIFICATE, trusted: false });
    expect(demoIdentify(catalogEntry('proxmox'), 'down.lan').reachable).toBe(false);
  });

  it('refuses as a Whombat would, then connects and lists what it made', async () => {
    const f = createConnectFixtures({ now, json, burrowId: 'bur_demo' });
    const refusalOf = async (r: Response | null) => {
      const body = (await r?.json()) as { error: { details: unknown } };
      return ConnectionErrorDetails.parse(body.error.details).code;
    };
    const base = { catalogId: 'proxmox', fields: { url: 'https://pve.lan:8006' } };
    expect(
      await refusalOf(
        await f.handle(
          'connections.create',
          {},
          post({ ...base, signIn: 'password', login: { account: 'wrong', password: 'x' } }),
        ),
      ),
    ).toBe('sign_in_refused');
    expect(
      await refusalOf(
        await f.handle(
          'connections.create',
          {},
          post({ ...base, signIn: 'password', login: { account: 'root', password: '2fa' } }),
        ),
      ),
    ).toBe('second_factor_needed');
    expect(
      await refusalOf(
        await f.handle(
          'connections.create',
          {},
          post({ ...base, fields: { url: 'https://192.168.1.5:8006' }, signIn: 'token', secret: 's' }),
        ),
      ),
    ).toBe('destination_refused');
    expect(
      await refusalOf(
        await f.handle('connections.create', {}, post({ ...base, signIn: 'token', secret: 's' })),
      ),
    ).toBe('check_failed');
    const made = await f.handle(
      'connections.create',
      {},
      post({
        ...base,
        fields: { ...base.fields, fingerprint: DEMO_CERTIFICATE },
        signIn: 'token',
        secret: 's',
        access: 'read',
      }),
    );
    expect(made?.status).toBe(201);
    const written = ConnectionWriteResponse.parse(await made?.json());
    expect(written.connection.access).toBe('read');
    expect(f.added().map((c) => c.id)).toEqual([written.connection.id]);
  });

  it('scans for three polls, then finds Proxmox VE and Portainer', async () => {
    const f = createConnectFixtures({ now, json, burrowId: 'bur_demo' });
    let last: ConnectionDiscovery | null = null;
    for (let i = 0; i < 4; i++)
      last = ConnectionDiscovery.parse(await (await f.handle('connections.discover', {}, post({})))?.json());
    expect(last?.state).toBe('done');
    expect(last?.found.map((s) => s.catalogId)).toEqual(['proxmox', 'portainer']);
  });

  it('finds Fastmail’s servers, refuses the password wrong, and connects the mailbox', async () => {
    const f = createConnectFixtures({ now, json, burrowId: 'bur_demo' });
    const found = ImapDiscoverResponse.parse(
      await (await f.handle('connectors.imapDiscover', {}, post({ email: 'mara@fastmail.com' })))?.json(),
    );
    expect(found.settings?.imap.host).toBe('imap.fastmail.com');
    const wrong = await f.handle(
      'connectors.imapConnect',
      {},
      post({ email: 'mara@fastmail.com', password: 'wrong' }),
    );
    expect(wrong?.status).toBe(409);
    const ok = await f.handle(
      'connectors.imapConnect',
      {},
      post({ email: 'mara@fastmail.com', password: 'pw' }),
    );
    expect(Connection.parse(await ok?.json()).email).toBe('mara@fastmail.com');
  });

  const details = async (r: Response | null) => {
    const body = (await r?.json()) as { error: { details: unknown } };
    return ConnectionErrorDetails.parse(body.error.details);
  };

  it('signs in to Plex on its own page: pending, then connected; again on the same connection (AP-3959)', async () => {
    const f = createConnectFixtures({ now, json, burrowId: 'bur_demo' });
    const base = {
      catalogId: 'plex',
      fields: { url: 'http://plex.lan:32400' },
      access: 'read',
    };
    const start = async (body: unknown) =>
      StartServiceLoginResponse.parse(
        await (await f.handle('connections.startServiceLogin', {}, post(body)))?.json(),
      );
    const poll = async (flowId: string) =>
      PollServiceLoginResponse.parse(
        await (await f.handle('connections.pollServiceLogin', { flowId }, post({})))?.json(),
      );
    const flow = await start(base);
    expect(flow.userCode).toBeNull();
    for (let i = 1; i < DEMO_SERVICE_LOGIN_POLLS; i++)
      expect((await poll(flow.flowId)).state).toBe('pending');
    const done = await poll(flow.flowId);
    if (done.state !== 'connected') throw new Error(done.state);
    expect(done.connection).toMatchObject({ catalogId: 'plex', signIn: 'token', access: 'read' });
    // A flow that ended is expired.
    expect((await poll(flow.flowId)).state).toBe('expired');
    // Sign in again: the same connection, no second one.
    const again = await start({ ...base, connectionId: done.connection.id });
    for (let i = 0; i < DEMO_SERVICE_LOGIN_POLLS; i++) await poll(again.flowId);
    expect(f.added().map((c) => c.id)).toEqual([done.connection.id]);
    // A device-code service's code; a server that didn't accept the account; an unlisted home address.
    expect((await start({ ...base, fields: { url: 'http://link.lan:32400' } })).userCode).toBe(
      DEMO_USER_CODE,
    );
    const wrong = await start({ ...base, fields: { url: 'http://wrong.lan:32400' } });
    let last: PollServiceLoginResponse | null = null;
    for (let i = 0; i < DEMO_SERVICE_LOGIN_POLLS; i++) last = await poll(wrong.flowId);
    expect(last?.state).toBe('failed');
    const unlisted = await f.handle(
      'connections.startServiceLogin',
      {},
      post({ ...base, fields: { url: 'http://192.168.1.20:32400' } }),
    );
    expect((await details(unlisted)).code).toBe('destination_refused');
  });

  it('takes UniFi’s code only with the challenge it handed back (AP-3962)', async () => {
    const f = createConnectFixtures({ now, json, burrowId: 'bur_demo' });
    const create = (login: Record<string, string>) =>
      f.handle(
        'connections.create',
        {},
        post({
          catalogId: 'unifi_network',
          fields: { url: 'https://unifi.lan' },
          signIn: 'password',
          login: { account: 'mara', password: '2fa', ...login },
        }),
      );
    const asked = await details(await create({}));
    expect(asked.code).toBe('second_factor_needed');
    expect(asked.challenge).toBeTruthy();
    // Without its challenge the code starts afresh: asked again, with a new challenge.
    const fresh = await details(await create({ code: '123456' }));
    expect(fresh.code).toBe('second_factor_needed');
    expect(fresh.challenge).not.toBe(asked.challenge);
    const wrong = await details(await create({ code: '000000', challenge: fresh.challenge ?? '' }));
    expect(wrong).toMatchObject({ code: 'sign_in_refused', reason: 'code' });
    expect(wrong.challenge).not.toBe(fresh.challenge);
    const made = await create({ code: '123456', challenge: wrong.challenge ?? '' });
    expect(made?.status).toBe(201);
  });

  it('asks Synology DSM for a code once, on connect and on Replace password (AP-3965)', async () => {
    const f = createConnectFixtures({ now, json, burrowId: 'bur_demo' });
    const body = {
      catalogId: 'synology',
      fields: { url: 'https://nas.lan:5001', username: 'whombat' },
      signIn: 'token',
      secret: '2fa',
    };
    expect((await details(await f.handle('connections.create', {}, post(body)))).code).toBe(
      'second_factor_needed',
    );
    expect(
      await details(await f.handle('connections.create', {}, post({ ...body, code: '000000' }))),
    ).toMatchObject({ code: 'sign_in_refused', reason: 'code' });
    const made = ConnectionWriteResponse.parse(
      await (await f.handle('connections.create', {}, post({ ...body, code: '123456' })))?.json(),
    );
    const connectionId = made.connection.id;
    const replace = (b: unknown) => f.handle('connections.setSecret', { connectionId }, post(b));
    expect((await details(await replace({ secret: '2fa' }))).code).toBe('second_factor_needed');
    const replaced = ConnectionWriteResponse.parse(
      await (await replace({ secret: '2fa', code: '654321' }))?.json(),
    );
    expect(replaced.connection.status).toBe('active');
    // A connection the demo didn't make here is the rest of the world's.
    expect(
      await f.handle('connections.setSecret', { connectionId: 'con_ha' }, post({ secret: 's' })),
    ).toBeNull();
  });
});
