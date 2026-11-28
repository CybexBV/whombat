/**
 * The hosts service's words in the reader's language. The hub writes its alerts, banners, hints and a server's status
 * note in English, and beside them a `code` with its `params` (`status_note_code` with `status_note_params` for the
 * note). On a box that speaks another language, this says them again from the code; without a code (an older hub) or on
 * an English box, the hub's own English stays. The hub's English is kept beside a hint (`_en`) so what Ignore compares
 * never depends on the language.
 */
import { formatLocaleList, formatLocaleNumber, type MessageVars } from '@whombat/core/i18n';
import { hasServerMessage, isEnglish, type ServerMessageKey, serverTranslator } from '../i18n/catalog';
import { localizePhrase } from '../i18n/phrases';

type J = Record<string, unknown>;
type Words = { title?: string; detail?: string; bannerTitle?: string; bannerDetail?: string };

const isObj = (v: unknown): v is J => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** What a code's words are filled with: numbers, sizes, temperatures and times in the locale's own form. */
class Fill {
  readonly tr: ReturnType<typeof serverTranslator>;
  constructor(readonly locale: string) {
    this.tr = serverTranslator(locale);
  }
  t(key: ServerMessageKey, vars?: MessageVars): string {
    return this.tr.t(key, vars);
  }
  tp(key: ServerMessageKey, n: number, vars?: MessageVars): string {
    return this.tr.tp(key, n, { n: this.n(n), ...vars });
  }
  n(v: unknown, digits = 0): string {
    const x = num(v);
    if (x === null) return str(v);
    return formatLocaleNumber(x, this.locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  }
  pct(v: unknown): string {
    const x = num(v);
    return x === null ? str(v) : `${this.n(Math.round(x))}%`;
  }
  temp(v: unknown): string {
    const x = num(v);
    return x === null ? str(v) : `${this.n(Math.round(x))} °C`;
  }
  gb(v: unknown): string {
    const x = num(v);
    if (x === null) return str(v);
    return x >= 1000 ? `${this.n(x / 1000, 1)} TB` : `${this.n(x, x < 10 ? 1 : 0)} GB`;
  }
  gib(v: unknown): string {
    const x = num(v);
    return x === null ? str(v) : `${this.n(x, x < 10 ? 1 : 0)} GiB`;
  }
  tb(v: unknown): string {
    const x = num(v);
    return x === null ? str(v) : `${this.n(x, 1)} TB`;
  }
  /** The hub's way of saying how long: `40 s`, `12 min`, `2 h 5 m`, `3 d 4 h`. */
  dur(seconds: unknown): string {
    const s = Math.max(0, Math.floor(num(seconds) ?? 0));
    if (s < 60) return this.t('hosts.dur.s', { n: s });
    if (s < 3600) return this.t('hosts.dur.min', { n: Math.floor(s / 60) });
    if (s < 86_400)
      return this.t('hosts.dur.hm', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
    return this.t('hosts.dur.dh', { d: Math.floor(s / 86_400), h: Math.floor((s % 86_400) / 3600) });
  }
  when(days: unknown): string {
    const d = Math.max(0, Math.round(num(days) ?? 0));
    if (d === 0) return this.t('hosts.when.today');
    if (d === 1) return this.t('hosts.when.tomorrow');
    return this.tp('hosts.when.inDays', d);
  }
  date(unixSeconds: unknown): string {
    const x = num(unixSeconds);
    if (x === null) return str(unixSeconds);
    try {
      return new Intl.DateTimeFormat(this.locale, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(x * 1000));
    } catch {
      return new Date(x * 1000).toISOString().slice(0, 10);
    }
  }
  names(v: unknown, max = 3): string {
    const all = list(v);
    if (all.length <= max) return formatLocaleList(all, this.locale);
    return `${all.slice(0, max).join(', ')}, …`;
  }
  /** A disk or folder's name: the hub's label (“Data”), else its mount point. */
  volume(p: J): string {
    const label = str(p.volume).trim();
    const entity = str(p.entity).replace(/^fs:/, '').trim();
    return localizePhrase(label || entity || '—', this.locale);
  }
  /** A sensor's label as people say it (“CPU”, “Memory”). */
  label(p: J): string {
    return localizePhrase(str(p.label) || str(p.sensor), this.locale);
  }
}

const sentence = (...parts: (string | null | undefined)[]) =>
  parts
    .filter((p): p is string => !!p?.trim())
    .map((p) => p.trim().replace(/[.\s]+$/, ''))
    .join('. ');

/** An alert's or banner's words by its code; null for a code this doesn't know (the hub's English stays). */
function alertWords(code: string, p: J, f: Fill): Words | null {
  const [base = '', variant = ''] = splitCode(code, ALERT_BASES);
  switch (base) {
    case 'agent.heartbeat_missing': {
      const title = f.t('hosts.code.agent.heartbeat_missing.title');
      const detail =
        variant === 'elapsed'
          ? f.t('hosts.code.agent.heartbeat_missing.elapsed.detail', { held: f.dur(p.heldSeconds) })
          : f.t('hosts.code.agent.heartbeat_missing.never.detail');
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'sensor.temp_high':
    case 'sensor.temp_critical': {
      const title = f.t('hosts.code.sensor.temp_high.title', { label: f.label(p), temp: f.temp(p.tempC) });
      const held = f.dur(p.heldSeconds);
      const limit = f.temp(p.limitC);
      const custom = variant === 'custom' || p.customLimit === true;
      const detail = custom
        ? f.t('hosts.code.sensor.temp_high.custom.detail', { temp: f.temp(p.tempC), limit, held })
        : base === 'sensor.temp_high'
          ? f.t('hosts.code.sensor.temp_high.detail', { limit, held })
          : f.t('hosts.code.sensor.temp_critical.detail', { limit, held });
      const advice =
        base === 'sensor.temp_critical'
          ? f.t('hosts.code.sensor.temp_critical.advice')
          : custom
            ? ''
            : f.t('hosts.code.sensor.temp_high.advice', { limit });
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail, advice) };
    }
    case 'disk.wear_high':
    case 'disk.wear_critical': {
      const title = f.t('hosts.code.disk.wear.title', { device: str(p.device), pct: f.pct(p.pct) });
      const detail =
        variant === 'tbw'
          ? f.t('hosts.code.disk.wear.tbw', { written: f.tb(p.writtenTb), rated: f.tb(p.ratedTbw) })
          : variant === 'written'
            ? f.t('hosts.code.disk.wear.written', { written: f.tb(p.writtenTb) })
            : '';
      const limit = p.customLimit === true ? f.t('hosts.word.customLimit', { limit: f.pct(p.limitPct) }) : '';
      const evidence = [detail, limit].filter(Boolean).join(', ');
      const advice = f.t(
        base === 'disk.wear_critical'
          ? 'hosts.code.disk.wear_critical.advice'
          : 'hosts.code.disk.wear_high.advice',
      );
      return { title, detail: evidence, bannerTitle: title, bannerDetail: sentence(evidence, advice) };
    }
    case 'disk.space_high': {
      const volume = f.volume(p);
      const pct = f.pct(p.pct);
      const detail = f.t('hosts.word.ofVolume', { used: f.gb(p.usedGB), total: f.gb(p.totalGB) });
      return {
        title: f.t('hosts.code.disk.space_high.title', { volume, pct }),
        detail,
        bannerTitle: f.t('hosts.code.disk.space_high.bannerTitle', { volume, pct }),
        bannerDetail: sentence(detail, f.t('hosts.wayOut.freeOrAdd')),
      };
    }
    case 'hypervisor.overcommit': {
      const title = f.t('hosts.code.hypervisor.overcommit.title');
      const detail = f.t('hosts.code.hypervisor.overcommit.detail', {
        allocated: f.n(p.allocated),
        threads: f.n(p.threads),
        ratio: f.n(p.ratio, 1),
        held: f.dur(p.heldSeconds),
      });
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'hypervisor.memory_assigned': {
      const title = f.t('hosts.code.hypervisor.memory_assigned.title', { pct: f.pct(p.pct) });
      const detail = f.t('hosts.code.hypervisor.memory_assigned.detail', {
        used: f.gib(p.usedGiB),
        total: f.gib(p.totalGiB),
      });
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'disk.smart_failing': {
      const title = f.t('hosts.code.disk.smart_failing.title', { device: str(p.device) });
      const detail = f.t('hosts.code.disk.smart_failing.detail');
      return {
        title,
        detail,
        bannerTitle: title,
        bannerDetail: sentence(detail, f.t('hosts.code.disk.smart_failing.advice')),
      };
    }
    case 'disk.smart_errors': {
      const title = f.t('hosts.code.disk.smart_errors.title', { device: str(p.device) });
      const parts: string[] = [];
      if (num(p.pending)) parts.push(f.tp('hosts.code.disk.smart_errors.pending', num(p.pending) ?? 0));
      if (num(p.uncorrectable))
        parts.push(f.tp('hosts.code.disk.smart_errors.uncorrectable', num(p.uncorrectable) ?? 0));
      if (num(p.mediaErrors)) parts.push(f.tp('hosts.code.disk.smart_errors.media', num(p.mediaErrors) ?? 0));
      if (str(p.selfTestType))
        parts.push(f.t('hosts.code.disk.smart_errors.selfTest', { type: str(p.selfTestType) }));
      const detail = parts.join(' · ');
      return {
        title,
        detail,
        bannerTitle: title,
        bannerDetail: sentence(detail, f.t('hosts.code.disk.smart_errors.advice')),
      };
    }
    case 'pool.degraded': {
      // As the hub says it: a degraded pool is missing a disk; a faulted or unavailable one isn't working properly.
      const faulted = list(p.faulted);
      const health = str(p.health).toUpperCase();
      const missing = health === '' || health === 'DEGRADED';
      const title = missing
        ? f.t('hosts.code.pool.degraded.missing', { name: str(p.name) })
        : f.t('hosts.code.pool.degraded.title', { name: str(p.name), health: health.toLowerCase() });
      const detail = faulted.length
        ? f.t('hosts.code.pool.degraded.offline', { disks: f.names(faulted, 4) })
        : health
          ? f.t('hosts.code.pool.degraded.reported', { health: health.toLowerCase() })
          : '';
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'pool.errors': {
      const title = f.t('hosts.code.pool.errors.title', { name: str(p.name) });
      const detail = f.t('hosts.code.pool.errors.detail', { io: f.n(p.ioErrors), scrub: f.n(p.scrubErrors) });
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'raid.degraded': {
      const title = f.t('hosts.code.raid.degraded.title', { name: str(p.name) });
      const detail = f.t('hosts.code.raid.degraded.detail', { active: f.n(p.active), total: f.n(p.total) });
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'fs.read_only': {
      const title = f.t('hosts.code.fs.read_only.title', { volume: f.volume(p) });
      const detail = f.t('hosts.code.fs.read_only.detail');
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'fs.inodes_high': {
      const title = f.t('hosts.code.fs.inodes_high.title', { volume: f.volume(p) });
      const detail = f.t('hosts.code.fs.inodes_high.detail', {
        used: f.n(p.used),
        total: f.n(p.total),
        pct: f.pct(p.pct),
      });
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'pve.quorum_lost': {
      const title = f.t('hosts.code.pve.quorum_lost.title', { name: str(p.name) });
      const detail = f.t('hosts.code.pve.quorum_lost.detail', {
        connected: f.n(p.connected),
        total: f.n(p.total),
      });
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'backup.failed': {
      const detail = f.t('hosts.code.backup.failed.detail', { ok: f.n(p.backedUp), total: f.n(p.total) });
      return {
        title: f.t('hosts.code.backup.failed.title'),
        detail,
        bannerTitle: f.t('hosts.code.backup.failed.bannerTitle'),
        bannerDetail: sentence(detail, f.t('hosts.code.backup.failed.advice')),
      };
    }
    case 'pve.replication_failed': {
      const title = f.t('hosts.code.pve.replication_failed.title', { id: str(p.id), target: str(p.target) });
      const detail = str(p.error);
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'ceph.health': {
      const bad = /err/i.test(str(p.status));
      const title = f.t(bad ? 'hosts.code.ceph.health.err' : 'hosts.code.ceph.health.warn');
      const detail = list(p.summary).join(' · ');
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'time.unsynced': {
      const title = f.t('hosts.code.time.unsynced.title');
      const detail = f.t('hosts.code.time.unsynced.detail', { source: str(p.source) || 'NTP' });
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'ups.on_battery': {
      const title = f.t('hosts.code.ups.on_battery.title', { name: str(p.name) });
      const parts: string[] = [];
      if (num(p.chargePct) !== null) parts.push(f.pct(p.chargePct));
      if (num(p.runtimeSeconds) !== null)
        parts.push(f.t('hosts.code.ups.on_battery.runtime', { left: f.dur(p.runtimeSeconds) }));
      const detail = parts.join(' · ');
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'net.link_down': {
      const title = f.t('hosts.code.net.link_down.title', { name: str(p.name) });
      const detail = str(p.address) || f.names(p.members, 4);
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'sensor.fan_failed': {
      const title = f.t('hosts.code.sensor.fan_failed.title', { label: f.label(p) });
      const detail = num(p.rpm) !== null ? `${f.n(p.rpm)} rpm` : '';
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'host.oom': {
      const title = f.t('hosts.code.host.oom.title');
      const detail = f.tp('hosts.code.host.oom.detail', num(p.count) ?? 1, { ago: f.dur(p.agoSeconds) });
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'guest.restart_loop': {
      const title = f.t('hosts.code.guest.restart_loop.title', { name: str(p.name) });
      const detail = f.tp('hosts.code.guest.restart_loop.detail', num(p.count) ?? 0, {
        window: f.dur(p.windowSeconds),
      });
      return {
        title,
        detail,
        bannerTitle: title,
        bannerDetail: sentence(detail, f.t('hosts.code.guest.restart_loop.advice')),
      };
    }
    case 'guest.stopped': {
      const title = f.t('hosts.code.guest.stopped.title', { name: str(p.name) });
      const detail = f.t(
        p.cause === 'oom' ? 'hosts.code.guest.stopped.oom' : 'hosts.code.guest.stopped.crash',
      );
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'disk.full_soon': {
      const volume = f.volume(p);
      const when = f.when(p.days);
      const detail = f.t('hosts.code.disk.full_soon.detail');
      return {
        title: f.t('hosts.code.disk.full_soon.title', { volume, when }),
        detail,
        bannerTitle: f.t('hosts.code.disk.full_soon.bannerTitle', { volume, when }),
        bannerDetail: sentence(detail, f.t('hosts.wayOut.freeOrAdd')),
      };
    }
    case 'security.denied_requests': {
      const title = f.t('hosts.code.security.denied_requests.title', { user: str(p.user) });
      const detail = f.tp('hosts.code.security.denied_requests.detail', num(p.count) ?? 0, {
        user: str(p.user),
      });
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'check.down': {
      const title = f.t('hosts.code.check.down.title', { name: str(p.name) });
      const detail =
        variant === 'heartbeat_never'
          ? f.t('hosts.code.check.down.heartbeat_never')
          : variant === 'heartbeat_failed'
            ? f.t('hosts.code.check.down.heartbeat_failed')
            : variant === 'heartbeat_elapsed'
              ? f.t('hosts.code.check.down.heartbeat_elapsed', { held: f.dur(p.heldSeconds) })
              : variant === 'heartbeat_exit'
                ? f.t('hosts.code.check.down.heartbeat_exit', { code: f.n(p.exitCode) })
                : str(p.error);
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    case 'check.cert_expiring': {
      const title = f.tp('hosts.code.check.cert_expiring.title', num(p.days) ?? 0, { name: str(p.name) });
      const detail = f.t('hosts.code.check.cert_expiring.detail', { date: f.date(p.expiresAt) });
      return { title, detail, bannerTitle: title, bannerDetail: sentence(detail) };
    }
    default:
      return null;
  }
}

/** What a collector reads, as the hub names it in “Whombat can’t read this server’s …”. */
function collectorWords(name: string, f: Fill): string {
  switch (name) {
    case 'smart':
      return f.t('hosts.collector.smart');
    case 'sensors':
    case 'temps':
      return f.t('hosts.collector.sensors');
    case 'ups':
      return f.t('hosts.collector.ups');
    case 'unraid':
      return f.t('hosts.collector.unraid');
    case 'disks':
      return f.t('hosts.collector.disks');
    case 'net':
    case 'network':
      return f.t('hosts.collector.network');
    case 'system':
      return f.t('hosts.collector.system');
    case 'docker':
      return f.t('hosts.collector.docker');
    case 'incus':
    case 'pve':
    case 'libvirt':
      return f.t('hosts.collector.machines');
    default:
      return f.t('hosts.collector.other', { name });
  }
}

/** A hint's words by its code; null for a code this doesn't know. */
function hintWords(code: string, p: J, f: Fill): Words | null {
  const [base = '', variant = ''] = splitCode(code, HINT_BASES);
  const count = num(p.count) ?? list(p.names).length;
  const named = () => f.names(p.names);
  switch (base) {
    case 'sensor.near_limit':
      return {
        title: f.t('hosts.hint.sensor.near_limit.title', { label: f.label(p), temp: f.temp(p.tempC) }),
        detail: f.t('hosts.hint.sensor.near_limit.detail', { limit: f.temp(p.limitC) }),
      };
    case 'swap.high': {
      const swap = f.t('hosts.hint.swap.high.detail', { used: f.gib(p.usedGiB), total: f.gib(p.totalGiB) });
      // How full the memory is says why swap matters, as the hub's own line does.
      const ram = num(p.ramPct) === null ? null : f.t('hosts.hint.swap.high.ram', { pct: f.pct(p.ramPct) });
      return { title: f.t('hosts.hint.swap.high.title'), detail: ram ? `${swap} · ${ram}` : swap };
    }
    case 'memory.low':
      return {
        title: f.t('hosts.hint.memory.low.title'),
        detail: f.t('hosts.hint.memory.low.detail', {
          available: f.gib(p.availableGiB),
          total: f.gib(p.totalGiB),
        }),
      };
    case 'disk.space':
      return {
        title: f.t('hosts.hint.disk.space.title', { volume: f.volume(p), pct: f.pct(p.pct) }),
        detail: f.t('hosts.word.ofVolume', { used: f.gb(p.usedGB), total: f.gb(p.totalGB) }),
      };
    case 'disk.wear':
      return {
        title: f.t('hosts.hint.disk.wear.title', { device: str(p.device), pct: f.pct(p.pct) }),
        detail:
          variant === 'tbw'
            ? f.t('hosts.code.disk.wear.tbw', { written: f.tb(p.writtenTb), rated: f.tb(p.ratedTbw) })
            : variant === 'written'
              ? f.t('hosts.code.disk.wear.written', { written: f.tb(p.writtenTb) })
              : '',
      };
    case 'collector.error':
      return {
        title: f.t('hosts.hint.collector.error.title', { what: collectorWords(str(p.collector), f) }),
        detail: str(p.error).trim() || f.t('hosts.hint.collector.error.noReason'),
      };
    case 'guests.unhealthy':
    case 'system.failed_units':
    case 'docker.image_updates':
    case 'docker.update_available':
    case 'unraid.plugin_updates':
    case 'guest.no_backup_job':
    case 'guest.agent_down':
    case 'incus.no_snapshots':
    case 'libvirt.no_backup':
    case 'guest.backup_old':
    case 'guest.pending_changes':
    case 'guest.snapshot_old':
    case 'unraid.disk_errors': {
      const key = `hosts.hint.${base}.title`;
      if (!hasServerMessage(key)) return null;
      return { title: f.tp(key, count), detail: named() };
    }
    case 'agent.outdated':
      return {
        title: f.t('hosts.hint.agent.outdated.title'),
        detail: f.t('hosts.hint.agent.outdated.detail', {
          agent: str(p.agentVersion),
          hub: str(p.hubVersion),
        }),
      };
    case 'system.updates': {
      const security = num(p.securityCount) ?? 0;
      return {
        title: f.tp('hosts.hint.system.updates.title', count),
        detail: security > 0 ? f.tp('hosts.hint.system.updates.security', security) : '',
      };
    }
    case 'system.reboot':
      return { title: f.t('hosts.hint.system.reboot.title'), detail: f.t('hosts.hint.system.reboot.detail') };
    case 'cpu.steal':
      return {
        title: f.t('hosts.hint.cpu.steal.title'),
        detail: f.t('hosts.hint.cpu.steal.detail', { pct: f.pct(p.pct) }),
      };
    case 'disk.counters':
      return { title: f.t('hosts.hint.disk.counters.title', { device: str(p.device) }) };
    case 'pool.scrub':
      return variant === 'never'
        ? {
            title: f.t('hosts.hint.pool.scrub.never.title', { name: str(p.name) }),
            detail: f.t('hosts.hint.pool.scrub.never.detail'),
          }
        : {
            title: f.t('hosts.hint.pool.scrub.title', { name: str(p.name) }),
            detail: f.t('hosts.hint.pool.scrub.detail', { date: f.date(p.checkedAt) }),
          };
    case 'raid.sync':
      return {
        title: f.t('hosts.hint.raid.sync.title', { name: str(p.name) }),
        detail: f.t('hosts.hint.raid.sync.detail'),
      };
    case 'backup.warning':
      return {
        title: f.t('hosts.hint.backup.warning.title'),
        detail: f.t('hosts.hint.backup.warning.detail', {
          ok: f.n(p.backedUp),
          total: f.n(p.total),
          warnings: f.tp('hosts.hint.backup.warning.warnings', count),
        }),
      };
    case 'platform.warnings':
      return {
        title: f.tp('hosts.hint.platform.warnings.title', count, { platform: str(p.platform) }),
        detail: str(p.message),
      };
    case 'memory.limit':
      return {
        title: f.tp('hosts.hint.memory.limit.title', count, { name: str(p.name) }),
        detail: f.t('hosts.hint.memory.limit.detail'),
      };
    case 'disk.forecast':
      return {
        title: f.t('hosts.hint.disk.forecast.title', { volume: f.volume(p), when: f.when(p.days) }),
        detail: f.t('hosts.hint.disk.forecast.detail'),
      };
    case 'incus.pool_full':
      return {
        title: f.t('hosts.hint.incus.pool_full.title', { name: str(p.name), pct: f.pct(p.pct) }),
        detail: f.t('hosts.word.ofVolume', { used: f.gb(p.usedGB), total: f.gb(p.totalGB) }),
      };
    case 'incus.warning':
      return { title: f.tp('hosts.hint.incus.warning.title', count), detail: str(p.message) };
    case 'unraid.parity_errors':
      return {
        title: f.tp('hosts.hint.unraid.parity_errors.title', count),
        detail: f.t('hosts.hint.unraid.parity_old.detail', { date: f.date(p.checkedAt) }),
      };
    case 'unraid.parity_old':
      return variant === 'never'
        ? { title: f.t('hosts.hint.unraid.parity_old.never.title') }
        : {
            title: f.t('hosts.hint.unraid.parity_old.title'),
            detail: f.t('hosts.hint.unraid.parity_old.detail', { date: f.date(p.checkedAt) }),
          };
    case 'unraid.pool_full':
    case 'libvirt.pool_full':
      return {
        title: f.t('hosts.hint.pool_full.title', { name: str(p.name), pct: f.pct(p.pct) }),
        detail: f.t('hosts.hint.pool_full.detail', { free: f.gb(p.freeGB) }),
      };
    case 'unraid.notification':
      return { title: str(p.subject), detail: str(p.description) };
    case 'unraid.os_update':
      return { title: f.t('hosts.hint.unraid.os_update.title', { version: str(p.version) }) };
    case 'unraid.array_stopped':
      return {
        title: f.t(
          variant === 'invalid'
            ? 'hosts.hint.unraid.array_stopped.invalid.title'
            : 'hosts.hint.unraid.array_stopped.title',
        ),
      };
    case 'storage.overcommit':
      return {
        title: f.t('hosts.hint.storage.overcommit.title', { name: str(p.name) }),
        detail: f.t('hosts.hint.storage.overcommit.detail', {
          provisioned: f.gb(p.provisionedGB),
          total: f.gb(p.totalGB),
          pct: f.pct(p.pct),
        }),
      };
    case 'macos.screen_sharing_off':
      return { title: f.t('hosts.hint.macos.screen_sharing_off.title') };
    case 'macos.screen_sign_in':
      return { title: f.t('hosts.hint.macos.screen_sign_in.title') };
    case 'macos.agent_folder':
      return {
        title: f.t('hosts.hint.macos.agent_folder.title'),
        detail: f.t('hosts.hint.macos.agent_folder.detail', { folder: str(p.folder) }),
      };
    case 'macos.helper_no_access':
      return { title: f.t('hosts.hint.macos.helper_no_access.title') };
    case 'macos.helper_off':
      return {
        title: f.t('hosts.hint.macos.helper_off.title'),
        detail: str(p.user) ? f.t('hosts.hint.macos.helper_off.detail', { user: str(p.user) }) : '',
      };
    case 'windows.protection_off':
      return {
        title: f.t('hosts.hint.windows.protection_off.title'),
        detail: f.t(
          variant === 'realtime'
            ? 'hosts.hint.windows.protection_off.realtime.detail'
            : 'hosts.hint.windows.protection_off.detail',
        ),
      };
    case 'windows.signatures_old':
      return {
        title: f.t('hosts.hint.windows.signatures_old.title', { days: f.n(p.days) }),
        detail: f.t('hosts.hint.windows.signatures_old.detail'),
      };
    default:
      return null;
  }
}

/** The rule or kind a code is about, and what follows it (`disk.wear_high.tbw` → `disk.wear_high`, `tbw`). */
function splitCode(code: string, bases: readonly string[]): [string, string] {
  for (const b of bases) {
    if (code === b) return [b, ''];
    if (code.startsWith(`${b}.`)) return [b, code.slice(b.length + 1)];
  }
  return [code, ''];
}

// Longest first, so `disk.wear_high` is never read as `disk.wear` with a variant.
const ALERT_BASES = [
  'agent.heartbeat_missing',
  'sensor.temp_critical',
  'sensor.temp_high',
  'disk.wear_critical',
  'disk.wear_high',
  'disk.space_high',
  'hypervisor.overcommit',
  'hypervisor.memory_assigned',
  'disk.smart_failing',
  'disk.smart_errors',
  'pool.degraded',
  'pool.errors',
  'raid.degraded',
  'fs.read_only',
  'fs.inodes_high',
  'pve.quorum_lost',
  'backup.failed',
  'pve.replication_failed',
  'ceph.health',
  'time.unsynced',
  'ups.on_battery',
  'net.link_down',
  'sensor.fan_failed',
  'host.oom',
  'guest.restart_loop',
  'guest.stopped',
  'disk.full_soon',
  'security.denied_requests',
  'check.down',
  'check.cert_expiring',
].sort((a, b) => b.length - a.length);

const HINT_BASES = [
  'sensor.near_limit',
  'swap.high',
  'memory.low',
  'disk.space',
  'disk.wear',
  'collector.error',
  'guests.unhealthy',
  'system.failed_units',
  'docker.image_updates',
  'docker.update_available',
  'unraid.plugin_updates',
  'guest.no_backup_job',
  'guest.agent_down',
  'agent.outdated',
  'system.updates',
  'system.reboot',
  'cpu.steal',
  'disk.counters',
  'pool.scrub',
  'raid.sync',
  'backup.warning',
  'platform.warnings',
  'memory.limit',
  'disk.forecast',
  'incus.no_snapshots',
  'incus.pool_full',
  'incus.warning',
  'unraid.parity_errors',
  'unraid.parity_old',
  'unraid.disk_errors',
  'unraid.pool_full',
  'libvirt.pool_full',
  'unraid.notification',
  'unraid.os_update',
  'unraid.array_stopped',
  'libvirt.no_backup',
  'guest.backup_old',
  'guest.pending_changes',
  'guest.snapshot_old',
  'storage.overcommit',
  'macos.agent_folder',
  'macos.helper_off',
  'macos.screen_sharing_off',
  'macos.screen_sign_in',
  'macos.helper_no_access',
  'windows.protection_off',
  'windows.signatures_old',
].sort((a, b) => b.length - a.length);

/** A server's status note by its code (“disk wear”, “CPU temperature”); null when the code is unknown. */
export function statusNoteWords(
  code: string | null | undefined,
  params: unknown,
  locale: string | null | undefined,
): string | null {
  if (!code || isEnglish(locale)) return null;
  const key = `hosts.note.${code}`;
  if (!hasServerMessage(key)) return null;
  const p = isObj(params) ? params : {};
  const sensor = localizePhrase(str(p.shortName) || str(p.sensor), locale);
  return serverTranslator(locale).t(key, { sensor });
}

/** The words of one alert, banner or hint of the hub in `locale`, from its code; null to keep the hub's English. */
export function hubWords(
  raw: J,
  locale: string | null | undefined,
  as: 'alert' | 'hint' = typeof raw.rule === 'string' ? 'alert' : 'hint',
): Words | null {
  if (isEnglish(locale)) return null;
  const code = str(raw.code);
  if (!code) return null;
  const params = isObj(raw.params) ? raw.params : {};
  const f = new Fill(locale ?? '');
  try {
    return as === 'alert' ? alertWords(code, params, f) : hintWords(code, params, f);
  } catch {
    // A param of an unexpected shape: the hub's English is still right.
    return null;
  }
}

const ENGLISH = new WeakMap<object, { title: string; detail: string }>();

/** Keeps the hub's English of a mapped hint beside it (the contract's shape has no room for it). */
export function rememberEnglish(mapped: object, raw: J): void {
  const en = hubEnglish(raw);
  if (en) ENGLISH.set(mapped, en);
}

/** The hub's English of a mapped hint whose words were said in another language; undefined when they weren't. */
export function englishOf(mapped: object): { title: string; detail: string } | undefined {
  return ENGLISH.get(mapped);
}

/** The English the hub wrote of a hint, kept beside it before its words were said again (`_en`). */
export function hubEnglish(raw: J): { title: string; detail: string } | null {
  const en = raw._en;
  if (!isObj(en)) return null;
  return { title: str(en.title), detail: str(en.detail) };
}

/** One hub object with its words said in `locale`, its English kept in `_en`. */
function localizeOne(o: J, locale: string): J {
  let out: J | null = null;
  const own = () => {
    out ??= { ...o };
    return out;
  };
  if (typeof o.code === 'string' && o.code && (typeof o.title === 'string' || typeof o.detail === 'string')) {
    const words = hubWords(o, locale);
    if (words) {
      const next = own();
      next._en = { title: str(o.title), detail: str(o.detail) };
      if (words.title) next.title = words.title;
      if (words.detail) next.detail = words.detail;
      else if (str(o.detail)) next.detail = localizePhrase(str(o.detail), locale);
      if ('banner_title' in o && words.bannerTitle) next.banner_title = words.bannerTitle;
      if ('banner_detail' in o && words.bannerDetail) next.banner_detail = words.bannerDetail;
    }
  }
  if (typeof o.status_note_code === 'string' && typeof o.status_note === 'string') {
    const note = statusNoteWords(o.status_note_code, o.status_note_params, locale);
    if (note) own().status_note = note;
  }
  return out ?? o;
}

/**
 * Any answer of the hub (the fleet, a server's detail, an alert list, one alert) with every alert, banner, hint and
 * status note said in `locale`. English (and an answer without codes) comes back as it was; nothing is changed in
 * place, so a cached English answer stays English.
 */
export function localizeHubJson<T>(value: T, locale: string | null | undefined, depth = 0): T {
  if (isEnglish(locale) || depth > 6) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const next = localizeHubJson(v, locale, depth + 1);
      if (next !== v) changed = true;
      return next;
    });
    return (changed ? out : value) as T;
  }
  if (!isObj(value)) return value;
  let out: J = localizeOne(value, locale ?? '');
  for (const [k, v] of Object.entries(out)) {
    if (k === '_en' || k === 'params' || k === 'status_note_params') continue;
    if (typeof v !== 'object' || v === null) continue;
    const next = localizeHubJson(v, locale, depth + 1);
    if (next !== v) {
      if (out === value) out = { ...out };
      out[k] = next;
    }
  }
  return out as T;
}
