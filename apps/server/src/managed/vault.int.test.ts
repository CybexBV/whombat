/**
 * The Vault on a managed appliance (docs/decisions/vault.md VT-58, VT-80; managed-runtime.md MR-68…): every Vault op
 * is on the session's allowlist; `vault.create` and `vault.setSecret` are secret ops — their receipts keep neither a
 * digest of the input nor the result, a replay answers `unknown_outcome` — and the value travels only inside the
 * session: no receipt, session event, table or answer holds it. The home network list is an account-level op for
 * the person.
 */
import { api, vaultSecretForms, vaultSshKeyForms } from '@whombat/core';
import { requestDigest } from '@whombat/protocol/session';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { commandReceipts } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { sshKeyPair } from '../test/ssh-keys';
import { useVaultNetForTests } from '../vault/net';

const CANARY = 'managed-vault-canary-5Kq2Wz8Lp4';
const m = useManagedRuntime({ seed: true });
type Answer = { t: string; output?: Record<string, unknown>; code?: string; details?: { code?: string } };

describe('the Vault over a session (VT-58)', () => {
  it('lists every Vault op, and only the ones that carry a value as secret ops', () => {
    const ops = Object.values(api.vault)
      .map((e) => e.id)
      .concat(Object.values(api.vaultNetworks).map((e) => e.id));
    for (const op of ops) {
      const spec = m.runtime.dispatcher.allowlist.get(op);
      expect(spec, op).toBeTruthy();
      // `vault.replaceSshKey` carries an imported private key (contracts 0.32.0, VT-S03), `vault.setTotp` a login's
      // authenticator key (3.14, vault-simplify.md CT-1663).
      expect(spec?.secret, op).toBe(
        ['vault.create', 'vault.setSecret', 'vault.replaceSshKey', 'vault.setTotp'].includes(op),
      );
    }
  });

  it('creates an entry and replaces its secret without the value in any receipt, event or answer', async () => {
    const mara = await m.enroll(IDS.mara);
    const c = await m.client(mara);
    const answers: unknown[] = [];
    const createId = 'req_vault_create_0001';
    const created = (await c.request(
      'vault.create',
      {
        params: { burrow: 'burrow-hq' },
        body: {
          name: 'Solar',
          kind: 'http',
          url: 'https://1.1.1.1/v1',
          auth: { type: 'bearer' },
          description: 'Inverter API key',
          secret: CANARY,
        },
      },
      { id: createId },
    )) as Answer;
    answers.push(created);
    expect(created.t, JSON.stringify(created)).toBe('result');
    const entry = (created.output as { entry: { id: string; secret: { set: boolean } } }).entry;
    expect(entry.secret.set).toBe(true);
    const [receipt] = await m.t.services.db
      .select()
      .from(commandReceipts)
      .where(eq(commandReceipts.requestId, createId));
    expect(receipt?.digest).toBe(requestDigest('vault.create', null));
    expect(receipt?.outcome).toEqual({ kind: 'result', resultKind: 'ok', redacted: true });
    const replay = (await c.request(
      'vault.create',
      {
        params: { burrow: 'burrow-hq' },
        body: {
          name: 'Solar',
          kind: 'http',
          url: 'https://1.1.1.1/v1',
          auth: { type: 'bearer' },
          secret: CANARY,
        },
      },
      { id: createId },
    )) as Answer;
    answers.push(replay);
    expect(replay).toMatchObject({ t: 'error', code: 'unknown_outcome' });

    const setId = 'req_vault_secret_0001';
    const replaced = (await c.request(
      'vault.setSecret',
      { params: { burrow: 'burrow-hq', entryId: entry.id }, body: { value: `${CANARY}-2` } },
      { id: setId },
    )) as Answer;
    answers.push(replaced);
    expect(replaced.t).toBe('result');
    const [set] = await m.t.services.db
      .select()
      .from(commandReceipts)
      .where(eq(commandReceipts.requestId, setId));
    expect(set?.digest).toBe(requestDigest('vault.setSecret', null));
    expect(set?.outcome).toEqual({ kind: 'result', resultKind: 'ok', redacted: true });

    // Ordinary ops answer as REST does.
    answers.push(await c.request('vault.list', { params: { burrow: 'burrow-hq' } }));

    const tables = await m.t.services.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const dump: string[] = [];
    for (const { table_name } of tables) {
      const rows = await m.t.services.db.execute(
        sql.raw(`select to_jsonb(t)::text as row from "${table_name}" t`),
      );
      for (const r of rows as unknown as { row: string }[]) dump.push(`${table_name}: ${r.row}`);
    }
    for (const value of [CANARY, `${CANARY}-2`])
      for (const form of vaultSecretForms(value))
        for (const text of [
          ...dump,
          ...answers.map((a) => JSON.stringify(a)),
          ...c.received.map((x) => JSON.stringify(x)),
        ])
          expect(text.includes(form), text.slice(0, 200)).toBe(false);
  });

  it('makes and replaces an SSH key over a session without the private key in any receipt (VT-S03, VT-58)', async () => {
    const pair = sshKeyPair('ed25519', {
      passphrase: 'managed-ssh-passphrase',
      cipher: 'aes256-ctr',
      rounds: 4,
    });
    const c = await m.client(await m.enroll(IDS.mara));
    const answers: unknown[] = [];
    const created = (await c.request('vault.create', {
      params: { burrow: 'burrow-hq' },
      body: { name: 'Deploy', kind: 'ssh', sshKey: { mode: 'generate' } },
    })) as Answer;
    answers.push(created);
    expect(created.t, JSON.stringify(created)).toBe('result');
    const entry = (created.output as { entry: { id: string; auth: { origin: string } } }).entry;
    expect(entry.auth.origin).toBe('generated');
    // A public server on port 22 (it isn't reached here); servers and keys are ordinary ops with receipts.
    useVaultNetForTests(m.t.services, { resolve: async () => [{ address: '93.184.216.34', family: 4 }] });
    const added = (await c.request(
      'vault.addSshServer',
      {
        params: { burrow: 'burrow-hq', entryId: entry.id },
        body: { name: 'web-1', host: 'web1.example.com', username: 'deploy' },
      },
      { id: 'req_vault_ssh_server_01' },
    )) as Answer;
    answers.push(added);
    expect(added).toMatchObject({
      t: 'result',
      output: { entry: { servers: [{ name: 'web-1', port: 22 }] } },
    });
    const replaceId = 'req_vault_ssh_replace_01';
    const replaced = (await c.request(
      'vault.replaceSshKey',
      {
        params: { burrow: 'burrow-hq', entryId: entry.id },
        body: { privateKey: pair.private, passphrase: 'managed-ssh-passphrase' },
      },
      { id: replaceId },
    )) as Answer;
    answers.push(replaced);
    expect(replaced).toMatchObject({ t: 'result', output: { entry: { auth: { origin: 'imported' } } } });
    const [receipt] = await m.t.services.db
      .select()
      .from(commandReceipts)
      .where(eq(commandReceipts.requestId, replaceId));
    expect(receipt?.digest).toBe(requestDigest('vault.replaceSshKey', null));
    expect(receipt?.outcome).toEqual({ kind: 'result', resultKind: 'ok', redacted: true });
    const generated = (await c.request('vault.generateSshKey', {
      params: { burrow: 'burrow-hq', entryId: entry.id },
    })) as Answer;
    answers.push(generated);
    expect(generated).toMatchObject({ t: 'result', output: { entry: { auth: { origin: 'generated' } } } });
    const dump = await m.t.services.db.execute(sql`select to_jsonb(r)::text as row from command_receipts r`);
    const forms = vaultSshKeyForms({ privateKeys: [pair.private], passphrase: 'managed-ssh-passphrase' });
    for (const text of [
      ...(dump as unknown as { row: string }[]).map((r) => r.row),
      ...answers.map((a) => JSON.stringify(a)),
      ...c.received.map((x) => JSON.stringify(x)),
    ])
      for (const form of forms) expect(text.includes(form), text.slice(0, 200)).toBe(false);
  });

  it('changes the home network list as an account-level op', async () => {
    const owner = await m.client(await m.enroll(IDS.mara));
    const added = (await owner.request('vaultNetworks.add', {
      body: { cidr: '192.168.1.0/24', ports: [8123], note: 'Home' },
    })) as Answer;
    expect(added).toMatchObject({
      t: 'result',
      output: { networks: [{ cidr: '192.168.1.0/24' }] },
    });
    const read = (await owner.request('vaultNetworks.list', {})) as Answer;
    expect(read).toMatchObject({ t: 'result', output: { networks: [{ ports: [8123] }] } });
  });
});
