/** Successful repository checks at exact commits. Failures, expired receipts and changed inputs never count. */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Component } from '../manifest/pins.ts';
import type { GateResult } from './validate.ts';

const Receipt = z.strictObject({
  version: z.literal(1),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  finishedAt: z.string().datetime(),
  logSha256: z.string().regex(/^[a-f0-9]{64}$/),
  durationMs: z.number().nonnegative(),
  summary: z.string(),
});

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const MAX_AGE_MS = 7 * 86_400_000;
const MAX_ENTRIES = 256;

export function gateKey(
  c: Component,
  gate: Component['gates'][number],
  setup: Record<string, string>,
): string {
  return digest(
    JSON.stringify({
      version: 1,
      repository: c.repository,
      commit: c.commit,
      gate: {
        id: gate.id,
        run: gate.run,
        cwd: gate.cwd,
        timeoutS: gate.timeoutS,
        needsPostgres: gate.needsPostgres,
        env: Object.fromEntries(Object.entries(gate.env).sort()),
      },
      setup: Object.fromEntries(Object.entries(setup).sort()),
    }),
  );
}

export function readGateCache(root: string, key: string, now = Date.now()): z.infer<typeof Receipt> | null {
  try {
    const receipt = Receipt.parse(JSON.parse(readFileSync(join(root, key, 'receipt.json'), 'utf8')));
    const age = now - Date.parse(receipt.finishedAt);
    if (receipt.key !== key || age < 0 || age > MAX_AGE_MS) return null;
    if (digest(readFileSync(join(root, key, 'log'))) !== receipt.logSha256) return null;
    return receipt;
  } catch {
    return null;
  }
}

export function saveGateCache(root: string, key: string, result: GateResult, now = Date.now()): void {
  if (result.outcome !== 'passed' || result.exitCode !== 0) {
    // Fresh negative evidence supersedes an earlier success, including a forced rerun.
    rmSync(join(root, key), { recursive: true, force: true });
    return;
  }
  if (!existsSync(result.log)) return;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const temporary = mkdtempSync(join(root, `${key}.tmp-`));
  try {
    const log = readFileSync(result.log);
    writeFileSync(join(temporary, 'log'), log, { mode: 0o600 });
    writeFileSync(
      join(temporary, 'receipt.json'),
      JSON.stringify(
        Receipt.parse({
          version: 1,
          key,
          finishedAt: new Date(now).toISOString(),
          logSha256: digest(log),
          durationMs: result.durationMs,
          summary: result.summary,
        }),
      ),
      { mode: 0o600 },
    );
    // A previous valid successful result is equivalent; avoid replacing another writer's receipt.
    if (!readGateCache(root, key, now)) {
      rmSync(join(root, key), { recursive: true, force: true });
      renameSync(temporary, join(root, key));
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Receipts belong to this environment's exclusive writer; retain at most a week and 256 successes. */
export function pruneGateCache(root: string, now = Date.now()): void {
  if (!existsSync(root)) return;
  const valid: { key: string; finishedAt: number }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const receipt = readGateCache(root, entry.name, now);
    if (receipt) valid.push({ key: entry.name, finishedAt: Date.parse(receipt.finishedAt) });
    else rmSync(join(root, entry.name), { recursive: true, force: true });
  }
  for (const entry of valid.sort((a, b) => b.finishedAt - a.finishedAt).slice(MAX_ENTRIES))
    rmSync(join(root, entry.key), { recursive: true, force: true });
}

/** Cache compatibility includes the implementation of the gate runner, not its checkout path. */
export function gateRunnerFingerprint(): string {
  return digest(
    Buffer.concat(
      [
        'validate.ts',
        'gate-cache.ts',
        'gate-coverage.ts',
        '../lib/proc.ts',
        '../lib/hash.ts',
        '../dev/postgres.ts',
        '../lib/paths.ts',
      ].map((name) => readFileSync(new URL(name, import.meta.url))),
    ),
  );
}
