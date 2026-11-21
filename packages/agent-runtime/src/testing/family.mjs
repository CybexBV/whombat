// Test helper process: starts a child in its own process group and one that escapes with setsid,
// prints `{"pid":…,"child":…,"escaped":…}` and then idles, ignoring SIGTERM when asked to, so tests
// can check that killProcessTree leaves nothing behind.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const stubborn = process.argv.includes('--stubborn');
const idle = ['-e', `${stubborn ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000);`];
const child = spawn(process.execPath, idle, { stdio: 'ignore' });
const escaped = spawn(process.execPath, idle, { stdio: 'ignore', detached: true });
escaped.unref();
if (stubborn) process.on('SIGTERM', () => {});
const info = JSON.stringify({ pid: process.pid, child: child.pid, escaped: escaped.pid });
const out = process.env.FAMILY_PIDS_FILE;
if (out) writeFileSync(out, info);
process.stdout.write(`${info}\n`);
setInterval(() => {}, 1000);
