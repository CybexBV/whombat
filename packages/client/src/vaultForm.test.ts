import { VAULT_SSH_KEY_PROBLEM_TEXT } from '@whombat/core/vault';
import { describe, expect, it } from 'vitest';
import { ApiError, InvalidRequestError } from './http/errors';
import { VAULT_AUTH_LABELS, vaultAuthOf, vaultFieldProblems, vaultProblemOf } from './vaultForm';

const typed = { headerName: ' X-Key ', queryName: ' token ', username: ' admin ' };

describe('Add to Vault', () => {
  it('saves the sign-in the form chose, its name trimmed', () => {
    expect(vaultAuthOf({ ...typed, auth: 'header' })).toEqual({ type: 'header', name: 'X-Key' });
    expect(vaultAuthOf({ ...typed, auth: 'query' })).toEqual({ type: 'query', name: 'token' });
    expect(vaultAuthOf({ ...typed, auth: 'basic' })).toEqual({ type: 'basic', username: 'admin' });
    expect(vaultAuthOf({ ...typed, auth: 'form' })).toEqual({ type: 'form', username: 'admin' });
    expect(vaultAuthOf({ ...typed, auth: 'none' })).toEqual({ type: 'none' });
    expect(vaultAuthOf({ ...typed, auth: 'bearer' })).toEqual({ type: 'bearer' });
    expect(Object.keys(VAULT_AUTH_LABELS)).toContain('ssh_key');
  });

  it('says the schema’s problems in plain words, the first per field', () => {
    expect(
      vaultFieldProblems([
        { path: ['name'], message: 'Too small: expected string to have >=1 characters' },
        { path: ['name'], message: 'Something else' },
        { path: ['sshKey', 'privateKey'], message: 'Too big: x' },
        { path: ['ports', 0], message: 'Invalid port' },
        { path: [], message: 'Pick one' },
      ]),
    ).toEqual({
      name: 'Give it a name.',
      'sshKey.privateKey': VAULT_SSH_KEY_PROBLEM_TEXT.too_long,
      'ports.0': 'Invalid port',
      form: 'Pick one',
    });
  });

  it('puts a refusal where it belongs', () => {
    const notAllowed = new ApiError(
      400,
      'validation_failed',
      'Not allowed: that address is private.',
      {},
      'vault.create',
      {},
      { code: 'address_not_allowed' },
    );
    expect(vaultProblemOf(notAllowed)).toEqual({
      message: null,
      fields: { url: 'Not allowed: that address is private.' },
    });
    const field = new ApiError(400, 'validation_failed', 'Invalid', {}, 'vault.setSecret', {
      value: ['Too big: x'],
    });
    expect(vaultProblemOf(field).fields).toEqual({ secret: 'That secret is too long.' });
    const invalid = new InvalidRequestError('vault.create', 'body', { name: ['Too small: x'] });
    expect(vaultProblemOf(invalid)).toEqual({ message: null, fields: { name: 'Give it a name.' } });
    expect(vaultProblemOf(new Error('boom'))).toEqual({ message: null, fields: {} });
  });
});
