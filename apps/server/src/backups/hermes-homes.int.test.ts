/**
 * The Hermes home in a backup file, end to end (hermes-engine.md HE-39, HE-40, HE-S115, HE-S123; BF-02; one-person.md
 * OP-08): the person has their memory and a Chat thread on a Hermes session, on the real runner with the scripted Hermes.
 * They make a file of their memories, the runner's home is lost, they restore the file, and find their memory back and
 * their thread picks up its session where it was. Needs Postgres: the files, the restores and the turns are the server's
 * jobs and rows.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { hermesPersonProfile } from '@whombat/agent-runtime';
import {
  api,
  type BackupFileView,
  type BackupRestoreView,
  type BackupUploadView,
  buildPath,
  type PersonMemory,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendMessage } from '../commands/messages';
import { dispatches } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { downloadBackup, uploadBackup } from '../test/backups';
import { useTestServer } from '../test/harness';
import { chatWith } from '../test/rooms';
import { startTestRunner, type TestRunner, waitFor } from '../test/runner';
import { SCRIPTED_ENV } from '../test/scripted';
import { accountOf, sessionFor } from '../test/tokens';
import { readBackupBody } from './body';
import { backupsFor } from './service';

const t = useTestServer({ seed: true, listen: true, env: SCRIPTED_ENV });
let runner: TestRunner;
const PASSWORD = 'correct horse battery';
const scratch = mkdtempSync(join(tmpdir(), 'whombat-homes-backup-'));
afterAll(async () => {
  await runner?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

interface Person {
  id: string;
  account: string;
  cookie: string;
  chat: string;
  /** What only this person's memory holds. */
  words: string;
  root: string;
  session: string;
  file: Buffer;
}
const people: Record<'mara', Person> = {} as never;

const url = (path: string, params: Record<string, string>) => `/api/v1${buildPath(path, params)}`;

async function call(method: 'GET' | 'POST' | 'PUT', path: string, cookie: string, body?: unknown) {
  const res = await t.api.inject({
    method,
    url: path,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as Record<string, unknown> };
}

async function say(p: Person, text: string, threadRootId?: string): Promise<string> {
  const res = await t.commit(p.id, sendMessage, {
    conversationId: p.chat,
    text,
    ...(threadRootId ? { threadRootId } : {}),
  });
  if (res.status !== 'ok') throw new Error('send failed');
  return res.result.id as string;
}

/** The turn a message started, once the runner finished it. */
async function turnOf(messageId: string) {
  return waitFor(
    async () => {
      const [d] = await t.services.db
        .select()
        .from(dispatches)
        .where(and(eq(dispatches.messageId, messageId), eq(dispatches.agentId, IDS.dusty)));
      return d?.state === 'done' && d.providerSessionId ? d : null;
    },
    20_000,
    'the turn',
  );
}

/** The scripted Hermes's session file in the person's profile, and its turns. */
function sessionFile(p: Person): string {
  const id = p.session.replace(/^hermes:/, '').replace(/[^A-Za-z0-9_-]/g, '_');
  return join(hermesPersonProfile(runner.hermesRoot), 'scripted-hermes', 'sessions', `${id}.json`);
}
const turnsIn = (p: Person) =>
  (JSON.parse(readFileSync(sessionFile(p), 'utf8')) as { history: unknown[] }).history.length;

async function memoryOf(p: Person): Promise<PersonMemory> {
  const res = await call('GET', url(api.memory.mine.path, { burrow: 'burrow-hq' }), p.cookie);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as unknown as PersonMemory;
}

async function makeFile(p: Person): Promise<Buffer> {
  const res = await call('POST', url(api.backups.create.path, { burrow: 'burrow-hq' }), p.cookie, {
    categories: ['memories'],
    password: PASSWORD,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await backupsFor(t.services).settle();
  const got = await call(
    'GET',
    url(api.backups.get.path, { burrow: 'burrow-hq', backupFileId: (res.body.file as BackupFileView).id }),
    p.cookie,
  );
  const made = got.body.file as BackupFileView;
  expect(made, JSON.stringify(made)).toMatchObject({ status: 'ready', error: null });
  return downloadBackup(t.services, 'burrow-hq', p.cookie, made.id);
}

async function restoreFile(p: Person): Promise<BackupRestoreView> {
  const staged = await call('POST', url(api.backups.stage.path, { burrow: 'burrow-hq' }), p.cookie, {
    fileName: 'mine.wbk',
    size: p.file.length,
  });
  expect(staged.status, JSON.stringify(staged.body)).toBe(201);
  const up = staged.body.upload as BackupUploadView;
  await uploadBackup(t.services, 'burrow-hq', p.cookie, up.id, p.file);
  const res = await call(
    'POST',
    url(api.backups.restore.path, { burrow: 'burrow-hq', stagedBackupId: up.id }),
    p.cookie,
    { password: PASSWORD, categories: ['memories'], onDifferent: 'keep' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await backupsFor(t.services).settle();
  const done = await call(
    'GET',
    url(api.backups.getRestore.path, {
      burrow: 'burrow-hq',
      restoreId: (res.body.restore as BackupRestoreView).id,
    }),
    p.cookie,
  );
  return done.body.restore as BackupRestoreView;
}

/** The people whose homes a file carries, and the text of every archive in it (gunzipped tar). */
async function contentsOf(file: Buffer): Promise<{ homes: string[]; archives: string }> {
  const path = join(scratch, `check-${Date.now()}.wbk`);
  writeFileSync(path, file);
  const homes: string[] = [];
  const blobs: Buffer[] = [];
  await readBackupBody(path, PASSWORD, {
    manifest: () => {},
    record: (kind, v) => {
      const r = v as { type?: string; home?: string };
      if (kind.kind === 'records' && r.type === 'hermes_home' && r.home) homes.push(r.home);
    },
    bytes: (kind) => {
      if (kind.kind !== 'blob') return null;
      const parts: Buffer[] = [];
      return {
        write: (d) => {
          parts.push(Buffer.from(d));
        },
        end: () => {
          blobs.push(Buffer.concat(parts));
        },
      };
    },
  });
  const archives = blobs
    .map((b) => {
      try {
        return gunzipSync(b).toString('utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
  return { homes, archives };
}

beforeAll(async () => {
  runner = await startTestRunner(t.baseUrl, { thinkMs: 20, tickMs: 20 });
  for (const [key, id, words] of [['mara', IDS.mara, 'Mara keeps bees on the roof.']] as const) {
    people[key] = {
      id,
      account: await accountOf(t.services, id),
      cookie: (await sessionFor(t.services, id)).cookie,
      chat: await chatWith(t.services, t.burrowId, IDS.dusty, id),
      words,
      root: '',
      session: '',
      file: Buffer.alloc(0),
    };
  }
}, 60_000);

describe('the person’s Hermes home through a backup file', () => {
  it('has their memory and a thread on a Hermes session', async () => {
    for (const p of Object.values(people)) {
      const wrote = await call(
        'PUT',
        url(api.memory.write.path, { burrow: 'burrow-hq', file: 'user' }),
        p.cookie,
        { text: p.words },
      );
      expect(wrote.status, JSON.stringify(wrote.body)).toBe(200);
      p.root = await say(p, 'Hello there, how are you today?');
      const first = await turnOf(p.root);
      expect(first.threadRootId).toBe(p.root);
      p.session = first.providerSessionId as string;
      // The session is in the person's profile (OP-08), with the thread's one turn.
      expect(turnsIn(p)).toBe(1);
    }
    expect((await memoryOf(people.mara)).user.text).toBe(people.mara.words);
  }, 60_000);

  it('makes a file of their memories: their home', async () => {
    for (const p of Object.values(people)) p.file = await makeFile(p);
    const mara = await contentsOf(people.mara.file);
    expect(mara.homes).toContain('person');
    expect(mara.archives).toContain(people.mara.words);
  }, 60_000);

  it('after the home is lost, restores the file: memory back, and the thread resumes its session', async () => {
    for (const name of ['memories', 'scripted-hermes'])
      rmSync(join(hermesPersonProfile(runner.hermesRoot), name), { recursive: true, force: true });
    for (const p of Object.values(people)) {
      expect((await memoryOf(p)).user.text).toBe('');
      expect(existsSync(sessionFile(p))).toBe(false);
    }

    for (const p of Object.values(people)) {
      const restored = await restoreFile(p);
      expect(restored, JSON.stringify(restored)).toMatchObject({ status: 'done' });
      expect(restored.summary?.categories.find((c) => c.id === 'memories')?.added).toBeGreaterThan(0);
    }
    for (const p of Object.values(people)) {
      expect((await memoryOf(p)).user.text).toBe(p.words);
      expect(turnsIn(p)).toBe(1);
    }

    // The thread's next turn picks the session up again: the same session, on its first try, now with two turns.
    for (const p of Object.values(people)) {
      const next = await turnOf(await say(p, 'And one more thing, please.', p.root));
      expect(next.providerSessionId).toBe(p.session);
      expect(next.attempts).toBe(1);
      expect(turnsIn(p)).toBe(2);
    }
  }, 90_000);
});
