/**
 * Spend in the mock world (Whombat spend.md SP-01, SP-02): 30 days of Dusty's finished turns, with plausible usage (no
 * mock exists for the Spend tab), summed with core's own arithmetic. Some turns ran on a provider that reports tokens but no cost (the help widget's); two scheduled turns
 * reported nothing. The invoice-PDF plan is the only plan.
 */
import {
  type SpendAgentWeek,
  type SpendOverview,
  type SpendUsage,
  type SpendWindows,
  spendTokens,
  spendWindowsFrom,
} from '@whombat/core/domain';
import { mara } from './principals.js';
import { SEED_NOW, SEED_TIME_ZONE } from './time.js';
import { plan } from './work.js';

export interface FixtureTurn {
  /** Mara's turn, or null for one outsiders started (the help widget) or a schedule's. */
  forId: string | null;
  finishedAt: string;
  usage: SpendUsage | null;
  /** The plan the turn worked on, when it did. */
  planId: string | null;
}

const HOUR = 3_600_000;

/**
 * `count` turns, one every `everyHours` back from the seed's now (starting `offsetHours` ago), each using about
 * `input` / `output` tokens (varied deterministically) and costing `usdPerMTok` per million tokens when set.
 */
function turns(
  count: number,
  everyHours: number,
  offsetHours: number,
  input: number,
  output: number,
  usdPerMTok: number | null,
  forIds: readonly (string | null)[],
  planId: string | null = null,
): FixtureTurn[] {
  return Array.from({ length: count }, (_, i) => {
    const vary = 0.6 + ((i * 37) % 81) / 100;
    const inputTokens = Math.round(input * vary);
    const outputTokens = Math.round(output * vary);
    const usage: SpendUsage =
      usdPerMTok === null
        ? { inputTokens, outputTokens }
        : {
            inputTokens,
            outputTokens,
            costUsd: Math.round(((inputTokens + outputTokens) / 1_000_000) * usdPerMTok * 10_000) / 10_000,
          };
    return {
      forId: forIds[i % forIds.length] ?? null,
      finishedAt: new Date(SEED_NOW.getTime() - (offsetHours + i * everyHours) * HOUR).toISOString(),
      usage,
      planId,
    };
  });
}

/** Dusty's last 30 days of turns: the PDF work, research and answers, the help widget and the nightly schedule. */
export const SPEND_TURNS: readonly FixtureTurn[] = [
  ...turns(42, 16, 1, 58_000, 7_400, 4.2, [mara.id], plan.id),
  ...turns(11, 60, 5, 44_000, 6_100, 4.2, [mara.id], plan.id),
  ...turns(30, 23, 3, 22_000, 2_100, 4.2, [mara.id]),
  ...turns(64, 11, 0.5, 5_200, 800, null, [null]),
  ...turns(28, 24, 4, 7_800, 900, 4.2, [null]),
  // Two scheduled turns whose provider reported no usage.
  {
    forId: null,
    finishedAt: new Date(SEED_NOW.getTime() - 50 * HOUR).toISOString(),
    usage: null,
    planId: null,
  },
  {
    forId: null,
    finishedAt: new Date(SEED_NOW.getTime() - 300 * HOUR).toISOString(),
    usage: null,
    planId: null,
  },
];

const now = SEED_NOW.toISOString();
const windowsOf = (rows: readonly FixtureTurn[]): SpendWindows => spendWindowsFrom(rows, now, SEED_TIME_ZONE);

/** `spend.overview`: every turn of Dusty's. */
export function spendOverview(rows: readonly FixtureTurn[] = SPEND_TURNS): SpendOverview {
  const planTurns = windowsOf(rows.filter((t) => t.planId === plan.id)).month;
  return {
    generatedAt: now,
    timeZone: SEED_TIME_ZONE,
    totals: windowsOf(rows),
    plans:
      planTurns.turns > 0 ? [{ planId: plan.id, title: plan.title, usedTokens: spendTokens(planTurns) }] : [],
  };
}

/** `spend.week`: the agent's turns of the last 7 days. */
export function spendWeek(rows: readonly FixtureTurn[] = SPEND_TURNS): SpendAgentWeek {
  return { week: windowsOf(rows).week };
}

/** Every Spend endpoint the fixture fetch serves. */
export const SPEND_ENDPOINT_IDS = ['spend.overview', 'spend.week'] as const;
