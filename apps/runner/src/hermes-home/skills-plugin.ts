/**
 * Hermes's own skills code, one step per process (hermes-skills.md HSK-03, HSK-S01…HSK-S12): the `whombat` plugin's
 * `python -m whombat_hermes.hermes_skills <step>` with the Python beside `hermes`, one JSON object in and one out.
 *
 * Every step runs with the runner's skills home as `HERMES_HOME` (its own state, outside `$WHOMBAT_HERMES_ROOT`,
 * HSK-S03), its own empty `HOME`, and none of the runner's secrets: no `GITHUB_TOKEN`/`GH_TOKEN`, and `GH_CONFIG_DIR`
 * an empty folder, so Hermes's `gh auth token` finds nothing and the hub reaches GitHub anonymously (HSK-S15). Without
 * a real Hermes (development's scripted one: no Python beside it, or no plugin in it) every step answers `unavailable`.
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HermesHomeErrorCode } from '@whombat/core';
import { HermesHomeError } from './context';

/** The plugin's skills steps (HSK-S04…HSK-S12). */
export type HermesSkillsStep =
  | 'sync'
  | 'builtins'
  | 'diff'
  | 'reset'
  | 'hub-search'
  | 'hub-inspect'
  | 'hub-install'
  | 'hub-uninstall'
  | 'hub-check'
  | 'hub-update'
  | 'scan';

/** Runs one step: its answer, or a `HermesHomeError` with the step's own code. */
export type HermesSkillsSteps = (step: HermesSkillsStep, input: Record<string, unknown>) => Promise<unknown>;

/** The plugin's error codes, as the Hermes-home service's. */
const CODES: Readonly<Record<string, HermesHomeErrorCode>> = {
  invalid: 'invalid',
  not_found: 'not_found',
  conflict: 'conflict',
  blocked: 'blocked',
  unavailable: 'unavailable',
  failed: 'failed',
};

/** Seconds a step may take beyond its own budget (HSK-S02) before the runner stops it: Hermes's start and the write. */
const GRACE_S = 30;
/** The plugin's budgets (HSK-S02), for steps that reach the network. */
const BUDGET_S: Partial<Record<HermesSkillsStep, number>> = {
  'hub-search': 20,
  'hub-inspect': 60,
  'hub-install': 90,
  'hub-check': 60,
  'hub-update': 90,
};
const LOCAL_S = 60;
/** The most a step's answer may be (a hub preview carries a whole `SKILL.md`). */
const ANSWER_MAX_BYTES = 8 * 1024 * 1024;
const STDERR_MAX_BYTES = 64 * 1024;

/** Variables a step gets from the runner's environment: how to reach the network, nothing that signs in. */
const PASSED = [
  'PATH',
  'LANG',
  'TZ',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NIX_SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  // Where Hermes's own skills are (the appliance's wrapper sets them; a runner may too).
  'HERMES_BUNDLED_SKILLS',
  'HERMES_OPTIONAL_SKILLS',
];

export interface PluginStepsOptions {
  /** The Python with Hermes and the plugin (`hermesPythonBeside`); null: no real Hermes. */
  python: string | null;
  /** The runner's skills state: `home/` (the skills home), `gh/` (empty), `user/` (the step's `HOME`). */
  state: string;
  env: NodeJS.ProcessEnv;
  log: (level: 'info' | 'warn', msg: string) => void;
}

/** The environment of one step (pure): the skills home, an empty `HOME` and `GH_CONFIG_DIR`, no sign-ins. */
export function stepEnv(state: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of PASSED) if (env[name] !== undefined) out[name] = env[name];
  out.PATH ??= '/usr/bin:/bin';
  out.LANG ??= 'C.UTF-8';
  out.HERMES_HOME = join(state, 'home');
  out.HOME = join(state, 'user');
  out.GH_CONFIG_DIR = join(state, 'gh');
  out.PYTHONDONTWRITEBYTECODE = '1';
  return out;
}

const unavailable = (why: string) => new HermesHomeError('unavailable', why);

/** The plugin's steps through `python -m whombat_hermes.hermes_skills`. */
export function pluginSteps(options: PluginStepsOptions): HermesSkillsSteps {
  return async (step, input) => {
    if (!options.python) throw unavailable('Hermes’s skills code isn’t here (no real Hermes).');
    for (const dir of ['home', 'gh', 'user'])
      await mkdir(join(options.state, dir), { recursive: true, mode: 0o700 });
    const env = stepEnv(options.state, options.env);
    const seconds =
      (typeof input.timeout === 'number' ? input.timeout : (BUDGET_S[step] ?? LOCAL_S)) + GRACE_S;
    return new Promise<unknown>((resolve, reject) => {
      const child = spawn(
        options.python as string,
        ['-m', 'whombat_hermes.hermes_skills', step],
        // An empty working directory: `-m` puts it first on Python's path.
        { env, cwd: join(options.state, 'user'), stdio: ['pipe', 'pipe', 'pipe'] },
      );
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
        finish(() => reject(unavailable(`Hermes’s ${step} step didn’t answer in time.`)));
      }, seconds * 1000);
      child.stdout.on('data', (b: Buffer) => {
        outBytes += b.length;
        if (outBytes > ANSWER_MAX_BYTES) {
          child.kill('SIGKILL');
          finish(() => reject(new HermesHomeError('failed', `Hermes’s ${step} step answered too much.`)));
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
              ? unavailable('Hermes’s skills code isn’t here (no Python beside Hermes).')
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
            const mapped = CODES[failure.code] ?? 'failed';
            if (mapped === 'failed')
              options.log('warn', `skills · Hermes's ${step} step failed: ${String(failure.message ?? '')}`);
            return reject(
              new HermesHomeError(mapped, String(failure.message ?? 'The step failed.').slice(0, 900)),
            );
          }
          // No answer: the plugin isn't in this Python (a host's own), or the step crashed.
          if (/No module named ['"]?(whombat_hermes|tools|agent|hermes_cli)/.test(stderr))
            return reject(unavailable('Hermes’s skills code isn’t in this Python.'));
          options.log(
            'warn',
            `skills · Hermes's ${step} step ended ${code} without an answer: ${stderr.slice(-500)}`,
          );
          reject(new HermesHomeError('failed', `Hermes’s ${step} step ended without an answer.`));
        }),
      );
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
    });
  };
}
