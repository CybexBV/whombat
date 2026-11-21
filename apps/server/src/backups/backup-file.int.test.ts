/**
 * Backup files end to end (docs/decisions/backup-file.md): the person makes a file of every category, downloads it,
 * uploads it into a fresh burrow (the bytes as the session's streams move them, `test/backups.ts`), previews and
 * restores it — and every category comes back through the commit
 * pipeline: secrets sealed again under the master key with the new rows' AADs, automations switched off, messages with
 * their authors and times. Restoring the same file again adds nothing; keep and replace; wrong passwords and damaged
 * files are refused; the agent can't reach any of it.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalOrigin } from '@whombat/agent-runtime/local-repos';
import { scriptedHermesLauncher } from '@whombat/agent-runtime/testing/hermes';
import {
  api,
  BACKUP_CATEGORY_IDS,
  type BackupCategoryId,
  type BackupFileView,
  type BackupRestorePreview,
  type BackupRestoreView,
  type BackupUploadView,
  buildPath,
} from '@whombat/core';
import { HermesHomeService } from '@whombat/runner';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAutomation, publishAutomationDraft, saveAutomationDraft } from '../automations/commands';
import { automationGrants } from '../automations/store';
import { createBurrow } from '../commands/burrows';
import { openConnectionSecret } from '../connections/crypto';
import {
  automations,
  backupFiles,
  backupRestores,
  burrows,
  catalogConnections,
  conversations,
  messages,
  principals,
  repos,
  vaultEntries,
} from '../db/schema/index';
import { saveFile } from '../files/space-commands';
import { createLocalRepo } from '../github/local-repo-command';
import { hermesHome, useHermesHome } from '../hermes-home/service';
import { agentNotesOf, setAgentNotes } from '../memory/notes';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { downloadBackup, uploadBackup } from '../test/backups';
import { insertConnection } from '../test/connections';
import { upload } from '../test/files';
import { useTestServer } from '../test/harness';
import { makeRoom } from '../test/rooms';
import { agentTokenFor, sessionFor } from '../test/tokens';
import { createVaultEntry } from '../vault/commands';
import { vaultSecretAad } from '../vault/store';
import { readBackupBody } from './body';
import { backupsFor } from './service';

/**
 * Holds a started restore while `gate.hold` is pending. A small restore finishes in milliseconds, so without it a
 * restore started a moment after another one ends is rightly let through, and “one at a time” can't be seen.
 */
const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null }));
vi.mock('./restore/job', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./restore/job')>();
  return {
    ...actual,
    runRestore: async (job: Parameters<typeof actual.runRestore>[0]) => {
      await gate.hold;
      return actual.runRestore(job);
    },
  };
});

const workspaces = mkdtempSync(join(tmpdir(), 'whombat-backup-ws-'));
const t = useTestServer({ seed: true, app: true, env: { WHOMBAT_WORKSPACES: workspaces } });
/** The runner's Hermes-home service on a throwaway root (HE-38), in this process. */
let hermes: HermesHomeService;
afterAll(() => rmSync(workspaces, { recursive: true, force: true }));

const PASSWORD = 'correct horse battery';
// Servers need the hosts service (stream V's tests, BF-13).
const ALL = BACKUP_CATEGORY_IDS.filter((id) => id !== 'servers') as BackupCategoryId[];
let maraCookie = '';
let target = { burrowId: '', principalId: '', slug: '' };
let fileBytes: Buffer = Buffer.alloc(0);
let made: BackupFileView;
let sharedConnectionId = '';

const url = (path: string, params: Record<string, string>) => `/api/v1${buildPath(path, params)}`;

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, cookie: string, body?: unknown) {
  const res = await t.api.inject({
    method,
    url: path,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {} };
}

/** Stages an upload in a burrow and sends `bytes` into it as the upload stream does; returns the upload. */
async function uploadFile(slug: string, cookie: string, bytes: Buffer): Promise<BackupUploadView> {
  const staged = await call('POST', url(api.backups.stage.path, { burrow: slug }), cookie, {
    fileName: 'restore-me.wbk',
    size: bytes.length,
  });
  expect(staged.status, JSON.stringify(staged.body)).toBe(201);
  const { id } = staged.body.upload as BackupUploadView;
  await uploadBackup(t.services, slug, cookie, id, bytes);
  const got = await call(
    'GET',
    url(api.backups.getUpload.path, { burrow: slug, stagedBackupId: id }),
    cookie,
  );
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  return got.body.upload as BackupUploadView;
}

async function restore(
  slug: string,
  uploadId: string,
  categories: BackupCategoryId[],
  onDifferent: 'keep' | 'replace' = 'keep',
): Promise<BackupRestoreView> {
  const res = await call(
    'POST',
    url(api.backups.restore.path, { burrow: slug, stagedBackupId: uploadId }),
    maraCookie,
    {
      password: PASSWORD,
      categories,
      onDifferent,
    },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await backupsFor(t.services).settle();
  const done = await call(
    'GET',
    url(api.backups.getRestore.path, { burrow: slug, restoreId: (res.body.restore as BackupRestoreView).id }),
    maraCookie,
  );
  return done.body.restore as BackupRestoreView;
}

beforeAll(async () => {
  const hermesDir = mkdtempSync(join(tmpdir(), 'whombat-backup-hermes-'));
  hermes = new HermesHomeService({
    root: join(hermesDir, 'root'),
    bin: await scriptedHermesLauncher(hermesDir),
  });
  maraCookie = (await sessionFor(t.services, IDS.mara)).cookie;
  const s = t.services;
  const [mara] = await s.db.select().from(principals).where(eq(principals.id, IDS.mara));
  // Connections: two of the burrow's, each with its token (one kind, one-person.md OP-S50).
  sharedConnectionId = await insertConnection(s, {
    catalogId: 'grafana',
    burrowId: TEST_BURROW_ID,
    fields: { url: 'https://grafana.example.test' },
    secret: 'grafana-token-1',
  });
  await insertConnection(s, {
    catalogId: 'grafana',
    burrowId: TEST_BURROW_ID,
    label: 'Mara’s Grafana',
    handle: 'grafana-2',
    fields: { url: 'https://mara.example.test' },
    secret: 'mara-own-token',
  });
  // The Vault: Mara's entry.
  expect(
    (
      await t.commit(IDS.mara, createVaultEntry, {
        name: 'Stripe',
        kind: 'http',
        url: 'https://api.stripe.com/v1',
        auth: { type: 'bearer' },
        secret: 'sk_live_mara',
      })
    ).status,
  ).toBe('ok');
  // A room nobody posted in yet: the file still carries it (one-person.md OP-S75).
  await makeRoom(t.services, t.burrowId, 'dusty-only');
  // Memories, an automation, a file in Files, a repository: in Mara's Chat, a room that comes back (a branch room comes
  // back only with its repository).
  // Mara's own Hermes memory (HE-S115) and the agent's notes (HE-S120), on the runner's service in this
  // process; a skill in the shared directory (HE-41).
  useHermesHome(t.services, hermes);
  await hermesHome(t.services).call('memory.write', {
    file: 'user',
    entries: ['We deploy on Tuesdays.'],
  });
  expect((await t.commit(IDS.mara, setAgentNotes, { text: 'Deploys go out on Tuesdays.' })).status).toBe(
    'ok',
  );
  mkdirSync(join(hermes.ctx.skillsDir, 'ops', 'deploy'), { recursive: true });
  writeFileSync(
    join(hermes.ctx.skillsDir, 'ops', 'deploy', 'SKILL.md'),
    '---\nname: deploy\ndescription: Deploy the website.\n---\n# Deploy\n',
  );
  const created = await t.commit(IDS.mara, createAutomation, {
    name: 'Morning hello',
    source: { kind: 'blank', conversationId: IDS.dmDusty },
  });
  expect(created.status).toBe('ok');
  const automationId = (created as { result: { automationId: string } }).result.automationId;
  const definition = {
    version: 1,
    conversationId: IDS.dmDusty,
    triggers: [{ kind: 'manual' }],
    steps: [{ id: 'hello', kind: 'post_message', text: 'Good morning.' }],
  };
  await t.commit(IDS.mara, saveAutomationDraft, { automationId, definition });
  const { definitionHash, validateDefinition } = await import('@whombat/core');
  const check = validateDefinition(definition);
  if (!check.ok) throw new Error(check.problems.join(' '));
  expect(
    (
      await t.commit(IDS.mara, publishAutomationDraft, {
        automationId,
        enable: true,
        definitionHash: definitionHash(check.definition),
      })
    ).status,
  ).toBe('ok');
  const note = await upload(
    t.api,
    { cookie: maraCookie },
    IDS.dmDusty,
    'notes.txt',
    Buffer.from('hello from a file\n'),
    'text/plain',
  );
  expect((await t.commit(IDS.mara, saveFile, { attachmentId: note.id, folder: 'Notes' })).status).toBe('ok');
  const origin = await createLocalOrigin({
    workspaces,
    burrowId: TEST_BURROW_ID,
    name: 'website',
    author: { name: 'Mara Okafor', email: 'mara@example.com' },
    now: new Date(),
  });
  expect(
    (await t.commit(IDS.mara, createLocalRepo, { name: 'website', originPath: origin.path })).status,
  ).toBe('ok');
  const second = await createBurrow(t.services, mara?.accountId as string, 'Restored Place', {
    besideOwn: true,
  });
  const [row] = await s.db.select().from(burrows).where(eq(burrows.id, second.burrowId));
  target = { ...second, slug: row?.slug as string };
});

describe('making a file', () => {
  it('estimates every category for its maker', async () => {
    const res = await call('GET', url(api.backups.estimate.path, { burrow: 'burrow-hq' }), maraCookie);
    expect(res.status).toBe(200);
    const cats = res.body.categories as { id: string; count: number }[];
    expect(cats.map((c) => c.id)).toEqual([...BACKUP_CATEGORY_IDS]);
    expect(cats.find((c) => c.id === 'vault')).toMatchObject({ count: 1 });
  });

  it('makes, signs and offers a file of every category', async () => {
    const res = await call('POST', url(api.backups.create.path, { burrow: 'burrow-hq' }), maraCookie, {
      categories: ALL,
      password: PASSWORD,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.file).toMatchObject({ status: 'making', includesSecrets: true });
    await backupsFor(t.services).settle();
    const got = await call(
      'GET',
      url(api.backups.get.path, { burrow: 'burrow-hq', backupFileId: (res.body.file as BackupFileView).id }),
      maraCookie,
    );
    made = got.body.file as BackupFileView;
    expect(made, JSON.stringify(made)).toMatchObject({ status: 'ready', error: null });
    expect(made.name).toMatch(/^burrow-hq-\d{4}-\d{2}-\d{2}\.wbk$/);
    const listed = await call('GET', url(api.backups.list.path, { burrow: 'burrow-hq' }), maraCookie);
    expect((listed.body.files as BackupFileView[]).map((f) => f.id)).toContain(made.id);
  });

  it('downloads it whole', async () => {
    fileBytes = await downloadBackup(t.services, 'burrow-hq', maraCookie, made.id);
    expect(fileBytes.length).toBe(made.size);
    expect(createHash('sha256').update(fileBytes).digest('hex')).toBe(made.sha256);
  });

  it('holds what Mara may see, every room among it, and her sign-ins inside the encryption', async () => {
    const path = join(t.services.config.WHOMBAT_BACKUP_FILES_DIR as string, 'check.wbk');
    await import('node:fs/promises').then((fs) => fs.writeFile(path, fileBytes));
    const lines: Record<string, unknown>[] = [];
    let manifest: Record<string, unknown> = {};
    await readBackupBody(path, PASSWORD, {
      manifest: (b) => {
        manifest = JSON.parse(b.toString('utf8'));
      },
      record: (kind, v) => {
        if (kind.kind === 'records') lines.push({ category: kind.category, ...(v as object) });
      },
    });
    expect(manifest).toMatchObject({ format: 'whombat.backup-file/1', includesSecrets: true });
    const text = JSON.stringify(lines);
    expect(text).toContain('sk_live_mara');
    expect(text).toContain('grafana-token-1');
    expect(text).toContain('mara-own-token');
    // Every room is the person's (one-person.md OP-S75).
    expect(text).toContain('dusty-only');
    // Nothing readable outside the encryption.
    expect(fileBytes.includes(Buffer.from('sk_live_mara'))).toBe(false);
    expect(fileBytes.includes(Buffer.from('Burrow HQ'))).toBe(false);
  });
});

describe('restoring it', () => {
  let uploadId = '';

  it('refuses a wrong password and a damaged file', async () => {
    const up = await uploadFile(target.slug, maraCookie, fileBytes);
    expect(up.status).toBe('uploaded');
    const wrong = await call(
      'POST',
      url(api.backups.inspect.path, { burrow: target.slug, stagedBackupId: up.id }),
      maraCookie,
      { password: 'not the password' },
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ error: { details: { code: 'backup_file.wrong_password' } } });
    const damaged = Buffer.from(fileBytes);
    const at = damaged.length - 40;
    damaged[at] = (damaged[at] as number) ^ 0xff;
    const bad = await uploadFile(target.slug, maraCookie, damaged);
    const refused = await call(
      'POST',
      url(api.backups.inspect.path, { burrow: target.slug, stagedBackupId: bad.id }),
      maraCookie,
      { password: PASSWORD },
    );
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { details: { code: 'backup_file.damaged' } } });
    await call(
      'DELETE',
      url(api.backups.removeUpload.path, { burrow: target.slug, stagedBackupId: bad.id }),
      maraCookie,
    );
    uploadId = up.id;
  });

  it('previews every category as new', async () => {
    const res = await call(
      'POST',
      url(api.backups.inspect.path, { burrow: target.slug, stagedBackupId: uploadId }),
      maraCookie,
      { password: PASSWORD },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const preview = res.body as unknown as BackupRestorePreview;
    expect(preview.sameBurrow).toBe(false);
    expect(preview.categories.map((c) => c.id)).toEqual(ALL);
    // The file's agent is this Whombat's own agent, never a new one (one-agent.md OA-S27).
    const agents = preview.categories.find((c) => c.id === 'agents');
    expect(agents?.new).toBe(0);
    expect((agents?.here ?? 0) + (agents?.different ?? 0)).toBeGreaterThan(0);
    expect(preview.categories.find((c) => c.id === 'automations')).toMatchObject({ new: 1, here: 0 });
  });

  it('brings every category back into a fresh burrow', async () => {
    const r = await restore(target.slug, uploadId, ALL);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'done', error: null, upload: null });
    const summary = r.summary;
    expect(summary).not.toBeNull();
    const byId = new Map(summary?.categories.map((c) => [c.id, c]));
    for (const id of ALL.filter((id) => !['agents', 'memories', 'skills', 'settings'].includes(id)))
      expect(byId.get(id)?.added, id).toBeGreaterThan(0);
    // The burrow's settings land on the burrow that is there (OP-S75): nothing of them counts as added.
    expect(byId.get('settings')?.added).toBe(0);
    expect(byId.get('agents')?.added).toBe(0);
    // Mara's Hermes home is her account's and the skills are the box's, here already: what is here stays,
    // and the file's skills replace the shared directory (HE-S123).
    expect(byId.get('memories')?.kept).toBeGreaterThan(0);
    expect(byId.get('skills')?.updated).toBe(1);
    expect(summary?.automationsOff).toBe(1);
    // The restored shared connection's check fails here (nothing answers): it needs a person.
    expect(summary?.connectionsToSignIn.length).toBeGreaterThan(0);

    const db = t.services.db;
    // Still the one agent the burrow was made with.
    const agents = await db
      .select()
      .from(principals)
      .where(and(eq(principals.burrowId, target.burrowId), eq(principals.kind, 'agent')));
    expect(agents).toHaveLength(1);
    // The automation comes back switched off.
    const [auto] = await db
      .select()
      .from(automations)
      .where(and(eq(automations.burrowId, target.burrowId), eq(automations.name, 'Morning hello')));
    expect(auto?.status).toBe('disabled');
    expect(await automationGrants(db, auto?.principalId as string)).toEqual([]);
    // The connection's token opens under this Whombat's master key with the new row's AAD.
    const [conn] = await db
      .select()
      .from(catalogConnections)
      .where(
        and(
          eq(catalogConnections.burrowId, target.burrowId),
          eq(catalogConnections.catalogId, 'grafana'),
          eq(catalogConnections.label, 'Grafana'),
        ),
      );
    expect(conn?.id).not.toBe(sharedConnectionId);
    expect(
      openConnectionSecret(t.services.custody, conn?.id as string, 'secret', conn?.secretEnc as string),
    ).toBe('grafana-token-1');
    expect(conn?.status).toBe('needs_reauth');
    // Mara's Vault entry is hers here, its secret sealed again.
    const [entry] = await db
      .select()
      .from(vaultEntries)
      .where(and(eq(vaultEntries.burrowId, target.burrowId), eq(vaultEntries.name, 'Stripe')));
    expect(entry?.ownerId).toBe(target.principalId);
    expect(t.services.custody.open(vaultSecretAad(entry?.id as string), entry?.sealed as string)).toBe(
      'sk_live_mara',
    );
    // Mara's Chat with its messages, their authors and times (a branch room without its repository stays behind).
    const [chat] = await db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.burrowId, target.burrowId),
          eq(conversations.kind, 'dm'),
          eq(conversations.dmPersonId, target.principalId),
        ),
      );
    expect(chat).toBeDefined();
    const [sourceMsg] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, IDS.dmDusty))
      .limit(1);
    const restored = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, chat?.id as string));
    const same = restored.find((m) => m.text === sourceMsg?.text);
    expect(same?.createdAt.toISOString()).toBe(sourceMsg?.createdAt.toISOString());
    const [author] = await db
      .select()
      .from(principals)
      .where(eq(principals.id, same?.authorId as string));
    const [sourceAuthor] = await db
      .select()
      .from(principals)
      .where(eq(principals.id, sourceMsg?.authorId as string));
    expect(author?.name).toBe(sourceAuthor?.name);
    // The agent's notes, Mara's own memory (here already: her profile is her account's), and the repository.
    expect((await agentNotesOf(db, target.burrowId))?.text).toBe('Deploys go out on Tuesdays.');
    expect((await hermesHome(t.services).call('memory.read', {})).user.entries).toEqual([
      'We deploy on Tuesdays.',
    ]);
    const [repo] = await db
      .select()
      .from(repos)
      .where(and(eq(repos.burrowId, target.burrowId), eq(repos.fullName, 'local/website')));
    expect(repo?.originPath).toBeTruthy();
    expect((await readFile(join(repo?.originPath as string, 'HEAD'), 'utf8')).trim()).toBe(
      'ref: refs/heads/main',
    );
  });

  it('restoring the same file again adds nothing', async () => {
    const up = await uploadFile(target.slug, maraCookie, fileBytes);
    const r = await restore(target.slug, up.id, ALL);
    expect(r.status, JSON.stringify(r)).toBe('done');
    for (const c of r.summary?.categories ?? []) expect(c.added, c.id).toBe(0);
    expect(r.summary?.automationsOff).toBe(0);
  });

  it('keeps what is here, or uses the backup', async () => {
    const memory = () =>
      hermesHome(t.services)
        .call('memory.read', {})
        .then((m) => m.user.entries);
    await hermesHome(t.services).call('memory.write', {
      file: 'user',
      entries: ['We deploy on Fridays now.'],
    });
    const keep = await restore(target.slug, (await uploadFile(target.slug, maraCookie, fileBytes)).id, [
      'memories',
    ]);
    expect(keep.summary?.categories[0]).toMatchObject({ id: 'memories', kept: 1, updated: 0 });
    expect(await memory()).toEqual(['We deploy on Fridays now.']);
    const replace = await restore(
      target.slug,
      (await uploadFile(target.slug, maraCookie, fileBytes)).id,
      ['memories'],
      'replace',
    );
    expect(replace.summary?.categories[0]).toMatchObject({ id: 'memories', updated: 1 });
    expect(await memory()).toEqual(['We deploy on Tuesdays.']);
  });
});

describe('one restore at a time (backup-options.md)', () => {
  it('two started at once: one runs, the other is refused, and the upload of the one refused stays usable', async () => {
    const one = await uploadFile(target.slug, maraCookie, fileBytes);
    const two = await uploadFile(target.slug, maraCookie, fileBytes);
    const start = (id: string) =>
      call('POST', url(api.backups.restore.path, { burrow: target.slug, stagedBackupId: id }), maraCookie, {
        password: PASSWORD,
        categories: ['memories'],
        onDifferent: 'keep',
      });
    // The same upload twice, and another one beside them: only one restore starts. The one that starts keeps running
    // until all three are answered.
    let release = () => {};
    gate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answers = await Promise.all([start(one.id), start(one.id), start(two.id)]).finally(() => {
      release();
      gate.hold = null;
    });
    const started = answers.filter((a) => a.status === 201);
    expect(started, JSON.stringify(answers.map((a) => a.body))).toHaveLength(1);
    for (const refused of answers.filter((a) => a.status !== 201))
      expect(JSON.stringify(refused.body)).toMatch(/restore_running|upload_expired/);
    await backupsFor(t.services).settle();
    const running = await t.services.db
      .select()
      .from(backupRestores)
      .where(and(eq(backupRestores.burrowId, target.burrowId), eq(backupRestores.status, 'restoring')));
    expect(running).toEqual([]);
  });
});

describe('who may', () => {
  it('the agent can’t reach any of it', async () => {
    const token = await agentTokenFor(t.services, TEST_BURROW_ID, IDS.dusty, IDS.general);
    const res = await t.api.inject({
      method: 'GET',
      url: url(api.backups.list.path, { burrow: 'burrow-hq' }),
      headers: { authorization: `Bearer ${(token as { token: string }).token}` },
    });
    expect([401, 403]).toContain(res.statusCode);
    expect(t.services.pipeline.has('backup.restore_batch')).toBe(true);
  });

  it('a restore batch runs only inside its own restore job', async () => {
    const res = await t
      .commit(IDS.mara, (await import('./commands')).restoreBatch, {
        restoreId: 'bkr_notrunning',
        category: 'settings',
        records: [],
      })
      .catch((err: unknown) => err);
    expect(res).toMatchObject({ extra: { details: { code: 'backup_file.restore_failed' } } });
  });
});

describe('housekeeping', () => {
  it('fails jobs a stopped server left running, and sweeps what expired', async () => {
    const service = backupsFor(t.services);
    const db = t.services.db;
    const now = new Date();
    await db.insert(backupFiles).values({
      id: 'bkf_leftrunning1',
      burrowId: TEST_BURROW_ID,
      madeById: IDS.mara,
      name: 'burrow-hq-2026-10-11.wbk',
      status: 'making',
      categories: ['agents'],
      includesSecrets: false,
      createdAt: now,
    });
    expect(await service.recover()).toEqual({ files: 1, restores: 0 });
    const [failed] = await db.select().from(backupFiles).where(eq(backupFiles.id, 'bkf_leftrunning1'));
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'failed' } });
    await db
      .update(backupFiles)
      .set({ expiresAt: new Date(now.getTime() - 1000) })
      .where(eq(backupFiles.id, 'bkf_leftrunning1'));
    expect((await service.sweep()).files).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(backupFiles).where(eq(backupFiles.id, 'bkf_leftrunning1'))).toEqual([]);
  });
});
