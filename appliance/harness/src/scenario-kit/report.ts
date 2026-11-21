/**
 * What scenarios record besides pass/fail (IN-13): blocked reasons, measurements and evidence notes, as JSON lines
 * in `$WB_SCENARIO_RECORD` (the validation run's report directory). A blocked scenario is skipped by vitest and
 * appears as `blocked: <component>/<feature>` in the report — never as passed.
 */
import { appendFileSync } from 'node:fs';

export interface Recorded {
  kind: 'blocked' | 'measure' | 'note' | 'gap';
  test: string;
  at: string;
  [k: string]: unknown;
}

function write(entry: Omit<Recorded, 'at'>): void {
  const file = process.env.WB_SCENARIO_RECORD;
  const line = JSON.stringify({ ...entry, at: new Date().toISOString() });
  if (file) appendFileSync(file, `${line}\n`);
  else process.stderr.write(`[scenario] ${line}\n`);
}

interface Ctx {
  task: { name: string; suite?: { name: string } };
  skip: (note?: string) => void;
}

const nameOf = (ctx: Ctx) =>
  ctx.task.suite?.name ? `${ctx.task.suite.name} > ${ctx.task.name}` : ctx.task.name;

/** Marks the running test blocked by a missing feature in another component and skips it. */
export function blocked(ctx: Ctx, gap: string, detail: string): never {
  write({ kind: 'blocked', test: nameOf(ctx), gap, detail });
  ctx.skip(`blocked: ${gap}`);
  throw new Error('unreachable');
}

export function measure(ctx: Ctx, name: string, values: Record<string, unknown>): void {
  write({ kind: 'measure', test: nameOf(ctx), name, ...values });
}

export function note(ctx: Ctx, text: string, extra: Record<string, unknown> = {}): void {
  write({ kind: 'note', test: nameOf(ctx), text, ...extra });
}

/** A defect found in another component (the test still fails or passes on its own merits). */
export function gap(ctx: Ctx, component: string, text: string): void {
  write({ kind: 'gap', test: nameOf(ctx), component, text });
}

export function percentiles(samples: number[]): {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
} {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) =>
    s.length ? (s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0) : 0;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    n: s.length,
    p50: round(q(50)),
    p95: round(q(95)),
    p99: round(q(99)),
    max: round(s[s.length - 1] ?? 0),
    mean: round(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
  };
}
