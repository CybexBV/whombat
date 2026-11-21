/**
 * Looking for a canary secret where it must never be (Whombat vault.md VT-80): in strings the scenario captured, in
 * the environment's log files, and in a command's output streamed without keeping it (a database dump). Needles come
 * from `plaintextNeedles` (UTF-8, UTF-16, base64 and base64url at every alignment, hex); a hit names where and which
 * encoding, never the value, so a report can carry it.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type Needles = [label: string, bytes: Buffer][];

/** `where: label` for every needle in `haystack`. */
export function needleHits(where: string, haystack: string | Buffer, needles: Needles): string[] {
  const buf = typeof haystack === 'string' ? Buffer.from(haystack, 'utf8') : haystack;
  return needles.filter(([, n]) => buf.includes(n)).map(([label]) => `${where}: ${label}`);
}

/** Every regular file directly in `dir` (the harness's `env/logs`, rotated files included). */
export function scanDir(dir: string, needles: Needles): { hits: string[]; files: number; bytes: number } {
  if (!existsSync(dir)) return { hits: [], files: 0, bytes: 0 };
  const hits: string[] = [];
  let files = 0;
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (!statSync(file).isFile()) continue;
    const content = readFileSync(file);
    files++;
    bytes += content.length;
    hits.push(...needleHits(name, content, needles));
  }
  return { hits, files, bytes };
}

/**
 * Runs `cmd` and looks for the needles in its stdout as it streams (chunks overlap by the longest needle, so a value
 * split between two chunks is still found); nothing is kept.
 */
export function scanCommand(
  where: string,
  cmd: string,
  args: readonly string[],
  needles: Needles,
  timeoutMs = 300_000,
): Promise<{ hits: string[]; bytes: number; code: number | null; stderr: string }> {
  const keep = Math.max(0, ...needles.map(([, n]) => n.length)) - 1;
  const found = new Set<string>();
  let tail = Buffer.alloc(0);
  let bytes = 0;
  let stderr = '';
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      const window = Buffer.concat([tail, chunk]);
      for (const hit of needleHits(where, window, needles)) found.add(hit);
      tail = keep > 0 ? window.subarray(Math.max(0, window.length - keep)) : Buffer.alloc(0);
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4_000) stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ hits: [...found], bytes, code, stderr });
    });
  });
}
