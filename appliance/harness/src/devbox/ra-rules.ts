/**
 * What `dev/devbox ra-check` (Whombat RA-60) counts, without the client: the scenario names and time budgets, and the
 * small text judgements its checks use (a Dutch answer, a question, the invoice's figures). Pure, so `main.ts` and the
 * unit tests load it without the app's session code.
 */

/** The scenarios, in the order they run (`--only` takes a comma-separated subset). */
export const RA_SCENARIO_NAMES = [
  'learn',
  'schedule',
  'notify',
  'lan',
  'ocr',
  'correction',
  'recovery',
] as const;
export type RaScenarioName = (typeof RA_SCENARIO_NAMES)[number];

/** Minutes one scenario may take (`WB_RA_SCENARIO_MINUTES`, default 15). */
export function scenarioMinutes(env: Record<string, string | undefined> = process.env): number {
  const m = Number(env.WB_RA_SCENARIO_MINUTES ?? '15');
  return Number.isFinite(m) && m >= 1 && m <= 120 ? m : 15;
}

/** The scenarios a run takes: `WB_RA_ONLY` (comma-separated names), else all; an unknown name throws. */
export function selectedScenarios(only: string | undefined): RaScenarioName[] {
  if (!only?.trim()) return [...RA_SCENARIO_NAMES];
  const names = only
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const unknown = names.filter((n) => !(RA_SCENARIO_NAMES as readonly string[]).includes(n));
  if (unknown.length)
    throw new Error(
      `unknown ra-check scenario ${unknown.join(', ')} (one of ${RA_SCENARIO_NAMES.join(', ')})`,
    );
  return RA_SCENARIO_NAMES.filter((n) => names.includes(n));
}

/** The whole run's time limit: every selected scenario's budget plus 20 minutes for setting up and reading back. */
export function raCheckTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return (selectedScenarios(env.WB_RA_ONLY).length * scenarioMinutes(env) + 20) * 60_000;
}

const words = (text: string) => text.toLowerCase().match(/[a-zà-ÿ']+/g) ?? [];

// Function words only one of the two languages uses (“is”, “in”, “a” are left out: both have them).
const DUTCH = new Set(
  'de het een en van op je jij jou u ik wij niet met voor dat die dit deze zijn wordt worden gebruikt standaard poort maar ook naar als bij om te er nog wel kan kun moet heb hebt heeft geen graag dank bedankt altijd nu hier daar uit tot meer zo dus omdat welke wat waar hoe wie mijn jouw uw onze zal zou gaat doen klaar gedaan natuurlijk vanaf voortaan antwoord antwoorden nederlands tijd herinnering benen'.split(
    ' ',
  ),
);
const ENGLISH = new Set(
  'the and of to it its by default port uses use you your we not with for that this these are be will can from as or but so what which where how who my our done please thanks here there sure answer answers english dutch time reminder legs'.split(
    ' ',
  ),
);

/** How Dutch a reply reads: counts of function words only Dutch or only English has. */
export function dutchScore(text: string): { dutch: number; english: number; isDutch: boolean } {
  let dutch = 0;
  let english = 0;
  for (const w of words(text)) {
    if (DUTCH.has(w)) dutch++;
    else if (ENGLISH.has(w)) english++;
  }
  return { dutch, english, isDutch: dutch >= 2 && dutch > english };
}

/** The questions in a message: sentences ending in a question mark, outside code. */
export function questionsIn(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, 'x');
  return prose
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 3 && x.endsWith('?'));
}

/** What a reply says of the invoice “INVOICE 4711 … Total € 99,50”. */
export function invoiceFigures(text: string): { number: boolean; total: boolean } {
  return { number: /\b4711\b/.test(text), total: /\b99[,.]50\b/.test(text) };
}

/** A reply cut to `max` characters on one line, for the result file. */
export function short(text: string, max = 300): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * The prompt cache's share of a spend window (Whombat prompt-efficiency.md PE-04, PE-12): `cacheReadTokens` and
 * `cacheWriteTokens` are parts of `inputTokens` (contracts 0.44.1), `cacheResults` counts the resumed turns whose cache
 * was hit, had expired or missed (the server's own addition). Absent until a turn in the window reported them.
 */
export interface SpendCache {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheResults?: { hit: number; expired: number; miss: number };
}

/** One window's totals: turns and tokens, with the cache split when the box's runtime reports one. */
export type SpendCounts = { turns: number; inputTokens: number; outputTokens: number } & SpendCache;

/** Totals of `spend.overview`'s week window as one snapshot (one agent, so no per-agent rows: OA-19). */
export type SpendSnapshot = SpendCounts & { costUsd: number | null };

/** The cache fields of a window, picked from `spend.overview`'s totals (absent ones left out). */
export function spendCache(t: SpendCache): SpendCache {
  return {
    ...(t.cacheReadTokens === undefined ? {} : { cacheReadTokens: t.cacheReadTokens }),
    ...(t.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: t.cacheWriteTokens }),
    ...(t.cacheResults
      ? {
          cacheResults: {
            hit: t.cacheResults.hit ?? 0,
            expired: t.cacheResults.expired ?? 0,
            miss: t.cacheResults.miss ?? 0,
          },
        }
      : {}),
  };
}

/**
 * What the cache did between two windows: once `after` reports a split, the reads and writes added (a window that had
 * none yet counts 0) and the input that came from neither (`uncachedInputTokens`); the cache results likewise.
 */
function cacheDelta(before: SpendCounts, after: SpendCounts, inputTokens: number) {
  const read =
    after.cacheReadTokens === undefined ? undefined : after.cacheReadTokens - (before.cacheReadTokens ?? 0);
  const write =
    after.cacheWriteTokens === undefined
      ? undefined
      : after.cacheWriteTokens - (before.cacheWriteTokens ?? 0);
  const r0 = before.cacheResults ?? { hit: 0, expired: 0, miss: 0 };
  return {
    ...(read === undefined ? {} : { cacheReadTokens: read }),
    ...(write === undefined ? {} : { cacheWriteTokens: write }),
    ...(read === undefined && write === undefined
      ? {}
      : { uncachedInputTokens: inputTokens - (read ?? 0) - (write ?? 0) }),
    ...(after.cacheResults
      ? {
          cacheResults: {
            hit: after.cacheResults.hit - r0.hit,
            expired: after.cacheResults.expired - r0.expired,
            miss: after.cacheResults.miss - r0.miss,
          },
        }
      : {}),
  };
}

/** What a scenario used: the difference of two snapshots. */
export function spendDelta(before: SpendSnapshot, after: SpendSnapshot) {
  const inputTokens = after.inputTokens - before.inputTokens;
  return {
    turns: after.turns - before.turns,
    inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    ...cacheDelta(before, after, inputTokens),
    costUsd: after.costUsd === null ? null : Math.round((after.costUsd - (before.costUsd ?? 0)) * 1e6) / 1e6,
  };
}
