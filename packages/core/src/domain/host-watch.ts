/**
 * What Whombat watches on a server (contracts 0.122.0, CT-1066; Whombat quiet-notices.md QN-01…QN-04, QN-15, QN-23):
 * one check per alert rule and hint kind of the hosts service, and Whombat's own two hints about a server's agent. The
 * client builds a server page's Worth a look lines from it (their kind, check, item and Ignore words); the runtime its
 * What Whombat watches, the dot and the desk's looks.
 *
 * Alerts are quieted in the hosts service (Ignore: its acknowledgement until the alert resolves; Remind me tomorrow:
 * until 09:00; Stop watching: the rule switched off for the server or one item). Hints are quieted in Whombat, by their
 * kind and item. Rule and hint ids are the hosts service's (`whombat-hosts` `internal/rules`, `internal/hub`).
 */
import { coreTranslator, hasCoreMessage, isEnglishLocale } from '../i18n/catalog.js';
import { BACKUP_PLACE_TEXT } from './backup-places.js';
import { NOTICE_CHECK_RE, type NoticeCheck, type NoticeNature, type QuietLifts } from './quiet.js';

/** Whombat's own hints about a server that keeps this Whombat's backups (backup-places.md BPL-11). */
export const BACKUP_PLACE_CLEANUP_HINT = 'backup_place.cleanup';
export const BACKUP_PLACE_SPACE_HINT = 'backup_place.space';
/** Whombat's own hint about a Proxmox machine whose backup didn't come back in a restore test (backup-trust.md). */
export const RESTORE_TEST_FAILED_HINT = 'restore_test.failed';

/**
 * A server check (CT-1066): `host.<rule>` for an alert rule, `host.hint.<kind>` for a hint; `name` the switch's words
 * (≤ 80), `nature` the kind of line, `warnNature` the kind when a hint is a warning where that differs (a pool at 95 %
 * is a problem, at 80 % a heads-up), `lifts` and `words` what Ignore does (a sentence ≤ 60), `perItem` its lines are
 * about one item each (a disk, a mount, a sensor), so Stop watching can be for one item. `fixable`: an only-you line
 * the assistant can carry out once the person asks (a backup job, a snapshot schedule, a restart). `startsOn`: Whombat watches it from the start (only
 * what is very important and what Whombat can act on; the rest is off until someone turns it on, Whombat
 * watch-defaults.md).
 */
export interface HostWatchCheck {
  readonly check: NoticeCheck;
  readonly rule?: string;
  readonly hint?: string;
  readonly name: string;
  readonly nature: NoticeNature;
  readonly warnNature?: NoticeNature;
  readonly lifts: QuietLifts;
  readonly words: string;
  readonly perItem: boolean;
  readonly fixable?: true;
  readonly startsOn: boolean;
}

/**
 * The alert rules Whombat watches from the start: a server gone, hardware failing, data at risk, storage full, power
 * out, apps crashing. A server running warm, disks wearing, machines given more than the server has, a clock or a
 * cable start off: the person turns them on for a server where they matter (watch-defaults.md).
 */
const RULES_ON: ReadonlySet<string> = new Set([
  'agent.heartbeat_missing',
  'sensor.temp_critical',
  'disk.wear_critical',
  'disk.space_high',
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
  'ups.on_battery',
  'sensor.fan_failed',
  'host.oom',
  'guest.restart_loop',
  'guest.stopped',
  'disk.full_soon',
  'check.down',
  'check.cert_expiring',
  'security.denied_requests',
]);

/**
 * The hints Whombat watches from the start: apps not working, storage full or broken, machines without a backup, and
 * Whombat's helper not updating (a failed update holds back every server's) or needing one more install. Updates, forecasts, warm parts, the platform's own messages and the rest
 * start off (watch-defaults.md).
 */
const HINTS_ON: ReadonlySet<string> = new Set([
  'guests.unhealthy',
  'incus.no_snapshots',
  'incus.pool_full',
  'libvirt.pool_full',
  'libvirt.no_backup',
  'unraid.array_stopped',
  'unraid.parity_errors',
  'unraid.disk_errors',
  'unraid.pool_full',
  'guest.backup_old',
  'guest.no_backup_job',
  'agent.update_failed',
  'agent.needs_install',
  // Whombat's root program on a Mac in a folder someone other than root can change: a security opening with one
  // clear step (run the installer again), so it starts on (watch-defaults.md).
  'macos.agent_folder',
  // A backup that didn't come back when Whombat tried it: data at risk, and Whombat says which and why. It exists only
  // once the person turned restore tests on (backup-trust.md).
  RESTORE_TEST_FAILED_HINT,
]);

const alert = (
  rule: string,
  name: string,
  nature: NoticeNature,
  words: string,
  perItem: boolean,
  lifts: QuietLifts = 'fixed',
): HostWatchCheck => ({
  check: `host.${rule}`,
  rule,
  name,
  nature,
  lifts,
  words,
  perItem,
  startsOn: RULES_ON.has(rule),
});

/**
 * Only-you hints the assistant can do on the person's word: Watch offers to ask it to fix them. A disk to replace, a
 * sign-in or a stopped array stay the person's alone.
 */
const FIXABLE_HINTS: ReadonlySet<string> = new Set([
  'system.reboot',
  'incus.no_snapshots',
  'libvirt.no_backup',
  'guest.no_backup_job',
  'guest.pending_changes',
]);

const hint = (
  kind: string,
  name: string,
  nature: NoticeNature,
  lifts: QuietLifts,
  words: string,
  perItem: boolean,
  warnNature?: NoticeNature,
): HostWatchCheck => ({
  check: `host.hint.${kind}`,
  hint: kind,
  name,
  nature,
  ...(warnNature ? { warnNature } : {}),
  lifts,
  words,
  perItem,
  ...(FIXABLE_HINTS.has(kind) ? { fixable: true as const } : {}),
  startsOn: HINTS_ON.has(kind),
});

/**
 * Every alert rule (29) and hint kind (44 of the hosts service, 5 of Whombat's) as a check, in the hosts service's
 * order: alerts first.
 */
export const HOST_WATCH_CHECKS: readonly HostWatchCheck[] = [
  // Alerts (rules/alerts.go).
  alert('agent.heartbeat_missing', 'Servers not checking in', 'problem', 'Until it checks in again.', false),
  alert('sensor.temp_high', 'Running hot', 'problem', 'Until it cools down.', true),
  alert('sensor.temp_critical', 'Running too hot', 'problem', 'Until it cools down.', true),
  alert('disk.wear_high', 'Disks wearing out', 'you', 'Until it wears further.', true),
  alert('disk.wear_critical', 'Disks worn out', 'you', 'Until it’s replaced.', true),
  alert('disk.space_high', 'Disks filling up', 'problem', 'Until there’s room again.', true),
  alert(
    'hypervisor.overcommit',
    'Machines given more processors than the server has',
    'fyi',
    'Until it’s back to normal.',
    false,
  ),
  alert('hypervisor.memory_assigned', 'Memory given to machines', 'fyi', 'Until it’s back to normal.', false),
  // Health (rules/health.go).
  alert('disk.smart_failing', 'Disks failing', 'you', 'Until it’s replaced.', true),
  alert('disk.smart_errors', 'Disk errors', 'problem', 'Until it gets worse.', true),
  alert('pool.degraded', 'Storage missing a disk', 'you', 'Until it’s whole again.', true),
  alert('pool.errors', 'Damaged data in storage', 'problem', 'Until the errors are cleared.', true),
  alert('raid.degraded', 'Mirrored disks missing one', 'you', 'Until they’re whole again.', true),
  alert(
    'fs.read_only',
    'Disks that can’t be written to',
    'problem',
    'Until it can be written to again.',
    true,
  ),
  alert(
    'fs.inodes_high',
    'Disks running out of room for files',
    'problem',
    'Until there’s room again.',
    true,
  ),
  alert(
    'pve.quorum_lost',
    'Servers of a cluster losing touch',
    'problem',
    'Until they’re back together.',
    false,
  ),
  alert('backup.failed', 'Backups failing', 'problem', 'Until a backup works again.', false),
  alert(
    'pve.replication_failed',
    'Copies to another server failing',
    'problem',
    'Until it works again.',
    true,
  ),
  alert('ceph.health', 'Shared storage problems (Ceph)', 'problem', 'Until it’s fine again.', false),
  alert('time.unsynced', 'Clock out of sync', 'problem', 'Until the clock is right again.', false),
  alert('ups.on_battery', 'Running on battery', 'you', 'Until the power is back.', true),
  alert('net.link_down', 'Network cables unplugged', 'problem', 'Until it’s connected again.', true),
  alert('sensor.fan_failed', 'Fans stopping', 'you', 'Until it spins again.', true),
  alert('host.oom', 'Running out of memory', 'problem', 'Until it happens again.', false, 'newer'),
  alert(
    'guest.restart_loop',
    'Machines and apps restarting over and over',
    'problem',
    'Until it happens again.',
    true,
    'newer',
  ),
  alert('guest.stopped', 'Machines stopping on their own', 'problem', 'Until it runs again.', true),
  alert('disk.full_soon', 'Disks about to fill up', 'problem', 'Until it gets fuller.', true),
  // The hub's own (hub/checks.go, hub/api_alerts.go): not about one server.
  alert('check.down', 'Checks failing', 'problem', 'Until it’s up again.', true),
  alert('check.cert_expiring', 'Certificates about to expire', 'problem', 'Until it’s renewed.', true),
  alert('security.denied_requests', 'Someone being refused', 'you', 'Until it happens again.', true, 'newer'),

  // Hints (rules/hints.go).
  hint('sensor.near_limit', 'Getting warm', 'fyi', 'fixed', 'Until it gets hotter.', true),
  hint('swap.high', 'Memory spilling onto disk', 'fyi', 'fixed', 'Until it gets worse.', false),
  hint('memory.low', 'Memory running low', 'problem', 'fixed', 'Until it gets worse.', false),
  hint('disk.space', 'Disks getting full', 'fyi', 'fixed', 'Until it gets fuller.', true),
  hint('disk.wear', 'Disk wear', 'fyi', 'fixed', 'Until it wears further.', true),
  hint('collector.error', 'Parts Whombat can’t read', 'problem', 'fixed', 'Until it works again.', true),
  hint(
    'guests.unhealthy',
    'Apps not working properly',
    'problem',
    'newer',
    'Until another one stops working.',
    false,
  ),
  hint(
    'agent.outdated',
    'Whombat’s helper out of date',
    'fyi',
    'newer',
    'Until there’s a newer version.',
    false,
  ),
  hint(
    'system.failed_units',
    'Background services stopping',
    'problem',
    'newer',
    'Until another one stops.',
    false,
  ),
  hint('system.updates', 'Updates waiting', 'fyi', 'newer', 'Until there are more.', false),
  hint('system.reboot', 'Restart needed', 'you', 'fixed', 'Until it restarts.', false),
  hint('cpu.steal', 'Slowed down by its host', 'fyi', 'fixed', 'Until it’s back to normal.', false),
  hint('disk.counters', 'Disk errors noticed', 'fyi', 'fixed', 'Until it gets worse.', true),
  hint('pool.scrub', 'Storage data checks overdue', 'fyi', 'fixed', 'Until the next check.', true),
  hint('raid.sync', 'Disks syncing', 'fyi', 'fixed', 'Until it’s done.', true),
  hint('backup.warning', 'Backup warnings', 'fyi', 'newer', 'Until the next backup.', false),
  hint(
    'platform.warnings',
    'Warnings from the server’s software',
    'fyi',
    'newer',
    'Until there’s a new warning.',
    true,
  ),
  hint('docker.image_updates', 'App updates', 'fyi', 'newer', 'Until there are more.', false),
  hint(
    'memory.limit',
    'Machines running out of their memory',
    'fyi',
    'newer',
    'Until it happens again.',
    true,
  ),
  hint(
    'disk.forecast',
    'Disks filling up in the coming weeks',
    'fyi',
    'fixed',
    'Until it’s close to full.',
    true,
  ),
  // Incus (rules/incus.go), libvirt (rules/libvirt.go).
  hint('incus.no_snapshots', 'Machines not backed up', 'you', 'newer', 'Until there’s another one.', false),
  hint(
    'incus.pool_full',
    'Incus storage filling up',
    'fyi',
    'fixed',
    'Until it gets fuller.',
    true,
    'problem',
  ),
  hint('incus.warning', 'Warnings from Incus', 'fyi', 'newer', 'Until there’s a new warning.', false),
  hint(
    'libvirt.pool_full',
    'Machine storage filling up',
    'fyi',
    'fixed',
    'Until it gets fuller.',
    true,
    'problem',
  ),
  hint(
    'libvirt.no_backup',
    'Machines without a recent backup',
    'you',
    'newer',
    'Until there’s another one.',
    false,
  ),
  // unRAID (rules/unraid.go).
  hint('unraid.array_stopped', 'Array stopped', 'you', 'fixed', 'Until it’s started.', false),
  hint('unraid.parity_errors', 'Parity errors', 'you', 'newer', 'Until the next parity check.', false),
  hint('unraid.parity_old', 'Parity check overdue', 'fyi', 'newer', 'Until the next parity check.', false),
  hint('unraid.disk_errors', 'Array disk errors', 'problem', 'fixed', 'Until it gets worse.', false),
  hint('unraid.pool_full', 'Unraid storage filling up', 'problem', 'fixed', 'Until it gets fuller.', true),
  hint('unraid.plugin_updates', 'Plugin updates', 'fyi', 'newer', 'Until there are more.', false),
  hint(
    'unraid.notification',
    'Messages from Unraid',
    'fyi',
    'fixed',
    'Until there’s a new message.',
    true,
    'you',
  ),
  hint('docker.update_available', 'App updates on Unraid', 'fyi', 'newer', 'Until there are more.', false),
  hint('unraid.os_update', 'Unraid updates', 'fyi', 'newer', 'Until there’s a newer version.', false),
  // Macs (hub/model/hints.go; Whombat macos-servers.md): the Mac's page shows each of them, so all start off.
  hint('macos.helper_off', 'Whombat Helper not running', 'you', 'fixed', 'Until it runs again.', false),
  hint(
    'macos.helper_no_access',
    'Whombat Helper without Accessibility',
    'you',
    'fixed',
    'Until it has it.',
    false,
  ),
  hint('macos.screen_sign_in', 'Screen sign-in failing', 'you', 'fixed', 'Until it signs in again.', false),
  hint('macos.screen_sharing_off', 'Screen Sharing off', 'you', 'fixed', 'Until it’s on.', false),
  hint(
    'macos.agent_folder',
    'Whombat’s Mac program in a folder others can change',
    'you',
    'fixed',
    'Until it’s in a safe folder.',
    false,
  ),
  // Proxmox VE guests and storage (hub/model/hints.go).
  hint(
    'guest.backup_old',
    'Machines with an old backup',
    'problem',
    'newer',
    'Until another one falls behind.',
    false,
  ),
  hint(
    'guest.no_backup_job',
    'Machines not in a backup plan',
    'you',
    'newer',
    'Until there’s another one.',
    false,
  ),
  hint(
    'guest.agent_down',
    'Machines not reporting what’s inside',
    'fyi',
    'newer',
    'Until there’s another one.',
    false,
  ),
  hint(
    'guest.pending_changes',
    'Machines waiting for a restart',
    'you',
    'newer',
    'Until there’s another one.',
    false,
  ),
  hint('guest.snapshot_old', 'Old snapshots', 'fyi', 'newer', 'Until there’s another one.', false),
  hint(
    'storage.overcommit',
    'Storage promising more than it has',
    'fyi',
    'fixed',
    'Until it’s back to normal.',
    true,
  ),
  // Whombat's own about its helper on a server (Whombat hosts/agent-updates.ts, AU-08).
  hint(
    'agent.update_failed',
    'Whombat’s helper not updating',
    'you',
    'newer',
    'Until the next update.',
    false,
  ),
  hint(
    'agent.needs_install',
    'Whombat’s helper needing one more install',
    'you',
    'fixed',
    'Until it’s installed.',
    false,
  ),
  // Whombat's own about a server that keeps this Whombat's backups (Whombat backup-places.md BPL-11): both start off.
  hint(
    BACKUP_PLACE_CLEANUP_HINT,
    BACKUP_PLACE_TEXT.watch.cleanupName,
    'you',
    'fixed',
    'Until it clears them again.',
    false,
  ),
  hint(
    BACKUP_PLACE_SPACE_HINT,
    BACKUP_PLACE_TEXT.watch.spaceName,
    'fyi',
    'fixed',
    'Until there’s room again.',
    false,
  ),
  // Whombat's own about a restore test of a Proxmox machine (Whombat backup-trust.md): one line per machine.
  hint(
    RESTORE_TEST_FAILED_HINT,
    'Backups that didn’t come back in a restore test',
    'problem',
    'fixed',
    'Until a test of it works.',
    true,
  ),
];

const BY_RULE = new Map(HOST_WATCH_CHECKS.filter((c) => c.rule).map((c) => [c.rule as string, c]));
const BY_HINT = new Map(HOST_WATCH_CHECKS.filter((c) => c.hint).map((c) => [c.hint as string, c]));

/** The check of a rule or kind a newer hosts service has and this version doesn't know (`host.other`, `host.hint.other`). */
export const HOST_OTHER_ALERT_CHECK = 'host.other';
export const HOST_OTHER_HINT_CHECK = 'host.hint.other';

/**
 * An alert rule's check (CT-1066); for a rule this version doesn't know (a newer hosts service): its own `host.<rule>`
 * when that is a valid check id, else `host.other`, a problem about one item, ignored until it resolves.
 */
export function hostAlertCheck(rule: string): HostWatchCheck {
  const known = BY_RULE.get(rule);
  if (known) return known;
  const check = `host.${rule}`;
  return {
    check: check.length <= 80 && NOTICE_CHECK_RE.test(check) ? check : HOST_OTHER_ALERT_CHECK,
    rule,
    name: 'Other alerts',
    nature: 'problem',
    lifts: 'fixed',
    words: 'Until it’s fixed.',
    perItem: true,
    // An alert of a newer hosts service's rule is still the hosts service's alert: shown until switched off.
    startsOn: true,
  };
}

/**
 * A hint kind's check (CT-1066); for a kind this version doesn't know: its own `host.hint.<kind>` when valid, else
 * `host.hint.other`, a heads-up about one item.
 */
export function hostHintCheck(kind: string): HostWatchCheck {
  const known = BY_HINT.get(kind);
  if (known) return known;
  const check = `host.hint.${kind}`;
  return {
    check: check.length <= 80 && NOTICE_CHECK_RE.test(check) ? check : HOST_OTHER_HINT_CHECK,
    hint: kind,
    name: 'Other hints',
    nature: 'fyi',
    lifts: 'fixed',
    words: 'Until it changes.',
    perItem: true,
    startsOn: false,
  };
}

/** Limits the hosts service accepts for alert rules. */
export const HOST_WATCH_LIMITS = {
  'sensor.temp_high': { unit: '°C', min: 1, max: 150 },
  'sensor.temp_critical': { unit: '°C', min: 1, max: 150 },
  'disk.wear_high': { unit: '%', min: 1, max: 100, defaultValue: 75 },
  'disk.wear_critical': { unit: '%', min: 1, max: 100, defaultValue: 90 },
  'disk.space_high': { unit: '%', min: 1, max: 100, defaultValue: 90 },
  'fs.inodes_high': { unit: '%', min: 1, max: 100, defaultValue: 90 },
} as const;

export function hostWatchLimit(rule: string | undefined) {
  if (rule && Object.hasOwn(HOST_WATCH_LIMITS, rule)) {
    return HOST_WATCH_LIMITS[rule as keyof typeof HOST_WATCH_LIMITS];
  }
}

const BY_CHECK = new Map(HOST_WATCH_CHECKS.map((c) => [c.check as string, c]));

/** Whether Whombat watches a server's check from the start, by its id; a hint this version doesn't know starts off. */
export function hostCheckStartsOn(check: string): boolean {
  const known = BY_CHECK.get(check);
  if (known) return known.startsOn;
  return !check.startsWith('host.hint.');
}

/** A hint's kind of line: `warnNature` for a warning where the check has one, else its `nature`. */
export function hostHintNature(c: HostWatchCheck, severity: 'warning' | 'info'): NoticeNature {
  return severity === 'warning' && c.warnNature ? c.warnNature : c.nature;
}

/**
 * The item a server's line is about (QN-03): the hosts service's entity as it is (`fs:/mnt/data`, `pool:tank`,
 * `sensor:coretemp-0`), for a check whose lines are about one item each; none for the server as a whole (`host`) or a
 * check that isn't per item. The runtime and the client both key quiet lines and exceptions by it.
 */
export function hostNoticeSubjectId(c: HostWatchCheck, entity: string | undefined): string | undefined {
  if (!c.perItem || !entity || entity === 'host') return undefined;
  return entity.slice(0, 160);
}

/**
 * An entity as people read it, when nothing better is known (a guest's name is): without the hosts service's prefix
 * (`fs:/mnt/data` → “/mnt/data”, `pool:tank` → “tank”, `pve/101` stays), at most 80 characters.
 */
export function hostEntityName(entity: string): string {
  const m = /^[a-z][a-z-]*:(.+)$/.exec(entity);
  return (m ? (m[1] as string) : entity).slice(0, 80);
}

/**
 * A check's name and Ignore words in a locale. A check this version doesn't know reads as “Other alerts” or “Other
 * hints”; English keeps the check's own words.
 */
export function hostWatchCheckWords(
  c: Pick<HostWatchCheck, 'check' | 'name' | 'words' | 'hint'>,
  locale?: string | null,
): { name: string; words: string } {
  if (isEnglishLocale(locale)) return { name: c.name, words: c.words };
  const tr = coreTranslator(locale);
  const own = `hostWatch.name.${c.check}`;
  const id = hasCoreMessage(own)
    ? c.check
    : c.hint !== undefined
      ? HOST_OTHER_HINT_CHECK
      : HOST_OTHER_ALERT_CHECK;
  const name = `hostWatch.name.${id}`;
  const words = `hostWatch.words.${id}`;
  return {
    name: hasCoreMessage(name) ? tr.t(name) : c.name,
    words: hasCoreMessage(words) ? tr.t(words) : c.words,
  };
}
