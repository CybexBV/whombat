import { catalogEntry } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { ApiError, InvalidRequestError } from '../http/errors';
import {
  connectButtonText,
  connectProblem,
  httpWarning,
  SESSION_CHECK_FAILED,
  signInChoices,
  signsInForSession,
  switchText,
  visibleFields,
} from './form';

const entry = (id: string) => {
  const e = catalogEntry(id);
  if (!e) throw new Error(id);
  return e;
};

const apiError = (status: number, code: string, details: unknown, message = '', fields = {}) =>
  new ApiError(status, code as never, message, {}, 'connections.create', fields, details);

describe('the connect form (CX-71, AP-756)', () => {
  it('numbers token sign-ins among themselves for `method`', () => {
    const choices = signInChoices(entry('custom_mcp'));
    expect(choices.map((c) => [c.kind, c.tokenIndex])).toEqual([
      ['none', null],
      ['token', 0],
      ['token', 1],
      ['mcp_oauth', null],
    ]);
    expect(connectButtonText(entry('custom_mcp'), choices[3] as never)).toBe('Continue to MCP server');
    expect(connectButtonText(entry('custom_mcp'), choices[0] as never)).toBe('Connect');
    const once = signInChoices(entry('proxmox'))[0];
    expect(connectButtonText(entry('proxmox'), once as never)).toBe('Sign in and connect');
  });

  it('shows the fields of the chosen sign-in: no service-picked field, a username only for basic auth', () => {
    const nextcloud = entry('nextcloud');
    const choices = signInChoices(nextcloud);
    const login = choices.find((c) => c.kind === 'nextcloud_login');
    const token = choices.find((c) => c.kind === 'token');
    expect(visibleFields(nextcloud, login as never).map((f) => f.id)).toEqual(['url', 'fingerprint']);
    expect(visibleFields(nextcloud, token as never).map((f) => f.id)).toEqual([
      'url',
      'username',
      'fingerprint',
    ]);
    const api = entry('custom_api');
    const [bearer, , basic] = signInChoices(api);
    expect(visibleFields(api, bearer as never).map((f) => f.id)).toEqual([
      'url',
      'description',
      'fingerprint',
    ]);
    expect(visibleFields(api, basic as never).map((f) => f.id)).toEqual([
      'url',
      'username',
      'description',
      'fingerprint',
    ]);
    const moneybird = entry('moneybird');
    expect(visibleFields(moneybird, signInChoices(moneybird)[0] as never).map((f) => f.id)).toEqual([]);
  });

  it('warns about a plain-http address', () => {
    expect(httpWarning({ url: 'http://192.168.1.5:8123' })).toContain('the token crosses');
    expect(httpWarning({ url: 'http://192.168.1.5:8123' }, 'password')).toContain('your password');
    const pihole = catalogEntry('pihole')?.signIn[0];
    expect(httpWarning({ url: 'http://pi.hole' }, 'token', pihole)).toContain('the app password crosses');
    // Plex's own page is https at plex.tv: only the token it gives crosses this address (AP-3902).
    const plex = catalogEntry('plex')?.signIn[0];
    expect(httpWarning({ url: 'http://plex.lan:32400' }, 'service_login', plex, 'plex')).toContain(
      'the token crosses',
    );
    expect(httpWarning({ url: 'https://home.example' })).toBeNull();
    expect(httpWarning({})).toBeNull();
  });
});

describe('refusals in a sentence with the fix (CX-41, CT-269)', () => {
  it('turns an unlisted home-network address into the sentence and Add this network', () => {
    const p = connectProblem(
      apiError(403, 'not_allowed', {
        code: 'destination_refused',
        cidr: '192.168.1.0/24',
        port: 8123,
      }),
    );
    expect(p.message).toBe(
      'That address is on your network. Add 192.168.1.0/24 port 8123 to the home network list to connect.',
    );
    expect(p.network).toEqual({ cidr: '192.168.1.0/24', port: 8123 });
    // A public address refused for another reason belongs under Address.
    expect(
      connectProblem(
        apiError(403, 'not_allowed', { code: 'destination_refused', problem: 'https_only' }, 'Use https.'),
      ).fields,
    ).toEqual({ url: 'Use https.' });
  });

  it('asks which administration when the token reaches several', () => {
    const p = connectProblem(
      apiError(409, 'conflict', {
        code: 'field_choice_needed',
        field: 'administration',
        options: [{ value: '1', label: 'Burrow HQ B.V.' }],
      }),
    );
    expect(p.choice).toEqual({ field: 'administration', options: [{ value: '1', label: 'Burrow HQ B.V.' }] });
    expect(p.message).toBe('Choose one to go on.');
  });

  it('keeps the server’s words when a session’s password is refused, and never names a token (NS-04, AP-3805)', () => {
    const npm = entry('nginx_proxy_manager');
    const method = npm.signIn[0];
    if (!method) throw new Error('no sign-in');
    expect(signsInForSession(method)).toBe(true);
    expect(signsInForSession(entry('homeassistant').signIn[0] ?? method)).toBe(false);
    const words = 'Nginx Proxy Manager refused the password. Check it and try again.';
    const refused = apiError(409, 'conflict', { code: 'check_failed', status: 401 }, words);
    expect(connectProblem(refused, undefined, method).message).toBe(words);
    // The same answer to a token keeps saying the token; without a sentence, the usual one.
    expect(connectProblem(refused).message).toContain('didn’t accept that token');
    expect(
      connectProblem(apiError(409, 'conflict', { code: 'check_failed', status: 200 }), undefined, method)
        .message,
    ).toBe(SESSION_CHECK_FAILED);
  });

  it('says a refused token plainly, puts field problems under their fields, and falls back calmly', () => {
    expect(
      connectProblem(apiError(409, 'conflict', { code: 'check_failed', status: 401 })).message,
    ).toContain('didn’t accept that token');
    expect(
      connectProblem(apiError(409, 'conflict', { code: 'limit_reached', limit: 'shared' })).message,
    ).toBe('That’s as many connections as there can be. Remove one first.');
    expect(
      connectProblem(
        apiError(400, 'validation_failed', undefined, 'Invalid', { 'fields.url': ['Not a URL.'] }),
      ).fields,
    ).toEqual({ url: 'Not a URL.' });
    // The server keys a Custom header shape's problem `auth` (Whombat CX-D07): it belongs under the header name.
    expect(
      connectProblem(
        apiError(400, 'validation_failed', undefined, 'Invalid', {
          auth: ['That header can’t carry a token.'],
        }),
      ).fields,
    ).toEqual({ authName: 'That header can’t carry a token.' });
    expect(
      connectProblem(new InvalidRequestError('connections.create', 'body', { secret: ['Too long.'] })).fields,
    ).toEqual({ secret: 'Too long.' });
    expect(connectProblem(new Error('boom')).message).toBe('That didn’t work. Try again in a moment.');
  });

  it('asks for a second factor’s code, and says what a refused sign in once means (CT-314)', () => {
    const code = connectProblem(
      apiError(
        409,
        'conflict',
        { code: 'second_factor_needed' },
        'Enter the code from your authenticator app, or the one UniFi just emailed you.',
      ),
    );
    expect(code.secondFactor).toBe(
      'Enter the code from your authenticator app, or the one UniFi just emailed you.',
    );
    expect(code.message).toBeNull();
    expect(connectProblem(apiError(409, 'conflict', { code: 'second_factor_needed' })).secondFactor).toBe(
      'Enter the code from your authenticator app.',
    );
    const wrong = connectProblem(
      apiError(
        409,
        'conflict',
        { code: 'sign_in_refused', reason: 'password' },
        'Wrong username, password or realm.',
      ),
    );
    expect([wrong.message, wrong.switchTo]).toEqual(['Wrong username, password or realm.', null]);
    expect(
      connectProblem(apiError(409, 'conflict', { code: 'sign_in_refused', reason: 'code' })).fields,
    ).toEqual({ code: 'That code didn’t work. Enter the newest one.' });
    const nextcloud = connectProblem(
      apiError(
        409,
        'conflict',
        { code: 'sign_in_refused', reason: 'second_factor', method: 'nextcloud_login' },
        'This account uses two-step sign-in. Sign in with Nextcloud instead.',
      ),
    );
    expect(nextcloud.switchTo).toBe('nextcloud_login');
    expect(switchText('nextcloud_login', entry('nextcloud'))).toBe('Sign in with Nextcloud instead');
    expect(
      connectProblem(apiError(409, 'conflict', { code: 'sign_in_refused', reason: 'single_sign_on' }))
        .switchTo,
    ).toBe('token');
    expect(switchText('token', entry('proxmox'))).toBe('Make a token by hand instead');
    expect(
      connectProblem(apiError(409, 'conflict', { code: 'sign_in_refused', reason: 'locked' })).message,
    ).toContain('Wait a few minutes');
  });

  it('keeps the challenge a code belongs to, from the ask and from a refused code (CT-731, SG-06)', () => {
    const asked = connectProblem(
      apiError(
        409,
        'conflict',
        { code: 'second_factor_needed', challenge: 'sealed-1' },
        'Enter the code UniFi just emailed to m•••@example.com.',
      ),
    );
    expect([asked.secondFactor, asked.challenge]).toEqual([
      'Enter the code UniFi just emailed to m•••@example.com.',
      'sealed-1',
    ]);
    const wrong = connectProblem(
      apiError(
        409,
        'conflict',
        { code: 'sign_in_refused', reason: 'code', challenge: 'sealed-2' },
        'That code didn’t work. Enter the newest code.',
      ),
    );
    expect(wrong.challenge).toBe('sealed-2');
    expect(wrong.fields.code).toContain('newest code');
    expect(connectProblem(apiError(409, 'conflict', { code: 'second_factor_needed' })).challenge).toBeNull();
    // Another refusal never carries one.
    expect(
      connectProblem(apiError(409, 'conflict', { code: 'sign_in_refused', reason: 'password' })).challenge,
    ).toBeNull();
  });

  it('names the service’s own page on its button and as the way out (SG-05, AP-3901)', () => {
    const plex = entry('plex');
    const [service, token] = signInChoices(plex);
    if (service?.kind !== 'service_login' || !token) throw new Error('plex sign-ins');
    expect(connectButtonText(plex, service)).toBe(service.label);
    expect(service.label).toBe('Sign in with Plex');
    expect(connectButtonText(plex, token)).toBe('Connect');
    expect(switchText('service_login', plex)).toBe('Sign in with Plex instead');
    expect(
      connectProblem(
        apiError(409, 'conflict', {
          code: 'sign_in_refused',
          reason: 'second_factor',
          method: 'service_login',
        }),
      ).switchTo,
    ).toBe('service_login');
  });

  it('offers the fingerprint a self-signed home-network server presents (CT-313)', () => {
    const fingerprint = Array.from({ length: 32 }, (_, i) => (i * 7).toString(16).padStart(2, '0').slice(-2))
      .join(':')
      .toUpperCase();
    const p = connectProblem(
      apiError(
        409,
        'conflict',
        { code: 'check_failed', certificateSha256: fingerprint },
        `Its certificate can’t be verified: it’s self-signed, expired or for another name. It presents ${fingerprint}; if UniFi Network shows the same fingerprint, use it as the certificate fingerprint.`,
      ),
    );
    expect(p.certificate).toBe(fingerprint);
    expect(p.message).toContain('if UniFi Network shows the same fingerprint');
    expect(
      connectProblem(apiError(409, 'conflict', { code: 'check_failed', status: 500 })).certificate,
    ).toBeNull();
  });
});
