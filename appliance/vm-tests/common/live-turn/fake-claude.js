#!/usr/bin/env node
// A stand-in for Claude Code in VM tests (runtime-live-turn, NX-75): the runner installs nothing of a real provider
// there, so the manager's install root gets this file instead. Hermes runs it as its model client (Claude DirectSDK,
// NX-486), and it speaks just enough of Claude Code's stream-JSON for one turn (Whombat
// packages/hermes-whombat/tests/native_directsdk.py, reduced): answers the `initialize` control request, and on the user
// message streams an answer whose text is what it saw of the place it runs in, as the assistant message, `message_stop`
// and one `result`. Hermes answers with it, and the runner posts that as the agent's reply. No network, no model.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const readline = require('node:readline');

const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return `ERR:${e.code}`;
  }
};
const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch (e) {
    return e.code;
  }
};

// Where this process runs: its pid namespace and pid 1 (bubblewrap's init in a fresh procfs), who it is, what it sees.
function evidence() {
  const status = read('/proc/self/status');
  return {
    pid: process.pid,
    nspid: (/^NSpid:\s*(.*)$/m.exec(status)?.[1] ?? '').trim(),
    pidns: (() => {
      try {
        return fs.readlinkSync('/proc/self/ns/pid');
      } catch (e) {
        return `ERR:${e.code}`;
      }
    })(),
    pid1: read('/proc/1/cmdline').split('\0').filter(Boolean).slice(0, 2).join(' '),
    procs: fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).length,
    uid: process.getuid(),
    host: os.hostname(),
    cgroup: read('/proc/self/cgroup').trim(),
    seccomp: (/^Seccomp:\s*(\d+)$/m.exec(status)?.[1] ?? '').trim(),
    nnp: (/^NoNewPrivs:\s*(\d+)$/m.exec(status)?.[1] ?? '').trim(),
    whombatHome: exists('/persist/whombat/home'),
    secrets: exists('/persist/secrets'),
    runWhombat: exists('/run/whombat'),
  };
}

// A direct connection to control's port on the test network (the runner's tasks have no route out: only loopback).
function probeNet(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 3000 });
    const done = (r) => {
      s.destroy();
      resolve(r);
    };
    s.on('connect', () => done('connected'));
    s.on('timeout', () => done('timeout'));
    s.on('error', (e) => done(e.code));
  });
}

if (process.argv.includes('--version')) {
  out('0.0.0-fake (Claude Code)');
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });
let pending = Promise.resolve();
rl.on('line', (line) => {
  pending = pending.then(() => handle(line));
});
rl.on('close', () => pending.then(() => process.exit(0)));

async function handle(line) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === 'control_request' && m.request?.subtype === 'initialize') {
    out({
      type: 'control_response',
      response: { subtype: 'success', request_id: m.request_id, response: { commands: [], models: [] } },
    });
  } else if (m.type === 'user' && m.shouldQuery === false) {
    // History Hermes replays into the session: nothing to answer.
    out({ type: 'result', num_turns: 0, is_error: false });
  } else if (m.type === 'user') {
    const e = evidence();
    e.net = await probeNet(process.env.FAKE_CLAUDE_PROBE_HOST || '192.168.1.1', 4600);
    const text = `FAKE-CLAUDE-OK ${JSON.stringify(e)}`;
    out({ type: 'system', subtype: 'init', session_id: 'fake-1' });
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    out({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }], id: 'msg_fake', model: 'sonnet', stop_reason: 'end_turn' },
    });
    out({ type: 'stream_event', event: { type: 'message_stop' } });
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      result: text,
      session_id: 'fake-1',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      total_cost_usd: 0,
      modelUsage: { sonnet: { costBasis: 'list' } },
    });
  }
}
