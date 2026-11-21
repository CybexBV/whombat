// `whombat` (docs/decisions/resourceful-agents.md RA-31; one-person.md OP-S112): the helper in every command of the
// person's agent for what only Whombat can do — wake the agent when a background job is done, and say how things stand.
// It holds nothing: it sends one JSON line to the runner through the pod's helper socket (`/run/whombat/agent.sock`,
// bound into the command's wrapper) and prints the answer. A notify works from a background job after the turn that
// started it ended, for as long as the pod lives. Services that stay up are containers (OP-19), not this helper's.
//
// Plain JavaScript with built-in modules and its neighbours only: it runs on the sandbox's pinned Node.
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { askLine } from './line-client.mjs';

/** The helper socket inside the command's wrapper; `WHOMBAT_AGENT_SOCKET` overrides it (tests). */
export const SOCKET = '/run/whombat/agent.sock';
/** The contracts' limit (`NOTIFY_TEXT_MAX`), checked before sending. */
export const TEXT_MAX = 2000;
/** How long it waits for the runner's answer. */
const ANSWER_MS = 30_000;

export const USAGE = `Usage: whombat <command>

  notify "<text>"   Wake yourself in the conversation and thread of the turn that started this command
                    (at most ${TEXT_MAX} characters; "-" reads stdin). Use it at the end of a background job:
                    make build; whombat notify "build done: $?"
  status            What your commands reach, and whether Docker is there.
`;

/** Thrown for a command refused before anything is sent: its line, exit 1 (2 for a usage error). */
class Refusal extends Error {
  constructor(message, code = 1) {
    super(message);
    this.exitCode = code;
  }
}

/** The command line → what to send, without the turn or stdin: `{op, …}`, `{help: true}`, or a `Refusal` thrown. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === undefined) throw new Refusal(USAGE.trimEnd(), 2);
  switch (command) {
    case 'help':
    case '-h':
    case '--help':
      return { help: true };
    case 'notify': {
      if (rest.length === 1 && rest[0] === '-') return { op: 'notify', stdin: true };
      const text = rest.join(' ').trim();
      if (!text)
        throw new Refusal('whombat: say what happened: whombat notify "backup finished, 3.2 GB".', 2);
      return { op: 'notify', text };
    }
    case 'status':
      if (rest.length) throw new Refusal('whombat: status takes nothing more.', 2);
      return { op: 'status' };
    default:
      throw new Refusal(`whombat: there is no command ${command}.\n\n${USAGE.trimEnd()}`, 2);
  }
}

function readStdin(max) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > max) {
        process.stdin.destroy();
        reject(new Refusal(`whombat: a notify carries at most ${TEXT_MAX} characters.`));
        return;
      }
      chunks.push(c);
    });
    process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/** What to send: the parsed command, with the notify's turn (`WHOMBAT_TURN`), text and id. */
export async function buildRequest(parsed, env = process.env, options = {}) {
  if (parsed.op !== 'notify') return { op: parsed.op };
  const turn = (env.WHOMBAT_TURN ?? '').trim();
  if (!turn)
    throw new Refusal(
      'whombat: notify needs WHOMBAT_TURN, which every command of a turn has. Pass it on to a job you start another way: WHOMBAT_TURN=$WHOMBAT_TURN.',
    );
  const raw = parsed.stdin ? await (options.readStdin ?? readStdin)(64 * 1024) : parsed.text;
  const text = String(raw ?? '').trim();
  if (!text) throw new Refusal('whombat: the notify’s text is empty.');
  if ([...text].length > TEXT_MAX)
    throw new Refusal(
      `whombat: a notify carries at most ${TEXT_MAX} characters (this one has ${[...text].length}); say where the rest is.`,
    );
  return { op: 'notify', turn, text, eventId: options.eventId ?? randomBytes(12).toString('hex') };
}

/** One line to the runner, one line back: `{reply}` or `{error}` (a sentence). */
export function exchange(request, env = process.env, options = {}) {
  const path = env.WHOMBAT_AGENT_SOCKET || SOCKET;
  return askLine(
    { path },
    request,
    {
      refused: (err) => ({ error: `whombat: couldn’t reach Whombat (${err?.code ?? err?.message}).` }),
      broken: (err) => ({
        error: `whombat: the connection to Whombat broke (${err?.code ?? err?.message}).`,
      }),
      unreadable: () => ({ error: 'whombat: Whombat’s answer couldn’t be read.' }),
      closed: (connected) => ({
        error: connected
          ? 'whombat: Whombat closed the connection without an answer; try again in a moment.'
          : 'whombat: couldn’t reach Whombat.',
      }),
      timeout: () => ({ error: 'whombat: Whombat didn’t answer in time; try again in a moment.' }),
    },
    options.timeoutMs ?? ANSWER_MS,
  );
}

/** The lines to print for the runner's answer to `request`. */
export function describeReply(request, reply) {
  if (request.op === 'notify')
    return 'Sent: Whombat wakes you in the conversation and thread this job was started from.';
  const s = reply.status ?? {};
  const home = Array.isArray(s.homeNetworks) && s.homeNetworks.length ? s.homeNetworks.join(', ') : '';
  return [
    s.lan
      ? `Reaches: the internet and your local network${home ? `, and ${home}` : ''}; production servers only with a yes.`
      : `Reaches: the internet${home ? ` and ${home}` : ', but not your local network'}; production servers only with a yes.`,
    s.docker
      ? 'Docker: there (docker, docker compose). Publish a service on a port from 20000 to 20099.'
      : 'Docker: not available here.',
  ].join('\n');
}

function exit(code, out, err) {
  const write = (stream, text) =>
    new Promise((resolvePromise) =>
      text ? stream.write(`${text}\n`, () => resolvePromise()) : resolvePromise(),
    );
  return Promise.all([write(process.stdout, out), write(process.stderr, err)]).then(() => process.exit(code));
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let request;
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) return exit(0, USAGE.trimEnd(), '');
    request = await buildRequest(parsed, env);
  } catch (err) {
    return exit(
      err instanceof Refusal ? err.exitCode : 1,
      '',
      err instanceof Refusal ? err.message : `whombat: ${err}`,
    );
  }
  const answer = await exchange(request, env);
  if (answer.error) return exit(1, '', answer.error);
  const r = answer.reply ?? {};
  if (r.ok !== true) return exit(1, '', `whombat: ${r.error ?? 'Whombat refused that.'}`);
  return exit(0, describeReply(request, r), '');
}

const self = fileURLToPath(import.meta.url);
let invoked = '';
try {
  invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
} catch {}
if (invoked === self || invoked === realpathSync(self)) await main();
