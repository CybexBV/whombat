// Tabs of a host page (UI v2), sticky under the top bar: Summary, Guests,
// Storage, Sensors, Virtualization and (admins) Agent. The tab is the `tab`
// search parameter; the console route implies the Guests tab.

import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import type { Range } from '../../api/types';
import { t } from '../../lib/i18n';
import { type HostTab, hostPath } from '../../lib/urlState';

export interface TabSpec {
  key: HostTab;
  label: string;
  count?: string | number | null;
}

export function HostTabs({ serverId, tabs, active, range }: { serverId: string; tabs: TabSpec[]; active: HostTab; range: Range }) {
  const nav = useRef<HTMLElement>(null);
  // Keep the marked tab visible when the row scrolls sideways (phones).
  useEffect(() => {
    const row = nav.current;
    const link = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !link || row.scrollWidth <= row.clientWidth) return;
    const left = link.offsetLeft - 16;
    const right = link.offsetLeft + link.offsetWidth + 16 - row.clientWidth;
    if (row.scrollLeft > left) row.scrollLeft = left;
    else if (row.scrollLeft < right) row.scrollLeft = right;
  }, [active]);
  return (
    <nav ref={nav} className="host-tabs" aria-label={t('Host sections')}>
      {tabs.map((tab) => (
        <Link key={tab.key} to={hostPath(serverId, { tab: tab.key, range })} aria-current={tab.key === active ? 'page' : undefined}>
          {tab.label}
          {tab.count != null && tab.count !== '' && <span className="c">{tab.count}</span>}
        </Link>
      ))}
    </nav>
  );
}
