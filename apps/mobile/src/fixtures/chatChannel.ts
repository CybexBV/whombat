/**
 * Chat in the one-Whombat demo world (Whombat chat-channel.md CHT-01…CHT-07; chat-channel.md AP-2460): Mara's Chat with
 * Neo, threaded, after the fresh start — yesterday's question about Zonneplan (three replies), this morning's backup
 * news, the shop's login Mara sent and Neo saved to her Vault (blanked, “Saved to your Vault · Shop admin”), the heat
 * pump's thread with its skill card, why pve-02 uses so much memory (about pve-02, Neo's answer and an
 * approval to cap the ZFS cache), a question about the access points' firmware Neo is still looking into and a tracker
 * customer's feature request waiting for Mara on its card (Approve, Approve and build, Decline, Ask the customer:
 * `tracker.decide` decides it on its message, `message.updated`) — and her Feedback room
 * with two reports from the website, one unread.
 *
 * Serves `chats.list` (the two rooms), `chats.threads` (paged by `lastAt`, by subject), `chats.start` (a thread in
 * Chat), and the rooms' `conversations.get`, `messages.list` (the threads' first messages with their replies counted),
 * `messages.thread` and `messages.send`: Neo answers every new thread and reply in the thread after `replyDelayMs`,
 * thinking first, and the thread's first message follows (`message.updated`). What answers in Chat (`chatRuntime.ts`,
 * chat-runtime-android.md AP-2732): `chats.runtime`, `chats.setThreadRuntime`, a new thread's choice, and Neo's
 * replies in Chat say what answered them. With `tasks` (`EXPO_PUBLIC_WHOMBAT_TASKS=1`, task-feedback.md AP-4306) the
 * newest thread is Mara's ask for tonight's server work with its task cards (thetitan's updates done, pve-01's backup
 * done with warnings, pve-02's that didn't work, the-falcon's updates running), and the running one ends after
 * `taskEndMs` as the runtime ends it: its card changed in place on its message (`message.updated`). With `threads` the
 * threads Neo started about the looks it looked into (`looks.ts`, look-research-mobile.md AP-5925) are in Chat too.
 *
 * Settled threads (chat-settle.md AP-6157, AP-6180): yesterday's Zonneplan question and the NAS certificate are settled
 * (Mara put them away), the website's login redirect settled when its pull request merged and the old Synology question
 * by itself after quiet days; pve-02's thread waits for Mara's yes and the heat pump's for her choice. `chats.threads`
 * lists by `state` with `settledCount`, `chats.settle` settles or opens one again (refused while Neo works on it or it
 * waits), `chats.settleFinished` settles the rest, a new message opens a thread again, each with `chat.settled` to Mara;
 * `me.getPreferences` and `me.updatePreferences` keep Profile's CHAT switches.
 *
 * With `code` (`EXPO_PUBLIC_WHOMBAT_CODE=1`) Mara's software work (`code.ts`) is in Chat's threads too: their rows'
 * work line (a council's round, a checklist's tasks) and `conversations.handoffs`, what T3 Code does for them, which
 * the job view in their threads draws. `chats.place`, which an older app may still call, answers the thread as it is.
 * With `watches` (`EXPO_PUBLIC_WHOMBAT_WATCHES=1`, findmy-watch.md) two one-time Find My watches are in Chat, each in a
 * thread of Mara's ask: Noor Visser leaving Keizersgracht, still watching with Cancel (`connections.findMyWatchCancel`
 * turns it cancelled on its message, `message.updated`), and Ruben Dekker arriving at Home, which happened. Made-up
 * people.
 *
 * Pure TypeScript over `Response`; every answer parses with its endpoint's schema (tested).
 */

import { lastOfMessage } from '@whombat/client';
import {
  type Approval,
  type ApprovalAction,
  actionCopy,
  type ChatPreferences,
  type ChatRoom,
  type ChatRuntime,
  type ChatSubject,
  type ChatSummary,
  type ChatThread,
  type ChatThreadLast,
  type ChatThreadRepo,
  type Conversation,
  type ConversationDetail,
  type ConversationSummary,
  type DelegationAiChoice,
  type DelegationModelsResponse,
  type DeviceSkillCard,
  type FeatureDecisionChoice,
  type FeatureRequestView,
  type FindMyWatchView,
  featureValueText,
  findMyWatchEndText,
  findMyWatchStartText,
  type GuideCard,
  GuideVaultAsk,
  type Handoff,
  JOB_RESULT_SENDS_MAX,
  type JobAnswersBody,
  type LocalModelView,
  type Message,
  type Preferences,
  type RealtimeEvent,
  signedReply,
  type TaskCard,
  type ThreadSettle,
  type ThreadWork,
  taskCardLine,
  VAULT_BLANKED,
} from '@whombat/core';
import { vaultAskCard, vaultAskLockedLabel } from '@whombat/core/vault';
import { at, deployApproval, JOB_RESULT_REPORT, jobResultFixture, mara } from '@whombat/fixtures';
import { createChatRuntimeFixtures, DEMO_RAN_ON } from './chatRuntime';
import { CODE_RESULT_MESSAGE, codeThreads } from './code';
import { councilPress, councilThreads } from './council';
import {
  DELEGATION_AI_OPTIONS,
  type DelegationFixtureStage,
  type DelegationPress,
  delegationPress,
  delegationThread,
} from './delegation';
import { jobOf } from './jobs';
import type { LookThreadSeed } from './looks';

/** Mara's Feedback room (CHT-03): her other room with the agent (`{type: 'dm', room: 'feedback'}`). */
export const FEEDBACK_ROOM_ID = 'cnv_dm-mara-feedback';
/** The approval in pve-02's thread: cap the ZFS cache (thetitan's Docker cleanup is #32). */
export const ZFS_APPROVAL = 33;

const ZFS_ACTION: Extract<ApprovalAction, { type: 'connection_call' }> = {
  type: 'connection_call',
  params: {
    connectionId: 'con_whombat_servers',
    handle: 'servers',
    tool: 'server_command',
    toolHash: '7a2c4e6f8b0d1f3a5c7e9b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a',
    words: 'limit the ZFS cache on pve-02 to 16 GB',
    server: { id: 'pve-02', name: 'pve-02' },
  },
};
/** The thread roots, for tests and Home's links. */
export const CHAT_ROOTS = {
  zonneplan: 'msg_chat-zonneplan',
  backups: 'msg_chat-backups',
  heat: 'msg_chat-heat',
  memory: 'msg_chat-memory',
  firmware: 'msg_chat-firmware',
  shop: 'msg_chat-shop',
  plans: 'msg_chat-plans',
  tasks: 'msg_chat-tasks',
  watchNoor: 'msg_chat-watch-noor',
  watchRuben: 'msg_chat-watch-ruben',
  prod1: 'msg_chat-prod1',
  githubCode: 'msg_chat-github-code',
  nas: 'msg_chat-nas',
  feature: 'msg_chat-feature',
  redirect: 'msg_chat-redirect',
  synology: 'msg_chat-synology',
  contact: 'msg_fb-contact',
  pricing: 'msg_fb-pricing',
} as const;

const PVE02: ChatSubject = { kind: 'server', id: 'pve-02', name: 'pve-02' };

/** The feature request in Chat: HollowMere College's CSV export, waiting for Mara. */
export const FEATURE_REQUEST_ID = 'tfr_hollowmere21';

interface RoomState {
  room: ChatRoom;
  conversation: Conversation;
  roots: Message[];
  replies: Map<string, Message[]>;
}

export interface ChatChannelOptions {
  now: () => Date;
  emit: (topic: string, event: RealtimeEvent) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  replyDelayMs: number;
  /** Tonight's server work with its task cards (AP-4306); off by default. */
  tasks?: boolean;
  /** Two one-time Find My watches (findmy-watch.md): one watching, one that happened. Off by default. */
  watches?: boolean;
  /**
   * The sign-in cards (vault-simplify.md VLT-42, VLT-44; app vault-asks.md AP-6680): prod-1 refused Neo's key, and
   * github.com sent a code after its login was saved. Off by default.
   */
  signIns?: boolean;
  /**
   * Councils Neo leads (council.md; `council.ts`): a review at work, a plan being built (its tasks on a checklist under
   * it), and one done with its scores and a picture. Off by default.
   */
  councils?: boolean;
  /**
   * A delegation Neo offers (delegate.md; `delegation.ts`) at this stage: the checklist waiting for Mara, the tasks at
   * work, or ended. None by default.
   */
  delegation?: DelegationFixtureStage;
  /** Mara's software work in Chat's threads, one in each state of its row (`code.ts`); off by default. */
  code?: boolean;
  /** Also a job in every state of the job view (`code.ts`, job-view.md); default `EXPO_PUBLIC_WHOMBAT_CODE=jobs`. */
  codeJobs?: boolean;
  /** When the-falcon's running updates end (ms after the world was made); default 30 s. */
  taskEndMs?: number;
  /** Threads Neo started in Chat about the looks it looked into (`looks.ts`); none by default. */
  threads?: readonly LookThreadSeed[];
  assistantId: string;
  /** Neo's name as it is now (the runtime's view says it). */
  assistantName: () => string;
  /** Mara's Chat as the world has it: its title follows the agent's name. */
  chat: () => Conversation;
  /** Mara's other room with the agent (Feedback). */
  dm: (id: string, title: string, lastAt: string | null) => Conversation;
  summaryOf: (c: Conversation) => ConversationSummary;
  /** The heat pump's card as it is now (the world decides it). */
  heat: () => DeviceSkillCard;
  /** The burrow's model on its network as it is now (AP-5126): Local in the picker while there is one. */
  localModel?: () => LocalModelView | null;
  json: (body: unknown, status?: number) => Response;
  notFound: (text: string) => Response;
  bodyOf: <T>(init: RequestInit | undefined) => Promise<T>;
}

export function createChatChannelFixtures(options: ChatChannelOptions) {
  const { now, emit, json, notFound, bodyOf, assistantId } = options;
  let seq = 0;
  const msg = (
    id: string | null,
    conversationId: string,
    authorId: string,
    createdAt: string,
    text: string,
    extra: Partial<Message> = {},
  ): Message => ({
    id: id ?? `msg_chat-${String(++seq).padStart(4, '0')}`,
    conversationId,
    authorId,
    createdAt,
    editedAt: null,
    text,
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
    ...extra,
  });

  /** Neo asks to cap the ZFS cache: a command on pve-02, asked first (as the server-asks fixture's). */
  const zfs = (state: Approval['state'], executeAt: string | null = null): Approval => {
    const copy = actionCopy(ZFS_ACTION);
    const base = deployApproval();
    const decided = state !== 'pending';
    return deployApproval({
      id: 'apr_zfs-cache',
      number: ZFS_APPROVAL,
      requesterId: assistantId,
      keyId: 'connections.write',
      action: ZFS_ACTION,
      connection: {
        label: 'Servers',
        catalogId: 'whombat_servers',
        argumentsPreview: 'echo 17179869184 > /sys/module/zfs/parameters/zfs_arc_max',
      },
      title: copy.title,
      question: copy.question,
      target: copy.target,
      whatHappens: [],
      explainer: 'Running a command on a server asks a person first.',
      summary: copy.runs,
      conditions: base.conditions
        .filter((c) => c.kind === 'person_approves')
        .map((c) => ({ ...c, met: state === 'approved' })),
      state,
      decidedById: decided ? mara.id : null,
      decidedAt: decided ? now().toISOString() : null,
      executeAt,
      conversationId: options.chat().id,
      messageId: null,
      involvedIds: [],
      eventId: null,
      createdAt: at('14:03'),
    });
  };

  /**
   * A tracker customer's feature request (the made-up Acme Desk) as the runtime resolves its card: Neo's value, why,
   * both drafts signed as the customer would get them, and “Approve and build”, since the demo's tracker automation
   * fixes.
   */
  const signature = () => `${options.assistantName()} - AI Assistant`;
  let feature: FeatureRequestView = {
    id: FEATURE_REQUEST_ID as FeatureRequestView['id'],
    runId: 'arn_tracker_feature' as FeatureRequestView['runId'],
    automationId: 'aut_tracker' as FeatureRequestView['automationId'],
    connection: 'Acme Desk dev',
    number: 21,
    title: 'Export invoices to CSV',
    organization: 'HollowMere College',
    agent: options.assistantName(),
    value: 7,
    valueWhy:
      'Several schools asked for this, and it’s a small change: the invoice list already has everything a spreadsheet needs.',
    summary: 'They want to download their invoices as a spreadsheet, so their bookkeeper can import them.',
    importance: 'medium',
    size: 'small',
    approvedMessage: signedReply(
      'Thanks for the idea! We’re going to build this: you’ll be able to download your invoices as a CSV file. We’ll let you know as soon as it’s ready.',
      signature(),
    ),
    declinedMessage: signedReply(
      'Thanks for the idea! We won’t build a separate CSV export for now: the new reports page, coming soon, lets you download the same figures.',
      signature(),
    ),
    declineReason: 'The new reports page will cover the same need soon.',
    canBuild: true,
    state: 'waiting',
    choice: null,
    note: null,
    decidedById: null,
    decidedAt: null,
    createdAt: at('10:46'),
  };
  /** The server's words with the card, for an app that can't show it. */
  const featureText = `Feature request from HollowMere College: “Export invoices to CSV” · ${featureValueText(7)}. Approve it, decline it or ask the customer here.`;

  const rooms = new Map<string, RoomState>();
  /** Threads Neo is working on (CT-442 `working`). */
  const working = new Set<string>([CHAT_ROOTS.firmware]);
  /** Settled threads and how (CHS-01, CHS-02), and the ones Mara opened again by hand (CHS-05). */
  const settled = new Map<string, ThreadSettle>([
    [CHAT_ROOTS.synology, { at: at('09:41', -9), how: 'quiet' }],
    [CHAT_ROOTS.redirect, { at: at('15:20', -5), how: 'merged' }],
    [CHAT_ROOTS.zonneplan, { at: at('21:12', -1), how: 'person' }],
    [CHAT_ROOTS.nas, { at: at('21:30', -1), how: 'person' }],
  ]);
  const keptOpen = new Set<string>();
  /**
   * How many of each thread's messages Mara has read, its first one counted (thread-unread.md TU-01): this morning's
   * backup news, Neo's ask in pve-02's thread, its answer about the plans page and the pricing report are new to her;
   * every other thread starts read to its end (`readAllYet`).
   */
  const readCount = new Map<string, number>([
    [CHAT_ROOTS.backups, 0],
    [CHAT_ROOTS.memory, 3],
    [CHAT_ROOTS.plans, 1],
    [CHAT_ROOTS.pricing, 0],
  ]);
  /** Mara's preferences as Profile saves them (CHAT's switches, the theme). */
  let preferences: Preferences = { theme: 'system', timeZone: null };
  /** Whether pve-02's yes is still to come (the approval in its thread). */
  let zfsPending = true;
  const meTopic = `me:${mara.id}`;
  /** A council or checklist going on from a thread, as its row says it. */
  const works = new Map<string, ThreadWork>();
  /** What Neo handed to T3 Code from Chat's threads. */
  const handoffs: Handoff[] = [];
  /** The repository a thread's work is in (software work), for its row's icon. */
  const repos = new Map<string, ChatThreadRepo>();

  const chatId = options.chat().id;
  // What answers in Chat (AP-2732): Neo's default, each thread's choice, what a reply ran on.
  const runtime = createChatRuntimeFixtures({
    now,
    emit,
    assistantId,
    assistantName: options.assistantName,
    meTopic,
    chatId,
    localModel: options.localModel ?? (() => null),
    threads: {
      [CHAT_ROOTS.memory]: { provider: 'codex', effort: 'high', fast: true },
      [CHAT_ROOTS.zonneplan]: { provider: 'claude', fast: true },
      [CHAT_ROOTS.heat]: { provider: 'claude', model: 'fable' },
    },
  });
  const thread = (
    room: RoomState,
    root: Message,
    replies: [string, string, string, Partial<Message>?][] = [],
  ) => {
    room.roots.push(root);
    room.replies.set(
      root.id,
      replies.map(([who, when, text, extra]) =>
        msg(null, root.conversationId, who, when, text, { threadRootId: root.id, ...extra }),
      ),
    );
  };
  const chat: RoomState = {
    room: 'chat',
    conversation: options.chat(),
    roots: [],
    replies: new Map(),
  };
  // Older threads that settled by themselves (Settled's “by itself”, “when its pull request merged”).
  thread(
    chat,
    msg(
      CHAT_ROOTS.synology,
      chatId,
      mara.id,
      at('09:30', -9),
      'Is the old Synology still backing up anything?',
    ),
    [[assistantId, at('09:41', -9), 'No. Its last backup was in June; everything goes to pve-01 now.']],
  );
  thread(
    chat,
    msg(CHAT_ROOTS.redirect, chatId, mara.id, at('10:05', -5), 'Fix the login redirect on the website'),
    [
      [
        assistantId,
        at('10:31', -5),
        'Fixed: the login page sent you back to the home page instead of where you were. The pull request is ready for you.',
      ],
    ],
  );
  thread(
    chat,
    msg(
      CHAT_ROOTS.zonneplan,
      chatId,
      mara.id,
      at('21:02', -1),
      'Is Zonneplan in Home Assistant still doing anything?',
    ),
    [
      [
        assistantId,
        at('21:04', -1),
        'Not much. It still reads the energy prices every hour, but nothing uses them since you moved the dishwasher schedule.',
        { ranOn: DEMO_RAN_ON.zonneplanFirst },
      ],
      [mara.id, at('21:07', -1), 'Then switch it off.'],
      [
        assistantId,
        at('21:09', -1),
        'Done. Zonneplan is off; your energy dashboard still has its history.',
        { ranOn: DEMO_RAN_ON.zonneplanLast },
      ],
    ],
  );
  thread(chat, msg(CHAT_ROOTS.nas, chatId, mara.id, at('21:20', -1), 'Renew the certificate on the NAS'), [
    [assistantId, at('21:24', -1), 'Done. The new certificate is good until next September.'],
  ]);
  thread(
    chat,
    msg(CHAT_ROOTS.backups, chatId, assistantId, at('07:00'), 'Last night’s backups ran for all 12 guests.'),
  );
  // A tracker customer asked for something new: Neo scored it, told them it's being looked at, and asks Mara.
  thread(
    chat,
    msg(
      CHAT_ROOTS.feature,
      chatId,
      assistantId,
      at('10:40'),
      'HollowMere College asked for something new in Acme Desk dev #21: “Export invoices to CSV”.',
    ),
    [
      [
        assistantId,
        at('10:45'),
        'It’s a feature request, and I think it’s worth building. I told them we’re looking at it.',
      ],
      [
        assistantId,
        at('10:46'),
        featureText,
        { card: { kind: 'feature_request', requestId: feature.id, request: feature } },
      ],
    ],
  );
  // A link in the first message: the inbox's row reads it as plain words, the preview stays inside the thread.
  thread(
    chat,
    msg(
      CHAT_ROOTS.plans,
      chatId,
      mara.id,
      at('10:52'),
      'Is it clear the prices here are without VAT? https://www.lumio.example.org/plans',
    ),
    [
      [
        assistantId,
        at('11:05'),
        'Not really: nothing on the page says so. I can add “excl. VAT” under each price if you like.',
      ],
    ],
  );
  // Mara sent the shop's login in her own chat: Neo saved it to her Vault and Whombat blanked it in her message
  // (Whombat vault-self-serve.md VS-04, VS-07; AP-4039). The entry is the demo Vault's “Shop admin”.
  thread(
    chat,
    msg(
      CHAT_ROOTS.shop,
      chatId,
      mara.id,
      at('11:30'),
      `The shop’s admin login is mara@burrowhq.example, password ${VAULT_BLANKED}`,
      {
        vaultSaved: [
          {
            entryId: 'vlt_shop',
            name: 'Shop admin',
            kind: 'login',
            how: 'saved',
            server: null,
            at: at('11:31'),
          },
        ],
      },
    ),
    [
      [
        assistantId,
        at('11:31'),
        'Saved it to your Vault as Shop admin. I can sign in to the shop from now on.',
      ],
    ],
  );
  thread(
    chat,
    msg(
      CHAT_ROOTS.heat,
      chatId,
      mara.id,
      at('13:20'),
      'We have a Daikin Altherma heat pump in the utility room. Can you add it, so I can see it and control it?',
    ),
    [
      [
        assistantId,
        at('13:41'),
        'It works. I checked what already exists first, then wrote a skill that only reads. Before I change anything, choose what I’m allowed to do.',
        { card: options.heat(), ranOn: DEMO_RAN_ON.heat },
      ],
    ],
  );
  thread(
    chat,
    msg(CHAT_ROOTS.memory, chatId, mara.id, at('13:52'), 'Why is pve-02 using so much memory?', {
      subject: PVE02,
    }),
    [
      [
        assistantId,
        at('13:53'),
        'It’s at 91%, but 38 GB of that is the ZFS cache, which gives memory back when a guest needs it. Nothing is short right now.',
        { ranOn: DEMO_RAN_ON.memoryFirst },
      ],
      [mara.id, at('13:58'), 'Can you cap the cache at 16 GB?'],
      [
        assistantId,
        at('14:03'),
        'Sure. It takes effect after a restart, so I’d do it tonight.',
        { card: { kind: 'approval', approval: zfs('pending') }, ranOn: DEMO_RAN_ON.memoryLast },
      ],
    ],
  );
  thread(
    chat,
    msg(CHAT_ROOTS.firmware, chatId, mara.id, at('14:04'), 'Is there new firmware for the access points?'),
  );
  if (options.tasks) taskThread();
  if (options.watches) watchThreads();
  if (options.signIns) signInThreads();
  if (options.councils) councilThreadsIn();
  if (options.delegation) delegationThreadIn(options.delegation);
  if (options.code) codeThreadsIn();
  for (const t of options.threads ?? []) {
    thread(chat, msg(t.id, chatId, t.authorId, t.at, t.text, { subject: t.subject }), t.replies);
    if (t.working) working.add(t.id);
  }
  rooms.set(chatId, chat);

  /** The sign-in cards, made by core as the server makes them, in two threads of Chat. */
  function signInThreads() {
    const made = now().getTime();
    const ago = (minutes: number) => new Date(made - minutes * 60_000).toISOString();
    const name = options.assistantName();
    const server = vaultAskCard(
      name,
      GuideVaultAsk.parse({
        kind: 'server',
        name: 'prod-1',
        username: 'deploy',
        server: { host: '192.168.1.30', port: 22, reason: 'key_refused' },
      }),
      'To copy the new website onto it.',
    );
    thread(chat, msg(CHAT_ROOTS.prod1, chatId, mara.id, ago(9), 'Put the new website on prod-1'), [
      [assistantId, ago(8), '', { card: server }],
    ]);
    const login = vaultAskCard(
      name,
      GuideVaultAsk.parse({ kind: 'login', name: 'github.com', url: 'https://github.com/login' }),
      'To open the pull request for the new site.',
    );
    const saved: GuideCard = {
      ...login,
      state: 'done',
      answer: {
        actionId: 'save',
        optionIds: null,
        label: vaultAskLockedLabel('saved', { name: 'github.com' }),
        at: ago(4),
        vaultEntryId: 'vlt_fixture_github',
        vaultOutcome: 'saved',
      },
    };
    const code = vaultAskCard(
      name,
      GuideVaultAsk.parse({ kind: 'code', name: 'github.com', hint: 'It came by text to your phone.' }),
      null,
    );
    thread(
      chat,
      msg(CHAT_ROOTS.githubCode, chatId, mara.id, ago(6), 'Open the pull request for the new site on GitHub'),
      [
        [assistantId, ago(5), '', { card: saved }],
        [assistantId, ago(3), '', { card: code }],
      ],
    );
  }

  /** The councils' threads (`council.ts`), as of now. */
  function councilThreadsIn() {
    const made = now().getTime();
    const ago = (minutes: number) => new Date(made - minutes * 60_000).toISOString();
    for (const t of councilThreads(made)) {
      const root = msg(t.id, chatId, mara.id, ago(t.at), t.text);
      thread(
        chat,
        root,
        t.replies.map(([who, minutes, text, extra]) => [
          who === 'mara' ? mara.id : assistantId,
          ago(minutes),
          text,
          extra ? { card: extra.card, attachments: extra.attachments ?? [] } : {},
        ]),
      );
    }
  }

  /** Mara's software work (`code.ts`), as of now: its threads, their work and hand-overs. */
  function codeThreadsIn() {
    const made = now().getTime();
    const ago = (minutes: number) => new Date(made - minutes * 60_000).toISOString();
    for (const t of codeThreads(options.codeJobs ?? process.env.EXPO_PUBLIC_WHOMBAT_CODE === 'jobs')) {
      const handoffId = `t3_${t.id}`;
      const result: [string, string, string, Partial<Message>][] =
        t.result !== undefined
          ? [
              [
                assistantId,
                ago(t.result),
                JOB_RESULT_REPORT,
                {
                  id: CODE_RESULT_MESSAGE,
                  jobResult: jobResultFixture(ago(t.result), { handoffId }),
                },
              ],
            ]
          : [];
      thread(chat, msg(t.id, chatId, mara.id, ago(t.at), t.text), [
        ...t.replies.map(([who, minutes, text]): [string, string, string] => [
          who === 'mara' ? mara.id : assistantId,
          ago(minutes),
          text,
        ]),
        ...result,
      ]);
      if (t.work) works.set(t.id, { ...t.work, since: ago(t.work.since) } as ThreadWork);
      if (t.settled !== undefined) settled.set(t.id, { at: ago(t.settled), how: 'person' });
      if (t.repo) repos.set(t.id, t.repo);
      if (t.unread) readCount.set(t.id, 1 + t.replies.length + result.length - t.unread);
      if (t.handoff)
        handoffs.push({
          id: handoffId,
          to: 't3code',
          conversationId: chatId,
          rootId: t.id,
          agentId: assistantId,
          title: t.handoff.title,
          state: t.handoff.state,
          since: ago(t.handoff.since),
          endedAt:
            t.result !== undefined
              ? ago(t.result)
              : t.handoff.state === 'checks'
                ? ago(t.handoff.since)
                : null,
          outcome: t.result !== undefined ? 'completed' : null,
          ...(t.result !== undefined
            ? { resultMessageId: CODE_RESULT_MESSAGE as Handoff['resultMessageId'] }
            : {}),
          steps: t.handoff.steps,
          asks: null,
          pullRequests: t.handoff.pullRequests,
          program: t.handoff.program,
          url: null,
          ...(t.handoff.job ? jobOf(t.handoff.job, made, t.handoff.since, t.handoff.pr ?? null) : {}),
        });
    }
  }

  /** The delegation's thread (`delegation.ts`), as of now. */
  function delegationThreadIn(stage: DelegationFixtureStage) {
    const made = now().getTime();
    const ago = (minutes: number) => new Date(made - minutes * 60_000).toISOString();
    const t = delegationThread(made, stage);
    thread(chat, msg(t.id, chatId, mara.id, ago(t.at), t.text), [
      [assistantId, ago(t.reply.at), t.reply.text, { card: t.reply.card, attachments: t.reply.attachments }],
    ]);
  }

  /**
   * Tonight's server work (AP-4306): Mara's ask, Neo's answer, then a task card per job as the runtime posts them — its
   * text the card's line for an app without the card (CT-884). The-falcon's updates end after `taskEndMs`.
   */
  function taskThread() {
    const made = now().getTime();
    const ago = (minutes: number) => new Date(made - minutes * 60_000).toISOString();
    const root = msg(
      CHAT_ROOTS.tasks,
      chatId,
      mara.id,
      ago(62),
      'Can you install the updates on thetitan and the-falcon, and back up the guests on pve-01 and pve-02?',
    );
    const card = (
      id: string,
      serverId: string,
      title: string,
      state: TaskCard['state'],
      startedAt: string,
      ended: { at: string; result: string } | null,
    ): [string, string, string, Partial<Message>] => {
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
      const text = taskCardLine({ ...task, state: 'running', endedAt: null, result: null }, startedAt);
      return [assistantId, startedAt, text, { card: task }];
    };
    thread(chat, root, [
      [assistantId, ago(61), 'On it. I’ll do them one at a time and tell you here how each one went.'],
      card('thetitan0upd', 'thetitan', 'Installing 23 updates on thetitan', 'ok', ago(61), {
        at: ago(57),
        result: 'thetitan is up to date: 23 updates installed. It needs a restart to finish.',
      }),
      [
        assistantId,
        ago(57),
        'thetitan has its 23 updates. It needs a restart to finish them. Shall I restart it tonight at 03:00?',
      ],
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
    ]);
    // The runtime ends the task: the card changes in place on its message, out to the room (TF-10, CT-880).
    options.setTimer(() => {
      const list = chat.replies.get(CHAT_ROOTS.tasks) ?? [];
      const at = list.findIndex((m) => m.card?.kind === 'task' && m.card.state === 'running');
      const running = list[at];
      if (running?.card?.kind !== 'task') return;
      const next: Message = {
        ...running,
        card: {
          ...running.card,
          state: 'ok',
          endedAt: now().toISOString(),
          result: 'the-falcon is up to date: 4 updates installed.',
        },
      };
      chat.replies.set(
        CHAT_ROOTS.tasks,
        list.map((m, i) => (i === at ? next : m)),
      );
      emit(`conv:${chatId}`, { type: 'message.updated', message: next });
    }, options.taskEndMs ?? 30_000);
  }

  /**
   * Two one-time Find My watches (findmy-watch.md), each in the thread of Mara's ask: Noor's still watching (its card
   * with Cancel), Ruben's happened (its card one line, and what Whombat posted when it saw it).
   */
  function watchThreads() {
    const made = now().getTime();
    const ago = (minutes: number) => new Date(made - minutes * 60_000).toISOString();
    const later = (minutes: number) => new Date(made + minutes * 60_000).toISOString();
    const noor: FindMyWatchView = {
      id: 'fmw_noor',
      name: 'Noor Visser',
      change: 'leaves',
      place: 'Keizersgracht',
      status: 'watching',
      startedAt: ago(20),
      endsAt: later(24 * 60 - 20),
      endedAt: null,
      to: null,
    };
    const ruben: FindMyWatchView = {
      id: 'fmw_ruben',
      name: 'Ruben Dekker',
      change: 'arrives',
      place: 'Home',
      status: 'happened',
      startedAt: ago(140),
      endsAt: later(24 * 60 - 140),
      endedAt: ago(45),
      to: 'Home',
    };
    const card = (w: FindMyWatchView): Partial<Message> => ({
      card: { kind: 'findmy_watch', watchId: w.id, watch: w },
    });
    thread(
      chat,
      msg(CHAT_ROOTS.watchNoor, chatId, mara.id, ago(21), 'Tell me when Noor leaves where she is now'),
      [[assistantId, noor.startedAt, findMyWatchStartText(noor), card(noor)]],
    );
    thread(chat, msg(CHAT_ROOTS.watchRuben, chatId, mara.id, ago(141), 'Tell me when Ruben gets home'), [
      [assistantId, ruben.startedAt, findMyWatchStartText(ruben), card(ruben)],
      [assistantId, ruben.endedAt ?? ago(45), findMyWatchEndText(ruben) ?? ''],
    ]);
  }

  /** The watch card's Cancel: the watch cancelled on its message, out to the room; one that ended answers as it is. */
  function cancelWatch(watchId: string): FindMyWatchView | null {
    for (const [rootId, list] of chat.replies) {
      const i = list.findIndex((m) => m.card?.kind === 'findmy_watch' && m.card.watchId === watchId);
      const was = list[i];
      if (was?.card?.kind !== 'findmy_watch' || !was.card.watch) continue;
      const watch = was.card.watch;
      if (watch.status !== 'watching') return watch;
      const next: FindMyWatchView = { ...watch, status: 'cancelled', endedAt: now().toISOString() };
      const message: Message = { ...was, card: { ...was.card, watch: next } };
      chat.replies.set(
        rootId,
        list.map((m, j) => (j === i ? message : m)),
      );
      emit(`conv:${chatId}`, { type: 'message.updated', message });
      return next;
    }
    return null;
  }

  const feedback: RoomState = {
    room: 'feedback',
    conversation: options.dm(FEEDBACK_ROOM_ID, 'Feedback', at('12:40')),
    roots: [],
    replies: new Map(),
  };
  thread(
    feedback,
    msg(
      CHAT_ROOTS.contact,
      FEEDBACK_ROOM_ID,
      assistantId,
      at('09:12'),
      'New feedback from lumio.example.org: “The contact form doesn’t send on my phone.”',
    ),
    [
      [
        assistantId,
        at('09:20'),
        'I tried it on a small screen: the Send button sits under the cookie banner. I’ve opened an issue for it.',
      ],
    ],
  );
  thread(
    feedback,
    msg(
      CHAT_ROOTS.pricing,
      FEEDBACK_ROOM_ID,
      assistantId,
      at('12:40'),
      'New feedback from lumio.example.org: “The prices on the plans page are without VAT, that wasn’t clear to me.”',
    ),
  );
  rooms.set(FEEDBACK_ROOM_ID, feedback);

  /* Reading ---------------------------------------------------------------------------------------------------- */

  const lastAt = (room: RoomState, root: Message) =>
    room.replies.get(root.id)?.at(-1)?.createdAt ?? root.createdAt;
  /** A thread's first message as the room lists it: its replies counted, the last three repliers, the last reply. */
  const counted = (room: RoomState, root: Message): Message => {
    const replies = room.replies.get(root.id) ?? [];
    const repliers: string[] = [];
    for (const r of [...replies].reverse()) if (!repliers.includes(r.authorId)) repliers.push(r.authorId);
    return {
      ...root,
      replyCount: replies.length,
      lastReplyAt: replies.at(-1)?.createdAt ?? null,
      threadParticipantIds: repliers.slice(0, 3),
      settled: settled.get(root.id) ?? null,
    };
  };
  /**
   * Work handed over from the thread goes on (delegate.md): a council at work, or a delegation's tasks handed over
   * and not over yet. It doesn't settle until that ends.
   */
  const handedOverIn = (room: RoomState, rootId: string) =>
    (room.replies.get(rootId) ?? []).some(
      (m) =>
        (m.card?.kind === 'council' && m.card.live) ||
        (m.card?.kind === 'delegation' && m.card.live && m.card.stage !== 'offer'),
    );
  /** Something in the thread waits for Mara (CHS-03): pve-02's yes, the heat pump's choice, the feature request. */
  const waitingIn = (rootId: string) =>
    (rootId === CHAT_ROOTS.memory && zfsPending) ||
    (rootId === CHAT_ROOTS.heat && !options.heat().decided) ||
    (rootId === CHAT_ROOTS.feature && feature.state === 'waiting');
  const roomOfRoot = (rootId: string) => [...rooms.values()].find((r) => r.replies.has(rootId)) ?? null;
  /** A thread's messages, its first one first. */
  const messagesOf = (room: RoomState, rootId: string): Message[] => {
    const root = room.roots.find((r) => r.id === rootId);
    return root ? [root, ...(room.replies.get(rootId) ?? [])] : [];
  };
  /** What is new to Mara in a thread: messages by someone else after what she read (TU-01). */
  const unreadIn = (room: RoomState, rootId: string): number => {
    const all = messagesOf(room, rootId);
    return all
      .slice(readCount.get(rootId) ?? all.length)
      .filter((m) => m.authorId !== mara.id && !m.deletedAt).length;
  };
  /** The room's badge: its open threads with something new (TU-03). */
  const roomUnread = (room: RoomState): number =>
    room.roots.filter((r) => !settled.has(r.id) && unreadIn(room, r.id) > 0).length;
  /** Reads a thread up to `count` of its messages; never back, unless `back` (Mark as unread, CIB-06). */
  const readTo = (rootId: string, count: number, back = false) => {
    const before = readCount.get(rootId) ?? 0;
    readCount.set(rootId, back ? count : Math.max(before, count));
  };
  /** Mara's badge for the room on her devices, which also asks which threads are new again. */
  const unreadFrame = (room: RoomState) =>
    emit(meTopic, {
      type: 'conversation.unread',
      conversationId: room.conversation.id,
      unread: roomUnread(room),
      mentions: 0,
    });
  /** The newest reply with words or files, as the inbox's row shows it (CIB-03). */
  const lastOf = (room: RoomState, rootId: string): ChatThreadLast | null => {
    for (const m of [...(room.replies.get(rootId) ?? [])].reverse()) {
      const last = lastOfMessage(m);
      if (last) return last;
    }
    return null;
  };
  const conversationOf = (room: RoomState): Conversation => {
    const last =
      room.roots
        .map((r) => lastAt(room, r))
        .sort()
        .at(-1) ?? null;
    return room.room === 'chat'
      ? { ...options.chat(), lastMessageAt: last }
      : { ...room.conversation, lastMessageAt: last };
  };
  const summary = (room: RoomState): ChatSummary => {
    const c = conversationOf(room);
    const last = [...room.roots].sort((a, b) => lastAt(room, a).localeCompare(lastAt(room, b))).at(-1);
    return {
      id: c.id,
      title: room.room === 'chat' ? c.title : 'Feedback',
      subject: null,
      lastAt: c.lastMessageAt,
      ...(last ? { lastText: last.text.slice(0, 200) } : {}),
      unread: roomUnread(room),
      default: room.room === 'chat',
      archivedAt: null,
      room: room.room,
    };
  };
  const threadOf = (room: RoomState, root: Message): ChatThread => {
    const last = lastOf(room, root.id);
    return {
      conversationId: room.conversation.id,
      room: room.room,
      rootId: root.id,
      authorId: root.authorId,
      text: root.text.slice(0, 200),
      subject: root.subject ?? null,
      createdAt: root.createdAt,
      replyCount: room.replies.get(root.id)?.length ?? 0,
      lastAt: lastAt(room, root),
      working: working.has(root.id),
      settled: settled.get(root.id) ?? null,
      waiting: waitingIn(root.id),
      ...(last ? { last } : {}),
      ...(repos.has(root.id) ? { repo: repos.get(root.id) } : {}),
      handedOver:
        handedOverIn(room, root.id) || handoffs.some((h) => h.rootId === root.id && h.state !== 'ended'),
      ...(room.room === 'chat' ? { work: works.get(root.id) ?? null } : {}),
    };
  };

  /* Writing ---------------------------------------------------------------------------------------------------- */

  const topic = (room: RoomState) => `conv:${room.conversation.id}`;
  /** A reply in a thread, out to the room, and the thread's first message as it reads now. */
  const reply = (
    room: RoomState,
    rootId: string,
    authorId: string,
    text: string,
    clientId: string | null,
    extra: Partial<Message> = {},
  ) => {
    const root = room.roots.find((r) => r.id === rootId);
    if (!root) return null;
    const m = msg(null, room.conversation.id, authorId, now().toISOString(), text, {
      threadRootId: rootId,
      clientId,
      ...extra,
    });
    room.replies.set(rootId, [...(room.replies.get(rootId) ?? []), m]);
    // A new message opens a settled thread again and clears an Open again by hand (CHS-04).
    const reopened = settled.delete(rootId);
    keptOpen.delete(rootId);
    // Writing in a thread reads it (TU-02); anyone else's message is new to Mara.
    if (authorId === mara.id) readTo(rootId, messagesOf(room, rootId).length);
    emit(topic(room), { type: 'message.created', message: m });
    emit(topic(room), { type: 'message.updated', message: counted(room, root) });
    if (reopened) settledFrame(room, rootId, null);
    if (authorId !== mara.id) unreadFrame(room);
    return m;
  };
  /** `chat.settled` to Mara's devices (topic `me`). */
  const settledFrame = (room: RoomState, rootId: string | null, value: ThreadSettle | null) =>
    emit(meTopic, {
      type: 'chat.settled',
      conversationId: room.conversation.id,
      room: room.room,
      rootId,
      settled: value,
    });
  /** Why a thread can't settle now, in the server's words (CHS-03); null when it can. */
  const refusal = (rootId: string): string | null => {
    const room = roomOfRoot(rootId);
    if (working.has(rootId) || (room && handedOverIn(room, rootId)))
      return `${options.assistantName()} is still working on this.`;
    if (waitingIn(rootId)) return 'This thread waits for your answer.';
    return null;
  };
  /** Neo answers in the thread: thinking first, then the reply (CHT-02). */
  const answer = (room: RoomState, rootId: string, text: string) => {
    working.add(rootId);
    emit(topic(room), {
      type: 'typing',
      conversationId: room.conversation.id,
      threadRootId: rootId,
      principalId: assistantId,
      active: true,
      expiresAt: new Date(now().getTime() + options.replyDelayMs + 4000).toISOString(),
    });
    options.setTimer(() => {
      working.delete(rootId);
      // In Chat a reply says what answered it: the thread's choice as it is now, else Neo's (CR-07).
      reply(
        room,
        rootId,
        assistantId,
        text,
        null,
        room.room === 'chat' ? { ranOn: runtime.ranOn(rootId) } : {},
      );
    }, options.replyDelayMs);
  };
  /** A new thread: its first message, out to the room; Neo answers in it. */
  const start = (
    room: RoomState,
    text: string,
    subject: ChatSubject | null,
    clientId: string | null,
    choice: ChatRuntime | null = null,
  ) => {
    const root = msg(null, room.conversation.id, mara.id, now().toISOString(), text, {
      clientId,
      ...(subject ? { subject } : {}),
    });
    room.roots.push(root);
    room.replies.set(root.id, []);
    readCount.set(root.id, 1);
    // What the box chose for the new thread, before Neo is woken (CR-02, CT-469).
    if (choice && room.room === 'chat') runtime.set(root.id, choice);
    emit(topic(room), { type: 'message.created', message: root });
    answer(
      room,
      root.id,
      subject
        ? `I’m looking at ${subject.name} now. I’ll tell you what I find.`
        : 'On it. I’ll tell you what I find.',
    );
    return root;
  };

  /** Puts the heat pump's card, as decided, on its message (`message.updated`). */
  function setHeat(card: DeviceSkillCard) {
    for (const room of rooms.values())
      for (const [rootId, list] of room.replies) {
        const at = list.findIndex((m) => m.card?.kind === 'device_skill');
        if (at < 0) continue;
        const next = { ...(list[at] as Message), card };
        room.replies.set(
          rootId,
          list.map((m, i) => (i === at ? next : m)),
        );
        emit(topic(room), { type: 'message.updated', message: next });
      }
  }

  // Every thread not listed in `readCount` starts read to its end.
  for (const room of rooms.values())
    for (const root of room.roots)
      if (!readCount.has(root.id)) readCount.set(root.id, messagesOf(room, root.id).length);

  return {
    setHeat,
    /**
     * A thread of Chat Neo starts with an Inbox item's words (*Talk to Neo about it*, `needsYou.discuss`): no answer
     * follows until Mara writes. The Chat and its first message, as `chats.start` answers.
     */
    discussInChat: (text: string, subject: ChatSubject | null) => {
      const root = msg(null, chat.conversation.id, assistantId, now().toISOString(), text, {
        clientId: null,
        ...(subject ? { subject } : {}),
      });
      chat.roots.push(root);
      chat.replies.set(root.id, []);
      readCount.set(root.id, 0);
      emit(topic(chat), { type: 'message.created', message: root });
      unreadFrame(chat);
      return { conversation: conversationOf(chat), message: root };
    },
    /** A reply in a thread of Chat, out to the room (a look's go-ahead and Neo's word on it). */
    replyInChat: (rootId: string, authorId: string, text: string) => {
      reply(chat, rootId, authorId, text, null);
    },
    /** Whether Neo is working in a thread of Chat (`working`). */
    setWorking: (rootId: string, on: boolean) => {
      if (on) working.add(rootId);
      else working.delete(rootId);
    },
    /** Mara's two rooms with the agent as the sidebar lists them: Chat, then Feedback (OA-04). */
    summaries: (): ConversationSummary[] =>
      [chat, feedback].map((room) => options.summaryOf(conversationOf(room))),
    /** What answers in Chat: “Make this Neo’s default” and Runs on's `host.agents` (AP-2732). */
    runtime,
    /** Where the heat pump's thread opens (Needs you's Choose, its page's “Open the chat”). */
    heatHref: `/chat?thread=${CHAT_ROOTS.heat}`,
    /** The answer for a request about Chat or Feedback, or null. */
    async handle(
      id: string,
      params: Record<string, string>,
      init: RequestInit | undefined,
      url: URL,
    ): Promise<Response | null> {
      const room = rooms.get(params.conversationId ?? '');
      switch (id) {
        case 'chats.list': {
          // After the fresh start (CHT-04): the two rooms; the old task chats are archived.
          if (['true', '1'].includes(url.searchParams.get('archived') ?? '')) return json({ chats: [] });
          return json({ chats: [chat, feedback].map(summary) });
        }
        case 'chats.threads': {
          const which = (url.searchParams.get('room') ?? 'chat') === 'feedback' ? feedback : chat;
          const kind = url.searchParams.get('subjectKind');
          const subjectId = url.searchParams.get('subjectId');
          const before = url.searchParams.get('before');
          const state = url.searchParams.get('state');
          const limit = Math.min(Number(url.searchParams.get('limit') ?? 30) || 30, 50);
          // The settled ones page by when they settled, the rest by their last activity (CHS-10).
          const order = (t: ChatThread) => (state === 'settled' ? (t.settled?.at ?? '') : t.lastAt);
          // The subject says which threads; the state which of them, and the count is of those settled.
          const here = which.roots
            .map((r) => threadOf(which, r))
            .filter((t) => !kind || (t.subject?.kind === kind && t.subject.id === subjectId));
          const all = here
            .filter((t) => (state === 'open' ? !t.settled : state === 'settled' ? !!t.settled : true))
            .filter((t) => !before || order(t) < before)
            .sort((a, b) => order(b).localeCompare(order(a)));
          const page = all.slice(0, limit);
          return json({
            threads: page,
            next: all.length > limit ? (page.at(-1) ? order(page.at(-1) as ChatThread) : null) : null,
            ...(before ? {} : { settledCount: here.filter((t) => t.settled).length }),
          });
        }
        case 'connections.findMyWatchCancel': {
          const watch = cancelWatch(params.watchId ?? '');
          return watch ? json(watch) : notFound('No such watch');
        }
        case 'chats.place': {
          // An older app moving a thread: every thread stays in Chat, so it answers the thread as it is.
          const root = chat.roots.find((r) => r.id === (params.rootId ?? ''));
          if (!root) return notFound('No such thread in your Chat');
          return json({ thread: threadOf(chat, root) });
        }
        case 'conversations.handoffs': {
          if (params.conversationId !== chatId) return null;
          return json({ conversationId: chatId, handoffs });
        }
        // A job's question answered or a message sent from the job (job-view.md): the job goes back to work.
        case 'conversations.handoffAnswer':
        case 'conversations.handoffSend': {
          if (params.conversationId !== chatId) return null;
          const body = await bodyOf<{ handoffId: string }>(init);
          const at = handoffs.findIndex((h) => h.id === body.handoffId);
          const was = handoffs[at];
          if (!was) return notFound('No such job');
          if (was.state === 'asked') handoffs[at] = { ...was, state: 'working', asks: null, question: null };
          emit(`conv:${chatId}`, { type: 'conversation.handoffs', conversationId: chatId, handoffs });
          return json({ conversationId: chatId, handoffs });
        }
        case 'chats.settle': {
          const rootId = params.rootId ?? '';
          const of = roomOfRoot(rootId);
          const root = of?.roots.find((r) => r.id === rootId);
          if (!of || !root) return notFound('No such thread in your Chat or Feedback');
          const body = await bodyOf<{ settled: boolean }>(init);
          if (body.settled) {
            const why = settled.has(rootId) ? null : refusal(rootId);
            if (why) return json({ error: { code: 'conflict', message: why } }, 409);
            if (!settled.has(rootId)) settled.set(rootId, { at: now().toISOString(), how: 'person' });
            keptOpen.delete(rootId);
            // Settling by hand reads it to its end (TU-02).
            readTo(rootId, messagesOf(of, rootId).length);
          } else {
            settled.delete(rootId);
            keptOpen.add(rootId);
          }
          const value = settled.get(rootId) ?? null;
          settledFrame(of, rootId, value);
          emit(topic(of), { type: 'message.updated', message: counted(of, root) });
          // A settled thread counts for nothing in the badge (TU-02).
          unreadFrame(of);
          return json({ thread: threadOf(of, root) });
        }
        case 'me.getPreferences':
          return json(preferences);
        case 'me.updatePreferences': {
          const body = await bodyOf<Partial<Preferences> & { chat?: ChatPreferences }>(init);
          preferences = { ...preferences, ...body };
          return json(preferences);
        }
        case 'chats.settleFinished': {
          const body = await bodyOf<{ room?: ChatRoom; onlyRead?: boolean }>(init);
          const which = body.room === 'feedback' ? feedback : chat;
          let count = 0;
          for (const r of which.roots) {
            if (settled.has(r.id) || refusal(r.id)) continue;
            // Settle everything read leaves what is new to Mara (CIB-07).
            if (body.onlyRead && unreadIn(which, r.id) > 0) continue;
            settled.set(r.id, { at: now().toISOString(), how: 'person' });
            keptOpen.delete(r.id);
            readTo(r.id, messagesOf(which, r.id).length);
            count += 1;
          }
          if (count) {
            settledFrame(which, null, null);
            unreadFrame(which);
          }
          return json({ room: which.room, conversationId: which.conversation.id, settled: count });
        }
        case 'chats.unread': {
          // The open threads with something new, newest activity first (TU-04).
          const which = (url.searchParams.get('room') ?? 'chat') === 'feedback' ? feedback : chat;
          const threads = which.roots
            .filter((r) => !settled.has(r.id))
            .map((r) => ({ rootId: r.id, unread: unreadIn(which, r.id), at: lastAt(which, r) }))
            .filter((t) => t.unread > 0)
            .sort((a, b) => b.at.localeCompare(a.at))
            .map(({ rootId, unread }) => ({ rootId, unread }));
          return json({ conversationId: which.conversation.id, threads });
        }
        case 'chats.readThread':
        case 'chats.markUnread': {
          const rootId = params.rootId ?? '';
          const of = roomOfRoot(rootId);
          if (!of) return notFound('No such thread in your Chat or Feedback');
          const all = messagesOf(of, rootId);
          if (id === 'chats.readThread') {
            const body = await bodyOf<{ messageId: string }>(init);
            const at = all.findIndex((m) => m.id === body.messageId);
            if (at < 0) return notFound('No such message in this thread');
            readTo(rootId, at + 1);
          } else {
            // Back to just before the newest message someone else wrote, which counts as new again (CIB-06).
            let at = -1;
            all.forEach((m, i) => {
              if (m.authorId !== mara.id && !m.deletedAt) at = i;
            });
            if (at >= 0) readTo(rootId, at, true);
          }
          unreadFrame(of);
          return json({
            conversationId: of.conversation.id,
            rootId,
            unread: unreadIn(of, rootId),
            roomUnread: roomUnread(of),
          });
        }
        case 'chats.start': {
          const body = await bodyOf<{ text: string; subject?: ChatSubject; runtime?: ChatRuntime }>(init);
          const root = start(chat, body.text, body.subject ?? null, null, body.runtime ?? null);
          return json({ conversation: conversationOf(chat), message: root }, 201);
        }
        case 'chats.runtime':
          return json(runtime.view(url.searchParams.get('thread')));
        case 'chats.setThreadRuntime': {
          const rootId = params.rootId ?? '';
          if (!chat.replies.has(rootId)) return notFound('No such thread in your Chat');
          const body = await bodyOf<{ runtime: ChatRuntime | null }>(init);
          return json({ thread: runtime.set(rootId, body.runtime) });
        }
        case 'conversations.get': {
          if (!room) return null;
          const conversation = conversationOf(room);
          const detail: ConversationDetail = {
            conversation,
            summary: options.summaryOf(conversation),
            pr: null,
            lastReadMessageId: null,
          };
          return json(detail);
        }
        case 'messages.list':
          if (!room) return null;
          if (url.searchParams.has('before')) return json({ messages: [], before: null, hasMore: false });
          return json({ messages: room.roots.map((r) => counted(room, r)), before: null, hasMore: false });
        case 'messages.thread': {
          const of = roomOfRoot(params.messageId ?? '');
          const root = of?.roots.find((r) => r.id === params.messageId);
          if (!of || !root) return null;
          return json({
            root: counted(of, root),
            replies: of.replies.get(root.id) ?? [],
            conversationId: of.conversation.id,
            where: of.room === 'chat' ? 'Chat' : 'Feedback',
            topic: null,
            more: null,
          });
        }
        case 'messages.send': {
          if (!room) return null;
          const body = await bodyOf<{
            text: string;
            threadRootId?: string | null;
            clientId?: string;
            runtime?: ChatRuntime;
          }>(init);
          const clientId = body.clientId ?? null;
          if (body.threadRootId) {
            const sent = reply(room, body.threadRootId, mara.id, body.text, clientId);
            if (!sent) return notFound('No such thread');
            answer(room, body.threadRootId, 'Got it. I’ll come back to you here.');
            return json({ message: sent, dispatches: [] }, 201);
          }
          return json(
            { message: start(room, body.text, null, clientId, body.runtime ?? null), dispatches: [] },
            201,
          );
        }
        case 'tracker.decide': {
          // Mara's answer to the feature request: the card changes on its message, as the runtime re-sends it.
          if (params.requestId !== FEATURE_REQUEST_ID) return notFound('Feature request');
          if (feature.state !== 'waiting')
            return json(
              {
                error: {
                  code: 'conflict',
                  message: 'This feature request isn’t waiting for an answer any more.',
                },
              },
              409,
            );
          const body = await bodyOf<{ choice: FeatureDecisionChoice; note?: string }>(init);
          const note = body.note?.trim() || null;
          if (body.choice === 'ask' && !note)
            return json(
              { error: { code: 'validation_failed', message: 'Write what you want to ask the customer.' } },
              422,
            );
          const words = body.choice === 'approve' || body.choice === 'build' ? null : note;
          feature = {
            ...feature,
            state: 'decided',
            choice: body.choice,
            // The agent's own reason, unchanged, isn't the person's note.
            note: body.choice === 'decline' && words === feature.declineReason ? null : words,
            decidedById: mara.id as FeatureRequestView['decidedById'],
            decidedAt: now().toISOString(),
          };
          const list = chat.replies.get(CHAT_ROOTS.feature) ?? [];
          chat.replies.set(
            CHAT_ROOTS.feature,
            list.map((m) => {
              if (m.card?.kind !== 'feature_request') return m;
              const next: Message = { ...m, card: { ...m.card, request: feature } };
              emit(topic(chat), { type: 'message.updated', message: next });
              return next;
            }),
          );
          return json({ request: feature });
        }
        case 'messages.jobAnswers': {
          // The person's answers to a job's result (job-result.md): kept on the message as sent, T3 Code on them.
          for (const [rootId, list] of chat.replies) {
            const at = list.findIndex((m) => m.id === params.messageId);
            const found = list[at];
            if (!found) continue;
            const result = found.jobResult;
            if (!result) return notFound('No job result');
            if (result.sends.at(-1)?.doneAt === null)
              return json(
                { error: { code: 'conflict', message: 'T3 Code is still on your last answers.' } },
                409,
              );
            const body = await bodyOf<JobAnswersBody>(init);
            const send = { at: now().toISOString(), answers: body.answers, doneAt: null, outcome: null };
            const next: Message = {
              ...found,
              jobResult: { ...result, sends: [...result.sends, send].slice(-JOB_RESULT_SENDS_MAX) },
            };
            chat.replies.set(
              rootId,
              list.map((m, i) => (i === at ? next : m)),
            );
            emit(topic(chat), { type: 'message.updated', message: next });
            return json({ message: next });
          }
          return null;
        }
        case 'councils.stop': {
          // A council's Stop: its card changes on its message, as the server re-sends it (council.md).
          const body = await bodyOf<{ councilId: string }>(init);
          for (const [rootId, list] of chat.replies) {
            const at = list.findIndex(
              (m) => m.card?.kind === 'council' && m.card.councilId === body.councilId,
            );
            const found = list[at];
            if (found?.card?.kind !== 'council') continue;
            const pressed = councilPress(found.card, now().toISOString());
            if (!('card' in pressed))
              return json({ error: { code: 'conflict', message: pressed.message } }, pressed.status);
            const next: Message = { ...found, card: pressed.card };
            chat.replies.set(
              rootId,
              list.map((m, i) => (i === at ? next : m)),
            );
            emit(topic(chat), { type: 'message.updated', message: next });
            return json({ councilId: pressed.card.councilId, stage: pressed.card.stage });
          }
          return notFound('No such council');
        }
        case 'delegations.models':
          // What T3 Code runs here, to choose a checklist task's AI from.
          return json({ options: DELEGATION_AI_OPTIONS, t3: 'ready' } satisfies DelegationModelsResponse);
        case 'delegations.pick':
        case 'delegations.setAi':
        case 'delegations.start':
        case 'delegations.stopTask':
        case 'delegations.stop': {
          // The delegation card's buttons: its card changes on its message, as the server re-sends it (delegate.md).
          const body = await bodyOf<{
            delegationId: string;
            taskId?: string;
            picked?: boolean;
            ai?: DelegationAiChoice | null;
          }>(init);
          const press: DelegationPress =
            id === 'delegations.pick'
              ? { op: 'pick', taskId: body.taskId ?? '', picked: body.picked === true }
              : id === 'delegations.setAi'
                ? { op: 'setAi', taskId: body.taskId ?? null, ai: body.ai ?? null }
                : id === 'delegations.stopTask'
                  ? { op: 'stopTask', taskId: body.taskId ?? '' }
                  : id === 'delegations.start'
                    ? { op: 'start' }
                    : { op: 'stop' };
          for (const [rootId, list] of chat.replies) {
            const at = list.findIndex(
              (m) => m.card?.kind === 'delegation' && m.card.delegationId === body.delegationId,
            );
            const found = list[at];
            if (found?.card?.kind !== 'delegation') continue;
            const pressed = delegationPress(found.card, press, now().toISOString());
            if (!('card' in pressed))
              return json(
                {
                  error: {
                    code:
                      pressed.status === 404
                        ? 'not_found'
                        : pressed.status === 400
                          ? 'validation_failed'
                          : 'conflict',
                    message: pressed.message,
                  },
                },
                pressed.status,
              );
            const next: Message = { ...found, card: pressed.card };
            chat.replies.set(
              rootId,
              list.map((m, i) => (i === at ? next : m)),
            );
            emit(topic(chat), { type: 'message.updated', message: next });
            return json(pressed.response);
          }
          return notFound('No such delegation');
        }
        case 'approvals.get':
          if (Number(params.number) !== ZFS_APPROVAL) return null;
          return json({ approval: zfs('pending'), eventId: null });
        case 'approvals.decide': {
          if (Number(params.number) !== ZFS_APPROVAL) return null;
          const body = await bodyOf<{ decision: 'approve' | 'decline'; executeAt?: string }>(init);
          const decided = zfs(body.decision === 'approve' ? 'approved' : 'declined', body.executeAt ?? null);
          zfsPending = false;
          const list = chat.replies.get(CHAT_ROOTS.memory) ?? [];
          chat.replies.set(
            CHAT_ROOTS.memory,
            list.map((m) => {
              if (m.card?.kind !== 'approval') return m;
              const next = { ...m, card: { kind: 'approval' as const, approval: decided } };
              emit(topic(chat), { type: 'message.updated', message: next });
              return next;
            }),
          );
          return json({ approval: decided, eventId: null });
        }
      }
      return null;
    },
  };
}
