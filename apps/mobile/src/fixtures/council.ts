/**
 * Councils in the demo world's Chat (Whombat docs/decisions/council.md): three threads where
 * Mara asked Neo to ask the council — a review at work (Claude still working, GPT gave 8/10 with a long answer that
 * T3 Code has the rest of, Muse didn't answer), the Settings page's plan the members agreed on, waiting for the
 * go-ahead (its tasks on the checklist card under it, waiting for her Hand over), and the login page done (every round's scores, the plan, a
 * picture of what changed with its notes). Stop ends a council on its message (`message.updated`), as the server does.
 * Pure TypeScript.
 */
import {
  type Attachment,
  COUNCIL_CARD_ANSWER_MAX,
  type CouncilCard,
  type CouncilCardMember,
  type CouncilRoundResult,
  type DelegationCard,
} from '@whombat/core';
import { councilDelegationCard } from './delegation';

/** The threads' first messages (Mara's asks). */
export const COUNCIL_ROOTS = {
  review: 'msg_chat-council-review',
  build: 'msg_chat-council-build',
  final: 'msg_chat-council-final',
} as const;

/** The councils, for Stop. */
export const COUNCIL_IDS = {
  review: 'cnl_backup-review',
  build: 'cnl_settings-page',
  final: 'cnl_login-page',
} as const;

/** The final card's picture: the login page before on top, after below. */
export const COUNCIL_SHOT_ATTACHMENT = 'att_council-login-light';

type Seed = [authorId: 'mara' | 'agent', minutesAgo: number, text: string, extra?: CouncilExtra];
interface CouncilExtra {
  /** The council's card, or the checklist of its plan's tasks under it. */
  card: CouncilCard | DelegationCard;
  attachments?: Attachment[];
}

/**
 * GPT's review of the backup plan, longer than the card opens to: the card has its first 6,000 characters, and
 * “The rest is in T3 Code”.
 */
function longReview(): string {
  const shares: [string, string][] = [
    [
      'Photos',
      'The nightly copy to the second NAS is right for photos: they change little and matter most. Keep 30 daily and 12 monthly versions, so a photo deleted by mistake in spring can still come back in autumn. The weekly copy to the cloud is good too; make sure it keeps deleted files for at least 90 days, or a sync of an empty folder empties the cloud as well.',
    ],
    [
      'Documents',
      'Documents change every day, so the hourly snapshot on the NAS itself is a good first line. It isn’t a backup on its own, though: a broken disk pool takes the snapshots with it. The nightly copy covers that. I’d add the scanned paperwork folder to the cloud copy as well, since it can’t be made again.',
    ],
    [
      'Media',
      'Leaving films and series out of the cloud copy is sensible: they are large and can be found again. Keep them in the copy to the second NAS only if there is room; otherwise a list of what you had is enough, which the plan doesn’t make yet.',
    ],
    [
      'Virtual machines',
      'The plan backs up the VMs on pve-01 and pve-02 every night with the hypervisor’s own backups. Those land on the same NAS as everything else, which is fine, but the job runs at 02:00, the same time as the copy to the second NAS. Move one of them an hour, or the copy may pick up half-written backup files.',
    ],
    [
      'Home Assistant',
      'Home Assistant makes its own backups, and the plan keeps the last seven. That is enough for a bad update. Copy them off the box too: if its disk dies, the backups on it go with it.',
    ],
    [
      'Mail archive',
      'The mail archive is in the plan once a month. Mail you can’t get from the provider any more is as precious as photos; I’d copy it weekly at least.',
    ],
  ];
  const parts = [
    '**8/10.** A sound plan: three copies, two places, one off site, and it is written down. What keeps it from a 9 is that nothing tests a restore, and two jobs collide at night.',
    '',
    '## Share by share',
    '',
    ...shares.flatMap(([name, text]) => [`### ${name}`, '', text, '']),
    '## What I’d change',
    '',
    '1. **Test a restore every month**: pick one file and one VM at random and bring them back somewhere else. A backup nobody has restored is a hope, not a backup.',
    '2. **Move the VM backups to 03:00**, so they don’t overlap the copy to the second NAS.',
    '3. **Copy Home Assistant’s backups off the box**, to the NAS with the rest.',
    '4. **Mail weekly** instead of monthly.',
    '5. **Write down how to restore**, not only how it backs up: where the keys are, which order to bring things back in, and who to call.',
    '',
    '## How I checked',
    '',
    'I read the plan, the NAS’s backup jobs and their logs of the last two weeks, and the cloud copy’s settings. Every job ran, two with warnings about files that were in use; those were the VM backups that collide with the copy.',
    '',
  ];
  let text = parts.join('\n');
  // Long enough that the card has only its start, as the server cuts it.
  while (text.length < COUNCIL_CARD_ANSWER_MAX)
    text += `\n${shares.map(([name, line]) => `**${name}, once more in detail.** ${line}`).join('\n\n')}\n`;
  return text.slice(0, COUNCIL_CARD_ANSWER_MAX);
}

export interface CouncilThreadSeed {
  id: string;
  /** Mara's ask, minutes ago. */
  at: number;
  text: string;
  replies: Seed[];
}

const T3 = 'https://t3.example/threads';
const CLAUDE = { name: 'Claude Opus 5.5', provider: 'Claude', mark: 'claude' } as const;
const GPT = { name: 'GPT 6.1 Sol', provider: 'Codex', mark: 'openai' } as const;
const MUSE = { name: 'Muse Wonder', provider: 'Muse Code', mark: null } as const;

/**
 * The agent's line before a council's card becomes the card message's own words, and that message's words go under the
 * card (council.md CNL-40): one message says what was asked, shows the card, then the latest thoughts or the end.
 */
function withIntro(replies: readonly Seed[]): Seed[] {
  const out: Seed[] = [];
  for (const reply of replies) {
    const before = out.at(-1);
    const [who, minutes, text, extra] = reply;
    if (extra && before && before[0] === 'agent' && !before[3] && who === 'agent')
      out[out.length - 1] = [who, minutes, before[2], { ...extra, card: { ...extra.card, note: text } }];
    else out.push(reply);
  }
  return out;
}

/** The council threads as of `made` (ms), each a thread of Chat. */
export function councilThreads(made: number, burrow = 'burrow-hq'): CouncilThreadSeed[] {
  const ago = (minutes: number) => new Date(made - minutes * 60_000).toISOString();
  const member = (
    id: string,
    who: { name: string; provider: string; mark: CouncilCardMember['mark'] },
    over: Partial<CouncilCardMember>,
  ): CouncilCardMember => ({
    id: id as CouncilCardMember['id'],
    ...who,
    role: 'member',
    state: 'done',
    score: null,
    verdict: null,
    since: null,
    endedAt: null,
    step: null,
    url: null,
    answer: null,
    ...over,
  });
  const round = (
    stage: CouncilRoundResult['stage'],
    n: number,
    marks: [typeof CLAUDE | typeof GPT | typeof MUSE, Partial<CouncilRoundResult['members'][number]>][],
  ): CouncilRoundResult => ({
    stage,
    round: n,
    members: marks.map(([who, over]) => ({
      ...who,
      state: 'done',
      score: null,
      verdict: null,
      ...over,
    })),
  });
  const card = (
    over: Partial<CouncilCard> & Pick<CouncilCard, 'councilId' | 'what' | 'title'>,
  ): CouncilCard => ({
    kind: 'council',
    stage: 'research',
    round: 1,
    roundsMax: 3,
    target: null,
    live: true,
    members: [],
    history: [],
    plan: null,
    shots: [],
    outcome: null,
    startedAt: ago(30),
    endedAt: null,
    ...over,
  });
  const settingsPlan = [
    'One plan from all three reviews:',
    '',
    '1. **Group the settings** under four headings: You, Neo, This Whombat and Advanced (Claude, GPT).',
    '2. **Bigger rows**: every row 52 pt tall with its switch at the end, so it’s easy to tap (all three).',
    '3. **Plain names**: “Who can sign in” instead of “Access control” (Muse).',
    '4. **Search** at the top of the page, which finds a setting by any word in it (GPT).',
    '5. **One save**: changes save as you make them, with Undo for a few seconds (Claude).',
    '6. Move *Danger zone* to the bottom of Advanced (Muse).',
    '7. Keep the dark theme’s contrast at 4.5:1 for every label (Claude).',
    '',
    '**Dropped**: a second sidebar for sub-pages (GPT): the four headings make it unneeded.',
  ].join('\n');
  const loginPlan = [
    '1. **Fewer words** on the login page: one line under the logo (all three).',
    '2. **Taller buttons** (52 pt) with more room between them (Claude, GPT).',
    '3. **Passkey first**, then email (Muse).',
    '',
    '**Dropped**: a background picture (GPT): it made the page slower on phones.',
  ].join('\n');
  const threads: CouncilThreadSeed[] = [
    {
      id: COUNCIL_ROOTS.review,
      at: 24,
      text: 'Ask the council to review my new backup plan for the NAS.',
      replies: [
        ['agent', 23, 'I’ve asked Claude, ChatGPT and Muse to review it, each on their own.'],
        [
          'agent',
          4,
          'GPT gives it 8: it likes the schedule but wants a test restore every month. Muse didn’t answer in time. Waiting for Claude.',
          {
            card: card({
              councilId: COUNCIL_IDS.review as CouncilCard['councilId'],
              what: 'review',
              title: 'Review the NAS backup plan',
              roundsMax: 1,
              startedAt: ago(23),
              members: [
                member('cnm_review-claude', CLAUDE, { state: 'working', since: ago(22) }),
                member('cnm_review-gpt', GPT, {
                  score: 8,
                  since: ago(22),
                  endedAt: ago(5),
                  url: `${T3}/backup-review-gpt`,
                  answer: longReview(),
                }),
                member('cnm_review-muse', MUSE, { state: 'no_answer', since: ago(22), endedAt: ago(2) }),
              ],
            }),
          },
        ],
      ],
    },
    {
      id: COUNCIL_ROOTS.build,
      at: 95,
      text: 'Ask the council to make the Settings page easier to use, until they all give it 9.',
      replies: [
        ['agent', 94, 'I’ve asked Claude, ChatGPT and Muse to look at the Settings page, each on their own.'],
        [
          'agent',
          3,
          'All three agree on the plan. Hand over its tasks on the Tasks card and T3 Code builds them, then the council checks the result.',
          {
            card: card({
              councilId: COUNCIL_IDS.build as CouncilCard['councilId'],
              what: 'improve',
              title: 'Make the Settings page easier to use',
              // It waits for the go-ahead: the checklist's Hand over (CNL-68).
              stage: 'approve',
              round: 1,
              target: 9,
              startedAt: ago(94),
              members: [
                member('cnm_settings-claude', CLAUDE, {
                  verdict: 'agree',
                  since: ago(20),
                  endedAt: ago(9),
                  url: `${T3}/settings-claude`,
                  answer:
                    'I agree with the plan. Grouping and bigger rows fix most of what I found; keep the switches at the end of each row so a thumb finds them in the same place.',
                }),
                member('cnm_settings-gpt', GPT, {
                  verdict: 'agree',
                  since: ago(20),
                  endedAt: ago(6),
                  url: `${T3}/settings-gpt`,
                  answer:
                    'Agreed. Two small things:\n\n- Search should also find a setting by its **old** name, so people who learned “Access control” still find it.\n- Undo should stay at least five seconds.',
                }),
                member('cnm_settings-muse', MUSE, {
                  verdict: 'agree',
                  since: ago(20),
                  endedAt: ago(4),
                  url: `${T3}/settings-muse`,
                  answer: 'Agreed. Putting Danger zone last is the change people will thank you for.',
                }),
              ],
              history: [
                round('research', 1, [
                  [CLAUDE, { score: 6 }],
                  [GPT, { score: 5.5 }],
                  [MUSE, { score: 6 }],
                ]),
                round('agree', 1, [
                  [CLAUDE, { verdict: 'agree' }],
                  [GPT, { verdict: 'agree' }],
                  [MUSE, { verdict: 'agree' }],
                ]),
              ],
              plan: settingsPlan,
            }),
          },
        ],
        // The plan's tasks, on a checklist of their own under the council's card.
        [
          'agent',
          2,
          'Here are the plan’s tasks for T3 Code, each on a branch of its own.',
          { card: councilDelegationCard(made) },
        ],
      ],
    },
    {
      id: COUNCIL_ROOTS.final,
      at: 60 * 26,
      text: 'Ask the council to make the login page calmer, until they all give it 9.',
      replies: [
        ['agent', 60 * 26 - 1, 'I’ve asked Claude, ChatGPT and Muse to look at the login page.'],
        [
          'agent',
          60 * 22,
          'Done: all three give the new login page 9 or more. It has fewer words, taller buttons and the passkey first, and its three pull requests are merged.',
          {
            card: card({
              councilId: COUNCIL_IDS.final as CouncilCard['councilId'],
              what: 'improve',
              title: 'Make the login page calmer',
              stage: 'done',
              round: 2,
              target: 9,
              live: false,
              startedAt: ago(60 * 26),
              endedAt: ago(60 * 22),
              outcome: 'done',
              // The last check's answers, still readable on the final card.
              members: [
                member('cnm_login-final-1', CLAUDE, {
                  score: 9,
                  answer: 'Calmer: fewer words, and the passkey button is the first thing you see.',
                }),
                member('cnm_login-final-2', GPT, {
                  score: 9,
                  answer: 'The taller buttons fixed the misses. Nothing left that I’d block on.',
                }),
                member('cnm_login-final-3', MUSE, {
                  score: 9.5,
                  answer: 'Good. It reads in one glance now.',
                }),
              ],
              history: [
                round('research', 1, [
                  [CLAUDE, { score: 6 }],
                  [GPT, { score: 6.5 }],
                  [MUSE, { score: 5 }],
                ]),
                round('agree', 1, [
                  [CLAUDE, { verdict: 'agree' }],
                  [GPT, { verdict: 'agree' }],
                  [MUSE, { verdict: 'agree' }],
                ]),
                round('check', 1, [
                  [CLAUDE, { score: 8.5 }],
                  [GPT, { score: 8 }],
                  [MUSE, { score: 9 }],
                ]),
                round('check', 2, [
                  [CLAUDE, { score: 9 }],
                  [GPT, { score: 9 }],
                  [MUSE, { score: 9.5 }],
                ]),
              ],
              plan: loginPlan,
              shots: [
                {
                  view: 'Login · light',
                  attachmentId: COUNCIL_SHOT_ATTACHMENT as CouncilCard['shots'][number]['attachmentId'],
                  width: 1440,
                  height: 1800,
                  areas: 3,
                  notes: [
                    { n: 1, text: 'One short line under the logo instead of three.' },
                    { n: 2, text: 'The buttons are taller, so they are easier to tap.' },
                    { n: 3, text: 'Sign in with a passkey comes first.' },
                  ],
                },
              ],
            }),
            attachments: [
              {
                id: COUNCIL_SHOT_ATTACHMENT as Attachment['id'],
                name: 'login-light.png',
                contentType: 'image/png',
                size: 412_880,
                url: `/api/v1/burrows/${burrow}/attachments/${COUNCIL_SHOT_ATTACHMENT}`,
                kind: 'image',
                width: 1440,
                height: 1800,
              },
            ],
          },
        ],
      ],
    },
  ];
  return threads.map((t) => ({ ...t, replies: withIntro(t.replies) }));
}

/**
 * Stop on a council's live card, as the server answers it: the card as it is after, or a refusal (409 when it already
 * ended).
 */
export function councilPress(
  card: CouncilCard,
  nowIso: string,
): { card: CouncilCard } | { status: 409; message: string } {
  if (!card.live) return { status: 409, message: 'This council has ended.' };
  return {
    card: {
      ...card,
      stage: 'stopped',
      live: false,
      outcome: 'stopped',
      endedAt: nowIso,
      members: card.members.map((m) =>
        m.state === 'working' ? { ...m, state: 'stopped', endedAt: nowIso } : m,
      ),
    },
  };
}
