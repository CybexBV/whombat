/**
 * Subscription usage in the mock world (contracts CT-153, CT-154; since 3.0 the person's only, CT-1513): Mara on Claude
 * Max, well into her 5-hour window, and on ChatGPT with an API key.
 */
import type { SubscriptionUsage, UsageWindow } from '@whombat/core/domain';
import { SEED_NOW } from './time.js';

const minutes = (n: number) => new Date(SEED_NOW.getTime() + n * 60_000).toISOString();

function window(
  kind: UsageWindow['kind'],
  usedPct: number,
  resetsInMinutes: number,
  status: UsageWindow['status'] = usedPct >= 80 ? 'warning' : 'ok',
): UsageWindow {
  const labels = { five_hour: '5-hour', seven_day: '7-day', seven_day_opus: '7-day Opus' } as const;
  return {
    kind,
    label: labels[kind as keyof typeof labels] ?? 'Usage',
    usedPct,
    resetsAt: minutes(resetsInMinutes),
    status,
    windowMinutes: kind === 'five_hour' ? 300 : 10_080,
  };
}

export const USAGE_SNAPSHOTS: readonly SubscriptionUsage[] = [
  {
    provider: 'claude',
    kind: 'subscription',
    connected: true,
    plan: 'max',
    windows: [
      window('five_hour', 62, 130),
      window('seven_day', 41, 3 * 1440 + 200),
      window('seven_day_opus', 18, 3 * 1440 + 200),
    ],
    observedAt: minutes(-4),
    source: 'turn',
    error: null,
  },
  {
    provider: 'codex',
    kind: 'api_key',
    connected: true,
    plan: null,
    windows: [],
    observedAt: minutes(-50),
    source: 'probe',
    error: null,
  },
];

/** `usage.list`: Mara's sign-ins. */
export function usageList(): { mine: SubscriptionUsage[] } {
  return { mine: [...USAGE_SNAPSHOTS] };
}

/** `usage.refresh`: Mara's snapshot for `provider`, read now; null when she has no sign-in for it. */
export function usageRefresh(provider: string): SubscriptionUsage | null {
  const snap = USAGE_SNAPSHOTS.find((s) => s.provider === provider);
  return snap ? { ...snap, observedAt: SEED_NOW.toISOString(), source: 'probe' } : null;
}

/** Every usage endpoint the fixture fetch serves. */
export const USAGE_ENDPOINT_IDS = ['usage.list', 'usage.refresh'] as const;
