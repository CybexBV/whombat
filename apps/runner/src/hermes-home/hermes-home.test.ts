import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostLockWaiters, lockHermesProfile } from '@whombat/agent-runtime';
import { scriptedHermesLauncher } from '@whombat/agent-runtime/testing/hermes';
import type { HermesHomeAnswer } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { HermesHomeService } from './index';
import { memoryPath, writeMemoryFile } from './memory';

async function setup(lockWaitMs = 50) {
  const dir = await mkdtemp(join(tmpdir(), 'wb-hermes-home-'));
  // Private, as the runner makes it: the service refuses a home others can read, whatever the umask.
  const root = join(dir, 'root');
  mkdirSync(root, { mode: 0o700 });
  const bin = await scriptedHermesLauncher(dir);
  // What the service warns about (a failed `hermes sessions delete`), so a failure says why.
  const warnings: string[] = [];
  const service = new HermesHomeService({ root, bin, lockWaitMs, log: (_level, msg) => warnings.push(msg) });
  let n = 0;
  const call = async (method: string, params: unknown): Promise<HermesHomeAnswer> =>
    service.handle({ id: `t${++n}`, method: method as never, params });
  const ok = async <T = Record<string, unknown>>(method: string, params: unknown): Promise<T> => {
    const a = await call(method, params);
    if (!a.ok) throw new Error(`${method}: ${a.code} ${a.error}`);
    return a.result as T;
  };
  return { dir, root, service, call, ok, warnings };
}

/** Resolves once `ok()` holds (checked every few milliseconds, for at most 5 s). */
async function until(ok: () => boolean): Promise<void> {
  const end = Date.now() + 5_000;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A scripted Hermes session as the scripted stand-in keeps it (`scripted-hermes/sessions/<id>.json`). */
function scriptedSession(profile: string, id: string): string {
  const path = join(profile, 'scripted-hermes', 'sessions', `${id}.json`);
  mkdirSync(join(profile, 'scripted-hermes', 'sessions'), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ id, cwd: '/', history: [{ prompt: 'hi', reply: 'hello' }] }));
  return path;
}

describe('the Hermes-home service: memory (HE-39)', () => {
  it('writes and reads Hermes’s own format, with its limit and the file’s version', async () => {
    const { root, ok, call } = await setup();
    const empty = await ok<{ memory: { entries: string[]; version: string } }>('memory.read', {});
    expect(empty.memory.entries).toEqual([]);
    expect(empty.memory.version).toBe('');

    const user = await ok<{ entries: string[]; chars: number; limit: number; version: string }>(
      'memory.write',
      {
        file: 'user',
        entries: ['Prefers short answers', '  ', 'Lives in Utrecht', 'Prefers short answers'],
      },
    );
    expect(user.entries).toEqual(['Prefers short answers', 'Lives in Utrecht']);
    expect(user.limit).toBe(1_375);
    const raw = readFileSync(join(root, 'memories', 'USER.md'), 'utf8');
    expect(raw).toBe('Prefers short answers\n§\nLives in Utrecht');
    expect(user.chars).toBe(raw.length);
    expect(statSync(join(root, 'memories', 'USER.md')).mode & 0o777).toBe(0o600);

    // A write based on an older version is refused; over the limit too.
    const stale = await call('memory.write', {
      file: 'user',
      entries: ['x'],
      ifVersion: 'abc',
    });
    expect(stale).toMatchObject({ ok: false, code: 'conflict' });
    const long = await call('memory.write', { file: 'user', entries: ['y'.repeat(1_400)] });
    expect(long).toMatchObject({ ok: false, code: 'too_long' });
    const fresh = await ok<{ entries: string[] }>('memory.write', {
      file: 'user',
      entries: ['Lives in Utrecht'],
      ifVersion: user.version,
    });
    expect(fresh.entries).toEqual(['Lives in Utrecht']);

    // The person's one home (OP-08); clearing one file leaves the other.
    expect((await ok<{ user: { entries: string[] } }>('memory.read', {})).user.entries).toEqual([
      'Lives in Utrecht',
    ]);
    await ok('memory.write', { file: 'memory', entries: ['Deploys from main'] });
    const cleared = await ok<{ memory: { entries: string[] }; user: { entries: string[] } }>('memory.clear', {
      file: 'user',
    });
    expect(cleared.user.entries).toEqual([]);
    expect(cleared.memory.entries).toEqual(['Deploys from main']);
  });

  it('writes through a new temporary file only, never a file or link already at its name', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'wb-memory-'));
    mkdirSync(join(profile, 'memories'), { mode: 0o700 });
    const outside = join(profile, 'outside.txt');
    writeFileSync(outside, 'not memory\n');
    const link = join(profile, 'memories', '.mem_planted_link');
    symlinkSync(outside, link);
    const file = join(profile, 'memories', '.mem_planted_file');
    writeFileSync(file, 'there before\n');
    for (const tmp of [link, file])
      await expect(writeMemoryFile(profile, 'memory', ['Deploys from main'], tmp)).rejects.toMatchObject({
        code: 'EEXIST',
      });
    expect(readFileSync(outside, 'utf8')).toBe('not memory\n');
    expect(readFileSync(file, 'utf8')).toBe('there before\n');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(memoryPath(profile, 'memory'))).toBe(false);
    // Its own name: written, renamed over the memory file, nothing left beside it.
    await writeMemoryFile(profile, 'memory', ['Deploys from main']);
    expect(readFileSync(memoryPath(profile, 'memory'), 'utf8')).toBe('Deploys from main');
    expect(statSync(memoryPath(profile, 'memory')).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(profile, 'memories')).sort()).toEqual([
      '.mem_planted_file',
      '.mem_planted_link',
      'MEMORY.md',
    ]);
  });

  it('refuses a write while a turn holds the profile, and a step the protocol doesn’t have', async () => {
    const { root, call } = await setup();
    const lock = await lockHermesProfile(root, root, { holder: 'turn' });
    try {
      expect(await call('memory.write', { file: 'memory', entries: ['x'] })).toMatchObject({
        ok: false,
        code: 'busy',
      });
    } finally {
      await lock.release();
    }
    expect(await call('memory.write', { file: 'other', entries: [] })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(await call('nope', {})).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('the Hermes-home service: sessions (HE-40)', () => {
  it('deletes sessions the Hermes way, and keeps them while a turn holds the profile; the outsiders’ in their home', async () => {
    const { root, service, ok, warnings } = await setup();
    const profile = root;
    const one = scriptedSession(profile, 'local-one');
    const two = scriptedSession(profile, 'local-two');

    const lock = await lockHermesProfile(root, profile, { holder: 'turn' });
    expect(await ok('sessions.delete', { home: 'person', sessions: ['local-one', 'local-gone'] })).toEqual({
      queued: 2,
    });
    await service.idle();
    expect(existsSync(one)).toBe(true);
    expect((await ok<{ sessions: string[] }>('sessions.pending', { home: 'person' })).sessions).toEqual([
      'local-one',
      'local-gone',
    ]);
    await lock.release();

    // The sweep after the turn: deleted, and the one Hermes doesn't know counts as gone.
    await service.sweep();
    await service.idle();
    expect(existsSync(one), warnings.join('\n')).toBe(false);
    expect(existsSync(two)).toBe(true);
    expect((await ok<{ sessions: string[] }>('sessions.pending', { home: 'person' })).sessions).toEqual([]);
    // A turn outsiders started ran in their profile (OP-17): its sessions are deleted there, never the person's.
    const theirs = scriptedSession(join(root, 'profiles', '_feedback'), 'local-two');
    await ok('sessions.delete', { home: 'outside', sessions: ['local-two'] });
    await service.idle();
    expect(existsSync(theirs)).toBe(false);
    expect(existsSync(two)).toBe(true);
  });

  it('lets a turn waiting for the profile go before the rest of a long list (HN-K05)', async () => {
    const { root, service, ok, warnings } = await setup();
    const profile = root;
    const ids = ['local-1', 'local-2', 'local-3'];
    const files = ids.map((id) => scriptedSession(profile, id));
    const pending = async () =>
      (await ok<{ sessions: string[] }>('sessions.pending', { home: 'person' })).sessions;

    const first = await lockHermesProfile(root, profile, { holder: 'turn-1' });
    await ok('sessions.delete', { home: 'person', sessions: ids });
    await service.idle();
    // A second turn of the same person waits for the profile while the first runs.
    const waiting = lockHermesProfile(root, profile, { holder: 'turn-2', waitMs: 10_000 });
    await until(() => hostLockWaiters(`hermes-profile:${profile}`) === 1);
    await first.release();
    await service.sweep();
    await service.idle();
    expect(await pending()).toEqual(ids);

    const second = await waiting;
    await second.release();
    await service.sweep();
    await service.idle();
    expect(await pending(), warnings.join('\n')).toEqual([]);
    for (const file of files) expect(existsSync(file)).toBe(false);
  });
});

/**
 * A stand-in for the Python beside `hermes`: records how the plugin's step was run (its arguments, `HERMES_HOME`, its
 * working directory, its input) and answers with `answer.json` and the exit code in `exit`.
 */
interface FakePython {
  python: string;
  answer(body: unknown, exit?: number): void;
  seen(): { stdin: string; args: string; home: string; cwd: string; cwdFiles: string };
}

function fakePython(dir: string): FakePython {
  const record = join(dir, 'python-seen');
  mkdirSync(record, { recursive: true });
  const python = join(dir, 'python');
  writeFileSync(
    python,
    [
      '#!/bin/sh',
      `cat > '${record}/stdin'`,
      `printf '%s' "$*" > '${record}/args'`,
      `printf '%s' "$HERMES_HOME" > '${record}/home'`,
      `pwd > '${record}/cwd'`,
      `ls -A > '${record}/cwd-files'`,
      `cat '${record}/answer.json'`,
      `exit $(cat '${record}/exit')`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const read = (name: string) => readFileSync(join(record, name), 'utf8').trim();
  return {
    python,
    answer(body, exit = 0) {
      writeFileSync(join(record, 'answer.json'), typeof body === 'string' ? body : JSON.stringify(body));
      writeFileSync(join(record, 'exit'), String(exit));
    },
    seen: () => ({
      stdin: read('stdin'),
      args: read('args'),
      home: read('home'),
      cwd: read('cwd'),
      cwdFiles: read('cwd-files'),
    }),
  };
}

describe('the Hermes-home service: listing a profile’s sessions (hermes-native.md HN-K09)', () => {
  const listing = (id: string, source = 'acp', lastActiveAt = '2026-10-01T08:00:00.000Z') => ({
    id,
    source,
    lastActiveAt,
  });

  it('asks Hermes through the plugin without the profile’s lock, the pod or the profile as its home', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-hermes-home-list-'));
    const root = join(dir, 'root');
    const fake = fakePython(dir);
    const events: string[] = [];
    const service = new HermesHomeService({
      root,
      bin: await scriptedHermesLauncher(dir),
      python: fake.python,
      lockWaitMs: 20,
      pods: {
        busy: () => true,
        quiesce: async () => {
          events.push('quiesce');
          return () => {};
        },
      },
    });
    const list = (home: 'person' | 'outside') =>
      service.handle({ id: 'l', method: 'sessions.list', params: { home } });

    // A profile that isn't there has nothing, and nothing is made for the read.
    fake.answer({ sessions: [listing('never')], more: false });
    expect(await list('person')).toEqual({ id: 'l', ok: true, result: { sessions: [], more: false } });
    expect(existsSync(root)).toBe(false);

    const profile = root;
    mkdirSync(profile, { recursive: true });
    const answered = {
      sessions: [listing('old-chat'), listing('cli-chat', 'cli'), listing('../escape'), listing('pod-chat')],
      more: true,
    };
    fake.answer(answered);
    // A turn holds the profile and the person's pod is busy: the read goes ahead anyway.
    const lock = await lockHermesProfile(root, profile, { holder: 'turn' });
    try {
      const a = await list('person');
      expect(a).toEqual({
        id: 'l',
        ok: true,
        result: {
          sessions: [listing('old-chat'), listing('cli-chat', 'cli'), listing('pod-chat')],
          more: true,
        },
      });
    } finally {
      await lock.release();
    }
    expect(events).toEqual([]);
    const seen = fake.seen();
    expect(seen.args).toBe('-m whombat_hermes.sessions list');
    expect(JSON.parse(seen.stdin)).toEqual({ profile });
    // Hermes's own start-up lands in an empty scratch directory of the step's, gone afterwards.
    expect(seen.home).not.toBe(profile);
    expect(seen.cwd).toBe(seen.home);
    expect(seen.cwdFiles).toBe('');
    expect(existsSync(seen.home)).toBe(false);
    // The outsiders' home (OP-17).
    mkdirSync(join(root, 'profiles', '_feedback'), { recursive: true });
    fake.answer({ sessions: [], more: false });
    await list('outside');
    expect(JSON.parse(fake.seen().stdin)).toEqual({ profile: join(root, 'profiles', '_feedback') });
  });

  it('says why it couldn’t list: no real Hermes, no plugin, a busy store, a crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-hermes-home-list-'));
    const root = join(dir, 'root');
    mkdirSync(root, { recursive: true });
    const bin = await scriptedHermesLauncher(dir);
    const list = (service: HermesHomeService) =>
      service.handle({ id: 'l', method: 'sessions.list', params: { home: 'person' } });

    // The scripted Hermes has no Python beside it.
    expect(await list(new HermesHomeService({ root, bin }))).toMatchObject({
      ok: false,
      code: 'unavailable',
    });

    const fake = fakePython(dir);
    const service = new HermesHomeService({ root, bin, python: fake.python });
    fake.answer({ code: 'busy', message: 'store busy' }, 1);
    expect(await list(service)).toMatchObject({ ok: false, code: 'busy' });
    fake.answer({ code: 'invalid', message: 'bad input' }, 1);
    expect(await list(service)).toMatchObject({ ok: false, code: 'failed' });
    fake.answer('', 3);
    expect(await list(service)).toMatchObject({ ok: false, code: 'failed' });
    writeFileSync(
      fake.python,
      '#!/bin/sh\ncat >/dev/null\necho "ModuleNotFoundError: No module named \'whombat_hermes\'" >&2\nexit 1\n',
    );
    expect(await list(service)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(
      await service.handle({ id: 'l', method: 'sessions.list', params: { home: '../x' } }),
    ).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('the Hermes-home service: a home’s archive (backups)', () => {
  async function exportAll(ok: Awaited<ReturnType<typeof setup>>['ok'], home: unknown) {
    const begun = await ok<{ transfer: string; bytes: number; sha256: string; files: number }>(
      'home.exportBegin',
      {
        home,
      },
    );
    const parts: Buffer[] = [];
    for (let offset = 0; offset < begun.bytes; ) {
      const { data } = await ok<{ data: string }>('home.exportChunk', {
        transfer: begun.transfer,
        offset,
        length: Math.min(64 * 1024, begun.bytes - offset),
      });
      const chunk = Buffer.from(data, 'base64');
      parts.push(chunk);
      offset += chunk.length;
    }
    await ok('home.discard', { transfer: begun.transfer });
    return { ...begun, archive: Buffer.concat(parts) };
  }

  async function importAll(
    ok: Awaited<ReturnType<typeof setup>>['ok'],
    home: unknown,
    archive: Buffer,
    sha256: string,
    mode: 'replace' | 'fill',
  ) {
    const { transfer } = await ok<{ transfer: string }>('home.importBegin', {
      home,
      bytes: archive.length,
      sha256,
    });
    for (let offset = 0; offset < archive.length; offset += 50_000)
      await ok('home.importChunk', {
        transfer,
        offset,
        data: archive.subarray(offset, offset + 50_000).toString('base64'),
      });
    return ok<{ files: number; kept: number }>('home.importCommit', { transfer, mode });
  }

  it('carries the person’s memory and sessions, never their skills, what the runner writes or Hermes’s logs', async () => {
    const a = await setup();
    const profile = a.root;
    await a.ok('memory.write', { file: 'memory', entries: ['Deploys from main'] });
    await a.ok('memory.write', { file: 'user', entries: ['Mara, in Utrecht'] });
    scriptedSession(profile, 'local-one');
    mkdirSync(join(profile, 'skills', 'ops', 'deploy', 'scripts'), { recursive: true });
    writeFileSync(join(profile, 'skills', 'ops', 'deploy', 'SKILL.md'), '# Deploy\n');
    writeFileSync(join(profile, 'skills', 'ops', 'deploy', 'scripts', 'go.sh'), 'echo go\n', { mode: 0o755 });
    writeFileSync(join(profile, 'state.db'), 'sqlite');
    writeFileSync(join(profile, 'state.db-wal'), 'wal');
    for (const name of ['config.yaml', 'SOUL.md', 'whombat.md', 'auth.json', 'local-model.key'])
      writeFileSync(join(profile, name), 'runner');
    mkdirSync(join(profile, 'logs'));
    writeFileSync(join(profile, 'logs', 'agent.log'), 'log');
    writeFileSync(join(profile, 'memories', 'MEMORY.md.lock'), '');

    const out = await exportAll(a.ok, { kind: 'profile', home: 'person' });
    // Memory (2), a session, the store and its log: the skills are the skills folder's own archive (OP-08).
    expect(out.files).toBe(5);

    // A fresh root (the box was wiped): the archive puts the home back.
    const b = await setup();
    const back = await importAll(
      b.ok,
      { kind: 'profile', home: 'person' },
      out.archive,
      out.sha256,
      'replace',
    );
    expect(back).toEqual({ files: 5, kept: 0 });
    const restored = b.root;
    const mem = await b.ok<{ memory: { entries: string[] }; user: { entries: string[] } }>('memory.read', {});
    expect(mem.memory.entries).toEqual(['Deploys from main']);
    expect(mem.user.entries).toEqual(['Mara, in Utrecht']);
    expect(existsSync(join(restored, 'scripted-hermes', 'sessions', 'local-one.json'))).toBe(true);
    expect(readFileSync(join(restored, 'state.db-wal'), 'utf8')).toBe('wal');
    expect(existsSync(join(restored, 'skills', 'ops'))).toBe(false);
    // The skills folder's archive carries the skills, scripts executable.
    const skills = await exportAll(a.ok, { kind: 'skills' });
    await importAll(b.ok, { kind: 'skills' }, skills.archive, skills.sha256, 'replace');
    expect(statSync(join(restored, 'skills', 'ops', 'deploy', 'scripts', 'go.sh')).mode & 0o100).toBe(0o100);
    // Never a login (a person's ChatGPT sign-in is Hermes's `auth.json`, HN-03), nor what the runner writes.
    for (const name of ['config.yaml', 'SOUL.md', 'whombat.md', 'auth.json', 'local-model.key', 'logs'])
      expect(existsSync(join(restored, name))).toBe(false);
    expect(existsSync(join(restored, 'memories', 'MEMORY.md.lock'))).toBe(false);
    // Putting a backup back over a home keeps the sign-in there.
    writeFileSync(join(restored, 'auth.json'), '{}');
    await importAll(b.ok, { kind: 'profile', home: 'person' }, out.archive, out.sha256, 'replace');
    expect(existsSync(join(restored, 'auth.json'))).toBe(true);
  });

  it('fills the skills folder skill by skill, not category by category (HN-K07)', async () => {
    const skill = (profile: string, path: string, text: string) => {
      mkdirSync(join(profile, 'skills', path), { recursive: true });
      writeFileSync(join(profile, 'skills', path, 'SKILL.md'), text);
    };
    const a = await setup();
    const there = a.root;
    skill(there, 'ops/deploy', 'backup deploy');
    skill(there, 'ops/rollback', 'backup rollback');
    skill(there, 'notes', 'backup notes');
    const out = await exportAll(a.ok, { kind: 'skills' });

    const b = await setup();
    const here = b.root;
    skill(here, 'ops/deploy', 'deploy as changed since');
    const filled = await importAll(b.ok, { kind: 'skills' }, out.archive, out.sha256, 'fill');
    expect(filled.kept).toBe(1);
    expect(readFileSync(join(here, 'skills', 'ops', 'deploy', 'SKILL.md'), 'utf8')).toBe(
      'deploy as changed since',
    );
    expect(readFileSync(join(here, 'skills', 'ops', 'rollback', 'SKILL.md'), 'utf8')).toBe('backup rollback');
    expect(readFileSync(join(here, 'skills', 'notes', 'SKILL.md'), 'utf8')).toBe('backup notes');
  });

  it('fills what is missing, replaces with the backup, and refuses what isn’t a home’s archive', async () => {
    const a = await setup();
    await a.ok('memory.write', { file: 'memory', entries: ['From the backup'] });
    scriptedSession(a.root, 'local-old');
    const out = await exportAll(a.ok, { kind: 'profile', home: 'person' });

    const b = await setup();
    await b.ok('memory.write', { file: 'memory', entries: ['Here already'] });
    const filled = await importAll(
      b.ok,
      { kind: 'profile', home: 'person' },
      out.archive,
      out.sha256,
      'fill',
    );
    expect(filled.kept).toBe(1);
    const here = b.root;
    expect(existsSync(join(here, 'scripted-hermes', 'sessions', 'local-old.json'))).toBe(true);
    expect((await b.ok<{ memory: { entries: string[] } }>('memory.read', {})).memory.entries).toEqual([
      'Here already',
    ]);
    await importAll(b.ok, { kind: 'profile', home: 'person' }, out.archive, out.sha256, 'replace');
    expect((await b.ok<{ memory: { entries: string[] } }>('memory.read', {})).memory.entries).toEqual([
      'From the backup',
    ]);

    // The shared skills' archive isn't a profile's; a wrong checksum and an archive out of order are refused.
    const skills = await exportAll(a.ok, { kind: 'skills' });
    const wrongKind = await b.call('home.importBegin', {
      home: { kind: 'profile', home: 'person' },
      bytes: skills.archive.length,
      sha256: skills.sha256,
    });
    if (!wrongKind.ok) throw new Error('importBegin failed');
    const t = (wrongKind.result as { transfer: string }).transfer;
    await b.ok('home.importChunk', { transfer: t, offset: 0, data: skills.archive.toString('base64') });
    expect(await b.call('home.importCommit', { transfer: t, mode: 'replace' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(await b.call('home.importCommit', { transfer: t, mode: 'replace' })).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    const bad = await b.ok<{ transfer: string }>('home.importBegin', {
      home: { kind: 'profile', home: 'person' },
      bytes: out.archive.length,
      sha256: '0'.repeat(64),
    });
    await b.ok('home.importChunk', {
      transfer: bad.transfer,
      offset: 0,
      data: out.archive.toString('base64'),
    });
    expect(await b.call('home.importCommit', { transfer: bad.transfer, mode: 'replace' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    const gap = await b.ok<{ transfer: string }>('home.importBegin', {
      home: { kind: 'profile', home: 'person' },
      bytes: out.archive.length,
      sha256: out.sha256,
    });
    expect(
      await b.call('home.importChunk', { transfer: gap.transfer, offset: 10, data: 'AAAA' }),
    ).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('the Hermes-home service with the person’s pod (hermes-native.md HN-W11)', () => {
  it('quiesces the person’s pod around a step, and a polite step stays away from a busy pod', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-hermes-home-pods-'));
    const root = join(dir, 'root');
    const events: string[] = [];
    let busy = false;
    const pods = {
      busy: () => busy,
      quiesce: async () => {
        events.push('quiesce');
        return () => {
          events.push('lift');
        };
      },
    };
    const service = new HermesHomeService({
      root,
      bin: await scriptedHermesLauncher(dir),
      lockWaitMs: 50,
      pods,
    });
    await service.ctx.withProfile(async () => {
      events.push('step');
    });
    expect(events).toEqual(['quiesce', 'step', 'lift']);
    busy = true;
    await expect(service.ctx.withProfile(async () => {}, { polite: true })).rejects.toMatchObject({
      code: 'busy',
    });
    expect(events).toHaveLength(3);
    // A pod that doesn't quiesce in time: busy, nothing run.
    const stuck = new HermesHomeService({
      root,
      bin: await scriptedHermesLauncher(dir),
      lockWaitMs: 20,
      pods: {
        busy: () => false,
        quiesce: (signal?: AbortSignal) =>
          new Promise<() => void>((_r, reject) =>
            signal?.addEventListener('abort', () => reject(signal.reason)),
          ),
      },
    });
    await expect(stuck.ctx.withProfile(async () => events.push('never'))).rejects.toMatchObject({
      code: 'busy',
    });
    expect(events).not.toContain('never');
  });
});
