/**
 * A server's operating-system updates on Whombat's side, the pure parts (docs/decisions/server-updates.md SWU-01…SWU-15;
 * server-updates-server.md SWU-S01…): the packages an agent may name, the waiting updates Whombat last read per server
 * (an approval's words are written without a lookup: “install 23 updates on PVE-02”), the two calls and their outcomes
 * in words (SWU-08: “PVE-02 is up to date: 23 updates installed. It needs a restart for the new kernel.”), and the
 * hub's refusals of the two ops in SWU's sentences.
 */
import {
  HOST_PACKAGE_NAME_PATTERN,
  HOST_PACKAGES_MAX,
  type HostPackageLast,
  type HostPackageTask,
  type HostSystem,
  type HostTask,
} from '@whombat/core';
import { ConnectionArgumentError } from '../connections/request';
import type { HostsError } from './client';

type Args = Readonly<Record<string, unknown>>;

/** At most this many waiting packages in `server_updates`. */
export const UPDATES_LIST_MAX = 500;

/** What a server's report says about its updates (`HostSystem`; `packageTask`/`packageLast` since 0.98.0, CT-501). */
export type UpdatesReport = Partial<Omit<HostSystem, 'packageTask' | 'packageLast'>> & {
  packageTask?: HostPackageTask | null;
  packageLast?: HostPackageLast | null;
};

/** What a finished package task reports (`HostTask.packages`, CT-501). */
export type PackagesResult = NonNullable<HostTask['packages']>;

/** The packages an agent named for an Install, checked: null when none (everything waiting). */
export function packagesArg(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.some((p) => typeof p !== 'string'))
    throw new ConnectionArgumentError('packages: a list of package names, like ["nginx", "openssl"].');
  const names = [...new Set((raw as string[]).map((p) => p.trim()).filter(Boolean))];
  if (names.length === 0) return null;
  if (names.length > HOST_PACKAGES_MAX)
    throw new ConnectionArgumentError(`packages: at most ${HOST_PACKAGES_MAX}.`);
  const bad = names.find((p) => !HOST_PACKAGE_NAME_PATTERN.test(p));
  if (bad)
    throw new ConnectionArgumentError(
      `packages: “${bad.slice(0, 60)}” isn’t a package name (letters, digits and + . _ : @ ~ -).`,
    );
  return names;
}

/* What Whombat last read --------------------------------------------------------------------------------------------- */

/** How long a read count names an Install's question (an agent reads the list just before it asks). */
export const WAITING_TTL_MS = 60 * 60 * 1000;

const waiting = new Map<string, { count: number; at: number }>();

/** Notes how many updates wait on a server, from a report Whombat read (`server_updates`, `server_detail`). */
export function noteWaitingUpdates(
  serverId: string,
  count: number | null | undefined,
  now = Date.now(),
): void {
  const key = serverId.trim().toLowerCase();
  if (typeof count === 'number' && Number.isInteger(count) && count >= 0)
    waiting.set(key, { count, at: now });
  else waiting.delete(key);
}

/** How many updates wait on a server as Whombat last read it within the hour, or null. */
export function waitingUpdates(serverId: string, now = Date.now()): number | null {
  const w = waiting.get(serverId.trim().toLowerCase());
  return w && now - w.at <= WAITING_TTL_MS ? w.count : null;
}

/* Words ------------------------------------------------------------------------------------------------------------- */

const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/** “1 update”, “23 updates”. */
export const updatesCount = (n: number) => (n === 1 ? '1 update' : `${n} updates`);

/** Names as words: “nginx”, “nginx and openssl”, “a, b and c”, “a, b, c and 4 more”. */
export function listWords(names: readonly string[], max = 3): string {
  const shown = names.slice(0, max);
  if (names.length > max) return `${shown.join(', ')} and ${names.length - max} more`;
  if (shown.length <= 1) return shown[0] ?? '';
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

/** The packages an Install named, from its arguments (unchecked: words only). */
function namedPackages(args: Args): string[] {
  return Array.isArray(args.packages)
    ? args.packages.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim())
    : [];
}

/**
 * `server_update` in words: what the approval asks (“install 23 updates on PVE-02”, “install nginx and openssl on
 * web-01”) and what Whombat is doing once a yes ran it. `waitingCount`: the updates Whombat last read there, if any.
 */
export function updatePhrase(
  args: Args,
  server: string,
  waitingCount: number | null,
): { ask: string; doing: string } {
  if (args.action === 'check')
    return { ask: `check ${server} for updates`, doing: `Checking ${server} for updates` };
  const named = namedPackages(args);
  if (named.length > 3)
    return {
      ask: `install updates of ${named.length} packages on ${server}`,
      doing: `Installing updates of ${named.length} packages on ${server}`,
    };
  if (named.length)
    return {
      ask: `install ${listWords(named)} on ${server}`,
      doing: `Installing ${listWords(named)} on ${server}`,
    };
  if (waitingCount)
    return {
      ask: `install ${updatesCount(waitingCount)} on ${server}`,
      doing: `Installing ${updatesCount(waitingCount)} on ${server}`,
    };
  return {
    ask: `install the waiting updates on ${server}`,
    doing: `Installing the waiting updates on ${server}`,
  };
}

/** The signed line and Done recently's title of a started Check or Install (SWU, the build brief §2). */
export function updateChangeText(op: 'packages.check' | 'packages.install', server: string): string {
  return op === 'packages.check' ? `Checked ${server} for updates` : `Installed updates on ${server}`;
}

/** What a restart is for, from the server's reason (hosts `rebootRequired`): “It needs a restart for …”. */
export function restartWords(reason: string | null | undefined): string {
  const r = (reason ?? '').trim();
  if (/^kernel\b/i.test(r) || /\bkernel\b.*\binstalled\b/i.test(r))
    return 'It needs a restart for the new kernel.';
  const pkgs = /need a reboot:\s*(.+)$/i.exec(r)?.[1];
  if (pkgs) {
    const more = /^(.*) and (\d+) more$/.exec(pkgs.trim());
    const names = (more ? (more[1] as string) : pkgs)
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const extra = more ? Number(more[2]) : 0;
    const words = extra ? `${names.join(', ')} and ${extra} more` : listWords(names, names.length);
    if (words) return `It needs a restart for ${words}.`;
  }
  return 'It needs a restart to finish.';
}

/** The agent's own sentence, one line, ending in a full stop (a warning, SWU-06). */
function sentence(text: string): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim()) ?? '').trim().slice(0, 300);
  if (!line) return '';
  const capped = cap(line);
  return /[.!?…]$/.test(capped) ? capped : `${capped}.`;
}

/**
 * The one message when an Install a Whombat started ended well (SWU-08), from the task's result and the server's report
 * after it: “PVE-02 is up to date: 23 updates installed. It needs a restart for the new kernel.” `report` is null when
 * the report after the task isn't there yet (then the restart isn't mentioned).
 */
export function installedText(
  server: string,
  result: PackagesResult | null,
  report: Pick<UpdatesReport, 'rebootRequired' | 'rebootReason'> | null,
  named: readonly string[] = [],
): string {
  const parts: string[] = [];
  const n = result?.installed ?? null;
  const kept = result?.keptBack ?? [];
  const held =
    kept.length === 1
      ? `${kept[0]} was held back`
      : `${kept.length} updates were held back (${listWords(kept)})`;
  if (n === null) parts.push(`The updates on ${server} are installed.`);
  else if (kept.length)
    parts.push(
      n > 0
        ? `${cap(updatesCount(n))} installed on ${server}, ${held}.`
        : `Nothing was installed on ${server}: ${held}.`,
    );
  else if (named.length) {
    const what = named.length > 3 ? `The ${named.length} packages` : listWords(named);
    const are = named.length === 1 ? 'is' : 'are';
    parts.push(
      n > 0
        ? `${what} on ${server} ${are} up to date: ${updatesCount(n)} installed.`
        : `${what} on ${server} ${are} up to date.`,
    );
  } else
    parts.push(
      n > 0 ? `${server} is up to date: ${updatesCount(n)} installed.` : `${server} was already up to date.`,
    );
  if (report?.rebootRequired) parts.push(restartWords(report.rebootReason));
  const warning = result?.warning ? sentence(result.warning) : '';
  if (warning) parts.push(warning);
  return parts.join(' ');
}

/** The one message when a Check a Whombat started ended well: “PVE-02 has 23 updates waiting, 4 for security.” */
export function checkedText(server: string, report: UpdatesReport | null): string | null {
  const n = report?.updates;
  if (typeof n !== 'number') return null;
  const restart = report?.rebootRequired ? ` ${restartWords(report.rebootReason)}` : '';
  if (n === 0) return `${server} is up to date.${restart}`;
  const security = report?.securityUpdates ? `, ${report.securityUpdates} for security` : '';
  return `${server} has ${updatesCount(n)} waiting${security}.${restart}`;
}

/**
 * Whether a server's report was made after a package task ended (the agent reads the updates and the reboot check again
 * at once, SWU-05): no package task runs, and the updates were read after the last one ended — by the agent's own clock
 * when the report says when that was (`packageLast`, which must be this task's or later: `since` is when Whombat started
 * following it), else after Whombat heard the end (`endedAt`).
 */
export function reportAfterTask(report: UpdatesReport | null, since: number, endedAt: number): boolean {
  if (!report || report.packageTask) return false;
  const checked = Date.parse(report.updatesCheckedAt ?? '');
  if (!Number.isFinite(checked)) return false;
  const last = Date.parse(report.packageLast?.finishedAt ?? '');
  if (Number.isFinite(last)) return last >= since - 60_000 && checked >= last;
  return checked >= endedAt - 5_000;
}

/** The words of a package task's end that has a code (whombat-hosts: the lock still held, the time limit). */
export function packageTaskCodeText(
  op: 'packages.check' | 'packages.install',
  code: string | null | undefined,
  server: string,
): string | null {
  if (code === 'busy') return busyText(server);
  if (code === 'timeout')
    return op === 'packages.install'
      ? `Installing updates on ${server} didn’t finish within two hours, so it was stopped.`
      : `Checking ${server} for updates didn’t finish within ten minutes, so it was stopped.`;
  return null;
}

/** SWU-04: the package lock was still held after two minutes. */
export const busyText = (server: string) =>
  `Another program is installing packages on ${server} right now. Try again in a few minutes.`;

/* Refusals ----------------------------------------------------------------------------------------------------------- */

/** An older agent's answer to an op it doesn't know (the hosts service's broker: “unknown operation”). */
const OLD_AGENT = /unknown operation/i;

/**
 * The hub's refusal of a Check or Install in SWU's words (SWU-01, SWU-04, SWU-07, SWU-14), or null for the general
 * words (`hostsErrorText`). The agent's own plain sentences pass (TrueNAS, NixOS, Unraid, no package manager, pacman
 * with named packages).
 */
export function packagesRefusalText(err: HostsError, op: string, server: string): string | null {
  const install = op !== 'packages.check';
  switch (err.code) {
    case 'manage_disabled':
    case 'remote_control_disabled':
      return install
        ? `Installing updates needs Full control on ${server}.`
        : `Checking for updates needs Full control on ${server}.`;
    case 'busy':
    case 'action_in_progress':
    case 'locked':
      return /lock/i.test(err.detail ?? '')
        ? busyText(server)
        : `${server} is already checking for or installing updates. Try again when that’s done.`;
    case 'unsupported':
    case 'unsupported_action':
      if (!err.detail || OLD_AGENT.test(err.detail)) return `Update Whombat’s helper on ${server} first.`;
      return sentence(err.detail);
    case 'not_allowed':
      return err.detail ? sentence(err.detail) : null;
    default:
      return null;
  }
}
