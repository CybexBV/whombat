/**
 * The one-Whombat world for fixture mode (app docs/decisions/one-whombat-shell.md AP-1278; one-agent.md AP-4921): the
 * Whombat's one agent — the shared world's agent, which Mara renamed Neo and gave Neo's face (OA-08) — whose name and
 * face `agent.update` changes as the server does (reserved or malformed names refused), and
 * everything the shell reads — Home (`home.overview`), Watch, Needs you snoozes and ignores, Done recently
 * with Undo, a pinned heat pump widget, task chats with their messages and the heat pump's `device_skill` card, Approve
 * later on the restart approval — as mock 1 and mock 3 draw them. Served in every fixture world.
 *
 * Times keep the mock's clock positions on the day the world is made (“10:12”, “13:41”, “3 d ago”), so a run at any
 * date reads like the mock; the visual checks freeze the clock at 14:05.
 */
import { createOverviewFixtures, localAt, tomorrowMorning } from '@whombat/client';
import { findMyConnectionThing, macFixtureListed } from '@whombat/client/hosts/fixtures';
import {
  type Agent,
  type AgentProfile,
  type Approval,
  type AutomationToday,
  type Bootstrap,
  type ChangeEntry,
  type ChatSubject,
  type ChatSummary,
  type Conversation,
  type ConversationDetail,
  type ConversationSummary,
  chatTitleFrom,
  type DeviceActionChoice,
  type DeviceSkillCard,
  type Grant,
  type GrantInput,
  type HomeChat,
  type HomeOverview,
  type HomeRef,
  type HomeSeverity,
  type Message,
  type MessageCard,
  type NeedsYouItem,
  needsYouCount,
  needsYouGroupOf,
  type OverviewLayout,
  osMark,
  type Plan,
  type ThingSummary,
  thingHref,
  type WatchItem,
  type Widget,
} from '@whombat/core';
import {
  AGENT_FACES,
  AGENT_NAME_FORM_TEXT,
  AGENT_NAME_PATTERN,
  AGENT_NAME_RESERVED_TEXT,
  type AgentFace,
  type AgentModelRuntimeUpdate,
  isReservedAgentName,
  resolveAgentModelRuntime,
} from '@whombat/core/domain';
import { agentDefaultGrants, describeGrantChange, diffGrants } from '@whombat/core/keys';
import { burrow, cnv_dm_dusty, deployApproval, dusty, mara, withServiceThings } from '@whombat/fixtures';
import {
  FIRST_DAY_ROOT_ID,
  type FirstDayFixture,
  firstDayBackupItem,
  firstDayWelcome,
} from './firstDayFixtures';

const API = '/api/v1';
const B = `${API}/burrows/${burrow.slug}`;
const TZ = 'Europe/Amsterdam';

/**
 * The Whombat's one agent is the shared world's (`dusty`): every message, run, approval and plan of that world is its.
 * Mara renamed it Neo and gave it Neo's face (OA-08), as the mocks draw it.
 */
export const WHOMBAT_ID = dusty.id;
export const WHOMBAT_HANDLE = 'neo';
export const ASSISTANT_NAME = 'Neo';
export const ASSISTANT_FACE: AgentFace = 'neo';
/** Mara's Chat with the agent: the shared world's (`cnv_dm-dusty`), whose messages this world draws as the mock. */
export const DEFAULT_CHAT_ID = cnv_dm_dusty.id;
export const HEAT_CHAT_ID = 'cnv_chat-heat-pump';
export const PVE_CHAT_ID = 'cnv_chat-pve-02';
export const MAIL_CHAT_ID = 'cnv_chat-customer-mail';
export const RESTART_APPROVAL = 901;
export const HEAT_PROPOSAL = 'dvp_heat-pump';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function notFound(message: string): Response {
  return json({ error: { code: 'not_found', message } }, 404);
}

/** Deterministic noise in [0, 1) (the mock's generator). */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

/** The mock's heat pump day: room, water to the radiators and outside, every 15 minutes since midnight. */
function heatPumpPoints(now: number): Widget['points'] {
  const start = Date.parse(localAt(now, TZ, '00:00', 0));
  const from = now - start < 6 * 3_600_000 ? now - 24 * 3_600_000 : start;
  const step = 15 * 60_000;
  const n = Math.max(2, Math.floor((now - from) / step) + 1);
  const r1 = rng(3);
  const r2 = rng(5);
  const r3 = rng(9);
  const room = (t: number) =>
    t < 0.25 ? 0.1 : t < 0.35 ? (t - 0.25) * 10 * 0.9 : 0.9 + 0.05 * Math.sin(t * 20);
  const water = (t: number) => 0.55 + 0.45 * Math.sin(t * 14) * (t > 0.3 ? 1 : 0.4);
  const outside = (t: number) => Math.sin((t - 0.25) * Math.PI);
  const points: Widget['points'] = [];
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1);
    const last = k === n - 1;
    points.push({
      t: new Date(from + k * step).toISOString(),
      values: {
        room: last ? 21 : round1(room(t) * 2.6 + 18.6 + (r1() - 0.5) * 2.6 * 0.35),
        water: last ? 34 : Math.round(water(t) * 12 + 26 + (r2() - 0.5) * 12 * 0.35),
        outside: last ? 9 : Math.max(1, Math.round(outside(t) * 6 + 4 + (r3() - 0.5) * 6 * 0.35)),
      },
    });
  }
  return points;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function message(
  over: Partial<Message> & Pick<Message, 'id' | 'conversationId' | 'authorId' | 'createdAt'>,
): Message {
  return {
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

export interface OneFixtures {
  handle(req: Request): Promise<Response | null>;
  /** Mara's assistant in the bootstrap (its name and face as saved), its default chat under DIRECT. */
  decorate(req: Request, response: Response): Promise<Response>;
  /** Her things as Home lists them now (the thing pages' world reads them, connection-pages.md CP-01). */
  things(): readonly ThingSummary[];
  /** A change made elsewhere in the world (a thing page's Restart, CP-12): newest first in Done recently. */
  addChange(change: ChangeEntry): void;
  /** The world's clock. */
  now(): number;
}

export function createOneFixtures(
  options: {
    now?: () => number;
    /** “Don’t ask again on pve-02” approved the restart and set pve-02 to Never (Whombat server-asks.md SA-07). */
    stopAsking?: (serverId: string) => void;
    /**
     * More things to list after hers, read at each answer (the service pages' Plex, Seerr, SABnzbd, Protect and Pi-hole,
     * service-dashboards.md AP-4571): their rows change as their buttons are pressed.
     */
    moreThings?: () => readonly ThingSummary[];
    /** A Whombat just claimed (Whombat first-day.md, `firstDayFixtures.ts`): only the welcome, nothing connected. */
    firstDay?: FirstDayFixture;
  } = {},
): OneFixtures {
  const clock = options.now ?? (() => Date.now());
  const made = clock();
  const at = (day: number, hhmm: string) => localAt(made, TZ, hhmm, day);

  /* The assistant and its chats -------------------------------------------------------------------- */

  /** Renamed and given another face through `agent.update` (OA-08). */
  let assistant: Agent = {
    ...dusty,
    name: ASSISTANT_NAME,
    handle: WHOMBAT_HANDLE,
    face: ASSISTANT_FACE,
    status: 'idle',
    doing: '',
  };

  interface Chat {
    conversation: Conversation;
    messages: Message[];
    unread: number;
  }
  const chats = new Map<string, Chat>();
  let seq = 0;
  const newId = (prefix: string) => `${prefix}_one-${++seq}`;

  function conversation(
    id: string,
    createdAt: string,
    chat: { title: string; subject?: ChatSubject | null } | null,
  ): Conversation {
    return {
      id: id as Conversation['id'],
      burrowId: burrow.id,
      kind: 'dm',
      slug: id,
      title: chat?.title ?? 'Chat',
      topic: '',
      actions: [],
      prNumber: null,
      repoId: null,
      createdAt,
      lastMessageAt: createdAt,
      chat: chat ? { title: chat.title, subject: chat.subject ?? null, archivedAt: null } : null,
    };
  }

  function addChat(c: Conversation, messages: Message[], unread = 0) {
    const last = messages.at(-1);
    chats.set(c.id, {
      conversation: { ...c, lastMessageAt: last?.createdAt ?? c.createdAt },
      messages,
      unread,
    });
  }

  const heatPlan: Plan = {
    id: 'pln_heat-pump' as Plan['id'],
    burrowId: burrow.id,
    title: 'Adding your Daikin heat pump',
    due: null,
    conversationId: HEAT_CHAT_ID as Plan['conversationId'],
    canvasId: null,
    canvasSlug: null,
    updatedAt: at(0, '13:41'),
    createdById: WHOMBAT_ID as Plan['createdById'],
    createdAt: at(0, '13:20'),
    source: null,
    messageId: 'msg_heat-steps' as Plan['messageId'],
    steps: (
      [
        ['Found its Modbus gateway on your network', '10.100.0.42, in the utility room’s network segment'],
        ['Home Assistant has no integration for this model', 'No ready-made tool either, so I’ll write one'],
        ['Found the list of readings in the installer manual', 'Page 41 of the PDF on Daikin’s site'],
        ['Read 9 values from your unit', 'They match what its display shows'],
      ] as const
    ).map(([title, note], i) => ({
      id: `stp_heat-${i + 1}` as Plan['steps'][number]['id'],
      title,
      state: 'done' as const,
      stateLabel: 'Done',
      runId: null,
      approvalId: null,
      automationRunId: null,
      dispatchId: null,
      note,
      updatedAt: at(0, '13:39'),
      refs: { runNumber: null, approvalNumber: null, automationRunNumber: null },
    })),
  };

  const heatCard: DeviceSkillCard = {
    kind: 'device_skill',
    proposalId: HEAT_PROPOSAL as DeviceSkillCard['proposalId'],
    name: 'Daikin Altherma heat pump',
    model: 'Altherma 3 H HT',
    readings: [
      { key: 'room', label: 'Room', value: '21.0', unit: '°C' },
      { key: 'water', label: 'Water to radiators', value: '34', unit: '°C' },
      { key: 'hot_water', label: 'Hot water', value: '48', unit: '°C' },
      { key: 'outside', label: 'Outside', value: '9', unit: '°C' },
      { key: 'power', label: 'Using', value: '1.2', unit: 'kW' },
      { key: 'mode', label: 'Mode', value: 'Heating' },
    ],
    moreReadings: 3,
    actions: [
      {
        key: 'room_temperature',
        label: 'Room temperature',
        description: 'Sets the room temperature the heat pump aims for.',
        proposed: { tier: 'can', limits: { min: 16, max: 24 } },
        valueType: 'number',
        min: 12,
        max: 28,
        unit: '°C',
      },
      {
        key: 'hot_water_boost',
        label: 'Hot water boost',
        description: 'On or off',
        proposed: { tier: 'ask' },
        valueType: 'boolean',
      },
      {
        key: 'heating_curve',
        label: 'Heating curve',
        description: 'The installer’s setting, change with care',
        proposed: { tier: 'off' },
        valueType: 'number',
        min: 0.2,
        max: 2,
        sensitive: true,
      },
    ],
    testedAt: at(0, '13:39'),
    status: 'proposed',
  };

  const person = mara.id;
  const bot = WHOMBAT_ID as Message['authorId'];
  addChat(conversation(DEFAULT_CHAT_ID, at(-6, '09:00'), null), [
    message({
      id: 'msg_whombat-hello' as Message['id'],
      conversationId: DEFAULT_CHAT_ID as Message['conversationId'],
      authorId: bot,
      createdAt: at(-6, '09:00'),
      text: `Hi Mara, I’m ${ASSISTANT_NAME}. Ask me to check, change or set up anything. Approvals and logins I need land here.`,
    }),
  ]);
  addChat(conversation(MAIL_CHAT_ID, at(-2, '08:10'), { title: 'Customer mail every morning' }), [
    message({
      id: 'msg_mail-1' as Message['id'],
      conversationId: MAIL_CHAT_ID as Message['conversationId'],
      authorId: person,
      createdAt: at(-2, '08:10'),
      text: 'Customer mail every morning\nCan you send me a summary of yesterday’s customer mail at 08:00?',
    }),
    message({
      id: 'msg_mail-2' as Message['id'],
      conversationId: MAIL_CHAT_ID as Message['conversationId'],
      authorId: bot,
      createdAt: at(-2, '08:12'),
      text: 'Done. You’ll get it here every morning at 08:00, starting tomorrow.',
    }),
  ]);
  addChat(
    conversation(PVE_CHAT_ID, at(0, '11:02'), {
      title: 'Why is pve-02 so warm?',
      subject: { kind: 'server', id: 'pve-02', name: 'pve-02' },
    }),
    [
      message({
        id: 'msg_pve-1' as Message['id'],
        conversationId: PVE_CHAT_ID as Message['conversationId'],
        authorId: person,
        createdAt: at(0, '11:02'),
        text: 'Why is pve-02 so warm?',
      }),
      message({
        id: 'msg_pve-2' as Message['id'],
        conversationId: PVE_CHAT_ID as Message['conversationId'],
        authorId: bot,
        createdAt: at(0, '11:04'),
        text: 'It’s been above 72 °C for 17 hours. The processor is only at 10 %, so it’s the room or the dust filter, not the work it does. Want me to tell you when it passes 80 °C?',
      }),
    ],
  );
  addChat(
    conversation(HEAT_CHAT_ID, at(0, '13:20'), {
      title: 'Add our heat pump',
      subject: { kind: 'device', id: 'con_heat-pump', name: 'Heat pump' },
    }),
    [
      message({
        id: 'msg_heat-ask' as Message['id'],
        conversationId: HEAT_CHAT_ID as Message['conversationId'],
        authorId: person,
        createdAt: at(0, '13:20'),
        text: 'We have a Daikin Altherma heat pump in the utility room. Can you add it, so I can see it and control it?',
      }),
      message({
        id: 'msg_heat-steps' as Message['id'],
        conversationId: HEAT_CHAT_ID as Message['conversationId'],
        authorId: bot,
        createdAt: at(0, '13:41'),
        text: 'It works. I checked what already exists first, then wrote a skill that only reads. Before I change anything, choose what I’m allowed to do.',
        card: { kind: 'plan', plan: heatPlan } as MessageCard,
      }),
      message({
        id: 'msg_heat-skill' as Message['id'],
        conversationId: HEAT_CHAT_ID as Message['conversationId'],
        authorId: bot,
        createdAt: at(0, '13:41'),
        card: heatCard,
      }),
    ],
  );

  /* Home ----------------------------------------------------------------------------------------- */

  const restart: Approval = {
    ...deployApproval(),
    id: 'apr_restart-nest' as Approval['id'],
    number: RESTART_APPROVAL,
    requesterId: WHOMBAT_ID as Approval['requesterId'],
    keyId: 'connections.write',
    action: {
      type: 'connection_call',
      params: {
        connectionId: 'con_servers',
        handle: 'servers',
        tool: 'guest_power',
        toolHash: 'a'.repeat(64),
        scope: 'shared',
        // It asks only for the Servers catalog's sensitive rules: you may stop asking on pve-02 (SA-07).
        server: { id: 'pve-02', name: 'pve-02' },
      },
    },
    title: 'Restart arnica-prod-nest-01 on pve-02',
    question: 'Restart arnica-prod-nest-01 on pve-02?',
    target: 'pve-02 · arnica-prod-nest-01',
    whatHappens: [
      'Restart arnica-prod-nest-01 so it gets its extra memory (4 → 8 GB)',
      'It’s down for about 40 seconds',
    ],
    explainer: 'Restarting a guest always asks a person.',
    summary: `${ASSISTANT_NAME} restarts arnica-prod-nest-01 on pve-02. It’s down for about 40 seconds.`,
    conditions: [
      {
        id: 'person',
        kind: 'person_approves',
        label: 'A person says yes',
        met: false,
        approverIds: [mara.id],
      },
    ],
    createdAt: at(0, '10:12'),
  } as Approval;
  let approval = restart;
  // The approval's card lands in the default chat (ONE-06), where “Tonight at 03:00” is offered too (AP-1280).
  (chats.get(DEFAULT_CHAT_ID) as Chat).messages.push(
    message({
      id: 'msg_whombat-restart' as Message['id'],
      conversationId: DEFAULT_CHAT_ID as Message['conversationId'],
      authorId: bot,
      createdAt: at(0, '10:12'),
      text: 'arnica-prod-nest-01 needs a restart to get its extra memory. It’s down for about 40 seconds.',
      card: { kind: 'approval', approval: restart } as MessageCard,
    }),
  );

  /** Ignored items (`needsYou.ignore`), kept so Undo brings them back; at the list's foot meanwhile. */
  let ignoredItems: NeedsYouItem[] = [];
  /** Items to be reminded of later (`needsYou.snooze`), at the list's foot until then. */
  let snoozedItems: NeedsYouItem[] = [];
  let needsYou: NeedsYouItem[] = [
    {
      id: 'ny_alert-blackbox',
      ref: { kind: 'alert', id: 'alt_blackbox-array' },
      kind: 'alert',
      severity: 'bad',
      title: 'The disk array on blackbox has failed',
      body: 'Both parity drives dropped out 3 days ago. Your files are still there, but nothing protects them now.',
      at: at(-3, '09:14'),
      subject: { kind: 'server', id: 'blackbox', name: 'blackbox' },
      nature: 'problem',
      actions: [
        { id: 'look', label: `Ask ${ASSISTANT_NAME}`, style: 'primary', kind: 'investigate' },
        { id: 'later', label: 'Remind me tomorrow', style: 'secondary', kind: 'snooze' },
      ],
    },
    {
      id: `ny_approval-${RESTART_APPROVAL}`,
      ref: { kind: 'approval', id: String(RESTART_APPROVAL) },
      kind: 'approval',
      severity: 'warn',
      title: 'Restart arnica-prod-nest-01 on pve-02?',
      body: 'It needs a restart to get its extra memory (4 → 8 GB). It’s down for about 40 seconds.',
      at: at(0, '10:12'),
      approvalNumber: RESTART_APPROVAL,
      subject: { kind: 'server', id: 'pve-02', name: 'pve-02' },
      // The approval's words everywhere (needs-you-list.md NYL-08): a yes, a yes for tonight, a no.
      actions: [
        { id: 'now', label: 'Yes, do it', style: 'primary', kind: 'approve' },
        {
          id: 'tonight',
          label: 'Tonight',
          style: 'secondary',
          kind: 'approve_later',
          at: localAt(made, TZ, '03:00', 1),
        },
        { id: 'decline', label: 'No', style: 'secondary', kind: 'decline' },
      ],
    },
    {
      id: `ny_skill-${HEAT_PROPOSAL}`,
      ref: { kind: 'device_skill', id: HEAT_PROPOSAL },
      kind: 'device_skill',
      severity: 'info',
      title: 'What may I change on the heat pump?',
      body: 'I can read it now. Pick what I’m allowed to change before I switch that on.',
      at: at(0, '13:41'),
      subject: { kind: 'device', id: 'con_heat-pump', name: 'Heat pump' },
      actions: [
        { id: 'choose', label: 'Choose', style: 'primary', kind: 'open', href: `/chats/${HEAT_CHAT_ID}` },
      ],
    },
  ];

  const server = (
    id: string,
    status: ThingSummary['status'],
    line: string,
    reason?: string,
  ): ThingSummary => ({
    id: `server:${id}`,
    kind: 'server',
    name: id,
    // What the Whombat server sends (CT-399 `hostOsMark`): Proxmox's, Unraid's or the Linux's mark.
    icon: osMark(line) ?? 'server',
    status,
    line,
    // Why it isn't fine (contracts 0.95 CT-453): the sidebar's tooltip.
    ...(reason ? { reason } : {}),
    facts: [],
    href: thingHref('server', id),
  });
  const connection = (
    id: string,
    catalogId: string,
    name: string,
    icon: string,
    over: Partial<ThingSummary> = {},
  ): ThingSummary => ({
    id: `connection:${id}`,
    kind: 'connection',
    catalogId,
    name,
    icon,
    status: 'ok',
    facts: [],
    href: thingHref('connection', id),
    ...over,
  });
  // `usedAt` (contracts 0.91, CT-404): the last call that worked, for the things Home shows without figures (HR-23).
  let things: ThingSummary[] = [
    server('thetitan', 'ok', 'Debian 13 · Threadripper 9970X'),
    server('pve-01', 'ok', 'Proxmox VE 9.2 · Core i9-13900H'),
    server('pve-02', 'warn', 'Proxmox VE 9.2 · Ryzen AI MAX+', 'Running warm'),
    server('blackbox', 'bad', 'Unraid 7.3 · Xeon W-1250', 'Disk array failed'),
    server('the-falcon', 'ok', 'Debian 13 · Ryzen 9 9950X3D'),
    // How Home Assistant runs, not the house (connection-pages.md CP-16): two integrations don't load.
    connection('con_home-assistant', 'homeassistant', 'Home Assistant', 'home', {
      status: 'warn',
      line: 'Home Assistant 2026.10.2',
      reason: '2 integrations not loading',
      facts: [
        { label: 'Integrations', value: '169 of 171' },
        { label: 'Errors today', value: '38' },
        { label: 'Updates', value: '2' },
      ],
    }),
    {
      id: 'device:con_heat-pump',
      kind: 'device',
      catalogId: 'device',
      name: 'Heat pump',
      icon: 'thermometer',
      status: 'learning',
      line: 'Daikin Altherma',
      facts: [],
      href: thingHref('device', 'con_heat-pump'),
    },
    connection('con_unifi', 'unifi', 'UniFi', 'wifi', {
      status: 'warn',
      line: '45 devices',
      reason: '1 access point offline',
      facts: [
        { label: 'Internet', value: '84 / 12', note: 'Mbit/s' },
        { label: 'Access points', value: '21 of 22', note: 'online' },
      ],
    }),
    connection('con_hetzner', 'hetzner', 'Hetzner', 'cloud', { line: '1 server', usedAt: at(-1, '16:20') }),
    // pve-02's own Proxmox API: part of the server, so only its page links to it (CP-10).
    connection('con_pve-02-api', 'proxmox', 'Proxmox VE API', 'server', {
      line: 'pve-02',
      facts: [{ label: 'Guests', value: '23' }],
      partOf: 'server:pve-02',
    }),
    // Mara's Google account, by the id the connectors' world gives it (`connectorFixtures.ts`): its page and its
    // Connection tab are that account's.
    connection('con_mara', 'google', 'Google', 'google', {
      line: 'Last checked 13:55',
      usedAt: at(0, '08:00'),
    }),
    // Find My through studio, when the servers' world lists the Mac (findmy-connection.md).
    ...(macFixtureListed() ? [findMyConnectionThing()] : []),
  ];

  const allThings = (): ThingSummary[] =>
    options.moreThings ? withServiceThings(things, options.moreThings()) : things;
  // Arranging the Overview (overview-arranged.md): its layout and its tiles' figures.
  const arranging = createOverviewFixtures(allThings);

  const automationsToday: AutomationToday[] = [
    {
      id: 'aut_customer-mail' as AutomationToday['id'],
      name: 'Customer mail summary',
      state: 'ran',
      at: at(0, '08:00'),
    },
    {
      id: 'aut_night-heating' as AutomationToday['id'],
      name: 'Night-time heating',
      state: 'scheduled',
      at: at(0, '22:00'),
    },
  ];

  let widgets: Widget[] = [
    {
      id: 'wdg_heat-pump' as Widget['id'],
      title: 'Heat pump · today',
      subtitle: 'Daikin Altherma',
      kind: 'line',
      series: [
        { key: 'room', label: 'Room', unit: '°C', color: 1 },
        { key: 'water', label: 'Water to radiators', unit: '°C', color: 2 },
        { key: 'outside', label: 'Outside', unit: '°C', color: 3 },
      ],
      latest: [
        { key: 'room', value: 21, unit: '°C' },
        { key: 'water', value: 34, unit: '°C' },
        { key: 'outside', value: 9, unit: '°C' },
      ],
      points: heatPumpPoints(made),
      refreshSec: 60,
      updatedAt: new Date(made).toISOString(),
      fromConversationId: HEAT_CHAT_ID as Widget['fromConversationId'],
    },
    // Kept on Home Assistant's page, not Home (contracts 0.88, CT-392; CP-14).
    {
      id: 'wdg_ha-database' as Widget['id'],
      title: 'Database size',
      subtitle: 'MariaDB',
      kind: 'line',
      series: [{ key: 'size', label: 'Database', unit: 'GB', color: 1 }],
      latest: [{ key: 'size', value: 2.8, unit: 'GB' }],
      points: heatPumpPoints(made).map((p, i, all) => ({
        t: p.t,
        values: { size: round1(2.6 + (0.2 * i) / Math.max(1, all.length - 1)) },
      })),
      refreshSec: 3600,
      updatedAt: new Date(made).toISOString(),
      thingId: 'connection:con_home-assistant',
    },
  ];

  const whombatActor = {
    kind: 'whombat' as const,
    id: WHOMBAT_ID as ChangeEntry['actor']['id'],
    name: ASSISTANT_NAME,
  };
  const change = (id: string, title: string, detail: string, when: string, over: Partial<ChangeEntry> = {}) =>
    ({
      id: `chg_${id}` as ChangeEntry['id'],
      title,
      detail,
      at: when,
      actor: whombatActor,
      undo: { state: 'none' },
      ...over,
    }) as ChangeEntry;
  // Mara's own edits (Whombat HR-05): on the thing's page, which says “You”; never on Home or Everything I did.
  const maraActor = { kind: 'person' as const, id: mara.id as ChangeEntry['actor']['id'], name: mara.name };
  /** When Undo last asked Neo to put a reported change back (a second press within 10 minutes is refused). */
  const undoAsked = new Map<string, number>();
  const undoUntil = (when: string) => new Date(Date.parse(when) + 24 * 3_600_000).toISOString();
  let changes: ChangeEntry[] = [
    // Reported by Neo with `report_change` in the default chat (Whombat HR-03): Undo asks Neo to put it back there.
    change(
      'zonneplan',
      'Removed 14 old Zonneplan entities from Home Assistant',
      'Home Assistant restarted afterwards',
      at(0, '12:15'),
      {
        undo: { state: 'available', until: undoUntil(at(0, '12:15')) },
        thingId: 'connection:con_home-assistant',
        link: `/chats/${DEFAULT_CHAT_ID}`,
      },
    ),
    change('nextcloud-memory', 'Gave nextcloud more memory', '2 → 4 GB, on pve-02', at(0, '10:12'), {
      undo: { state: 'available', until: undoUntil(at(0, '10:12')) },
      thingId: 'server:pve-02',
      link: thingHref('server', 'pve-02'),
    }),
    change('pve-01-updates', 'Installed security updates on pve-01', 'No restart needed', at(0, '03:00'), {
      thingId: 'server:pve-01',
    }),
    change('ha-name', 'Changed the name and notes of Home Assistant', '', at(-1, '20:40'), {
      actor: maraActor,
      thingId: 'connection:con_home-assistant',
    }),
    change(
      'mail-drafts',
      'Wrote replies to 3 customer emails',
      'Saved as drafts in your mailbox',
      at(-1, '17:40'),
      {
        link: `/chats/${MAIL_CHAT_ID}`,
      },
    ),
    change(
      'pve-02-backups',
      'Moved pve-02’s backups to 02:00',
      'They overlapped with the nightly sync',
      at(-1, '11:05'),
      {
        undo: { state: 'available' },
        thingId: 'server:pve-02',
        link: thingHref('server', 'pve-02'),
      },
    ),
    change(
      'old-wp-staging',
      'Stopped old-wp-staging on pve-01',
      'Nobody had opened it in 60 days',
      at(-2, '16:30'),
      {
        undo: { state: 'available' },
        thingId: 'server:pve-01',
        link: thingHref('server', 'pve-01'),
      },
    ),
    change('ha-lights', 'Turned off the hallway lights', 'Nobody was home', at(-3, '23:10'), {
      undo: { state: 'undone' },
      thingId: 'connection:con_home-assistant',
    }),
    change(
      'ha-shelly',
      'Updated the Shelly integration',
      'To 1.4.2, which Home Assistant offered',
      at(-4, '09:30'),
      {
        thingId: 'connection:con_home-assistant',
      },
    ),
    change('unifi-guest', 'Turned on the guest network', 'For the party, until Sunday', at(-5, '18:00'), {
      link: thingHref('connection', 'con_unifi'),
      thingId: 'connection:con_unifi',
    }),
    change(
      'hetzner-firewall',
      'Opened port 443 on the web server’s firewall',
      'You asked in “Deploy the website”',
      at(-10, '16:20'),
      { thingId: 'connection:con_hetzner' },
    ),
    change(
      'hetzner-dns',
      'Pointed whombat.example at the web server',
      'You asked in “Deploy the website”',
      at(-10, '16:05'),
      { thingId: 'connection:con_hetzner' },
    ),
  ];

  let watch: WatchItem[] = [
    {
      id: 'wch_blackbox-array',
      ref: { kind: 'alert', id: 'alt_blackbox-array' },
      source: 'server',
      severity: 'bad',
      title: 'The disk array on blackbox has failed',
      body: 'Both parity drives dropped out. Your files are still there, but nothing protects them now.',
      at: at(-3, '09:14'),
      serverId: 'blackbox',
      state: 'open',
      href: thingHref('server', 'blackbox'),
    },
    {
      id: 'wch_pve-02-hot',
      ref: { kind: 'alert', id: 'alt_pve-02-hot' },
      source: 'server',
      severity: 'warn',
      title: 'pve-02 is running hot',
      body: 'Its processor has been above 72 °C for 17 hours. The fans are at full speed.',
      at: at(-1, '21:05'),
      serverId: 'pve-02',
      state: 'open',
      href: thingHref('server', 'pve-02'),
    },
    {
      id: 'wch_pve-01-backup',
      ref: { kind: 'hint', id: 'hnt_pve-01-backup' },
      source: 'server',
      severity: 'warn',
      title: 'No backup of pve-01’s guests for 2 days',
      body: 'The last backup job stopped halfway. The next one runs tonight at 02:00.',
      at: at(0, '06:30'),
      serverId: 'pve-01',
      state: 'open',
      href: thingHref('server', 'pve-01'),
    },
    {
      id: 'wch_pve-02-pending',
      ref: { kind: 'hint', id: 'pve-02:guest.pending_changes:pve-02' },
      source: 'server',
      severity: 'info',
      title: '1 guest has changes waiting for a restart',
      body: 'nextcloud (1 change). Restart it to apply them.',
      at: at(0, '06:10'),
      serverId: 'pve-02',
      state: 'open',
      href: thingHref('server', 'pve-02'),
      nature: 'you',
      fixable: true,
    },
    {
      id: 'wch_hetzner-slow',
      ref: { kind: 'connection', id: 'con_hetzner' },
      source: 'connection',
      severity: 'info',
      title: 'Hetzner answered slowly',
      body: 'Its API took 9 seconds to answer twice this morning. It works again.',
      at: at(0, '07:40'),
      state: 'snoozed',
      snoozedUntil: tomorrowMorning(made, TZ),
      href: thingHref('connection', 'con_hetzner'),
    },
    // Heads-ups: in the Needs you list, folded and never counted; never on an older app's Watch.
    {
      id: 'wch_pve-01-updates',
      ref: { kind: 'hint', id: 'pve-01:system.updates:pve-01' },
      source: 'server',
      severity: 'info',
      title: '12 updates waiting on pve-01',
      body: 'None of them is urgent. Install them on the System tab.',
      at: at(0, '05:00'),
      serverId: 'pve-01',
      state: 'open',
      href: `${thingHref('server', 'pve-01')}?tab=system`,
      nature: 'fyi',
    },
    {
      id: 'wch_blackbox-plex',
      ref: { kind: 'hint', id: 'blackbox:docker.update_available:plex' },
      source: 'server',
      severity: 'info',
      title: 'An update for Plex',
      body: 'Plex 1.41.2 is out. Update it.',
      at: at(-1, '18:20'),
      serverId: 'blackbox',
      state: 'open',
      href: `${thingHref('server', 'blackbox')}?guest=docker%3Aplex`,
      nature: 'fyi',
    },
  ];

  const sameRef = (a: HomeRef, b: HomeRef) => a.kind === b.kind && a.id === b.id;

  /**
   * Home's chats (contracts 0.91 `HomeChat`, CT-403; HR-21), one in each state: the heat pump chat Neo works in, the
   * default chat waiting for Mara while the restart (#901) is undecided, and the others as recent.
   */
  function homeChats(): HomeChat[] {
    const waiting = needsYou.some((i) => i.approvalNumber === RESTART_APPROVAL);
    const last = (id: string) => {
      const chat = chats.get(id);
      return chat?.messages.at(-1)?.createdAt ?? chat?.conversation.lastMessageAt ?? at(0, '00:00');
    };
    const list: HomeChat[] = [];
    const heat = chats.get(HEAT_CHAT_ID);
    if (heat)
      list.push({
        conversationId: HEAT_CHAT_ID,
        // What it is doing there, as Home says it (“and I’m adding your Daikin heat pump”).
        title: heatPlan.title,
        state: 'working',
        at: last(HEAT_CHAT_ID),
        progress: { done: 3, total: 5 },
        step: 'Choosing what I may change',
      });
    list.push({
      conversationId: DEFAULT_CHAT_ID,
      title: assistant.name,
      state: waiting ? 'waiting' : 'recent',
      at: last(DEFAULT_CHAT_ID),
      default: true,
    });
    for (const id of [PVE_CHAT_ID, MAIL_CHAT_ID]) {
      const chat = chats.get(id);
      if (chat && !chat.conversation.chat?.archivedAt)
        list.push({
          conversationId: id,
          title: chat.conversation.chat?.title ?? chat.conversation.title,
          state: 'recent',
          at: last(id),
        });
    }
    return list;
  }

  function worstOf(open: readonly WatchItem[]): { worst?: HomeSeverity } {
    const worst = (['bad', 'warn', 'info'] as const).find((sev) => open.some((w) => w.severity === sev));
    return worst ? { worst } : {};
  }

  function overview(): HomeOverview {
    const open = watch.filter((w) => w.state === 'open' && w.nature !== 'fyi');
    const list = fixtureNeedsYouList(
      needsYou,
      [
        ...ignoredItems.map((i) => ({ ...i, state: 'acknowledged' as const })),
        ...snoozedItems.map((i) => ({
          ...i,
          state: 'snoozed' as const,
          snoozedUntil: tomorrowMorning(clock(), TZ),
        })),
      ],
      watch,
      allThings(),
    );
    return {
      summary: {
        // The one count (needs-you-list.md NYL-04): the list's first group.
        needsYou: needsYouCount(list),
        working: options.firstDay ? 0 : 1,
        problems: open.length,
        // The worst open item's severity, as the Whombat sends it (contracts 0.95 CT-454): an older app's Watch badge.
        ...worstOf(open),
      },
      needsYou,
      needsYouList: list,
      things: allThings(),
      automationsToday,
      // Home's own widgets; those kept on a thing's page show there (CP-14).
      widgets: widgets.filter((w) => !w.thingId),
      // What an agent changed (HR-05): a person's own edits stay on the thing's page.
      doneRecently: changes.filter((c) => c.actor.kind !== 'person').slice(0, 5),
      chats: homeChats(),
      arranged: arranging.arranged(),
      generatedAt: new Date(clock()).toISOString(),
    };
  }

  /* Chats ------------------------------------------------------------------------------------------ */

  function summaryOf(chat: Chat): ConversationSummary {
    const c = chat.conversation;
    return {
      id: c.id,
      kind: 'dm',
      slug: c.slug,
      title: c.title,
      link: c.chat ? { type: 'chat', id: c.id } : { type: 'dm', room: 'chat' },
      unread: chat.unread,
      mentions: 0,
      prNumber: null,
      lastMessageAt: c.lastMessageAt,
    };
  }

  function chatSummary(chat: Chat): ChatSummary {
    const c = chat.conversation;
    const last = chat.messages.filter((m) => !m.threadRootId).at(-1);
    return {
      id: c.id,
      title: c.chat?.title ?? c.title,
      subject: c.chat?.subject ?? null,
      lastAt: last?.createdAt ?? c.lastMessageAt,
      ...(last?.text ? { lastText: last.text.slice(0, 200) } : {}),
      unread: chat.unread,
      default: !c.chat,
      archivedAt: c.chat?.archivedAt ?? null,
    };
  }

  function detailOf(chat: Chat): ConversationDetail {
    return {
      conversation: chat.conversation,
      summary: summaryOf(chat),
      pr: null,
      lastReadMessageId: chat.messages.at(-1)?.id ?? null,
    };
  }

  function patchCard(card: DeviceSkillCard) {
    for (const chat of chats.values())
      chat.messages = chat.messages.map((m) =>
        m.card?.kind === 'device_skill' && m.card.proposalId === card.proposalId ? { ...m, card } : m,
      );
  }

  function currentCard(): DeviceSkillCard {
    for (const chat of chats.values())
      for (const m of chat.messages)
        if (m.card?.kind === 'device_skill' && m.card.proposalId === HEAT_PROPOSAL) return m.card;
    return heatCard;
  }

  /** Its keys as a new Whombat gives them (OA-05, `agentDefaultGrants`); `agent.setKeys` replaces them. */
  let grants: Grant[] = agentDefaultGrants(WHOMBAT_ID);

  function setAssistantKeys(next: readonly GrantInput[]): Response {
    const saved = next.map((g) => ({ ...g, agentId: WHOMBAT_ID }) as Grant);
    const events = diffGrants(grants, saved).map((change, i) => ({
      id: `evt_one-keys-${++seq}-${i}`,
      text: describeGrantChange(assistant.name, change),
    }));
    grants = saved;
    return json({ grants, events });
  }

  /** `agent.get`: the agent, its keys and its profile (Settings → Agent reads it). */
  function assistantProfile(): AgentProfile {
    return {
      agent: assistant,
      grants,
      keys: {
        keys: grants.filter((g) => g.tier !== 'cannot').length,
        askFirst: grants.filter((g) => g.tier === 'ask').length,
      },
      recent: [],
      currentRun: null,
      modelFallback: null,
    };
  }

  /** A refusal on one field, as the server words it (`validation_failed`). */
  function refused(field: 'name' | 'face', message: string): Response {
    return json({ error: { code: 'validation_failed', message, fields: { [field]: [message] } } }, 422);
  }

  /**
   * `agent.update` (OA-08): a name must be well-formed and not “Whombat”; a face one of the five. A rename keeps the
   * face. The model (`runtime`) is the models layer's (`modelFixtures.ts`) when it runs; here it is kept as sent.
   */
  function updateAssistant(input: {
    name?: string;
    face?: string;
    runtime?: AgentModelRuntimeUpdate;
  }): Response {
    const name = input.name?.trim();
    if (name !== undefined && name !== assistant.name) {
      if (isReservedAgentName(name)) return refused('name', AGENT_NAME_RESERVED_TEXT);
      if (!AGENT_NAME_PATTERN.test(name)) return refused('name', AGENT_NAME_FORM_TEXT);
      assistant = { ...assistant, name };
    }
    if (input.face !== undefined) {
      if (!(AGENT_FACES as readonly string[]).includes(input.face))
        return refused('face', 'Pick one of the five faces.');
      assistant = { ...assistant, face: input.face as AgentFace };
    }
    if (input.runtime)
      assistant = { ...assistant, runtime: resolveAgentModelRuntime(input.runtime, assistant.runtime) };
    return json({ agent: assistant });
  }

  async function body<T>(req: Request): Promise<T> {
    const text = await req.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  // The first day: Chat holds the welcome alone, Needs you the backup proposal, and nothing else is there yet.
  if (options.firstDay) {
    const welcomedAt = at(0, '09:00');
    chats.clear();
    addChat(
      conversation(DEFAULT_CHAT_ID, welcomedAt, null),
      firstDayWelcome(options.firstDay, { person: 'Mara', assistant: ASSISTANT_NAME }).map((m, i) =>
        message({
          id: `msg_first-day-${i + 1}` as Message['id'],
          threadRootId: i > 0 ? (FIRST_DAY_ROOT_ID as Message['id']) : null,
          conversationId: DEFAULT_CHAT_ID as Message['conversationId'],
          authorId: bot,
          createdAt: at(0, `09:0${i}`),
          text: m.text,
          card: m.card,
        }),
      ),
    );
    needsYou = [firstDayBackupItem(welcomedAt)];
    watch = [];
    things = [];
    widgets = [];
    changes = [];
    automationsToday.length = 0;
  }

  return {
    async handle(req) {
      const url = new URL(req.url, 'http://fixtures.local');
      const path = url.pathname;
      if (!path.startsWith(`${B}/`)) return null;
      const rest = path.slice(B.length);
      const route = `${req.method} ${rest}`;

      if (rest === '/agent') {
        if (req.method === 'GET') return json(assistantProfile());
        if (req.method === 'PATCH') return updateAssistant(await body<{ name?: string; face?: string }>(req));
      }
      if (rest === '/agent/keys' && req.method === 'PUT')
        return setAssistantKeys((await body<{ grants: GrantInput[] }>(req)).grants);

      switch (route) {
        case 'GET /home':
          return json(overview());
        case 'PUT /overview/layout':
          return json(arranging.arrange((await body<{ layout: OverviewLayout }>(req)).layout));
        case 'GET /overview/views':
          return json(arranging.views(url.searchParams.get('show') ?? ''));
        case 'GET /overview/figures':
          return json(arranging.figures(url.searchParams.get('thing') ?? undefined));
        case 'GET /watch': {
          const all = url.searchParams.get('state') === 'all';
          // An older app's Watch: never the heads-ups.
          const items = watch.filter((w) => w.nature !== 'fyi');
          return json({ items: all ? items : items.filter((w) => w.state === 'open') });
        }
        case 'POST /needs-you/snooze': {
          const { ref, until } = await body<{ ref: HomeRef; until: string }>(req);
          snoozedItems.push(...needsYou.filter((i) => sameRef(i.ref, ref)));
          needsYou = needsYou.filter((i) => !sameRef(i.ref, ref));
          watch = watch.map((w) =>
            sameRef(w.ref, ref) ? { ...w, state: 'snoozed', snoozedUntil: until } : w,
          );
          return json({ ref, snoozedUntil: until });
        }
        case 'POST /needs-you/ignore': {
          const { ref, ignored = true } = await body<{ ref: HomeRef; ignored?: boolean }>(req);
          if (ignored) {
            const item = needsYou.find((i) => sameRef(i.ref, ref));
            if (item) ignoredItems.push(item);
            needsYou = needsYou.filter((i) => !sameRef(i.ref, ref));
            watch = watch.map((w) => (sameRef(w.ref, ref) ? { ...w, state: 'acknowledged' } : w));
          } else {
            const back = ignoredItems.filter((i) => sameRef(i.ref, ref));
            ignoredItems = ignoredItems.filter((i) => !sameRef(i.ref, ref));
            needsYou = [...back, ...needsYou];
            watch = watch.map((w) => (sameRef(w.ref, ref) ? { ...w, state: 'open' } : w));
          }
          return json({ ref, ignored });
        }
        // Watch's Bring it back: a snooze or Ignore taken back.
        case 'POST /watch/acknowledge': {
          const { ref, acknowledged = true } = await body<{ ref: HomeRef; acknowledged?: boolean }>(req);
          const state = acknowledged ? 'acknowledged' : 'open';
          watch = watch.map((w) => {
            if (!sameRef(w.ref, ref)) return w;
            const { snoozedUntil: _, ...rest } = w;
            return { ...rest, state };
          });
          // Bring it back: a Needs you item snoozed or ignored is back in the list.
          if (!acknowledged) {
            const back = [...ignoredItems, ...snoozedItems].filter((i) => sameRef(i.ref, ref));
            ignoredItems = ignoredItems.filter((i) => !sameRef(i.ref, ref));
            snoozedItems = snoozedItems.filter((i) => !sameRef(i.ref, ref));
            needsYou = [...back, ...needsYou];
          }
          return json({ ref, state });
        }
        case 'GET /changes': {
          const limit = Number(url.searchParams.get('limit') ?? 20);
          const before = url.searchParams.get('before');
          const thing = url.searchParams.get('thing');
          // Everything I did lists what an agent changed; a thing's page lists people's edits there too (HR-05).
          const list = changes.filter((c) => (thing ? c.thingId === thing : c.actor.kind !== 'person'));
          const from = before ? list.findIndex((c) => c.id === before) + 1 : 0;
          const page = list.slice(from, from + limit);
          const more = from + limit < list.length;
          return json({ changes: page, before: more ? (page.at(-1)?.id ?? null) : null });
        }
        case 'GET /widgets': {
          const thing = url.searchParams.get('thing');
          return json({ widgets: widgets.filter((w) => (w.thingId ?? null) === thing) });
        }
        case 'GET /chats': {
          const archived = url.searchParams.get('archived') === 'true';
          const kind = url.searchParams.get('subjectKind');
          const id = url.searchParams.get('subjectId');
          const list = [...chats.values()]
            .map(chatSummary)
            .filter((c) => (archived ? !!c.archivedAt : !c.archivedAt))
            .filter((c) => (!kind || c.subject?.kind === kind) && (!id || c.subject?.id === id))
            .sort((a, b) => Date.parse(b.lastAt ?? '0') - Date.parse(a.lastAt ?? '0'));
          return json({ chats: list });
        }
        case 'POST /chats': {
          const { text, subject } = await body<{ text: string; subject?: ChatSubject }>(req);
          const id = newId('cnv');
          const now = new Date(clock()).toISOString();
          const c = conversation(id, now, { title: chatTitleFrom(text), subject: subject ?? null });
          const first = message({
            id: newId('msg') as Message['id'],
            conversationId: id as Message['conversationId'],
            authorId: person,
            createdAt: now,
            text,
          });
          const reply = message({
            id: newId('msg') as Message['id'],
            conversationId: id as Message['conversationId'],
            authorId: bot,
            createdAt: new Date(clock() + 1000).toISOString(),
            text: 'On it. I’ll tell you here what I find.',
          });
          addChat(c, [first, reply]);
          return json({ conversation: chats.get(id)?.conversation, message: first }, 201);
        }
      }

      const chatRoute = /^\/chats\/(cnv_[A-Za-z0-9_-]+)(\/archive)?$/.exec(rest);
      if (chatRoute) {
        const chat = chats.get(chatRoute[1] as string);
        if (!chat?.conversation.chat) return notFound('No chat by that id.');
        const c = chat.conversation;
        if (req.method === 'PATCH' && !chatRoute[2]) {
          const { title } = await body<{ title: string }>(req);
          chat.conversation = { ...c, title, chat: { ...c.chat, title } as Conversation['chat'] };
          return json({ conversation: chat.conversation });
        }
        if (req.method === 'POST' && chatRoute[2]) {
          chat.conversation = {
            ...c,
            chat: { ...c.chat, archivedAt: new Date(clock()).toISOString() } as Conversation['chat'],
          };
          return json({ conversation: chat.conversation });
        }
      }

      const undo = /^\/changes\/(chg_[A-Za-z0-9_-]+)\/undo$/.exec(rest);
      if (undo && req.method === 'POST') {
        const found = changes.find((c) => c.id === undo[1]);
        if (!found) return notFound('No change by that id.');
        if (found.undo.state !== 'available')
          return json({ error: { code: 'conflict', message: 'This can’t be undone any more.' } }, 409);
        // A change reported in a chat (HR-03): the person's message goes there and Neo is asked to put it back.
        const reportedIn = found.link?.startsWith('/chats/') ? found.link.slice('/chats/'.length) : null;
        const chat = reportedIn ? chats.get(reportedIn) : undefined;
        if (reportedIn && chat) {
          const last = undoAsked.get(found.id);
          if (last !== undefined && clock() - last < 10 * 60_000)
            return json({ error: { code: 'conflict', message: 'I’m already undoing this.' } }, 409);
          undoAsked.set(found.id, clock());
          const sent = new Date(clock()).toISOString();
          chat.messages = [
            ...chat.messages,
            message({
              id: newId('msg') as Message['id'],
              conversationId: reportedIn as Message['conversationId'],
              authorId: person,
              createdAt: sent,
              text: `Please undo this: ${found.title}`,
            }),
          ];
          chat.conversation = { ...chat.conversation, lastMessageAt: sent };
          return json({ change: found, state: 'requested', conversationId: reportedIn });
        }
        const next = { ...found, undo: { state: 'undone' as const } };
        changes = changes.map((c) => (c.id === next.id ? next : c));
        return json({ change: next, state: 'undone' });
      }

      const widget = /^\/widgets\/(wdg_[A-Za-z0-9_-]+)(\/move)?$/.exec(rest);
      if (widget) {
        const id = widget[1] as string;
        // `widgets.remove` and `widgets.move` answer the list of the place the widget is kept (CT-392).
        const place = widgets.find((w) => w.id === id)?.thingId ?? null;
        const ofPlace = () => widgets.filter((w) => (w.thingId ?? null) === place);
        if (req.method === 'DELETE' && !widget[2]) {
          widgets = widgets.filter((w) => w.id !== id);
          return json({ widgets: ofPlace() });
        }
        if (req.method === 'POST' && widget[2]) {
          const { position } = await body<{ position: number }>(req);
          const mine = ofPlace();
          const from = mine.findIndex((w) => w.id === id);
          if (from >= 0) {
            const moving = mine[from] as Widget;
            const next = mine.filter((w) => w.id !== id);
            next.splice(Math.min(position, next.length), 0, moving);
            widgets = [...widgets.filter((w) => (w.thingId ?? null) !== place), ...next];
          }
          return json({ widgets: ofPlace() });
        }
      }

      const skill = /^\/device-skills\/(dvp_[A-Za-z0-9_-]+)\/(decide|decline)$/.exec(rest);
      if (skill && req.method === 'POST') {
        if (skill[1] !== HEAT_PROPOSAL) return notFound('No device skill by that id.');
        if (skill[2] === 'decline') {
          const card = { ...currentCard(), status: 'declined' as const };
          patchCard(card);
          needsYou = needsYou.filter((i) => i.ref.kind !== 'device_skill');
          return json({ card, connectionId: null });
        }
        const { actions, switchOn } = await body<{
          actions: Record<string, DeviceActionChoice>;
          switchOn: boolean;
        }>(req);
        const card: DeviceSkillCard = {
          ...currentCard(),
          decided: actions,
          ...(switchOn ? { status: 'on' as const, connectionId: 'con_heat-pump' } : {}),
        };
        patchCard(card);
        if (switchOn) {
          needsYou = needsYou.filter((i) => i.ref.kind !== 'device_skill');
          things = things.map((t) =>
            t.id === 'device:con_heat-pump'
              ? {
                  ...t,
                  status: 'ok',
                  facts: [
                    { label: 'Room', value: '21.0', unit: '°C' },
                    { label: 'Water to radiators', value: '34', unit: '°C' },
                  ],
                }
              : t,
          );
        }
        return json({ card, connectionId: switchOn ? 'con_heat-pump' : null });
      }

      const decide = new RegExp(`^/approvals/${RESTART_APPROVAL}(/decide|/undo)?$`).exec(rest);
      if (decide) {
        if (req.method === 'GET' && !decide[1]) return json({ approval, eventId: null });
        if (req.method === 'POST' && decide[1] === '/decide') {
          const { decision, executeAt, scope } = await body<{
            decision: 'approve' | 'decline';
            executeAt?: string;
            scope?: 'once' | 'agent';
          }>(req);
          const stopAsking = decision === 'approve' && scope === 'agent';
          approval = {
            ...approval,
            state: decision === 'approve' ? 'approved' : 'declined',
            decidedById: mara.id,
            decidedAt: new Date(clock()).toISOString(),
            ...(executeAt ? { executeAt } : {}),
            ...(stopAsking ? { scope: 'agent' } : {}),
          } as Approval;
          if (stopAsking) options.stopAsking?.('pve-02');
          needsYou = needsYou.filter((i) => i.ref.kind !== 'approval');
          return json({ approval, eventId: null });
        }
      }

      // Server alerts acknowledged or snoozed from Watch (the hosts service's, stream WT's world serves the rest).
      const ack = /^\/hosts\/alerts\/([A-Za-z0-9_.:-]+)\/ack$/.exec(rest);
      const alertItem = ack ? watch.find((w) => w.ref.kind === 'alert' && w.ref.id === ack[1]) : undefined;
      if (ack && alertItem) {
        const nowIso = new Date(clock()).toISOString();
        let acknowledged: { at: string; by: string; note: string; until: string | null } | null = null;
        if (req.method === 'POST') {
          const { minutes = 0, note = '' } = await body<{ minutes?: number; note?: string }>(req);
          const until = minutes > 0 ? new Date(clock() + minutes * 60_000).toISOString() : null;
          acknowledged = { at: nowIso, by: mara.name, note, until };
          watch = watch.map((w) =>
            w.id === alertItem.id
              ? { ...w, state: until ? 'snoozed' : 'acknowledged', ...(until ? { snoozedUntil: until } : {}) }
              : w,
          );
          needsYou = needsYou.filter((i) => !sameRef(i.ref, alertItem.ref));
        } else if (req.method === 'DELETE') {
          watch = watch.map((w) =>
            w.id === alertItem.id ? { ...w, state: 'open', snoozedUntil: undefined } : w,
          );
        } else return null;
        return json({
          id: alertItem.ref.id,
          serverId: alertItem.serverId ?? null,
          severity: alertItem.severity === 'bad' ? 'critical' : 'warning',
          title: alertItem.title,
          detail: alertItem.body,
          openedAt: alertItem.at,
          rule: 'fixture',
          state: 'open',
          acknowledged,
          attention: acknowledged === null,
        });
      }

      const conv = /^\/conversations\/(cnv_[A-Za-z0-9_-]+)(\/messages|\/read)?$/.exec(rest);
      const chat = conv ? chats.get(conv[1] as string) : undefined;
      if (conv && chat) {
        if (req.method === 'GET' && !conv[2]) return json(detailOf(chat));
        if (req.method === 'GET' && conv[2] === '/messages')
          return json({
            messages: chat.messages.filter((m) => !m.threadRootId),
            before: null,
            hasMore: false,
          });
        if (req.method === 'POST' && conv[2] === '/messages') {
          const input = await body<{ text: string; clientId?: string; threadRootId?: string | null }>(req);
          const m = message({
            id: newId('msg') as Message['id'],
            conversationId: chat.conversation.id as Message['conversationId'],
            authorId: person,
            createdAt: new Date(clock()).toISOString(),
            text: input.text,
            clientId: input.clientId ?? null,
            threadRootId: (input.threadRootId ?? null) as Message['threadRootId'],
          });
          chat.messages = [...chat.messages, m];
          chat.conversation = { ...chat.conversation, lastMessageAt: m.createdAt };
          return json({ message: m, dispatches: [] }, 201);
        }
        if (req.method === 'POST' && conv[2] === '/read') {
          chat.unread = 0;
          return json({ unread: 0, mentions: 0 });
        }
      }
      return null;
    },

    things: () => allThings(),
    addChange(entry) {
      changes = [entry, ...changes];
    },
    now: clock,

    async decorate(req, response) {
      const path = new URL(req.url, 'http://fixtures.local').pathname;
      if (req.method !== 'GET' || !response.ok || path !== `${B}/bootstrap`) return response;
      const boot = (await response.json()) as Bootstrap;
      const def = chats.get(DEFAULT_CHAT_ID) as Chat;
      // One agent per Whombat (OA-01; one-agent.md AP-4921): the world's agent, as Mara named it, and Mara's Chat as
      // this world draws it, in the place of the shared world's.
      const hasChat = boot.sidebar.dms.some((d) => d.id === DEFAULT_CHAT_ID);
      const chatRow = { ...summaryOf(def), title: 'Chat' };
      return json({
        ...boot,
        principals: boot.principals.map((p) => (p.id === WHOMBAT_ID ? assistant : p)),
        sidebar: {
          ...boot.sidebar,
          dms: hasChat
            ? boot.sidebar.dms.map((d) => (d.id === DEFAULT_CHAT_ID ? { ...d, ...chatRow } : d))
            : [chatRow, ...boot.sidebar.dms],
        },
      } satisfies Bootstrap);
    },
  };
}

/**
 * The one Needs you list as the Whombat puts it together (needs-you-list.md NYL-01): Needs you's items first (they keep
 * their buttons and claim their ref), then what only Watch had, as items about their thing; each in its group, worst
 * first then newest. The looks' fixtures add their research.
 */
export function fixtureNeedsYouList(
  open: readonly NeedsYouItem[],
  quiet: readonly NeedsYouItem[],
  watch: readonly WatchItem[],
  things: readonly Pick<ThingSummary, 'id' | 'name'>[],
): NeedsYouItem[] {
  const same = (a: HomeRef, b: HomeRef) => a.kind === b.kind && a.id === b.id;
  const own = [...open, ...quiet].map((item) => {
    const seen = watch.find((w) => same(w.ref, item.ref));
    return seen?.href && !item.href ? { ...item, href: seen.href } : item;
  });
  const name = (id: string) => things.find((t) => t.id === id)?.name;
  const rest = watch
    .filter((w) => !own.some((i) => same(i.ref, w.ref)))
    .map((w): NeedsYouItem => {
      const subject = w.serverId
        ? { kind: 'server' as const, id: w.serverId, name: name(`server:${w.serverId}`) ?? w.serverId }
        : w.ref.kind === 'connection'
          ? { kind: 'connection' as const, id: w.ref.id, name: name(`connection:${w.ref.id}`) ?? w.ref.id }
          : undefined;
      return {
        id: w.id,
        ref: w.ref,
        kind: w.ref.kind === 'alert' ? 'alert' : w.ref.kind === 'connection' ? 'connection' : 'hint',
        severity: w.severity,
        title: w.title,
        body: w.body,
        at: w.at,
        actions: [],
        nature: w.nature ?? 'problem',
        ...(subject ? { subject } : {}),
        ...(w.href ? { href: w.href } : {}),
        ...(w.state !== 'open' ? { state: w.state } : {}),
        ...(w.snoozedUntil ? { snoozedUntil: w.snoozedUntil } : {}),
        ...(w.fixable ? { fixable: true as const } : {}),
      };
    });
  const rank = { bad: 0, warn: 1, info: 2 } as const;
  return [...own, ...rest]
    .sort((a, b) => rank[a.severity] - rank[b.severity] || b.at.localeCompare(a.at))
    .map((i) => ({ ...i, group: needsYouGroupOf(i) }));
}
