/**
 * A profile's Hermes conversations (contracts 2.1 `sessions.list`, CT-1453; hermes-native.md HN-K09): what the server
 * prunes from (`sessions.delete` for the ones no thread names). Listed the Hermes way — the `whombat` plugin's
 * `python -m whombat_hermes.sessions list` with the Python beside `hermes`: Hermes's own session store opened read-only,
 * as its ACP `session/list` reads it — never by reading `state.db` here.
 *
 * A read: no profile lock and no pod quiesced, so a running turn neither waits for it nor makes it `busy`. The step's
 * `HERMES_HOME` and `HOME` are an empty scratch directory of its own (Hermes's start-up scaffolding lands there, not in
 * the profile); the profile is named on stdin. A profile that doesn't exist yet has no conversations (nothing is made
 * for a read). Without a real Hermes (development's scripted one: no Python beside it, or no plugin in it) the step
 * answers `unavailable`, as Hermes's skills steps do.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HERMES_SESSIONS_LIST_MAX,
  type HermesHome,
  type HermesHomeErrorCode,
  type HermesHomeResult,
  HermesSessionListing,
} from '@whombat/core';
import { type HermesHomeContext, HermesHomeError } from './context';

/** The plugin's module of session steps. */
export const SESSIONS_STEPS_MODULE = 'whombat_hermes.sessions';
/** One listing at most (Hermes's start, then one read of the store). */
const LIST_TIMEOUT_MS = 120_000;
/** The most a listing's answer may be (5,000 entries at the longest ids are about 1.2 MB). */
const ANSWER_MAX_BYTES = 4 * 1024 * 1024;
const STDERR_MAX_BYTES = 64 * 1024;

const unavailable = (why: string) => new HermesHomeError('unavailable', why);

/** The plugin's codes the server acts on; anything else (`invalid` is the runner's own mistake) failed. */
const CODES: Readonly<Record<string, HermesHomeErrorCode>> = { busy: 'busy', unavailable: 'unavailable' };

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Runs the plugin's `list` step: its answer, or a `HermesHomeError`. */
function runList(ctx: HermesHomeContext, python: string, profile: string, scratch: string): Promise<unknown> {
  const env: NodeJS.ProcessEnv = {
    ...ctx.hermesEnv(scratch),
    HOME: scratch,
    PYTHONDONTWRITEBYTECODE: '1',
    HERMES_QUIET: '1',
  };
  return new Promise<unknown>((resolve, reject) => {
    // An empty working directory: `-m` puts it first on Python's path.
    const child = spawn(python, ['-m', SESSIONS_STEPS_MODULE, 'list'], {
      env,
      cwd: scratch,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new HermesHomeError('failed', 'Hermes didn’t list its sessions in time.')));
    }, LIST_TIMEOUT_MS);
    child.stdout.on('data', (b: Buffer) => {
      outBytes += b.length;
      if (outBytes > ANSWER_MAX_BYTES) {
        child.kill('SIGKILL');
        finish(() => reject(new HermesHomeError('failed', 'Hermes’s session list was too long.')));
      } else out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      if (errBytes < STDERR_MAX_BYTES) err.push(b);
      errBytes += b.length;
    });
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          e.code === 'ENOENT' || e.code === 'EACCES'
            ? unavailable('Hermes’s sessions can’t be listed here (no Python beside Hermes).')
            : e,
        ),
      ),
    );
    child.on('close', (code) =>
      finish(() => {
        const text = Buffer.concat(out).toString('utf8').trim().split('\n').at(-1) ?? '';
        const stderr = Buffer.concat(err).toString('utf8');
        let answer: unknown;
        try {
          answer = text ? JSON.parse(text) : undefined;
        } catch {
          answer = undefined;
        }
        if (code === 0 && answer && typeof answer === 'object') return resolve(answer);
        const failure = answer as { code?: unknown; message?: unknown } | undefined;
        if (failure && typeof failure.code === 'string') {
          const message = String(failure.message ?? 'Listing failed.').slice(0, 900);
          const mapped = CODES[failure.code] ?? 'failed';
          if (mapped === 'failed') ctx.log('warn', `hermes-home · listing sessions failed: ${message}`);
          return reject(new HermesHomeError(mapped, message));
        }
        // No answer: the plugin isn't in this Python (a host's own), or the step crashed.
        if (/No module named ['"]?(whombat_hermes|hermes_state|acp_adapter)/.test(stderr))
          return reject(unavailable('Hermes’s sessions can’t be listed here (no plugin in its Python).'));
        ctx.log(
          'warn',
          `hermes-home · listing sessions ended ${code} without an answer: ${stderr.slice(-500)}`,
        );
        reject(new HermesHomeError('failed', 'Listing Hermes’s sessions ended without an answer.'));
      }),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ profile }));
  });
}

/**
 * A home's conversations, least recently active first (at most `HERMES_SESSIONS_LIST_MAX`; `more` when Hermes has
 * more). An entry the contract can't carry (an id Whombat never stores) is left out.
 */
export async function listSessions(
  ctx: HermesHomeContext,
  home: HermesHome,
): Promise<HermesHomeResult<'sessions.list'>> {
  const profile = ctx.profileDir(home);
  if (!ctx.python) throw unavailable('Hermes’s sessions can’t be listed here (no real Hermes).');
  if (!(await isDir(profile))) return { sessions: [], more: false };
  const scratch = await mkdtemp(join(tmpdir(), 'wb-hermes-sessions-'));
  try {
    const answer = (await runList(ctx, ctx.python, profile, scratch)) as {
      sessions?: unknown;
      more?: unknown;
    };
    const listed = Array.isArray(answer.sessions) ? answer.sessions : [];
    const sessions: HermesSessionListing[] = [];
    for (const entry of listed) {
      const parsed = HermesSessionListing.safeParse(entry);
      if (parsed.success) sessions.push(parsed.data);
    }
    if (sessions.length < listed.length)
      ctx.log(
        'warn',
        `hermes-home · ${listed.length - sessions.length} listed sessions left out (not Whombat’s shape)`,
      );
    return {
      sessions: sessions.slice(0, HERMES_SESSIONS_LIST_MAX),
      more: answer.more === true || sessions.length > HERMES_SESSIONS_LIST_MAX,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
