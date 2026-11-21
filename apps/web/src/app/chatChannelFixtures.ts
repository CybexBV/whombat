/**
 * Chat in fixture mode (Whombat chat-channel.md CHT-01…CHT-08; app chat-channel.md AP-2411): in the assistant shell with
 * `chatChannel` the one-Whombat layer's default chat is Mara's Chat — one threaded room, as the runtime with
 * `chat.channel` has it — so this layer, outside it, answers for that conversation itself:
 *
 * - the Chat as the mock draws it: yesterday's Zonneplan question with Neo's answer in its thread, this morning's
 *   backups note, “Why is pve-02 using so much memory?” about pve-02 with its thread and the ZFS cache approval
 *   (#902, with Tonight at 03:00), and the firmware question Neo is looking into;
 * - `chats.list` with the Chat (`room: 'chat'`) and no task chats (the fresh start archived them, CHT-04);
 * - `chats.threads` (newest activity first, by subject, paged by `before`), the threads and their messages;
 * - a top-level message (and `chats.start`, CHT-06) starts a thread that Neo answers in;
 * - “Clear chats” (`chats.clear`, Whombat chat-clear.md CHC-01): the room starts after it, every thread stays listed;
 * - settled threads (Whombat chat-settle.md; app chat-settle.md AP-6150…AP-6158): yesterday's NAS certificate (settled
 *   by Mara this morning) and Zonneplan (by her last night) fold into one line; Neo's login redirect fix settled when its
 *   pull request merged, a disk question by itself after quiet days, and ten older ones (14 settled, `settledCount`);
 *   Neo's question about tonight's updates waits for Mara's answer (`waiting`), and so does pve-02's thread while the
 *   ZFS cache approval is open. `chats.threads` lists by `state`, `chats.settle` settles or opens one again (refused
 *   while Neo works on it or it waits), `chats.settleFinished` settles the rest, and a reply opens a thread again;
 * - what answers in Chat (Whombat chat-runtime.md; app chat-runtime.md AP-2711): `chats.runtime` with Neo on Claude's
 *   Opus, both providers ready with the mock's models and usage, and each thread's choice (`chats.setThreadRuntime`,
 *   a top-level message's `runtime`); Zonneplan's thread switched to ChatGPT · High effort before Neo's last answer,
 *   and pve-02's thread on fast replies, whose first answer came at the normal speed because they were busy. `VITE_FIXTURE_CHAT_RUNTIME`:
 *   `codex-off` (ChatGPT isn't set up), `gateway` (Claude's turns go through the AI gateway), `off` (no button).
 *
 * With `tasks` (task-feedback.md AP-4304) the newest thread is Mara's ask for tonight's server work, answered with
 * server task cards as the runtime posts them (TF-10): thetitan's updates done (and Neo offering the restart they need,
 * TF-12), pve-01's backup done with warnings, pve-02's that didn't work, and the-falcon's updates still running. Its
 * times count back from when the world was made: the ask 62 minutes before, the-falcon's clock from 2 min 14 s before.
 *
 * With `council` four threads hold a council each (`councilFixtures.ts`), whose Go ahead and Stop change its card here.
 *
 * With `code` five threads hold software work (`codeFixtures.ts`): a council, a checklist and T3 Code's jobs, each with
 * its work line on its row and, for T3 Code's, the job's stage track and parts in the thread.
 *
 * The Feedback room is the feedback chat layer's (`feedbackChatFixtures.ts`), outside this one. Without `chatChannel`
 * nothing here answers: the task chats stay as they were.
 */
import { lastOfMessage, localAt } from '@whombat/client';
import {
  type Approval,
  CHAT_THREADS_LIMIT_DEFAULT,
  type ChatRuntime,
  type ChatRuntimeView,
  type ChatSubject,
  type ChatSummary,
  type ChatThread,
  CONNECT_HERE_FORM,
  type Conversation,
  type ConversationDetail,
  catalogEntry,
  connectHereAsk,
  connectHereCard,
  connectHereLocked,
  type DelegationAiChoice,
  GuideCard,
  GuideVaultAsk,
  type Handoff,
  type HandoffState,
  type JobResultAnswer,
  type Message,
  type MessageCard,
  type ProviderModel,
  type RanOn,
  type TaskCard,
  type ThreadSettle,
  type ThreadWork,
  taskCardLine,
} from '@whombat/core';
import { vaultAskCard, vaultAskLockedLabel } from '@whombat/core/vault';
import { burrow, deployApproval, mara } from '@whombat/fixtures';
import { CODE_CHECKS_THREAD, codeWorld } from './codeFixtures';
import { COUNCIL_SHOT_ID, councilShotBytes, councilThreads, pressCouncil } from './councilFixtures';
import { COUNCIL_PROVIDER_OPTIONS } from './councilSetupFixtures';
import {
  chooseDelegationAi,
  DELEGATION_SHOT_ID,
  type DelegationFixture,
  type DelegationPress,
  delegationShotBytes,
  delegationThreads,
  pressDelegation,
} from './delegationFixtures';
import { type FirstDayFixture, firstDayWelcome } from './firstDayFixtures';
import { ASSISTANT_NAME, DEFAULT_CHAT_ID, WHOMBAT_ID } from './oneFixtures';

const API = '/api/v1';
const B = `${API}/burrows/${burrow.slug}`;
const TZ = 'Europe/Amsterdam';

/** The ZFS cache approval in the pve-02 thread (the mock's card). */
export const ZFS_APPROVAL = 902;
export const PVE_THREAD = 'msg_chat-pve-memory';
export const FIRMWARE_THREAD = 'msg_chat-firmware';
/** With `newReplies`: Mara's link to a pull request, Neo's answer new. */
export const LINK_THREAD = 'msg_chat-shop-pr';
/** The thread Neo handed to T3 Code (t3code-handoff.md AP-6616). */
export const T3_THREAD = 'msg_chat-t3-settle';
/** Tonight's server work, with its task cards (option `tasks`, AP-4304). */
export const TASKS_THREAD = 'msg_chat-tasks';
/** Setting things up from the chat (option `connect`, Whombat connect-in-chat.md): the connect and Vault cards. */
export const CONNECT_THREAD = 'msg_chat-connect';
export const VAULT_SAVED_THREAD = 'msg_chat-grafana';
/** An API and an MCP server connected by talking (option `connect`, Whombat connect-by-talking.md). */
export const BY_TALKING_THREAD = 'msg_chat-weather';
export const BY_TALKING_MCP_THREAD = 'msg_chat-linear';
/**
 * Asking for every sign-in (Whombat vault-simplify.md VLT-40…VLT-44): prod-1 refused Neo's key, so its card offers the
 * three ways; github.com's login was saved with its authenticator key, then the site sent a code.
 */
export const SERVER_SIGNIN_THREAD = 'msg_chat-prod1';
export const CODE_THREAD = 'msg_chat-github-code';
/** Settled threads (chat-settle.md AP-6152…): yesterday's two, folded into one line. */
export const CERT_THREAD = 'msg_chat-cert';
export const ZONNEPLAN_THREAD = 'msg_chat-zonneplan';
/** Settled when its pull request merged, and by itself after quiet days (AP-6153). */
export const LOGIN_THREAD = 'msg_chat-login';
export const DISK_THREAD = 'msg_chat-disk';
/** Neo's question about tonight's updates: it waits for Mara's answer (`ChatThread.waiting`). */
export const UPDATES_THREAD = 'msg_chat-updates';
/** How many threads of the Chat are settled when the world is made. */
export const SETTLED_THREADS = 14;

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

/** Claude Code's models as the mock lists them; Opus has fast replies, off unless asked (CR-06). */
export const CHAT_CLAUDE_MODELS: ProviderModel[] = [
  {
    id: 'opus',
    label: 'Opus',
    description: 'Everyday, complex tasks',
    efforts: [...CLAUDE_EFFORTS],
    isDefault: true,
    fast: 'off',
  },
  {
    id: 'fable',
    label: 'Fable',
    description: 'Hardest, longest tasks',
    efforts: [...CLAUDE_EFFORTS],
    isDefault: false,
  },
  {
    id: 'sonnet',
    label: 'Sonnet',
    description: 'Routine tasks',
    efforts: ['low', 'medium', 'high'],
    isDefault: false,
  },
  { id: 'haiku', label: 'Haiku', description: 'Quick answers', efforts: [], isDefault: false },
];

const codexModel = (
  id: string,
  label: string,
  description: string,
  fast: 'on' | 'off' = 'off',
): ProviderModel => ({
  id,
  label,
  description,
  efforts: [...CODEX_EFFORTS],
  isDefault: id === 'gpt-6.1-sol',
  fast,
});

/** Codex's models as the mock lists them: seven, every one with the priority tier, Sol's on by default (CR-06). */
export const CHAT_CODEX_MODELS: ProviderModel[] = [
  codexModel('gpt-6.1-sol', 'GPT-6.1 Sol', 'Everyday work', 'on'),
  codexModel('gpt-6-astra', 'GPT-6 Astra', 'Most demanding work'),
  codexModel('gpt-6-luna', 'GPT-6 Luna', 'Quick, light tasks', 'on'),
  codexModel('gpt-6', 'GPT-6', 'Earlier everyday model'),
  codexModel('gpt-6-mini', 'GPT-6 Mini', 'Small and quick'),
  codexModel('gpt-5.5', 'GPT-5.5', 'Fast, dependable coding model'),
  codexModel('gpt-5.5-mini', 'GPT-5.5 Mini', 'Smallest and quickest'),
];

const ON_OPUS: RanOn = { provider: 'claude', model: null, modelLabel: 'Opus', effort: null, fast: false };
const ON_SOL_HIGH: RanOn = {
  provider: 'codex',
  model: 'gpt-6.1-sol',
  modelLabel: 'GPT-6.1 Sol',
  effort: 'high',
  fast: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function message(over: Partial<Message> & Pick<Message, 'id' | 'authorId' | 'createdAt'>): Message {
  return {
    conversationId: DEFAULT_CHAT_ID as Message['conversationId'],
    editedAt: null,
    text: '',
    mentions: [],
    card: null,
    suggestions: [],
    more: null,
    attachments: [],
    reactions: [],
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
    ...over,
  };
}

export interface ChatChannelFixtures {
  handle(req: Request): Promise<Response | null>;
  /**
   * *Talk to {assistant} about it* (Whombat inbox.md IBX-07): a thread Neo opens with the Inbox item's words, about its
   * thing; the answer `needsYou.discuss` gives.
   */
  discuss(text: string, subject: ChatSubject | null): Promise<Response>;
}

export function createChatChannelFixtures(
  options: {
    now?: () => number;
    tasks?: boolean;
    connect?: boolean;
    /** A Whombat just claimed (Whombat first-day.md): the room holds only the welcome. */
    firstDay?: FirstDayFixture;
    /**
     * Threads with something Mara hasn't read (Whombat thread-unread.md, chat-inbox.md): pve-02's thread has Neo's last
     * two answers new, last night's backups and Neo's answer on Mara's pull request link one each. Off, nothing is new,
     * as the mock draws it.
     */
    newReplies?: boolean;
    /**
     * Work Neo handed to T3 Code (Whombat t3code.md T3-24; app t3code-handoff.md AP-6616): Mara's Settle bug, handed
     * over six minutes ago, in this state. Off, nothing was handed over, as the mock draws it.
     */
    handoff?: HandoffState | null;
    /**
     * Councils (Whombat council.md CNL-40…CNL-44, CNL-60, `councilFixtures.ts`): four threads with a council each, live at
     * research, building with its checklist waiting under it, building with its tasks at work, and the final card with
     * its picture. Off, none.
     */
    council?: boolean;
    /**
     * Delegations (Whombat delegate.md, `delegationFixtures.ts`): threads in which the assistant offers coding tasks to
     * hand to T3 Code, the checklist, at work or ended (`all`: the three). Off, none.
     */
    delegation?: DelegationFixture | null;
    /** Software work (`codeFixtures.ts`): five threads with a council, a checklist or a T3 Code job. Off, none. */
    code?: boolean;
  } = {},
): ChatChannelFixtures {
  const clock = options.now ?? (() => Date.now());
  const made = clock();
  const at = (day: number, hhmm: string) => localAt(made, TZ, hhmm, day);
  const person = mara.id as Message['authorId'];
  const bot = WHOMBAT_ID as Message['authorId'];
  let seq = 0;
  const newId = () => `msg_chat-${++seq}`;
  const pve: ChatSubject = { kind: 'server', id: 'pve-02', name: 'pve-02' };

  const zfs: Approval = {
    ...deployApproval(),
    id: 'apr_zfs-cache' as Approval['id'],
    number: ZFS_APPROVAL,
    requesterId: WHOMBAT_ID as Approval['requesterId'],
    keyId: 'connections.write',
    action: {
      type: 'connection_call',
      params: {
        connectionId: 'con_servers',
        handle: 'servers',
        tool: 'server_command',
        toolHash: 'b'.repeat(64),
        scope: 'shared',
        server: { id: 'pve-02', name: 'pve-02' },
        // The server's own words for the call (CT-347): the card's title, as the mock's.
        words: 'limit the ZFS cache on pve-02 to 16 GB',
      },
    },
    title: 'Limit the ZFS cache on pve-02 to 16 GB',
    question: 'Limit the ZFS cache on pve-02 to 16 GB?',
    target: 'servers · server_command',
    whatHappens: ['pve-02 restarts once to apply it'],
    explainer: 'Restarting a server always asks a person.',
    summary: `${ASSISTANT_NAME} limits the ZFS cache on pve-02 to 16 GB. pve-02 restarts once to apply it.`,
    conditions: [
      {
        id: 'person',
        kind: 'person_approves',
        label: 'A person says yes',
        met: false,
        approverIds: [mara.id],
      },
    ],
    createdAt: at(0, '09:44'),
  } as Approval;
  let approval = zfs;

  /** Ten older questions, settled by Mara or by themselves, a day apart (Settled's later pages). */
  const older = [
    'Can you rotate the Wi-Fi password for guests?',
    'Why did the NAS wake up at 04:00?',
    'Move the Plex library to the new disk',
    'Is the UPS battery still good?',
    'Turn off the porch light schedule',
    'What uses the most bandwidth at night?',
    'Update Home Assistant to the new release',
    'Did the printer get its firmware?',
    'Clean up old snapshots on pve-01',
    'Why is the garage sensor offline?',
  ].flatMap((text, i): Message[] => {
    const id = `msg_chat-old-${i}` as Message['id'];
    return [
      message({ id, authorId: person, createdAt: at(-8 - i * 2, '10:05'), text }),
      message({
        id: `msg_chat-old-${i}-1` as Message['id'],
        authorId: bot,
        createdAt: at(-8 - i * 2, '10:07'),
        threadRootId: id,
        text: 'Done.',
      }),
    ];
  });

  /** Top-level messages and replies, oldest first. */
  let messages: Message[] = [
    ...older,
    message({
      id: DISK_THREAD as Message['id'],
      authorId: person,
      createdAt: at(-6, '10:05'),
      text: 'Which guests use the most disk on pve-01?',
    }),
    message({
      id: 'msg_chat-disk-1' as Message['id'],
      authorId: bot,
      createdAt: at(-6, '10:06'),
      threadRootId: DISK_THREAD as Message['id'],
      text: 'web-03 uses 410 GB, most of it old logs. The rest are under 60 GB each.',
    }),
    message({
      id: LOGIN_THREAD as Message['id'],
      authorId: bot,
      createdAt: at(-3, '16:10'),
      text: 'Fix the login redirect on the website',
    }),
    message({
      id: 'msg_chat-login-1' as Message['id'],
      authorId: bot,
      createdAt: at(-3, '16:40'),
      threadRootId: LOGIN_THREAD as Message['id'],
      text: 'The fix is ready for review: signing in now brings you back to the page you were on.',
    }),
    message({
      id: CERT_THREAD as Message['id'],
      authorId: person,
      createdAt: at(-1, '14:20'),
      text: 'Renew the certificate on the NAS',
    }),
    message({
      id: 'msg_chat-cert-1' as Message['id'],
      authorId: bot,
      createdAt: at(-1, '14:23'),
      threadRootId: CERT_THREAD as Message['id'],
      text: 'Done. The new one is good until next October.',
    }),
    message({
      id: ZONNEPLAN_THREAD as Message['id'],
      authorId: person,
      createdAt: at(-1, '21:02'),
      text: 'Is the Zonneplan integration in Home Assistant still doing anything?',
    }),
    message({
      id: 'msg_chat-zonneplan-1' as Message['id'],
      authorId: bot,
      createdAt: at(-1, '21:04'),
      threadRootId: 'msg_chat-zonneplan' as Message['id'],
      text: 'It is. It read tomorrow’s prices at 21:00 and moved the dishwasher to 03:00, when power is cheapest.',
      ranOn: ON_OPUS,
    }),
    message({
      id: 'msg_chat-zonneplan-2' as Message['id'],
      authorId: person,
      createdAt: at(-1, '21:07'),
      threadRootId: 'msg_chat-zonneplan' as Message['id'],
      text: 'Good, leave it on.',
    }),
    message({
      id: 'msg_chat-zonneplan-3' as Message['id'],
      authorId: bot,
      createdAt: at(-1, '21:09'),
      threadRootId: 'msg_chat-zonneplan' as Message['id'],
      text: 'Will do.',
      ranOn: ON_SOL_HIGH,
    }),
    message({
      id: UPDATES_THREAD as Message['id'],
      authorId: bot,
      createdAt: at(-1, '22:30'),
      text: 'Install the updates on thetitan and the-falcon tonight? Both restart once after.',
    }),
    message({
      id: 'msg_chat-backups' as Message['id'],
      authorId: bot,
      createdAt: at(0, '07:00'),
      text: 'Last night’s backups ran for all 12 guests. pve-02 is using more memory than usual, I’ll keep an eye on it.',
    }),
    message({
      id: PVE_THREAD as Message['id'],
      authorId: person,
      createdAt: at(0, '09:41'),
      text: 'Why is pve-02 using so much memory?',
      subject: pve,
    }),
    message({
      id: 'msg_chat-pve-1' as Message['id'],
      authorId: bot,
      createdAt: at(0, '09:42'),
      threadRootId: PVE_THREAD as Message['id'],
      text: 'It’s at 91%, but 38 GB of that is the ZFS cache, which gives memory back when a guest needs it. Nothing is short right now.',
      ranOn: { ...ON_OPUS, fastSkipped: 'busy' },
    }),
    message({
      id: 'msg_chat-pve-2' as Message['id'],
      authorId: person,
      createdAt: at(0, '09:44'),
      threadRootId: PVE_THREAD as Message['id'],
      text: 'Can you cap the cache at 16 GB?',
    }),
    message({
      id: 'msg_chat-pve-3' as Message['id'],
      authorId: bot,
      createdAt: at(0, '09:44'),
      threadRootId: PVE_THREAD as Message['id'],
      text: 'Sure. It takes effect after a restart, so I’d do it tonight.',
      card: { kind: 'approval', approval: zfs } as MessageCard,
      ranOn: { ...ON_OPUS, fast: true },
    }),
    message({
      id: FIRMWARE_THREAD as Message['id'],
      authorId: person,
      createdAt: at(0, '10:12'),
      text: 'Is there new firmware for the access points?',
    }),
  ];
  // An inbox with news: Mara's link to a pull request, which Neo answered while she was away.
  if (options.newReplies)
    messages = [
      ...messages,
      message({
        id: LINK_THREAD as Message['id'],
        authorId: person,
        createdAt: at(0, '09:31'),
        text: 'Can you look at this? https://github.com/acme/shop/pull/412',
      }),
      message({
        id: 'msg_chat-shop-pr-1' as Message['id'],
        authorId: bot,
        createdAt: at(0, '09:55'),
        threadRootId: LINK_THREAD as Message['id'],
        text: 'Looks good. Two small things before you merge: the toggle forgets its setting after a reload, and the label reads “Darkmode”. I left both as comments on the pull request.',
      }),
    ];
  if (options.handoff) messages = [...messages, ...handoffThread()];
  if (options.tasks) messages = [...messages, ...taskThread()];
  if (options.council) messages = [...messages, ...councilThreads({ made, person, bot, message })];
  if (options.delegation)
    messages = [...messages, ...delegationThreads({ made, person, bot, message, which: options.delegation })];
  // Software work: its threads, their councils' and checklists' progress, and T3 Code's hand-overs.
  const code = options.code
    ? codeWorld({ made, person, bot, message, conversationId: DEFAULT_CHAT_ID })
    : { messages: [], work: new Map<string, ThreadWork>(), handoffs: [], settled: [], repos: new Map() };
  messages = [...messages, ...code.messages];

  /** Mara's bug that Neo handed to T3 Code six minutes ago (AP-6616). */
  function handoffThread(): Message[] {
    const ago = (minutes: number) => new Date(made - minutes * 60_000).toISOString();
    return [
      message({
        id: T3_THREAD as Message['id'],
        authorId: person,
        createdAt: ago(7),
        text: 'Settle on the phone does nothing in the Feedback room. Can you fix it?',
      }),
      message({
        id: 'msg_chat-t3-settle-1' as Message['id'],
        authorId: bot,
        createdAt: ago(6.5),
        threadRootId: T3_THREAD as Message['id'],
        text: 'I’ve asked T3 Code to find out why and fix it. I’ll tell you here when it’s done.',
      }),
    ];
  }

  /** What Neo handed over, as `conversations.handoffs` lists it, in the state asked for. */
  function handoffs(): Handoff[] {
    return [...ownHandoffs(), ...code.handoffs];
  }

  function ownHandoffs(): Handoff[] {
    const state = options.handoff;
    if (!state) return [];
    const ago = (minutes: number) => new Date(made - minutes * 60_000 - 12_000).toISOString();
    const ended = state === 'ended' || state === 'checks';
    return [
      {
        id: 'mcp:thread-settle',
        to: 't3code',
        conversationId: conversation.id,
        rootId: T3_THREAD as Handoff['rootId'],
        agentId: bot as Handoff['agentId'],
        title: `${ASSISTANT_NAME} - Settle does nothing in the Feedback room`,
        state,
        since: ago(6),
        endedAt: ended ? new Date(made - 30_000).toISOString() : null,
        outcome: state === 'ended' ? 'completed' : null,
        steps: [
          { text: 'Getting the workspace ready', detail: null, done: true },
          { text: 'Reading the code', detail: 'rg settle apps/mobile/src', done: true },
          { text: 'Changing useSettle.tsx', detail: null, done: true },
          {
            text: 'Running the tests',
            detail: 'pnpm --filter @whombat/mobile test',
            done: state !== 'working' && state !== 'finishing',
          },
        ],
        asks:
          state === 'asked'
            ? 'Should Settle also work for threads that wait for you?'
            : state === 'needs_ok'
              ? 'git push origin fix-settle'
              : null,
        pullRequests: state === 'checks' ? ['https://github.com/burrow-hq/whombat/pull/342'] : [],
        program: 'Codex · gpt-5.5',
        url: 'http://thetitan:3773/env-1/mcp%3Athread-settle',
      },
    ];
  }
  if (options.connect) messages = [...messages, ...connectThreads()];

  /**
   * Setting things up from the chat (connect-in-chat.md): Mara asks to connect Home Assistant and UniFi; Neo's card
   * opens the connect form filled in from the scan (Manage, by risk), and its Vault card asks for the UniFi password
   * with a write-only field. In an older thread the Grafana password was saved through such a card.
   */
  function connectThreads(): Message[] {
    const ago = (minutes: number) => new Date(made - minutes * 60_000).toISOString();
    const guide = (card: Record<string, unknown>) =>
      GuideCard.parse({ kind: 'guide', state: 'open', step: null, ...card }) as MessageCard;
    const root = CONNECT_THREAD as Message['id'];
    const saved = VAULT_SAVED_THREAD as Message['id'];
    return [
      message({
        id: saved,
        authorId: person,
        createdAt: ago(180),
        text: 'Can you keep an eye on my Grafana dashboards?',
      }),
      message({
        id: 'msg_chat-grafana-1' as Message['id'],
        authorId: bot,
        createdAt: ago(179),
        threadRootId: saved,
        card: guide({
          guide: 'secret',
          node: 'new',
          title: `${ASSISTANT_NAME} needs the Grafana password`,
          body: 'To read your dashboards.\n\nIt’s saved in your Vault as “Grafana” for http://192.168.1.40:3000. It goes straight there and never shows in the chat.',
          blocks: [
            {
              type: 'form',
              id: 'save',
              fields: [{ id: 'secret', label: 'Password', kind: 'secret' }],
              submitLabel: 'Save to Vault',
            },
            { type: 'actions', actions: [{ id: 'no', label: 'No', style: 'quiet' }] },
          ],
          state: 'done',
          answer: {
            actionId: 'save',
            label: 'Saved to your Vault · Grafana',
            at: ago(176),
            vaultEntryId: 'vlt_fixture_grafana',
          },
          vaultAsk: { kind: 'basic', name: 'Grafana', url: 'http://192.168.1.40:3000', username: 'admin' },
        }),
      }),
      message({
        id: 'msg_chat-grafana-2' as Message['id'],
        authorId: bot,
        createdAt: ago(175),
        threadRootId: saved,
        text: 'Got it. Your dashboards all load, and I’ll tell you when one stops.',
        ranOn: ON_OPUS,
      }),
      message({
        id: root,
        authorId: person,
        createdAt: ago(14),
        text: 'Connect my Home Assistant, and check why the UniFi Wi-Fi keeps dropping',
      }),
      message({
        id: 'msg_chat-connect-1' as Message['id'],
        authorId: bot,
        createdAt: ago(13),
        threadRootId: root,
        card: guide({
          guide: 'add_connection',
          node: 'connect',
          title: 'Connect Home Assistant at 192.168.1.20',
          body: 'Whombat found it on your network at 192.168.1.20.\n\nSign in to it once: Whombat makes its own key and forgets the password.\n\nManage: Neo can also switch devices, run scripts and change automations. Locks, alarms, gates and doors still ask you first.',
          blocks: [
            {
              type: 'actions',
              actions: [
                {
                  id: 'connect',
                  label: 'Sign in…',
                  style: 'primary',
                  href: '/settings?tab=connections&connection=homeassistant&url=http%3A%2F%2F192.168.1.20%3A8123&access=manage',
                },
              ],
            },
          ],
          state: 'done',
        }),
      }),
      message({
        id: 'msg_chat-connect-2' as Message['id'],
        authorId: bot,
        createdAt: ago(12),
        threadRootId: root,
        card: vaultAskCard(
          ASSISTANT_NAME,
          GuideVaultAsk.parse({ kind: 'login', name: 'UniFi', url: 'https://192.168.1.1' }),
          'To read the Wi-Fi’s logs on your UniFi console.',
        ) as MessageCard,
      }),
      ...signInThreads(),
      ...byTalkingThreads(),
    ];
  }

  /**
   * Connecting by talking (connect-by-talking.md): Neo set the weather API up from its documentation and its card waits
   * for the key; Linear's open MCP server was connected with one tap.
   */
  function byTalkingThreads(): Message[] {
    const ago = (minutes: number) => new Date(made - minutes * 60_000).toISOString();
    const entryOf = (id: string) => {
      const e = catalogEntry(id);
      if (!e) throw new Error(id);
      return e;
    };
    const askOf = (id: string, choice: Parameters<typeof connectHereAsk>[1]) => {
      const made = connectHereAsk(entryOf(id), choice);
      if ('problem' in made) throw new Error(made.problem);
      return made.ask;
    };
    const weather = askOf('custom_api', {
      label: 'OpenWeatherMap',
      url: 'https://api.openweathermap.org/data/2.5',
      signIn: 'query',
      keyName: 'appid',
      access: 'read',
    });
    const linear = askOf('custom_mcp', {
      label: 'Linear',
      url: 'https://mcp.linear.app/mcp',
      signIn: 'none',
      access: 'read',
    });
    const api = BY_TALKING_THREAD as Message['id'];
    const mcp = BY_TALKING_MCP_THREAD as Message['id'];
    return [
      message({
        id: api,
        authorId: person,
        createdAt: ago(11),
        text: 'Connect OpenWeatherMap, I have a key',
      }),
      message({
        id: 'msg_chat-weather-1' as Message['id'],
        authorId: bot,
        createdAt: ago(10),
        threadRootId: api,
        card: connectHereCard(entryOf('custom_api'), weather, ASSISTANT_NAME) as MessageCard,
      }),
      message({ id: mcp, authorId: person, createdAt: ago(10), text: 'Connect Linear’s MCP server' }),
      message({
        id: 'msg_chat-linear-1' as Message['id'],
        authorId: bot,
        createdAt: ago(9),
        threadRootId: mcp,
        card: {
          ...connectHereCard(entryOf('custom_mcp'), linear, ASSISTANT_NAME),
          state: 'done',
          answer: {
            actionId: CONNECT_HERE_FORM,
            optionIds: null,
            label: connectHereLocked('connected', 'Linear'),
            at: ago(9),
            connectionId: 'con_fixture_linear',
          },
        } as MessageCard,
      }),
    ];
  }

  /**
   * The sign-in cards (vault-simplify.md VLT-42, VLT-44, VLT-46): Mara asks to put the new site on prod-1, whose server
   * refused Neo's key — its card is open with the three ways. Opening a pull request on github.com needed the login:
   * saved with its authenticator key, then GitHub sent a code to Mara's phone, which its card asks for.
   */
  function signInThreads(): Message[] {
    const ago = (minutes: number) => new Date(made - minutes * 60_000).toISOString();
    const server = SERVER_SIGNIN_THREAD as Message['id'];
    const code = CODE_THREAD as Message['id'];
    const githubAsk = GuideVaultAsk.parse({
      kind: 'login',
      name: 'github.com',
      url: 'https://github.com/login',
    });
    const githubLogin = vaultAskCard(ASSISTANT_NAME, githubAsk, 'To open the pull request for the new site.');
    return [
      message({
        id: server,
        authorId: person,
        createdAt: ago(9),
        text: 'Put the new website on prod-1',
      }),
      message({
        id: 'msg_chat-prod1-1' as Message['id'],
        authorId: bot,
        createdAt: ago(8),
        threadRootId: server,
        card: vaultAskCard(
          ASSISTANT_NAME,
          GuideVaultAsk.parse({
            kind: 'server',
            name: 'prod-1',
            username: 'deploy',
            server: { host: '192.168.1.30', port: 22, reason: 'key_refused' },
          }),
          'To copy the new website onto it.',
        ) as MessageCard,
      }),
      message({
        id: code,
        authorId: person,
        createdAt: ago(6),
        text: 'Open the pull request for the new site on GitHub',
      }),
      message({
        id: 'msg_chat-github-code-1' as Message['id'],
        authorId: bot,
        createdAt: ago(5),
        threadRootId: code,
        card: {
          ...githubLogin,
          state: 'done',
          answer: {
            actionId: 'save',
            optionIds: null,
            label: vaultAskLockedLabel('saved', { name: 'github.com' }),
            at: ago(4),
            vaultEntryId: 'vlt_fixture_github',
            vaultOutcome: 'saved',
          },
        } as MessageCard,
      }),
      message({
        id: 'msg_chat-github-code-2' as Message['id'],
        authorId: bot,
        createdAt: ago(3),
        threadRootId: code,
        card: vaultAskCard(
          ASSISTANT_NAME,
          GuideVaultAsk.parse({ kind: 'code', name: 'github.com', hint: 'It came by text to your phone.' }),
          null,
        ) as MessageCard,
      }),
    ];
  }

  /**
   * Tonight's server work (AP-4304): Mara's ask, Neo's answer, then a task card per job as the runtime posts them — its
   * text the card's line for an app without the card (CT-884), which folds into the card here.
   */
  function taskThread(): Message[] {
    const root = TASKS_THREAD as Message['id'];
    // Minutes before the world was made: 10:20 … 10:45 at the visual suite's 11:22, in order whatever the hour.
    const ago = (minutes: number) => new Date(made - minutes * 60_000).toISOString();
    const card = (
      id: string,
      serverId: string,
      title: string,
      state: TaskCard['state'],
      startedAt: string,
      ended: { at: string; result: string } | null,
    ): Message => {
      const task: TaskCard = {
        kind: 'task',
        followedTaskId: `ftk_${id}` as TaskCard['followedTaskId'],
        serverId,
        server: serverId,
        title,
        state,
        startedAt,
        endedAt: ended?.at ?? null,
        result: ended?.result ?? null,
      };
      return message({
        id: `msg_chat-task-${id}` as Message['id'],
        authorId: bot,
        createdAt: startedAt,
        threadRootId: root,
        text: taskCardLine({ ...task, state: 'running', endedAt: null, result: null }, startedAt),
        card: task as MessageCard,
      });
    };
    return [
      message({
        id: root,
        authorId: person,
        createdAt: ago(62),
        text: 'Can you install the updates on thetitan and the-falcon, and back up the guests on pve-01 and pve-02?',
      }),
      message({
        id: 'msg_chat-tasks-1' as Message['id'],
        authorId: bot,
        createdAt: ago(61),
        threadRootId: root,
        text: 'On it. I’ll do them one at a time and tell you here how each one went.',
        ranOn: ON_OPUS,
      }),
      card('thetitan0upd', 'thetitan', 'Installing 23 updates on thetitan', 'ok', ago(61), {
        at: ago(57),
        result: 'thetitan is up to date: 23 updates installed. It needs a restart to finish.',
      }),
      message({
        id: 'msg_chat-tasks-2' as Message['id'],
        authorId: bot,
        createdAt: ago(57),
        threadRootId: root,
        text: 'thetitan has its 23 updates. It needs a restart to finish them. Shall I restart it tonight at 03:00?',
        ranOn: ON_OPUS,
      }),
      card('pve01backup0', 'pve-01', 'Backing up 12 guests on pve-01', 'warning', ago(57), {
        at: ago(39),
        result:
          '11 of 12 guests on pve-01 are backed up with warnings. web-03 was skipped because it was busy.',
      }),
      card('pve02backup0', 'pve-02', 'Backing up web on pve-02', 'error', ago(39), {
        at: ago(37),
        result:
          'Backing up web on pve-02 didn’t work: the storage is full. Free some space on local-zfs and try again.',
      }),
      card(
        'falcon0upd00',
        'the-falcon',
        'Installing 4 updates on the-falcon',
        'running',
        ago(134 / 60),
        null,
      ),
    ];
  }

  /** What answers in Chat (AP-2711): Neo's own on Opus, each thread's choice (none: Neo's). */
  const runtimeMode = import.meta.env.VITE_FIXTURE_CHAT_RUNTIME ?? '';
  let assistantRuntime: ChatRuntime = { provider: 'claude' };
  const threadRuntimes = new Map<string, ChatRuntime>([
    ['msg_chat-zonneplan', { provider: 'codex', effort: 'high' }],
    [PVE_THREAD, { provider: 'claude', fast: true }],
  ]);
  function runtimeView(thread: string | null): ChatRuntimeView {
    return {
      assistantId: WHOMBAT_ID as ChatRuntimeView['assistantId'],
      assistantName: ASSISTANT_NAME,
      default: assistantRuntime,
      ...(thread ? { thread: threadRuntimes.get(thread) ?? null } : {}),
      providers: [
        {
          provider: 'claude',
          ready: true,
          models: CHAT_CLAUDE_MODELS,
          fastBlocked: runtimeMode === 'gateway' ? 'gateway' : null,
          usage: runtimeMode === 'gateway' ? null : { usedPct: 38, resetsAt: null },
        },
        {
          provider: 'codex',
          ready: runtimeMode !== 'codex-off',
          models: CHAT_CODEX_MODELS,
          fastBlocked: null,
          usage: runtimeMode === 'codex-off' ? null : { usedPct: 12, resetsAt: null },
        },
      ],
    };
  }
  /** Stored as the server does (CR-02): null when it is Neo's own. */
  function storeRuntime(rootId: string, runtime: ChatRuntime | null | undefined): ChatRuntime | null {
    const same =
      !runtime ||
      (runtime.provider === assistantRuntime.provider &&
        (runtime.model ?? null) === (assistantRuntime.model ?? null) &&
        (runtime.effort ?? null) === (assistantRuntime.effort ?? null) &&
        (runtime.fast ?? null) === (assistantRuntime.fast ?? null));
    if (same) threadRuntimes.delete(rootId);
    else threadRuntimes.set(rootId, runtime);
    return same ? null : runtime;
  }

  /** Threads the assistant has a turn on (`ChatThread.working`). */
  const working = new Set<string>([FIRMWARE_THREAD]);
  /** Threads with a question for Mara (`ChatThread.waiting`); pve-02's waits too while its approval is open. */
  const asking = new Set<string>([UPDATES_THREAD]);
  const waiting = (rootId: string) =>
    asking.has(rootId) || (rootId === PVE_THREAD && approval.state === 'pending');
  /** Settled threads (chat-settle.md CHS-01): by Mara, by themselves after quiet days, or when a pull request merged. */
  const settled = new Map<string, ThreadSettle>([
    ...code.settled,
    [CERT_THREAD, { at: at(0, '09:20'), how: 'person' }],
    [ZONNEPLAN_THREAD, { at: at(-1, '21:15'), how: 'person' }],
    [LOGIN_THREAD, { at: at(-2, '10:30'), how: 'merged' }],
    [DISK_THREAD, { at: at(-6, '10:06'), how: 'quiet' }],
    ...Array.from({ length: 10 }, (_, i): [string, ThreadSettle] => [
      `msg_chat-old-${i}`,
      i % 3 === 1
        ? { at: at(-8 - i * 2, '10:07'), how: 'quiet' }
        : { at: at(-8 - i * 2, '11:00'), how: 'person' },
    ]),
  ]);
  let unread = 0;
  /** Each thread's new messages for Mara (`chats.unread`); a read thread leaves it. */
  const newIn = new Map<string, number>([
    ...(options.newReplies
      ? ([
          [PVE_THREAD, 2],
          ['msg_chat-backups', 1],
          [LINK_THREAD, 1],
        ] as const)
      : []),
    // Software work: the invoice job has the assistant's news about its pull request.
    ...(options.code ? ([[CODE_CHECKS_THREAD, 1]] as const) : []),
  ]);
  /** Chat's badge: threads with something new while there are any, else the room's own count. */
  const badge = () => {
    const threads = [...newIn.keys()].filter((id) => !settled.has(id)).length;
    return threads || unread;
  };

  const conversation: Conversation = {
    id: DEFAULT_CHAT_ID as Conversation['id'],
    burrowId: burrow.id,
    kind: 'dm',
    slug: DEFAULT_CHAT_ID,
    title: 'Chat',
    topic: '',
    actions: [],
    prNumber: null,
    repoId: null,
    createdAt: at(-6, '09:00'),
    lastMessageAt: at(0, '10:12'),
    chat: null,
  };

  if (options.firstDay) {
    messages = firstDayWelcome(options.firstDay, { person: 'Mara', assistant: ASSISTANT_NAME }).map((m, i) =>
      message({
        id: `msg_first-day-${i + 1}` as Message['id'],
        authorId: bot,
        createdAt: at(0, `09:0${i}`),
        text: m.text,
        card: m.card,
      }),
    );
    settled.clear();
  }

  /** Messages with their threads' counts and the approval as it is now. */
  function current(): Message[] {
    const fresh = messages.map((m) =>
      m.card?.kind === 'approval' && m.card.approval.number === ZFS_APPROVAL
        ? { ...m, card: { kind: 'approval', approval } as MessageCard }
        : m,
    );
    return fresh.map((m) => {
      if (m.threadRootId) return m;
      const replies = fresh.filter((r) => r.threadRootId === m.id);
      const settle = settled.get(m.id);
      const root = settle ? { ...m, settled: settle } : m;
      return replies.length
        ? {
            ...root,
            replyCount: replies.length,
            lastReplyAt: replies.at(-1)?.createdAt ?? null,
            threadParticipantIds: [...new Set(replies.map((r) => r.authorId).reverse())].slice(0, 3),
          }
        : root;
    });
  }

  const top = () => current().filter((m) => !m.threadRootId);
  /** When Mara cleared Chat (`chats.clear`, Whombat chat-clear.md CHC-01): the room starts after it, Threads doesn't. */
  let clearedAt: number | null = null;
  const shown = () => top().filter((m) => clearedAt === null || Date.parse(m.createdAt) > clearedAt);

  /**
   * Whether work handed over from a thread goes on (DLG-31): T3 Code on Neo's hand-over, a council that is live, or a
   * delegation at work. Such a thread doesn't settle.
   */
  function handedOver(rootId: string): boolean {
    if (rootId === T3_THREAD && options.handoff && options.handoff !== 'ended') return true;
    if (code.handoffs.some((h) => h.rootId === rootId && h.state !== 'ended')) return true;
    return messages.some(
      (m) =>
        (m.id === rootId || m.threadRootId === rootId) &&
        ((m.card?.kind === 'council' && m.card.live) ||
          (m.card?.kind === 'delegation' && m.card.live && m.card.stage === 'working')),
    );
  }

  /** The thread's newest reply with words or files (`ChatThread.last`), as the server sends it. */
  function lastOf(rootId: string) {
    const replies = messages.filter((r) => r.threadRootId === rootId);
    for (let i = replies.length - 1; i >= 0; i--) {
      const last = lastOfMessage(replies[i] as Message);
      if (last) return last;
    }
    return undefined;
  }

  function threadOf(m: Message): ChatThread {
    const last = lastOf(m.id);
    return {
      ...(last ? { last } : {}),
      conversationId: conversation.id,
      room: 'chat' as const,
      rootId: m.id,
      authorId: m.authorId,
      text: m.text.slice(0, 200),
      subject: m.subject ?? null,
      createdAt: m.createdAt,
      replyCount: m.replyCount,
      lastAt: m.lastReplyAt ?? m.createdAt,
      working: working.has(m.id),
      runtime: threadRuntimes.get(m.id) ?? null,
      settled: settled.get(m.id) ?? null,
      waiting: waiting(m.id),
      handedOver: handedOver(m.id),
      work: code.work.get(m.id) ?? workOf(m.id),
      ...(code.repos.has(m.id) ? { repo: code.repos.get(m.id) } : {}),
    };
  }

  /**
   * A live council's or checklist's progress, as the server reads it: a council at work first (a council's own list
   * says so on its line), then the thread's newest list at work or offered.
   */
  function workOf(rootId: string): ThreadWork | null {
    const all = messages
      .filter((m) => m.id === rootId || m.threadRootId === rootId)
      .map((m) => m.card)
      .reverse();
    const cards = [
      ...all.filter((c) => c?.kind === 'council' && c.live),
      ...all.filter((c) => c?.kind !== 'council'),
    ];
    for (const card of cards) {
      if (card?.kind === 'council' && card.live)
        return {
          kind: 'council',
          stage: card.stage,
          answered: card.members.filter((x) => x.state !== 'working').length,
          of: card.members.length,
          members: card.members.map((x) => ({
            mark: x.mark,
            letter: x.name.charAt(0).toUpperCase() || '?',
            working: x.state === 'working',
          })),
          since: card.startedAt,
        };
      if (card?.kind === 'delegation' && card.live && card.stage === 'offer')
        return {
          kind: 'tasks',
          done: 0,
          total: card.tasks.filter((x) => x.state === 'offered').length,
          working: 0,
          needsYou: true,
          offered: true,
          since: card.startedAt,
        };
      if (card?.kind === 'delegation' && card.live && card.stage === 'working')
        return {
          kind: 'tasks',
          // As the server counts: what a thread doing several tasks said it finished is done, and it works as one.
          done: card.tasks.filter((x) => x.state === 'done' || (x.state === 'working' && x.reported)).length,
          total: card.tasks.filter((x) => x.state !== 'skipped').length,
          working: new Set(card.tasks.filter((x) => x.state === 'working').map((x) => x.url ?? x.id)).size,
          needsYou: card.tasks.some((x) => x.pending !== null),
          since: card.handedAt ?? card.startedAt,
        };
    }
    return null;
  }
  function threads(): ChatThread[] {
    return top()
      .map(threadOf)
      .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  }

  /** Why a thread can't settle now (CHS-03), or null. */
  function notNow(rootId: string): string | null {
    if (working.has(rootId)) return `${ASSISTANT_NAME} is still working on this.`;
    if (waiting(rootId)) return 'This thread waits for your answer.';
    if (handedOver(rootId)) return 'T3 Code is still working on what was handed over here.';
    return null;
  }

  function summary(): ChatSummary {
    const last = top().at(-1);
    return {
      id: conversation.id,
      title: ASSISTANT_NAME,
      subject: null,
      lastAt: last?.createdAt ?? conversation.createdAt,
      ...(last?.text ? { lastText: last.text.slice(0, 200) } : {}),
      unread: badge(),
      default: true,
      archivedAt: null,
      room: 'chat',
    };
  }

  function detail(): ConversationDetail {
    const last = shown().at(-1);
    return {
      conversation: { ...conversation, lastMessageAt: last?.createdAt ?? conversation.createdAt },
      summary: {
        id: conversation.id,
        kind: 'dm',
        slug: conversation.slug,
        title: conversation.title,
        link: { type: 'dm', room: 'chat' },
        unread: badge(),
        mentions: 0,
        prNumber: null,
        lastMessageAt: last?.createdAt ?? conversation.lastMessageAt,
      },
      pr: null,
      lastReadMessageId: last?.id ?? null,
    };
  }

  /** A person's new top-level message: its thread, which the assistant answers in at once (no socket here). */
  function startThread(
    text: string,
    subject: ChatSubject | null,
    clientId: string | null,
    runtime?: ChatRuntime,
  ): Message {
    const now = clock();
    const on = runtime ?? assistantRuntime;
    const models = on.provider === 'codex' ? CHAT_CODEX_MODELS : CHAT_CLAUDE_MODELS;
    const model = models.find((m) => (on.model ? m.id === on.model : m.isDefault));
    const root = message({
      id: newId() as Message['id'],
      authorId: person,
      createdAt: new Date(now).toISOString(),
      text,
      clientId,
      ...(subject ? { subject } : {}),
    });
    const answer = message({
      id: newId() as Message['id'],
      authorId: bot,
      createdAt: new Date(now + 1000).toISOString(),
      threadRootId: root.id,
      text: subject
        ? `On it. I’m looking at ${subject.name} now and I’ll answer here.`
        : 'On it. I’ll answer here.',
      ranOn: {
        provider: on.provider,
        model: on.model ?? null,
        modelLabel: model?.label ?? null,
        effort: on.effort ?? null,
        fast: on.fast ?? model?.fast === 'on',
      },
    });
    messages = [...messages, root, answer];
    return root;
  }

  async function body<T>(req: Request): Promise<T> {
    const text = await req.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url, 'http://fixtures.local');
    const path = url.pathname;
    if (!path.startsWith(`${B}/`)) return null;
    const rest = path.slice(B.length);
    const route = `${req.method} ${rest}`;

    if (route === 'GET /chats') {
      // Archived task chats are the one layer's; the list itself is the Chat (CHT-04: the task chats are archived).
      if (url.searchParams.get('archived') === 'true') return null;
      return json({ chats: [summary()] });
    }
    // “Make this Neo’s default” (CR-03): Chat's default follows; the one-Whombat layer answers with the assistant.
    if (route === 'PATCH /agent') {
      const { runtime } = await body<{ runtime?: ChatRuntime & { provider: string } }>(req);
      if (runtime) assistantRuntime = runtime;
      return null;
    }
    if (route === 'GET /chats/runtime') {
      if (runtimeMode === 'off') return json({ error: { code: 'not_found', message: 'Not here.' } }, 404);
      return json(runtimeView(url.searchParams.get('thread')));
    }
    const setRuntime = /^\/chats\/threads\/(msg_[A-Za-z0-9_-]+)\/runtime$/.exec(rest);
    if (setRuntime && req.method === 'PUT') {
      const { runtime } = await body<{ runtime: ChatRuntime | null }>(req);
      return json({ thread: storeRuntime(setRuntime[1] as string, runtime) });
    }
    if (route === 'POST /chats') {
      const { text, subject, runtime } = await body<{
        text: string;
        subject?: ChatSubject;
        runtime?: ChatRuntime;
      }>(req);
      const root = startThread(text, subject ?? null, null, runtime);
      storeRuntime(root.id, runtime);
      return json({ conversation: detail().conversation, message: root }, 201);
    }
    if (route === 'POST /chats/clear') {
      const { room } = await body<{ room?: string }>(req);
      if ((room ?? 'chat') !== 'chat') return null;
      const cleared = shown().length;
      // The world's times are of today: a clear before 10:12 still covers the newest message.
      if (cleared > 0) clearedAt = Math.max(clock(), ...shown().map((m) => Date.parse(m.createdAt)));
      unread = 0;
      // Chat is an inbox: clearing settles what can settle (Whombat chat-inbox.md CIB-13).
      for (const m of top().filter((x) => !settled.has(x.id) && !notNow(x.id))) {
        settled.set(m.id, { at: new Date(clock()).toISOString(), how: 'person' });
        newIn.delete(m.id);
      }
      return json({
        room: 'chat',
        conversationId: conversation.id,
        clearedAt: new Date(clearedAt ?? clock()).toISOString(),
        cleared,
      });
    }
    if (route === 'GET /chats/threads') {
      if ((url.searchParams.get('room') ?? 'chat') !== 'chat') return null;
      const kind = url.searchParams.get('subjectKind');
      const id = url.searchParams.get('subjectId');
      const before = url.searchParams.get('before');
      const state = url.searchParams.get('state');
      const limit = Number(url.searchParams.get('limit') ?? CHAT_THREADS_LIMIT_DEFAULT);
      // Open threads by their last activity, settled ones by when they settled (CHS-10).
      const order = (t: ChatThread) =>
        Date.parse(state === 'settled' ? (t.settled?.at ?? t.lastAt) : t.lastAt);
      // The subject narrows both the list and its settled count, as the server's does; the state the list.
      const here = threads().filter(
        (t) => (!kind || t.subject?.kind === kind) && (!id || t.subject?.id === id),
      );
      const list = here
        .filter((t) => (state === 'open' ? !t.settled : state === 'settled' ? !!t.settled : true))
        .sort((a, b) => order(b) - order(a))
        .filter((t) => !before || order(t) < Date.parse(before));
      const page = list.slice(0, limit);
      const last = page.at(-1);
      return json({
        threads: page,
        next: list.length > limit && last ? new Date(order(last)).toISOString() : null,
        ...(before ? {} : { settledCount: here.filter((t) => t.settled).length }),
      });
    }
    if (route === `GET /conversations/${conversation.id}/handoffs`)
      return json({ conversationId: conversation.id, handoffs: handoffs() });
    // A job's question answered or a message sent from the job (job-view.md): the job goes back to work.
    if (
      route === `POST /conversations/${conversation.id}/handoffs/answer` ||
      route === `POST /conversations/${conversation.id}/handoffs/send`
    ) {
      const { handoffId } = await body<{ handoffId: string }>(req);
      const at = code.handoffs.findIndex((h) => h.id === handoffId);
      const was = code.handoffs[at];
      if (!was) return json({ code: 'not_found', message: 'Job not found.' }, 404);
      if (was.state === 'asked') code.handoffs[at] = { ...was, state: 'working', asks: null, question: null };
      return json({ conversationId: conversation.id, handoffs: handoffs() });
    }
    if (route === 'GET /chats/unread') {
      if ((url.searchParams.get('room') ?? 'chat') !== 'chat') return null;
      return json({
        conversationId: conversation.id,
        threads: [...newIn].filter(([id]) => !settled.has(id)).map(([rootId, n]) => ({ rootId, unread: n })),
      });
    }
    const readThread = /^\/chats\/threads\/(msg_[A-Za-z0-9_-]+)\/read$/.exec(rest);
    if (readThread && req.method === 'POST') {
      const rootId = readThread[1] as string;
      if (!top().some((m) => m.id === rootId))
        return json({ error: { code: 'not_found', message: 'That thread isn’t here.' } }, 404);
      newIn.delete(rootId);
      return json({ conversationId: conversation.id, rootId, unread: 0, roomUnread: badge() });
    }
    // Mark as unread (chat-inbox.md CIB-06): the newest message someone else wrote in it counts as new again.
    const markUnread = /^\/chats\/threads\/(msg_[A-Za-z0-9_-]+)\/unread$/.exec(rest);
    if (markUnread && req.method === 'POST') {
      const rootId = markUnread[1] as string;
      const root = top().find((m) => m.id === rootId);
      if (!root) return json({ error: { code: 'not_found', message: 'That thread isn’t here.' } }, 404);
      const others = messages.some(
        (m) => (m.id === rootId || m.threadRootId === rootId) && m.authorId !== person,
      );
      if (others) newIn.set(rootId, 1);
      return json({
        conversationId: conversation.id,
        rootId,
        unread: newIn.get(rootId) ?? 0,
        roomUnread: badge(),
      });
    }
    const settle = /^\/chats\/threads\/(msg_[A-Za-z0-9_-]+)\/settled$/.exec(rest);
    if (settle && req.method === 'PUT') {
      const root = top().find((m) => m.id === settle[1]);
      if (!root) return json({ error: { code: 'not_found', message: 'That thread isn’t here.' } }, 404);
      const { settled: on } = await body<{ settled: boolean }>(req);
      if (on) {
        const why = notNow(root.id);
        if (why) return json({ error: { code: 'conflict', message: why } }, 409);
        settled.set(root.id, { at: new Date(clock()).toISOString(), how: 'person' });
        // Settling by hand reads it (thread-unread.md TU-02).
        newIn.delete(root.id);
      } else settled.delete(root.id);
      return json({ thread: threadOf(current().find((m) => m.id === root.id) ?? root) });
    }
    if (route === 'POST /chats/settle') {
      const { room, onlyRead } = await body<{ room?: string; onlyRead?: boolean }>(req);
      if ((room ?? 'chat') !== 'chat') return null;
      // “Settle everything read” leaves what has something new (CIB-07).
      const finished = top().filter(
        (m) => !settled.has(m.id) && !notNow(m.id) && !(onlyRead && (newIn.get(m.id) ?? 0) > 0),
      );
      for (const m of finished) {
        settled.set(m.id, { at: new Date(clock()).toISOString(), how: 'person' });
        newIn.delete(m.id);
      }
      return json({ room: 'chat', conversationId: conversation.id, settled: finished.length });
    }

    const thread = /^\/messages\/(msg_[A-Za-z0-9_-]+)\/thread$/.exec(rest);
    if (thread && req.method === 'GET') {
      const all = current();
      const root = all.find((m) => m.id === thread[1] && !m.threadRootId);
      if (!root) return null;
      return json({
        root,
        replies: all.filter((m) => m.threadRootId === root.id),
        conversationId: conversation.id,
        where: 'Chat',
        topic: null,
        more: null,
      });
    }
    // Answers to what a job's result left for Mara (job-result.md): they go to T3 Code together, and the message says
    // so until it is done (the fixture's T3 Code stays on them).
    const jobAnswers = /^\/messages\/(msg_[A-Za-z0-9_-]+)\/job-answers$/.exec(rest);
    if (jobAnswers && req.method === 'POST') {
      const at = messages.findIndex((m) => m.id === jobAnswers[1]);
      const found = at >= 0 ? messages[at] : undefined;
      const result = found?.jobResult;
      if (!found || !result)
        return json({ error: { code: 'not_found', message: 'That report isn’t here any more.' } }, 404);
      if (result.sends.some((s) => s.doneAt === null))
        return json({ error: { code: 'conflict', message: 'T3 Code is still on your last answers.' } }, 409);
      const { answers } = await body<{ answers: JobResultAnswer[] }>(req);
      const next: Message = {
        ...found,
        jobResult: {
          ...result,
          sends: [
            ...result.sends,
            { at: new Date(clock()).toISOString(), answers, doneAt: null, outcome: null },
          ],
        },
      };
      messages = messages.map((m, i) => (i === at ? next : m));
      return json({ message: next });
    }
    const one = /^\/messages\/(msg_[A-Za-z0-9_-]+)$/.exec(rest);
    if (one && req.method === 'GET') {
      const m = current().find((x) => x.id === one[1]);
      return m ? json({ message: m }) : null;
    }

    // The pictures of what changed, as the server serves an attachment: the final council card's, the working task's.
    if (options.council && route === `GET /attachments/${COUNCIL_SHOT_ID}`)
      return new Response(new Blob([councilShotBytes() as BlobPart], { type: 'image/png' }), {
        headers: { 'content-type': 'image/png' },
      });
    if (options.delegation && route === `GET /attachments/${DELEGATION_SHOT_ID}`)
      return new Response(new Blob([delegationShotBytes() as BlobPart], { type: 'image/png' }), {
        headers: { 'content-type': 'image/png' },
      });
    // A council's Stop (council.md CNL-43, CNL-60): the card ends as the server's would, and its checklist with it.
    if (route === 'POST /councils/stop' && options.council) {
      const { councilId } = await body<{ councilId: string }>(req);
      const at = messages.findIndex((m) => m.card?.kind === 'council' && m.card.councilId === councilId);
      const found = at >= 0 ? messages[at] : undefined;
      const card = found?.card;
      if (!found || card?.kind !== 'council')
        return json({ error: { code: 'not_found', message: 'That council isn’t here any more.' } }, 404);
      const next = pressCouncil(card, clock());
      if (!next)
        return json({ error: { code: 'conflict', message: 'The council doesn’t wait for that now.' } }, 409);
      const root = found.threadRootId ?? found.id;
      messages = messages.map((m, i) => {
        if (i === at) return { ...m, card: next as MessageCard };
        // Its plan's tasks stop too.
        const stopped =
          m.card?.kind === 'delegation' && m.card.council && (m.threadRootId ?? m.id) === root
            ? pressDelegation(m.card, { op: 'stop' }, clock())
            : null;
        return stopped ? { ...m, card: stopped as MessageCard } : m;
      });
      return json({ councilId, stage: next.stage });
    }

    // The AI chosen on a checklist, from the council's fixture models.
    if (route === 'GET /delegations/models' && (options.delegation || options.council))
      return json({ options: COUNCIL_PROVIDER_OPTIONS, t3: 'ready' });
    if (route === 'POST /delegations/ai' && (options.delegation || options.council)) {
      const sent = await body<{ delegationId: string; taskId?: string; ai: DelegationAiChoice | null }>(req);
      const at = messages.findIndex(
        (m) => m.card?.kind === 'delegation' && m.card.delegationId === sent.delegationId,
      );
      const card = at >= 0 ? messages[at]?.card : undefined;
      if (card?.kind !== 'delegation')
        return json({ error: { code: 'not_found', message: 'That list isn’t here any more.' } }, 404);
      const next = chooseDelegationAi(card, sent, COUNCIL_PROVIDER_OPTIONS);
      if (!next)
        return json({ error: { code: 'conflict', message: 'The list doesn’t wait for that now.' } }, 409);
      messages = messages.map((m, i) => (i === at ? { ...m, card: next as MessageCard } : m));
      return json({ delegationId: sent.delegationId, stage: next.stage });
    }

    // A delegation's buttons (delegate.md): tick, Hand over, Stop this task, Stop; the card changes as the server's would.
    const delegationOp = (
      {
        'POST /delegations/pick': 'pick',
        'POST /delegations/start': 'start',
        'POST /delegations/stop-task': 'stopTask',
        'POST /delegations/stop': 'stop',
      } as Record<string, DelegationPress['op']>
    )[route];
    if (delegationOp && (options.delegation || options.council)) {
      const sent = await body<{
        delegationId: string;
        taskId?: string;
        picked?: boolean;
      }>(req);
      const at = messages.findIndex(
        (m) => m.card?.kind === 'delegation' && m.card.delegationId === sent.delegationId,
      );
      const found = at >= 0 ? messages[at] : undefined;
      const card = found?.card;
      if (!found || card?.kind !== 'delegation')
        return json({ error: { code: 'not_found', message: 'That list isn’t here any more.' } }, 404);
      const press = {
        op: delegationOp,
        taskId: sent.taskId ?? '',
        picked: sent.picked ?? false,
      } as DelegationPress;
      const next = pressDelegation(card, press, clock());
      if (!next)
        return json({ error: { code: 'conflict', message: 'The list doesn’t wait for that now.' } }, 409);
      // A council's checklist put aside or stopped before it was handed over ends the council as Stopped (CNL-60).
      const ends = card.council && card.stage === 'offer' && next.stage === 'stopped';
      const root = found.threadRootId ?? found.id;
      messages = messages.map((m, i) => {
        if (i === at) return { ...m, card: next as MessageCard };
        const council =
          ends && m.card?.kind === 'council' && (m.threadRootId ?? m.id) === root
            ? pressCouncil(m.card, clock())
            : null;
        return council ? { ...m, card: council as MessageCard } : m;
      });
      return json({ delegationId: sent.delegationId, stage: next.stage });
    }

    const decide = new RegExp(`^/approvals/${ZFS_APPROVAL}(/decide)?$`).exec(rest);
    if (decide) {
      if (req.method === 'GET' && !decide[1]) return json({ approval, eventId: null });
      if (req.method === 'POST' && decide[1]) {
        const { decision, executeAt } = await body<{ decision: 'approve' | 'decline'; executeAt?: string }>(
          req,
        );
        approval = {
          ...approval,
          state: decision === 'approve' ? 'approved' : 'declined',
          decidedById: mara.id,
          decidedAt: new Date(clock()).toISOString(),
          ...(executeAt ? { executeAt } : {}),
        } as Approval;
        return json({ approval, eventId: null });
      }
    }

    const conv = new RegExp(`^/conversations/${DEFAULT_CHAT_ID}(/messages|/read)?$`).exec(rest);
    if (!conv) return null;
    if (req.method === 'GET' && !conv[1]) return json(detail());
    if (req.method === 'GET' && conv[1] === '/messages')
      return json({ messages: shown(), before: null, hasMore: false });
    if (req.method === 'POST' && conv[1] === '/messages') {
      const input = await body<{
        text: string;
        clientId?: string;
        threadRootId?: string | null;
        runtime?: ChatRuntime;
      }>(req);
      if (!input.threadRootId) {
        const root = startThread(input.text, null, input.clientId ?? null, input.runtime);
        storeRuntime(root.id, input.runtime);
        return json({ message: root, dispatches: [] }, 201);
      }
      const reply = message({
        id: newId() as Message['id'],
        authorId: person,
        createdAt: new Date(clock()).toISOString(),
        text: input.text,
        clientId: input.clientId ?? null,
        threadRootId: input.threadRootId as Message['threadRootId'],
      });
      messages = [...messages, reply];
      // A new message opens a settled thread again (CHS-04), and answers a question in it.
      settled.delete(input.threadRootId);
      asking.delete(input.threadRootId);
      return json({ message: reply, dispatches: [] }, 201);
    }
    if (req.method === 'POST' && conv[1] === '/read') {
      unread = 0;
      return json({ unread: 0, mentions: 0 });
    }
    return null;
  }

  async function discuss(text: string, subject: ChatSubject | null): Promise<Response> {
    const root = message({
      id: newId() as Message['id'],
      authorId: bot,
      createdAt: new Date(clock()).toISOString(),
      text,
      ...(subject ? { subject } : {}),
    });
    messages = [...messages, root];
    return json({ conversation: detail().conversation, message: root }, 201);
  }

  return { handle, discuss };
}
