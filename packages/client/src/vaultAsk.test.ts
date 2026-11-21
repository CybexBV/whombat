import { type GuideFormBlock, GuideVaultAsk } from '@whombat/core/domain';
import { VAULT_ASK_FIELDS, VAULT_ASK_TEXT, VAULT_TOTP_PROBLEM_TEXT, vaultAskCard } from '@whombat/core/vault';
import { describe, expect, it } from 'vitest';
import {
  vaultAskKept,
  vaultAskOf,
  vaultAskProblems,
  vaultAskShownFields,
  vaultAskValues,
  vaultAskWays,
  vaultEntryStaysMcp,
  vaultKeptPasswordLine,
  vaultTotpLine,
} from './vaultAsk';

const ask = (over: Record<string, unknown>) => GuideVaultAsk.parse({ name: 'github.com', ...over });

function formOf(a: GuideVaultAsk): GuideFormBlock {
  const card = vaultAskCard('Dusty', a, 'To open your pull request.');
  const form = card.blocks.find((b) => b.type === 'form');
  if (form?.type !== 'form') throw new Error('no form');
  return form;
}

const ids = (fields: readonly { id: string }[]) => fields.map((f) => f.id);

const SERVER = ask({
  kind: 'server',
  name: 'prod-1',
  username: 'deploy',
  server: { host: '192.168.1.20', port: 22, reason: 'key_refused' },
});

describe('the sign-in card', () => {
  it('is a secret card with its ask', () => {
    const card = vaultAskCard('Dusty', SERVER, null);
    expect(vaultAskOf(card)?.kind).toBe('server');
    expect(vaultAskOf({ guide: 'email', vaultAsk: undefined })).toBeNull();
  });

  it('lists the three ways, the key put on first, with the assistant by name', () => {
    const ways = vaultAskWays('Dusty');
    expect(ways.map((w) => w.id)).toEqual(['key_once', 'keep_password', 'own_key']);
    expect(ways[0]?.label).toContain('Dusty');
    expect(ways[0]?.detail).toContain('Dusty');
  });
});

describe('which fields count per way', () => {
  const form = formOf(SERVER);

  it('shows the password for the first two ways, needed', () => {
    for (const way of ['key_once', 'keep_password'] as const) {
      const shown = vaultAskShownFields(SERVER, form, way);
      expect(ids(shown)).toEqual([VAULT_ASK_FIELDS.password]);
      expect(shown[0]?.optional).toBe(false);
    }
  });

  it('shows the private key, needed, and the passphrase, optional, for your own key', () => {
    const shown = vaultAskShownFields(SERVER, form, 'own_key');
    expect(ids(shown)).toEqual([VAULT_ASK_FIELDS.privateKey, VAULT_ASK_FIELDS.passphrase]);
    expect(shown.map((f) => f.optional)).toEqual([false, true]);
    expect(shown[0]?.kind).toBe('key_file');
  });

  it('says what is missing in core’s words', () => {
    expect(vaultAskProblems(SERVER, vaultAskShownFields(SERVER, form, 'key_once'), {})).toEqual({
      password: VAULT_ASK_TEXT.empty.password,
    });
    expect(vaultAskProblems(SERVER, vaultAskShownFields(SERVER, form, 'own_key'), {})).toEqual({
      private_key: VAULT_ASK_TEXT.empty.privateKey,
    });
  });

  it('keeps every field of the other kinds', () => {
    const login = ask({ kind: 'login', url: 'https://github.com' });
    expect(ids(vaultAskShownFields(login, formOf(login), 'own_key'))).toEqual(['username', 'secret', 'totp']);
    const code = ask({ kind: 'code' });
    expect(ids(vaultAskShownFields(code, formOf(code), 'key_once'))).toEqual(['code']);
  });
});

describe('what is sent', () => {
  const form = formOf(SERVER);

  it('sends the chosen way and only its fields, even after typing in another way’s', () => {
    const typed = { password: ' hunter2 ', private_key: '-----BEGIN…\nabc\n', passphrase: 'x' };
    expect(
      vaultAskValues(SERVER, vaultAskShownFields(SERVER, form, 'keep_password'), typed, 'keep_password'),
    ).toEqual({ password: ' hunter2 ', way: 'keep_password' });
    expect(vaultAskValues(SERVER, vaultAskShownFields(SERVER, form, 'own_key'), typed, 'own_key')).toEqual({
      private_key: '-----BEGIN…\nabc\n',
      passphrase: 'x',
      way: 'own_key',
    });
  });

  it('trims a username and a code, never a password', () => {
    const login = ask({ kind: 'login', url: 'https://github.com' });
    const shown = vaultAskShownFields(login, formOf(login), 'key_once');
    expect(vaultAskValues(login, shown, { username: ' mara ', secret: ' p ', totp: '' }, 'key_once')).toEqual(
      {
        username: 'mara',
        secret: ' p ',
      },
    );
    const code = ask({ kind: 'code' });
    expect(
      vaultAskValues(
        code,
        vaultAskShownFields(code, formOf(code), 'key_once'),
        { code: ' 123 456 ' },
        'key_once',
      ),
    ).toEqual({
      code: '123 456',
    });
  });

  it('checks a login’s authenticator key before sending', () => {
    const login = ask({ kind: 'login', url: 'https://github.com', username: 'mara' });
    const shown = vaultAskShownFields(login, formOf(login), 'key_once');
    expect(vaultAskProblems(login, shown, { secret: 'p', totp: 'not a key!' }).totp).toBe(
      VAULT_TOTP_PROBLEM_TEXT.key,
    );
    expect(vaultAskProblems(login, shown, { secret: 'p', totp: 'JBSW Y3DP EHPK 3PXP' })).toEqual({});
    expect(vaultAskProblems(login, shown, { secret: 'p' })).toEqual({});
  });

  it('drops every secret once sent, keeping only a username', () => {
    const login = ask({ kind: 'basic', url: 'http://192.168.1.40:3000' });
    const shown = vaultAskShownFields(login, formOf(login), 'key_once');
    expect(vaultAskKept(shown, { username: 'admin', secret: 'p' })).toEqual({ username: 'admin' });
    const code = ask({ kind: 'code' });
    expect(vaultAskKept(vaultAskShownFields(code, formOf(code), 'key_once'), { code: '1' })).toEqual({});
  });
});

describe('the entry page', () => {
  const now = '2026-11-03T12:00:00.000Z';
  it('shows an authenticator key and a kept password as set, never a value', () => {
    expect(vaultTotpLine({ set: false, setAt: null }, now, 'UTC')).toBeNull();
    expect(vaultTotpLine({ set: true, setAt: '2026-11-01T12:00:00.000Z' }, now, 'UTC')).toMatch(
      /^Set · added /,
    );
    expect(vaultKeptPasswordLine(undefined, now, 'UTC')).toBeNull();
    expect(vaultKeptPasswordLine({ set: true, setAt: '2026-11-01T12:00:00.000Z' }, now, 'UTC')).toContain(
      'kept password',
    );
  });

  it('notes an MCP entry that couldn’t move to Connections', () => {
    expect(vaultEntryStaysMcp({ moveToConnections: true })).toBe(true);
    expect(vaultEntryStaysMcp({ moveToConnections: false })).toBe(false);
  });
});
