/**
 * Councils in Chat for fixture mode (option `council`, `VITE_FIXTURE_COUNCIL=1` or `whombat:fixture-council`; Whombat
 * council.md CNL-40…CNL-44, CNL-60…CNL-64): Mara's threads, each with a council of Claude, ChatGPT (Codex) and
 * Muse in another state, newest last:
 *
 * - research, live: the NAS backup question; Claude still at work, ChatGPT in with 8/10 and a long answer (the card holds
 *   its start, the rest is in T3 Code), Muse didn't answer in time;
 * - waiting for the go-ahead: the Inbox plan they agreed on, folded on the card, and its tasks on a checklist card under
 *   it in the same thread, waiting for Mara to hand them over (that is the go-ahead);
 * - the same for the Files page after Mara talked about the checklist: it moved to the thread's end with its change,
 *   and the words it left behind link to it (card-moves.md CM-07);
 * - build, live: the login page, where Mara said to go all the way: its tasks were handed over at once and work on the
 *   card under it (one merged, one at work, one after it);
 * - final: the Settings page, done, with its two rounds of scores, the plan and one picture of what changed (before on
 *   top, after below, two numbered areas) with its notes; the picture is the message's attachment, drawn in
 *   `shotFixtures.ts` and served at its API path (the session reads attachments only there);
 * - asked again: a review of the Inbox, its Tasks card, Mara's questions and a second review of the list, with the list
 *   as it was folded where she talked about it (card-moves.md CM-10), once ended and once while the second one works.
 *
 * The members of the live councils have their answers to read on their rows. Times count back from when the world was
 * made. Stop (`councils.stop`) changes the card in the world, as the server does, and stops its checklist too; the card
 * shows it on the next read (no socket here).
 */
import {
  type Attachment,
  COUNCIL_CARD_ANSWER_MAX,
  type CouncilCard,
  type CouncilCardMember,
  type CouncilRoundResult,
  type DelegationCard,
  type Message,
  type MessageCard,
  type RanOn,
} from '@whombat/core';
import { burrow } from '@whombat/fixtures';
import { fixtureDelegation, fixtureTasks, PR, T3 } from './delegationFixtures';
import { SHOT, shotPictureBytes } from './shotFixtures';

export const COUNCIL_RESEARCH_THREAD = 'msg_chat-council-nas';
/** The Inbox council whose plan's checklist waits under it (CNL-60). */
export const COUNCIL_CHECKLIST_THREAD = 'msg_chat-council-inbox';
/** The Files council whose checklist moved down after Mara changed it by talking (card-moves.md CM-07). */
export const COUNCIL_MOVED_THREAD = 'msg_chat-council-files';
export const COUNCIL_BUILD_THREAD = 'msg_chat-council-login';
/** A review, its tasks, more talk and the council again, with the Tasks card as it was where Mara talked (CM-10). */
export const COUNCIL_AGAIN_THREAD = 'msg_chat-council-again';
/** The same while the second council works, the list it checks waiting further up. */
export const COUNCIL_AGAIN_LIVE_THREAD = 'msg_chat-council-again-live';
export const COUNCIL_FINAL_THREAD = 'msg_chat-council-settings';
/** The visual suite's switch for the councils (as `whombat:fixture-looks`). */
export const COUNCIL_FIXTURE_KEY = 'whombat:fixture-council';

/** Whether the councils are in Chat: the option, else `VITE_FIXTURE_COUNCIL=1` or the visual suite's switch. */
export function councilSeeded(option: boolean | undefined): boolean {
  if (option !== undefined) return option;
  if (import.meta.env.VITE_FIXTURE_COUNCIL === '1') return true;
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(COUNCIL_FIXTURE_KEY) === '1';
  } catch {
    return false;
  }
}

/** The final card's picture: an attachment of its message, served at its API path (`councilShotBytes`). */
export const COUNCIL_SHOT_ID = 'att_council-settings-light';
export const COUNCIL_SHOT_URL = `/api/v1/burrows/${burrow.slug}/attachments/${COUNCIL_SHOT_ID}`;

/** The picture's PNG: what `GET …/attachments/att_council-settings-light` answers. */
export const councilShotBytes = shotPictureBytes;

const ON_OPUS: RanOn = { provider: 'claude', model: null, modelLabel: 'Opus', effort: null, fast: false };

type MakeMessage = (over: Partial<Message> & Pick<Message, 'id' | 'authorId' | 'createdAt'>) => Message;

/** The three members as T3 Code runs them (CNL-04): one per provider, best model first. */
const CLAUDE = { name: 'Claude Opus 5.5', provider: 'Claude', mark: 'claude' } as const;
const CODEX = { name: 'GPT 6.1 Sol', provider: 'Codex', mark: 'openai' } as const;
const MUSE = { name: 'Muse Wonder', provider: 'Muse Code', mark: null } as const;
type Who = typeof CLAUDE | typeof CODEX | typeof MUSE;

/** The Inbox plan the members agreed on (CNL-13: where each idea came from, what was dropped). */
export const COUNCIL_INBOX_PLAN = [
  '**Make the Inbox quicker to read and calmer to look at.**',
  '',
  '1. **Taller rows and buttons** (44 px), so they are easy to tap. *From Claude and ChatGPT.*',
  '2. **One line per item**: what it is and when; the rest opens in place. *From ChatGPT.*',
  '3. **Plainer words**: “Needs a look” instead of “Attention required”. *From Muse.*',
  '4. **Settle with one tap**, with Undo for five seconds. *From Claude.*',
  '5. **Later and Settled as tabs** at the top, not at the end of the list. *From Muse.*',
  '6. **Calmer colours**: only what is broken now is red. *From Claude.*',
  '',
  '**Dropped:** a search box (the Inbox rarely holds more than 20 items, Muse agreed) and swiping on a computer (a phone gesture).',
].join('\n');

const LOGIN_PLAN = [
  '1. **A bigger Sign in button**, the only filled button on the page. *From Claude.*',
  '2. **Say what went wrong** under the field it is about, in plain words. *From ChatGPT and Muse.*',
  '3. **Remember the email address** on this device. *From Muse.*',
  '',
  '**Dropped:** a picture on the page (it pushes the form down on a phone).',
].join('\n');

/** ChatGPT's answer to the NAS question: longer than the card holds, so its row says the rest is in T3 Code (CNL-64). */
const NAS_ANSWER = (() => {
  const lines = [
    '**Back up the NAS to Backblaze B2 with restic, every night.** About €3 a month for your 500 GB, and the copy is in another country if the house burns down.',
    '',
    '### Why this one',
    '- **Offsite and cheap**: B2 costs about €5.50 per TB a month, and you pay only for what you keep.',
    '- **Locked before it leaves**: restic encrypts on the NAS, so Backblaze only ever sees scrambled data.',
    '- **Only changes go up**: after the first upload a night sends what changed, usually under 1 GB.',
    '- **One file back is easy**: open a snapshot like a folder and copy what you need.',
    '',
    '### How to set it up',
    '1. Make a B2 bucket with object lock for 30 days, so nothing on the NAS can delete old copies.',
    '2. Make a key that may only write to that bucket.',
    '3. Install restic on the NAS and keep its password in two places, one of them on paper.',
    '4. Start the first backup on a Friday: 500 GB takes about two days on your upload.',
    '5. Keep 7 daily, 4 weekly and 12 monthly snapshots.',
    '6. Once a month, bring one file back and compare it.',
    '',
    '### Folder by folder',
    '',
    '| Folder | Size | Changes a night | A month |',
    '|---|---|---|---|',
  ];
  // The recent years month by month: those are the folders that still change.
  for (let year = 2026; year >= 2004; year--)
    if (year >= 2020)
      for (let month = 12; month >= 1; month--)
        lines.push(
          `| photos/${year}/${String(month).padStart(2, '0')} | ${1 + ((year + month) % 4)} GB | ${year === 2026 ? '0.1 GB' : 'none'} | €0.0${1 + ((year + month) % 3)} |`,
        );
    else lines.push(`| photos/${year} | ${8 + (year % 7) * 3} GB | none | €0.${10 + (year % 5)} |`);
  for (let year = 2026; year >= 2012; year--)
    lines.push(
      `| video/${year} | ${14 + (year % 4) * 6} GB | ${year === 2026 ? '0.6 GB' : 'none'} | €0.${20 + (year % 6)} |`,
    );
  lines.push(
    '',
    '### What I left out',
    '- **A second NAS at a friend’s house**: safer against a cloud closing down, but €400 up front and you have to look after it.',
    '- **Glacier-style storage**: cheaper to keep, but getting 500 GB back costs more than a year of B2 and takes hours.',
    '- **Syncing instead of backing up**: a deleted or encrypted file would be deleted or encrypted in the copy too.',
  );
  return lines.join('\n').slice(0, COUNCIL_CARD_ANSWER_MAX);
})();

const SETTINGS_PLAN = [
  '1. **Taller buttons and switches** (44 px). *From Claude and ChatGPT.*',
  '2. **Plainer section names**: “This Whombat” instead of “System”. *From Muse.*',
  '3. **Save as you go**, each change says “Saved”. *From Claude.*',
  '',
  '**Dropped:** a search box for 14 settings.',
].join('\n');

export function councilThreads({
  made,
  person,
  bot,
  message,
}: {
  made: number;
  person: Message['authorId'];
  bot: Message['authorId'];
  message: MakeMessage;
}): Message[] {
  const ago = (minutes: number) => new Date(made - minutes * 60_000).toISOString();
  let n = 0;
  const member = (
    who: Who,
    state: CouncilCardMember['state'],
    since: number,
    over: Partial<CouncilCardMember> = {},
  ): CouncilCardMember => ({
    id: `cnm_fixture${++n}` as CouncilCardMember['id'],
    ...who,
    role: 'member',
    state,
    score: null,
    verdict: null,
    since: ago(since),
    endedAt: null,
    step: null,
    url: null,
    answer: null,
    ...over,
  });
  const round = (
    stage: CouncilRoundResult['stage'],
    number: number,
    said: [Who, Partial<CouncilRoundResult['members'][number]>][],
  ): CouncilRoundResult => ({
    stage,
    round: number,
    members: said.map(([who, over]) => ({ ...who, state: 'done', score: null, verdict: null, ...over })),
  });
  const council = (over: Partial<CouncilCard> & Pick<CouncilCard, 'councilId' | 'title'>): CouncilCard => ({
    kind: 'council',
    what: 'improve',
    stage: 'research',
    round: 1,
    roundsMax: 3,
    target: 9,
    live: true,
    members: [],
    history: [],
    plan: null,
    shots: [],
    outcome: null,
    startedAt: ago(60),
    endedAt: null,
    ...over,
  });
  const thread = (
    root: string,
    minutes: number,
    ask: string,
    // An answer of the agent's: `intro` its words above the card, `text` its thoughts or conclusion under it (a council's
    // card, or the checklist of its plan's tasks under it).
    answers: {
      intro?: string;
      text: string;
      card?: CouncilCard | DelegationCard;
      attachments?: Attachment[];
      at: number;
    }[],
  ): Message[] => [
    message({ id: root as Message['id'], authorId: person, createdAt: ago(minutes), text: ask }),
    ...answers.map((a, i) =>
      message({
        id: `${root}-${i + 1}` as Message['id'],
        authorId: bot,
        createdAt: ago(a.at),
        threadRootId: root as Message['id'],
        text: a.intro ?? a.text,
        ranOn: ON_OPUS,
        ...(a.card ? { card: (a.intro ? { ...a.card, note: a.text } : a.card) as MessageCard } : {}),
        ...(a.attachments ? { attachments: a.attachments } : {}),
      }),
    ),
  ];

  /** The Inbox plan's tasks, on the checklist under its council, waiting to be handed over (CNL-60). */
  const inboxChecklist = (): DelegationCard => {
    const t = fixtureTasks('cinbox');
    return fixtureDelegation(ago, {
      delegationId: 'dlg_fixturecouncilinbox' as DelegationCard['delegationId'],
      title: 'Improve the Inbox',
      council: true,
      startedAt: ago(2),
      tasks: [
        t(1, 'Taller rows and buttons', { why: 'Rows are hard to tap on a phone now.' }),
        t(2, 'One line per item', { why: 'Each item takes three lines now.', after: 1 }),
        t(3, 'Plainer words', { why: '“Attention required” sounds like something broke.' }),
        t(4, 'Settle with one tap', { why: 'Settling takes a menu now.' }),
        t(5, 'Later and Settled as tabs', { why: 'They are at the end of a long list now.' }),
        t(6, 'Calmer colours', { why: 'Red shows for things that aren’t broken.', after: 1 }),
      ],
    });
  };

  /** The login plan's tasks, handed over at once (the person said to go all the way). */
  const loginTasks = (): DelegationCard => {
    const t = fixtureTasks('clogin');
    return fixtureDelegation(ago, {
      delegationId: 'dlg_fixturecouncillogin' as DelegationCard['delegationId'],
      title: 'Make the login page clearer',
      council: true,
      stage: 'working',
      startedAt: ago(8),
      handedAt: ago(8),
      tasks: [
        t(1, 'A bigger Sign in button', {
          state: 'done',
          checks: 'passing',
          merge: 'merged',
          program: 'Claude',
          since: ago(8),
          endedAt: ago(3),
          url: `${T3}/login-button`,
          branch: 'delegate/login-button',
          pr: `${PR}/830`,
        }),
        t(2, 'Say what went wrong', {
          state: 'working',
          program: 'Claude',
          step: 'Changing LoginPage.tsx',
          since: ago(8),
          url: `${T3}/login-errors`,
          branch: 'delegate/login-errors',
        }),
        t(3, 'Remember the email address', { state: 'queued', after: 2 }),
      ],
    });
  };

  const final = council({
    councilId: 'cnl_fixturesettings' as CouncilCard['councilId'],
    title: 'Improve the Settings page',
    stage: 'done',
    round: 1,
    live: false,
    // The last check's answers, still readable on the final card.
    members: [
      member(CLAUDE, 'done', 155, {
        score: 9,
        verdict: 'agree',
        endedAt: ago(151),
        answer: 'The section names say what they hold now, and the buttons are easy to hit. 9/10.',
      }),
      member(CODEX, 'done', 155, {
        score: 9.5,
        verdict: 'agree',
        endedAt: ago(152),
        answer: 'Clearer and calmer. The taller buttons fixed the misses on a phone.',
      }),
      member(MUSE, 'done', 155, {
        score: 9,
        verdict: 'agree',
        endedAt: ago(151),
        answer: 'Good. “This Whombat” reads much better than “System”.',
      }),
    ],
    history: [
      round('research', 1, [
        [CLAUDE, { score: 6 }],
        [CODEX, { score: 7 }],
        [MUSE, { score: 6.5 }],
      ]),
      round('check', 1, [
        [CLAUDE, { score: 9, verdict: 'agree' }],
        [CODEX, { score: 9.5, verdict: 'agree' }],
        [MUSE, { score: 9, verdict: 'agree' }],
      ]),
    ],
    plan: SETTINGS_PLAN,
    shots: [
      {
        view: 'Settings · light',
        attachmentId: COUNCIL_SHOT_ID as CouncilCard['shots'][number]['attachmentId'],
        width: SHOT.width,
        height: SHOT.height,
        areas: 2,
        notes: [
          { n: 1, text: '“System” is now “This Whombat”, so it says what it is.' },
          { n: 2, text: 'The buttons are taller, so they are easier to tap.' },
        ],
      },
    ],
    outcome: 'done',
    startedAt: ago(190),
    endedAt: ago(150),
  });

  /** The Files plan's checklist as first offered, which Mara talked about: kept folded under its intro (CM-10). */
  const filesOffered = (): DelegationCard => {
    const t = fixtureTasks('cfiles');
    return fixtureDelegation(ago, {
      delegationId: 'dlg_fixturecouncilfiles' as DelegationCard['delegationId'],
      title: 'Improve the Files page',
      council: true,
      startedAt: ago(14),
      tasks: [
        t(2, 'Bigger file rows', { why: 'Rows are hard to tap on a phone now.' }),
        t(1, 'Upload button at the top', { why: 'It is under the list now, out of sight.' }),
        t(3, 'Plainer sizes', { why: '“1048576 bytes” instead of “1 MB”.' }),
        t(4, 'A search box', { why: 'Finding a file means scrolling now.' }),
      ].map((task, i) => ({ ...task, n: i + 1 })),
    });
  };
  /** The Files plan's checklist after Mara's change: the search box is off, the upload button first. */
  const filesChecklist = (): DelegationCard => {
    const t = fixtureTasks('cfiles');
    return fixtureDelegation(ago, {
      delegationId: 'dlg_fixturecouncilfiles' as DelegationCard['delegationId'],
      title: 'Improve the Files page',
      council: true,
      startedAt: ago(14),
      changed: {
        at: ago(5),
        said: ['Took off “A search box”', 'Moved “Upload button at the top” to the top'],
      },
      tasks: [
        t(1, 'Upload button at the top', { why: 'It is under the list now, out of sight.' }),
        t(2, 'Bigger file rows', { why: 'Rows are hard to tap on a phone now.' }),
        t(3, 'Plainer sizes', { why: '“1048576 bytes” instead of “1 MB”.' }),
      ],
    });
  };
  const filesRoot = COUNCIL_MOVED_THREAD as Message['id'];
  const filesReply = (n: number, at: number, over: Partial<Message> & { text: string }): Message =>
    message({
      id: `${filesRoot}-${n}` as Message['id'],
      authorId: bot,
      createdAt: ago(at),
      threadRootId: filesRoot,
      ranOn: ON_OPUS,
      ...over,
    });
  const moved = [
    message({
      id: filesRoot,
      authorId: person,
      createdAt: ago(30),
      text: 'Can the council look at the Files page? Make it 9 out of 10.',
    }),
    filesReply(1, 29, {
      text: 'I asked the council how to make the Files page easier to use, aiming for 9 out of 10.',
      card: {
        ...council({
          councilId: 'cnl_fixturefiles' as CouncilCard['councilId'],
          title: 'Improve the Files page',
          stage: 'approve',
          startedAt: ago(29),
          history: [
            round('research', 1, [
              [CLAUDE, { score: 6 }],
              [CODEX, { score: 6.5 }],
              [MUSE, { score: 7 }],
            ]),
          ],
          members: [
            member(CLAUDE, 'done', 20, { verdict: 'agree', endedAt: ago(16) }),
            member(CODEX, 'done', 20, { verdict: 'agree', endedAt: ago(15) }),
            member(MUSE, 'done', 20, { verdict: 'agree', endedAt: ago(15) }),
          ],
          plan: '1. **Upload button at the top.**\n2. **Bigger file rows.**\n3. **Plainer sizes.**\n4. **A search box.**',
        }),
        note: 'The council agreed on a plan. Hand over its tasks on the Tasks card to start.',
      } as MessageCard,
    }),
    // The checklist's intro: its card moved to the end with Mara's change; she talked about it, so it stays here as it was.
    filesReply(2, 14, {
      text: 'Here is the plan as four tasks for T3 Code. Tick what you want and hand them over.',
      movedCard: { kind: 'delegation', id: 'dlg_fixturecouncilfiles' },
      earlierCard: filesOffered() as MessageCard,
    }),
    message({
      id: `${filesRoot}-3` as Message['id'],
      authorId: person,
      createdAt: ago(6),
      threadRootId: filesRoot,
      text: 'Drop the search box. And can the upload button go first?',
    }),
    filesReply(4, 5, { text: 'I took the search box off and made the upload button the first task.' }),
    filesReply(5, 5, { text: '', card: filesChecklist() as MessageCard }),
  ];

  /**
   * A review of the Inbox, its tasks, more talk and the council asked again (card-moves.md CM-10): where Mara talked
   * after the Tasks card, the card as it was stays folded there; `live`: the second council still at work, the list it
   * checks waiting above it.
   */
  const againThread = (root: string, live: boolean): Message[] => {
    const R = root as Message['id'];
    let k = 0;
    const said = (at: number, over: Partial<Message> & { text: string }, who = bot): Message =>
      message({
        id: `${root}-${++k}` as Message['id'],
        authorId: who,
        createdAt: ago(at),
        threadRootId: R,
        ...(who === bot ? { ranOn: ON_OPUS } : {}),
        ...over,
      });
    const t = fixtureTasks(`again${live ? 'l' : 'f'}`);
    const firstReview = council({
      councilId: `cnl_${root}-1` as CouncilCard['councilId'],
      what: 'review',
      title: 'Review the Inbox',
      target: null,
      stage: 'done',
      live: false,
      outcome: 'done',
      startedAt: ago(139),
      endedAt: ago(104),
      members: [
        member(CLAUDE, 'done', 139, {
          score: 6,
          endedAt: ago(121),
          answer: 'Rows are cramped on a phone and “Attention required” sounds like something broke. 6/10.',
        }),
        member(CODEX, 'done', 139, {
          score: 7,
          endedAt: ago(113),
          answer: 'Clear enough, but each item takes three lines, so you see four items at once. 7/10.',
        }),
        member(MUSE, 'done', 139, {
          score: 6.5,
          endedAt: ago(105),
          answer: 'Red shows for things that aren’t broken. Later and Settled are hard to find. 6.5/10.',
        }),
      ],
      history: [
        round('research', 1, [
          [CLAUDE, { score: 6 }],
          [CODEX, { score: 7 }],
          [MUSE, { score: 6.5 }],
        ]),
      ],
    });
    // The list as first offered, then with Mara's search box, then as the council's second look left it.
    const tasksV0 = (): DelegationCard =>
      fixtureDelegation(ago, {
        delegationId: `dlg_${root}` as DelegationCard['delegationId'],
        title: 'Calm down the Inbox',
        startedAt: ago(104),
        tasks: [
          t(1, 'Taller rows and buttons', { why: 'Rows are hard to tap on a phone now.' }),
          t(2, 'One line per item', { why: 'Each item takes three lines now.' }),
          t(3, 'Plainer words', { why: '“Attention required” sounds like something broke.' }),
          t(4, 'Later and Settled as tabs', { why: 'They are at the end of a long list now.' }),
        ],
      });
    const tasksV1 = (): DelegationCard =>
      fixtureDelegation(ago, {
        delegationId: `dlg_${root}` as DelegationCard['delegationId'],
        title: 'Calm down the Inbox',
        startedAt: ago(104),
        tasks: [
          t(1, 'Taller rows and buttons', { why: 'Rows are hard to tap on a phone now.' }),
          t(2, 'One line per item', { why: 'Each item takes three lines now.' }),
          t(3, 'Plainer words', { why: '“Attention required” sounds like something broke.' }),
          t(4, 'Later and Settled as tabs', { why: 'They are at the end of a long list now.' }),
          t(5, 'A search box', { why: 'Mara can’t find old items.' }),
        ],
      });
    const tasksV2 = (): DelegationCard =>
      fixtureDelegation(ago, {
        delegationId: `dlg_${root}` as DelegationCard['delegationId'],
        title: 'Calm down the Inbox',
        startedAt: ago(104),
        changed: { at: ago(29.9), said: ['Took off “A search box”', 'Moved “One line per item” to the top'] },
        tasks: [
          t(1, 'One line per item', { why: 'Each item takes three lines now. The rest builds on it.' }),
          t(2, 'Taller rows and buttons', { why: 'Rows are hard to tap on a phone now.', after: 1 }),
          t(3, 'Plainer words', { why: '“Attention required” sounds like something broke.' }),
          t(4, 'Later and Settled as tabs', { why: 'They are at the end of a long list now.' }),
        ],
      });
    const secondReview = (done: boolean): CouncilCard =>
      council({
        councilId: `cnl_${root}-2` as CouncilCard['councilId'],
        what: 'review',
        title: 'Review the new Inbox tasks',
        target: null,
        stage: done ? 'done' : 'research',
        live: !done,
        outcome: done ? 'done' : null,
        startedAt: ago(59),
        endedAt: done ? ago(30) : null,
        members: [
          member(CLAUDE, done ? 'done' : 'working', 59, {
            ...(done
              ? {
                  score: 8,
                  endedAt: ago(31),
                  answer: 'Good list. Do the one-line rows first: the taller rows depend on them. 8/10.',
                }
              : { step: 'Reading InboxRow.tsx' }),
          }),
          member(CODEX, 'done', 59, {
            score: 8.5,
            endedAt: ago(40),
            answer: 'Right four things, but drop the search box: the Inbox rarely holds 20 items. 8.5/10.',
          }),
          member(MUSE, 'done', 59, {
            score: 8,
            endedAt: ago(45),
            answer: 'Agree with the list. A search box isn’t worth it for so few items. 8/10.',
          }),
        ],
        history: done
          ? [
              round('research', 1, [
                [CLAUDE, { score: 8 }],
                [CODEX, { score: 8.5 }],
                [MUSE, { score: 8 }],
              ]),
            ]
          : [],
      });
    const card = (c: CouncilCard | DelegationCard, note: string | null) =>
      ({ ...c, note }) as unknown as MessageCard;
    const head: Message[] = [
      message({
        id: R,
        authorId: person,
        createdAt: ago(140),
        text: 'Can the council review the Inbox and give it a score? It feels busy to me.',
      }),
      said(139, {
        text: 'I asked the council to review the Inbox and score it.',
        movedCard: { kind: 'council', id: firstReview.councilId },
      }),
      said(120, {
        text: 'Claude gives it 6: the rows are cramped on a phone and “Attention required” sounds alarming.',
      }),
      said(112, {
        text: 'ChatGPT gives it 7: clear enough, but every item takes three lines. Waiting for Muse.',
      }),
      said(104, { text: '', card: card(firstReview, 'The council finished.') }),
      // The review's conclusion, its tasks on it (council.md CNL-72); Mara talked about the list after it, so the list
      // as it was stays here.
      said(103.95, {
        text: 'The council gives the Inbox 6 to 7 out of 10. All three find it busy: cramped rows, three lines per item and words that sound alarming.\n\nHere is what they found as four tasks for T3 Code. Tick what you want and hand them over.',
        movedCard: { kind: 'delegation', id: `dlg_${root}` },
        earlierCard: tasksV0() as MessageCard,
      }),
      said(90, { text: 'Why is “Calmer colours” not in there? I thought Muse wanted it.' }, person),
      said(89, {
        text: 'Muse mentioned it, but Claude and ChatGPT didn’t, so I left it out. Want me to add it?',
      }),
      said(80, { text: 'No, fine. But add a search box, I can never find old items.' }, person),
    ];
    if (live)
      return [
        ...head,
        // The council is looking at this list now: Hand over waits for its answer.
        said(79.1, {
          text: '',
          card: card(
            { ...tasksV1(), checking: true, changed: { at: ago(79.1), said: ['Added “A search box”'] } },
            null,
          ),
        }),
        said(79, { text: 'I added a search box as task 5.' }),
        said(60, { text: 'Ask the council again if this list is right now, before I hand it over.' }, person),
        // Mara asked how it went while it worked, so the council's card as it was then stays here.
        said(59, {
          text: 'I asked the council whether the five tasks are the right ones now.',
          movedCard: { kind: 'council', id: `cnl_${root}-2` },
          earlierCard: card(
            {
              ...secondReview(false),
              members: secondReview(false).members.map((m) =>
                m.name === CODEX.name
                  ? { ...m, state: 'working', score: null, endedAt: null, answer: null }
                  : m,
              ),
            },
            null,
          ),
        }),
        said(44, { text: 'Muse agrees with the list but says a search box isn’t worth it for 20 items.' }),
        said(43, { text: 'Is it nearly done?' }, person),
        said(42.9, { text: 'Muse has answered; Claude and ChatGPT are still reading.' }),
        said(40, { text: '', card: card(secondReview(false), null) }),
        said(39, { text: 'ChatGPT gives it 8.5 and also says to drop the search box. Waiting for Claude.' }),
      ];
    return [
      ...head,
      // The list with the search box, which Mara asked the council about: kept where it was.
      said(79.1, {
        text: '',
        movedCard: { kind: 'delegation', id: `dlg_${root}` },
        earlierCard: tasksV1() as MessageCard,
      }),
      said(79, { text: 'I added a search box as task 5.' }),
      said(60, { text: 'Ask the council again if this list is right now, before I hand it over.' }, person),
      said(59, {
        text: 'I asked the council whether the five tasks are the right ones now.',
        movedCard: { kind: 'council', id: `cnl_${root}-2` },
      }),
      said(44, { text: 'Muse agrees with the list but says a search box isn’t worth it for 20 items.' }),
      said(39, { text: 'ChatGPT gives it 8.5 and also says to drop the search box. Waiting for Claude.' }),
      said(30, { text: '', card: card(secondReview(true), 'The council finished.') }),
      said(29.95, {
        text: 'All three give the new list 8 out of 10. Two say to drop the search box, and Claude wants the one-line rows done first. I changed the Tasks card to match.',
      }),
      said(29.9, { text: '', card: card(tasksV2(), null) }),
    ];
  };

  return [
    ...againThread(COUNCIL_AGAIN_THREAD, false),
    ...againThread(COUNCIL_AGAIN_LIVE_THREAD, true),
    ...moved,
    ...thread(
      COUNCIL_FINAL_THREAD,
      192,
      'Ask the council to improve the Settings page until they all give it 9 out of 10.',
      [
        {
          at: 150,
          intro:
            'I asked the council to make the Settings page easier to use, until all three give it 9 out of 10.',
          text: 'The Settings page is done: all three give it 9 or more now, up from 6 or 7. The section names are plainer and the buttons are taller, and both changes are merged.',
          card: final,
          attachments: [
            {
              id: COUNCIL_SHOT_ID as Attachment['id'],
              name: 'settings-light.png',
              contentType: 'image/png',
              size: councilShotBytes().byteLength,
              url: COUNCIL_SHOT_URL,
              kind: 'image',
              width: SHOT.width,
              height: SHOT.height,
            },
          ],
        },
      ],
    ),
    ...thread(
      COUNCIL_BUILD_THREAD,
      48,
      'Ask the council to make the login page clearer. Go all the way, no need to ask me.',
      [
        {
          at: 9,
          intro:
            'I asked the council to make the login page clearer, and to build it without asking you first.',
          text: 'All three agreed on the plan, so I handed its three tasks to T3 Code at once. The council checks the result when they are merged.',
          card: council({
            councilId: 'cnl_fixturelogin' as CouncilCard['councilId'],
            title: 'Make the login page clearer',
            stage: 'build',
            startedAt: ago(47),
            history: [
              round('research', 1, [
                [CLAUDE, { score: 5 }],
                [CODEX, { score: 6 }],
                [MUSE, { score: 6 }],
              ]),
            ],
            members: [
              member(CLAUDE, 'done', 16, {
                verdict: 'agree',
                endedAt: ago(11),
                answer:
                  'I agree with the plan. The bigger button and the error under its field fix what confused people most.',
              }),
              member(CODEX, 'done', 16, {
                verdict: 'agree',
                endedAt: ago(12),
                answer:
                  'Agreed. Keep the error words short: “That password isn’t right” rather than an error code.',
              }),
              member(MUSE, 'done', 16, {
                verdict: 'agree',
                endedAt: ago(10),
                answer:
                  'Agreed, and good that the picture was dropped: on a phone the form is the first thing you see now.',
              }),
            ],
            plan: LOGIN_PLAN,
          }),
        },
        {
          at: 8,
          intro: 'Here are the plan’s three tasks, handed to T3 Code.',
          text: 'The button is merged. T3 Code is on the error words now; remembering the email comes after, as it changes the same page.',
          card: loginTasks(),
        },
      ],
    ),
    ...thread(
      COUNCIL_CHECKLIST_THREAD,
      40,
      'Can the council have a look at the Inbox? It feels busy. Make it 9 out of 10.',
      [
        {
          at: 3,
          intro: 'I asked the council how to make the Inbox feel less busy, aiming for 9 out of 10.',
          text: 'The council agreed on a plan. Hand over its tasks on the Tasks card to start.',
          card: council({
            councilId: 'cnl_fixtureinbox' as CouncilCard['councilId'],
            title: 'Improve the Inbox',
            stage: 'approve',
            startedAt: ago(39),
            history: [
              round('research', 1, [
                [CLAUDE, { score: 6 }],
                [CODEX, { score: 7 }],
                [MUSE, { score: 6.5 }],
              ]),
              round('agree', 1, [
                [CLAUDE, { verdict: 'agree' }],
                [CODEX, { verdict: 'changes' }],
                [MUSE, { verdict: 'agree' }],
              ]),
            ],
            members: [
              member(CLAUDE, 'done', 12, {
                verdict: 'agree',
                endedAt: ago(5),
                answer: 'I agree. Settle with one tap and Undo is the change people will notice most.',
              }),
              member(CODEX, 'done', 12, {
                verdict: 'agree',
                endedAt: ago(4),
                answer:
                  'Agreed now that each item is one line. Do the rows first: the other changes build on them.',
              }),
              member(MUSE, 'done', 12, {
                verdict: 'agree',
                endedAt: ago(3),
                answer:
                  'Agreed. Plainer words matter more than they look: “Attention required” made people think something was broken.',
              }),
            ],
            plan: COUNCIL_INBOX_PLAN,
          }),
        },
        {
          at: 2,
          intro:
            'Here is the plan as six tasks for T3 Code. Tick what you want and hand them over; the council checks the result.',
          text: 'Each task gets its own branch and pull request, and I merge each one once its checks pass.',
          card: inboxChecklist(),
        },
      ],
    ),
    ...thread(
      COUNCIL_RESEARCH_THREAD,
      62,
      'Ask the council how I should back up the NAS offsite. Cheap, and safe if the house burns down.',
      [
        {
          at: 1,
          intro: 'I asked the council for a cheap offsite backup of the NAS that survives a house fire.',
          text: 'ChatGPT suggests Backblaze B2 with restic, about €3 a month for your 500 GB. Muse ran out of time. Waiting for Claude.',
          card: council({
            councilId: 'cnl_fixturenas' as CouncilCard['councilId'],
            what: 'research',
            title: 'Back up the NAS offsite',
            target: null,
            startedAt: ago(61),
            members: [
              member(CLAUDE, 'working', 58, { url: 'http://thetitan:3773/env-1/council-claude' }),
              member(CODEX, 'done', 58, {
                score: 8,
                endedAt: ago(36),
                url: 'http://thetitan:3773/env-1/council-codex',
                answer: NAS_ANSWER,
              }),
              member(MUSE, 'no_answer', 58, { endedAt: ago(0.5) }),
            ],
          }),
        },
      ],
    ),
  ];
}

/**
 * What Stop does to a council's card here, as the server does (CNL-43): it ends it and stops the members at work. Null
 * when the press doesn't apply (it ended already). The checklist of its plan stops with it (`chatChannelFixtures.ts`).
 */
export function pressCouncil(card: CouncilCard, now: number): CouncilCard | null {
  const at = new Date(now).toISOString();
  if (!card.live) return null;
  return {
    ...card,
    stage: 'stopped',
    live: false,
    outcome: 'stopped',
    endedAt: at,
    members: card.members.map((m) => (m.state === 'working' ? { ...m, state: 'stopped', endedAt: at } : m)),
  };
}
