/**
 * Software work in fixture mode (option `code`, `VITE_FIXTURE_CODE=1` or `whombat:fixture-code`): five of Mara's
 * threads of the Chat, each with work going on from it, so Chat's rows show every kind of work line, newest work first:
 *
 * - a council at work on the Settings page, 2 of its 3 members answered (its live card in the thread);
 * - T3 Code fixing the empty backup page, running the tests, with pull request #48;
 * - the Vault checklist, 2 of 5 tasks done, one needing Mara's OK (its card in the thread);
 * - T3 Code's invoice change in another repository, waiting for the checks on #212;
 * - yesterday's first-start work in a third repository, settled when its pull request merged.
 *
 * T3 Code's jobs show their stage track and parts in their threads; `jobs` adds a job in every state of that view.
 * Times count back from when the world was made.
 */
import type {
  ChatThreadRepo,
  CouncilCard,
  CouncilCardMember,
  DelegationCard,
  Handoff,
  Message,
  MessageCard,
  ThreadSettle,
  ThreadWork,
} from '@whombat/core';
import { HANDOFF_COUNCIL_STEP } from '@whombat/core';
import {
  JOB_RESULT_REPORT,
  type JobFixture,
  type JobFixtureState,
  jobFixture,
  jobResultFixture,
  jobSteps,
} from '@whombat/fixtures';
import { fixtureDelegation, fixtureTasks } from './delegationFixtures';
import { ASSISTANT_NAME } from './oneFixtures';

export const CODE_COUNCIL_THREAD = 'msg_chat-code-settings';
export const CODE_HANDOFF_THREAD = 'msg_chat-code-backup';
export const CODE_TASKS_THREAD = 'msg_chat-code-vault';
export const CODE_CHECKS_THREAD = 'msg_chat-code-invoice';
export const CODE_SETTLED_THREAD = 'msg_chat-code-boot';
/** The visual suite's switch for the software work (as `whombat:fixture-council`); `jobs` adds a job in every state. */
export const CODE_FIXTURE_KEY = 'whombat:fixture-code';

/** The job threads `VITE_FIXTURE_CODE=jobs` adds, one per state of the job view. */
export const CODE_JOB_THREADS: Record<Exclude<JobFixtureState, 'tests' | 'checks'>, string> = {
  reading: 'msg_chat-code-job-reading',
  plan: 'msg_chat-code-job-plan',
  editing: 'msg_chat-code-job-editing',
  fixing: 'msg_chat-code-job-fixing',
  question: 'msg_chat-code-job-question',
  needs_ok: 'msg_chat-code-job-needs-ok',
  merged: 'msg_chat-code-job-merged',
};

/**
 * The job-result threads `VITE_FIXTURE_CODE=jobs` adds (job-result mockup): T3 Code's report as a message with three
 * points left for Mara, the same report with two of them answered and T3 Code on them, and a job whose council is
 * reviewing what T3 Code wasn't sure about.
 */
export const CODE_RESULT_THREADS = {
  result: 'msg_chat-code-job-result',
  sent: 'msg_chat-code-job-result-sent',
  council: 'msg_chat-code-job-council',
} as const;

/** Whether Chat also holds a job in every state of the job view: `VITE_FIXTURE_CODE=jobs` or the visual switch. */
export function codeJobsSeeded(): boolean {
  if (import.meta.env.VITE_FIXTURE_CODE === 'jobs') return true;
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(CODE_FIXTURE_KEY) === 'jobs';
  } catch {
    return false;
  }
}

/** Whether Chat holds the software work: the option, else `VITE_FIXTURE_CODE=1` or the visual suite's switch. */
export function codeSeeded(option: boolean | undefined): boolean {
  if (option !== undefined) return option;
  if (import.meta.env.VITE_FIXTURE_CODE === '1' || import.meta.env.VITE_FIXTURE_CODE === 'jobs') return true;
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(CODE_FIXTURE_KEY) : null;
    return v === '1' || v === 'jobs';
  } catch {
    return false;
  }
}

type MakeMessage = (over: Partial<Message> & Pick<Message, 'id' | 'authorId' | 'createdAt'>) => Message;

const GH = 'https://github.com/acmehq';
const T3 = 'http://thetitan:3773/env-1';

export interface CodeWorld {
  messages: Message[];
  /** A council's or checklist's progress, by thread. */
  work: Map<string, ThreadWork>;
  handoffs: Handoff[];
  settled: [string, ThreadSettle][];
  /** The repository a thread's work is in, by thread: its row's icon. */
  repos: Map<string, ChatThreadRepo>;
}

export function codeWorld({
  made,
  person,
  bot,
  message,
  conversationId,
}: {
  made: number;
  person: Message['authorId'];
  bot: Message['authorId'];
  message: MakeMessage;
  conversationId: string;
}): CodeWorld {
  const ago = (minutes: number) => new Date(made - minutes * 60_000).toISOString();
  const thread = (root: string, minutes: number, ask: string, answers: [number, string, MessageCard?][]) => [
    message({ id: root as Message['id'], authorId: person, createdAt: ago(minutes), text: ask }),
    ...answers.map(([at, text, card], i) =>
      message({
        id: `${root}-${i + 1}` as Message['id'],
        authorId: bot,
        createdAt: ago(at),
        threadRootId: root as Message['id'],
        text,
        ...(card ? { card } : {}),
      }),
    ),
  ];
  const member = (
    n: number,
    who: Pick<CouncilCardMember, 'name' | 'provider' | 'mark'>,
    over: Partial<CouncilCardMember>,
  ): CouncilCardMember => ({
    id: `cnm_fixturecode${n}` as CouncilCardMember['id'],
    ...who,
    role: 'member',
    state: 'done',
    score: null,
    verdict: null,
    since: ago(12),
    endedAt: null,
    step: null,
    url: null,
    answer: null,
    ...over,
  });
  const council: CouncilCard = {
    kind: 'council',
    councilId: 'cnl_fixturecodesettings' as CouncilCard['councilId'],
    title: 'Make the Settings page calmer',
    what: 'improve',
    stage: 'research',
    round: 1,
    roundsMax: 3,
    target: 9,
    live: true,
    members: [
      member(
        1,
        { name: 'GPT 6.1 Sol', provider: 'Codex', mark: 'openai' },
        {
          score: 7,
          verdict: 'changes',
          endedAt: ago(6),
          answer:
            'Too many sections on one page. Group them into four and put the rare ones under Advanced. 7/10.',
        },
      ),
      member(
        2,
        { name: 'Claude Opus 5.5', provider: 'Claude', mark: 'claude' },
        {
          state: 'working',
          step: 'Reading the Settings screens',
        },
      ),
      member(
        3,
        { name: 'Muse Wonder', provider: 'Muse Code', mark: null },
        {
          score: 9,
          verdict: 'agree',
          endedAt: ago(9),
          answer: 'Mostly fine. “System” should be “This Whombat”, and the switches need more room. 9/10.',
        },
      ),
    ],
    history: [],
    plan: null,
    shots: [],
    outcome: null,
    startedAt: ago(12),
    endedAt: null,
  };
  const t = fixtureTasks('codevault');
  const tasks: DelegationCard = fixtureDelegation(ago, {
    delegationId: 'dlg_fixturecodevault' as DelegationCard['delegationId'],
    title: 'Split the Vault work into five tasks',
    stage: 'working',
    startedAt: ago(45),
    handedAt: ago(41),
    tasks: [
      t(1, 'Group sign-ins by service', {
        state: 'done',
        checks: 'passing',
        merge: 'merged',
        program: 'Claude',
        since: ago(41),
        endedAt: ago(30),
        branch: 'delegate/vault-groups',
        pr: `${GH}/whombat/pull/51`,
      }),
      t(2, 'Show when a key was last used', {
        state: 'done',
        checks: 'passing',
        merge: 'merged',
        program: 'Claude',
        since: ago(41),
        endedAt: ago(22),
        branch: 'delegate/vault-last-used',
        pr: `${GH}/whombat/pull/52`,
      }),
      t(3, 'Ask before sharing a key', {
        state: 'working',
        pending: 'approval',
        program: 'Codex',
        step: 'Waiting for your OK to push',
        since: ago(30),
        url: `${T3}/vault-share`,
        branch: 'delegate/vault-share',
      }),
      t(4, 'Plainer words on the Vault page', { state: 'queued', after: 3 }),
      t(5, 'Search the Vault', { state: 'queued', after: 1 }),
    ],
  });

  const messages = [
    ...thread(
      CODE_SETTLED_THREAD,
      26 * 60,
      'The first start of AcmeOS takes almost two minutes. Can it be faster?',
      [
        [25 * 60, 'I’ll have T3 Code look at what runs at the first start.'],
        [21 * 60, 'Merged: the first start takes 40 seconds now. It waits for the network only once.'],
      ],
    ),
    ...thread(CODE_TASKS_THREAD, 50, 'Split the Vault work into tasks and build them.', [
      [45, 'Here are five tasks. Tick what to hand over.', tasks as MessageCard],
    ]),
    ...thread(CODE_CHECKS_THREAD, 40, 'Acme Desk invoices should show the order number.', [
      [38, 'I’ve asked T3 Code to add it to the invoice emails.'],
      [6, 'It’s in pull request #212. GitHub is checking it now.'],
    ]),
    ...thread(CODE_COUNCIL_THREAD, 14, 'Can the council look at the Settings page? It feels cluttered.', [
      [
        12,
        'I’ve asked three models to look at the Settings page. I’ll bring you one plan.',
        council as MessageCard,
      ],
    ]),
    ...thread(CODE_HANDOFF_THREAD, 9, 'The backup page has been empty since yesterday, can you fix it?', [
      [
        8,
        'It’s a bug in Whombat: the page reads the old list. I’ll fix it in T3 Code and open a pull request.',
      ],
    ]),
  ];

  const work = new Map<string, ThreadWork>([
    [
      CODE_COUNCIL_THREAD,
      {
        kind: 'council',
        stage: 'research',
        answered: 2,
        of: 3,
        members: [
          { mark: 'openai', letter: 'G', working: false },
          { mark: 'claude', letter: 'C', working: true },
          { mark: null, letter: 'M', working: false },
        ],
        since: ago(12),
      },
    ],
    [CODE_TASKS_THREAD, { kind: 'tasks', done: 2, total: 5, working: 1, needsYou: true, since: ago(41) }],
  ]);
  const handoff = (over: Partial<Handoff> & Pick<Handoff, 'id' | 'rootId' | 'title' | 'state'>): Handoff => ({
    to: 't3code',
    conversationId: conversationId as Handoff['conversationId'],
    agentId: bot as Handoff['agentId'],
    since: ago(8),
    endedAt: null,
    outcome: null,
    steps: [],
    asks: null,
    pullRequests: [],
    program: 'Codex · gpt-5.5',
    url: `${T3}/${over.id}`,
    ...over,
  });
  const handoffs: Handoff[] = [
    handoff({
      id: 'mcp:code-backup',
      rootId: CODE_HANDOFF_THREAD as Handoff['rootId'],
      title: `${ASSISTANT_NAME} - Fix the empty backup page`,
      ...pr(jobFixture('tests', made, 7.5), 'whombat', 48),
      state: 'working',
      since: ago(7.5),
      steps: [
        { text: 'Finding the cause', detail: null, done: true },
        { text: 'Writing the fix', detail: 'apps/web/src/features/backups/BackupList.tsx', done: true },
        { text: 'Running the tests', detail: 'pnpm --filter @whombat/web test', done: false },
      ],
      pullRequests: [`${GH}/whombat/pull/48`],
    }),
    handoff({
      id: 'mcp:code-invoice',
      rootId: CODE_CHECKS_THREAD as Handoff['rootId'],
      title: `${ASSISTANT_NAME} - Add the order number to invoice emails`,
      ...pr(jobFixture('checks', made, 38), 'tracker-web', 212),
      state: 'checks',
      since: ago(38),
      steps: [{ text: 'Writing the change', detail: null, done: true }],
      pullRequests: [`${GH}/tracker-web/pull/212`],
    }),
  ];
  // A job in every other state of the job view (`VITE_FIXTURE_CODE=jobs`).
  if (codeJobsSeeded()) {
    const jobs: [Exclude<JobFixtureState, 'tests' | 'checks'>, number, string, string, number | null][] = [
      ['reading', 2, 'Why does the search page load so slowly?', 'Find why search loads slowly', null],
      ['plan', 4, 'Can the invoice PDF follow dark mode?', 'Dark mode for the invoice PDF', null],
      ['editing', 11, 'Call Overview “Home” in the sidebar.', 'Rename Overview to Home', null],
      ['fixing', 22, 'Show each backup’s size in the list.', 'Show the backup size on each row', 49],
      ['question', 16, 'Move the backup page to the new list.', 'Move backups to the new list', null],
      ['needs_ok', 19, 'Fix the Vault search and push it.', 'Fix the Vault search', null],
      ['merged', 70, 'The login page is empty on Safari.', 'Fix the empty login page on Safari', 47],
    ];
    for (const [state, minutes, ask, title, number] of jobs) {
      const root = CODE_JOB_THREADS[state];
      messages.push(
        ...thread(root, minutes + 1, ask, [[minutes, 'I’ll have T3 Code do it and tell you how it went.']]),
      );
      const fixture = jobFixture(state, made, minutes);
      handoffs.push(
        handoff({
          id: `mcp:code-job-${state}`,
          rootId: root as Handoff['rootId'],
          title: `${ASSISTANT_NAME} - ${title}`,
          program: 'Claude · claude-opus-5-5',
          steps: jobSteps(state),
          ...(number ? pr(fixture, 'whombat', number) : fixture),
        }),
      );
    }
  }
  if (codeJobsSeeded()) {
    // T3 Code's report as the thread's last message, under T3 Code's name; its job ended, so no line or parts of its own.
    const results: [keyof typeof CODE_RESULT_THREADS, number, string][] = [
      ['result', 60, 'Remove needless complexity from the repository.'],
      ['sent', 90, 'Clean up what nothing uses any more.'],
    ];
    for (const [which, minutes, ask] of results) {
      const root = CODE_RESULT_THREADS[which];
      const id = `${root}-2` as Message['id'];
      const ended = ago(minutes - 55);
      messages.push(
        ...thread(root, minutes, ask, [
          [minutes - 1, 'T3 Code is on it. Its report will appear here when it’s done.'],
        ]),
        message({
          id,
          authorId: bot,
          createdAt: ended,
          threadRootId: root as Message['id'],
          text: JOB_RESULT_REPORT,
          jobResult: jobResultFixture(ended, {
            handoffId: `mcp:code-${which}`,
            url: `${T3}/code-${which}`,
            sends:
              which === 'sent'
                ? [
                    {
                      at: ago(3),
                      answers: [
                        {
                          point: 1,
                          title: 'Keep the unused groundwork for moving boxes?',
                          choice: 'Remove',
                          words: null,
                        },
                        {
                          point: 2,
                          title: 'An unused screen for release details: missing or retired?',
                          choice: 'Keep it for later',
                          words: null,
                        },
                      ],
                      doneAt: null,
                      outcome: null,
                    },
                  ]
                : [],
          }),
        }),
      );
      handoffs.push(
        handoff({
          id: `mcp:code-${which}`,
          rootId: root as Handoff['rootId'],
          title: `${ASSISTANT_NAME} - ${ask}`,
          state: 'ended',
          outcome: 'completed',
          since: ago(minutes - 1),
          endedAt: ended,
          program: 'Claude · claude-opus-5-5',
          resultMessageId: id,
        }),
      );
    }
    // A job whose council looks at what T3 Code wasn't sure about: the council's faces on its line.
    messages.push(
      ...thread(CODE_RESULT_THREADS.council, 50, 'Remove needless complexity from the tracker.', [
        [49, 'T3 Code is on it. Its report will appear here when it’s done.'],
      ]),
    );
    handoffs.push(
      handoff({
        id: 'mcp:code-council',
        rootId: CODE_RESULT_THREADS.council as Handoff['rootId'],
        title: `${ASSISTANT_NAME} - Remove needless complexity from the tracker`,
        state: 'working',
        since: ago(49),
        program: 'Claude · claude-opus-5-5',
        steps: [
          { text: 'Reading the repository', detail: null, done: true },
          { text: 'Removing unused code', detail: null, done: true },
          { text: 'Running the tests', detail: 'pnpm test', done: true },
          { text: HANDOFF_COUNCIL_STEP, detail: null, done: false },
        ],
      }),
    );
  }
  const settled: [string, ThreadSettle][] = [[CODE_SETTLED_THREAD, { at: ago(21 * 60), how: 'merged' }]];
  // Acme's shop has no icon of its own (its letter shows); the help desk's job says its repository in its title.
  const repos = new Map<string, ChatThreadRepo>([
    [CODE_TASKS_THREAD, { fullName: 'acme/shop', name: 'shop', iconUrl: null }],
    [CODE_CHECKS_THREAD, { fullName: 'acme/desk', name: 'desk', iconUrl: null }],
  ]);
  return { messages, work, handoffs, settled, repos };
}

/** A job fixture's pull request as this repository's `#number`. */
function pr(fixture: JobFixture, repo: string, number: number): JobFixture {
  const url = `${GH}/${repo}/pull/${number}`;
  return {
    ...fixture,
    pullRequest: fixture.pullRequest ? { ...fixture.pullRequest, number, url } : null,
    pullRequests: fixture.pullRequests.length ? [url] : [],
    changes: fixture.changes ? { ...fixture.changes, url: `${url}/files` } : null,
  };
}
