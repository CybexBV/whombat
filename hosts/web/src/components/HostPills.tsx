// One pill per host in the top bar (status dot + name; the open host raised).
// Past MAX_PILLS hosts, or on narrow screens, the pills collapse into a
// "Hosts" menu button next to the current host's pill. Below 760 px the
// shell shows the hosts sheet instead (see AppShell).

import { useId } from 'react';
import { Link, useMatch } from 'react-router';
import { useServers } from '../api/queries';
import type { ServerListItem } from '../api/types';
import { t } from '../lib/i18n';
import { STATUS_DOT, STATUS_LABEL } from '../lib/thresholds';
import { hostPath, useRange } from '../lib/urlState';
import { Dot } from './controls';
import { Icon } from './Icon';
import { usePopover } from './popover';

export const MAX_PILLS = 8;

/** "Online", "Disk wear", "CPU temperature", "Offline". */
export function serverStatusText(s: Pick<ServerListItem, 'status' | 'status_note'>): string {
  if (s.status === 'offline') return t('Offline');
  if (s.status === 'warning' && s.status_note) return s.status_note.charAt(0).toUpperCase() + s.status_note.slice(1);
  return STATUS_LABEL[s.status];
}

export function useCurrentHost(): string | null {
  return useMatch('/servers/:id/*')?.params.id ?? null;
}

function Pill({ s, current, range, onClick }: { s: ServerListItem; current: boolean; range: ReturnType<typeof useRange>[0]; onClick?: () => void }) {
  return (
    <Link
      to={hostPath(s.id, { range })}
      className={current ? 'host-pill on' : 'host-pill'}
      aria-current={current ? 'page' : undefined}
      aria-label={`${s.id}, ${serverStatusText(s)}`}
      title={serverStatusText(s)}
      onClick={onClick}
    >
      <Dot color={STATUS_DOT[s.status]} />
      <span className="pill-name">{s.id}</span>
    </Link>
  );
}

/** Hosts by group, in list order (one group: no headings). */
export function groupHosts(list: ServerListItem[]): { name: string; items: ServerListItem[] }[] {
  const out: { name: string; items: ServerListItem[] }[] = [];
  for (const s of list) {
    let g = out.find((x) => x.name === s.group);
    if (!g) out.push((g = { name: s.group, items: [] }));
    g.items.push(s);
  }
  return out;
}

export function HostPills() {
  const servers = useServers();
  const current = useCurrentHost();
  const [range] = useRange();
  const pop = usePopover();
  const id = useId();
  const list = servers.data ?? [];
  const collapsed = list.length > MAX_PILLS;
  const cur = list.find((s) => s.id === current);
  const groups = groupHosts(list);

  const menu = (
    <div className="hosts-wrap" ref={pop.root} onBlur={pop.onBlur}>
      {cur && <Pill s={cur} current range={range} />}
      <button
        ref={pop.trigger}
        type="button"
        className="tb-item hosts-more"
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-controls={pop.open ? id : undefined}
        onClick={() => pop.setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && pop.open) {
            e.preventDefault();
            pop.close();
          }
        }}
      >
        {cur ? t('All hosts') : t('Hosts')}
        <Icon name="chevronDown" size={14} />
      </button>
      {pop.open && (
        <div
          id={id}
          className="hosts-menu"
          role="menu"
          aria-label={t('Hosts')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              pop.close();
            }
          }}
        >
          {groups.map((g) => (
            <div key={g.name} role="group" aria-label={g.name}>
              {groups.length > 1 && (
                <div className="grp" aria-hidden="true">
                  {g.name}
                </div>
              )}
              {g.items.map((s) => (
                <Link key={s.id} to={hostPath(s.id, { range })} role="menuitem" className={s.id === current ? 'opt on' : 'opt'} onClick={() => pop.setOpen(false)}>
                  <Dot color={STATUS_DOT[s.status]} />
                  <span className="mono">{s.id}</span>
                  <span className="st">{serverStatusText(s)}</span>
                </Link>
              ))}
            </div>
          ))}
          {list.length === 0 && <div className="palette-note">{servers.isPending ? t('Loading hosts…') : t('No hosts yet.')}</div>}
        </div>
      )}
    </div>
  );

  if (collapsed || list.length === 0) return menu;
  return (
    <div className="hosts" aria-label={t('Hosts')}>
      {list.map((s) => (
        <Pill key={s.id} s={s} current={s.id === current} range={range} />
      ))}
    </div>
  );
}
