/**
 * A delegation in the demo world's Chat (Whombat docs/decisions/delegate.md): Mara asked Neo to polish the Settings page,
 * and Neo offers seven tasks to hand to T3 Code. As `offer` the checklist waits for her (five ticked, one after
 * another); as `working` six are handed over — two merged (folded into “2 merged”), one waiting for its checks with a
 * picture of what it changed, one merging, one whose checks keep failing, one that asked Neo a question — and one wasn't
 * ticked; as `done` it ended with five merged and one that didn't finish. The card's buttons answer as the server does,
 * the card changing on its message (`message.updated`). The same tasks, all ticked, carry out the council's plan for the
 * Settings page on a checklist of their own under its card (`councilDelegationCard`, `council.ts`). On the checklist
 * the AI can be chosen: grouping the settings runs with Claude Opus 5.5 at Extra high, the rest with T3 Code's default,
 * from the three models T3 Code runs here (`DELEGATION_AI_OPTIONS`). Pure TypeScript.
 */
import type {
  Attachment,
  CouncilProviderOption,
  DelegationActionResponse,
  DelegationAi,
  DelegationAiChoice,
  DelegationCard,
  DelegationCardTask,
} from '@whombat/core';

export type DelegationFixtureStage = 'offer' | 'working' | 'done';

const STAGES: readonly DelegationFixtureStage[] = ['offer', 'working', 'done'];

/**
 * The stage an environment switch asks for (`offer`, `working`, `done`; `1` is `working`, where most shows), or null for
 * anything else.
 */
export function delegationStageFrom(value: string | undefined): DelegationFixtureStage | null {
  if (value === '1') return 'working';
  return STAGES.find((s) => s === value) ?? null;
}

/** The thread's first message (Mara's ask). */
export const DELEGATION_ROOT = 'msg_chat-delegation';
/** The delegation, for the buttons. */
export const DELEGATION_ID = 'dlg_settings-polish';
/** The picture the search task sent of what it changed. */
export const DELEGATION_SHOT_ATTACHMENT = 'att_delegation-search-light';

/** The tasks' ids, by their number on the card. */
export const DELEGATION_TASKS = {
  rows: 'dlt_settings-rows',
  group: 'dlt_settings-group',
  names: 'dlt_settings-names',
  search: 'dlt_settings-search',
  danger: 'dlt_settings-danger',
  save: 'dlt_settings-save',
  contrast: 'dlt_settings-contrast',
} as const;

export interface DelegationThreadSeed {
  id: string;
  /** Mara's ask, minutes ago. */
  at: number;
  text: string;
  /** Neo's message: its intro above the card, the card and the pictures' files, minutes ago. */
  reply: { at: number; text: string; card: DelegationCard; attachments: Attachment[] };
}

/** What T3 Code runs on Mara's computer, to choose a task's AI from (`delegations.models`). */
export const DELEGATION_AI_OPTIONS: CouncilProviderOption[] = [
  {
    id: 'codex',
    name: 'Codex',
    models: [
      {
        id: 'gpt-6.1-sol',
        label: 'GPT 6.1 Sol',
        efforts: ['low', 'medium', 'high', 'xhigh', 'ultra'],
        defaultEffort: 'medium',
        fast: true,
      },
    ],
  },
  {
    id: 'claudeAgent',
    name: 'Claude',
    models: [
      {
        id: 'claude-opus-5-5',
        label: 'Claude Opus 5.5',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high',
        fast: false,
      },
      {
        id: 'claude-sonnet-5-5',
        label: 'Claude Sonnet 5.5',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
      },
    ],
  },
];

/** The AI chosen for grouping the settings on the checklist. */
const GROUP_AI: DelegationAi = {
  provider: 'claudeAgent',
  model: 'claude-opus-5-5',
  label: 'Claude Opus 5.5',
  effort: 'xhigh',
  fast: null,
};

const T3 = 'https://t3.example/threads';
const PRS = 'https://github.com/mara/whombat-site/pull';

type TaskSeed = [id: string, title: string, why: string | null, over?: Partial<DelegationCardTask>];

/** A task on the card, as the server sends it. */
export function delegationTask(n: number, [id, title, why, over]: TaskSeed): DelegationCardTask {
  return {
    id: id as DelegationCardTask['id'],
    n,
    title,
    why,
    picked: false,
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
  };
}

/** The Settings page's tasks on the checklist, as Neo offers them. */
const SETTINGS_TASKS: TaskSeed[] = [
  [DELEGATION_TASKS.rows, 'Make the rows taller', 'Easier to tap on a phone.', { picked: true }],
  [
    DELEGATION_TASKS.group,
    'Group the settings under four headings',
    'A setting is easier to find.',
    { picked: true, ai: GROUP_AI },
  ],
  [
    DELEGATION_TASKS.names,
    'Plain names for the sign-in settings',
    '“Access control” means little to most people.',
  ],
  [
    DELEGATION_TASKS.search,
    'Search at the top of the page',
    'Finds a setting by any word in it.',
    { picked: true, after: 2 },
  ],
  [DELEGATION_TASKS.danger, 'Move Danger zone to the bottom', null],
  [
    DELEGATION_TASKS.save,
    'Save changes as you make them',
    'With Undo for a few seconds, so nothing is lost.',
    { picked: true },
  ],
  [
    DELEGATION_TASKS.contrast,
    'Keep every label readable in the dark',
    'Contrast of 4.5:1 for every label.',
    { picked: true },
  ],
];

/** The search task's picture of what it changed: the page before on top, after below, two areas numbered. */
function searchShot(burrow: string): {
  shot: NonNullable<DelegationCardTask['shots']>[number];
  attachment: Attachment;
} {
  return {
    shot: {
      view: 'Settings · light',
      attachmentId: DELEGATION_SHOT_ATTACHMENT as Attachment['id'],
      width: 1440,
      height: 1800,
      areas: 2,
      notes: [
        { n: 1, text: 'A search box at the top finds a setting by any word in it.' },
        { n: 2, text: 'The headings moved down a little to make room.' },
      ],
    },
    attachment: {
      id: DELEGATION_SHOT_ATTACHMENT as Attachment['id'],
      name: 'settings-search-light.png',
      contentType: 'image/png',
      size: 388_120,
      url: `/api/v1/burrows/${burrow}/attachments/${DELEGATION_SHOT_ATTACHMENT}`,
      kind: 'image',
      width: 1440,
      height: 1800,
    },
  };
}

/** The checklist, then the card at the stage asked for, as of `made` (ms). */
function settingsCard(
  made: number,
  stage: DelegationFixtureStage,
  burrow: string,
): { card: DelegationCard; attachments: Attachment[] } {
  const ago = (minutes: number) => new Date(made - minutes * 60_000).toISOString();
  const offered = SETTINGS_TASKS.map((seed, i) => delegationTask(i + 1, seed));
  const base: DelegationCard = {
    kind: 'delegation',
    delegationId: DELEGATION_ID as DelegationCard['delegationId'],
    title: 'Polish the Settings page',
    project: 'whombat-site',
    stage: 'offer',
    live: true,
    atOnce: 3,
    pullRequests: true,
    merge: true,
    ai: null,
    tasks: offered,
    outcome: null,
    note: null,
    startedAt: ago(20),
    handedAt: null,
    endedAt: null,
  };
  const handed = (n: number, over: Partial<DelegationCardTask>): DelegationCardTask => {
    const t = offered[n - 1] as DelegationCardTask;
    return { ...t, picked: true, url: `${T3}/${t.id.slice(4)}`, branch: `t3/${t.id.slice(4)}`, ...over };
  };
  const skipped = (n: number): DelegationCardTask => ({
    ...(offered[n - 1] as DelegationCardTask),
    state: 'skipped',
  });
  const merged = (n: number, pr: number, since: number, ended: number, note: string, program = 'Claude') =>
    handed(n, {
      state: 'done',
      program,
      since: ago(since),
      endedAt: ago(ended),
      pr: `${PRS}/${pr}`,
      merge: 'merged',
      checks: 'passing',
      note,
    });
  if (stage === 'offer') return { card: base, attachments: [] };
  const search = searchShot(burrow);
  if (stage === 'working')
    return {
      card: {
        ...base,
        stage: 'working',
        handedAt: ago(18),
        tasks: [
          merged(1, 41, 18, 9, 'The rows are taller now, so they’re easier to tap.'),
          merged(2, 42, 18, 7, 'Four headings: You, Neo, This Whombat and Advanced.', 'Codex'),
          skipped(3),
          // Its thread ended its run and T3 Code watches its pull request: no place held, no turning ring.
          handed(4, {
            state: 'working',
            checks: 'running',
            program: 'Claude',
            since: ago(7),
            pr: `${PRS}/45`,
            shots: [search.shot],
          }),
          handed(5, {
            state: 'working',
            merge: 'merging',
            checks: 'passing',
            step: 'Bringing the branch up to date',
            program: 'Claude',
            since: ago(16),
            pr: `${PRS}/43`,
          }),
          handed(6, {
            state: 'done',
            checks: 'failing',
            program: 'Codex',
            since: ago(18),
            endedAt: ago(4),
            pr: `${PRS}/44`,
            note: 'One test of saving still fails after three fixes; it needs a look.',
          }),
          // A question Neo answers itself: nothing for Mara to do.
          handed(7, { state: 'working', pending: 'question', program: 'Claude', since: ago(9) }),
        ],
        note: 'Rows and grouping are merged. Saving has a check that keeps failing, so I’m looking at it.',
      },
      attachments: [search.attachment],
    };
  return {
    card: {
      ...base,
      stage: 'done',
      live: false,
      outcome: 'incomplete',
      handedAt: ago(58),
      endedAt: ago(3),
      tasks: [
        merged(1, 41, 58, 46, 'The rows are taller now, so they’re easier to tap.'),
        merged(2, 42, 58, 31, 'Four headings: You, Neo, This Whombat and Advanced.', 'Codex'),
        skipped(3),
        handed(4, {
          state: 'failed',
          program: 'Claude',
          since: ago(31),
          endedAt: ago(3),
          note: 'The search box pushed the page sideways on small phones.',
        }),
        skipped(5),
        merged(6, 44, 58, 40, 'Changes save as you make them, with Undo for five seconds.', 'Codex'),
        merged(7, 46, 40, 22, 'Every label reaches 4.5:1 in the dark theme now.'),
      ],
      note: 'Four of the five are done and merged. Search ran into a problem on small phones; I can try it again another way.',
    },
    attachments: [],
  };
}

/** The council's checklist (council.md): the agreed plan's tasks, all ticked; Hand over is the go-ahead. */
export const COUNCIL_DELEGATION_ID = 'dlg_settings-council';

export function councilDelegationCard(made: number): DelegationCard {
  const ago = (minutes: number) => new Date(made - minutes * 60_000).toISOString();
  return {
    kind: 'delegation',
    delegationId: COUNCIL_DELEGATION_ID as DelegationCard['delegationId'],
    title: 'Make the Settings page easier to use',
    project: 'whombat-site',
    stage: 'offer',
    live: true,
    atOnce: 3,
    pullRequests: true,
    merge: true,
    council: true,
    ai: null,
    tasks: SETTINGS_TASKS.map(([id, title, why, over], i) =>
      delegationTask(i + 1, [
        id.replace('dlt_settings-', 'dlt_council-'),
        title,
        why,
        { after: over?.after ?? null, picked: true },
      ]),
    ),
    outcome: null,
    note: null,
    startedAt: ago(3),
    handedAt: null,
    endedAt: null,
  };
}

/** The thread as of `made` (ms) at the stage asked for. */
export function delegationThread(
  made: number,
  stage: DelegationFixtureStage,
  burrow = 'burrow-hq',
): DelegationThreadSeed {
  const { card, attachments } = settingsCard(made, stage, burrow);
  return {
    id: DELEGATION_ROOT,
    at: stage === 'done' ? 64 : 22,
    text: 'Can you polish the Settings page? Hand the work to T3 Code.',
    reply: {
      at: stage === 'done' ? 62 : 20,
      text: 'Here’s what I’d change. Each one goes to T3 Code on a branch of its own.',
      card,
      attachments,
    },
  };
}

/** A press on the card, as the session op's body has it. */
export type DelegationPress =
  | { op: 'pick'; taskId: string; picked: boolean }
  | { op: 'start' }
  | { op: 'stopTask'; taskId: string }
  | { op: 'stop' }
  /** The AI for one task (`taskId`) or every task; null: the default. */
  | { op: 'setAi'; taskId: string | null; ai: DelegationAiChoice | null };

/** What a handed-over task does first, in the demo world. */
const FIRST_STEP = 'Reading the code';

/** The AI chosen as the card says it, or why T3 Code can't run it here (its model, effort or fast tier). */
function aiOf(choice: DelegationAiChoice): DelegationAi | string {
  const model = DELEGATION_AI_OPTIONS.find((p) => p.id === choice.provider)?.models.find(
    (m) => m.id === choice.model,
  );
  if (!model) return 'T3 Code can’t run that model now.';
  if (choice.effort !== null && !model.efforts.includes(choice.effort))
    return `${model.label} doesn’t take that effort.`;
  if (choice.fast !== null && typeof model.fast !== 'boolean') return `${model.label} has no fast tier.`;
  return { ...choice, label: model.label };
}

/**
 * A press on the card as the server answers it: the card as it is after, or a refusal (404 when there is no such task,
 * 409 when the checklist was handed over already, nothing is ticked, or it ended; 400 for an AI T3 Code can't run).
 */
export function delegationPress(
  card: DelegationCard,
  press: DelegationPress,
  nowIso: string,
):
  | { card: DelegationCard; response: DelegationActionResponse }
  | { status: 400 | 404 | 409; message: string } {
  const answer = (next: DelegationCard) => ({
    card: next,
    response: { delegationId: next.delegationId, stage: next.stage },
  });
  if (!card.live) return { status: 409, message: 'This has ended.' };
  switch (press.op) {
    case 'pick': {
      if (card.stage !== 'offer') return { status: 409, message: 'These were handed over already.' };
      if (!card.tasks.some((t) => t.id === press.taskId)) return { status: 404, message: 'No such task.' };
      return answer({
        ...card,
        tasks: card.tasks.map((t) => (t.id === press.taskId ? { ...t, picked: press.picked } : t)),
      });
    }
    case 'setAi': {
      if (card.stage !== 'offer') return { status: 409, message: 'These were handed over already.' };
      if (press.taskId !== null && !card.tasks.some((t) => t.id === press.taskId))
        return { status: 404, message: 'No such task.' };
      const ai = press.ai ? aiOf(press.ai) : null;
      if (typeof ai === 'string') return { status: 400, message: ai };
      if (press.taskId === null) return answer({ ...card, ai });
      return answer({ ...card, tasks: card.tasks.map((t) => (t.id === press.taskId ? { ...t, ai } : t)) });
    }
    case 'start': {
      if (card.stage !== 'offer') return { status: 409, message: 'These were handed over already.' };
      if (!card.tasks.some((t) => t.state === 'offered' && t.picked))
        return { status: 409, message: 'Tick a task first.' };
      const queued = card.tasks.map(
        (t): DelegationCardTask =>
          t.state !== 'offered' ? t : { ...t, state: t.picked ? 'queued' : 'skipped' },
      );
      let room = card.atOnce;
      const tasks = queued.map((t): DelegationCardTask => {
        if (t.state !== 'queued' || t.after !== null || room === 0) return t;
        room -= 1;
        return {
          ...t,
          state: 'working',
          step: FIRST_STEP,
          program: 'Claude',
          since: nowIso,
          url: `${T3}/${t.id.slice(4)}`,
          branch: `t3/${t.id.slice(4)}`,
        };
      });
      return answer({ ...card, stage: 'working', handedAt: nowIso, tasks });
    }
    case 'stopTask': {
      const found = card.tasks.find((t) => t.id === press.taskId);
      if (!found) return { status: 404, message: 'No such task.' };
      const tasks = card.tasks.map(
        (t): DelegationCardTask =>
          t.id === press.taskId && (t.state === 'working' || t.state === 'queued')
            ? { ...t, state: 'stopped', pending: null, step: null, endedAt: nowIso }
            : t,
      );
      const going = tasks.some((t) => t.state === 'working' || t.state === 'queued');
      if (going || card.stage !== 'working') return answer({ ...card, tasks });
      const unfinished = tasks.some(
        (t) => t.state === 'failed' || t.state === 'stopped' || t.state === 'timed_out',
      );
      return answer({
        ...card,
        tasks,
        stage: 'done',
        live: false,
        outcome: unfinished ? 'incomplete' : 'done',
        endedAt: nowIso,
      });
    }
    case 'stop':
      return answer({
        ...card,
        stage: 'stopped',
        live: false,
        outcome: 'stopped',
        endedAt: nowIso,
        tasks: card.tasks.map(
          (t): DelegationCardTask =>
            t.state === 'working' || t.state === 'queued'
              ? { ...t, state: 'stopped', pending: null, step: null, endedAt: nowIso }
              : t,
        ),
      });
  }
}
