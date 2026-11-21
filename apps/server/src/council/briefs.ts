/**
 * What a council's lead thread in T3 Code is told (docs/decisions/council.md CNL-80…CNL-86), and the titles Whombat
 * reads its reviewers by. Pure. These words go to the coding agent, never into the Chat. The lead runs the council
 * itself (T3 Code's own council skill where it has one): it starts the reviewers on the council's seats, brings their
 * findings together, and for a council that improves something builds and fixes in its own checkout. Whombat only reads
 * along, so the brief fixes what it reads: each reviewer's title and the lines its answer ends with.
 */
import type { CouncilKind, CouncilRoundStage } from '@whombat/core';
import type { CouncilSeat } from '../db/schema/councils';
import { PERSON_WORDS_MARK, withPersonWords } from '../t3code/person-words';

const fence = (label: string, text: string) => [`${label}:`, '<<<', text.trim(), '>>>'];

/** How long a reviewer may work before the council goes on without it (CNL-14). */
export const MEMBER_HOURS = 1;

/** The word a round has in its reviewers' titles, by its stage. */
const ROUND_WORDS: Record<CouncilRoundStage, string> = { research: 'look', agree: 'plan', check: 'check' };

/** A reviewer's thread title: “Council · Claude Opus 5.5 · look 1”. */
export function memberTitle(label: string, stage: CouncilRoundStage, round: number): string {
  return `Council · ${label} · ${ROUND_WORDS[stage]} ${round}`.slice(0, 150);
}

/** The lead thread's title (before T3 Code's “<agent> - ” in front): “Council · Improve the Settings page”. */
export function leadTitle(title: string): string {
  return `Council · ${title}`.slice(0, 150);
}

/**
 * The round a reviewer's title names: its stage and number, and the seat's name between the dots. Null when the lead
 * titled it otherwise (Whombat then places it by its model and its order).
 */
export function roundOfTitle(
  title: string,
): { stage: CouncilRoundStage; round: number; label: string | null } | null {
  const m = /\b(look|plan|check)\s*#?\s*(\d{1,2})\s*$/i.exec(title.trim());
  if (!m) return null;
  const word = (m[1] as string).toLowerCase();
  const stage = (Object.keys(ROUND_WORDS) as CouncilRoundStage[]).find((s) => ROUND_WORDS[s] === word);
  const round = Number(m[2]);
  if (!stage || round < 1 || round > 10) return null;
  const parts = title.split('·').map((p) => p.trim());
  return { stage, round, label: parts.length >= 3 ? (parts[1] ?? null) : null };
}

/** A seat as `delegate_task` takes it: the provider instance, the model and its options. */
function seatLine(seat: CouncilSeat): string {
  const options = Object.fromEntries(seat.options.map((o) => [o.id, o.value]));
  return `- ${seat.label}: target ${JSON.stringify({ providerInstanceId: seat.provider, model: seat.model, options })}`;
}

export interface LeadBriefInput {
  /** The agent's short name: the lead's answer is written for it. */
  lead: string;
  kind: CouncilKind;
  /** What the council is asked, in the agent's words. */
  question: string;
  seats: readonly CouncilSeat[];
  /**
   * The council is T3 Code's own: the lead sits the members its council skill names, and the seats are only Whombat's
   * guess of them, for a lead without that skill. False: the person chose the seats, and the lead sits exactly those.
   */
  t3Council?: boolean;
  /** Whether it works in a project (its own worktree for `improve`, the person's checkout otherwise). */
  project: boolean;
  /** The most rounds to agree, and to check, each. */
  rounds: number;
  /** `improve`: the score every reviewer must give the result. */
  target: number | null;
  /** `improve`: build the agreed plan without waiting for the person's go-ahead. */
  goAllTheWay: boolean;
  /** What the person wrote to ask for the council, word for word, when their own message started the turn. */
  personWords?: string | null;
}

/** The steps of the council, by what it does. */
function steps(input: LeadBriefInput): string[] {
  const rounds = `${input.rounds} round${input.rounds === 1 ? '' : 's'}`;
  if (input.kind === 'review')
    return [
      'What to do: one round of reviews (“look 1”). Each reviewer reviews it as an expert: what works, what doesn’t, what to change, the most important first, and scores how good it is now out of 10. Change nothing yourself: no edits, commits, pushes or pull requests.',
    ];
  if (input.kind === 'research')
    return [
      'What to do:',
      '1. One round of research (“look 1”): each reviewer researches it and answers, saying where it found each fact (a file, or a link for what it looked up on the web). No score.',
      `2. Write one answer from theirs: what they agree on, what only one found, with the sources. Put it to fresh reviewers (“plan 1”, “plan 2”, at most ${rounds}) until every one agrees or only nice-to-haves are left; take the must-fix objections that are right. When the first round already agrees, skip this.`,
      'Change nothing yourself: no edits, commits, pushes or pull requests.',
    ];
  const target = input.target ?? 9;
  return [
    'What to do:',
    '1. Look (“look 1”): each reviewer looks at how it is now and proposes how to improve it, the changes that matter most first, each with why, and scores how good it is now out of 10.',
    `2. Plan: write one plan from their proposals: small, the steps that matter most, each with the reviewers it came from, then a short “Dropped” list (each idea you left out, whose, and why). Put it to fresh reviewers (“plan 1”, “plan 2”, at most ${rounds}) until every one agrees or only nice-to-haves are left; take the must-fix objections that are right and in scope.`,
    ...(input.goAllTheWay
      ? ['3. The person said to build it without asking first: go on once the plan is agreed.']
      : [
          '3. Then stop: end your turn with the agreed plan as your answer, and change nothing yet. The person decides whether it is built; you are told here in this thread, and go on with step 4 then.',
        ]),
    '4. Build: make the plan’s changes in this checkout (a worktree of your own), keep them as small as the plan, run the checks the repository’s own instructions ask for after a change (its fast tests, never the whole suite), commit, and open one pull request. For changes people can see, take before and after screenshots and give every reviewer the same ones.',
    `5. Check (“check 1”, “check 2”, at most ${rounds}): fresh reviewers judge the result against the goal and the plan and score it out of 10; the goal is ${target}/10 from every one. Below that: fix the must-fix items that are right and in scope, run the checks, and check again. At the limit, stop and say what is still open.`,
    '6. Put the scores in the pull request’s description (a “Council review” section: the rounds, and one row per reviewer with its score each round; “no score” where it gave none). Then finish the work the way the repository’s AGENTS.md or CLAUDE.md say work is finished (merging, putting it on DEV); when they say nothing, leave the pull request open. Never production.',
  ];
}

/** The lines every reviewer's answer ends with, by round. */
function endLines(kind: CouncilKind): string[] {
  if (kind === 'research')
    return [
      'A “plan” round’s answer ends with these lines, exactly as written (a “look” round’s has none):',
      'Verdict: agree   (or: Verdict: changes needed)',
      'Must fix: one line each, at most five (only with changes needed)',
    ];
  return [
    'Every reviewer’s answer ends with these lines, exactly as written (a “plan” round without the score, a review’s only round without the verdict):',
    'Score: <0 to 10>/10',
    'Verdict: agree   (or: Verdict: changes needed)',
    'Must fix: one line each, at most five (only with changes needed)',
  ];
}

export function leadBrief(input: LeadBriefInput): string {
  const where = !input.project
    ? 'You are in an empty scratch folder: this is research on the web.'
    : input.kind === 'improve'
      ? 'You are in a worktree of your own of the project, as the person has it now. Build here, never in their checkout.'
      : 'You are in the person’s own checkout of the project, as it is now, uncommitted changes included: that is what the council looks at.';
  return [
    `You lead a council for ${input.lead}, the person’s assistant in Whombat: several AI models from different companies each judge the same thing on their own, and you bring what they find together. Whombat shows the person every reviewer and its score while you work, by reading your reviewers’ threads: keep to the titles and the closing lines below exactly.`,
    '',
    'If you have a council skill, follow it for how to run the reviewers; where it and this brief differ, this brief wins.',
    where,
    '',
    ...fence('What the council is asked', input.question),
    ...(input.personWords ? ['', ...fence(PERSON_WORDS_MARK.replace(/:$/, ''), input.personWords)] : []),
    '',
    ...(input.t3Council
      ? [
          'The council’s seats are your council skill’s members, at the efforts it gives them. Start one reviewer per member with delegate_task (role "review", mode "async", isolation "shared" so each sees this checkout as it is). Only when you have no council skill, sit these:',
        ]
      : [
          'The council’s seats. Start one reviewer per seat with delegate_task (role "review", mode "async", isolation "shared" so each sees this checkout as it is), with exactly this target:',
        ]),
    ...input.seats.map(seatLine),
    'When T3 Code refuses a seat, go on with the others and say so; never put another model in its place, and never review in a seat’s place yourself.',
    '',
    'Title every reviewer’s task exactly “Council · <the seat’s name> · <look|plan|check> <round number>”, the seat’s name being its model’s name (“Council · GPT 6.2 Sol · look 1”). Each round has fresh reviewers on the same seats, and no reviewer hears another’s answer or score. Any other task you start must not have “council” or “review” in its title: Whombat reads those as reviewers.',
    'Tell every reviewer: work on your own; change nothing (reading files, read-only commands and running the app to look at it are fine); run only the few tests or commands you need, never whole test suites or full builds; don’t ask questions, decide and say what you assumed; don’t delegate or start a council. Give each the goal, what to judge this round, this checkout’s path, and the evidence (the diff or pull request, screenshots, the checks you ran).',
    ...endLines(input.kind),
    '',
    ...steps(input),
    '',
    `A reviewer that hasn’t answered ${MEMBER_HOURS === 1 ? 'an hour' : `${MEMBER_HOURS} hours`} after it started: cancel it (task_cancel), count it as no answer and go on. Judge every finding on its evidence, not on how many said it, and fight scope creep: fresh reviewers always find more.`,
    '',
    `Your last answer is for ${input.lead}, who retells it to a person who may not be a developer: plain words, the most important first — what the council found or did, where the reviewers agreed and where not, each round’s scores, what is still open${input.kind === 'improve' ? ', and the pull request' : ''}. Say which reviewers took part and which didn’t.`,
  ].join('\n');
}

/**
 * What the lead is told when the person or the agent sends it on (`council_tell`): the agent's words, fenced, and
 * after them what the person wrote, word for word, when their own message started the turn. `go`: the person's
 * go-ahead on the plan it waits with. `revise`: the plan it waits with is to change, and nothing is built yet.
 */
export function tellBrief(
  lead: string,
  message: string,
  how: 'go' | 'revise' | 'tell',
  personWords: string | null = null,
): string {
  const first =
    how === 'go'
      ? [
          'The person said to go ahead: build the agreed plan now (step 4 of your brief), then check it and finish as the brief says.',
        ]
      : how === 'revise'
        ? [
            'Nothing is built yet, and this is not the go-ahead: change the plan as asked below, put it to fresh reviewers again when it changed more than a detail, and stop again with the plan as your answer.',
          ]
        : [];
  return withPersonWords([...first, ...fence(`${lead} tells you`, message)].join('\n'), personWords);
}

/** What the lead is told when the council is stopped: its reviewers stop with it. */
export const STOP_BRIEF =
  'The council was stopped. Cancel every reviewer still at work (task_cancel), change nothing more, and end your turn with one line saying where it got to.';

/** What the lead is told about a reviewer that ran out of time. */
export function lateBrief(names: readonly string[]): string {
  return `${names.join(' and ')} ran out of time: cancel ${names.length === 1 ? 'its task' : 'their tasks'} (task_cancel), count ${names.length === 1 ? 'it' : 'them'} as no answer and go on without ${names.length === 1 ? 'it' : 'them'}.`;
}

/** What the lead is told once it started more rounds than the council allows. */
export const LIMIT_BRIEF =
  'That was the last round the council allows. Start no more reviewers: finish now with the scores so far and what is still open.';
