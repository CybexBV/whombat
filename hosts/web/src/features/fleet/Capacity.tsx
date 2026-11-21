// Capacity (UI v2, was Hypervisors F7): one row per online KVM host with
// vCPU allocated against threads (meter spans 0 to 2 : 1, tick at 1 : 1) and
// guest memory assigned against host RAM. Rows open the host's
// Virtualization tab.

import { Link } from 'react-router';
import type { FleetServer, Range, Stack } from '../../api/types';
import { Meter } from '../../components/controls';
import { DASH, formatRatio } from '../../lib/format';
import { t } from '../../lib/i18n';
import { levelBar, memoryAssignedLevel, overcommitLevel, VCPU_TICK_PCT, vcpuMeterWidth } from '../../lib/thresholds';
import { hostPath } from '../../lib/urlState';

export const STACK_LABEL: Record<Stack, string> = { incus: 'Incus', libvirt: 'libvirt', proxmox: 'Proxmox VE' };

export function Capacity({ servers, range }: { servers: FleetServer[]; range: Range }) {
  const rows = servers.filter((s) => s.hypervisor && (s.hypervisor.vms + s.hypervisor.containers > 0 || s.hypervisor.vcpu_allocated > 0));
  if (!rows.length) return null;
  return (
    <section className="section" aria-labelledby="cap-title">
      <div className="section-head">
        <h2 className="h2" id="cap-title">
          {t('Capacity')}
        </h2>
        <span className="lbl">{t('Running guests against physical capacity · the vCPU bar spans 0 to 2 : 1, the tick marks 1 : 1')}</span>
      </div>
      <div className="card" role="table" aria-labelledby="cap-title">
        <div className="cap-row thead" role="row">
          <span className="lbl" role="columnheader">
            {t('Host')}
          </span>
          <span className="lbl" role="columnheader">
            {t('vCPU allocated')}
          </span>
          <span className="lbl" role="columnheader">
            {t('Memory assigned')}
          </span>
        </div>
        {rows.map((s) => {
          const h = s.hypervisor!;
          const ratio = h.host_threads ? h.vcpu_allocated / h.host_threads : h.vcpu_overcommit_ratio;
          const memPct = s.memory_total_gb ? (h.guest_memory_assigned_gb / s.memory_total_gb) * 100 : h.guest_memory_assigned_pct;
          const vcpuLevel = overcommitLevel(ratio);
          const memLevel = memoryAssignedLevel(memPct);
          return (
            <div className="cap-row" role="row" key={s.id}>
              <span className="host" role="rowheader">
                <Link to={hostPath(s.id, { tab: 'virtualization', range })}>{s.id}</Link>
                <small>{h.stacks.map((k) => STACK_LABEL[k]).join(' · ')}</small>
              </span>
              <div role="cell">
                <div className="v">
                  <b>
                    {h.vcpu_allocated} / {h.host_threads} <span>{t('threads')} · {formatRatio(ratio)}</span>
                  </b>
                  {vcpuLevel === 'warning' && <span className="sr-only">({t('overcommitted')})</span>}
                </div>
                <Meter pct={vcpuMeterWidth(ratio)} color={levelBar(vcpuLevel)} tick={VCPU_TICK_PCT} />
              </div>
              <div role="cell">
                <div className="v">
                  <b>
                    {Math.round(h.guest_memory_assigned_gb)} / {s.memory_total_gb == null ? DASH : Math.round(s.memory_total_gb)} GB <span>· {Math.round(memPct)}%</span>
                  </b>
                  {memLevel !== 'good' && <span className="sr-only">({t('high')})</span>}
                </div>
                <Meter pct={memPct} color={levelBar(memLevel, 'var(--series-memory)')} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
