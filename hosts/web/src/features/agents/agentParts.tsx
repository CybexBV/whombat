// Pieces shared by the agents list and a server's settings page.

import type { ReactNode } from 'react';
import type { AgentInfo, CollectorStatus } from '../../api/types';
import { Chip, Dot } from '../../components/controls';
import { Icon } from '../../components/Icon';
import { useNow } from '../../lib/clock';
import { formatAgoIso, formatFull } from '../../lib/format';
import { t, tx } from '../../lib/i18n';

/** Clock skew from which the agent is flagged (NTP problem on the host). */
export const SKEW_WARN_S = 2;

export function AgentStatus({ a }: { a: Pick<AgentInfo, 'connected' | 'last_seen'> }) {
  const now = useNow();
  if (a.connected) {
    return (
      <span className="state">
        <Dot color="var(--good)" />
        {t('Connected')}
      </span>
    );
  }
  if (!a.last_seen) {
    return (
      <span className="state">
        <Dot color="var(--muted)" />
        {t('Never connected')}
      </span>
    );
  }
  return (
    <span className="state">
      <Dot color="var(--critical)" />
      <span>
        {tx('Last seen {time}', {
          time: (
            <time dateTime={a.last_seen} title={formatFull(Date.parse(a.last_seen))}>
              {formatAgoIso(a.last_seen, now)}
            </time>
          ),
        })}
      </span>
    </span>
  );
}

export function Warn({ children }: { children: ReactNode }) {
  return (
    <div className="warn-line">
      <span className="warn-ic" aria-hidden="true">
        <Icon name="warning" size={16} />
      </span>
      <span>{children}</span>
    </div>
  );
}

/** "Clock off by 4.8 s (ahead of the hub)." or null while within SKEW_WARN_S. */
export function skewWarning(skew: number | null | undefined): string | null {
  if (skew == null || Math.abs(skew) < SKEW_WARN_S) return null;
  const s = Math.abs(skew).toFixed(1);
  return skew > 0 ? t('Clock off by {s} s (ahead of the hub).', { s }) : t('Clock off by {s} s (behind the hub).', { s });
}

/** Failing collectors first, with their error; then the ones that report. */
export function CollectorChips({ serverId, collectors }: { serverId: string; collectors: CollectorStatus[] }) {
  const failing = collectors.filter((c) => !c.ok);
  const ok = collectors.filter((c) => c.ok);
  return (
    <ul className="collector-list" aria-label={failing.length ? t('Collectors on {id}, {n} not reporting', { id: serverId, n: failing.length }) : t('Collectors on {id}, all reporting', { id: serverId })}>
      {failing.map((c) => (
        <li key={c.name}>
          <Chip dot="var(--warning)" className="chip-sm chip-wrap">
            <span>
              <span className="ink">{c.name}</span>: {c.error || t('not reporting')}
            </span>
          </Chip>
        </li>
      ))}
      {ok.map((c) => (
        <li key={c.name}>
          <Chip className="chip-sm" title={t('{name}: reporting', { name: c.name })}>
            {c.name}
          </Chip>
        </li>
      ))}
    </ul>
  );
}
