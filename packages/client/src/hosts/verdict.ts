/**
 * The verdict at the top of a server's or a machine's page (Whombat server-pages.md): one plain sentence that answers
 * “is it all right, and does it need me?” before any figure — “thetitan is fine: 33 apps and 6 machines are running.”,
 * “blackbox has a problem: The disk array failed.” It reads the same lines Worth a look shows (their kind, tone and
 * whether they are quiet), so the sentence and the card never disagree. Pure.
 */
import { type HostGuest, type HostHint, noticeNature, type ThingPageNotice } from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { HOSTS_ACTIONS_WORDS } from '../i18n/messages/connectionsHosts/actions';
import { guestHints } from './lifecycle';

const words = (locale?: string | null) => clientTree(locale, HOSTS_ACTIONS_WORDS).verdict;

export type VerdictTone = 'ok' | 'warn' | 'bad' | 'mut';

export interface Verdict {
  tone: VerdictTone;
  /** One or two short sentences. */
  sentence: string;
}

type Line = Pick<ThingPageNotice, 'title' | 'tone' | 'nature' | 'link' | 'quiet'>;

/** What runs on a server, temporary machines left out: Docker containers are apps, the rest machines. */
export interface RunningCounts {
  apps: { running: number; total: number };
  machines: { running: number; total: number };
}

export interface ServerVerdictInput {
  name: string;
  status: 'ok' | 'warn' | 'bad' | 'offline' | 'pending';
  /** The hosts service's few words on a status that isn't ok (“running warm”). */
  statusNote?: string | null;
  /** Worth a look's lines, the banner's first, in the card's order. */
  lines: readonly Line[];
  running?: RunningCounts | null;
  /** When Whombat last heard from it (“2 h ago”), for an offline server. */
  lastHeard?: string | null;
  /** The reader's language (English when none is given). */
  locale?: string | null;
}

function title(l: Pick<Line, 'title'>): string {
  return l.title.trim().replace(/[.!…]+$/, '');
}

/** “33 apps and 6 machines are running”, “1 machine is running”, “Nothing on it is running”; null without any. */
export function runningWords(r: RunningCounts | null | undefined, locale?: string | null): string | null {
  if (!r) return null;
  const w = words(locale);
  const apps = r.apps.running ? w.apps(r.apps.running) : null;
  const machines = r.machines.running ? w.machines(r.machines.running) : null;
  if (!apps && !machines) return r.apps.total + r.machines.total > 0 ? w.nothingRunning : null;
  const what = apps && machines ? interpolate(w.both, { apps, machines }) : (apps ?? machines ?? '');
  const one = !(apps && machines) && (r.apps.running || r.machines.running) === 1;
  return interpolate(one ? w.isRunning : w.areRunning, { what });
}

/**
 * A server's verdict: offline and waiting servers say so; a problem names the worst one; otherwise it is fine, with
 * what runs on it, and how many things wait for the person (the one by its title).
 */
export function serverVerdict(input: ServerVerdictInput): Verdict {
  const { name, locale } = input;
  const w = words(locale);
  if (input.status === 'offline')
    return {
      tone: 'bad',
      sentence: `${interpolate(w.offline, { name })}${input.lastHeard ? interpolate(w.lastHeard, { when: input.lastHeard }) : ''}`,
    };
  if (input.status === 'pending') return { tone: 'mut', sentence: interpolate(w.pending, { name }) };
  const asking = input.lines.filter((l) => !l.quiet && noticeNature(l) !== 'fyi');
  const problems = asking.filter((l) => noticeNature(l) === 'problem');
  const worst = problems.find((l) => l.tone === 'bad') ?? problems[0];
  if (worst) {
    const others = asking.length - 1;
    const more = others ? w.moreNeed(others) : '';
    return {
      tone: problems.some((l) => l.tone === 'bad') || input.status === 'bad' ? 'bad' : 'warn',
      sentence: interpolate(w.problem, { name, title: title(worst), more }),
    };
  }
  const yours = asking.length;
  const note = input.statusNote?.trim();
  if (input.status !== 'ok' && note) {
    const said = note.replace(/[.!]+$/, '');
    // “running warm” reads as it is (“pve-02 is running warm.”); any other note follows a colon.
    const first = /^running\b/i.test(said)
      ? interpolate(w.runningNote, { name, note: `${said.charAt(0).toLowerCase()}${said.slice(1)}` })
      : interpolate(w.note, { name, note: `${said.charAt(0).toUpperCase()}${said.slice(1)}` });
    return {
      tone: input.status === 'bad' ? 'bad' : 'warn',
      sentence: `${first}${yours ? ` ${w.needYou(yours)}.` : ''}`,
    };
  }
  const running = runningWords(input.running, locale);
  const first = running
    ? interpolate(w.fineRunning, { name, running: `${running.charAt(0).toLowerCase()}${running.slice(1)}` })
    : interpolate(w.fine, { name });
  if (!yours) return { tone: 'ok', sentence: first };
  return {
    tone: 'ok',
    sentence:
      yours === 1
        ? interpolate(w.oneThing, { first, need: w.needYou(1), title: title(asking[0] as Line) })
        : interpolate(w.things, { first, need: w.needYou(yours) }),
  };
}

export interface GuestVerdictInput {
  name: string;
  state: 'running' | 'stopped' | 'unhealthy' | 'paused';
  /** Its server can't be reached: what Whombat knows is from its last report. */
  serverOffline?: boolean;
  /** Its own lines (no backup plan, a restart to apply changes), in their order. */
  lines: readonly Pick<ThingPageNotice, 'title' | 'tone'>[];
  /** The reader's language (English when none is given). */
  locale?: string | null;
}

const GUEST_STATE = {
  running: { words: 'guestRunning', tone: 'ok' },
  unhealthy: { words: 'guestUnhealthy', tone: 'bad' },
  stopped: { words: 'guestStopped', tone: 'mut' },
  paused: { words: 'guestPaused', tone: 'warn' },
} as const satisfies Record<GuestVerdictInput['state'], { words: string; tone: VerdictTone }>;

/** A machine's verdict: its state in words, then what needs the person there (the one by its title). */
export function guestVerdict(input: GuestVerdictInput): Verdict {
  const w = words(input.locale);
  const name = input.name;
  if (input.serverOffline) return { tone: 'mut', sentence: interpolate(w.serverOffline, { name }) };
  const s = GUEST_STATE[input.state];
  const first = interpolate(w[s.words], { name });
  const n = input.lines.length;
  if (!n)
    return {
      tone: s.tone,
      sentence: input.state === 'running' ? interpolate(w.runningFine, { name }) : first,
    };
  const tone: VerdictTone =
    s.tone === 'bad' || input.lines.some((l) => l.tone === 'bad') ? 'bad' : s.tone === 'ok' ? 'warn' : s.tone;
  return {
    tone,
    sentence:
      n === 1
        ? interpolate(w.oneThing, { first, need: w.needYou(1), title: title(input.lines[0] as Line) })
        : interpolate(w.things, { first, need: w.needYou(n) }),
  };
}

/**
 * A machine's verdict from what Whombat knows of it: its own hints (no backup plan, an old backup, changes waiting for
 * a restart) and its server's warnings about it; heads-ups don't count.
 */
export function machineVerdict(
  g: HostGuest,
  serverHints: readonly Pick<HostHint, 'entity' | 'title' | 'severity'>[],
  now: number,
  locale?: string | null,
): Verdict {
  const lines: Pick<ThingPageNotice, 'title' | 'tone'>[] = guestHints(g, now, locale).map((h) => ({
    title: h.title,
    tone: h.tone === 'bad' ? 'bad' : 'warn',
  }));
  for (const h of serverHints)
    if (
      h.severity === 'warning' &&
      (h.entity === g.id || h.entity === g.name) &&
      !lines.some((l) => l.title === h.title)
    )
      lines.push({ title: h.title, tone: 'warn' });
  return guestVerdict({
    name: g.name,
    state: g.state,
    serverOffline: g.serverOnline === false,
    lines,
    locale,
  });
}
