// `whombat-gh` (docs/decisions/agent-gh.md AGH-02, AGH-08, AGH-15): the `gh` of an agent's shell in a managed turn.
// It runs nothing itself and holds no token: it reads the files and stdin the command names (AGH-08) where the agent's
// shell is, sends the words and those bytes as one JSON line to the runner's per-turn gh service — the unix socket in
// `$WHOMBAT_GH_SOCKET` (bound into the command's wrapper) — reads one JSON line back (`{exitCode, stdout, stderr}`, base64) and prints it. The runner asks the server, which
// decides the command by the agent's keys, and either runs the real gh outside the sandbox or answers itself.
//
// Plain JavaScript with built-in modules and its neighbours only: it runs on the commands' Node, from their folder bound
// read-only into their wrapper.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askLine, socketTarget } from './line-client.mjs';

/** The contracts' limits (`GH_ARGS_MAX`, `GH_ARG_MAX`, `GH_FILES_MAX`, `GH_INPUT_MAX_BYTES`), checked before sending. */
export const ARGS_MAX = 200;
export const ARG_MAX = 65_536;
export const FILES_MAX = 8;
export const INPUT_MAX_BYTES = 1024 * 1024;

/** Commands whose `-F` / `--body-file` names a body file (AGH-08); `gh api`'s `-F` is a field. */
const BODY_FILE_COMMANDS = new Set(['pr', 'issue', 'release']);

/**
 * What the command reads (AGH-08): the paths of the files it names, in order and once each, and whether it reads
 * stdin (`-`, `@-`). `gh api`: `--input FILE` and the `@FILE` values of `-F/--field key=@FILE`; `gh pr|issue|release
 * …`: `-F/--body-file FILE`. Values attached (`--input=f`, `-Ff`, `-F=f`) or as the next word; nothing after `--`.
 */
export function inputsOf(args) {
  const out = { paths: [], stdin: false };
  const command = args.find((a) => !a.startsWith('-'));
  const api = command === 'api';
  const bodyFiles = !api && BODY_FILE_COMMANDS.has(command);
  if (!api && !bodyFiles) return out;
  const file = (p) => {
    if (p === '-') out.stdin = true;
    else if (p && !out.paths.includes(p)) out.paths.push(p);
  };
  const field = (v) => {
    const eq = v.indexOf('=');
    if (eq < 0) return;
    const value = v.slice(eq + 1);
    if (value.startsWith('@')) file(value.slice(1));
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    let flag = a;
    let value = null;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flag = a.slice(0, eq);
        value = a.slice(eq + 1);
      }
    } else if (a.length > 2 && a[0] === '-' && a[1] === 'F') {
      flag = '-F';
      value = a.slice(a[2] === '=' ? 3 : 2);
    }
    const reads = api
      ? flag === '--input' || flag === '-F' || flag === '--field'
      : flag === '-F' || flag === '--body-file';
    if (!reads) continue;
    if (value === null) {
      value = args[i + 1];
      if (value === undefined) break;
      i++;
    }
    if (api && flag !== '--input') field(value);
    else file(value);
  }
  return out;
}

const ERRNO_TEXT = {
  ENOENT: 'no such file or directory',
  EACCES: 'permission denied',
  EISDIR: 'is a directory',
  ENOTDIR: 'not a directory',
};

/** Thrown for a command refused before anything is sent: its line, exit 1. */
class Refusal extends Error {}

function readAll(stream, max) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size > max) {
        stream.destroy();
        reject(new Refusal(tooBig()));
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => resolvePromise(Buffer.concat(chunks)));
    stream.on('error', (err) => reject(err));
  });
}

const tooBig = () =>
  'gh: the files and input of this command come to more than 1 MiB; through Whombat gh takes at most 1 MiB in one command.';

/**
 * The request for the gh service: the words, the files they name (read relative to `cwd`) and stdin when the command
 * reads it. Throws a `Refusal` (its message is the line to print) for what the contracts wouldn't take.
 */
export async function buildRequest(args, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  if (args.length > ARGS_MAX || args.some((a) => a.length > ARG_MAX))
    throw new Refusal(
      `gh: this command is too long to send through Whombat (at most ${ARGS_MAX} words of ${ARG_MAX} characters).`,
    );
  const inputs = inputsOf(args);
  if (inputs.paths.length > FILES_MAX)
    throw new Refusal(
      `gh: this command reads ${inputs.paths.length} files; through Whombat gh reads at most ${FILES_MAX} in one command.`,
    );
  let total = 0;
  const files = [];
  for (const path of inputs.paths) {
    let data;
    try {
      const full = resolve(cwd, path);
      if (statSync(full).size + total > INPUT_MAX_BYTES) throw new Refusal(tooBig());
      data = readFileSync(full);
    } catch (err) {
      if (err instanceof Refusal) throw err;
      throw new Refusal(`open ${path}: ${ERRNO_TEXT[err?.code] ?? err?.message ?? String(err)}`);
    }
    total += data.length;
    if (total > INPUT_MAX_BYTES) throw new Refusal(tooBig());
    files.push({ path, base64: data.toString('base64') });
  }
  let stdin = null;
  if (inputs.stdin) {
    const read = options.readStdin ?? ((max) => readAll(process.stdin, max));
    const data = await read(INPUT_MAX_BYTES - total);
    if (data.length + total > INPUT_MAX_BYTES) throw new Refusal(tooBig());
    stdin = data.toString('base64');
  }
  return { args: [...args], files, stdin };
}

/** Where the gh service is: `$WHOMBAT_GH_SOCKET` (AGH-16), or null outside a turn with GitHub. */
function target(env) {
  const path = env.WHOMBAT_GH_SOCKET;
  return path ? socketTarget(path) : null;
}

function unreachable(err) {
  return `gh: couldn’t reach Whombat (${err?.code ?? err?.message ?? 'no answer'}); this turn may be over.`;
}

/** One try: `{reply}`, `{error}` once connected, or `{refused: err}` when it couldn't connect at all. */
function attempt(request, options) {
  return askLine(options, request, {
    refused: (err) => ({ refused: err }),
    broken: (err) => ({ error: unreachable(err) }),
    unreadable: () => ({ error: 'gh: Whombat’s answer couldn’t be read.' }),
    closed: () => ({ error: 'gh: the connection to Whombat closed before gh answered.' }),
  });
}

/** Sends one request line to `$WHOMBAT_GH_SOCKET` and reads one reply line (`{exitCode, stdout, stderr}`). */
export async function exchange(request, env = process.env) {
  const t = target(env);
  if (!t)
    return { error: 'gh: gh isn’t available here: Whombat runs gh for you only in a turn that has GitHub.' };
  const r = await attempt(request, t);
  return r.refused ? { error: unreachable(r.refused) } : r;
}

function exit(code, out, err) {
  const write = (stream, data) =>
    new Promise((resolvePromise) =>
      data.length ? stream.write(data, () => resolvePromise()) : resolvePromise(),
    );
  return Promise.all([write(process.stdout, out), write(process.stderr, err)]).then(() => process.exit(code));
}

/**
 * `gh auth token` answers here, quietly and without a token, as gh does without a login: Hermes asks it at every session
 * start (its credential discovery), and the token is never the agent's anyway (AGH-02; hermes-engine.md step 1).
 */
export function quietRefusal(argv) {
  const words = argv.filter((a) => !a.startsWith('-'));
  return words[0] === 'auth' && words[1] === 'token';
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (quietRefusal(argv)) return exit(1, Buffer.alloc(0), Buffer.alloc(0));
  let request;
  try {
    request = await buildRequest(argv);
  } catch (err) {
    return exit(1, Buffer.alloc(0), Buffer.from(`${err instanceof Refusal ? err.message : `gh: ${err}`}\n`));
  }
  const answer = await exchange(request, env);
  if (answer.error) return exit(1, Buffer.alloc(0), Buffer.from(`${answer.error}\n`));
  const r = answer.reply ?? {};
  const code = Number.isInteger(r.exitCode) && r.exitCode >= 0 && r.exitCode <= 255 ? r.exitCode : 1;
  const decode = (s) => (typeof s === 'string' ? Buffer.from(s, 'base64') : Buffer.alloc(0));
  return exit(code, decode(r.stdout), decode(r.stderr));
}

const self = fileURLToPath(import.meta.url);
let invoked = '';
try {
  invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
} catch {}
if (invoked === self || invoked === realpathSync(self)) await main();
