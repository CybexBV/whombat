/**
 * Mara's software work in the demo world, threads of her Chat, one in each state its row shows — a council at work (two
 * of three answered), T3 Code running the tests with pull request #48, a checklist of tasks waiting for her OK, T3 Code
 * waiting for the checks on #212, a job that is done and settled, T3 Code waiting while its council reviews, and a job whose
 * result is T3 Code's report as a message, with three points left for her (job-result.md). What goes on comes as the server says it: the
 * threads' `work` (a council's round, a checklist's tasks) and the Chat's hand-overs to T3 Code
 * (`conversations.handoffs`), which the thread's job view draws. Pure TypeScript.
 */
import { type ChatThreadRepo, HANDOFF_COUNCIL_STEP, type Handoff, type ThreadWork } from '@whombat/core';
import { type JobFixtureState, jobSteps } from '@whombat/fixtures';
import { DEMO_REPOS } from './repos';

/** The threads' first messages. */
export const CODE_ROOTS = {
  council: 'msg_chat-code-council',
  tests: 'msg_chat-code-tests',
  tasks: 'msg_chat-code-tasks',
  checks: 'msg_chat-code-checks',
  done: 'msg_chat-code-done',
  reviewing: 'msg_chat-code-reviewing',
  result: 'msg_chat-code-result',
} as const;

/** The result message in `CODE_ROOTS.result`'s thread (job-result.md). */
export const CODE_RESULT_MESSAGE = 'msg_chat-code-result-report';

type Seed = [authorId: 'mara' | 'agent', minutesAgo: number, text: string];

export interface CodeThreadSeed {
  id: string;
  /** Minutes before the world was made. */
  at: number;
  text: string;
  replies: Seed[];
  /** Its council or checklist, with `since` in minutes ago. */
  work?: (
    | Omit<Extract<ThreadWork, { kind: 'council' }>, 'since'>
    | Omit<Extract<ThreadWork, { kind: 'tasks' }>, 'since'>
  ) & {
    since: number;
  };
  /** Settled this many minutes ago. */
  settled?: number;
  /** The repository its work is in, for its row's icon. */
  repo?: ChatThreadRepo;
  /** Its newest replies Mara hasn't read yet. */
  unread?: number;
  /**
   * The job ended this many minutes ago and its result is a message from the assistant (`@whombat/fixtures`'
   * `JOB_RESULT_REPORT`), `CODE_RESULT_MESSAGE`; its hand-over points to it.
   */
  result?: number;
  /** Its hand-over to T3 Code, with `since` in minutes ago. */
  handoff?: Pick<Handoff, 'state' | 'steps' | 'pullRequests' | 'program'> & {
    since: number;
    title: string;
    /** Its progress as the job view draws it (`@whombat/fixtures`' `jobFixture`, job-view.md). */
    job?: JobFixtureState;
    /** Its pull request's number, where the job has one. */
    pr?: number;
  };
}

/** The job threads `EXPO_PUBLIC_WHOMBAT_CODE=jobs` adds, one per state of the job view (job-view.md). */
export const CODE_JOB_ROOTS: Record<Exclude<JobFixtureState, 'tests' | 'checks'>, string> = {
  reading: 'msg_chat-code-job-reading',
  plan: 'msg_chat-code-job-plan',
  editing: 'msg_chat-code-job-editing',
  fixing: 'msg_chat-code-job-fixing',
  question: 'msg_chat-code-job-question',
  needs_ok: 'msg_chat-code-job-needs-ok',
  merged: 'msg_chat-code-job-merged',
};

/** A job in every other state of the job view. */
function jobThreads(): CodeThreadSeed[] {
  const jobs: [keyof typeof CODE_JOB_ROOTS, number, string, string, number | null][] = [
    ['reading', 2, 'Why does the search page load so slowly?', 'Find why search loads slowly', null],
    ['plan', 4, 'Can the invoice PDF follow dark mode?', 'Dark mode for the invoice PDF', null],
    ['editing', 11, 'Call Overview “Home” in the sidebar.', 'Rename Overview to Home', null],
    ['fixing', 22, 'Show each backup’s size in the list.', 'Show the backup size on each row', 49],
    ['question', 16, 'Move the backup page to the new list.', 'Move backups to the new list', null],
    ['needs_ok', 19, 'Fix the Vault search and push it.', 'Fix the Vault search', null],
    ['merged', 70, 'The login page is empty on Safari.', 'Fix the empty login page on Safari', 47],
  ];
  return jobs.map(([state, minutes, text, title, pr]) => ({
    id: CODE_JOB_ROOTS[state],
    at: minutes + 1,
    text,
    replies: [['agent', minutes, 'I’ll have T3 Code do it and tell you how it went.']],
    handoff: {
      title: `Neo - ${title}`,
      state: 'working',
      since: minutes,
      steps: jobSteps(state),
      pullRequests: [],
      program: 'Claude · claude-opus-5-5',
      job: state,
      ...(pr ? { pr } : {}),
    },
  }));
}

/** `jobs`: also a job in every state of the job view (`EXPO_PUBLIC_WHOMBAT_CODE=jobs`). */
export function codeThreads(jobs = false): CodeThreadSeed[] {
  return [
    ...(jobs ? jobThreads() : []),
    {
      id: CODE_ROOTS.council,
      at: 40,
      text: 'Can the council look at the Settings page? It feels cluttered.',
      replies: [
        ['agent', 39, 'I’ve asked three models to look at the Settings page. I’ll bring you one plan.'],
      ],
      work: {
        kind: 'council',
        stage: 'research',
        answered: 2,
        of: 3,
        members: [
          { mark: 'openai', letter: 'O', working: false },
          { mark: 'claude', letter: 'C', working: true },
          { mark: null, letter: 'M', working: false },
        ],
        since: 12,
      },
    },
    {
      id: CODE_ROOTS.tests,
      at: 30,
      text: 'The backup page has been empty since yesterday, can you fix it?',
      repo: DEMO_REPOS.shop,
      unread: 1,
      replies: [
        ['agent', 29, 'It’s a bug: the page reads the old list. T3 Code is fixing it.'],
        ['agent', 8, 'The fix is in pull request #48. The tests run now.'],
      ],
      handoff: {
        title: 'Neo - Fix the empty backup page',
        state: 'working',
        since: 6,
        steps: [
          { text: 'Finding the cause', detail: null, done: true },
          { text: 'Writing the fix', detail: null, done: true },
          { text: 'Running the tests', detail: 'pnpm test', done: false },
        ],
        pullRequests: [],
        program: 'Codex · gpt-6.1',
        job: 'tests',
        pr: 48,
      },
    },
    {
      id: CODE_ROOTS.tasks,
      at: 60 * 20,
      text: 'Split the Vault work into tasks and build them.',
      replies: [['agent', 60 * 20 - 1, 'Here are five tasks. Two are done; the next needs your OK.']],
      work: { kind: 'tasks', done: 2, total: 5, working: 0, needsYou: true, since: 41 },
    },
    {
      id: CODE_ROOTS.checks,
      at: 60 * 3,
      text: 'Acme Desk invoices should show the order number',
      repo: DEMO_REPOS.desk,
      replies: [
        ['agent', 60 * 3 - 2, 'Done in pull request #212. GitHub is checking it now.'],
        ['mara', 60 * 3 - 4, 'Thanks, merge it once it’s green.'],
      ],
      handoff: {
        title: 'Neo - Add the order number to invoice emails',
        state: 'checks',
        since: 20,
        steps: [{ text: 'Writing the change', detail: null, done: true }],
        pullRequests: ['#212'],
        program: 'Claude Code · Opus 5.5',
        job: 'checks',
        pr: 212,
      },
    },
    {
      id: CODE_ROOTS.reviewing,
      at: 50,
      text: 'Tidy up the old sign-in code.',
      replies: [['agent', 49, 'T3 Code is on it. Its report will appear here when it’s done.']],
      handoff: {
        title: 'Neo - Tidy up the old sign-in code',
        state: 'working',
        since: 48,
        steps: [
          { text: 'Removing unused code', detail: null, done: true },
          { text: 'Running the tests', detail: null, done: true },
          // T3 Code waits while its council looks at what it wasn't sure about: the line shows the council's faces.
          { text: HANDOFF_COUNCIL_STEP, detail: null, done: false },
        ],
        pullRequests: [],
        program: 'Claude · claude-opus-5-5',
      },
    },
    {
      id: CODE_ROOTS.result,
      at: 75,
      text: 'Remove needless complexity · shop',
      repo: DEMO_REPOS.shop,
      replies: [['agent', 74, 'T3 Code is on it. Its report will appear here when it’s done.']],
      result: 21,
      handoff: {
        title: 'Neo - Remove needless complexity',
        state: 'ended',
        since: 74,
        steps: [
          { text: 'Looking for unused code', detail: null, done: true },
          { text: HANDOFF_COUNCIL_STEP, detail: null, done: true },
          { text: 'Running the tests', detail: null, done: true },
        ],
        pullRequests: [],
        program: 'Claude · claude-opus-5-5',
      },
    },
    {
      id: CODE_ROOTS.done,
      at: 60 * 30,
      text: 'Can you make the first start of AcmeOS faster?',
      replies: [['agent', 60 * 26, 'Merged: the first start is about a third faster.']],
      settled: 60 * 25,
    },
  ];
}
