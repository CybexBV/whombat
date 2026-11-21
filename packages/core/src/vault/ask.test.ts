import { describe, expect, it } from 'vitest';
import { BackupVaultEntryRecord } from '../backup/records.js';
import { VaultAskInput } from '../contracts/mcp-setup.js';
import { VaultAddServerInput } from '../contracts/mcp-vault.js';
import { LOGIN_ASK_WAIT_MS, LoginAskBody, LoginAskReply, LoginAskWaitReply } from '../contracts/runner.js';
import {
  GUIDE_VAULT_OUTCOMES,
  GUIDE_VAULT_REFUSALS,
  GUIDE_VAULT_SERVER_WAYS,
  GuideCard,
  GuideVaultAsk,
  guideCardText,
} from '../domain/guides.js';
import {
  VAULT_ASK_DECLINE,
  VAULT_ASK_FIELDS,
  VAULT_ASK_FORM,
  VAULT_ASK_TEXT,
  VAULT_ASK_WAY_FIELDS,
  vaultAskCard,
  vaultAskErrorField,
  vaultAskErrorText,
  vaultAskLockedLabel,
  vaultAskSubmitLabel,
  vaultAskTitle,
  vaultAskWay,
} from './ask.js';
import { VaultSshServer } from './schemas.js';

const T = '2026-11-03T09:00:00.000Z';

const formOf = (card: GuideCard) => {
  const form = card.blocks.find((b) => b.type === 'form');
  if (form?.type !== 'form') throw new Error('no form');
  return form;
};

describe('vault_ask’s kinds', () => {
  it('asks for a server by its address', () => {
    expect(VaultAskInput.safeParse({ kind: 'server', address: '192.168.1.20' }).success).toBe(true);
    expect(
      VaultAskInput.safeParse({
        kind: 'server',
        address: 'prod1.example.com:2222',
        username: 'deploy',
        name: 'prod-1',
        reason: 'key_refused',
        entry: 'vlt_abc123',
      }).success,
    ).toBe(true);
    const paths = (input: unknown) => {
      const r = VaultAskInput.safeParse(input);
      return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    };
    expect(paths({ kind: 'server' })).toContain('address');
    expect(paths({ kind: 'server', address: 'root@192.168.1.20' })).toContain('address');
    expect(paths({ kind: 'server', address: '192.168.1.20', username: 'has space' })).toContain('username');
    expect(paths({ kind: 'server', address: '192.168.1.20', hint: 'x' })).toContain('hint');
  });

  it('asks for a code by the site that sent it', () => {
    expect(
      VaultAskInput.safeParse({ kind: 'code', name: 'github.com', hint: 'It came by text.' }).success,
    ).toBe(true);
    const paths = (input: unknown) => {
      const r = VaultAskInput.safeParse(input);
      return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    };
    expect(paths({ kind: 'code' })).toContain('name');
    expect(paths({ kind: 'code', name: 'github.com', address: 'https://github.com' })).toContain('address');
    expect(paths({ kind: 'code', name: 'github.com', entry: 'vlt_abc123' })).toContain('entry');
    expect(paths({ kind: 'login', name: 'GitHub', address: 'https://github.com', reason: 'new' })).toContain(
      'reason',
    );
  });

  it('keeps the older kinds as they were', () => {
    expect(
      VaultAskInput.safeParse({ kind: 'login', name: 'UniFi', address: 'https://192.168.1.1' }).success,
    ).toBe(true);
    expect(VaultAskInput.safeParse({ kind: 'token', entry: 'vlt_abc123' }).success).toBe(true);
    expect(VaultAskInput.safeParse({ kind: 'basic', name: 'NAS' }).success).toBe(false);
  });

  it('still takes vault_add_server’s password, which is ignored', () => {
    const parsed = VaultAddServerInput.safeParse({ address: '192.168.1.20', password: 'hunter22' });
    expect(parsed.success).toBe(true);
    expect(VaultAddServerInput.shape.password.description).toContain('vault_ask');
  });
});

describe('the card', () => {
  const server = GuideVaultAsk.parse({
    kind: 'server',
    name: 'prod-1',
    username: 'deploy',
    server: { host: '203.0.113.7', port: 22, reason: 'key_refused' },
  });

  it('names the assistant and the thing in its title', () => {
    expect(vaultAskTitle('Dusty', { kind: 'login', name: 'github.com' })).toContain('github.com');
    expect(vaultAskTitle('Dusty', server)).toMatch(/^Dusty .*prod-1.*key$/);
    expect(vaultAskTitle('Dusty', { kind: 'server', name: '192.168.1.20' })).toContain(
      'sign in to 192.168.1.20',
    );
    expect(vaultAskTitle('Dusty', { kind: 'code', name: 'github.com' })).toContain('github.com sent you');
    expect(vaultAskTitle('Dusty', { kind: 'token', name: 'Cloudflare' })).toContain('sign-in key');
    expect(VAULT_ASK_TEXT.under('Dusty')).toContain('Dusty never sees it');
    expect(vaultAskSubmitLabel('server')).toBe(VAULT_ASK_TEXT.signIn);
    expect(vaultAskSubmitLabel('login')).toBe(VAULT_ASK_TEXT.save);
  });

  it('offers a server three ways, the password once first', () => {
    expect(GUIDE_VAULT_SERVER_WAYS[0]).toBe('key_once');
    expect(VAULT_ASK_TEXT.ways.key_once('Dusty')).toContain('Dusty’s key');
    expect(vaultAskWay(undefined)).toBe('key_once');
    expect(vaultAskWay('own_key')).toBe('own_key');
    expect(vaultAskWay('rm -rf')).toBe('key_once');
    expect(VAULT_ASK_WAY_FIELDS.own_key).toEqual([VAULT_ASK_FIELDS.privateKey, VAULT_ASK_FIELDS.passphrase]);
    const card = vaultAskCard('Dusty', server, 'The key stopped working.');
    expect(card.node).toBe('server');
    expect(card.vaultAsk?.server).toMatchObject({ host: '203.0.113.7', tries: 0, serverId: null });
    const form = formOf(card);
    expect(form.id).toBe(VAULT_ASK_FORM);
    expect(form.submitLabel).toBe('Sign in');
    expect(form.fields.map((f) => [f.id, f.kind])).toEqual([
      ['password', 'secret'],
      ['private_key', 'key_file'],
      ['passphrase', 'secret'],
    ]);
    expect(card.blocks.some((b) => b.type === 'actions' && b.actions[0]?.id === VAULT_ASK_DECLINE)).toBe(
      true,
    );
    expect(card.body).toContain('The key stopped working.');
  });

  it('asks a login for its optional authenticator key, and the username only when unknown', () => {
    const card = vaultAskCard(
      'Dusty',
      GuideVaultAsk.parse({ kind: 'login', name: 'GitHub', url: 'https://github.com' }),
      null,
    );
    expect(formOf(card).fields.map((f) => [f.id, f.optional])).toEqual([
      ['username', false],
      ['secret', false],
      ['totp', true],
    ]);
    const replace = vaultAskCard(
      'Dusty',
      GuideVaultAsk.parse({ kind: 'basic', name: 'NAS', username: 'admin', entryId: 'vlt_abc123' }),
      null,
    );
    expect(replace.node).toBe('replace');
    expect(formOf(replace).fields.map((f) => f.id)).toEqual(['secret']);
  });

  it('says a code isn’t kept', () => {
    const card = vaultAskCard(
      'Dusty',
      GuideVaultAsk.parse({ kind: 'code', name: 'github.com', hint: 'By text.' }),
      null,
    );
    expect(card.title).toContain('github.com');
    expect(card.body).toContain(VAULT_ASK_TEXT.underCode);
    expect(card.body).not.toContain('Vault');
    expect(formOf(card).fields.map((f) => f.id)).toEqual(['code']);
  });

  it('says on the field why a try failed', () => {
    for (const r of GUIDE_VAULT_REFUSALS) expect(vaultAskErrorText(r, 'prod-1').length).toBeGreaterThan(0);
    expect(vaultAskErrorText('key_refused', 'prod-1')).toContain('prod-1');
    expect(vaultAskErrorField('password_wrong', 'key_once')).toBe('password');
    expect(vaultAskErrorField('key_refused', 'own_key')).toBe('private_key');
    expect(vaultAskErrorField('passphrase_wrong', 'own_key')).toBe('passphrase');
    expect(VAULT_ASK_TEXT.tooManyTries).toContain('3');
  });

  it('locks with a plain line and tells the agent how it went', () => {
    for (const o of GUIDE_VAULT_OUTCOMES)
      expect(vaultAskLockedLabel(o, { name: 'prod-1' }).length).toBeLessThanOrEqual(200);
    expect(vaultAskLockedLabel('saved', { name: 'UniFi' })).toContain('UniFi');
    expect(vaultAskLockedLabel('key_added', { name: '192.168.1.20', server: 'prod-1' })).toContain('prod-1');
    const locked = GuideCard.parse({
      ...vaultAskCard('Dusty', server, null),
      state: 'done',
      answer: {
        actionId: VAULT_ASK_FORM,
        label: vaultAskLockedLabel('refused', { name: 'prod-1' }),
        at: T,
        vaultOutcome: 'refused',
        vaultRefusal: 'password_wrong',
      },
    });
    expect(guideCardText(locked)).toContain('outcome refused (password_wrong)');
    const added = GuideCard.parse({
      ...locked,
      answer: {
        actionId: VAULT_ASK_FORM,
        label: 'x',
        at: T,
        vaultEntryId: 'vlt_abc123',
        vaultOutcome: 'key_added',
        vaultServer: 'prod-1',
      },
    });
    expect(guideCardText(added)).toContain('server prod-1');
    expect(guideCardText(added)).toContain('vlt_abc123');
  });
});

describe('a server’s kept password', () => {
  it('is a state, never a value, and off by default', () => {
    const s = VaultSshServer.parse({
      id: 'vss_web1',
      name: 'web-1',
      host: 'web1.example.com',
      port: 22,
      username: 'deploy',
      hostKey: null,
      seenHostKey: null,
      check: { status: 'unchecked', outcome: null, summary: '', checkedAt: null },
      createdAt: T,
      updatedAt: T,
    });
    expect(s.password).toEqual({ set: false, setAt: null });
  });

  it('comes along in a backup', () => {
    const rec = BackupVaultEntryRecord.parse({
      type: 'vault_entry',
      id: 'vlt_abc123',
      kind: 'ssh',
      name: 'Servers',
      createdAt: T,
      sshServers: [{ id: 'vss_web1', name: 'web-1', host: 'h', port: 22, username: 'root', password: 'pw' }],
    });
    expect(rec.sshServers[0]?.password).toBe('pw');
  });
});

describe('Hermes’s own asks', () => {
  it('waits ten minutes for a login and five for a code', () => {
    expect(LOGIN_ASK_WAIT_MS.login).toBe(600_000);
    expect(LOGIN_ASK_WAIT_MS.code).toBe(300_000);
  });

  it('asks from an https origin in a live lease', () => {
    const body = { runnerId: 'rnr_abc123', attempt: 1, kind: 'login', origin: 'https://github.com' };
    expect(LoginAskBody.parse(body).username).toBeNull();
    expect(LoginAskBody.safeParse({ ...body, origin: 'https://github.com/login' }).success).toBe(false);
    expect(LoginAskBody.safeParse({ ...body, runnerId: undefined }).success).toBe(false);
    expect(LoginAskReply.safeParse({ status: 'refused', reason: 'not_person', message: 'x' }).success).toBe(
      true,
    );
  });

  it('answers a saved login without its password', () => {
    const saved = LoginAskWaitReply.parse({
      status: 'saved',
      login: {
        entryId: 'vlt_abc123',
        name: 'GitHub',
        origin: 'https://github.com',
        username: 'mara',
        otp: true,
      },
    });
    expect(JSON.stringify(saved)).not.toContain('password');
    expect(LoginAskWaitReply.safeParse({ status: 'code', code: '' }).success).toBe(false);
    expect(LoginAskWaitReply.safeParse({ status: 'timed_out' }).success).toBe(true);
  });
});
