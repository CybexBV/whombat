// Resolved alerts for GET /alerts?state=resolved (the fixtures only have open
// ones). Relative to the fixture's as_of; newest resolution first.

import type { Alert } from '../../src/api/types.ts';
import { iso } from './state.ts';

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

interface Seed {
  id: string;
  server: string;
  severity: Alert['severity'];
  title: string;
  detail: string;
  rule: string;
  /** Opened this long before as_of. */
  ago: number;
  /** Open for this long. */
  open: number;
}

const SEEDS: Seed[] = [
  { id: 'al_r06', server: 'granite', severity: 'warning', title: 'sdb temperature at 52 °C', detail: 'Above 50 °C for 22 min', rule: 'disk.temp_high', ago: 1 * D + 3 * H, open: 41 * MIN },
  { id: 'al_r05', server: 'flint', severity: 'critical', title: 'Agent unreachable', detail: 'No heartbeat for 6 min', rule: 'agent.heartbeat_missing', ago: 2 * D + 5 * H, open: 6 * MIN },
  { id: 'al_r04', server: 'obsidian', severity: 'warning', title: 'CPU package at 84 °C', detail: 'Above 80 °C for 11 min', rule: 'sensor.temp_high', ago: 3 * D + 9 * H, open: 27 * MIN },
  { id: 'al_r03', server: 'quartz', severity: 'warning', title: 'nvme0n1 temperature at 71 °C', detail: 'Above 70 °C for 9 min', rule: 'disk.temp_high', ago: 4 * D + 2 * H, open: 18 * MIN },
  { id: 'al_r02', server: 'onyx', severity: 'critical', title: 'Agent unreachable', detail: 'No heartbeat for 14 min', rule: 'agent.heartbeat_missing', ago: 5 * D + 7 * H, open: 14 * MIN },
  { id: 'al_r01', server: 'shale', severity: 'warning', title: 'CPU package at 82 °C', detail: 'Above 80 °C for 16 min', rule: 'sensor.temp_high', ago: 6 * D + 4 * H, open: 52 * MIN },
];

export function resolvedAlerts(asOf: string): Alert[] {
  const t = Date.parse(asOf);
  return SEEDS.map((s) => ({
    id: s.id,
    server: s.server,
    severity: s.severity,
    title: s.title,
    detail: s.detail,
    opened_at: iso(t - s.ago),
    rule: s.rule,
    resolved_at: iso(t - s.ago + s.open),
    state: 'resolved' as const,
  })).sort((a, b) => Date.parse(b.resolved_at) - Date.parse(a.resolved_at));
}
