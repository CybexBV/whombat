/** `dev/logs [service] [-f] [-n N]` — tails the environment's logs (all services when none is named). */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../lib/paths.ts';

const args = process.argv.slice(2);
const follow = args.includes('-f');
const nIdx = args.indexOf('-n');
const n = nIdx >= 0 ? (args[nIdx + 1] ?? '100') : '100';
const names = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '-n');
if (!existsSync(paths.logs)) {
  console.error('no logs yet (dev/up)');
  process.exit(1);
}
const available = readdirSync(paths.logs).filter((f) => f.endsWith('.log'));
if (names.includes('postgres')) {
  spawn('docker', ['logs', ...(follow ? ['-f'] : []), '--tail', n, 'whombat-mgd-pg'], { stdio: 'inherit' });
} else {
  const files = (names.length ? names.map((x) => `${x}.log`) : available).map((f) => join(paths.logs, f));
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length) {
    console.error(
      `no such log: ${missing.join(', ')}\navailable: ${available.map((f) => f.replace(/\.log$/, '')).join(', ')}`,
    );
    process.exit(1);
  }
  spawn('tail', ['-n', n, ...(follow ? ['-F'] : []), ...files], { stdio: 'inherit' });
}
