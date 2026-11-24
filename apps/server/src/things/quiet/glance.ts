/**
 * A thing's dot from its lines (quiet-notices.md QN-02, QN-14, QN-22; QN-S03, QN-S06, QN-S07). The health pass keeps
 * the lines that could colour it in the glance (`GlanceLine`: not heads-ups, not info), each with how many passes in a
 * row it was seen; whoever shows the thing (Home's cards and the sidebar, Watch, Needs you, the desk) works the dot out
 * from those and the quiet rows at that moment (`verdict`), so an Ignore or its Undo shows at once and a snooze ends at
 * its time, not at the next pass. Pure.
 */
import type { ThingStatus } from '@whombat/core';
import { type ApplyLine, applyQuiet, natureOf, type StateRow } from './apply';
import { notWatched } from './defaults';
import type { ThingQuiet } from './store';
import type { LooseNotice, NoticeIgnore, NoticeNature, NoticeSubject } from './types';
import type { Hold } from './windows';

/** A line as the glance keeps it (server only). */
export interface GlanceLine {
  check?: string;
  subject?: NoticeSubject;
  tone: 'bad' | 'warn' | 'info';
  nature: NoticeNature;
  title: string;
  badge?: string;
  episode?: string;
  band?: number;
  confirm?: 2;
  /** Health passes in a row that saw it (for `confirm`). */
  seen?: number;
  ignore?: NoticeIgnore;
  /** Its ask link's question: what the desk sends when someone asks the assistant to look into it (QN-20). */
  question?: string;
  offline?: true;
}

/** What the desk's look carries of the line behind a thing's dot (QN-20; contracts 0.122 CT-1065). */
export interface GlanceNotice {
  check: string;
  subject?: string;
  nature: NoticeNature;
  ignoreWords?: string;
  question?: string;
}

/** The most lines a glance keeps. */
export const GLANCE_LINES_MAX = 30;

/** Whether a line can colour a dot at all: not a heads-up, not information. */
export function colours(l: ApplyLine): boolean {
  return l.tone !== 'info' && natureOf(l) !== 'fyi';
}

/** A line as the glance keeps it. */
export function glanceLine(l: LooseNotice, seen?: number): GlanceLine {
  return {
    ...(l.check ? { check: l.check } : {}),
    ...(l.subject ? { subject: l.subject } : {}),
    tone: l.tone,
    nature: natureOf(l),
    title: l.title,
    ...(l.badge ? { badge: l.badge } : {}),
    ...(l.episode ? { episode: l.episode } : {}),
    ...(l.band != null ? { band: l.band } : {}),
    ...(l.confirm ? { confirm: l.confirm } : {}),
    ...(seen ? { seen } : {}),
    ...(l.ignore ? { ignore: l.ignore } : {}),
    ...(l.link?.kind === 'ask' ? { question: l.link.question } : {}),
    ...(l.offline ? { offline: true as const } : {}),
  };
}

/** What a thing's dot comes to now. */
export interface Verdict {
  status: Extract<ThingStatus, 'ok' | 'warn' | 'bad' | 'offline'>;
  reason?: string;
  notice?: GlanceNotice;
  /** The line behind it. */
  worst: GlanceLine | null;
  /** Every line behind it, worst first: what the assistant looks into when it looks into the thing. */
  asking?: GlanceLine[];
  /** What holds the whole thing quiet now (a window or a cause, monitoring.md MON-04, MON-07). */
  held?: Hold;
}

/** The notice a desk look carries for a line. */
export function noticeOf(l: GlanceLine): GlanceNotice | undefined {
  if (!l.check) return undefined;
  return {
    check: l.check,
    ...(l.subject ? { subject: l.subject.id } : {}),
    nature: l.nature,
    ...(l.ignore ? { ignoreWords: l.ignore.words } : {}),
    ...(l.question ? { question: l.question } : {}),
  };
}

/** The dot from the kept lines and the quiet rows now (a read: nothing ends here). */
export function verdict(lines: readonly GlanceLine[], quiet: ThingQuiet, now: Date): Verdict {
  const states: StateRow[] = lines.flatMap((l) =>
    l.check
      ? [
          {
            checkId: l.check,
            subject: l.subject?.id ?? '',
            firstSeen: now,
            lastSeen: now,
            seenPasses: l.seen ?? 0,
            tone: l.tone,
          },
        ]
      : [],
  );
  const r = applyQuiet({ lines, quiets: quiet.quiets, ...notWatched(quiet), states, now, pass: false });
  const worst = r.worst;
  if (!worst) return { status: 'ok', worst: null, ...(r.held ? { held: r.held } : {}) };
  const notice = noticeOf(worst);
  return {
    status: worst.offline ? 'offline' : r.status,
    ...(r.reason ? { reason: r.reason } : {}),
    ...(notice ? { notice } : {}),
    worst,
    asking: [worst, ...r.asking.filter((l) => l !== worst)],
  };
}
