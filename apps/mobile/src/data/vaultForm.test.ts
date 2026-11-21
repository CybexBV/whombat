import { ApiError } from '@whombat/client';
import { describe, expect, it } from 'vitest';
import {
  checksAfterAdd,
  emptyVaultForm,
  FIRST_PHONE_TEMPLATE,
  phoneVaultTemplates,
  replaceProblemOf,
  replaceSecretModel,
  setSecretBody,
  VAULT_FORM_TEXT,
  type VaultForm,
  vaultAddressHint,
  vaultCreateBody,
  vaultFormFields,
  vaultFormProblems,
} from './vaultForm';

const form = (
  patch: Partial<VaultForm>,
  template: Parameters<typeof emptyVaultForm>[0] = 'token',
): VaultForm => ({
  ...emptyVaultForm(template),
  ...patch,
});

describe('Add to Vault on the phone', () => {
  it('offers every new template but an SSH key, and a website login only where the Whombat has them', () => {
    // No secret entry any more (CT-823; AP-4156), and no Connection: MCP servers are in Connections (VLT-30).
    expect(phoneVaultTemplates()).toEqual(['token', 'basic', 'login']);
    expect(emptyVaultForm(FIRST_PHONE_TEMPLATE).auth).toBe('bearer');
  });

  it('shows the fields of the template and its sign-in choice', () => {
    const token = vaultFormFields('token', form({ url: 'http://192.168.1.10:8123/api' }));
    expect(token).toMatchObject({
      addressLabel: 'Address',
      auths: ['bearer', 'header', 'query'],
      headerName: false,
      username: false,
      secret: true,
      secretLabel: 'Token',
    });
    expect(token.httpWarning).toMatch(/^This address uses http/);
    expect(vaultFormFields('token', form({ auth: 'query' }, 'token')).queryWarning).toMatch(/^Query strings/);
    expect(vaultFormFields('basic', form({}, 'basic'))).toMatchObject({
      auths: [],
      username: true,
      secretLabel: 'Password',
    });
    expect(vaultFormFields('login', form({}, 'login'))).toMatchObject({
      addressLabel: 'Sign-in page',
      username: true,
    });
  });

  it('builds vault.create’s body from the template', () => {
    expect(
      vaultCreateBody(
        'token',
        form({
          name: ' Grafana ',
          url: ' http://grafana.local/api ',
          auth: 'header',
          headerName: ' X-Key ',
          secret: 's3',
        }),
      ),
    ).toEqual({
      name: 'Grafana',
      description: '',
      kind: 'http',
      url: 'http://grafana.local/api',
      auth: { type: 'header', name: 'X-Key' },
      secret: 's3',
    });
    // A website login without selectors: the browser finds the fields itself.
    expect(
      vaultCreateBody(
        'login',
        form({ name: 'Shop', url: 'https://shop.example.com', username: ' me@x.nl ', secret: 'pw' }, 'login'),
      ),
    ).toMatchObject({ kind: 'login', auth: { type: 'form', username: 'me@x.nl' } });
  });

  it('refuses before sending what the contract would, in plain words', () => {
    const problems = vaultFormProblems('basic', form({}, 'basic'));
    expect(problems.name).toBe('Give it a name.');
    expect(problems['auth.username']).toBe('Add the username.');
    expect(
      vaultFormProblems(
        'token',
        form({ name: 'x'.repeat(61), url: 'https://grafana.example.com', secret: 'k' }, 'token'),
      ).name,
    ).toBe('Keep the name to 60 characters.');
    expect(
      vaultFormProblems(
        'token',
        form({ name: 'Grafana', url: 'https://grafana.example.com', secret: 't' }, 'token'),
      ),
    ).toEqual({});
  });

  it('checks the connection after adding, except a website login (and an SSH key or old secret)', () => {
    expect(['mcp', 'http', 'secret', 'login', 'ssh'].map(checksAfterAdd)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('says what the address may be', () => {
    expect(vaultAddressHint([])).toBe(
      'Public addresses need https. Nothing on your network is on the home network list yet.',
    );
    expect(vaultAddressHint([{ cidr: '192.168.1.0/24', ports: [80, 8123] }])).toBe(
      'Public addresses need https. On your network: 192.168.1.0/24 · ports 80, 8123.',
    );
  });
});

describe('Replace on the phone', () => {
  it('asks for the username too on basic auth and a website login', () => {
    expect(replaceSecretModel({ type: 'basic', username: 'admin' })).toEqual({
      none: false,
      withUsername: true,
      username: 'admin',
      label: 'Password',
    });
    expect(replaceSecretModel({ type: 'bearer' })).toMatchObject({ withUsername: false, label: 'Secret' });
    expect(replaceSecretModel({ type: 'none' }).none).toBe(true);
    expect(replaceSecretModel(null)).toMatchObject({ none: false, withUsername: false });
  });

  it('sends the username only when it changed', () => {
    const auth = { type: 'form' as const, username: 'me@x.nl' };
    expect(setSecretBody(auth, 'pw', ' me@x.nl ')).toEqual({ value: 'pw' });
    expect(setSecretBody(auth, 'pw', 'you@x.nl')).toEqual({ value: 'pw', username: 'you@x.nl' });
    expect(setSecretBody({ type: 'bearer' }, 'tok', 'ignored')).toEqual({ value: 'tok' });
  });

  it('shows the value’s refusal under the secret, and a plain message otherwise', () => {
    const field = new ApiError(400, 'validation_failed', 'Invalid', {}, 'vault.setSecret', {
      value: ['Too big: x'],
    });
    expect(replaceProblemOf(field)).toEqual({
      message: null,
      fields: { secret: 'That secret is too long.' },
    });
    expect(replaceProblemOf(new Error('boom'))).toEqual({ message: VAULT_FORM_TEXT.failed, fields: {} });
  });
});
