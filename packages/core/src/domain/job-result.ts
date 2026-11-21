/**
 * The result of a job handed to T3 Code, as a message in the thread it was handed over from (Whombat t3code.md
 * T3-55…T3-61; app job-result.md): the message's text is T3 Code's own report, as it wrote it, and `Message.jobResult`
 * carries the facts the box knows (how the tests went, what changed, how long it took, on which AI) and the answers the
 * person sent to what the report left for them. An app that doesn't know the field shows the report as an ordinary
 * message.
 */
import { z } from 'zod';
import { Count, Timestamp } from './common.js';
import { HandoffOutcome, HandoffPullRequest } from './handoff.js';

/** The longest report a result message keeps (the rest is in T3 Code): well inside a message's own limit. */
export const JOB_REPORT_MAX = 24_000;
/** At most this many points of a report can be answered in one sending, and at most this many sendings are kept. */
export const JOB_RESULT_POINTS_MAX = 20;
export const JOB_RESULT_SENDS_MAX = 10;

/**
 * The step a job shows while its thread's council reviews what it wasn't sure about (`Handoff.steps`): the apps show
 * the council's faces on the job's line for it.
 */
export const HANDOFF_COUNCIL_STEP = 'the council is reviewing';

/**
 * The person's answer to one point the report left for them: the point's number and title as the report gave them, and
 * the choice they marked, their own words, or both.
 */
export const JobResultAnswer = z
  .object({
    point: z.number().int().min(1).max(99),
    title: z.string().trim().min(1).max(300),
    choice: z.string().trim().min(1).max(200).nullable(),
    words: z.string().trim().min(1).max(2000).nullable(),
  })
  .refine((a) => a.choice !== null || a.words !== null, { message: 'An answer needs a choice or words.' });
export type JobResultAnswer = z.infer<typeof JobResultAnswer>;

/** Answers the person sent together: T3 Code carries them out in one run. */
export const JobResultSend = z.object({
  at: Timestamp,
  answers: z.array(JobResultAnswer).min(1).max(JOB_RESULT_POINTS_MAX),
  /** When the run that carried them out ended; null while T3 Code works on them. */
  doneAt: Timestamp.nullable(),
  /** How that run ended; null while it works. */
  outcome: HandoffOutcome.nullable(),
});
export type JobResultSend = z.infer<typeof JobResultSend>;

export const JobResult = z.object({
  /** The T3 Code thread that did the job: its hand-over's id. */
  handoffId: z.string().min(1).max(300),
  /** How the run the report is of ended. */
  outcome: HandoffOutcome,
  endedAt: Timestamp,
  /** How its last tests went; null when the box read none. */
  tests: z.enum(['passed', 'failed']).nullable(),
  /** What its pull request changes; null without one. */
  changes: z.object({ files: Count, additions: Count, deletions: Count }).nullable(),
  pullRequest: HandoffPullRequest.nullable(),
  durationMs: Count.nullable(),
  /** The AI program and model it ran on (“Claude · claude-opus-5-5”). */
  program: z.string().max(80).nullable(),
  /** The thread's page in T3 Code. */
  url: z.string().max(2000).nullable(),
  /** The report was longer than `JOB_REPORT_MAX`: the message keeps its start. */
  cut: z.boolean(),
  /** What the person answered to the report's open points, oldest first. */
  sends: z.array(JobResultSend).max(JOB_RESULT_SENDS_MAX),
});
export type JobResult = z.infer<typeof JobResult>;

/** `messages.jobAnswers`: the answers the person marked on a result message, sent together. */
export const JobAnswersBody = z.object({
  answers: z.array(JobResultAnswer).min(1).max(JOB_RESULT_POINTS_MAX),
});
export type JobAnswersBody = z.infer<typeof JobAnswersBody>;

/** The line a thread's brief carries once it was told how to write its report: never told twice. */
export const JOB_REPORT_MARK = 'How to write your last message';

/**
 * What a T3 Code thread started from a person's chat is told about its last message: it is shown to the person as it
 * is, so it is written for them, in a shape the apps lay out (`jobReport`, `@whombat/client`). Every heading is
 * optional; a short answer has none.
 */
export const JOB_REPORT_LINES: readonly string[] = [
  `${JOB_REPORT_MARK}: when all the work is done, your last message is shown to the person in their chat exactly as you write it, as the result of this job. Write it for them, not for another agent, in plain words someone who doesn’t read code understands: no file paths, function names or commands outside “Technical detail”. A short answer needs no headings. For a job that changed things use this shape, leaving out any section with nothing in it:`,
  '',
  '<First, without a heading, one or two sentences: what is done and where it runs now, whether anything works differently, and how the tests went.>',
  '',
  '## What changed',
  '- **<Area>:** <what changed there>',
  '',
  '## What I decided',
  '- <a choice you made yourself that the person should know of, and why>',
  '',
  '## What the council decided',
  '- **<Removed, Fixed, Kept or another word>: <the point in a few words>.** <the reason in one sentence>',
  '',
  '## Left for you',
  '1. **<The question in a few words?>** <what it is about, in one or two sentences>',
  '   - Advice: <what you or the council advise, and why>',
  '   - Choices: <the first choice> | <the second choice>',
  '',
  '## Technical detail',
  '<files, commands, checks and whatever else only a developer needs>',
  '',
  'Don’t write the report before the work is over: when you end a turn to wait for tests, a deploy or other work that still runs, say in one line what you wait for, and write the report in the message that ends the job. When the person answers what you left for them, carry it out and write the whole report again, updated.',
];

/**
 * The message T3 Code gets when the person sends their answers: each point by its number and title with what they
 * chose or wrote, then what to do with them.
 */
export function jobAnswersMessage(answers: readonly JobResultAnswer[]): string {
  const said = (a: JobResultAnswer) =>
    a.choice !== null && a.words !== null ? `${a.choice}. ${a.words}` : (a.choice ?? a.words ?? '');
  return [
    'My answers to what you left for me:',
    ...[...answers].sort((a, b) => a.point - b.point).map((a) => `${a.point}. ${a.title}: ${said(a)}`),
    '',
    'Carry these out in one go and keep the tests passing. Leave the points I didn’t answer open. Then write your whole report again, updated, in the same shape as before: what I answered moves to what changed or what was decided, and “Left for you” keeps only what is still open.',
  ].join('\n');
}
