/**
 * The verdict at the top of a server's or a machine's page (Whombat server-pages.md): one plain sentence that answers
 * “is it all right, and does it need me?” before any figure — “thetitan is fine: 33 apps and 6 machines are running.”,
 * “blackbox has a problem: The disk array failed.” It reads the same lines Worth a look shows (their kind, tone and
 * whether they are quiet), so the sentence and the card never disagree. Pure.
 */
import { type HostGuest, type HostHint, noticeNature, type ThingPageNotice } from '@whombat/core/domain';
import { plural } from './format';
import { guestHints } from './lifecycle';

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
}

function title(l: Pick<Line, 'title'>): string {
  return l.title.trim().replace(/[.!…]+$/, '');
}

/** “33 apps and 6 machines are running”, “1 machine is running”, “Nothing on it is running”; null without any. */
export function runningWords(r: RunningCounts | null | undefined): string | null {
  if (!r) return null;
  const parts = [
    r.apps.running ? plural(r.apps.running, 'app') : null,
    r.machines.running ? plural(r.machines.running, 'machine') : null,
  ].filter((p): p is string => !!p);
  if (!parts.length) return r.apps.total + r.machines.total > 0 ? 'Nothing on it is running' : null;
  const one = parts.length === 1 && (r.apps.running || r.machines.running) === 1;
  return `${parts.join(' and ')} ${one ? 'is' : 'are'} running`;
}

/** “One thing needs you”, “3 things need you”. */
function needYou(n: number): string {
  return n === 1 ? 'One thing needs you' : `${n} things need you`;
}

/**
 * A server's verdict: offline and waiting servers say so; a problem names the worst one; otherwise it is fine, with
 * what runs on it, and how many things wait for the person (the one by its title).
 */
export function serverVerdict(input: ServerVerdictInput): Verdict {
  const { name } = input;
  if (input.status === 'offline')
    return {
      tone: 'bad',
      sentence: `${name} isn’t checking in.${input.lastHeard ? ` Whombat last heard from it ${input.lastHeard}.` : ''}`,
    };
  if (input.status === 'pending') return { tone: 'mut', sentence: `${name} hasn’t checked in yet.` };
  const asking = input.lines.filter((l) => !l.quiet && noticeNature(l) !== 'fyi');
  const problems = asking.filter((l) => noticeNature(l) === 'problem');
  const worst = problems.find((l) => l.tone === 'bad') ?? problems[0];
  if (worst) {
    const others = asking.length - 1;
    const more = others
      ? ` ${others === 1 ? 'One more thing needs' : `${others} more things need`} a look.`
      : '';
    return {
      tone: problems.some((l) => l.tone === 'bad') || input.status === 'bad' ? 'bad' : 'warn',
      sentence: `${name} has a problem: ${title(worst)}.${more}`,
    };
  }
  const yours = asking.length;
  const note = input.statusNote?.trim();
  if (input.status !== 'ok' && note) {
    const words = note.replace(/[.!]+$/, '');
    // “running warm” reads as it is (“pve-02 is running warm.”); any other note follows a colon.
    const first = /^running\b/i.test(words)
      ? `${name} is ${words.charAt(0).toLowerCase()}${words.slice(1)}.`
      : `${name} needs a look: ${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
    return {
      tone: input.status === 'bad' ? 'bad' : 'warn',
      sentence: `${first}${yours ? ` ${needYou(yours)}.` : ''}`,
    };
  }
  const running = runningWords(input.running);
  const first = running
    ? `${name} is fine: ${running.charAt(0).toLowerCase()}${running.slice(1)}.`
    : `${name} is fine.`;
  if (!yours) return { tone: 'ok', sentence: first };
  return {
    tone: 'ok',
    sentence:
      yours === 1 ? `${first} ${needYou(1)}: ${title(asking[0] as Line)}.` : `${first} ${needYou(yours)}.`,
  };
}

export interface GuestVerdictInput {
  name: string;
  state: 'running' | 'stopped' | 'unhealthy' | 'paused';
  /** Its server can't be reached: what Whombat knows is from its last report. */
  serverOffline?: boolean;
  /** Its own lines (no backup plan, a restart to apply changes), in their order. */
  lines: readonly Pick<ThingPageNotice, 'title' | 'tone'>[];
}

const GUEST_STATE: Record<GuestVerdictInput['state'], { words: string; tone: VerdictTone }> = {
  running: { words: 'is running', tone: 'ok' },
  unhealthy: { words: 'isn’t working properly', tone: 'bad' },
  stopped: { words: 'is stopped', tone: 'mut' },
  paused: { words: 'is paused', tone: 'warn' },
};

/** A machine's verdict: its state in words, then what needs the person there (the one by its title). */
export function guestVerdict(input: GuestVerdictInput): Verdict {
  if (input.serverOffline)
    return { tone: 'mut', sentence: `Whombat can’t reach ${input.name}’s server right now.` };
  const s = GUEST_STATE[input.state];
  const first = `${input.name} ${s.words}.`;
  const n = input.lines.length;
  if (!n)
    return { tone: s.tone, sentence: input.state === 'running' ? `${input.name} is running fine.` : first };
  const tone: VerdictTone =
    s.tone === 'bad' || input.lines.some((l) => l.tone === 'bad') ? 'bad' : s.tone === 'ok' ? 'warn' : s.tone;
  return {
    tone,
    sentence:
      n === 1 ? `${first} ${needYou(1)}: ${title(input.lines[0] as Line)}.` : `${first} ${needYou(n)}.`,
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
): Verdict {
  const lines: Pick<ThingPageNotice, 'title' | 'tone'>[] = guestHints(g, now).map((h) => ({
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
  return guestVerdict({ name: g.name, state: g.state, serverOffline: g.serverOnline === false, lines });
}
