/**
 * Skills in a backup file (hermes-engine.md HE-S123, HE-S136; hermes-skills.md HSK-S14): the person's change of one of
 * Hermes's built-ins, a skill installed from Hermes's hub, a built-in switched off and what the agent learned with the
 * file's maker go into a `.wbk` through the runner's archives, and come back from it after they were lost — the shared
 * directory put back whole, Hermes's bookkeeping with it, then synced; the learned skill with the maker's own Hermes
 * home. Hermes's steps are the runner's fake plugin. Needs Postgres: the backup jobs and their records.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermesPersonProfile } from '@whombat/agent-runtime';
import {
  api,
  type BackupFileView,
  type BackupRestoreView,
  type BackupUploadView,
  buildPath,
} from '@whombat/core';
import { fakeHermesSkills, HermesHomeService } from '@whombat/runner';
import { beforeAll, describe, expect, it } from 'vitest';
import { backupsFor } from '../backups/service';
import { useHermesHome } from '../hermes-home/service';
import { IDS } from '../seed/test-world';
import { downloadBackup, uploadBackup } from '../test/backups';
import { useTestServer } from '../test/harness';
import { accountOf, sessionFor } from '../test/tokens';
import { skillsCall } from './hermes';

const t = useTestServer({ seed: true, app: true });
const PASSWORD = 'correct horse battery';
let cookie = '';
let root = '';
let shared = '';
let maraAccount = '';

const url = (path: string, params: Record<string, string>) => `/api/v1${buildPath(path, params)}`;

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await t.api.inject({
    method,
    url: path,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') as Record<string, unknown> };
}

const learnedDir = () => join(hermesPersonProfile(root), 'skills', 'finance', 'invoices');

beforeAll(async () => {
  cookie = (await sessionFor(t.services, IDS.mara)).cookie;
  maraAccount = await accountOf(t.services, IDS.mara);
  root = join(await mkdtemp(join(tmpdir(), 'wb-skills-backup-')), 'hermes');
  const md = (name: string, body: string) =>
    `---\nname: ${name}\ndescription: Use for ${name}.\n---\n${body}\n`;
  const home = new HermesHomeService({
    root,
    bin: '/bin/false',
    skillsSteps: fakeHermesSkills({
      builtins: [
        { path: 'productivity/notion', files: { 'SKILL.md': md('notion', 'Use the API.') } },
        { path: 'email/himalaya', files: { 'SKILL.md': md('himalaya', 'Read mail.') } },
        { path: 'media/gif-search', files: { 'SKILL.md': md('gif-search', 'Find a GIF.') } },
      ],
      hub: [
        {
          identifier: 'official/smart-home/mqtt',
          source: 'official',
          trust: 'builtin',
          name: 'mqtt',
          description: 'MQTT.',
          category: 'smart-home',
          files: { 'SKILL.md': md('mqtt', 'Check the broker.') },
        },
      ],
    }),
  });
  useHermesHome(t.services, home);
  shared = home.ctx.skillsDir;
  await skillsCall(t.services, 'skills.sync', {});
});

describe('skills in a backup file', () => {
  it('bring back the person’s change, an installed, a switched-off and a removed skill, and what the agent learned', async () => {
    const notion = await readFile(join(shared, 'productivity/notion/SKILL.md'), 'utf8');
    await skillsCall(t.services, 'skills.write', {
      path: 'productivity/notion',
      text: notion.replace(/\n---\n[\s\S]*$/, '\n---\n# Notion\n\nCheck the shared pages first.\n'),
      by: maraAccount,
    });
    await skillsCall(t.services, 'skills.hubInstall', {
      identifier: 'official/smart-home/mqtt',
      by: maraAccount,
    });
    await skillsCall(t.services, 'skills.setOff', { path: 'email/himalaya', off: true, by: maraAccount });
    await skillsCall(t.services, 'skills.remove', { path: 'media/gif-search', by: maraAccount });
    mkdirSync(learnedDir(), { recursive: true });
    writeFileSync(
      join(learnedDir(), 'SKILL.md'),
      '---\nname: invoices\ndescription: Use when invoices need matching.\n---\nMatch by amount.\n',
    );

    const made = await call('POST', url(api.backups.create.path, { burrow: 'burrow-hq' }), {
      categories: ['skills', 'memories'],
      password: PASSWORD,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    await backupsFor(t.services).settle();
    const file = (
      await call(
        'GET',
        url(api.backups.get.path, {
          burrow: 'burrow-hq',
          backupFileId: (made.body.file as BackupFileView).id,
        }),
      )
    ).body.file as BackupFileView;
    expect(file, JSON.stringify(file)).toMatchObject({ status: 'ready' });
    const bytes = await downloadBackup(t.services, 'burrow-hq', cookie, file.id);

    // Lost: the change restored away, the installed one uninstalled, the switch undone, the learned skill removed.
    await skillsCall(t.services, 'skills.restore', { path: 'productivity/notion', by: maraAccount });
    await skillsCall(t.services, 'skills.hubUninstall', { path: 'smart-home/mqtt', by: maraAccount });
    await skillsCall(t.services, 'skills.setOff', { path: 'email/himalaya', off: false, by: maraAccount });
    await skillsCall(t.services, 'skills.restore', { path: 'media/gif-search', by: maraAccount });
    await rm(learnedDir(), { recursive: true, force: true });

    const staged = await call('POST', url(api.backups.stage.path, { burrow: 'burrow-hq' }), {
      fileName: 'skills.wbk',
      size: bytes.length,
    });
    const up = staged.body.upload as BackupUploadView;
    await uploadBackup(t.services, 'burrow-hq', cookie, up.id, bytes);
    const started = await call(
      'POST',
      url(api.backups.restore.path, { burrow: 'burrow-hq', stagedBackupId: up.id }),
      { password: PASSWORD, categories: ['skills', 'memories'], onDifferent: 'replace' },
    );
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    await backupsFor(t.services).settle();
    const done = (
      await call(
        'GET',
        url(api.backups.getRestore.path, {
          burrow: 'burrow-hq',
          restoreId: (started.body.restore as BackupRestoreView).id,
        }),
      )
    ).body.restore as BackupRestoreView;
    expect(done, JSON.stringify(done)).toMatchObject({ status: 'done', error: null });

    expect(await readFile(join(shared, 'productivity/notion/SKILL.md'), 'utf8')).toContain(
      'Check the shared pages first.',
    );
    // Hermes's own records came back with the directory: the hub lock, the manifest, and Whombat's bookkeeping.
    const { skills: rows } = await skillsCall(t.services, 'skills.list', {});
    const byPath = new Map(rows.map((r) => [r.path, r]));
    expect(byPath.get('productivity/notion')).toMatchObject({
      origin: 'builtin',
      changed: { by: maraAccount },
    });
    expect(byPath.get('smart-home/mqtt')).toMatchObject({
      origin: 'hub',
      hub: { identifier: 'official/smart-home/mqtt' },
    });
    expect(byPath.get('email/himalaya')).toMatchObject({ state: 'off' });
    // Hermes's manifest came back with it: the removed built-in stays removed after the sync.
    expect(byPath.get('media/gif-search')).toMatchObject({ state: 'removed' });
    expect(byPath.get('finance/invoices')).toMatchObject({ origin: 'learned' });
  });
});
