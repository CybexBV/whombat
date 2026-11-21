// Virtualization (S7, SCREENS 3.6): capability grid and four allocation cards.
// Allocation numbers are the hub's (ARCHITECTURE 3.3); the UI only formats
// them and applies the thresholds.

import type { Metrics, Stack, Virtualization as V } from '../../api/types';
import { Chip, Dot, Meter } from '../../components/controls';
import { Sparkline } from '../../components/Sparkline';
import { formatNum, formatRatio, netRateParts } from '../../lib/format';
import { t } from '../../lib/i18n';
import { levelBar, memoryAssignedLevel, overcommitLevel, VCPU_TICK_PCT, vcpuMeterWidth } from '../../lib/thresholds';

const STACK_PHRASE: Record<Stack, string> = { incus: 'Incus', libvirt: 'libvirt / QEMU', proxmox: 'Proxmox VE' };

function subline(v: V, proxmox: boolean): string {
  if (proxmox) return t('Proxmox VE · QEMU / KVM guests and LXC containers · reported by the agent and the PVE API');
  const stacks = v.stacks.filter((s) => s !== 'proxmox').map((s) => STACK_PHRASE[s]);
  const kvm = v.capabilities.kvm.enabled ? t('KVM host') : t('Host');
  return stacks.length
    ? t('{host} · {stacks} guests · reported by the agent', { host: kvm, stacks: stacks.reduce((a, b) => t('{a} and {b}', { a, b })) })
    : t('{host} · reported by the agent', { host: kvm });
}

/** Ballooning state ("active", "idle"): capitalized for a value, lower case in a sentence. */
function balloonState(state: string, capital: boolean): string {
  if (state === 'active') return capital ? t('Active') : t('active');
  if (state === 'idle') return capital ? t('Idle') : t('idle');
  return capital ? state.charAt(0).toUpperCase() + state.slice(1) : state;
}

const pageSize = (s: string): string => s.replace(/^(\d+(?:\.\d+)?)\s*([KMGT])$/i, (_m, n: string, u: string) => `${n} ${u.toUpperCase()}B`);
const on = (b: boolean) => (b ? 'var(--good)' : 'var(--muted)');

export function Virtualization({ v, proxmox, metrics }: { v: V; proxmox: boolean; metrics: Metrics | undefined }) {
  const c = v.capabilities;
  const a = v.allocation;
  const caps: { k: string; v: string; s: string | null; dot: string }[] = [
    { k: 'KVM', v: c.kvm.enabled ? t('Enabled') : t('Disabled'), s: [c.kvm.module, c.kvm.device].filter(Boolean).join(' · ') || null, dot: on(c.kvm.enabled) },
    {
      k: t('CPU virtualization'),
      v: c.cpu_virtualization.type ?? t('Not available'),
      s: [c.cpu_virtualization.flag?.toUpperCase(), c.cpu_virtualization.nested_paging ? 'nested paging' : null].filter(Boolean).join(' · ') || null,
      dot: on(!!c.cpu_virtualization.type),
    },
    {
      k: 'IOMMU',
      v: c.iommu.enabled ? t('Enabled') : t('Disabled'),
      s: c.iommu.enabled && c.iommu.groups != null ? t('{groups} groups · {devices} on vfio-pci', { groups: c.iommu.groups, devices: c.iommu.vfio_pci_devices ?? 0 }) : null,
      dot: on(c.iommu.enabled),
    },
    { k: t('Nested virtualization'), v: c.nested.enabled ? t('Enabled') : t('Disabled'), s: c.nested.module_param, dot: on(c.nested.enabled) },
  ];
  if (c.hugepages && !proxmox) {
    caps.push({ k: 'Hugepages', v: t('{size} GB reserved', { size: formatNum(c.hugepages.reserved_gb) }), s: `${c.hugepages.count} × ${pageSize(c.hugepages.page_size)}`, dot: on(c.hugepages.reserved_gb > 0) });
  } else if (c.ballooning) {
    const b = c.ballooning;
    const active = b.state === 'active';
    caps.push({
      k: 'Ballooning',
      v: active && b.vms_active != null && b.vms_total != null ? t('Active on {active} of {total} VMs', { active: b.vms_active, total: b.vms_total }) : balloonState(b.state, true),
      s: 'virtio-balloon',
      dot: on(active),
    });
  }
  if (c.ksm) {
    const showBalloon = !!c.hugepages && !proxmox && c.ballooning;
    caps.push({ k: t('Memory sharing'), v: t('KSM · {size} GB saved', { size: formatNum(c.ksm.saved_gb) }), s: showBalloon ? t('Balloon {state}', { state: balloonState(c.ballooning!.state, false) }) : null, dot: on(c.ksm.saved_gb > 0) });
  }

  const ratio = a.host_threads ? a.vcpu_allocated / a.host_threads : a.vcpu_overcommit_ratio;
  const memPct = a.host_memory_gb ? (a.guest_memory_assigned_gb / a.host_memory_gb) * 100 : 0;
  const vcpuLevel = overcommitLevel(ratio);
  const memLevel = memoryAssignedLevel(memPct);
  const net = a.network_mbps ? netRateParts(a.network_mbps.total) : null;
  const balloon = c.ballooning?.state;

  return (
    <section id="virtualization" tabIndex={-1} className="section" aria-labelledby="virt-title">
      <div className="section-head-2">
        <div>
          <h2 className="h2" id="virt-title">
            {t('Virtualization')}
          </h2>
          <div className="lbl" style={{ marginTop: 4 }}>
            {subline(v, proxmox)}
          </div>
        </div>
        <Chip dot={on(c.kvm.enabled)}>{c.kvm.enabled ? t('KVM enabled') : t('KVM not available')}</Chip>
      </div>
      <div className="card fact-grid">
        {caps.map((f) => (
          <div className="field" key={f.k}>
            <div className="lbl">{f.k}</div>
            <div className="v with-dot">
              <Dot color={f.dot} />
              {f.v}
            </div>
            {f.s && <div className="lbl mono s">{f.s}</div>}
          </div>
        ))}
      </div>
      <div className="alloc-grid">
        <div className="card alloc-card">
          <div className="lbl">{t('vCPU allocated')}</div>
          <div className="alloc-value">
            <span className="big">{a.vcpu_allocated}</span>
            <span className="lbl">{t('on {n} threads', { n: a.host_threads })}</span>
          </div>
          <Meter pct={vcpuMeterWidth(ratio)} color={levelBar(vcpuLevel)} tick={VCPU_TICK_PCT} />
          <div className="alloc-sub">
            {t('Overcommit {ratio} (tick = 1 : 1)', { ratio: formatRatio(ratio) })}
            {vcpuLevel === 'warning' && <span className="sr-only">{t(', above the 1.5 : 1 warning level')}</span>}
          </div>
        </div>
        <div className="card alloc-card">
          <div className="lbl">{t('Guest memory assigned')}</div>
          <div className="alloc-value">
            <span className="big">{Math.round(a.guest_memory_assigned_gb)}</span>
            <span className="lbl">{t('of {size} GB', { size: Math.round(a.host_memory_gb) })}</span>
          </div>
          <Meter pct={memPct} color={levelBar(memLevel, 'var(--series-memory)')} />
          <div className="alloc-sub">
            {a.guest_memory_in_use_gb != null ? t('{size} GB in use by guests', { size: Math.round(a.guest_memory_in_use_gb) }) : t('Guest memory in use not reported')}
            {balloon ? ` · ${t('ballooning {state}', { state: balloonState(balloon, false) })}` : ''}
            {memLevel !== 'good' && <span className="sr-only">{t(', {pct}% of host memory', { pct: Math.round(memPct) })}</span>}
          </div>
        </div>
        <div className="card alloc-card">
          <div className="lbl">{t('Guest disk I/O')}</div>
          <div className="alloc-value">
            <span className="big">{a.disk_io_mbs ? formatNum(a.disk_io_mbs.total) : '—'}</span>
            <span className="lbl">MB/s</span>
          </div>
          <Sparkline values={metrics?.series.guest_disk_io_mbs} color="var(--series-aqua)" strokeWidth={2} />
          <div className="alloc-sub">{a.disk_io_mbs ? t('Read {read} · write {write} MB/s', { read: formatNum(a.disk_io_mbs.read), write: formatNum(a.disk_io_mbs.write) }) : t('Not reported')}</div>
        </div>
        <div className="card alloc-card">
          <div className="lbl">{t('Guest network')}</div>
          <div className="alloc-value">
            <span className="big">{net ? net.value : '—'}</span>
            <span className="lbl">{net ? net.unit : 'Mb/s'}</span>
          </div>
          <Sparkline values={metrics?.series.guest_net_mbps} color="var(--series-yellow)" strokeWidth={2} />
          <div className="alloc-sub">
            {a.network_mbps && net
              ? t('Receive {rx} · transmit {tx} {unit}', { rx: formatNum(a.network_mbps.rx / net.scale), tx: formatNum(a.network_mbps.tx / net.scale), unit: net.unit })
              : t('Not reported')}
          </div>
        </div>
      </div>
    </section>
  );
}
