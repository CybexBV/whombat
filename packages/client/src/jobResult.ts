/**
 * A job's result message (Whombat t3code.md T3-55…T3-61; docs/app/decisions/job-result.md): T3 Code's report, which is
 * the message's text, read into the parts the web and the phone lay out alike — the outcome, what changed, what it
 * decided, what its council decided, what is left for the person with the choices to answer, and the technical detail
 * that stays folded — plus the one line of facts under it and the words for answering. The report is T3 Code's own
 * markdown: every part is found by its heading, and anything that doesn't fit a part is kept as text, never dropped.
 * Pure, no DOM and no React Native.
 */
import type { JobResult, JobResultAnswer, Message } from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { handoffWords, T3_CODE_NAME } from './handoff';
import { clientTree } from './i18n/catalog';
import { WORK_AREA_WORDS } from './i18n/messages/chatWork/work';
import { stageTime } from './job';

/** A job result's words, in a locale (English when none). */
export function jobResultWords(locale?: string | null) {
  const w = clientTree(locale, WORK_AREA_WORDS).jobResult;
  const t3 = T3_CODE_NAME;
  const n = (value: number) => count(value, locale);
  return {
    /** The name over the report: the program that wrote it. */
    author: T3_CODE_NAME,
    /** A point's advice, said by the council when the report says so. */
    council: w.council,
    advice: w.advice,
    left: {
      /** Under “Left for you”, while points wait for an answer. */
      intro: w.left.intro,
      reply: w.left.reply,
      replyPlaceholder: w.left.replyPlaceholder,
      replyLabel: (title: string) => interpolate(w.left.replyLabel, { title }),
      send: (marked: number) => (marked === 0 ? w.left.sendNone : w.left.send(marked)),
      hintNone: w.left.hintNone,
      hintOpen: (open: number) => w.left.hintOpen(open),
      hintAll: interpolate(w.left.hintAll, { t3 }),
      chose: (choice: string) => interpolate(w.left.chose, { choice }),
      wrote: w.left.wrote,
      /** While T3 Code works on what was sent; `time` is how long ago (`2m`). */
      sent: (answers: number, time: string) => w.left.sent(answers, { t3, time }),
      /** Once it carried them out; `time` is a clock time (`23:44`). */
      done: (time: string) => interpolate(w.left.done, { time }),
      problem: interpolate(w.left.problem, { t3 }),
      stopped: interpolate(w.left.stopped, { t3 }),
      failed: w.left.failed,
    },
    facts: {
      testsPassed: w.facts.testsPassed,
      testsFailed: w.facts.testsFailed,
      files: (value: number) => w.facts.files(value, { n: n(value) }),
      fewer: (value: number) => w.facts.fewer(value, { n: n(value) }),
      more: (value: number) => w.facts.more(value, { n: n(value) }),
      pullRequest: (num: number, state: string) => interpolate(w.facts.pullRequest, { n: num, state }),
      prState: {
        open: w.facts.prState.open,
        draft: w.facts.prState.draft,
        merged: w.facts.prState.merged,
        closed: w.facts.prState.closed,
      },
      problem: w.facts.problem,
      stopped: w.facts.stopped,
      detail: w.facts.detail,
      hideDetail: w.facts.hideDetail,
      open: handoffWords(locale).openInT3Code,
      rest: interpolate(w.facts.rest, { t3 }),
    },
  };
}

/** A job result's words, in English. */
export const JOB_RESULT_WORDS = jobResultWords();

const wordsIn = (locale?: string | null) => (locale ? jobResultWords(locale) : JOB_RESULT_WORDS);

function count(n: number, locale?: string | null): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, locale?.toLowerCase().startsWith('nl') ? '.' : ',');
}

/* The report ----------------------------------------------------------------------------------------------------------- */

/** One thing the report left for the person. */
export interface JobReportPoint {
  /** Its number in the report (1, 2, …). */
  n: number;
  title: string;
  /** What it is about (markdown); empty when the report gave only the question. */
  text: string;
  advice: string | null;
  /** The advice is the council's. */
  council: boolean;
  /** The choices to answer with; none: only words. */
  choices: string[];
}

/** One point the council settled: `Removed`, what, and why. */
export interface JobReportDecision {
  status: string;
  /** `quiet`: nothing changed (kept, left as it is). */
  tone: 'ok' | 'quiet';
  title: string;
  reason: string;
}

/** One area of “What changed”: its label (null for a change without one) and what changed there. */
export interface JobReportGroup {
  label: string | null;
  items: string[];
}

interface SectionBase {
  title: string;
  /** The section as T3 Code wrote it (markdown): what an app shows when the part has no rows. */
  body: string;
  /** Text before the rows, and after them. */
  intro: string | null;
  outro: string | null;
}
export type JobReportSection =
  | (SectionBase & { kind: 'changed'; groups: JobReportGroup[] | null })
  | (SectionBase & { kind: 'decided' })
  | (SectionBase & { kind: 'council'; decisions: JobReportDecision[] | null })
  | (SectionBase & { kind: 'left'; points: JobReportPoint[] })
  | (SectionBase & { kind: 'other' });

export interface JobReport {
  /** The words before the first heading: what came of it (markdown). */
  outcome: string;
  /** Its sections in T3 Code's order, without the technical detail. */
  sections: JobReportSection[];
  /** “Technical detail”, folded by the apps; null without one. */
  detail: string | null;
  /** The points left for the person, from every “Left for you” section. */
  points: JobReportPoint[];
}

const HEADING = /^ {0,3}#{1,4}\s+(.+?)\s*#*\s*$/;
const BOLD_LINE = /^ {0,3}\*\*([^*]{2,80})\*\*:?\s*$/;
const FENCE = /^ {0,3}(```|~~~)/;

function kindOf(title: string): JobReportSection['kind'] | 'detail' {
  const t = title
    .toLowerCase()
    .replace(/[:.]+$/, '')
    .replace(/[’`]/g, "'")
    .trim();
  if (/^technical details?$/.test(t)) return 'detail';
  if (/left for you|for you to (decide|review|check|choose)|needs you|your call|yours to decide/.test(t))
    return 'left';
  if (/council/.test(t)) return 'council';
  if (/^what (i |was |has )?changed$|^changes$/.test(t)) return 'changed';
  if (/^what i decided$|^decisions$|^my decisions$/.test(t)) return 'decided';
  return 'other';
}

interface ListItem {
  /** Its number when it has one. */
  n: number | null;
  /** Its first line without the marker, then the lines under it without their indent. */
  lines: string[];
}

const ITEM = /^ {0,1}(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/;

/** A section's top-level list: what stands before it, its items, what stands after it. Null without a list. */
function listOf(body: string): { intro: string; items: ListItem[]; outro: string } | null {
  const lines = body.split('\n');
  const intro: string[] = [];
  const outro: string[] = [];
  const items: ListItem[] = [];
  let blank = false;
  let fenced = false;
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced;
    const item = fenced ? null : ITEM.exec(line);
    if (outro.length) outro.push(line);
    else if (item) {
      items.push({ n: item[2] ? Number(item[2]) : null, lines: [item[3] ?? ''] });
    } else if (!items.length) intro.push(line);
    else if (!line.trim()) (items.at(-1) as ListItem).lines.push('');
    // A line at the margin after an empty one ends the list: what follows is the section's last words.
    else if (blank && !/^\s/.test(line)) outro.push(line);
    else (items.at(-1) as ListItem).lines.push(line.replace(/^ {1,4}/, ''));
    blank = !line.trim();
  }
  if (!items.length) return null;
  for (const i of items) while (i.lines.length > 1 && !i.lines.at(-1)?.trim()) i.lines.pop();
  return { intro: intro.join('\n').trim(), items, outro: outro.join('\n').trim() };
}

const ADVICE = /^[-*+]\s*(?:\*\*)?\s*(council(?:['’]s)?(?: advice)?|advice)\s*:?\s*(?:\*\*)?\s*:?\s*(.+)$/i;
const CHOICES = /^[-*+]\s*(?:\*\*)?\s*choices?\s*:?\s*(?:\*\*)?\s*:?\s*(.+)$/i;
const CHOICE_MAX = 60;
const CHOICES_MAX = 4;

/** `**Title** rest`, else the first sentence as the title. */
function titled(line: string): { title: string; rest: string } {
  const bold = /^\*\*(.+?)\*\*[:.]?\s*(.*)$/.exec(line);
  if (bold?.[1]) return { title: bold[1].trim(), rest: bold[2] ?? '' };
  const sentence = /^(.+?[?.!])\s+(.+)$/.exec(line);
  if (sentence?.[1] && sentence[1].length <= 160) return { title: sentence[1], rest: sentence[2] ?? '' };
  return { title: line.trim(), rest: '' };
}

function pointOf(item: ListItem, n: number): JobReportPoint {
  const { title, rest } = titled(item.lines[0] ?? '');
  const text: string[] = rest ? [rest] : [];
  let advice: string | null = null;
  let council = false;
  let choices: string[] = [];
  for (const raw of item.lines.slice(1)) {
    const line = raw.trim();
    const a = ADVICE.exec(line);
    const c = a ? null : CHOICES.exec(line);
    if (a?.[2]) {
      advice = a[2].trim();
      council = /^council/i.test(a[1] ?? '');
    } else if (c?.[1]) {
      const found = c[1]
        .split('|')
        .map((s) => s.replace(/^\*\*|\*\*$/g, '').trim())
        .filter(Boolean);
      // Choices are a few short labels; a sentence with a bar in it is text.
      if (found.length >= 2 && found.length <= CHOICES_MAX && found.every((f) => f.length <= CHOICE_MAX))
        choices = found;
      else text.push(raw);
    } else text.push(raw);
  }
  return { n, title, text: text.join('\n').trim(), advice, council, choices };
}

function decisionOf(item: ListItem): JobReportDecision | null {
  const m = /^\*\*([^:*]{1,40}):\s*(.+?)\*\*\s*(.*)$/.exec(item.lines[0] ?? '');
  if (!m?.[1] || !m[2]) return null;
  const status = m[1].trim();
  return {
    status,
    tone: /^(kept|keep|left|unchanged|no change|not changed)/i.test(status) ? 'quiet' : 'ok',
    title: m[2].trim().replace(/[.:]$/, ''),
    reason: [m[3] ?? '', ...item.lines.slice(1)].join('\n').trim(),
  };
}

function groupOf(item: ListItem): JobReportGroup {
  const m = /^\*\*(.+?)\*\*\s*:?\s*(.*)$/.exec(item.lines[0] ?? '');
  const label = m?.[1] ? m[1].replace(/:$/, '').trim() : null;
  const said = (m ? (m[2] ?? '') : (item.lines[0] ?? '')).trim();
  // Beside its area's label a change reads as a sentence of its own (“Deploy scripts: removed …” is “Removed …”).
  const first = label ? said.charAt(0).toUpperCase() + said.slice(1) : said;
  const items: string[] = first ? [first] : [];
  for (const raw of item.lines.slice(1)) {
    const sub = /^\s*[-*+]\s+(.*)$/.exec(raw);
    if (sub?.[1]) items.push(sub[1].trim());
    else if (raw.trim() && items.length) items[items.length - 1] += ` ${raw.trim()}`;
    else if (raw.trim()) items.push(raw.trim());
  }
  return { label, items };
}

function sectionOf(title: string, body: string, firstPoint: number): JobReportSection {
  const kind = kindOf(title) as JobReportSection['kind'];
  const list = kind === 'other' || kind === 'decided' ? null : listOf(body);
  const base = { title, body, intro: list?.intro || null, outro: list?.outro || null };
  if (kind === 'left')
    return {
      ...base,
      kind,
      points: (list?.items ?? []).map((item, i) => pointOf(item, item.n ?? firstPoint + i)),
    };
  if (kind === 'council') {
    const decisions = (list?.items ?? []).map(decisionOf);
    return {
      ...base,
      kind,
      decisions:
        decisions.length && decisions.every((d) => d !== null) ? (decisions as JobReportDecision[]) : null,
    };
  }
  if (kind === 'changed') {
    const groups = (list?.items ?? []).map(groupOf).filter((g) => g.items.length);
    return { ...base, kind, groups: groups.length ? groups : null };
  }
  return { ...base, kind };
}

/** T3 Code's report read into its parts. A report without headings is all outcome. */
export function jobReport(text: string): JobReport {
  const outcome: string[] = [];
  const parts: { title: string; lines: string[] }[] = [];
  let fenced = false;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : (HEADING.exec(line) ?? BOLD_LINE.exec(line));
    const title = heading?.[1]?.replace(/^\*\*|\*\*$/g, '').trim();
    if (title) parts.push({ title, lines: [] });
    else (parts.at(-1)?.lines ?? outcome).push(line);
  }
  const sections: JobReportSection[] = [];
  const points: JobReportPoint[] = [];
  const detail: string[] = [];
  for (const p of parts) {
    const body = p.lines.join('\n').trim();
    if (kindOf(p.title) === 'detail') {
      if (body) detail.push(body);
      continue;
    }
    if (!body) continue;
    const section = sectionOf(p.title, body, points.length + 1);
    if (section.kind === 'left') points.push(...section.points);
    sections.push(section);
  }
  return { outcome: outcome.join('\n').trim(), sections, detail: detail.join('\n\n') || null, points };
}

/* The message ----------------------------------------------------------------------------------------------------------- */

export interface JobResultFact {
  key: 'problem' | 'tests' | 'files' | 'lines' | 'pullRequest' | 'time' | 'model';
  text: string;
  tone: 'ok' | 'bad' | null;
  url: string | null;
}

/** A point as the message shows it: what the person answered when their answer is with T3 Code now. */
export interface JobResultPoint extends JobReportPoint {
  answer: { choice: string | null; words: string | null } | null;
}

export interface JobResultView {
  report: JobReport;
  /** The points with what was answered; in the report's order. */
  points: JobResultPoint[];
  /** How many still wait for an answer. */
  open: number;
  /** Answers T3 Code works on now: how many, and since when. No more can be sent until it is done. */
  pending: { answers: number; at: string } | null;
  /** The last sending T3 Code is done with: when, and how that run ended. */
  done: { at: string; outcome: NonNullable<JobResult['outcome']> } | null;
  facts: JobResultFact[];
  tone: 'ok' | 'bad' | 'quiet';
  /** The thread's page in T3 Code. */
  url: string | null;
  cut: boolean;
}

/** Whether a message is a job's result: the apps lay it out with `jobResultView` under T3 Code's name. */
export const isJobResult = (m: Pick<Message, 'jobResult' | 'deletedAt'>): boolean =>
  !!m.jobResult && !m.deletedAt;

export function jobResultFacts(r: JobResult, locale?: string | null): JobResultFact[] {
  const W = wordsIn(locale).facts;
  const facts: JobResultFact[] = [];
  if (r.outcome !== 'completed')
    facts.push({
      key: 'problem',
      text: r.outcome === 'failed' ? W.problem : W.stopped,
      tone: r.outcome === 'failed' ? 'bad' : null,
      url: null,
    });
  if (r.tests)
    facts.push({
      key: 'tests',
      text: r.tests === 'passed' ? W.testsPassed : W.testsFailed,
      tone: r.tests === 'passed' ? 'ok' : 'bad',
      url: null,
    });
  if (r.changes) {
    facts.push({ key: 'files', text: W.files(r.changes.files), tone: null, url: null });
    const net = r.changes.additions - r.changes.deletions;
    if (net !== 0)
      facts.push({ key: 'lines', text: net < 0 ? W.fewer(-net) : W.more(net), tone: null, url: null });
  }
  if (r.pullRequest)
    facts.push({
      key: 'pullRequest',
      text: W.pullRequest(r.pullRequest.number, W.prState[r.pullRequest.state]),
      tone: null,
      url: r.pullRequest.url,
    });
  if (r.durationMs !== null)
    facts.push({ key: 'time', text: stageTime(r.durationMs), tone: null, url: null });
  if (r.program) facts.push({ key: 'model', text: r.program, tone: null, url: null });
  return facts;
}

/** A result message as the apps draw it; null for any other message. */
export function jobResultView(
  m: Pick<Message, 'text' | 'jobResult' | 'deletedAt'>,
  locale?: string | null,
): JobResultView | null {
  const r = m.jobResult;
  if (!r || m.deletedAt) return null;
  const report = jobReport(m.text);
  const last = r.sends.at(-1) ?? null;
  const pending = last && last.doneAt === null ? last : null;
  const points = report.points.map((p) => {
    const a = pending?.answers.find((x) => x.point === p.n) ?? null;
    return { ...p, answer: a ? { choice: a.choice, words: a.words } : null };
  });
  return {
    report,
    points,
    open: points.filter((p) => !p.answer).length,
    pending: pending ? { answers: pending.answers.length, at: pending.at } : null,
    done: last?.doneAt && last.outcome ? { at: last.doneAt, outcome: last.outcome } : null,
    facts: jobResultFacts(r, locale),
    tone: r.outcome === 'failed' ? 'bad' : r.outcome === 'stopped' ? 'quiet' : 'ok',
    url: r.url,
    cut: r.cut,
  };
}

/* Answering ------------------------------------------------------------------------------------------------------------- */

/** What the person marked on one point before sending: a choice, their own words, or both. */
export interface JobPointMark {
  choice?: string | null;
  words?: string | null;
}

/** The marks worth sending, as `messages.jobAnswers` takes them: points with a choice or words, in the report's order. */
export function jobAnswersOf(
  points: readonly JobResultPoint[],
  marks: Readonly<Record<number, JobPointMark | undefined>>,
): JobResultAnswer[] {
  return points.flatMap((p) => {
    if (p.answer) return [];
    const choice = marks[p.n]?.choice?.trim() || null;
    const words = marks[p.n]?.words?.trim() || null;
    return choice || words ? [{ point: p.n, title: p.title.slice(0, 300), choice, words }] : [];
  });
}

/** The send bar under the open points: its button, whether it can be pressed, and the line beside it. */
export function jobSendBar(
  view: Pick<JobResultView, 'open' | 'pending'>,
  marked: number,
  locale?: string | null,
): { button: string; enabled: boolean; hint: string } | null {
  if (view.pending || view.open === 0) return null;
  const W = wordsIn(locale).left;
  const left = view.open - marked;
  return {
    button: W.send(marked),
    enabled: marked > 0,
    hint: marked === 0 ? W.hintNone : left > 0 ? W.hintOpen(left) : W.hintAll,
  };
}
