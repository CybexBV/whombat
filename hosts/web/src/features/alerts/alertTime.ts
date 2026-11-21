// Relative time of an alert row: "since 02:14" for an agent that went silent
// (its start time), else "14 min ago".

import type { Alert } from '../../api/types';
import { formatAgoIso, formatSince } from '../../lib/format';

export function alertWhen(a: Alert, now: number): string {
  const t = Date.parse(a.opened_at);
  if (a.rule === 'agent.heartbeat_missing') return formatSince(t, now);
  return formatAgoIso(a.opened_at, now);
}
