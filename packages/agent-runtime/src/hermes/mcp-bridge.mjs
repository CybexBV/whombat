#!/usr/bin/env node
// Whombat's MCP tools for Hermes (docs/decisions/hermes-engine.md, step 1 interfaces): Hermes's ACP takes only stdio
// MCP servers from its client, so the runner passes this bridge — `node mcp-bridge.mjs <server>/mcp` — with the
// dispatch's agent token in WHOMBAT_MCP_TOKEN. Each JSON-RPC line on stdin is POSTed to Whombat's streamable HTTP
// endpoint (the bearer token, the MCP session id and protocol version the server gave); the answer — JSON, or the
// events of an SSE stream — goes to stdout, one line per message. A request the server can't take is answered with a
// JSON-RPC error, so the client never waits forever. No dependencies: it runs in the task sandbox with Node alone.
import { createInterface } from 'node:readline';

const url = process.argv[2];
const token = process.env.WHOMBAT_MCP_TOKEN ?? '';
if (!url) {
  process.stderr.write('usage: mcp-bridge.mjs <url>\n');
  process.exit(2);
}

/** The MCP session the server opened at `initialize`, and the protocol version it chose. */
let session = null;
let protocol = null;
/** Messages wait until the session is known: `initialize` first, everything after it in order of arrival. */
let ready = null;
let closed = false;

const write = (message) => {
  if (!closed) process.stdout.write(`${JSON.stringify(message)}\n`);
};

const errorFor = (message, text, code = -32603) => {
  if (message && message.id !== undefined && message.id !== null && typeof message.method === 'string')
    write({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
};

function headers() {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(session ? { 'mcp-session-id': session } : {}),
    ...(protocol ? { 'mcp-protocol-version': protocol } : {}),
  };
}

/** The `data:` messages of an SSE body, as they arrive. */
async function relayEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  const flush = () => {
    if (!data.length) return;
    const text = data.join('\n');
    data = [];
    try {
      relay(JSON.parse(text));
    } catch {
      // Not JSON: not a message (a comment or keep-alive the server sent as data).
    }
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) break;
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line === '') flush();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  flush();
}

/** One message (or a batch) from the server to the client; the initialize answer names the protocol version. */
function relay(message) {
  for (const m of Array.isArray(message) ? message : [message]) {
    const version = m?.result?.protocolVersion;
    if (typeof version === 'string' && !protocol) protocol = version;
    write(m);
  }
}

async function post(message) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(message) });
  } catch (err) {
    errorFor(message, `Whombat’s tools can’t be reached: ${err?.cause?.code ?? err?.message ?? err}`);
    return;
  }
  const sid = res.headers.get('mcp-session-id');
  if (sid && !session) session = sid;
  if (res.status === 202 || res.status === 204) return;
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    let answered = false;
    try {
      const body = JSON.parse(text);
      if (body && body.jsonrpc === '2.0' && body.error && body.id !== undefined) {
        write(body);
        answered = true;
      }
    } catch {
      // Not JSON-RPC: said below.
    }
    if (!answered)
      errorFor(
        message,
        res.status === 401 || res.status === 403
          ? 'Whombat refused this turn’s token.'
          : `Whombat’s tools answered ${res.status}${text ? `: ${text}` : ''}`,
      );
    return;
  }
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/event-stream') && res.body) {
    await relayEvents(res.body);
    return;
  }
  const text = await res.text();
  if (!text.trim()) return;
  try {
    relay(JSON.parse(text));
  } catch {
    errorFor(message, 'Whombat’s tools answered something that isn’t JSON.');
  }
}

const pending = new Set();
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const first = !ready;
  const run = first
    ? post(message)
    : // After the session exists, requests run side by side (a slow tool doesn't hold the next one back).
      ready.then(() => post(message));
  if (first) ready = run.catch(() => {});
  const p = run
    .catch((err) => errorFor(message, String(err?.message ?? err)))
    .finally(() => pending.delete(p));
  pending.add(p);
});
rl.on('close', async () => {
  await Promise.allSettled([...pending]);
  closed = true;
  // Ends the server's session, when it keeps one.
  if (session)
    await fetch(url, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(2000) }).catch(
      () => {},
    );
  process.exit(0);
});
