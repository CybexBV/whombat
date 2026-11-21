import { afterEach, describe, expect, it } from 'vitest';
import { AUTHENTICATOR_CODE } from './home-common';
import { HA_TOKEN_ICON, provisionHomeAssistant } from './homeassistant';
import {
  expectStop,
  type Stub,
  type StubReply,
  type StubRequest,
  type StubSocket,
  startStub,
  stubInput,
  TEST_PASSWORD,
} from './testing-home';

/** A Home Assistant as CS-22 reads it: the login flow, `/auth/token`, `/auth/revoke` and the WebSocket API. */
interface HaWorld {
  /** The account's MFA modules (`totp`, `notify`), and the code that passes. */
  modules?: string[];
  code?: string;
  /** The account's tokens before Whombat signs in. */
  tokens?: { id: string; client_name: string; client_icon?: string | null; type: string }[];
  /**
   * The auth providers configured (`homeassistant` by default); `GET /auth/providers` answers them as `{providers}` or,
   * before 2024.2, as a bare list (`listShape`), or not at all (`providersUnreadable`: before onboarding).
   */
  providers?: string[];
  listShape?: boolean;
  providersUnreadable?: boolean;
  banned?: boolean;
  localOnly?: boolean;
  /** The 403 text of a blocked login (“User is local only” through the cloud). */
  blockedText?: string;
  /** This Whombat's address isn't a client id Home Assistant takes. */
  clientIdRefused?: boolean;
  abortAfterWrongCode?: boolean;
  authInvalid?: boolean;
}

const LONG_LIVED = 'long_lived_access_token';

function fakeHomeAssistant(world: HaWorld) {
  const flows = new Map<string, { step: string; module?: string }>();
  const tokens = [...(world.tokens ?? [])];
  const revoked: string[] = [];
  let n = 0;
  const form = (step_id: string, extra: Record<string, unknown> = {}) => ({
    type: 'form',
    flow_id: 'f1',
    handler: ['homeassistant', null],
    step_id,
    data_schema: [],
    errors: {},
    ...extra,
  });
  const mfaForm = (module: string, errors = {}) =>
    form('mfa', {
      data_schema: [{ name: 'code', type: 'string', required: true }],
      description_placeholders: { mfa_module_name: module.toUpperCase(), mfa_module_id: module },
      errors,
    });
  const providers = world.providers ?? ['homeassistant'];
  const created = (): StubReply =>
    world.localOnly
      ? {
          status: 403,
          json: { message: `Login blocked: ${world.blockedText ?? 'User cannot authenticate remotely'}` },
        }
      : {
          json: {
            type: 'create_entry',
            flow_id: 'f1',
            handler: ['homeassistant', null],
            result: 'authcode-1',
          },
        };

  const route = (req: StubRequest): StubReply => {
    if (req.method === 'GET' && req.path === '/auth/providers') {
      if (world.banned) return { status: 403, body: '403: Forbidden' };
      if (world.providersUnreadable)
        return { status: 400, json: { message: 'Onboarding not finished', code: 'onboarding_required' } };
      const list = providers.map((type) => ({ name: type, id: null, type }));
      return { json: world.listShape ? list : { providers: list, preselect_remember_me: false } };
    }
    if (req.method === 'POST' && req.path === '/auth/login_flow') {
      if (world.banned) return { status: 403, body: '403: Forbidden' };
      if (world.clientIdRefused) return { status: 400, json: { message: 'Invalid client id' } };
      // An unknown handler isn't caught: Home Assistant answers 500 (SG-14).
      if (!providers.includes(req.json().handler?.[0]))
        return { status: 500, body: '500 Internal Server Error' };
      flows.set('f1', { step: 'init' });
      return { json: form('init', { data_schema: [{ name: 'username' }, { name: 'password' }] }) };
    }
    if (req.path === '/auth/login_flow/f1') {
      const flow = flows.get('f1');
      if (!flow) return { status: 404, json: { message: 'Invalid flow specified' } };
      if (req.method === 'DELETE') {
        flows.delete('f1');
        return { json: { message: 'Flow aborted' } };
      }
      const body = req.json();
      if (body.client_id !== 'https://whombat.home.test/')
        return { status: 400, json: { message: 'Invalid client id' } };
      if (flow.step === 'init') {
        if (body.username !== 'mara' || body.password !== TEST_PASSWORD) {
          return { json: form('init', { errors: { base: 'invalid_auth' } }) };
        }
        const modules = world.modules ?? [];
        if (modules.length === 0) return created();
        if (modules.length > 1) {
          flow.step = 'select_mfa_module';
          return {
            json: form('select_mfa_module', {
              data_schema: [
                {
                  name: 'multi_factor_auth_module',
                  type: 'select',
                  options: modules.map((m) => [m, m.toUpperCase()]),
                  required: true,
                },
              ],
            }),
          };
        }
        flow.step = 'mfa';
        flow.module = modules[0];
        return { json: mfaForm(flow.module as string) };
      }
      if (flow.step === 'select_mfa_module') {
        flow.step = 'mfa';
        flow.module = body.multi_factor_auth_module;
        return { json: mfaForm(flow.module as string) };
      }
      if (flow.step === 'mfa') {
        if (body.code === world.code) return created();
        if (world.abortAfterWrongCode) return { json: { type: 'abort', reason: 'too_many_retry' } };
        return { json: mfaForm(flow.module as string, { base: 'invalid_code' }) };
      }
    }
    if (req.method === 'POST' && req.path === '/auth/token') {
      const f = req.form();
      if (f.grant_type !== 'authorization_code' || f.code !== 'authcode-1') {
        return { status: 400, json: { error: 'invalid_request' } };
      }
      return {
        json: {
          access_token: 'session-access',
          token_type: 'Bearer',
          refresh_token: 'session-refresh',
          expires_in: 1800,
        },
      };
    }
    if (req.method === 'POST' && req.path === '/auth/revoke') {
      revoked.push(req.form().token ?? '');
      return { json: {} };
    }
    return { status: 404, body: '404: Not Found' };
  };

  const websocket = {
    open: (socket: StubSocket) => socket.send({ type: 'auth_required', ha_version: '2026.10.1' }),
    // biome-ignore lint/suspicious/noExplicitAny: the client's messages.
    message: (socket: StubSocket, m: any) => {
      if (m.type === 'auth') {
        socket.send(
          m.access_token === 'session-access' && !world.authInvalid
            ? { type: 'auth_ok', ha_version: '2026.10.1' }
            : { type: 'auth_invalid', message: 'Invalid access token or password' },
        );
        return;
      }
      // Something unrelated first, as Home Assistant may send.
      socket.send({ id: 999, type: 'event', event: {} });
      if (m.type === 'auth/refresh_tokens') {
        socket.send({
          id: m.id,
          type: 'result',
          success: true,
          result: [
            { id: 'session', client_name: null, client_icon: null, type: 'normal', is_current: true },
            ...tokens.map((t) => ({ client_icon: null, ...t, is_current: false })),
          ],
        });
      } else if (m.type === 'auth/delete_refresh_token') {
        const i = tokens.findIndex((t) => t.id === m.refresh_token_id);
        if (i < 0) {
          socket.send({ id: m.id, type: 'result', success: false, error: { code: 'invalid_token_id' } });
          return;
        }
        tokens.splice(i, 1);
        socket.send({ id: m.id, type: 'result', success: true, result: {} });
      } else if (m.type === 'auth/long_lived_access_token') {
        if (tokens.some((t) => t.client_name === m.client_name && t.type === LONG_LIVED)) {
          socket.send({ id: m.id, type: 'result', success: false, error: { code: 'unknown_error' } });
          return;
        }
        tokens.push({
          id: `llat-${++n}`,
          client_name: m.client_name,
          client_icon: m.client_icon,
          type: LONG_LIVED,
        });
        socket.send({ id: m.id, type: 'result', success: true, result: `eyJhbGciOi.long-lived-${n}.sig` });
      }
    },
  };
  return { route, websocket, tokens, revoked, flows };
}

let stub: Stub | null = null;
afterEach(async () => {
  await stub?.close();
  stub = null;
});

async function homeAssistant(world: HaWorld = {}) {
  const fake = fakeHomeAssistant(world);
  stub = await startStub(fake.route, { websocket: fake.websocket });
  return { ...fake, stub };
}

const created = (s: Stub) =>
  s.socketMessages.filter((m) => (m as { type: string }).type === 'auth/long_lived_access_token');

describe('Home Assistant (CS-22)', () => {
  it('makes a long-lived token named Whombat at either level, and revokes its session', async () => {
    for (const access of ['read', 'manage'] as const) {
      const { stub, tokens, revoked } = await homeAssistant();
      const made = await provisionHomeAssistant(stubInput(stub, 'homeassistant', { access }));
      expect(made).toEqual({
        fields: {},
        secret: 'eyJhbGciOi.long-lived-1.sig',
        limited: false,
        externalName: null,
        note: null,
      });
      const start = stub.calls('POST /auth/login_flow')[0]?.json();
      expect(start).toEqual({
        client_id: 'https://whombat.home.test/',
        handler: ['homeassistant', null],
        redirect_uri: 'https://whombat.home.test/',
      });
      expect(stub.calls('POST /auth/token')[0]?.form()).toEqual({
        grant_type: 'authorization_code',
        code: 'authcode-1',
        client_id: 'https://whombat.home.test/',
      });
      expect(stub.socketMessages[0]).toEqual({ type: 'auth', access_token: 'session-access' });
      expect(created(stub)).toEqual([
        {
          id: 2,
          type: 'auth/long_lived_access_token',
          client_name: 'Whombat',
          client_icon: HA_TOKEN_ICON,
          lifespan: 3650,
        },
      ]);
      expect(tokens.map((t) => t.client_name)).toEqual(['Whombat']);
      expect(revoked).toEqual(['session-refresh']);
      await stub.close();
    }
  });

  it('names the token after this Whombat', async () => {
    const { stub } = await homeAssistant();
    await provisionHomeAssistant(stubInput(stub, 'homeassistant', { name: 'Whombat (Lumio)' }));
    expect(created(stub)[0]).toMatchObject({ client_name: 'Whombat (Lumio)' });
  });

  it('never deletes a token, not even Whombat’s own: it takes the next free name', async () => {
    const { stub, tokens } = await homeAssistant({
      tokens: [
        { id: 'ours', client_name: 'Whombat', client_icon: HA_TOKEN_ICON, type: LONG_LIVED },
        { id: 'theirs', client_name: 'Whombat 2', type: LONG_LIVED },
        // A sign-in session of that name isn't a long-lived token: the name is free.
        { id: 'refresh', client_name: 'Whombat 3', type: 'normal' },
      ],
    });
    await provisionHomeAssistant(stubInput(stub, 'homeassistant'));
    expect(
      stub.socketMessages.some((m) => (m as { type: string }).type === 'auth/delete_refresh_token'),
    ).toBe(false);
    expect(created(stub)[0]).toMatchObject({ client_name: 'Whombat 3', client_icon: HA_TOKEN_ICON });
    expect(tokens.map((t) => t.id)).toEqual(['ours', 'theirs', 'refresh', 'llat-1']);
  });

  it('refuses a wrong password, and aborts the flow', async () => {
    const { stub, flows } = await homeAssistant();
    const stop = await expectStop(
      provisionHomeAssistant(stubInput(stub, 'homeassistant', { password: 'nope' })),
      'password',
      'nope',
    );
    expect(stop.message).toBe('Wrong username or password.');
    expect(flows.size).toBe(0);
    expect(stub.calls('POST /auth/token')).toHaveLength(0);
  });

  it('asks for the authenticator code, then signs in from the start with it', async () => {
    const world = { modules: ['totp'], code: '135790' };
    const first = await homeAssistant(world);
    const stop = await expectStop(
      provisionHomeAssistant(stubInput(first.stub, 'homeassistant')),
      'second_factor_needed',
    );
    expect(stop.message).toBe(AUTHENTICATOR_CODE);
    expect(first.flows.size).toBe(0);
    await first.stub.close();

    const second = await homeAssistant(world);
    const made = await provisionHomeAssistant(stubInput(second.stub, 'homeassistant', { code: '135 790' }));
    expect(made.secret).toMatch(/^eyJ/);
    const steps = second.stub.calls('POST /auth/login_flow/f1').map((r) => r.json());
    expect(steps).toEqual([
      { client_id: 'https://whombat.home.test/', username: 'mara', password: TEST_PASSWORD },
      { client_id: 'https://whombat.home.test/', code: '135790' },
    ]);
  });

  it('picks the authenticator app among several modules', async () => {
    const { stub } = await homeAssistant({ modules: ['notify', 'totp'], code: '135790' });
    await provisionHomeAssistant(stubInput(stub, 'homeassistant', { code: '135790' }));
    const steps = stub.calls('POST /auth/login_flow/f1').map((r) => r.json());
    expect(steps[1]).toEqual({ client_id: 'https://whombat.home.test/', multi_factor_auth_module: 'totp' });
    expect(steps[2]).toEqual({ client_id: 'https://whombat.home.test/', code: '135790' });
  });

  it('can’t use codes sent as notifications: sign in with Home Assistant instead (SG-14)', async () => {
    const { stub } = await homeAssistant({ modules: ['notify'], code: '1' });
    const stop = await expectStop(provisionHomeAssistant(stubInput(stub, 'homeassistant')), 'unsupported');
    expect(stop.message).toContain('notifications');
    expect(stop.method).toBe('ha_oauth');
  });

  it('signs in at command_line where there is no homeassistant provider (SG-14)', async () => {
    for (const listShape of [false, true]) {
      const { stub } = await homeAssistant({ providers: ['command_line'], listShape });
      const made = await provisionHomeAssistant(stubInput(stub, 'homeassistant'));
      expect(made.secret).toMatch(/^eyJ/);
      expect(stub.calls('POST /auth/login_flow')[0]?.json().handler).toEqual(['command_line', null]);
      await stub.close();
    }
  });

  it('prefers the homeassistant provider, and keeps it when the providers can’t be read', async () => {
    const both = await homeAssistant({ providers: ['trusted_networks', 'command_line', 'homeassistant'] });
    await provisionHomeAssistant(stubInput(both.stub, 'homeassistant'));
    expect(both.stub.calls('POST /auth/login_flow')[0]?.json().handler).toEqual(['homeassistant', null]);
    await both.stub.close();

    const unread = await homeAssistant({ providersUnreadable: true });
    await provisionHomeAssistant(stubInput(unread.stub, 'homeassistant'));
    expect(unread.stub.calls('POST /auth/login_flow')[0]?.json().handler).toEqual(['homeassistant', null]);
  });

  it('sends a Home Assistant without password sign-in to its own sign-in, before or at the flow (SG-14)', async () => {
    const trusted = await homeAssistant({ providers: ['trusted_networks'] });
    const before = await expectStop(
      provisionHomeAssistant(stubInput(trusted.stub, 'homeassistant')),
      'unsupported',
    );
    expect(before.method).toBe('ha_oauth');
    expect(trusted.stub.calls('POST /auth/login_flow')).toHaveLength(0);
    await trusted.stub.close();

    // The providers couldn't be read, and the flow answers 500 for the missing handler.
    const at = await homeAssistant({ providers: ['trusted_networks'], providersUnreadable: true });
    const stop = await expectStop(provisionHomeAssistant(stubInput(at.stub, 'homeassistant')), 'unsupported');
    expect(stop.method).toBe('ha_oauth');
    expect(stop.message).not.toContain('500');
  });

  it('says when Home Assistant doesn’t take this Whombat’s address (SG-14)', async () => {
    const { stub } = await homeAssistant({ clientIdRefused: true });
    const stop = await expectStop(provisionHomeAssistant(stubInput(stub, 'homeassistant')), 'unsupported');
    expect(stop.message).toContain('this Whombat’s address');
    expect(stop.method).toBe('token');
  });

  it('refuses a wrong code, and says when Home Assistant gave up', async () => {
    const wrong = await homeAssistant({ modules: ['totp'], code: '135790' });
    await expectStop(
      provisionHomeAssistant(stubInput(wrong.stub, 'homeassistant', { code: '000000' })),
      'code',
    );
    await wrong.stub.close();

    const gaveUp = await homeAssistant({ modules: ['totp'], code: '135790', abortAfterWrongCode: true });
    await expectStop(
      provisionHomeAssistant(stubInput(gaveUp.stub, 'homeassistant', { code: '000000' })),
      'locked',
    );
  });

  it('refuses an account that may only sign in from home (also through the cloud), and a ban', async () => {
    const local = await homeAssistant({ localOnly: true });
    const stop = await expectStop(provisionHomeAssistant(stubInput(local.stub, 'homeassistant')), 'rights');
    expect(stop.message).toBe('This account may only sign in from the home network.');
    await local.stub.close();

    const cloud = await homeAssistant({ localOnly: true, blockedText: 'User is local only' });
    const fromCloud = await expectStop(
      provisionHomeAssistant(stubInput(cloud.stub, 'homeassistant')),
      'rights',
    );
    expect(fromCloud.message).toBe('This account may only sign in from the home network.');
    await cloud.stub.close();

    const banned = await homeAssistant({ banned: true });
    await expectStop(provisionHomeAssistant(stubInput(banned.stub, 'homeassistant')), 'locked');
  });

  it('revokes the session when the WebSocket refuses it', async () => {
    const { stub, revoked } = await homeAssistant({ authInvalid: true });
    await expectStop(provisionHomeAssistant(stubInput(stub, 'homeassistant')), 'unsupported');
    expect(revoked).toEqual(['session-refresh']);
  });
});
