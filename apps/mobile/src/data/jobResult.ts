/**
 * A job's result message on the phone (docs/app/decisions/job-result.md), on top of `@whombat/client`'s `jobResult.ts`:
 * what the person marked on the points left for them before sending (a choice or their own words, never both), which
 * marks still hold after the message changed, and the lines the message says about its answers. Pure.
 */
import {
  handoffMinutes,
  type JobPointMark,
  type JobReportPoint,
  type JobResultPoint,
  type JobResultView,
  jobAnswersOf,
  jobResultWords,
} from '@whombat/client';
import { formatClock } from '@whombat/core/text';

/** What the person marked on a message's points, and which points have their words field open. */
export interface JobMarks {
  marks: Readonly<Record<number, JobPointMark>>;
  writing: readonly number[];
}

export const NO_MARKS: JobMarks = { marks: {}, writing: [] };

/**
 * The points as far as marks depend on them: their numbers, titles and choices. Marks hold while this stays the same (a
 * `message.updated` for a reaction or a send), and start again when T3 Code wrote its report anew.
 */
export function pointsKey(points: readonly Pick<JobReportPoint, 'n' | 'title' | 'choices'>[]): string {
  return JSON.stringify(points.map((p) => [p.n, p.title, p.choices]));
}

/** The marks kept for these points, or none when they were made for other points. */
export function marksFor(stored: { key: string; marks: JobMarks } | undefined, key: string): JobMarks {
  return stored && stored.key === key ? stored.marks : NO_MARKS;
}

const without = (list: readonly number[], n: number) => list.filter((x) => x !== n);

/** A choice tapped: it is marked, closing the words field; tapped again, it is unmarked. */
export function chooseMark(m: JobMarks, n: number, choice: string): JobMarks {
  const marks = { ...m.marks };
  if (m.marks[n]?.choice === choice) delete marks[n];
  else marks[n] = { choice };
  return { marks, writing: without(m.writing, n) };
}

/** “Reply in words” tapped: the field opens and its words become the answer (a marked choice goes); again, it closes. */
export function toggleWords(m: JobMarks, n: number): JobMarks {
  const marks = { ...m.marks };
  if (m.writing.includes(n)) {
    delete marks[n];
    return { marks, writing: without(m.writing, n) };
  }
  marks[n] = { words: '' };
  return { marks, writing: [...m.writing, n] };
}

export function typeWords(m: JobMarks, n: number, words: string): JobMarks {
  return { ...m, marks: { ...m.marks, [n]: { words } } };
}

/** How many answers one press of Send sends. */
export const markedCount = (points: readonly JobResultPoint[], m: JobMarks): number =>
  jobAnswersOf(points, m.marks).length;

/** What an answered point says in place of its choices; null while it is open. */
export function answeredLine(p: Pick<JobResultPoint, 'answer'>, locale?: string): string | null {
  if (!p.answer) return null;
  const left = jobResultWords(locale).left;
  return p.answer.choice ? left.chose(p.answer.choice) : left.wrote;
}

/** The line in place of the send bar while T3 Code works on the answers: how many, and for how long. */
export function sentLine(
  pending: NonNullable<JobResultView['pending']>,
  nowMs: number,
  locale?: string,
): string {
  const at = Date.parse(pending.at);
  return jobResultWords(locale).left.sent(
    pending.answers,
    handoffMinutes(Number.isNaN(at) ? nowMs : at, nowMs),
  );
}

/** The one quiet line once T3 Code is done with the last answers sent: when, at the Whombat's clock, or how it ended. */
export function doneLine(
  done: NonNullable<JobResultView['done']>,
  timeZone: string,
  locale?: string,
): { text: string; tone: 'ok' | 'bad' | 'quiet' } {
  const W = jobResultWords(locale).left;
  if (done.outcome === 'completed') return { text: W.done(formatClock(done.at, timeZone)), tone: 'ok' };
  if (done.outcome === 'failed') return { text: W.problem, tone: 'bad' };
  return { text: W.stopped, tone: 'quiet' };
}

/**
 * A part written as one plain list (“What I decided”), so it is drawn with the same bullets as What changed: the words
 * before it, its items (a wrapped line joined to its item) and the words after it. Null for anything else (a nested or
 * numbered list, code, no list at all), which stays the markdown it is.
 */
export function plainList(body: string): { intro: string; items: string[]; outro: string } | null {
  const intro: string[] = [];
  const items: string[] = [];
  const outro: string[] = [];
  let blank = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line) || /^\s+([-*+]|\d{1,3}[.)])\s/.test(line)) return null;
    const item = /^[-*+]\s+(.*)$/.exec(line);
    if (outro.length) {
      if (item) return null;
      outro.push(line);
    } else if (item) items.push((item[1] ?? '').trim());
    else if (!items.length) {
      if (/^\d{1,3}[.)]\s/.test(line)) return null;
      intro.push(line);
    } else if (!line.trim()) {
      // An empty line between items or before the last words.
    } else if (blank && !/^\s/.test(line)) outro.push(line);
    else items[items.length - 1] += ` ${line.trim()}`;
    blank = !line.trim();
  }
  if (!items.length || items.some((i) => !i)) return null;
  return { intro: intro.join('\n').trim(), items, outro: outro.join('\n').trim() };
}

/** The outcome as the message leads with it: its first paragraph a step larger, the rest as the body. */
export function outcomeParts(outcome: string): { lead: string; rest: string } {
  const [lead = '', ...rest] = outcome.split(/\n[ \t]*\n/);
  return { lead: lead.trim(), rest: rest.join('\n\n').trim() };
}
