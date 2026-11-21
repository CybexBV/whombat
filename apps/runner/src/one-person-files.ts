/**
 * The files the runner kept per account before one person (docs/decisions/one-person.md OP-08, OP-09, OP-S80, OP-S85,
 * OP-S109; OP-S131…OP-S134), moved once at the runner's start, before the sign-ins, the skills sync, the Hermes-home
 * service and the pod read them. Idempotent: what is moved is gone from the old place, so a start that stopped halfway
 * carries on and every later start finds nothing to do.
 *
 * - Hermes: `profiles/<person>/*` into the root, the person's Hermes home (not `.no-bundled-skills`: Hermes would stop
 *   seeding its skills). The person's skills join the root's `skills/` (theirs win: a copy they changed). Then
 *   `profiles/_shared/`'s memories are appended to the person's (deduplicated, within Hermes's limits) and its learned
 *   skills join (a clash keeps the person's). `_shared` and anyone else's profile go; `_feedback` stays.
 * - Pending session deletes: `pending/<person>.json` → `person.json`, `_feedback.json` → `outside.json`; `_shared`'s
 *   and anyone else's go with their profiles.
 * - Sign-ins: `<credentials>/<person>/<provider>` → `<credentials>/<provider>`; anyone else's and `org/` go.
 * - The work folder: `<workspaces>/.computers/<agent>/work` → `$WHOMBAT_AGENT_HOME/work`; the rest of `.computers` goes.
 *
 * Which account is the person's the server says (`runner.person`); it is asked only when an account's folder is still
 * there, again until it answers. Before a claim (null) the one account folder there is the person's; with several,
 * nothing of the accounts' is moved and the next start tries again.
 */
import { chmod, cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostLock, lockHermesProfile } from '@whombat/agent-runtime';
import {
  HERMES_MEMORY_DELIMITER,
  HERMES_MEMORY_LIMITS,
  type HermesMemoryFile,
  memoryChars,
} from '@whombat/core';
import { readMemoryFile, writeMemoryFile } from './hermes-home/memory';

/** An account id as a folder name (Whombat's ids). */
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
/** The AI gateway's turn homes (`<credentials>/gateway/<connection>/<provider>`, AIG-10): not a person's, never moved. */
const GATEWAY = 'gateway';
const SHARED = '_shared';
const FEEDBACK = '_feedback';
/** The provider homes of one person's sign-ins (OP-S85). */
const PROVIDERS = ['claude', 'codex', 'github'] as const;
/** Kept out of the move: Hermes would stop seeding its skills (OP-S80). */
const NO_BUNDLED = '.no-bundled-skills';
/** How long a lock of the move waits (nothing else runs on these at the runner's start). */
const LOCK_WAIT_MS = 30_000;

export interface OnePersonFilesOptions {
  /** `WHOMBAT_HERMES_ROOT`. */
  hermesRoot: string;
  /** `WHOMBAT_CREDENTIALS_ROOT`. */
  credentialsRoot: string;
  /** `WHOMBAT_WORKSPACES`. */
  workspaces: string;
  /** `WHOMBAT_AGENT_HOME`. */
  agentHome: string;
  /** The person's account (`runner.person`): null before the claim; throws while the server doesn't answer. */
  person: () => Promise<string | null>;
  log: (level: 'info' | 'warn', msg: string) => void;
  /** Between two asks the server didn't answer (default 2 s, doubling to 30 s). */
  retryMs?: number;
}

export interface OnePersonFilesResult {
  /** The account whose files became the person's, or null. */
  person: string | null;
  /** What was done, one line each. */
  done: string[];
}

const exists = async (path: string) => (await lstat(path).catch(() => null)) !== null;
const isDir = async (path: string) => (await lstat(path).catch(() => null))?.isDirectory() ?? false;
const names = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort();

/** Moves `from` to `to` (same filesystem: a rename; else a copy, then the original goes). */
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await cp(from, to, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      errorOnExist: true,
    });
    await rm(from, { recursive: true, force: true });
  }
}

/** The account folders the old layout left (`profiles/<account>`, `<credentials>/<account>`, `pending/<account>.json`). */
export async function accountFolders(o: Pick<OnePersonFilesOptions, 'hermesRoot' | 'credentialsRoot'>) {
  const found = new Set<string>();
  for (const name of await names(join(o.hermesRoot, 'profiles')))
    if (
      name !== SHARED &&
      name !== FEEDBACK &&
      ACCOUNT.test(name) &&
      (await isDir(join(o.hermesRoot, 'profiles', name)))
    )
      found.add(name);
  for (const name of await names(join(o.hermesRoot, 'pending'))) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (id && id !== SHARED && id !== FEEDBACK && id !== 'person' && id !== 'outside' && ACCOUNT.test(id))
      found.add(id);
  }
  for (const name of await names(o.credentialsRoot))
    if (
      ACCOUNT.test(name) &&
      name !== 'org' &&
      name !== GATEWAY &&
      !(PROVIDERS as readonly string[]).includes(name) &&
      (await isDir(join(o.credentialsRoot, name)))
    )
      found.add(name);
  return [...found].sort();
}

/** Asks the server for the person until it answers; null when it can't be told (see the module's comment). */
async function resolvePerson(o: OnePersonFilesOptions, folders: readonly string[]): Promise<string | null> {
  let wait = o.retryMs ?? 2_000;
  for (;;) {
    let answer: string | null;
    try {
      answer = await o.person();
    } catch (err) {
      o.log(
        'warn',
        `one person · waiting for the server to name the person: ${String((err as Error).message ?? err)}`,
      );
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 30_000);
      continue;
    }
    if (answer) return answer;
    if (folders.length === 1) return folders[0] as string;
    return null;
  }
}

/** Moves the old layout's files to the one person's (see the module's comment). */
export async function moveToOnePerson(o: OnePersonFilesOptions): Promise<OnePersonFilesResult> {
  const done: string[] = [];
  const folders = await accountFolders(o);
  let person: string | null = null;
  if (folders.length) {
    person = await resolvePerson(o, folders);
    if (person === null)
      o.log(
        'warn',
        `one person · ${folders.length} people's folders and nobody claimed this Whombat yet: they stay until it is claimed`,
      );
  }
  const accountsKnown = folders.length === 0 || person !== null;
  if (accountsKnown) {
    await hermesFiles(o, person, done);
    await credentials(o, person, done);
  }
  await workFolder(o, done);
  for (const line of done) o.log('info', `one person · ${line}`);
  return { person, done };
}

/* Hermes ----------------------------------------------------------------------------------------------------------- */

async function hermesFiles(o: OnePersonFilesOptions, person: string | null, done: string[]): Promise<void> {
  const root = o.hermesRoot;
  const profiles = join(root, 'profiles');
  const old = (await names(profiles)).filter((n) => n !== FEEDBACK && !n.startsWith('.'));
  const pending = (await names(join(root, 'pending'))).filter(
    (n) => n.endsWith('.json') && n !== 'person.json' && n !== 'outside.json',
  );
  if (!old.length && !pending.length) return;
  const holder = 'one-person move';
  const locks = [await lockHermesProfile(root, root, { holder, waitMs: LOCK_WAIT_MS })];
  try {
    locks.push(
      await hostLock(`hermes-skills:${join(root, 'skills')}`, {
        dir: join(root, 'locks'),
        holder,
        waitMs: LOCK_WAIT_MS,
      }),
    );
    for (const name of old)
      locks.push(await lockHermesProfile(root, join(profiles, name), { holder, waitMs: LOCK_WAIT_MS }));
    if (person && old.includes(person)) {
      await intoRoot(o, join(profiles, person), done);
      done.push(`moved ${person}'s Hermes home into ${root}`);
    }
    if (old.includes(SHARED)) {
      await sharedIntoRoot(o, join(profiles, SHARED), done);
      done.push('merged the shared profile’s memories and learned skills');
    }
    for (const name of old) {
      await rm(join(profiles, name), { recursive: true, force: true });
      if (name !== person && name !== SHARED) done.push(`removed the Hermes home of ${name}`);
    }
    await pendingDeletes(root, person, pending, done);
  } finally {
    for (const lock of locks.reverse()) await lock.release().catch(() => {});
  }
}

/** The person's old profile into the root: each entry moved, memories and skills merged, the root's kept on a clash. */
async function intoRoot(o: OnePersonFilesOptions, from: string, done: string[]): Promise<void> {
  const root = o.hermesRoot;
  for (const name of await names(from)) {
    const src = join(from, name);
    if (name === NO_BUNDLED) continue;
    if (name === 'skills') {
      // A link (the old skills home's way to the shared folder) is nobody's skills.
      if ((await lstat(src)).isSymbolicLink()) continue;
      await mergeSkills(src, join(root, 'skills'), 'incoming', done);
      continue;
    }
    if (name === 'memories' && (await exists(join(root, 'memories')))) {
      await mergeMemories(from, root, done);
      continue;
    }
    if (await exists(join(root, name))) {
      o.log('warn', `one person · ${join(root, name)} is there already: kept, the old ${name} left out`);
      continue;
    }
    await move(src, join(root, name));
  }
}

/** The shared profile's memories appended to the person's, its learned skills into the root's (a clash: the person's). */
async function sharedIntoRoot(o: OnePersonFilesOptions, from: string, done: string[]): Promise<void> {
  if (await isDir(join(from, 'memories'))) await mergeMemories(from, o.hermesRoot, done);
  if (await isDir(join(from, 'skills')))
    await mergeSkills(join(from, 'skills'), join(o.hermesRoot, 'skills'), 'kept', done);
}

/** Appends the memory entries of the profile `from` that the profile `into` doesn't have, as Hermes's limits allow. */
async function mergeMemories(from: string, into: string, done: string[]): Promise<void> {
  for (const file of ['memory', 'user'] as HermesMemoryFile[]) {
    const theirs = await readMemoryFile(from, file).catch(() => null);
    if (!theirs?.entries.length) continue;
    const mine = await readMemoryFile(into, file);
    const entries = [...mine.entries];
    const known = new Set(entries.map((e) => e.trim()));
    let left = 0;
    for (const entry of theirs.entries) {
      if (known.has(entry.trim())) continue;
      const next = [...entries, entry];
      if (memoryChars(next.join(HERMES_MEMORY_DELIMITER)) > HERMES_MEMORY_LIMITS[file]) {
        left++;
        continue;
      }
      entries.push(entry);
      known.add(entry.trim());
    }
    if (entries.length > mine.entries.length) {
      await mkdir(join(into, 'memories'), { recursive: true, mode: 0o700 });
      await writeMemoryFile(into, file, entries);
      done.push(
        `added ${entries.length - mine.entries.length} ${file} entries${left ? ` (${left} didn’t fit)` : ''}`,
      );
    }
  }
}

/**
 * Moves the skills under `from` into `into`, folder by folder (a skill is a folder with a `SKILL.md`, under categories):
 * on a clash `incoming` replaces the one there (the person's changed copy of a shared skill), `kept` leaves it.
 * Hermes's and Whombat's own files (dot names) stay out.
 */
async function mergeSkills(
  from: string,
  into: string,
  clash: 'incoming' | 'kept',
  done: string[],
): Promise<void> {
  let moved = 0;
  const walk = async (rel: string) => {
    for (const name of await names(join(from, rel))) {
      if (name.startsWith('.')) continue;
      const path = join(rel, name);
      const src = join(from, path);
      const dst = join(into, path);
      const info = await lstat(src).catch(() => null);
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory() && !(await exists(join(src, 'SKILL.md')))) {
        await walk(path);
        continue;
      }
      if (await exists(dst)) {
        if (clash === 'kept') continue;
        await rm(dst, { recursive: true, force: true });
      }
      await mkdir(join(into, rel), { recursive: true, mode: 0o700 });
      await move(src, dst);
      if (info.isDirectory()) moved++;
    }
  };
  await walk('');
  if (moved) done.push(`moved ${moved} skill${moved === 1 ? '' : 's'} into ${into}`);
}

/** `pending/<person>.json` and `_feedback.json` become the homes' lists (merged with any there); the others go. */
async function pendingDeletes(root: string, person: string | null, files: readonly string[], done: string[]) {
  const dir = join(root, 'pending');
  const read = async (name: string): Promise<{ id: string; attempts: number }[]> => {
    try {
      const list = JSON.parse(await readFile(join(dir, name), 'utf8')) as unknown;
      return Array.isArray(list)
        ? list.filter((p): p is { id: string; attempts: number } => typeof p?.id === 'string')
        : [];
    } catch {
      return [];
    }
  };
  const into = async (from: string, to: string) => {
    const list = [...(await read(to))];
    const ids = new Set(list.map((p) => p.id));
    for (const p of await read(from)) if (!ids.has(p.id)) list.push({ id: p.id, attempts: p.attempts ?? 0 });
    const tmp = join(dir, `${to}.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(list), { mode: 0o600 });
    await rename(tmp, join(dir, to));
    done.push(`pending session deletes of ${from} kept as ${to}`);
  };
  for (const name of files) {
    if (person && name === `${person}.json`) await into(name, 'person.json');
    else if (name === `${FEEDBACK}.json`) await into(name, 'outside.json');
    await rm(join(dir, name), { force: true });
  }
}

/* Sign-ins and the work folder ------------------------------------------------------------------------------------- */

async function credentials(o: OnePersonFilesOptions, person: string | null, done: string[]): Promise<void> {
  const root = o.credentialsRoot;
  for (const name of await names(root)) {
    if ((PROVIDERS as readonly string[]).includes(name) || name === GATEWAY || name.startsWith('.')) continue;
    if (!ACCOUNT.test(name) || !(await isDir(join(root, name)))) continue;
    if (name === person)
      for (const provider of PROVIDERS) {
        const src = join(root, name, provider);
        if (!(await isDir(src))) continue;
        if (await exists(join(root, provider))) {
          o.log(
            'warn',
            `one person · ${join(root, provider)} is there already: kept, the old sign-in left out`,
          );
          continue;
        }
        await move(src, join(root, provider));
        done.push(`moved the ${provider} sign-in to ${join(root, provider)}`);
      }
    await rm(join(root, name), { recursive: true, force: true });
    if (name !== person)
      done.push(name === 'org' ? 'removed the organisation’s sign-ins' : `removed ${name}'s sign-ins`);
  }
}

async function workFolder(o: OnePersonFilesOptions, done: string[]): Promise<void> {
  const computers = join(o.workspaces, '.computers');
  if (!(await isDir(computers))) return;
  const target = join(o.agentHome, 'work');
  for (const agent of await names(computers)) {
    const work = join(computers, agent, 'work');
    if (!(await isDir(work))) continue;
    await mkdir(o.agentHome, { recursive: true, mode: 0o770 });
    if (!(await exists(target)) || (await names(target)).length === 0) {
      await rm(target, { recursive: true, force: true });
      await move(work, target);
      // As the agent's home is (I-3): the container engine's group reaches it for bind mounts.
      await chmod(target, 0o770);
      done.push(`moved the work folder to ${target}`);
    } else {
      // A second agent's (there is one agent, OA-01) or a work folder made meanwhile: beside it, never over it.
      await move(work, join(target, `from-${agent}`));
      done.push(`moved ${agent}'s work folder to ${join(target, `from-${agent}`)}`);
    }
  }
  await rm(computers, { recursive: true, force: true });
}
