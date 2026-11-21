/**
 * A backup file made on one Whombat restores on another with another master key (docs/decisions/backup-file.md BF-06):
 * the sign-ins inside the file are sealed again under the second Whombat's key, with the new rows' AADs — they open
 * there and not under the first one's key. Each Vault entry's switch for the agent comes back as it was
 * (docs/decisions/vault-simplify.md VLT-10).
 */
import { randomBytes } from 'node:crypto';
import { api, type BackupUploadView, buildPath, newId } from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBurrow } from '../commands/burrows';
import { openConnectionSecret } from '../connections/crypto';
import { burrows, catalogConnections, principals, vaultEntries, vaultSshServers } from '../db/schema/index';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { downloadBackup, uploadBackup } from '../test/backups';
import { insertConnection } from '../test/connections';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';
import { createVaultEntry, setVaultKeyEnvName, takeVaultKey } from '../vault/commands';
import { createVaultSshEntry } from '../vault/ssh-commands';
import { generateSshKey } from '../vault/ssh-keys';
import { vaultSecretAad, vaultServerPasswordAad, vaultTotpAad } from '../vault/store';
import { backupsFor } from './service';

const a = useTestServer({
  seed: true,
  app: true,
  env: { WHOMBAT_MASTER_KEY: randomBytes(32).toString('base64') },
});
const b = useTestServer({
  seed: true,
  app: true,
  env: { WHOMBAT_MASTER_KEY: randomBytes(32).toString('base64') },
});
const PASSWORD = 'moving house, carefully';
const TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DP';
const KEPT = 'nas-admin-kept-password';
const url = (path: string, params: Record<string, string>) => `/api/v1${buildPath(path, params)}`;

let bytes: Buffer = Buffer.alloc(0);

beforeAll(async () => {
  await insertConnection(a.services, {
    catalogId: 'grafana',
    burrowId: TEST_BURROW_ID,
    fields: { url: 'https://grafana.example.test' },
    secret: 'shared-grafana-token',
  });
  expect(
    (
      await a.commit(IDS.mara, createVaultEntry, {
        name: 'Bank',
        kind: 'http',
        url: 'https://bank.example.com',
        auth: { type: 'bearer' },
        secret: 'iban-and-pin',
      })
    ).status,
  ).toBe('ok');
  const [bank] = await a.services.db.select().from(vaultEntries).where(eq(vaultEntries.name, 'Bank'));
  expect(
    (await a.commit(IDS.mara, setVaultKeyEnvName, { entryId: bank?.id as string, envName: 'BANK_TOKEN' }))
      .status,
  ).toBe('ok');
  const archive = await a.commit(IDS.mara, createVaultEntry, {
    name: 'Archive',
    kind: 'http',
    url: 'https://archive.example.com',
    auth: { type: 'bearer' },
    secret: 'old-archive-token',
  });
  if (archive.status !== 'ok') throw new Error('Archive not made');
  const archiveId = archive.result.entryId;
  expect((await a.commit(IDS.mara, takeVaultKey, { entryId: archiveId })).status).toBe('ok');
  // A login's authenticator key and a server's kept password come along sealed (vault-simplify.md CT-1664).
  expect(
    (
      await a.commit(IDS.mara, createVaultEntry, {
        name: 'Shop',
        kind: 'login',
        url: 'https://shop.example.com/login',
        auth: { type: 'form', username: 'mara' },
        secret: 'shop-password',
        totp: TOTP,
      })
    ).status,
  ).toBe('ok');
  const keyId = newId('vaultEntry');
  const key = generateSshKey(keyId);
  const sshKey = await a.commit(IDS.mara, createVaultSshEntry, {
    entryId: keyId,
    name: 'Servers',
    privateKey: key.privateKey,
    auth: key.auth,
  });
  expect(sshKey.status).toBe('ok');
  const serverId = newId('vaultSshServer');
  await a.services.db.insert(vaultSshServers).values({
    id: serverId,
    burrowId: TEST_BURROW_ID,
    entryId: keyId,
    name: 'nas',
    host: 'nas.example.com',
    port: 22,
    username: 'admin',
    passwordSealed: a.services.custody.seal(vaultServerPasswordAad(keyId, serverId), KEPT),
    passwordSetAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const cookie = (await sessionFor(a.services, IDS.mara)).cookie;
  const made = await a.api.inject({
    method: 'POST',
    url: url(api.backups.create.path, { burrow: 'burrow-hq' }),
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ categories: ['connections', 'vault'], password: PASSWORD }),
  });
  expect(made.statusCode, made.body).toBe(201);
  await backupsFor(a.services).settle();
  const id = (JSON.parse(made.body) as { file: { id: string } }).file.id;
  bytes = await downloadBackup(a.services, 'burrow-hq', cookie, id);
});

describe('another Whombat', () => {
  it('seals the restored sign-ins under its own master key', async () => {
    const [mara] = await b.services.db.select().from(principals).where(eq(principals.id, IDS.mara));
    const fresh = await createBurrow(b.services, mara?.accountId as string, 'New Box Home', {
      besideOwn: true,
    });
    const [burrow] = await b.services.db.select().from(burrows).where(eq(burrows.id, fresh.burrowId));
    const cookie = (await sessionFor(b.services, IDS.mara)).cookie;
    const slug = burrow?.slug as string;
    const staged = await b.api.inject({
      method: 'POST',
      url: url(api.backups.stage.path, { burrow: slug }),
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ fileName: 'home.wbk', size: bytes.length }),
    });
    expect(staged.statusCode, staged.body).toBe(201);
    const upload = (JSON.parse(staged.body) as { upload: BackupUploadView }).upload;
    await uploadBackup(b.services, slug, cookie, upload.id, bytes);
    const res = await b.api.inject({
      method: 'POST',
      url: url(api.backups.restore.path, { burrow: slug, stagedBackupId: upload.id }),
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ password: PASSWORD, categories: ['connections', 'vault'] }),
    });
    expect(res.statusCode, res.body).toBe(201);
    await backupsFor(b.services).settle();

    const [conn] = await b.services.db
      .select()
      .from(catalogConnections)
      .where(
        and(eq(catalogConnections.burrowId, fresh.burrowId), eq(catalogConnections.catalogId, 'grafana')),
      );
    expect(
      openConnectionSecret(b.services.custody, conn?.id as string, 'secret', conn?.secretEnc as string),
    ).toBe('shared-grafana-token');
    expect(() =>
      openConnectionSecret(a.services.custody, conn?.id as string, 'secret', conn?.secretEnc as string),
    ).toThrow();
    const [entry] = await b.services.db
      .select()
      .from(vaultEntries)
      .where(and(eq(vaultEntries.burrowId, fresh.burrowId), eq(vaultEntries.name, 'Bank')));
    expect(b.services.custody.open(vaultSecretAad(entry?.id as string), entry?.sealed as string)).toBe(
      'iban-and-pin',
    );
    expect(() =>
      a.services.custody.open(vaultSecretAad(entry?.id as string), entry?.sealed as string),
    ).toThrow();
    // The switch as it was: on with its variable, or off.
    expect(entry?.agentOnAt).toBeTruthy();
    expect(entry?.envName).toBe('BANK_TOKEN');
    const [archive] = await b.services.db
      .select()
      .from(vaultEntries)
      .where(and(eq(vaultEntries.burrowId, fresh.burrowId), eq(vaultEntries.name, 'Archive')));
    expect(archive).toMatchObject({ agentOnAt: null });
    const [shop] = await b.services.db
      .select()
      .from(vaultEntries)
      .where(and(eq(vaultEntries.burrowId, fresh.burrowId), eq(vaultEntries.name, 'Shop')));
    expect(b.services.custody.open(vaultTotpAad(shop?.id as string), shop?.totpSealed as string)).toContain(
      `secret=${TOTP}`,
    );
    const [keyHere] = await b.services.db
      .select()
      .from(vaultEntries)
      .where(and(eq(vaultEntries.burrowId, fresh.burrowId), eq(vaultEntries.name, 'Servers')));
    const [nas] = await b.services.db
      .select()
      .from(vaultSshServers)
      .where(eq(vaultSshServers.entryId, keyHere?.id as string));
    expect(
      b.services.custody.open(
        vaultServerPasswordAad(keyHere?.id as string, nas?.id as string),
        nas?.passwordSealed as string,
      ),
    ).toBe(KEPT);
  });
});
