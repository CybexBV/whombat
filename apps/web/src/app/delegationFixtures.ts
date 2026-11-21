/**
 * Delegations in Chat for fixture mode (option `delegation`, `VITE_FIXTURE_DELEGATION` or `whombat:fixture-delegation`;
 * Whombat delegate.md): Mara's threads in which the assistant offers coding tasks to hand to T3 Code, each in its own
 * thread and branch. `offer`, `working` or `done` seeds that one thread; `1` (or `all`) seeds all three, newest last:
 *
 * - done: the Inbox polish, ended; three tasks done and merged (folded into one line), one ran into a problem;
 * - working: the Settings page; one task's pull request being merged (with a picture of what it changed), one asking Neo
 *   a question, one waiting for task 1, one waiting for its checks, one whose checks still fail, one waiting its turn to
 *   be merged, two merged (folded), one not handed over;
 * - offer: the Files space, a checklist of four tasks, three ticked, the last one after the first.
 *
 * The checklist's second task has its own AI chosen; `delegations.setAi` chooses others and `delegations.models` lists
 * the council's fixture models (`councilSetupFixtures.ts`).
 *
 * Times count back from when the world was made. The card's buttons (`delegations.pick`, `start`, `stopTask`, `stop`)
 * change it in the world, as the server does; the card shows it on the next read (no socket here). A council's own
 * checklist is in `councilFixtures.ts`, built with the same helpers.
 */
import type {
  Attachment,
  CouncilProviderOption,
  DelegationAi,
  DelegationAiChoice,
  DelegationCard,
  DelegationCardTask,
  Message,
  MessageCard,
  RanOn,
} from '@whombat/core';
import { burrow } from '@whombat/fixtures';
import { SHOT, shotPictureBytes } from './shotFixtures';

export const DELEGATION_OFFER_THREAD = 'msg_chat-delegation-files';
export const DELEGATION_WORKING_THREAD = 'msg_chat-delegation-settings';
export const DELEGATION_DONE_THREAD = 'msg_chat-delegation-inbox';
/** One thread doing five of the tasks together, shown alone (`lead`). */
export const DELEGATION_LEAD_THREAD = 'msg_chat-delegation-exams';
/** The visual suite's switch for the delegations (as `whombat:fixture-council`). */
export const DELEGATION_FIXTURE_KEY = 'whombat:fixture-delegation';

/** Which delegation threads are in Chat. */
export type DelegationFixture = 'offer' | 'working' | 'done' | 'lead' | 'all';

function fixtureOf(value: string | null | undefined): DelegationFixture | null {
  if (value === '1' || value === 'all') return 'all';
  if (value === 'offer' || value === 'working' || value === 'done' || value === 'lead') return value;
  return null;
}

/** Which delegations are in Chat: the option, else `VITE_FIXTURE_DELEGATION` or the visual suite's switch. */
export function delegationSeeded(option: DelegationFixture | null | undefined): DelegationFixture | null {
  if (option !== undefined) return option;
  const env = fixtureOf(import.meta.env.VITE_FIXTURE_DELEGATION);
  if (env) return env;
  try {
    return typeof localStorage !== 'undefined'
      ? fixtureOf(localStorage.getItem(DELEGATION_FIXTURE_KEY))
      : null;
  } catch {
    return null;
  }
}

/** The working card's picture of what its first task changed: a file of the card's message, served at its API path. */
export const DELEGATION_SHOT_ID = 'att_delegation-settings-buttons';
const DELEGATION_SHOT_URL = `/api/v1/burrows/${burrow.slug}/attachments/${DELEGATION_SHOT_ID}`;
/** What `GET …/attachments/att_delegation-settings-buttons` answers: the drawn settings page. */
export const delegationShotBytes = shotPictureBytes;

const ON_OPUS: RanOn = { provider: 'claude', model: null, modelLabel: 'Opus', effort: null, fast: false };
export const T3 = 'http://thetitan:3773/env-1';
export const PR = 'https://github.com/acmehq/whombat/pull';

type MakeMessage = (over: Partial<Message> & Pick<Message, 'id' | 'authorId' | 'createdAt'>) => Message;

/** A delegation's tasks, their ids by its name and their number: `dlt_files1` is the Files checklist's first. */
export const fixtureTasks =
  (name: string) =>
  (number: number, title: string, over: Partial<DelegationCardTask> = {}): DelegationCardTask => ({
    id: `dlt_${name}${number}` as DelegationCardTask['id'],
    n: number,
    title,
    why: null,
    picked: true,
    after: null,
    state: 'offered',
    pending: null,
    step: null,
    program: null,
    since: null,
    endedAt: null,
    url: null,
    branch: null,
    pr: null,
    note: null,
    ...over,
  });

/** A delegation card as the server sends it: a live checklist of the Whombat project, merged one at a time. */
export const fixtureDelegation = (
  ago: (minutes: number) => string,
  over: Partial<DelegationCard> & Pick<DelegationCard, 'delegationId' | 'title' | 'tasks'>,
): DelegationCard => ({
  kind: 'delegation',
  project: 'Whombat',
  stage: 'offer',
  live: true,
  atOnce: 3,
  pullRequests: true,
  merge: true,
  ai: null,
  outcome: null,
  note: null,
  startedAt: ago(30),
  handedAt: null,
  endedAt: null,
  ...over,
});

export function delegationThreads({
  made,
  person,
  bot,
  message,
  which,
}: {
  made: number;
  person: Message['authorId'];
  bot: Message['authorId'];
  message: MakeMessage;
  which: DelegationFixture;
}): Message[] {
  const ago = (minutes: number) => new Date(made - minutes * 60_000).toISOString();
  const delegation = (over: Parameters<typeof fixtureDelegation>[1]) => fixtureDelegation(ago, over);
  // The agent's answer: its intro above the card (the message's words), its latest words under it (the card's note).
  const thread = (
    root: string,
    minutes: number,
    ask: string,
    answer: { intro: string; at: number; card: DelegationCard; attachments?: Attachment[] },
  ): Message[] => [
    message({ id: root as Message['id'], authorId: person, createdAt: ago(minutes), text: ask }),
    message({
      id: `${root}-1` as Message['id'],
      authorId: bot,
      createdAt: ago(answer.at),
      threadRootId: root as Message['id'],
      text: answer.intro,
      ranOn: ON_OPUS,
      card: answer.card as MessageCard,
      ...(answer.attachments ? { attachments: answer.attachments } : {}),
    }),
  ];

  const inbox = fixtureTasks('inbox');
  const settings = fixtureTasks('settings');
  const files = fixtureTasks('files');

  const done = () =>
    thread(DELEGATION_DONE_THREAD, 240, 'Hand the Inbox polish to T3 Code, all four.', {
      at: 180,
      intro: 'I’ll hand the Inbox polish to T3 Code as four tasks, each on its own branch.',
      card: delegation({
        delegationId: 'dlg_fixtureinbox' as DelegationCard['delegationId'],
        title: 'Polish the Inbox',
        stage: 'done',
        live: false,
        outcome: 'incomplete',
        startedAt: ago(238),
        handedAt: ago(236),
        endedAt: ago(181),
        note: 'Three of the four are done and merged. The swipe on the phone ran into a problem: the tests for the list wouldn’t start. Shall I try that one again?',
        tasks: [
          inbox(1, 'Taller rows and buttons', {
            state: 'done',
            program: 'Codex',
            since: ago(236),
            endedAt: ago(214),
            url: `${T3}/inbox-rows`,
            branch: 'delegate/inbox-rows',
            pr: `${PR}/812`,
            merge: 'merged',
            note: 'The rows are 44 px tall now, easy to tap.',
          }),
          inbox(2, 'One line per item', {
            state: 'done',
            program: 'Claude',
            since: ago(236),
            endedAt: ago(205),
            url: `${T3}/inbox-one-line`,
            branch: 'delegate/inbox-one-line',
            pr: `${PR}/813`,
            merge: 'merged',
            note: 'Each item is one line; the rest opens in place.',
          }),
          inbox(3, 'Swipe to Settle on the phone', {
            state: 'failed',
            program: 'Codex',
            since: ago(236),
            endedAt: ago(200),
            url: `${T3}/inbox-swipe`,
            branch: 'delegate/inbox-swipe',
            note: 'The list’s tests wouldn’t start.',
          }),
          inbox(4, 'Plainer words', {
            state: 'done',
            program: 'Claude',
            after: 2,
            since: ago(205),
            endedAt: ago(181),
            url: `${T3}/inbox-words`,
            branch: 'delegate/inbox-words',
            pr: `${PR}/815`,
            merge: 'merged',
          }),
        ],
      }),
    });

  const working = () =>
    thread(DELEGATION_WORKING_THREAD, 40, 'Yes, hand those over.', {
      at: 2,
      intro: 'I’m handing the Settings page work to T3 Code, three tasks at a time.',
      card: delegation({
        delegationId: 'dlg_fixturesettings' as DelegationCard['delegationId'],
        title: 'Polish the Settings page',
        stage: 'working',
        startedAt: ago(38),
        handedAt: ago(34),
        note: 'Two are merged and the buttons are being merged now. The sections’ checks still fail; I asked its thread to look again.',
        tasks: [
          settings(1, 'Taller buttons and switches', {
            state: 'working',
            merge: 'merging',
            checks: 'passing',
            program: 'Codex',
            step: 'Bringing the branch up to date',
            since: ago(34),
            url: `${T3}/settings-buttons`,
            branch: 'delegate/settings-buttons',
            pr: `${PR}/819`,
            note: 'Buttons and switches are 44 px tall now.',
            shots: [
              {
                view: 'Settings · light',
                attachmentId: DELEGATION_SHOT_ID as Attachment['id'],
                width: SHOT.width,
                height: SHOT.height,
                areas: 2,
                notes: [
                  { n: 1, text: 'The side list’s sections line up with the page.' },
                  { n: 2, text: 'The buttons are taller, so they are easier to tap.' },
                ],
              },
            ],
          }),
          settings(2, 'Plainer section names', {
            state: 'working',
            pending: 'question',
            program: 'Claude',
            since: ago(34),
            url: `${T3}/settings-names`,
            branch: 'delegate/settings-names',
          }),
          settings(3, 'Save as you go', {
            state: 'done',
            checks: 'passing',
            program: 'Claude',
            since: ago(34),
            endedAt: ago(19),
            url: `${T3}/settings-save`,
            branch: 'delegate/settings-save',
            pr: `${PR}/820`,
            merge: 'merged',
            note: 'Each change says “Saved” now.',
          }),
          settings(4, 'Search box for the settings', { state: 'skipped', picked: false }),
          settings(5, 'Keyboard shortcuts on the page', { state: 'queued', after: 1 }),
          settings(6, 'Clearer error messages', {
            state: 'done',
            merge: 'waiting',
            checks: 'passing',
            program: 'Claude',
            since: ago(30),
            endedAt: ago(4),
            url: `${T3}/settings-errors`,
            branch: 'delegate/settings-errors',
            pr: `${PR}/821`,
          }),
          settings(7, 'Fewer settings on the first page', {
            state: 'done',
            checks: 'passing',
            program: 'Codex',
            since: ago(33),
            endedAt: ago(12),
            url: `${T3}/settings-first-page`,
            branch: 'delegate/settings-first-page',
            pr: `${PR}/822`,
            merge: 'merged',
          }),
          settings(8, 'Dark colours that match the app', {
            state: 'working',
            checks: 'running',
            program: 'Codex',
            since: ago(16),
            url: `${T3}/settings-dark`,
            branch: 'delegate/settings-dark',
            pr: `${PR}/823`,
          }),
          settings(9, 'Sections remember if they’re open', {
            state: 'done',
            checks: 'failing',
            program: 'Claude',
            since: ago(28),
            endedAt: ago(6),
            url: `${T3}/settings-sections`,
            branch: 'delegate/settings-sections',
            pr: `${PR}/824`,
            note: 'Two tests of the phone layout still fail after three tries.',
          }),
        ],
      }),
      attachments: [
        {
          id: DELEGATION_SHOT_ID as Attachment['id'],
          name: 'settings-buttons.png',
          contentType: 'image/png',
          size: delegationShotBytes().byteLength,
          url: DELEGATION_SHOT_URL,
          kind: 'image',
          width: SHOT.width,
          height: SHOT.height,
        },
      ],
    });

  const offer = () =>
    thread(DELEGATION_OFFER_THREAD, 6, 'The Files space feels clunky. Can T3 Code fix it?', {
      at: 1,
      intro:
        'I found four things T3 Code can fix in the Files space. Tick the ones you want and I’ll hand them over.',
      card: delegation({
        delegationId: 'dlg_fixturefiles' as DelegationCard['delegationId'],
        title: 'Smooth out the Files space',
        startedAt: ago(1),
        note: 'Each task gets its own branch and a pull request, and I merge each one once its checks pass.',
        tasks: [
          files(1, 'Drag files in from the desktop', {
            why: 'Now you have to use the Upload button for every file.',
          }),
          files(2, 'Show how full the space is', {
            why: 'You only find out when an upload fails.',
            ai: {
              provider: 'claudeAgent',
              model: 'claude-opus-5-5',
              label: 'Claude Opus 5.5',
              effort: 'xhigh',
              fast: null,
            },
          }),
          files(3, 'Previews for PDFs', { why: 'They open as a download now.', picked: false }),
          files(4, 'Undo after deleting a file', {
            why: 'A deleted file is gone at once.',
            after: 1,
          }),
        ],
      }),
    });

  const exams = fixtureTasks('exams');
  const examsThread = `${T3}/exams-calmer`;
  const lead = () =>
    thread(DELEGATION_LEAD_THREAD, 30, 'Hand the Exams page list to T3 Code, all of it.', {
      at: 27,
      intro: 'I’ve handed the Exams page work to T3 Code. One thread does five of them together.',
      card: delegation({
        delegationId: 'dlg_fixtureexams' as DelegationCard['delegationId'],
        title: 'Make the Exams page calmer',
        stage: 'working',
        startedAt: ago(28),
        handedAt: ago(26),
        note: 'Handed over to T3 Code.',
        tasks: [
          exams(1, 'Clear names for the exam types', {
            state: 'working',
            program: 'Codex',
            step: 'Running a command',
            said: 'The cards are calmer now. I’m moving the filters into one row next.',
            since: ago(26),
            url: examsThread,
            branch: 'delegate/exams-calmer',
            reported: true,
            note: 'Exam types have plain names.',
          }),
          exams(2, 'Calmer cards', {
            state: 'working',
            after: 1,
            program: 'Codex',
            since: ago(26),
            url: examsThread,
            reported: true,
            note: 'The cards have fewer lines and one colour.',
          }),
          exams(3, 'Filters in one row', {
            state: 'working',
            after: 1,
            program: 'Codex',
            since: ago(26),
            url: examsThread,
          }),
          exams(4, 'Remember the last filter', {
            state: 'working',
            after: 1,
            program: 'Codex',
            since: ago(26),
            url: examsThread,
          }),
          exams(5, 'An empty page that says what to do', {
            state: 'working',
            after: 1,
            program: 'Codex',
            since: ago(26),
            url: examsThread,
          }),
          exams(6, 'Print a class list', {
            state: 'working',
            program: 'Claude',
            step: 'Changing ExamPrint.tsx',
            since: ago(25),
            url: `${T3}/exams-print`,
            branch: 'delegate/exams-print',
          }),
          exams(7, 'Check everything together', { state: 'queued' }),
        ],
      }),
    });

  if (which === 'lead') return lead();
  if (which === 'offer') return offer();
  if (which === 'working') return working();
  if (which === 'done') return done();
  return [...done(), ...working(), ...offer()];
}

/**
 * The AI chosen on a checklist (`delegations.setAi`), as the server keeps it: for one task or for every task, named as
 * T3 Code names it. Null when it doesn't apply (handed over, a task that isn't there, a model it doesn't run).
 */
export function chooseDelegationAi(
  card: DelegationCard,
  sent: { taskId?: string; ai: DelegationAiChoice | null },
  options: readonly CouncilProviderOption[],
): DelegationCard | null {
  if (!card.live || card.stage !== 'offer') return null;
  let ai: DelegationAi | null = null;
  if (sent.ai) {
    const model = options
      .find((p) => p.id === sent.ai?.provider)
      ?.models.find((m) => m.id === sent.ai?.model);
    if (!model || (sent.ai.effort !== null && !model.efforts.includes(sent.ai.effort))) return null;
    ai = {
      provider: sent.ai.provider,
      model: model.id,
      label: model.label,
      effort: sent.ai.effort,
      fast: typeof model.fast === 'boolean' ? sent.ai.fast : null,
    };
  }
  if (!sent.taskId) return { ...card, ai };
  if (!card.tasks.some((t) => t.id === sent.taskId)) return null;
  return { ...card, tasks: card.tasks.map((t) => (t.id === sent.taskId ? { ...t, ai } : t)) };
}

/** A press on a delegation's card, as the fixture server gets it. */
export type DelegationPress =
  | { op: 'pick'; taskId: string; picked: boolean }
  | { op: 'start' }
  | { op: 'stopTask'; taskId: string }
  | { op: 'stop' };

/**
 * What a press does to a delegation's card here, as the server does (delegate.md): a tick changes the checklist, Hand
 * over starts the ticked tasks (a few at once, the rest wait their turn), Stop this task stops one and Stop (or Not now)
 * ends it all. Null when the press doesn't apply (it ended, or the checklist was handed over already).
 */
export function pressDelegation(
  card: DelegationCard,
  press: DelegationPress,
  now: number,
): DelegationCard | null {
  const at = new Date(now).toISOString();
  if (!card.live) return null;
  if (press.op === 'pick') {
    if (card.stage !== 'offer' || !card.tasks.some((t) => t.id === press.taskId)) return null;
    return {
      ...card,
      tasks: card.tasks.map((t) => (t.id === press.taskId ? { ...t, picked: press.picked } : t)),
    };
  }
  if (press.op === 'start') {
    if (card.stage !== 'offer' || !card.tasks.some((t) => t.picked)) return null;
    let started = 0;
    const tasks = card.tasks.map((t): DelegationCardTask => {
      if (!t.picked) return { ...t, state: 'skipped' };
      if (t.after === null && started < card.atOnce) {
        started++;
        return {
          ...t,
          state: 'working',
          step: 'Getting the workspace ready',
          program: 'Claude',
          since: at,
          url: `${T3}/${t.id}`,
        };
      }
      return { ...t, state: 'queued' };
    });
    return { ...card, stage: 'working', handedAt: at, tasks };
  }
  const stopped = (t: DelegationCardTask): DelegationCardTask =>
    t.state === 'working' || t.state === 'queued'
      ? { ...t, state: 'stopped', step: null, pending: null, endedAt: at }
      : t;
  if (press.op === 'stopTask') {
    if (card.stage !== 'working') return null;
    const tasks = card.tasks.map((t) => (t.id === press.taskId ? stopped(t) : t));
    const going = tasks.some((t) => t.state === 'working' || t.state === 'queued');
    return going
      ? { ...card, tasks }
      : { ...card, tasks, stage: 'done', live: false, outcome: 'incomplete', endedAt: at };
  }
  return {
    ...card,
    stage: 'stopped',
    live: false,
    outcome: 'stopped',
    endedAt: at,
    // A checklist that was never handed over keeps its tasks offered: the ended card leaves them out.
    tasks: card.tasks.map(stopped),
  };
}
