/**
 * A server's operating-system updates on the web and the phone (Whombat server-updates.md SWU-04…SWU-14; app
 * server-updates-app.md AP-2860…): the Updates and Restart lines' words, which buttons show for which state and
 * server (Full control, the runtime's `hosts.package_updates`, not on Unraid), the install question, the
 * running package task and the last one's result, the waiting packages security first, and the updates hint's way out.
 * Pure.
 */
import type {
  HostHint,
  HostInspectResult,
  HostPackageLast,
  HostPackageOp,
  HostPackageTask,
  HostRemoteControl,
  HostSystem,
  HostTask,
} from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { HOSTS_UPDATES_WORDS } from '../i18n/messages/connectionsHosts/hostsBasics';
import { formatAgoIso } from './format';

/* The report (contracts 0.98.0, CT-500…CT-502) ------------------------------------------------------------------ */

/** Check or Install. */
export type PackageOp = HostPackageOp;

/** What an ended package task did (`HostTask.packages`). */
export type PackageTaskOutcome = NonNullable<HostTask['packages']>;

/** The parts of a server's system report the updates read. */
export type UpdatesSystem = Pick<
  HostSystem,
  'packageManager' | 'updates' | 'securityUpdates' | 'updatesCheckedAt' | 'updatesError' | 'rebootRequired'
> & {
  rebootReason?: string | null;
  packageTask?: HostPackageTask | null;
  packageLast?: HostPackageLast | null;
};

/* The words (SWU-04, SWU-07, SWU-10, SWU-13) -------------------------------------------------------------------- */

/** The words of a server's updates, in a locale (English when none is given). */
export function updatesWords(locale?: string | null) {
  const w = clientTree(locale, HOSTS_UPDATES_WORDS);
  return {
    title: w.title,
    restartTitle: w.restartTitle,
    install: w.install,
    check: w.check,
    showLog: w.showLog,
    restartNow: w.restartNow,
    running: { ...w.running } as Record<PackageOp, string>,
    upToDate: w.upToDate,
    noReport: w.noReport,
    restartNeeded: w.restartNeeded,
    restartNotNeeded: w.restartNotNeeded,
    nothingWaiting: w.nothingWaiting,
    /** The install question. */
    confirmTitle: (n: number, server: string) => w.confirmTitle(n, { server }),
    confirmBody: (server: string) => interpolate(w.confirmBody, { server }),
    /** Watch only, Restart or consoles only. */
    needsFullControl: (server: string) => interpolate(w.needsFullControl, { server }),
    /** The package lock stayed held. */
    busy: (server: string) => interpolate(w.busy, { server }),
    /**
     * The updates hint's way out: the web's System tab; the phone's Updates screen, short as “Look into it” so the
     * hint's words keep their room, also for the restart hint.
     */
    wayOut: { ...w.wayOut },
    /** The toasts and notes of a package task started from here. */
    started: (op: PackageOp, server: string) => interpolate(w.started[opOf(op)], { server }),
    /** What the task dialog and its toasts call it (“Updates on pve-02 failed: …”). */
    what: (op: PackageOp, server: string) => interpolate(w.what[opOf(op)], { server }),
    finished: (op: PackageOp, server: string) => interpolate(w.finished[opOf(op)], { server }),
    failed: (op: PackageOp, server: string) => interpolate(w.failed[opOf(op)], { server }),
  };
}

export const UPDATES_WORDS = updatesWords('en');

/** Anything but Install reads as a check. */
function opOf(op: PackageOp): PackageOp {
  return op === 'install' ? 'install' : 'check';
}

/** The Updates line's words as the agent reports them (the System tab's, unchanged). */
export function updatesLineText(s: UpdatesSystem, locale?: string | null): string {
  const w = clientTree(locale, HOSTS_UPDATES_WORDS);
  if (s.updatesError) return interpolate(w.line.couldntCheck, { error: s.updatesError });
  if (s.updates == null) return w.noReport;
  if (s.updates === 0) return w.upToDate;
  return s.securityUpdates
    ? w.line.waitingSecurity(s.updates, { security: s.securityUpdates })
    : w.line.waiting(s.updates);
}

/** The Restart line's words: “Needed: a new kernel”, “Not needed”. */
export function restartLineText(
  s: Pick<UpdatesSystem, 'rebootRequired' | 'rebootReason'>,
  locale?: string | null,
): string {
  const w = clientTree(locale, HOSTS_UPDATES_WORDS);
  if (!s.rebootRequired) return w.restartNotNeeded;
  return s.rebootReason ? interpolate(w.line.restartWhy, { reason: s.rebootReason }) : w.restartNeeded;
}

/** A package task's own words as the end of “… stopped: {reason}.”: its first line, trimmed, without its stop. */
function reasonOf(message: string | null | undefined): string {
  const line =
    (message ?? '')
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '';
  const short = line.length > 160 ? `${line.slice(0, 157).trimEnd()}…` : line;
  return short.replace(/[.!]+$/, '');
}

/**
 * How a package task ended, in one or two sentences (SWU-10): “Installed 23 updates.”, “Nothing to install.”,
 * “Installing updates stopped: {reason}.”, SWU-04's busy sentence, a stop at its time limit; a good Install with a
 * note (SWU-06's enterprise repository) adds it. A good Check says nothing: the Updates line's “checked” says it.
 */
export function packageResultText(
  last: Pick<HostPackageLast, 'op' | 'status' | 'installed' | 'message'> & { code?: string | null },
  server: string,
  locale?: string | null,
): string | null {
  const w = clientTree(locale, HOSTS_UPDATES_WORDS);
  const r = w.result;
  const verb = r.verb[last.op];
  if (last.status === 'failed') {
    if (last.code === 'busy') return interpolate(w.busy, { server });
    // Check and Install may run this long on the server; a task stopped there says so.
    if (last.code === 'timeout') return interpolate(r.timeout, { verb, limit: r.limit[last.op] });
    const why = reasonOf(last.message);
    return why ? interpolate(r.stoppedWhy, { verb, why }) : interpolate(r.stopped, { verb });
  }
  if (last.op === 'check') return null;
  const done =
    last.installed == null ? r.installedAll : last.installed === 0 ? r.nothing : r.installed(last.installed);
  return hasNote(last.message) ? `${done} ${reasonOf(last.message)}.` : done;
}

/** A good task's message that says something (SWU-06's enterprise repository), not “OK”. */
function hasNote(message: string | null | undefined): boolean {
  const m = reasonOf(message);
  return !!m && m.toUpperCase() !== 'OK';
}

/**
 * An ended task's result in its dialog or sheet (`HostTask.packages`): what it installed, the packages it kept back,
 * its warning (SWU-06). Null for a task without it.
 */
export function packageTaskOutcomeText(
  op: PackageOp,
  p: PackageTaskOutcome | null | undefined,
  server: string,
  locale?: string | null,
): string | null {
  if (!p) return null;
  const r = clientTree(locale, HOSTS_UPDATES_WORDS).result;
  const parts: string[] = [];
  const main = packageResultText(
    { op, status: 'ok', installed: p.installed, message: p.warning },
    server,
    locale,
  );
  if (main) parts.push(main);
  else if (hasNote(p.warning)) parts.push(`${reasonOf(p.warning)}.`);
  if (p.keptBack.length) {
    const list = p.keptBack.slice(0, 5).join(', ');
    parts.push(
      p.keptBack.length > 5
        ? interpolate(r.keptBackMore, { list, more: p.keptBack.length - 5 })
        : interpolate(r.keptBack, { list }),
    );
  }
  return parts.length ? parts.join(' ') : null;
}

/** A package task's op from its report or its id's dialog (`packages.install` → `install`). */
export function packageOpOf(op: string): PackageOp | null {
  const o = op.replace(/^packages\./, '');
  return o === 'check' || o === 'install' ? o : null;
}

/* Who may, and what shows (SWU-07, SWU-10, SWU-14) -------------------------------------------------------------- */

/** A result stays beside the Updates line this long (a week), then the line alone says how it is. */
export const PACKAGE_RESULT_SHOWN_MS = 7 * 24 * 3600_000;

export interface ServerUpdatesInput {
  /** The server's name in the words (“pve-02”). */
  server: string;
  system: UpdatesSystem | null | undefined;
  remoteControl: Pick<HostRemoteControl, 'manage' | 'hostPower'>;
  /** An Unraid server: its plugins and OS have their own updates (SWU-01). */
  unraid: boolean;
  /** Its agent is connected (an offline one can't be asked). */
  connected: boolean;
  now: number;
  /** The language the words are in (English when none is given). */
  locale?: string | null;
}

export type UpdatesTone = 'ok' | 'warn' | 'bad' | 'mut';

export interface ServerUpdatesView {
  /** Whombat can install this server's updates at all: the new parts show (else the lines are as they were). */
  available: boolean;
  /** The Updates line: its words, tone and when the list was read. */
  line: { text: string; tone: UpdatesTone; checked: string | null };
  /** The package task running there (also one started on another device), its log one click away. */
  running: { taskId: string; op: PackageOp; text: string } | null;
  /** How the last one ended, with when (a week at most). */
  result: { text: string; tone: Exclude<UpdatesTone, 'mut'>; when: string } | null;
  /** Updates waiting (the question's count). */
  count: number;
  /** The person may start and stop package tasks here (Full control, the agent there). */
  may: boolean;
  install: boolean;
  check: boolean;
  /** Why they can't be installed here (SWU-07), while updates wait. */
  note: string | null;
  restart: { text: string; tone: 'ok' | 'warn'; button: boolean };
}

/** Whether the agent reads this server's package manager (it lists updates, or said why it couldn't). */
function reportsUpdates(s: UpdatesSystem): boolean {
  return s.updates != null || !!s.updatesError;
}

export function serverUpdatesView(input: ServerUpdatesInput): ServerUpdatesView {
  const locale = input.locale;
  const words = updatesWords(locale);
  const s = input.system ?? null;
  const available = !!s && !input.unraid && reportsUpdates(s);
  const manage = input.remoteControl.manage === true;
  const may = available && manage && input.connected;
  const task = available ? (s?.packageTask ?? null) : null;
  const count = s?.updates ?? 0;
  const lineText = s ? updatesLineText(s, locale) : words.noReport;
  const last = available && !task ? (s?.packageLast ?? null) : null;
  const lastAt = last ? Date.parse(last.finishedAt) : Number.NaN;
  const resultText =
    last && Number.isFinite(lastAt) && input.now - lastAt <= PACKAGE_RESULT_SHOWN_MS
      ? packageResultText(last, input.server, locale)
      : null;
  return {
    available,
    line: {
      text: task ? words.running[task.op] : lineText,
      tone: task ? 'mut' : s?.securityUpdates ? 'warn' : 'ok',
      checked: s?.updatesCheckedAt
        ? interpolate(clientTree(locale, HOSTS_UPDATES_WORDS).line.checked, {
            ago: formatAgoIso(s.updatesCheckedAt, input.now, locale),
          })
        : null,
    },
    running: task ? { taskId: task.id, op: task.op, text: words.running[task.op] } : null,
    result:
      last && resultText
        ? {
            text: resultText,
            tone: last.status === 'failed' ? 'bad' : hasNote(last.message) ? 'warn' : 'ok',
            when: formatAgoIso(last.finishedAt, input.now, locale),
          }
        : null,
    count,
    may,
    install: may && !task && count > 0,
    check: may && !task,
    note: available && !manage && count > 0 ? words.needsFullControl(input.server) : null,
    restart: {
      text: s ? restartLineText(s, locale) : words.restartNotNeeded,
      tone: s?.rebootRequired ? 'warn' : 'ok',
      button:
        available && input.connected && s?.rebootRequired === true && input.remoteControl.hostPower !== false,
    },
  };
}

/* The waiting packages (SWU-12) ------------------------------------------------------------------------------- */

type PackageItem = Extract<HostInspectResult, { kind: 'updates' }>['items'][number];

export interface PackageRow {
  name: string;
  /** “3.5.1-1 → 3.5.1-1+deb13u1”, or the new one alone. */
  versions: string;
  security: boolean;
  source: string | null;
  label: string;
}

/** The waiting packages, security first, then by name. */
export function packageRows(items: readonly PackageItem[], locale?: string | null): PackageRow[] {
  const w = clientTree(locale, HOSTS_UPDATES_WORDS);
  return [...items]
    .sort((a, b) => Number(!!b.security) - Number(!!a.security) || a.name.localeCompare(b.name))
    .map((u) => {
      const versions = u.current ? `${u.current} → ${u.new}` : u.new;
      return {
        name: u.name,
        versions,
        security: !!u.security,
        source: u.source ?? null,
        label: interpolate(u.security ? w.packageLabelSecurity : w.packageLabel, {
          name: u.name,
          versions: u.current ? interpolate(w.versionsTo, { current: u.current, new: u.new }) : u.new,
        }),
      };
    });
}

/* The hint (SWU-13) ------------------------------------------------------------------------------------------- */

/** The hub's hint that updates wait (`system.updates`, whombat-hosts `rules/hints.go`). */
export function isUpdatesHint(h: Pick<HostHint, 'kind'>): boolean {
  return h.kind === 'system.updates';
}

/** The hub's hint that the server needs a restart (`system.reboot`): on the phone it opens Updates too (AP-2887). */
export function isRebootHint(h: Pick<HostHint, 'kind'>): boolean {
  return h.kind === 'system.reboot';
}
