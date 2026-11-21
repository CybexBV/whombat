// Fake ACP runtime for tests (docs/decisions/bp-acp.md): speaks newline-delimited JSON-RPC 2.0 on stdio as an
// ACP v1 agent would, without the SDK, so it can also break the protocol on purpose. Behaviour comes from
// FAKE_ACP_MODE (comma-separated flags); every message it receives, and the answers to its own requests, are
// appended to FAKE_ACP_LOG as JSON lines.
//
// Flags: family (grandchildren, so a test can check they die with the runtime).
//
// Hermes (`hermes acp` through its gateway, hermes-engine.md step 1): hermes (initialize without MCP over HTTP, with
// load and resume; `local-…` session ids; reply chunks with a messageId, notices without; resume and load replay the
// conversation; a prompt sent while one runs waits for it, FIFO) · stdio-mcp (starts the session's stdio MCP server
// and calls set_status through it, named as Hermes names an editor's server) · steer (`/steer x` while a prompt runs:
// the “Steer queued” notice, and the running prompt's reply says steered=x) · hermes-permission (Hermes's
// dangerous-command card and a clarify question) · hermes-ask (the card Hermes's approval gate sends for Whombat's
// policy asking about a key: `<web_search> (plugin approval rule)` with the plugin's JSON) · review (the plugin's review marker in
// `$HERMES_HOME/whombat-review/` before the answer, gone FAKE_ACP_REVIEW_MS later, as Hermes's memory and skill review) ·
// review-dies (with review: the process exits while the review runs) · lost (the first prompt is refused as a turn Hermes lost, until
// `/discard adm_lost1`) · slow (thinks until cancelled, then `cancelled`) · no-model (the prompt fails as Hermes's does
// without a model) · repeat (the reply's last sentence again under its message id, as Hermes does after a refused Codex
// command) · stale (a lost turn's late chunk right after a session is set up, before any prompt) · legacy-claude (resume
// says the session is on `claude-cli:opus`) · other-model (resume says DirectSDK on `sonnet`) · chatgpt-model (on
// `openai-codex:gpt-6-sol`) · codex-mode (on `openai:gpt-6-sol`, a Codex-mode session) · confirm-model
// (`session/set_model` asks Hermes's guarded-switch card, `model-confirm-…`, and is refused unless allowed) ·
// refuse-model (`session/set_model` refused) · silence-refused (the reply is only `NO_REPLY`, then the gateway's notice
// that replaces it on a person's turn, under the same message id).
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const flags = new Set(
  (process.env.FAKE_ACP_MODE ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const logFile = process.env.FAKE_ACP_LOG;
const log = (entry) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};
log({ kind: 'start', cwd: process.cwd(), argv: process.argv.slice(2), env: { ...process.env } });

const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextId = 5000;
const waiting = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const sessions = new Map();
let cancelled = null;
let family = null;
const hermes = flags.has('hermes');
let messageSeq = 0;
/** Hermes's reply chunks carry a messageId; its notices don't. */
const reply = (sid, text, messageId = `msg-${++messageSeq}`) =>
  update(sid, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
    ...(hermes ? { messageId } : {}),
  });
const notice = (sid, text) =>
  update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
/** Per session: the prompt running now (later ones wait for it), and steers taken into it. */
const running = new Map();
const steered = new Map();
let lost = flags.has('lost');

/** Calls set_status on a stdio MCP server (the session's `whombat`), as Hermes's MCP client would. */
async function callStdioMcp(server) {
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value])) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout });
  const answers = new Map();
  lines.on('line', (line) => {
    const m = JSON.parse(line);
    answers.get(m.id)?.(m);
  });
  const call = (id, method, params) =>
    new Promise((resolve) => {
      answers.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const init = await call(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fake-hermes', version: '1' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const result = await call(2, 'tools/call', { name: 'set_status', arguments: { doing: 'Testing Hermes' } });
  child.stdin.end();
  return { ok: !init.error && !result.error && !result.result?.isError, error: result.error?.message };
}

function startFamily() {
  if (!flags.has('family')) return;
  family = spawn(process.execPath, [fileURLToPath(new URL('../../testing/family.mjs', import.meta.url))], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, FAMILY_PIDS_FILE: process.env.FAKE_ACP_PIDS },
  });
  family.unref();
}

async function prompt(id, params) {
  const sid = params.sessionId;
  const text0 = params.prompt.find((b) => b.type === 'text')?.text ?? '';
  if (hermes) {
    if (text0.startsWith('/discard ')) {
      if (text0.trim() === '/discard adm_lost1') lost = false;
      notice(sid, `Discarded ${text0.slice(9).trim()}.\n`);
      send({ id, result: { stopReason: 'end_turn' } });
      return;
    }
    if (lost) {
      send({
        id,
        error: {
          code: -32603,
          message: 'Internal error',
          data: {
            details:
              'unknown_execution: do not resend accepted input; a turn in this session was lost when the gateway restarted. Send `/discard adm_lost1` here, then continue.',
          },
        },
      });
      return;
    }
    if (text0.startsWith('/steer ')) {
      if (running.get(sid)) {
        steered.set(sid, [...(steered.get(sid) ?? []), text0.slice(7)]);
        notice(sid, `⏩ Steer queued for the active turn: ${text0.slice(7, 87)}\n`);
      }
      send({ id, result: { stopReason: 'end_turn' } });
      return;
    }
    // Hermes's FIFO: a prompt sent while one runs waits for it.
    while (running.get(sid)) await running.get(sid);
    let done;
    running.set(
      sid,
      new Promise((r) => {
        done = r;
      }),
    );
    try {
      await runPrompt(id, params);
    } finally {
      running.delete(sid);
      done();
    }
    return;
  }
  await runPrompt(id, params);
}

async function runPrompt(id, params) {
  const sid = params.sessionId;
  const session = sessions.get(sid) ?? { mcpServers: [] };
  cancelled = null;
  startFamily();
  update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking…' } });
  if (flags.has('no-model')) {
    reply(sid, '⚠️ No model is set.');
    send({
      id,
      error: { code: -32603, message: 'Internal error', data: { details: 'admitted_turn_failed' } },
    });
    return;
  }
  if (flags.has('silence-refused')) {
    reply(sid, 'NO_REPLY');
    reply(
      sid,
      '\n\n⚠️ The model returned only a silence marker for a message that needed a reply.',
      `msg-${messageSeq}`,
    );
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (flags.has('slow')) {
    for (let i = 0; i < 400 && cancelled !== sid; i++) {
      update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '.' } });
      await sleep(25);
    }
    send({ id, result: { stopReason: cancelled === sid ? 'cancelled' : 'end_turn' } });
    return;
  }
  let text = 'Done.';
  if (hermes) text = `Done: ${(params.prompt.find((b) => b.type === 'text')?.text ?? '').slice(0, 60)}`;
  if (flags.has('stdio-mcp')) {
    const server = session.mcpServers.find((s) => s.name === 'whombat' && s.command);
    update(sid, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-mcp',
      title: 'mcp__editor_whombat_6321104b__set_status: {"doing": "Testing Hermes"}',
      kind: 'other',
      status: 'in_progress',
    });
    const r = server ? await callStdioMcp(server) : { ok: false, error: 'no stdio server' };
    update(sid, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-mcp',
      status: r.ok ? 'completed' : 'failed',
    });
    text += ` mcp=${r.ok ? 'ok' : `failed(${r.error})`}`;
  }
  if (flags.has('hermes-permission')) {
    const exec = await ask('session/request_permission', {
      sessionId: sid,
      toolCall: {
        toolCallId: 'perm-check-1',
        title: 'Codex requests exec in /work: rm -rf build',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'rm -rf build', description: 'Codex requests exec in /work' },
      },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    const clarify = await ask('session/request_permission', {
      sessionId: sid,
      toolCall: { toolCallId: 'clarify-p1', title: 'Which branch?', kind: 'other', status: 'pending' },
      options: [
        { optionId: 'choice-0', name: 'main', kind: 'allow_once' },
        { optionId: 'skip', name: 'Skip', kind: 'reject_once' },
      ],
    });
    const pickedOf = (r) =>
      r.result?.outcome?.outcome === 'selected' ? r.result.outcome.optionId : r.result?.outcome?.outcome;
    text += ` exec=${pickedOf(exec)} clarify=${pickedOf(clarify)}`;
  }
  if (flags.has('hermes-ask')) {
    const description = JSON.stringify({
      kind: 'whombat_ask',
      key: 'web.browse',
      tool: 'web_search',
      detail: 'opening hours  of the Rijksmuseum',
      ask: '0123456789abcdef0123456789abcdef',
    });
    const asked = await ask('session/request_permission', {
      sessionId: sid,
      toolCall: {
        toolCallId: 'perm-check-7',
        title: `${description}: <web_search> (plugin approval rule)`,
        kind: 'execute',
        status: 'pending',
        rawInput: { command: '<web_search> (plugin approval rule)', description },
      },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    const picked =
      asked.result?.outcome?.outcome === 'selected'
        ? asked.result.outcome.optionId
        : asked.result?.outcome?.outcome;
    text += ` ask=${picked}`;
  }
  if (hermes) {
    await sleep(Number(process.env.FAKE_ACP_WORK_MS ?? 0));
    const took = steered.get(sid);
    if (took?.length) text += ` steered=${took.join('|')}`;
    steered.delete(sid);
  }
  const resources = params.prompt.filter((b) => b.type === 'resource').length;
  if (resources) text += ` resources=${resources}`;
  reply(sid, text);
  if (flags.has('repeat')) reply(sid, ` ${text}`, `msg-${messageSeq}`);
  if (flags.has('review') && process.env.HERMES_HOME) {
    // The plugin's review signal (whombat_hermes/review.py): a marker in the profile before the answer goes back,
    // removed when Hermes's memory and skill review ends.
    const ms = Number(process.env.FAKE_ACP_REVIEW_MS ?? 800);
    const dir = join(process.env.HERMES_HOME, 'whombat-review');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const marker = join(dir, `${process.pid}-1`);
    writeFileSync(marker, '', { mode: 0o600 });
    log({ kind: 'review', marker });
    setTimeout(() => rmSync(marker, { force: true }), ms);
    // review-dies: Hermes dies while the review runs, after the answer went back (the marker stays behind).
    if (flags.has('review-dies')) setTimeout(() => process.exit(3), 100);
  }
  send({ id, result: { stopReason: 'end_turn' } });
}

async function handle(msg) {
  log({ kind: 'recv', ...msg });
  if (msg.id !== undefined && !msg.method) {
    const resolve = waiting.get(msg.id);
    waiting.delete(msg.id);
    resolve?.(msg);
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: hermes
            ? {
                loadSession: true,
                promptCapabilities: { image: true },
                sessionCapabilities: { fork: {}, list: {}, resume: {} },
              }
            : {
                loadSession: false,
                promptCapabilities: { image: false, embeddedContext: true },
                mcpCapabilities: { http: true, sse: false },
                sessionCapabilities: {},
              },
          agentInfo: hermes
            ? { name: 'hermes-agent', version: '0.22.5' }
            : { name: 'fake-acp', title: 'Fake ACP', version: '1.0.0' },
          authMethods: [{ id: 'login', name: 'Log in', description: null }],
        },
      });
      return;
    case 'session/new': {
      const sessionId = hermes ? `local-${'0'.repeat(63)}${sessions.size + 1}` : `fake-${sessions.size + 1}`;
      sessions.set(sessionId, { mcpServers: params.mcpServers, meta: params._meta ?? null });
      send({ id, result: { sessionId } });
      if (flags.has('stale')) reply(sessionId, 'STALE late output of a lost turn');
      return;
    }
    case 'session/load': {
      if (hermes && params.sessionId === 'gone') {
        send({ id, error: { code: -32603, message: 'Internal error', data: { details: 'not_found' } } });
        return;
      }
      sessions.set(params.sessionId, { mcpServers: params.mcpServers });
      update(params.sessionId, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'OLD QUESTION' },
      });
      update(params.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'OLD REPLY' },
      });
      await sleep(10);
      send({ id, result: {} });
      return;
    }
    case 'session/resume':
      if (params.sessionId === 'gone') {
        send({ id, error: { code: -32002, message: 'Resource not found' } });
        return;
      }
      sessions.set(params.sessionId, { mcpServers: params.mcpServers });
      if (hermes) {
        // Hermes replays the conversation on resume too.
        update(params.sessionId, {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'OLD QUESTION' },
        });
        notice(params.sessionId, 'OLD REPLY');
        update(params.sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 'old-call',
          title: 'exec_command: ls',
          kind: 'other',
          status: 'completed',
        });
        await sleep(10);
      }
      {
        const current = flags.has('legacy-claude')
          ? 'claude-cli:opus'
          : flags.has('other-model')
            ? 'claude-subscription-directsdk-experimental:sonnet'
            : flags.has('chatgpt-model')
              ? 'openai-codex:gpt-6-sol'
              : flags.has('codex-mode')
                ? 'openai:gpt-6-sol'
                : null;
        send({
          id,
          result: current
            ? { models: { currentModelId: current, availableModels: [{ modelId: current, name: current }] } }
            : {},
        });
      }
      return;
    case 'session/set_model':
      if (flags.has('refuse-model')) {
        send({ id, error: { code: -32602, message: 'Invalid params', data: { details: 'no such model' } } });
        return;
      }
      if (flags.has('confirm-model')) {
        const answer = await ask('session/request_permission', {
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: 'model-confirm-0a1b2c3d4e5f',
            title: `Large context switch: ${params.modelId}`,
            kind: 'other',
            status: 'pending',
            rawInput: { model: params.modelId, guards: ['large_context'] },
          },
          options: [
            { optionId: 'allow_once', kind: 'allow_once', name: 'Switch anyway' },
            { optionId: 'deny', kind: 'reject_once', name: 'Cancel' },
          ],
        });
        if (answer.result?.outcome?.optionId !== 'allow_once') {
          send({
            id,
            error: { code: -32603, message: 'Internal error', data: { details: 'model_switch_cancelled' } },
          });
          return;
        }
      }
      send({ id, result: {} });
      return;
    case 'session/prompt':
      void prompt(id, params);
      return;
    case 'session/cancel':
      cancelled = params.sessionId;
      log({ kind: 'cancel', sessionId: params.sessionId });
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  void handle(JSON.parse(line));
});
rl.on('close', () => process.exit(0));
