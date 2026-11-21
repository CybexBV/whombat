#!/usr/bin/env node
// A stand-in for `hermes` in a pod's tests (hermes-native.md HN-W01, HN-W02): `gateway run` stays up until it is
// stopped and notes its pid in `$FAKE_POD_DIR/gateway.pids`; `acp` answers each line it reads with what it knows (its
// pid, its working directory, a variable of the pod's environment) and ends with its stdin; a line `{"probe":[paths]}`
// is answered with what it sees at each path (whether it is there, and what a directory holds); a line
// `{"run":{"argv":[…],"session":"…"}}` runs the argv as Hermes's terminal environment would (one-person.md OP-07: the
// commands' launcher, `WHOMBAT_COMMANDS_NODE` + `WHOMBAT_COMMANDS_LAUNCHER`, naming the session) and answers
// `{"ran":{"code","stdout","stderr"}}`.
import { spawn } from 'node:child_process';
import { appendFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [mode] = process.argv.slice(2);
const dir = process.env.FAKE_POD_DIR;

if (mode === 'gateway') {
  if (dir) appendFileSync(join(dir, 'gateway.pids'), `${process.pid}\n`);
  process.stderr.write(`gateway up ${process.pid}\n`);
  process.on('SIGTERM', () => process.exit(0));
  // Its stdin is pod-init's pipe: gone with pod-init (a test that kills it never leaves this one running).
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
} else if (mode === 'acp') {
  process.on('SIGTERM', () => process.exit(0));
  const lines = createInterface({ input: process.stdin });
  const look = (path) => {
    try {
      const st = statSync(path);
      return { exists: true, entries: st.isDirectory() ? readdirSync(path).sort() : null };
    } catch (err) {
      return { exists: false, error: err.code ?? String(err) };
    }
  };
  const run = ({ argv, session }) => {
    const child = spawn(process.env.WHOMBAT_COMMANDS_NODE, [process.env.WHOMBAT_COMMANDS_LAUNCHER, ...argv], {
      env: { ...process.env, ...(session ? { WHOMBAT_TURN_SESSION: session } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) =>
      process.stdout.write(`${JSON.stringify({ ran: { code: -1, stdout, stderr: String(err) } })}\n`),
    );
    child.on('close', (code) =>
      process.stdout.write(`${JSON.stringify({ ran: { code, stdout, stderr } })}\n`),
    );
  };
  lines.on('line', (line) => {
    let probe = null;
    let command = null;
    try {
      const parsed = JSON.parse(line);
      probe = parsed.probe ?? null;
      command = parsed.run ?? null;
    } catch {}
    if (command) {
      run(command);
      return;
    }
    if (Array.isArray(probe)) {
      process.stdout.write(
        `${JSON.stringify({ probe: Object.fromEntries(probe.map((p) => [p, look(p)])) })}\n`,
      );
      return;
    }
    process.stdout.write(
      `${JSON.stringify({
        echo: line,
        pid: process.pid,
        cwd: process.cwd(),
        pod: process.env.FAKE_POD_MARK ?? null,
        token: process.env.WHOMBAT_MCP_TOKEN ?? null,
      })}\n`,
    );
  });
  lines.on('close', () => process.exit(0));
} else {
  process.stderr.write(`fake hermes: unknown mode ${mode}\n`);
  process.exit(2);
}
