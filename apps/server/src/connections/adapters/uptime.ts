import { connectionRow } from '../store';
import { readUptimeCheck, uptimeState } from '../uptime';
import type { Adapter } from './types';

export const UPTIME_ADAPTER: Adapter = {
  async uptime_status({ call }) {
    if (!call) throw new Error('Missing connection call context.');
    const row = await connectionRow(call.services.db, call.connectionId);
    if (!row || row.burrowId !== call.burrowId) throw new Error('Connection is missing.');
    const check = await readUptimeCheck(call.services, row);
    const status = uptimeState(check, row.fields.kind === 'heartbeat');
    const structured = {
      status,
      since: check?.since ?? null,
      checkedAt: check?.last?.at ?? null,
      latencyMs: check?.status === 'up' && !check.stale ? (check.last?.latencyMs ?? null) : null,
      certificateEndsAt: check?.last?.certNotAfter ?? null,
    };
    const content = JSON.stringify(structured);
    return { content, structured, bytes: Buffer.byteLength(content), isError: false, truncated: false };
  },
};
