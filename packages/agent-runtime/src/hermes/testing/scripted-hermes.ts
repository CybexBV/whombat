#!/usr/bin/env node
/**
 * The scripted Hermes (docs/decisions/hermes-engine.md HE-33, HE-S100…HE-S109): a stand-in for `hermes acp` that the
 * demo and the runner's and server's tests run through `WHOMBAT_HERMES_BIN`, on the same path as a live turn — the
 * profile the runner writes, ACP, the stdio MCP bridge, sessions — with a deterministic agent instead of a model.
 *
 *   <this file> acp [--think-ms N] [--tick-ms N]
 *   <this file> sessions delete <id> --yes   (as Hermes's own command)
 *   <this file> --version          (the pinned release's version line, for the runner's check)
 *
 * It speaks ACP as Hermes 0.22.5 does to the runner's `HermesProvider`: `initialize`; `session/new`, `session/load` and
 * `session/resume` (sessions kept in `$HERMES_HOME`, the conversation replayed on load and resume; each session keeps the
 * provider and model of the `config.yaml` it began with, says them as `models.currentModelId`, and changes them only by
 * `session/set_model`, hermes-native.md HN-07); `session/prompt`
 * (one at a time per session, later ones wait), `/steer` (“⏩ Steer queued …”, a notice without a message id) and
 * `/discard`; `session/cancel` (the prompt ends `cancelled`); `session/update` with thoughts, reply chunks (with a
 * message id) and tool calls shaped as Hermes shapes them (`tc-…` ids, `<tool>: <preview>` titles, Whombat's tools as
 * `mcp__editor_whombat_<tag>__<tool>`, the result as Hermes renders it); `session/request_permission` as Hermes's
 * dangerous-command card. Whombat's tools are called through the MCP server the session got — the stdio bridge,
 * started and spoken to over stdio as Hermes does.
 *
 * What it does is the scripted agent's (`scripted-turn.ts`): read the turn's prompt, then the canned reply, a search
 * answer, the demo storyline's run, a review, the personal assistant's mail and calendar, or a command it asks to run.
 * `--think-ms` and `--tick-ms` set its pace (the mock's 1.6 s and 2.6 s by default; tests pass a few milliseconds).
 * Node runs this file as it is (type stripping): it imports packages and `.ts` files only; the storyline, which needs
 * the contracts' sources, loads through tsx.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { HERMES_PIN } from '../pin.ts';
import {
  CANNED_REPLY,
  calendarReply,
  chooseScript,
  INBOX_TODAY_QUERY,
  inboxReply,
  NOT_CONNECTED_REPLY,
  type RunFacts,
  readTurn,
  type Script,
  sendReply,
  THINK_MS,
  TICK_MS,
  type ToolAnswer,
  type TurnFacts,
  tomorrowBounds,
} from './scripted-turn.ts';

type Json = Record<string, unknown>;

/* Settings ----------------------------------------------------------------------------------------------------------- */

function flag(name: string): number | null {
  const args = process.argv.slice(2);
  const at = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (at < 0) return null;
  const raw = args[at]?.includes('=') ? args[at]?.split('=')[1] : args[at + 1];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const THINK = flag('--think-ms') ?? THINK_MS;
const TICK = flag('--tick-ms') ?? TICK_MS;
const HOME = process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes');
const SESSIONS = join(HOME, 'scripted-hermes', 'sessions');

/* ACP over stdio ------------------------------------------------------------------------------------------------------ */

const send = (frame: Json) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const update = (sessionId: string, u: Json) =>
  send({ method: 'session/update', params: { sessionId, update: u } });
const textBlock = (text: string) => ({ type: 'content', content: { type: 'text', text } });

let nextRequest = 1;
const answers = new Map<number, (msg: Json) => void>();
/** A request to the client (`session/request_permission`); its answer, or its error. */
function ask(method: string, params: Json): Promise<Json> {
  const id = nextRequest++;
  return new Promise((resolve) => {
    answers.set(id, resolve);
    send({ id, method, params });
  });
}

/* Sessions -------------------------------------------------------------------------------------------------------------- */

interface McpServerSpec {
  name: string;
  command?: string;
  args?: string[];
  env?: { name: string; value: string }[];
}

/**
 * A session's provider and model, as Hermes keeps them from when it began (HN-07): the provider as its picker ids name it
 * (a named entry of `providers:` as `custom:<name>`). Null: a session from before the scripted Hermes kept one.
 */
interface Route {
  provider: string;
  model: string;
}

interface Session {
  id: string;
  cwd: string;
  history: { prompt: string; reply: string }[];
  route: Route | null;
  /** What `/reasoning` and `/fast` pinned for this session (HN-L11). */
  settings?: Record<string, string>;
  /** This process's: the MCP servers the session got last, the prompt running now and the steers it took. */
  servers: McpServerSpec[];
  queue: Promise<void>;
  running: AbortController | null;
  steers: string[];
}

const sessions = new Map<string, Session>();
const file = (id: string) => join(SESSIONS, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

function save(s: Session): void {
  mkdirSync(SESSIONS, { recursive: true, mode: 0o700 });
  const tmp = `${file(s.id)}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ id: s.id, cwd: s.cwd, history: s.history, route: s.route, settings: s.settings ?? {} }),
    {
      mode: 0o600,
    },
  );
  renameSync(tmp, file(s.id));
}

function stored(id: string, servers: McpServerSpec[]): Session | null {
  if (!existsSync(file(id))) return null;
  try {
    const raw = JSON.parse(readFileSync(file(id), 'utf8')) as Pick<Session, 'id' | 'cwd' | 'history'> & {
      route?: Route | null;
    };
    return { ...raw, route: raw.route ?? null, servers, queue: Promise.resolve(), running: null, steers: [] };
  } catch {
    return null;
  }
}

/** Hermes replays a session's conversation on load and resume; the runner drops it as history. */
function replay(s: Session): void {
  for (const turn of s.history) {
    update(s.id, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: turn.prompt } });
    if (turn.reply)
      update(s.id, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: turn.reply },
        messageId: messageId(),
      });
  }
}

const messageId = () => `msg-${randomBytes(8).toString('hex')}`;

/** The provider and model the profile's `config.yaml` names now (what a new session begins on); null without one. */
function configRoute(): Route | null {
  try {
    const text = readFileSync(join(HOME, 'config.yaml'), 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n');
    const config = JSON.parse(text) as { model?: { provider?: string; default?: string }; providers?: Json };
    const provider = config.model?.provider?.trim();
    const model = config.model?.default?.trim();
    if (!provider || !model) return null;
    return { provider: config.providers?.[provider] ? `custom:${provider}` : provider, model };
  } catch {
    return null;
  }
}

/** ACP's model state of a session (Hermes's `<provider>:<model>` picker id); none when it keeps no route. */
function modelsOf(s: Session): Json {
  if (!s.route) return {};
  const current = `${s.route.provider}:${s.route.model}`;
  return {
    models: { currentModelId: current, availableModels: [{ modelId: current, name: s.route.model }] },
  };
}

/** Providers Hermes reads a `<provider>:<model>` id of as a pick of that provider (its `parse_model_input`). */
const PICKABLE = new Set([
  'claude-subscription-directsdk-experimental',
  'claude-cli',
  'openai-codex',
  'anthropic',
]);
/** Providers Hermes knows but reads `<provider>:<model>` of as a vendor slug, `<provider>/<model>` (`openai`). */
const SLUG_VENDORS = new Set(['openai']);

/** Where `session/set_model` puts a session, as Hermes 0.22.5 resolves the id (`custom:<name>:` keeps its colons). */
function pickedRoute(modelId: string, current: Route): Route {
  if (modelId.startsWith('custom:')) {
    const [, name, ...rest] = modelId.split(':');
    return { provider: `custom:${name}`, model: rest.join(':') };
  }
  const at = modelId.indexOf(':');
  const left = at > 0 ? modelId.slice(0, at) : '';
  if (PICKABLE.has(left)) return { provider: left, model: modelId.slice(at + 1) };
  if (SLUG_VENDORS.has(left) && !current.provider.startsWith('custom'))
    return { provider: current.provider, model: `${left}/${modelId.slice(at + 1)}` };
  return { provider: current.provider, model: modelId };
}

function setModel(id: number | string, params: Json): void {
  const s = sessions.get(String(params.sessionId ?? ''));
  const modelId = typeof params.modelId === 'string' ? params.modelId.trim() : '';
  if (!s || !modelId) {
    send({ id, error: { code: -32602, message: 'Invalid params' } });
    return;
  }
  if (s.running) {
    send({
      id,
      error: { code: -32603, message: 'Session is busy; switch models while the session is idle' },
    });
    return;
  }
  s.route = pickedRoute(modelId, s.route ?? { provider: '', model: '' });
  save(s);
  send({ id, result: {} });
}

/* Whombat's MCP server, over stdio as Hermes speaks to an editor's server ---------------------------------------------- */

/** What Hermes keeps of a stdio server's environment (the MCP SDK's default) besides the server's own variables. */
const MCP_ENV = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

interface McpResult {
  isError: boolean;
  text: string;
  structured: Json | null;
}

class StdioMcp {
  readonly #child: ChildProcess;
  readonly #waiting = new Map<number, (msg: Json) => void>();
  #id = 1;
  tools = new Set<string>();

  constructor(spec: McpServerSpec) {
    const env: NodeJS.ProcessEnv = {};
    for (const k of MCP_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
    for (const e of spec.env ?? []) env[e.name] = e.value;
    this.#child = spawn(spec.command ?? 'false', spec.args ?? [], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    this.#child.on('error', () => this.#fail('the MCP server didn’t start'));
    this.#child.on('exit', () => this.#fail('the MCP server ended'));
    createInterface({ input: this.#child.stdout as NodeJS.ReadableStream }).on('line', (line) => {
      let msg: Json;
      try {
        msg = JSON.parse(line) as Json;
      } catch {
        return;
      }
      if (typeof msg.id === 'number' && !msg.method) {
        this.#waiting.get(msg.id)?.(msg);
        this.#waiting.delete(msg.id);
      } else if (msg.method === 'ping' && msg.id !== undefined) {
        this.#write({ id: msg.id, result: {} });
      }
    });
  }

  #fail(reason: string): void {
    for (const resolve of this.#waiting.values()) resolve({ error: { code: -32000, message: reason } });
    this.#waiting.clear();
  }

  #write(frame: Json): void {
    this.#child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
  }

  request(method: string, params: Json): Promise<Json> {
    const id = this.#id++;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      this.#write({ id, method, params });
    });
  }

  async open(): Promise<void> {
    const init = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'hermes-agent', version: 'scripted' },
    });
    if (init.error) throw new Error(String((init.error as Json).message ?? 'initialize failed'));
    this.#write({ method: 'notifications/initialized' });
    let cursor: string | undefined;
    do {
      const listed = await this.request('tools/list', cursor ? { cursor } : {});
      const result = (listed.result ?? {}) as { tools?: { name: string }[]; nextCursor?: string };
      for (const t of result.tools ?? []) this.tools.add(t.name);
      cursor = result.nextCursor;
    } while (cursor);
  }

  async call(name: string, args: Json): Promise<McpResult> {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res.error)
      return { isError: true, text: String((res.error as Json).message ?? 'error'), structured: null };
    const r = (res.result ?? {}) as {
      content?: { type: string; text?: string }[];
      structuredContent?: Json;
      isError?: boolean;
    };
    const text = (r.content ?? [])
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('');
    return { isError: r.isError === true, text, structured: r.structuredContent ?? null };
  }

  close(): void {
    this.#child.stdin?.end();
    this.#child.kill();
  }
}

const servers = new Map<string, Promise<StdioMcp>>();

/** The session's `whombat` server, started once per process (Hermes starts an editor's servers per session). */
function whombat(s: Session): Promise<StdioMcp> | null {
  const spec = s.servers.find((x) => x.name === 'whombat' && x.command);
  if (!spec) return null;
  const key = JSON.stringify(spec);
  let open = servers.get(key);
  if (!open) {
    const mcp = new StdioMcp(spec);
    open = mcp.open().then(() => mcp);
    open.catch(() => {});
    servers.set(key, open);
  }
  return open;
}

/** Hermes's name for a tool of an editor's server: `mcp__editor_<server>_<tag>__<tool>` (gateway/session_local_mcp). */
function hermesToolName(s: Session, tool: string): string {
  const scope = `editor-session:${createHash('sha256')
    .update(`${basename(HOME)}:${s.id}`)
    .digest('hex')}`;
  const tag = createHash('sha256').update(`${scope}:0`).digest('hex').slice(0, 8);
  return `mcp__editor_whombat_${tag}__${tool}`;
}

/* Hermes's renderings ------------------------------------------------------------------------------------------------- */

const PREVIEW_KEYS = ['query', 'text', 'command', 'path', 'name', 'prompt', 'code', 'goal'];

/** `<tool>: <preview>` (`build_tool_title`): the first of Hermes's preview arguments, on one line, at most 80. */
function toolTitle(name: string, args: Json): string {
  const key = PREVIEW_KEYS.find((k) => k in args);
  const raw = key === undefined ? '' : args[key];
  const value = Array.isArray(raw) ? (raw[0] ?? '') : raw;
  const preview = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!preview) return name;
  return `${name}: ${preview.length > 80 ? `${preview.slice(0, 77)}...` : preview}`;
}

const truncate = (text: string, limit: number) =>
  text.length <= limit
    ? text
    : `${text.slice(0, Math.max(0, limit - 100))}\n... (${text.length} chars total, truncated)`;

/** Hermes's `_format_structured_value`: nested values as compact Markdown bullets. */
function structuredLines(key: string, value: unknown, indent = 0, depth = 3): string[] {
  const pad = '  '.repeat(indent);
  const label = key ? `**${key}:**` : '';
  const line = (t: string) => `${pad}- ${label ? `${label} ` : ''}${t}`;
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    (typeof value === 'object' && !Object.keys(value).length)
  )
    return [];
  if (depth <= 0)
    return [line(truncate(typeof value === 'object' ? JSON.stringify(value) : String(value), 240))];
  if (Array.isArray(value)) {
    const lines = [line(`${value.length} item${value.length === 1 ? '' : 's'}`)];
    for (const [i, item] of value.slice(0, 8).entries())
      lines.push(
        `${pad}  ${i + 1}. ${truncate(typeof item === 'object' ? JSON.stringify(item) : String(item), 240)}`,
      );
    return lines;
  }
  if (typeof value === 'object') {
    const lines = [label ? `${pad}- ${label}` : `${pad}- ${Object.keys(value).length} fields`];
    for (const [k, v] of Object.entries(value as Json).slice(0, 8))
      lines.push(...structuredLines(k, v, indent + 1, depth - 1));
    return lines;
  }
  return [line(truncate(String(value), 500))];
}

/**
 * A Whombat tool's result as Hermes hands it on: its MCP handler's JSON (`{"result": text}`, the structured content
 * dropped when the text is the same JSON; `{"error": …}` for an error), rendered by the ACP adapter's generic formatter
 * (`<tool> result` and a bullet per field). Whombat's structured outcome doesn't reach the client as data (HE-S105).
 */
function hermesResult(name: string, res: McpResult): string {
  if (res.isError) return `${name} failed: ${truncate(res.text || 'MCP tool returned an error', 2000)}`;
  let payload: Json;
  let same = false;
  try {
    same = res.structured !== null && JSON.stringify(JSON.parse(res.text)) === JSON.stringify(res.structured);
  } catch {
    same = false;
  }
  if (res.structured === null || same) payload = { result: res.text };
  else
    payload = res.text ? { result: res.text, structuredContent: res.structured } : { result: res.structured };
  const lines = [`${name} result`];
  for (const [k, v] of Object.entries(payload)) lines.push(...structuredLines(k, v));
  return truncate(lines.join('\n'), 7000);
}

/* A turn ------------------------------------------------------------------------------------------------------------- */

class Cancelled extends Error {}

const toolCallId = () => `tc-${randomBytes(6).toString('hex')}`;

class Turn {
  readonly s: Session;
  readonly signal: AbortSignal;
  readonly facts: TurnFacts;

  constructor(s: Session, signal: AbortSignal, facts: TurnFacts) {
    this.s = s;
    this.signal = signal;
    this.facts = facts;
  }

  check(): void {
    if (this.signal.aborted) throw new Cancelled();
  }

  /** Waits `ms`; a cancel ends it at once. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.signal.aborted) return reject(new Cancelled());
      const timer = setTimeout(() => {
        this.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Cancelled());
      };
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  thought(text: string): void {
    update(this.s.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
  }

  /** Thinks for the agent's thinking time, a thought about once a second. */
  async think(): Promise<void> {
    let left = THINK;
    while (left > 0) {
      this.thought('…');
      const step = Math.min(left, 1000);
      await this.wait(step);
      left -= step;
    }
  }

  /** One of Whombat's tools through the session's MCP server, reported as Hermes reports a tool call. */
  async tool(name: string, args: Json): Promise<ToolAnswer> {
    this.check();
    const open = whombat(this.s);
    const mcp = open ? await open.catch(() => null) : null;
    // A tool the server doesn't offer this turn is one the model never sees.
    if (!mcp?.tools.has(name))
      return {
        ok: false,
        body: { error: { code: 'not_offered', message: `${name} isn’t offered in this turn.` } },
      };
    const id = toolCallId();
    const hermesName = hermesToolName(this.s, name);
    const hasArgs = Object.keys(args).length > 0;
    update(this.s.id, {
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title: toolTitle(hermesName, args),
      kind: 'other',
      status: 'pending',
      ...(hasArgs ? { content: [textBlock(JSON.stringify(args, null, 2))], rawInput: args } : {}),
      locations: typeof args.path === 'string' ? [{ path: args.path }] : [],
    });
    const res = await mcp.call(name, args);
    update(this.s.id, {
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      kind: 'other',
      status: res.isError ? 'failed' : 'completed',
      content: [textBlock(hermesResult(hermesName, res))],
    });
    let body: Json = res.structured ?? {};
    if (!res.structured) {
      try {
        body = JSON.parse(res.text) as Json;
      } catch {
        body = res.isError ? { error: { message: res.text } } : {};
      }
    }
    return { ok: !res.isError && body.status !== 'blocked', body };
  }
}

/* The scripts ------------------------------------------------------------------------------------------------------- */

type Story = typeof import('./scripted-story.ts');
let story: Promise<Story> | null = null;
const loadStory = () => {
  // The story reads the mock world from @whombat/fixtures, TypeScript sources whose `.js` specifiers only tsx resolves.
  story ??= import('tsx/esm/api').then(({ register }) => {
    register();
    return import('./scripted-story.ts');
  });
  return story;
};

/** The search answer with its receipts (`post_answer`). */
async function answer(t: Turn, search: NonNullable<TurnFacts['search']>): Promise<string> {
  const { citationMarkers, pickCitations, STORYLINE } = await loadStory();
  await t.think();
  const { storyline, cited } = pickCitations(search.query, search.results);
  if (cited.length === 0) return '';
  const text = storyline
    ? STORYLINE.answerText
    : `Here’s what I found about “${search.query}”. The closest match is ${cited[0]?.where}. ${citationMarkers(cited.length)}`;
  await t.tool('post_answer', {
    answerId: search.answerId,
    text,
    citations: cited.map((r, i) => ({ n: i + 1, resultId: r.id })),
    actions: storyline ? [...STORYLINE.answerActions] : [],
  });
  return '';
}

/** The demo run plays its LIVE timeline from where it stands; any other run is finished as it is. */
async function playRun(t: Turn, run: RunFacts): Promise<string> {
  const { activeStepAt, filesAt, isStorylineRun, STORYLINE, storylineTick } = await loadStory();
  const number = run.number;
  if (!isStorylineRun(run)) {
    for (const [i, step] of run.steps.entries())
      if (step.state !== 'done') await t.tool('run_step', { run: number, step: i, state: 'done' });
    await t.tool('finish_run', {
      run: number,
      outcome: 'done',
      summary: 'Picked the run back up and finished it.',
    });
    return '';
  }
  const total = STORYLINE.lines.length;
  for (let tick = storylineTick(run); tick < total; tick++) {
    await t.wait(TICK);
    const next = tick + 1;
    // Tests land while "Run the billing test suite" is still the active step.
    if (next === STORYLINE.testsAtTick) await t.tool('run_tests', { run: number, ...STORYLINE.tests.after });
    const before = activeStepAt(tick);
    const after = activeStepAt(next);
    if (after !== before) {
      for (let s = before; s < after; s++) await t.tool('run_step', { run: number, step: s, state: 'done' });
      if (after < STORYLINE.steps.length)
        await t.tool('run_step', { run: number, step: after, state: 'active' });
    }
    await t.tool('run_files', { run: number, files: filesAt(next) });
    // The log line last, so the run's "Now:" is the line just played.
    await t.tool('run_log', { run: number, lines: [STORYLINE.lines[tick] as string] });
  }
  await t.tool('post_message', { conversationId: STORYLINE.branchRoomId, text: STORYLINE.pushedMessage });
  await t.tool('finish_run', { run: number, outcome: 'done', summary: STORYLINE.summary });
  await t.tool('set_status', { doing: STORYLINE.pushedDoing });
  return '';
}

/** Someone else pushed a fix to a pull request: approve it, say so in its room. */
async function reviewApprove(t: Turn, prNumber: number, conversationId: string): Promise<string> {
  const { STORYLINE } = await loadStory();
  await t.think();
  const review = await t.tool('review_pull_request', { prNumber, decision: 'approve', body: '' });
  if (!review.ok) return 'I couldn’t approve this one. I don’t hold the key for it.';
  const storyline = prNumber === STORYLINE.prNumber;
  await t.tool('post_card', {
    conversationId,
    text: storyline ? STORYLINE.approvedMessage : 'Approved. Thanks for the fix.',
    card: { kind: 'pill', text: `Approved · PR #${prNumber}`, tone: 'ok' },
  });
  await t.tool('set_status', { doing: storyline ? STORYLINE.approvedDoing : `Approved PR #${prNumber}.` });
  return '';
}

let permissionSeq = 1;

/**
 * A command the person asked to run: Hermes's terminal tool behind its dangerous-command card
 * (`session/request_permission`); allowed, it runs through the commands' launcher when the turn has one
 * (`WHOMBAT_COMMANDS_NODE` + `WHOMBAT_COMMANDS_LAUNCHER`, as Hermes's `whombat_commands` backend), else `sh` in the
 * session's folder.
 */
async function command(t: Turn, cmd: string): Promise<string> {
  await t.think();
  const id = toolCallId();
  update(t.s.id, {
    sessionUpdate: 'tool_call',
    toolCallId: id,
    title: `terminal: ${cmd}`,
    kind: 'execute',
    status: 'pending',
    content: [textBlock(`$ ${cmd}`)],
    locations: [],
  });
  const description = 'Run a command the person asked for';
  const card = `perm-check-${permissionSeq++}`;
  const options = [
    { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
    { optionId: 'allow_session', kind: 'allow_always', name: 'Allow for session' },
    { optionId: 'allow_always', kind: 'allow_always', name: 'Allow always' },
    { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
    { optionId: 'deny_always', kind: 'reject_always', name: 'Deny always' },
  ];
  const answered = await ask('session/request_permission', {
    sessionId: t.s.id,
    toolCall: {
      toolCallId: card,
      title: `${description}: ${cmd}`,
      kind: 'execute',
      status: 'pending',
      content: [textBlock(`${description}\n$ ${cmd}`)],
      rawInput: { command: cmd, description },
    },
    options,
  });
  const outcome = ((answered.result as Json | undefined)?.outcome ?? {}) as {
    outcome?: string;
    optionId?: string;
  };
  const allowed =
    outcome.outcome === 'selected' &&
    options.some((o) => o.optionId === outcome.optionId && o.kind.startsWith('allow'));
  update(t.s.id, {
    sessionUpdate: 'tool_call_update',
    toolCallId: card,
    status: allowed ? 'completed' : 'failed',
  });
  t.check();
  if (!allowed) {
    update(t.s.id, {
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      kind: 'execute',
      status: 'failed',
      content: [textBlock('This tool call ended without a result (blocked, denied, or interrupted).')],
    });
    return 'I wasn’t allowed to run that.';
  }
  const node = process.env.WHOMBAT_COMMANDS_NODE?.trim();
  const launcher = process.env.WHOMBAT_COMMANDS_LAUNCHER?.trim();
  const [bin, ...pre] = node && launcher ? [node, launcher, 'bash'] : ['/bin/sh'];
  const ran = await new Promise<{ code: number; output: string }>((resolve) => {
    // The session the command belongs to, as the plugin's backend names it (HN-W04).
    const child = spawn(bin as string, [...pre, '-c', cmd], {
      cwd: t.s.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WHOMBAT_TURN_SESSION: t.s.id },
    });
    let output = '';
    const keep = (b: Buffer) => {
      output = (output + b.toString('utf8')).slice(-20_000);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const onAbort = () => child.kill('SIGKILL');
    t.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => resolve({ code: 127, output: String(err) }));
    child.on('close', (code) => {
      t.signal.removeEventListener('abort', onAbort);
      resolve({ code: code ?? 1, output });
    });
  });
  t.check();
  const text = ran.output.trim();
  update(t.s.id, {
    sessionUpdate: 'tool_call_update',
    toolCallId: id,
    kind: 'execute',
    status: ran.code === 0 ? 'completed' : 'failed',
    content: [textBlock(truncate(JSON.stringify({ output: text, exit_code: ran.code }), 5000))],
  });
  if (ran.code !== 0) return `It failed (exit ${ran.code}).${text ? ` ${text.slice(-300)}` : ''}`;
  return text ? text.slice(-500) : 'It ran without output.';
}

async function play(t: Turn, script: Script): Promise<string> {
  switch (script.kind) {
    case 'canned':
      await t.think();
      return script.text;
    case 'answer':
      return answer(t, script.search);
    case 'run':
      return playRun(t, script.run);
    case 'review_approve':
      return reviewApprove(t, script.prNumber, script.conversationId);
    case 'command':
      return command(t, script.command);
    case 'assistant_guide': {
      await t.think();
      // Whombat posts the guide's cards in the conversation; nothing to add (AG-01).
      const res = await t.tool('start_guide', { topic: script.topic });
      return res.ok ? '' : 'I couldn’t start that guide. Try Settings → Connections.';
    }
    case 'assistant_send':
      await t.think();
      return sendReply(await t.tool('mail_send', { ...script.mail }));
    case 'assistant_inbox':
      await t.think();
      return inboxReply(await t.tool('mail_search', { query: INBOX_TODAY_QUERY, limit: 10 }));
    case 'assistant_calendar': {
      await t.think();
      const timeZone = t.facts.timeZone ?? 'UTC';
      const { from, to } = tomorrowBounds(t.facts.now ?? new Date(), timeZone);
      const res = await t.tool('calendar_events', {
        from: from.toISOString(),
        to: to.toISOString(),
        calendarId: 'primary',
        limit: 20,
      });
      return calendarReply(res, timeZone);
    }
  }
}

function soul(): string {
  try {
    return readFileSync(join(HOME, 'SOUL.md'), 'utf8');
  } catch {
    return '';
  }
}

/** One prompt of a session: what the script says, as the reply; `cancelled` when stopped. */
async function runPrompt(s: Session, text: string, signal: AbortSignal): Promise<'end_turn' | 'cancelled'> {
  update(s.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking…' } });
  const facts = readTurn(text, soul());
  const t = new Turn(s, signal, facts);
  let reply: string;
  try {
    reply = await play(t, chooseScript(facts));
    t.check();
  } catch (err) {
    if (err instanceof Cancelled || signal.aborted) return 'cancelled';
    reply = facts.request ? NOT_CONNECTED_REPLY : CANNED_REPLY;
  }
  if (reply)
    update(s.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: reply },
      messageId: messageId(),
    });
  s.history.push({ prompt: text.slice(0, 4000), reply });
  save(s);
  return 'end_turn';
}

async function prompt(id: number | string, params: Json): Promise<void> {
  const s = sessions.get(String(params.sessionId));
  if (!s) {
    send({ id, error: { code: -32002, message: 'Resource not found', data: { details: 'not_found' } } });
    return;
  }
  const blocks = (params.prompt ?? []) as { type: string; text?: string }[];
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
  if (text.startsWith('/discard ')) {
    update(s.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `Discarded ${text.slice(9).trim()}.\n` },
    });
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  // A session's own effort and fast replies (hermes-native.md HN-L11): Hermes's notice, nothing in the conversation.
  if (/^\/(reasoning|fast) \S+$/.test(text)) {
    const [command, level] = text.slice(1).split(' ');
    s.settings = { ...(s.settings ?? {}), [command as string]: level as string };
    save(s);
    update(s.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `${command} set to ${level} for this session.\n` },
    });
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (text.startsWith('/steer ')) {
    // Taken into the running turn; Hermes says so in a notice (no message id), never part of the reply.
    if (s.running) {
      s.steers.push(text.slice(7));
      update(s.id, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `⏩ Steer queued for the active turn: ${text.slice(7, 87)}\n` },
      });
    }
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  // One prompt at a time: a later one waits for the one running (Hermes's admissions are in order).
  const before = s.queue;
  let done = () => {};
  s.queue = new Promise((r) => {
    done = r;
  });
  await before;
  const controller = new AbortController();
  s.running = controller;
  try {
    const stopReason = await runPrompt(s, text, controller.signal);
    send({ id, result: { stopReason } });
  } finally {
    s.running = null;
    s.steers = [];
    done();
  }
}

function open(id: number | string, params: Json, method: 'session/load' | 'session/resume'): void {
  const sid = String(params.sessionId ?? '');
  const s = sessions.get(sid) ?? stored(sid, (params.mcpServers ?? []) as McpServerSpec[]);
  if (!s) {
    if (method === 'session/resume') send({ id, error: { code: -32002, message: 'Resource not found' } });
    else send({ id, error: { code: -32603, message: 'Internal error', data: { details: 'not_found' } } });
    return;
  }
  s.servers = (params.mcpServers ?? []) as McpServerSpec[];
  if (typeof params.cwd === 'string') s.cwd = params.cwd;
  sessions.set(sid, s);
  replay(s);
  send({ id, result: modelsOf(s) });
}

function handle(msg: Json): void {
  if (msg.id !== undefined && !msg.method) {
    const resolve = answers.get(msg.id as number);
    answers.delete(msg.id as number);
    resolve?.(msg);
    return;
  }
  const id = msg.id as number | string | undefined;
  const params = (msg.params ?? {}) as Json;
  switch (msg.method) {
    case 'initialize':
      send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true },
            sessionCapabilities: { fork: {}, list: {}, resume: {} },
          },
          agentInfo: { name: 'hermes-agent', title: 'Hermes (scripted)', version: 'scripted' },
          authMethods: [],
        },
      });
      return;
    case 'session/new': {
      const s: Session = {
        id: `local-${randomBytes(32).toString('hex')}`,
        cwd: typeof params.cwd === 'string' ? params.cwd : process.cwd(),
        history: [],
        route: configRoute(),
        servers: (params.mcpServers ?? []) as McpServerSpec[],
        queue: Promise.resolve(),
        running: null,
        steers: [],
      };
      sessions.set(s.id, s);
      save(s);
      send({ id, result: { sessionId: s.id, ...modelsOf(s) } });
      return;
    }
    case 'session/load':
    case 'session/resume':
      if (id !== undefined) open(id, params, msg.method);
      return;
    case 'session/set_model':
      if (id !== undefined) setModel(id, params);
      return;
    case 'session/prompt':
      if (id !== undefined) void prompt(id, params);
      return;
    case 'session/cancel':
      sessions.get(String(params.sessionId))?.running?.abort();
      return;
    default:
      if (id !== undefined)
        send({ id, error: { code: -32601, message: `Method not found: ${String(msg.method)}` } });
  }
}

function shutdown(): void {
  for (const server of servers.values()) void server.then((m) => m.close()).catch(() => {});
  setTimeout(() => process.exit(0), 50).unref();
}

if (process.argv[2] === '--version') {
  // As the pinned release says it (the runner's `checkHermes` reads the version off the first line).
  process.stdout.write(
    `Hermes Agent v${HERMES_PIN.version} (scripted) · a stand-in for tests and the demo\n`,
  );
  process.exit(0);
}
if (process.argv[2] === 'sessions' && process.argv[3] === 'delete' && process.argv[4]) {
  // As `hermes sessions delete <id> --yes` answers (the Hermes-home service deletes a thread's session so, HE-S113).
  const id = process.argv[4];
  if (existsSync(file(id))) {
    rmSync(file(id), { force: true });
    process.stdout.write(`Deleted session '${id}'.\n`);
    process.exit(0);
  }
  process.stdout.write(`No session '${id}'. Run: hermes sessions list to find the id.\n`);
  process.exit(1);
}
if (process.argv[2] !== 'acp') {
  process.stderr.write(
    'usage: scripted-hermes acp [--think-ms N] [--tick-ms N] | sessions delete <id> --yes | --version\n',
  );
  process.exit(2);
}
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line) as Json);
  } catch {
    // Not JSON-RPC: ignored, as Hermes's reader does.
  }
});
lines.on('close', shutdown);
