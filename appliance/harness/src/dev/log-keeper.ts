/**
 * Runs a service with its output in a bounded log (IN-41; control CL-38: request logs are kept at most 14 days).
 * The current file is `<file>`; at the first line of a new UTC day, or when it passes `--max-bytes`, it is renamed to
 * `<file>.<YYYY-MM-DDTHHMMSS>` and a new one begins. Rotated files older than `--days` are deleted, and the oldest
 * go first while all of them together pass `--max-total`. The keeper forwards SIGTERM/SIGINT to the service, drains
 * its output and exits with its exit code, so `stopGroup` and `dev/logs` work as for any other service.
 *
 *   node log-keeper.ts --file <log> [--days 14] [--max-bytes 64MiB] [--max-total 512MiB] -- <cmd> [args…]
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const MiB = 1024 * 1024;

export interface KeeperOptions {
  file: string;
  days: number;
  maxBytes: number;
  maxTotal: number;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Deletes rotated copies of `file` older than `days`, then the oldest while their total passes `maxTotal`. */
export function prune(o: KeeperOptions, now = Date.now()): string[] {
  const dir = dirname(o.file);
  const prefix = `${basename(o.file)}.`;
  if (!existsSync(dir)) return [];
  const rotated = readdirSync(dir)
    .filter((n) => n.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}T\d{6}(-\d+)?$/.test(n.slice(prefix.length)))
    .map((n) => ({ path: join(dir, n), st: statSync(join(dir, n)) }))
    .sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
  const removed: string[] = [];
  let total = rotated.reduce((s, r) => s + r.st.size, 0);
  for (const r of rotated) {
    if (now - r.st.mtimeMs > o.days * 86_400_000 || total > o.maxTotal) {
      unlinkSync(r.path);
      total -= r.st.size;
      removed.push(r.path);
    }
  }
  return removed;
}

/** A log file that rotates by day and size (see the module comment). */
export class BoundedLog {
  private fd: number;
  private size: number;
  private opened: string;
  private readonly o: KeeperOptions;
  private readonly now: () => number;
  constructor(o: KeeperOptions, now: () => number = Date.now) {
    this.o = o;
    this.now = now;
    this.fd = openSync(o.file, 'a');
    const st = statSync(o.file);
    this.size = st.size;
    // A file left from an earlier day rotates at the first write.
    this.opened = day(st.size > 0 ? st.mtimeMs : this.now());
    prune(o, this.now());
  }

  write(chunk: Buffer): void {
    const today = day(this.now());
    if (this.size > 0 && (today !== this.opened || this.size + chunk.length > this.o.maxBytes)) this.rotate();
    this.opened = today;
    writeSync(this.fd, chunk);
    this.size += chunk.length;
  }

  private rotate(): void {
    closeSync(this.fd);
    const stamp = new Date(this.now()).toISOString().replace(/[:]/g, '').replace(/\..*$/, '');
    let target = `${this.o.file}.${stamp}`;
    for (let i = 1; existsSync(target); i++) target = `${this.o.file}.${stamp}-${i}`;
    renameSync(this.o.file, target);
    this.fd = openSync(this.o.file, 'a');
    this.size = 0;
    prune(this.o, this.now());
  }

  close(): void {
    closeSync(this.fd);
  }
}

function size(v: string): number {
  const m = /^(\d+)(KiB|MiB|GiB)?$/.exec(v);
  if (!m) throw new Error(`bad size ${v}`);
  return Number(m[1]) * ({ KiB: 1024, MiB, GiB: 1024 * MiB }[m[2] ?? ''] ?? 1);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  if (sep < 0 || sep === argv.length - 1)
    throw new Error('usage: log-keeper.ts --file <log> [...] -- <cmd> [args…]');
  const opts = argv.slice(0, sep);
  const get = (k: string, d: string) => {
    const i = opts.indexOf(k);
    return i >= 0 ? (opts[i + 1] ?? d) : d;
  };
  const o: KeeperOptions = {
    file: get('--file', ''),
    days: Number(get('--days', '14')),
    maxBytes: size(get('--max-bytes', '64MiB')),
    maxTotal: size(get('--max-total', '512MiB')),
  };
  if (!o.file) throw new Error('--file is required');
  const out = new BoundedLog(o);
  const [cmd, ...args] = argv.slice(sep + 1);
  const child = spawn(cmd ?? '', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c: Buffer) => out.write(c));
  child.stderr.on('data', (c: Buffer) => out.write(c));
  for (const s of ['SIGTERM', 'SIGINT'] as const)
    process.on(s, () => {
      child.kill(s);
    });
  child.on('close', (code, signal) => {
    out.close();
    process.exit(code ?? (signal ? 1 : 0));
  });
}
