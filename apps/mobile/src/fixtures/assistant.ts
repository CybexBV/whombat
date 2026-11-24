/**
 * The one-Whombat demo world (mock 4: Lumio at 14:05; one-whombat-mobile.md AP-1377): Home, Watch, task chats, five
 * servers with their guests, the heat pump's device skill, Approve later, snoozes and ignores — over the real contracts,
 * in the app, without a server. The demo world (`EXPO_PUBLIC_WHOMBAT_MODE=fixtures`, or “Explore the demo burrow”) is
 * this world (one-layout-android.md AP-2646); its clock starts at 14:05.
 *
 * - `home.overview`: “blackbox’s disk array failed. 2 other things need you.” — blackbox's disk array (Look into it · Remind me
 *   tomorrow), restarting arnica-prod-nest-01 (Yes, now · Yes, tonight · No, and Remind me tomorrow), the heat pump's skill (opens
 *   its chat); the five servers, Home Assistant, the heat pump (learning), UniFi, Hetzner and Mail.
 * - `watch.list`: two alerts, a hint, a failed automation and an acknowledged alert; Acknowledge, Snooze and Watch again
 *   change them (`hosts.ackAlert`, `needsYou.snooze`).
 * - Chat (`chatChannel.ts`, chat-channel.md AP-2460; the demo runtime has `chat.channel`): Mara's threaded Chat and her
 *   Feedback room after the fresh start, `chats.threads`, a new thread from `chats.start` or the composer. Without it
 *   (`chat: false`): `chats.*` and the chats' `conversations.get` / `messages.list` / `messages.send`, three task chats
 *   and the default one. Neo answers a new message after `replyDelayMs` (“thinking” first), as a realtime
 *   `message.created`.
 * - The Whombat's one agent is Neo, with Neo's face (Whombat one-agent.md OA-01, OA-08; app one-agent.md AP-4964): the
 *   burrow's agent (`prn_dusty`) renamed, so everything it did in the demo world is Neo's. `agent.get` answers Settings
 *   → Agent and `agent.update` renames it (the server's checks, the default chat's title follows) or gives it another
 *   face, with an `agent.updated` event. Neo holds the agent's default keys (`agentDefaultGrants`, OA-05);
 *   `agent.setKeys` replaces them with a Keys event per change (AP-1555).
 * - `hosts.*`: the fleet, a server's detail, its guests and their power (the guest changes state a moment later, with
 *   a `hosts.guest` event).
 * - `connections.tools`: Home Assistant, UniFi, Hetzner, Mail, Find My through studio (Settings → Connections lists it;
 *   Home stays mock 4's) and (once switched on) the heat pump, for their
 *   Connection screens.
 * - `deviceSkills.decide` / `decline`: the card changes on its message (`message.updated`), the heat pump leaves Needs
 *   you and starts reading.
 *
 * Pure TypeScript over `Response`, unit-tested: every answer parses with its endpoint's response schema.
 */

import { createOverviewFixtures, nextAt } from '@whombat/client';
import {
  createFindMyTimelineFixture,
  createMacFixture,
  FIND_MY_CONNECTION_FIELDS,
  FIND_MY_CONNECTION_ID,
  MAC_SERVER,
  withQuietFixtures,
} from '@whombat/client/hosts/fixtures';
import {
  AGENT_NAME_FORM_TEXT,
  AGENT_NAME_PATTERN,
  AGENT_NAME_RESERVED_TEXT,
  type Agent,
  type AgentFace,
  type AgentModelRuntimeUpdate,
  type AgentProfile,
  type AgentRuntime,
  type Approval,
  type Burrow,
  type ChatSubject,
  type ChatSummary,
  ConnectionLabel,
  type Conversation,
  type ConversationDetail,
  type ConversationSummary,
  type DeviceSkillCard,
  FIND_MY_PEOPLE_TOOL,
  FIND_MY_TIMELINE_TOOL,
  type Grant,
  type GrantInput,
  type HomeChat,
  type HomeOverview,
  type HostAlert,
  type HostFleet,
  type HostGuest,
  type HostHint,
  type HostServer,
  type HostServerDetail,
  type HostServerSettingsPatch,
  isReservedAgentName,
  type Message,
  type NeedsYouItem,
  type OverviewLayout,
  type Principal,
  parseThingId,
  type RealtimeEvent,
  resolveAgentModelRuntime,
  type ThingPage,
  type ThingSummary,
  type ThingWatch,
  thingHref,
  thingId,
  type VaultEntry,
  type WatchItem,
} from '@whombat/core';
import type { KeepQuietBody, SetThingWatchLimitBody } from '@whombat/core/contracts';
import { agentDefaultGrants, describeGrantChange, diffGrants } from '@whombat/core/keys';
import {
  at,
  BURROW_ID,
  deployApproval,
  dusty,
  burrow as fixtureBurrow,
  mara,
  withServiceThings,
} from '@whombat/fixtures';
import { createChatChannelFixtures, FEEDBACK_ROOM_ID } from './chatChannel';
import { addedTools, createConnectFixtures } from './connect';
import { demoCatalogStatus, demoConnectionsList, demoConnectorsStatus } from './connections';
import { type DelegationFixtureStage, delegationStageFrom } from './delegation';
import { createHomeRedesignFixtures } from './homeRedesign';
import { createAgentUpdatesFixtures } from './hostsAgentUpdates';
import { createIuFixtures, iuGuestCounts, iuGuests } from './hostsIu';
import { createGuestManageFixtures } from './hostsManage';
import { createSiFixtures } from './hostsSi';
import { createUpdatesFixtures } from './hostsUpdates';
import { createLocalModelFixtures } from './localModel';
import { createLookFixtures, lookThreads } from './looks';
import { createMonitoringFixtures, SABNZBD_MACHINE } from './monitoring';
import {
  createServerAsksFixtures,
  DOCKER_CHAT_ID,
  SERVER_ASKS_APPROVAL,
  SERVER_NAME_TAKEN,
} from './serverAsks';
import { createServerDashboardFixtures } from './serverDashboards';
import { createThingPageFixtures } from './thingPages';
import { createWebSearchFixtures } from './webSearch';

/** The mock's moment: 14:05 on the seed day. */
export const ASSISTANT_NOW = at('14:05');
const ZONE = 'Europe/Amsterdam';

/** The Whombat's one agent: the burrow's (`prn_dusty`), called Neo in this world. */
export const ASSISTANT_ID = dusty.id;
/** Mara's Chat with Neo. */
export const DEFAULT_CHAT_ID = 'cnv_dm-mara';
export const HEAT_CHAT_ID = 'cnv_chat-heat';
export const PVE_CHAT_ID = 'cnv_chat-pve02';
export const MAIL_CHAT_ID = 'cnv_chat-mail';
/** The chat Neo is working in on Home (home-redesign-mobile.md AP-2266). */
export const HA_CHAT_ID = 'cnv_chat-ha';
/** Neo's card “Add 10.100.0.40 as a server?” (SI-10), with `si` on (server-signin-mobile.md AP-1714). */
export const ADD_SERVER_CHAT_ID = 'cnv_chat-add-server';
export const RESTART_APPROVAL = 31;
export const HEAT_PROPOSAL = 'dvp_heatpump';
const HEAT_CONNECTION = 'con_heatpump';

/**
 * An agent's runtime with another model runtime: matches the server's normalization (main model and background model
 * for every provider, effort and fast replies only for Claude Code and ChatGPT; omitting `backgroundModel` keeps it on
 * the same provider, `null` or a provider switch clears it).
 */
function withModelRuntime(runtime: AgentRuntime, model: AgentModelRuntimeUpdate): AgentRuntime {
  return resolveAgentModelRuntime(model, runtime);
}

/**
 * Neo, the Whombat's one agent (OA-01): the burrow's agent renamed, with Neo's face (OA-08), as the bootstrap lists it;
 * on Claude Code's default (chat-runtime-android.md AP-2732).
 */
export function assistantAgent(): Agent {
  return {
    ...dusty,
    runtime: { ...dusty.runtime, provider: 'claude' },
    name: 'Neo',
    face: 'neo',
    status: 'idle',
    doing: 'Learning your heat pump.',
  };
}

/* Servers ----------------------------------------------------------------------------------------------------------- */

const REMOTE = {
  console: true,
  power: true,
  hostShell: true,
  hostPower: true,
  manage: true,
  diagnose: true,
} as const;

/** 48 half-hours of CPU, a gentle day with a bump (`peak` at the backup hour). */
function day(base: number, peak: number): number[] {
  return Array.from({ length: 48 }, (_, i) => {
    const wave = Math.sin((i / 48) * Math.PI * 2) * 4;
    const bump = i >= 4 && i <= 8 ? peak : 0;
    return Math.max(1, Math.round(base + wave + bump));
  });
}

interface ServerSeed {
  id: string;
  status: HostServer['status'];
  statusNote: string | null;
  os: string;
  cpu: string;
  cpuPct: number;
  mem: [number, number];
  disk: [number, number];
  temp: number;
  guests: [number, number];
  peak: number;
}

const SERVERS: ServerSeed[] = [
  {
    id: 'thetitan',
    status: 'ok',
    statusNote: null,
    // An Incus host (incus-unraid-mobile.md AP-1640).
    os: 'Debian GNU/Linux 13',
    cpu: 'AMD Ryzen 9 7950X',
    cpuPct: 9,
    mem: [61.4, 128],
    disk: [1.5, 4],
    temp: 52,
    guests: [14, 20],
    peak: 18,
  },
  {
    id: 'pve-01',
    status: 'ok',
    statusNote: null,
    os: 'Proxmox VE 9.0.10',
    cpu: 'Intel Core i7-12700',
    cpuPct: 21,
    mem: [44.1, 64],
    disk: [2.2, 4],
    temp: 58,
    guests: [18, 31],
    peak: 12,
  },
  {
    id: 'pve-02',
    status: 'warn',
    statusNote: 'running warm',
    os: 'Proxmox VE 9.0.10',
    cpu: 'AMD Ryzen 7 5800X',
    cpuPct: 34,
    mem: [51.2, 64],
    disk: [1.1, 2],
    temp: 61,
    guests: [23, 40],
    peak: 40,
  },
  {
    id: 'blackbox',
    status: 'bad',
    statusNote: 'disk array failed',
    // An Unraid server (AP-1640).
    os: 'Unraid 7.3.1',
    cpu: 'Intel Xeon E-2236',
    cpuPct: 4,
    mem: [9.8, 32],
    disk: [11.2, 16],
    temp: 47,
    guests: [6, 9],
    peak: 6,
  },
  {
    id: 'the-falcon',
    status: 'ok',
    statusNote: null,
    os: 'Debian GNU/Linux 13',
    cpu: 'AMD Ryzen 5 5600G',
    cpuPct: 6,
    mem: [12.6, 32],
    disk: [18.4, 24],
    temp: 44,
    guests: [5, 33],
    peak: 8,
  },
  {
    // A Mac (macos-servers.md MAC-36): its screen, password and helper are the shared fixture's.
    id: MAC_SERVER,
    status: 'ok',
    statusNote: null,
    os: 'macOS 27.2.1',
    cpu: 'Apple M2 Ultra',
    cpuPct: 7,
    mem: [78.7, 192],
    disk: [0.76, 2],
    temp: 48,
    guests: [0, 0],
    peak: 6,
  },
];

function hostServer(s: ServerSeed): HostServer {
  const proxmox = s.os.startsWith('Proxmox');
  const mac = s.id === MAC_SERVER;
  // thetitan and blackbox are the Incus and Unraid servers (IU-03, AP-1640).
  const iu = iuGuests(s.id);
  return {
    id: s.id,
    name: s.id,
    group: 'Home lab',
    status: s.status,
    statusNote: s.statusNote,
    platform: proxmox
      ? 'proxmox'
      : s.id === 'thetitan'
        ? 'incus'
        : s.id === 'blackbox'
          ? 'unraid'
          : s.id === 'the-falcon'
            ? 'libvirt'
            : mac
              ? 'macos'
              : 'standard',
    ...(mac ? { osFamily: 'macos' as const } : {}),
    ...(iu?.some((g) => g.self) ? { hostsThisWhombat: true } : {}),
    os: s.os,
    cpu: { model: s.cpu, cores: 8, threads: 16 },
    uptimeS: 19 * 86_400,
    cpuPct: s.cpuPct,
    memory: { usedPct: Math.round((s.mem[0] / s.mem[1]) * 100), usedGb: s.mem[0], totalGb: s.mem[1] },
    storage: { usedPct: Math.round((s.disk[0] / s.disk[1]) * 100), usedTb: s.disk[0], capacityTb: s.disk[1] },
    temperature: { maxC: s.temp, limitC: 85 },
    diskWearMaxPct: s.id === 'pve-01' ? 82 : 14,
    guests: iu
      ? iuGuestCounts(iu)
      : mac
        ? []
        : [{ platform: proxmox ? 'pve' : 'docker', running: s.guests[0], total: s.guests[1] }],
    agent: { version: '0.9.2', connected: true },
    lastSeen: ASSISTANT_NOW,
    cpu24h: day(s.cpuPct, s.peak),
    remoteControl: { ...REMOTE },
    alerts: { critical: s.status === 'bad' ? 1 : 0, warning: s.status === 'warn' ? 1 : 0 },
    maintenance: null,
    parent: null,
  };
}

function alert(
  id: string,
  serverId: string,
  severity: HostAlert['severity'],
  title: string,
  detail: string,
  openedAt: string,
  section: string,
): HostAlert {
  return {
    id,
    serverId,
    severity,
    title,
    detail,
    openedAt,
    rule: `${section}.check`,
    state: 'open',
    resolvedAt: null,
    section,
    acknowledged: null,
    muted: false,
    suppressedBy: null,
    attention: true,
  };
}

const HINTS: HostHint[] = [
  {
    serverId: 'pve-01',
    kind: 'disk.wear',
    severity: 'info',
    entity: 'sdb',
    title: 'Disk sdb is 82 % worn',
    detail: 'It still works fine. Plan to replace it in the next few months.',
    section: 'storage',
  },
];

interface GuestSeed {
  vmid: number;
  name: string;
  kind: HostGuest['kind'];
  state: HostGuest['state'];
  cpu: number;
  mem: [number, number];
}

const PVE02_GUESTS: GuestSeed[] = [
  { vmid: 118, name: 'arnica-prod-nest-01', kind: 'vm', state: 'running', cpu: 6.2, mem: [3600, 4096] },
  { vmid: 119, name: 'arnica-prod-nest-02', kind: 'vm', state: 'running', cpu: 4.8, mem: [5100, 8192] },
  { vmid: 121, name: 'grafana', kind: 'container', state: 'running', cpu: 1.4, mem: [410, 1024] },
  { vmid: 122, name: 'pihole', kind: 'container', state: 'running', cpu: 0.6, mem: [180, 512] },
  { vmid: 125, name: 'jellyfin', kind: 'vm', state: 'running', cpu: 18.9, mem: [6200, 8192] },
  { vmid: 130, name: 'win11-test', kind: 'vm', state: 'stopped', cpu: 0, mem: [0, 8192] },
  // SABnzbd's machine, stopped: SABnzbd doesn't answer while it is (monitoring.md MON-07).
  { vmid: 126, name: SABNZBD_MACHINE.name, kind: 'container', state: 'stopped', cpu: 0, mem: [0, 2048] },
  { vmid: 131, name: 'build-runner', kind: 'container', state: 'paused', cpu: 0, mem: [900, 4096] },
  // Home Assistant's container (its page runs on it: connection-pages-mobile.md AP-1966).
  { vmid: 132, name: 'homeassistant', kind: 'container', state: 'running', cpu: 5.0, mem: [3000, 8192] },
];

function guestsFor(serverId: string): HostGuest[] {
  const iu = iuGuests(serverId);
  if (iu) return iu;
  const seeds: GuestSeed[] =
    serverId === 'pve-02'
      ? PVE02_GUESTS
      : [
          {
            vmid: 101,
            name: `${serverId}-web`,
            kind: 'container',
            state: 'running',
            cpu: 2.1,
            mem: [512, 2048],
          },
          { vmid: 102, name: `${serverId}-db`, kind: 'vm', state: 'running', cpu: 7.4, mem: [3900, 8192] },
          { vmid: 103, name: `${serverId}-old`, kind: 'vm', state: 'stopped', cpu: 0, mem: [0, 4096] },
        ];
  return seeds.map((g) => {
    const on = g.state === 'running';
    return {
      id: `pve:${g.vmid}`,
      serverId,
      serverOnline: true,
      name: g.name,
      platform: 'pve',
      kind: g.kind,
      image: g.kind === 'vm' ? 'debian-12' : 'debian-12-standard',
      state: g.state,
      vcpu: g.kind === 'vm' ? 4 : 2,
      cpuPct: on ? g.cpu : null,
      memoryUsedMb: g.state === 'stopped' ? null : g.mem[0],
      memoryLimitMb: g.mem[1],
      uptimeS: on ? 6 * 86_400 : 0,
      console: { available: on, protocols: g.kind === 'vm' ? ['vnc'] : ['shell'] },
      vmid: g.vmid,
      node: serverId,
      ...(g.name === 'arnica-prod-nest-01' ? { pendingChanges: 1, tags: ['prod'] } : {}),
    } satisfies HostGuest;
  });
}

/* Home -------------------------------------------------------------------------------------------------------------- */

function serverThing(s: HostServer): ThingSummary {
  const running = s.guests.reduce((n, g) => n + g.running, 0);
  const total = s.guests.reduce((n, g) => n + g.total, 0);
  return {
    id: thingId('server', s.id),
    kind: 'server',
    name: s.name,
    icon: 'server',
    status: s.status === 'pending' ? 'unknown' : s.status,
    line: s.statusNote ? s.statusNote.charAt(0).toUpperCase() + s.statusNote.slice(1) : 'Running fine',
    facts: [
      { label: 'CPU', value: `${s.cpuPct}`, unit: '%' },
      { label: 'Memory', value: `${s.memory.usedPct}`, unit: '%' },
      { label: 'Hottest', value: `${s.temperature?.maxC}`, unit: '°C' },
      { label: 'Guests', value: `${running}`, note: `of ${total} running` },
    ],
    href: thingHref('server', s.id),
  };
}

function otherThings(heatOn: boolean): ThingSummary[] {
  const connection = (
    id: string,
    name: string,
    icon: string,
    catalogId: string,
    facts: ThingSummary['facts'],
    line?: string,
  ): ThingSummary => ({
    id: thingId('connection', id),
    kind: 'connection',
    catalogId,
    name,
    icon,
    status: 'ok',
    ...(line ? { line } : {}),
    facts,
    href: thingHref('connection', id),
  });
  return [
    // Technical, as its page (connection-pages.md CP-16; connection-pages-mobile.md AP-1966).
    {
      ...connection(
        'con_ha',
        'Home Assistant',
        'home',
        'homeassistant',
        [
          { label: 'Integrations', value: '169', note: 'of 171' },
          { label: 'Errors today', value: '38' },
          { label: 'Updates', value: '2' },
        ],
        'Home Assistant 2026.10.2',
      ),
      status: 'warn',
    },
    {
      id: thingId('device', HEAT_CONNECTION),
      kind: 'device',
      name: 'Heat pump',
      icon: 'thermometer',
      status: heatOn ? 'ok' : 'learning',
      line: heatOn ? 'Daikin Altherma' : 'Neo is learning it',
      facts: heatOn
        ? [
            { label: 'Room', value: '21.0', unit: '°C' },
            { label: 'Water to radiators', value: '34', unit: '°C' },
            { label: 'Mode', value: 'Heating' },
          ]
        : [],
      href: thingHref('device', HEAT_CONNECTION),
    },
    connection('con_unifi', 'UniFi', 'wifi', 'unifi', [
      { label: 'Devices', value: '38' },
      { label: 'New', value: '1' },
    ]),
    // Without figures: when each was last used (contracts 0.91 `usedAt`, home-redesign-mobile.md AP-2266).
    {
      ...connection('con_hetzner', 'Hetzner', 'cloud', 'hetzner', [], 'Last checked 14:00'),
      usedAt: at('16:20', -1),
    },
    {
      ...connection('con_mail', 'Mail', 'mail', 'google_mail', [], 'Last checked 14:00'),
      usedAt: at('08:00'),
    },
  ];
}

/** The demo's connections as their Connection screens read them (`connections.tools`): a few tools each. */
const CONNECTIONS: Record<
  string,
  {
    catalogId: string;
    label: string;
    handle: string;
    /** Its address (the form's `url`), as its page says it; Settings → Connections' row shows the host (AP-2815). */
    url?: string;
    /** Its other fields (Find My's Mac and background reads). */
    fields?: Record<string, string>;
    /** How it signs in, when not with a token (Find My: through the Mac). */
    signIn?: 'none';
    tools: [string, string, 'read' | 'write', 'can' | 'ask' | 'off'][];
  }
> = {
  con_ha: {
    catalogId: 'homeassistant',
    label: 'Home Assistant',
    handle: 'home-assistant',
    url: 'http://10.100.0.131:8123',
    tools: [
      ['ha_states', 'Reads the state of lights, sensors, locks and the alarm', 'read', 'can'],
      ['ha_turn_on', 'Turns a light or a switch on', 'write', 'can'],
      ['ha_lock', 'Locks or unlocks a door', 'write', 'ask'],
    ],
  },
  con_unifi: {
    // The catalog's entry (Home's row keeps `unifi`, which titles it “Network”).
    catalogId: 'unifi_network',
    label: 'UniFi',
    handle: 'unifi',
    url: 'https://10.100.0.1',
    tools: [['unifi_clients', 'Lists the devices on your network', 'read', 'can']],
  },
  con_hetzner: {
    catalogId: 'hetzner',
    label: 'Hetzner',
    handle: 'hetzner',
    tools: [['hetzner_servers', 'Lists your cloud servers', 'read', 'can']],
  },
  con_mail: {
    catalogId: 'google_mail',
    label: 'Mail',
    handle: 'mail',
    tools: [['mail_search', 'Searches your mail', 'read', 'can']],
  },
  // Find My through studio (findmy-connection.md): read every 15 minutes for an automation.
  [FIND_MY_CONNECTION_ID]: {
    catalogId: 'findmy',
    label: 'Find My',
    handle: 'findmy',
    fields: { ...FIND_MY_CONNECTION_FIELDS },
    signIn: 'none',
    tools: [
      [FIND_MY_PEOPLE_TOOL.name, FIND_MY_PEOPLE_TOOL.title, 'read', 'can'],
      [FIND_MY_TIMELINE_TOOL.name, FIND_MY_TIMELINE_TOOL.title, 'read', 'can'],
    ],
  },
  [HEAT_CONNECTION]: {
    catalogId: 'device',
    label: 'Heat pump',
    handle: 'heat-pump',
    tools: [
      ['heat_pump_read', 'Reads the heat pump’s values', 'read', 'can'],
      ['heat_pump_room_setpoint', 'Sets the room temperature', 'write', 'can'],
    ],
  },
};

/** The demo's connections Settings → Connections lists (AP-2815). */
const DEMO_CATALOG_CONNECTIONS = ['con_ha', 'con_unifi', 'con_hetzner', FIND_MY_CONNECTION_ID];

/**
 * A connection with its tools as `connections.tools` answers it; `tiers` holds the tiers set since the demo started
 * (`connectionId/tool`), over the table's.
 */
function connectionTools(id: string, heatOn: boolean, tiers: ReadonlyMap<string, string> = new Map()) {
  const c = CONNECTIONS[id];
  if (!c || (id === HEAT_CONNECTION && !heatOn)) return null;
  return {
    connection: {
      id,
      catalogId: c.catalogId,
      label: c.label,
      handle: c.handle,
      burrowId: BURROW_ID,
      connectedBy: { id: mara.id, name: mara.name },
      detail: null,
      signIn: id === HEAT_CONNECTION || c.signIn === 'none' ? ('none' as const) : ('token' as const),
      transport: id === HEAT_CONNECTION ? ('builtin' as const) : ('rest' as const),
      fields: { ...(c.url ? { url: c.url } : {}), ...c.fields } as Record<string, string>,
      status: 'active' as const,
      reauthReason: null,
      checks: [],
      checkedAt: at('14:00'),
      toolCount: c.tools.length,
      canManage: true,
      access: 'manage' as const,
      poller: null,
      createdAt: at('09:00', -30),
      lastUsedAt: at('13:58'),
    },
    tools: c.tools.map(([name, description, access, tier]) => ({
      name,
      description,
      access,
      tier: (tiers.get(`${id}/${name}`) ?? tier) as typeof tier,
      sensitive: false,
      isNew: false,
      ...(name === 'heat_pump_room_setpoint'
        ? { limits: { args: { '/value': { min: 16, max: 24, step: 0.5 } } } }
        : {}),
    })),
    guide: '',
  };
}

/* Chats -------------------------------------------------------------------------------------------------------------- */

function conversation(
  id: string,
  title: string,
  chat: Conversation['chat'],
  lastMessageAt: string | null,
): Conversation {
  return {
    id,
    burrowId: BURROW_ID,
    kind: 'dm',
    slug: id.replace(/^cnv_/, ''),
    title,
    topic: '',
    actions: [],
    prNumber: null,
    repoId: null,
    createdAt: at('09:00'),
    lastMessageAt,
    chat,
  };
}

/** A room's sidebar summary: Mara's Chat and Feedback room by their room (OA-04), an older task chat by its id. */
function summaryOf(c: Conversation): ConversationSummary {
  return {
    id: c.id,
    kind: c.kind,
    slug: c.slug,
    title: c.title,
    link:
      c.id === DEFAULT_CHAT_ID
        ? { type: 'dm' }
        : c.id === FEEDBACK_ROOM_ID
          ? { type: 'dm', room: 'feedback' }
          : { type: 'chat', id: c.id },
    unread: 0,
    mentions: 0,
    prNumber: null,
    lastMessageAt: c.lastMessageAt,
  };
}

let seq = 0;
function message(
  conversationId: string,
  authorId: string,
  createdAt: string,
  text: string,
  card: Message['card'] = null,
): Message {
  seq += 1;
  return {
    id: `msg_one-${String(seq).padStart(4, '0')}`,
    conversationId,
    authorId,
    createdAt,
    editedAt: null,
    text,
    mentions: [],
    card,
    suggestions: [],
    more: null,
    attachments: [],
    reactions: [],
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
  };
}

export function heatPumpCard(): DeviceSkillCard {
  return {
    kind: 'device_skill',
    proposalId: HEAT_PROPOSAL,
    name: 'Daikin Altherma heat pump',
    model: 'EHVX08S23E',
    readings: [
      { key: 'room', label: 'Room', value: '21.0', unit: '°C' },
      { key: 'flow', label: 'Water to radiators', value: '34', unit: '°C' },
      { key: 'dhw', label: 'Hot water', value: '48', unit: '°C' },
      { key: 'outside', label: 'Outside', value: '9', unit: '°C' },
      { key: 'power', label: 'Using', value: '1.2', unit: 'kW' },
      { key: 'mode', label: 'Mode', value: 'Heating' },
    ],
    moreReadings: 3,
    actions: [
      {
        key: 'room_setpoint',
        label: 'Room temperature',
        description: 'What the room is heated to',
        proposed: { tier: 'can', limits: { min: 16, max: 24, step: 0.5 } },
        valueType: 'number',
        min: 12,
        max: 30,
        unit: '°C',
      },
      {
        key: 'dhw_boost',
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
        sensitive: true,
      },
    ],
    testedAt: at('13:40'),
    status: 'proposed',
  };
}

interface ChatState {
  conversation: Conversation;
  messages: Message[];
  unread: number;
}

/* The world -------------------------------------------------------------------------------------------------------- */

export interface AssistantFixtureOptions {
  now: () => Date;
  /** Deliver a realtime event on a topic. */
  emit: (topic: string, event: RealtimeEvent) => void;
  replyDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  /**
   * Add a server's extras (server-signin-mobile.md AP-1714): nas-02 waiting from an older command (Home's Needs you and
   * Waiting for you) and Neo's Add a server card in a chat. Default `EXPO_PUBLIC_WHOMBAT_SI=1`.
   */
  si?: boolean;
  /**
   * Chat (chat-channel.md AP-2460): the threaded Chat and Feedback rooms, where the demo runtime's `chat.channel` puts
   * the app; false gives the task chats of before. Default on unless `EXPO_PUBLIC_WHOMBAT_CHAT=0`.
   */
  chat?: boolean;
  /** Tonight's server work in Chat (`chatChannel.ts`, AP-4306); default `EXPO_PUBLIC_WHOMBAT_TASKS=1`. */
  tasks?: boolean;
  /** Two one-time Find My watches in Chat (`chatChannel.ts`, findmy-watch.md); default `EXPO_PUBLIC_WHOMBAT_WATCHES=1`. */
  watches?: boolean;
  /** The sign-in cards in Chat (`chatChannel.ts`, AP-6680); default `EXPO_PUBLIC_WHOMBAT_SIGNIN=1`. */
  signIns?: boolean;
  /** Councils in Chat (`council.ts`, council.md); default `EXPO_PUBLIC_WHOMBAT_COUNCIL=1`. */
  councils?: boolean;
  /** A delegation in Chat at this stage (`delegation.ts`, delegate.md); default `EXPO_PUBLIC_WHOMBAT_DELEGATION`. */
  delegation?: DelegationFixtureStage | null;
  /** Software work in Chat's threads, with T3 Code's jobs (`code.ts`); default `EXPO_PUBLIC_WHOMBAT_CODE=1`. */
  code?: boolean;
  /**
   * The service pages' Plex, Seerr, SABnzbd, Protect and Pi-hole listed on Home and the Connections tab
   * (service-dashboards.md AP-4660); their pages answer either way. Default `EXPO_PUBLIC_WHOMBAT_SERVICES=1`, so the demo
   * world's Home stays mock 4's.
   */
  services?: boolean;
  /**
   * A model on the burrow's network (`./localModel`, hermes-engine-app.md AP-5126): Llama on the NAS in Settings → AI,
   * Local in Runs on and the Chat picker. Default `EXPO_PUBLIC_WHOMBAT_LOCAL_MODEL=1`; off, the burrow has none.
   */
  localModel?: boolean;
  /**
   * Web search with a Brave Search key (`./webSearch`, Whombat web-search.md): on in Settings → AI. Default
   * `EXPO_PUBLIC_WHOMBAT_WEB_SEARCH=1`; off, the burrow has none.
   */
  webSearch?: boolean;
  /**
   * Looks Neo looked into (`./looks`, look-research-mobile.md AP-5925): Home Assistant found with a step, UniFi only Mara
   * can fix, pve-02 being looked into, each on Needs you with its thread in Chat. Default `EXPO_PUBLIC_WHOMBAT_LOOKS=1`.
   */
  looks?: boolean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function notFound(text: string): Response {
  return json({ error: { code: 'not_found', message: text } }, 404);
}

/** `agent.update`'s refusal of a field, as the server sends it (`validation_failed`, the field's message). */
function refused(field: 'name' | 'face', message: string): Response {
  return json({ error: { code: 'validation_failed', message, fields: { [field]: [message] } } }, 422);
}

async function bodyOf<T>(init: RequestInit | undefined): Promise<T> {
  return JSON.parse(String(init?.body ?? '{}')) as T;
}

/** The delegation in Chat: the stage asked for, else `EXPO_PUBLIC_WHOMBAT_DELEGATION`'s; none when neither says one. */
function delegationOption(asked: DelegationFixtureStage | null | undefined): {
  delegation?: DelegationFixtureStage;
} {
  const stage = asked === undefined ? delegationStageFrom(process.env.EXPO_PUBLIC_WHOMBAT_DELEGATION) : asked;
  return stage ? { delegation: stage } : {};
}

export function createAssistantFixtures(options: AssistantFixtureOptions) {
  const { now, emit } = options;
  const replyDelayMs = options.replyDelayMs ?? 1600;
  const listServices = options.services ?? process.env.EXPO_PUBLIC_WHOMBAT_SERVICES === '1';
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));

  let assistant = assistantAgent();
  // The burrow as this world has it: its model on the network and its web search, each published with the other.
  const worldBurrow = (): Burrow => ({
    ...fixtureBurrow,
    name: 'Lumio',
    localModel: local.view(),
    webSearch: webSearch.view(),
  });
  // The model on the network (AP-5126): Settings → AI's section, Local in Runs on and the Chat picker.
  const local = createLocalModelFixtures({
    now,
    emit,
    on: options.localModel ?? process.env.EXPO_PUBLIC_WHOMBAT_LOCAL_MODEL === '1',
    burrow: worldBurrow,
  });
  // Web search with a Brave Search key: Settings → AI's section under the model on the network.
  const webSearch = createWebSearchFixtures({
    now,
    emit,
    on: options.webSearch ?? process.env.EXPO_PUBLIC_WHOMBAT_WEB_SEARCH === '1',
    burrow: worldBurrow,
  });
  /** Its keys as a new Whombat gives them (OA-05); `agent.setKeys` replaces them. */
  let grants: Grant[] = agentDefaultGrants(ASSISTANT_ID);
  let keysSeq = 0;
  const servers = SERVERS.map(hostServer);
  const guests = new Map(servers.map((s) => [s.id, guestsFor(s.id)]));
  // Add a server: Sign in once's jobs, the command, Waiting for you (server-signin-mobile.md AP-1714).
  const si = createSiFixtures({
    now,
    emit,
    setTimer,
    hostsTopic: `hosts:${BURROW_ID}`,
    meTopic: `me:${mara.id}`,
    servers,
    addServer: (name) => {
      const server = {
        ...hostServer({
          id: name,
          status: 'ok',
          statusNote: null,
          os: 'Proxmox VE 9.0.10',
          cpu: 'Intel Core i5-12500',
          cpuPct: 3,
          mem: [4.2, 32],
          disk: [0.1, 1],
          temp: 41,
          guests: [0, 0],
          peak: 6,
        }),
        lastSeen: now().toISOString(),
      };
      const at = servers.findIndex((s) => s.id === server.id);
      if (at >= 0) servers[at] = server;
      else servers.push(server);
      guests.set(server.id, []);
      return server;
    },
    json,
    notFound,
    bodyOf,
    waiting: options.si ?? process.env.EXPO_PUBLIC_WHOMBAT_SI === '1',
  });
  const alerts: HostAlert[] = [
    alert(
      'al_blackbox_md0',
      'blackbox',
      'critical',
      'Disk array failed',
      'The parity disk is disabled. Your files have no protection now.',
      at('13:52'),
      'array',
    ),
    // A rule with a limit (monitoring.md MON-15): its line's ⋯ offers Change the limit.
    {
      ...alert(
        'al_pve02_temp',
        'pve-02',
        'warning',
        'CPU running warm',
        'It sat above 75 °C for 40 minutes during the backup.',
        at('12:10'),
        'sensors',
      ),
      rule: 'sensor.temp_high',
    },
    {
      ...alert(
        'al_falcon_backup',
        'the-falcon',
        'warning',
        'Backup took long',
        'Last night’s backup took 3 hours, twice the usual.',
        at('06:40'),
        'backups',
      ),
      acknowledged: { at: at('09:15'), by: 'Mara Okafor', note: '', until: null },
      attention: false,
    },
  ];
  const snoozed = new Map<string, string>();
  let heat: DeviceSkillCard = heatPumpCard();
  let restartDecided = false;
  // “Asks you first” per server and Neo's command on thetitan (server-asks-mobile.md AP-1746).
  const asks = createServerAsksFixtures({ now, requesterId: ASSISTANT_ID });
  /** A server as the world names it now: the name a person gave it, else its own. */
  const named = (s: HostServer): HostServer => ({ ...s, name: asks.nameOf(s.id) ?? s.name });
  // A connection's label, renamed where it is listed (`connections.update {label}`).
  const labels = new Map<string, string>();
  const labelled = <T extends { connection: { id: string; label: string } }>(t: T | null): T | null =>
    t
      ? { ...t, connection: { ...t.connection, label: labels.get(t.connection.id) ?? t.connection.label } }
      : null;
  const relabelled = (t: ThingSummary): ThingSummary => {
    const ref = parseThingId(t.id);
    const label = ref?.kind === 'connection' ? labels.get(ref.id) : undefined;
    return label ? { ...t, name: label } : t;
  };
  let failedAutomationSnoozed: string | null = null;

  const chats = new Map<string, ChatState>();
  const addChat = (
    id: string,
    title: string,
    subject: ChatSubject | null,
    lines: [string, string, string, Message['card']?][],
  ) => {
    const messages = lines.map(([who, when, text, card]) => message(id, who, at(when), text, card ?? null));
    const last = messages.at(-1)?.createdAt ?? null;
    const chat = id === DEFAULT_CHAT_ID ? null : { title, subject, archivedAt: null };
    chats.set(id, { conversation: conversation(id, title, chat, last), messages, unread: 0 });
  };
  addChat(DEFAULT_CHAT_ID, 'Neo', null, [
    [
      ASSISTANT_ID,
      '08:00',
      'Good morning. All five servers ran fine overnight, and the mail summary is in your inbox.',
    ],
  ]);
  addChat(MAIL_CHAT_ID, 'Customer mail every morning', null, [
    [mara.id, '08:30', 'Can you sum up customer mail for me every morning?'],
    [ASSISTANT_ID, '08:31', 'Done. You’ll get a short summary at 08:00 on weekdays.'],
  ]);
  addChat(PVE_CHAT_ID, 'Why is pve-02 so warm?', { kind: 'server', id: 'pve-02', name: 'pve-02' }, [
    [mara.id, '12:14', 'Why is pve-02 so warm?'],
    [
      ASSISTANT_ID,
      '12:20',
      'The backup job and jellyfin ran at the same time and its CPU sat above 75 °C. I moved two busy guests to pve-01; it’s at 61 °C now.',
    ],
  ]);
  addChat(HEAT_CHAT_ID, 'Add our heat pump', null, [
    [
      mara.id,
      '13:20',
      'We have a Daikin Altherma heat pump in the utility room. Can you add it, so I can see it and control it?',
    ],
    [
      ASSISTANT_ID,
      '13:41',
      'It works. I checked what already exists first, then wrote a skill that only reads. Before I change anything, choose what I’m allowed to do.',
      heat,
    ],
  ]);
  addChat(
    DOCKER_CHAT_ID,
    'Clean up Docker on thetitan',
    { kind: 'server', id: 'thetitan', name: 'thetitan' },
    [
      [mara.id, '14:00', 'thetitan is running low on disk. Can you clear out old Docker images?'],
      [
        ASSISTANT_ID,
        '14:02',
        'About 180 GB is unused images. I need your yes to run the cleanup on thetitan.',
        { kind: 'approval', approval: asks.approval() },
      ],
    ],
  );
  addChat(
    HA_CHAT_ID,
    'Remove old Zonneplan entities',
    { kind: 'connection', id: 'con_ha', name: 'Home Assistant' },
    [
      [mara.id, '13:55', 'Home Assistant still lists the old Zonneplan entities. Can you clean them up?'],
      [
        ASSISTANT_ID,
        '13:57',
        'On it. 14 of them aren’t used by anything any more. I’m removing those, then I’ll restart Home Assistant.',
      ],
    ],
  );
  const heatChat = chats.get(HEAT_CHAT_ID);
  if (heatChat) heatChat.unread = 1;
  if (options.si ?? process.env.EXPO_PUBLIC_WHOMBAT_SI === '1')
    addChat(ADD_SERVER_CHAT_ID, 'Add the new Proxmox box', null, [
      [mara.id, '13:30', 'I put a new Proxmox box on the network at 10.100.0.40. Can you add it?'],
      [ASSISTANT_ID, '13:31', '', si.addServerCard()],
    ]);
  let chatSeq = 0;
  // Looks Neo looked into (AP-5925): their threads are in Chat, so they need it.
  const looksOn = options.looks ?? process.env.EXPO_PUBLIC_WHOMBAT_LOOKS === '1';
  // Chat after the fresh start (AP-2460): the default chat is Chat, threaded; Feedback beside it.
  const rooms =
    (options.chat ?? process.env.EXPO_PUBLIC_WHOMBAT_CHAT !== '0')
      ? createChatChannelFixtures({
          now,
          emit,
          setTimer,
          replyDelayMs,
          tasks: options.tasks ?? process.env.EXPO_PUBLIC_WHOMBAT_TASKS === '1',
          watches: options.watches ?? process.env.EXPO_PUBLIC_WHOMBAT_WATCHES === '1',
          signIns: options.signIns ?? process.env.EXPO_PUBLIC_WHOMBAT_SIGNIN === '1',
          councils: options.councils ?? process.env.EXPO_PUBLIC_WHOMBAT_COUNCIL === '1',
          code: options.code ?? ['1', 'jobs'].includes(process.env.EXPO_PUBLIC_WHOMBAT_CODE ?? ''),
          ...delegationOption(options.delegation),
          ...(looksOn ? { threads: lookThreads(ASSISTANT_ID) } : {}),
          assistantId: ASSISTANT_ID,
          assistantName: () => assistant.name,
          chat: () =>
            chats.get(DEFAULT_CHAT_ID)?.conversation ?? conversation(DEFAULT_CHAT_ID, 'Neo', null, null),
          dm: (id, title, last) => conversation(id, title, { title, subject: null, archivedAt: null }, last),
          summaryOf,
          heat: () => heat,
          localModel: () => local.view(),
          json,
          notFound,
          bodyOf,
        })
      : null;
  const looks =
    looksOn && rooms
      ? createLookFixtures({
          now,
          setTimer,
          chatId: DEFAULT_CHAT_ID,
          assistantId: ASSISTANT_ID,
          personId: mara.id,
          reply: rooms.replyInChat,
          working: rooms.setWorking,
          changed: () => emit(`me:${mara.id}`, { type: 'home.changed', parts: ['needsYou', 'things'] }),
        })
      : null;

  const isSnoozed = (key: string) => {
    const until = snoozed.get(key);
    return until !== undefined && Date.parse(until) > now().getTime();
  };

  function needsYou(): NeedsYouItem[] {
    const items: NeedsYouItem[] = [];
    const disk = alerts.find((a) => a.id === 'al_blackbox_md0');
    if (disk && !disk.acknowledged && !isSnoozed('alert:al_blackbox_md0'))
      items.push({
        id: 'hosts.alert:al_blackbox_md0',
        ref: { kind: 'alert', id: 'al_blackbox_md0' },
        kind: 'alert',
        severity: 'bad',
        title: 'blackbox’s disk array failed',
        body: 'Your files have no protection now',
        at: disk.openedAt,
        actions: [
          { id: 'investigate', label: 'Look into it', style: 'primary', kind: 'investigate' },
          { id: 'snooze', label: 'Remind me tomorrow', style: 'secondary', kind: 'snooze' },
        ],
        subject: { kind: 'server', id: 'blackbox', name: 'blackbox' },
      });
    if (!restartDecided && !isSnoozed(`approval:${RESTART_APPROVAL}`))
      items.push({
        id: `approval:${RESTART_APPROVAL}`,
        ref: { kind: 'approval', id: String(RESTART_APPROVAL) },
        kind: 'approval',
        severity: 'warn',
        title: 'Restart arnica-prod-nest-01?',
        body: 'It needs a restart to get its extra memory (4 → 8 GB). It’s down for about 40 seconds.',
        at: at('13:58'),
        actions: [
          { id: 'approve', label: 'Restart now', style: 'primary', kind: 'approve' },
          {
            id: 'later',
            label: 'Tonight at 03:00',
            style: 'secondary',
            kind: 'approve_later',
            at: nextAt(now(), ZONE, '03:00'),
          },
          { id: 'decline', label: 'No', style: 'secondary', kind: 'decline' },
          // An older Whombat's “Not now”: the sheet shows it as the quiet Remind me tomorrow.
          { id: 'snooze', label: 'Not now', style: 'secondary', kind: 'snooze' },
        ],
        subject: { kind: 'server', id: 'pve-02', name: 'pve-02' },
        approvalNumber: RESTART_APPROVAL,
      });
    if (heat.status === 'proposed' && !isSnoozed(`device_skill:${HEAT_PROPOSAL}`))
      items.push({
        id: `device_skill:${HEAT_PROPOSAL}`,
        ref: { kind: 'device_skill', id: HEAT_PROPOSAL },
        kind: 'device_skill',
        severity: 'info',
        title: 'Heat pump: what may I change?',
        body: 'It reads fine already',
        at: at('13:41'),
        actions: [
          {
            id: 'open',
            label: 'Choose',
            style: 'primary',
            kind: 'open',
            href: rooms?.heatHref ?? `/chats/${HEAT_CHAT_ID}`,
          },
        ],
        subject: { kind: 'device', id: HEAT_CONNECTION, name: 'Heat pump' },
      });
    for (const item of si.needsYou()) if (!isSnoozed(`enrollment:${item.ref.id}`)) items.push(item);
    for (const item of looks?.items() ?? [])
      if (!isSnoozed(`${item.ref.kind}:${item.ref.id}`)) items.push(item);
    return items;
  }

  /**
   * Home's chats (contracts 0.91 `HomeOverview.chats`; home-redesign-mobile.md AP-2266): the one Neo works in, those
   * waiting for Mara (the Docker cleanup's approval, the heat pump's choice), then the newest others.
   */
  function homeChats(): HomeChat[] {
    const last = (id: string) => chats.get(id)?.messages.at(-1)?.createdAt ?? at('08:00');
    const title = (id: string) => chats.get(id)?.conversation.chat?.title ?? 'Chat';
    const list: HomeChat[] = [
      {
        conversationId: HA_CHAT_ID,
        title: title(HA_CHAT_ID),
        state: 'working',
        at: last(HA_CHAT_ID),
        progress: { done: 2, total: 4 },
        step: 'Removing the 14 entities',
      },
    ];
    if (asks.approval().state === 'pending')
      list.push({
        conversationId: DOCKER_CHAT_ID,
        title: title(DOCKER_CHAT_ID),
        state: 'waiting',
        at: last(DOCKER_CHAT_ID),
      });
    if (heat.status === 'proposed')
      list.push({
        conversationId: HEAT_CHAT_ID,
        title: title(HEAT_CHAT_ID),
        state: 'waiting',
        at: last(HEAT_CHAT_ID),
      });
    for (const id of [PVE_CHAT_ID, MAIL_CHAT_ID])
      list.push({ conversationId: id, title: title(id), state: 'recent', at: last(id) });
    list.push({
      conversationId: DEFAULT_CHAT_ID,
      title: assistant.name,
      state: 'recent',
      at: last(DEFAULT_CHAT_ID),
      default: true,
    });
    return list;
  }

  function overview(): HomeOverview {
    const items = needsYou();
    return {
      summary: { needsYou: items.length, working: heat.status === 'proposed' ? 1 : 0, problems: 0 },
      needsYou: items,
      // + the service pages' Plex, Seerr, SABnzbd, Protect and Pi-hole when asked for (service-dashboards.md AP-4660).
      // A service page with the id of one of the world's own (a group's UniFi) replaces it.
      things: withServiceThings(
        [...servers.map((s) => serverThing(named(s))), ...otherThings(heat.status === 'on').map(relabelled)],
        listServices ? thingPages.serviceThings() : [],
      ).map(monitoring.withThing),
      automationsToday: [
        { id: 'aut_mail', name: 'Customer mail every morning', state: 'ran', at: at('08:00') },
        { id: 'aut_backup', name: 'Check the backups', state: 'failed', at: at('07:10') },
        { id: 'aut_lights', name: 'Lights off at night', state: 'scheduled', at: at('23:00') },
      ],
      chats: homeChats(),
      widgets: homeParts.widgets(),
      doneRecently: homeParts.doneRecently(),
      // What Neo finished today (status-line.md), a fix of the night among them.
      doneToday: [
        { id: 'dnt_mail', text: 'Wrote replies to 3 customer emails', at: at('09:20') },
        { id: 'dnt_zigbee', text: 'Restarted Zigbee in Home Assistant', at: at('03:12'), fixed: true },
      ],
      arranged: arranging.arranged(),
      generatedAt: now().toISOString(),
    };
  }
  // Arranging the Overview (overview-arranged.md): the layout kept, the tiles' figures made from Home's things.
  const arranging = createOverviewFixtures(() => overview().things);

  function watch(state: 'open' | 'all'): WatchItem[] {
    const items: WatchItem[] = [];
    for (const a of alerts) {
      const until = a.acknowledged?.until ?? null;
      const snoozedNow = until !== null && Date.parse(until) > now().getTime();
      items.push({
        id: `hosts.alert:${a.id}`,
        ref: { kind: 'alert', id: a.id },
        source: 'server',
        severity: a.severity === 'critical' ? 'bad' : 'warn',
        title: a.title,
        body: a.detail,
        at: a.openedAt,
        ...(a.serverId ? { serverId: a.serverId, href: thingHref('server', a.serverId) } : {}),
        state: a.acknowledged ? (snoozedNow ? 'snoozed' : 'acknowledged') : 'open',
        ...(snoozedNow && until ? { snoozedUntil: until } : {}),
      });
    }
    for (const h of HINTS)
      items.push({
        id: `hosts.hint:${h.serverId}:${h.kind}:${h.entity}`,
        ref: { kind: 'hint', id: `${h.serverId}:${h.kind}:${h.entity}` },
        source: 'server',
        severity: 'info',
        title: h.title,
        body: h.detail,
        at: at('10:00'),
        serverId: h.serverId,
        state: 'open',
        href: thingHref('server', h.serverId),
      });
    const automationSnoozed =
      failedAutomationSnoozed !== null && Date.parse(failedAutomationSnoozed) > now().getTime();
    items.push({
      id: 'automation_run:41',
      ref: { kind: 'automation_run', id: '41' },
      source: 'automation',
      severity: 'warn',
      title: 'Check the backups didn’t finish',
      body: 'It couldn’t reach the-falcon at 07:10. It tries again tomorrow.',
      at: at('07:10'),
      state: automationSnoozed ? 'snoozed' : 'open',
      ...(automationSnoozed && failedAutomationSnoozed ? { snoozedUntil: failedAutomationSnoozed } : {}),
      href: '/automations/aut_backup',
    });
    return state === 'open' ? items.filter((i) => i.state === 'open') : items;
  }

  function fleet(): HostFleet {
    const open = alerts.filter((a) => a.state === 'open');
    return {
      asOf: now().toISOString(),
      groups: [{ name: 'Home lab', count: servers.length }],
      kpis: {
        serversOnline: servers.length,
        serversTotal: servers.length,
        cpuAvgPct: 15,
        memoryPct: 56,
        memoryUsedGb: 179.1,
        memoryTotalGb: 320,
        storageUsedTb: 34.4,
        storageTotalTb: 50,
        storagePct: 69,
        disksOver75Wear: 1,
        openAlerts: open.length,
        openAlertsCritical: open.filter((a) => a.severity === 'critical').length,
        openAlertsWarning: open.filter((a) => a.severity === 'warning').length,
      },
      servers: servers.map((s) => ({ ...named(s), asksFirst: asks.of(s.id) })),
      alerts,
      hints: HINTS,
      agentsConnected: servers.length,
      pendingEnrollments: si.pendingCount(),
    };
  }

  function detail(s: HostServer): HostServerDetail {
    const [name = '', version = ''] = (s.os ?? '').split(/ (?=\d)/);
    // thetitan's Incus and blackbox's Unraid: their detail, hints and workloads (AP-1640).
    const { hostsThisWhombat, hints: iuHints = [], ...extra } = iu.detailExtras(s.id);
    // Updates waiting, being installed, waiting for a restart (server-updates-app.md AP-2886).
    return agentsFx.detail(
      updatesFx.detail({
        asOf: now().toISOString(),
        server: {
          id: s.id,
          ...(asks.nameOf(s.id) ? { name: asks.nameOf(s.id) } : {}),
          group: s.group,
          status: s.status,
          statusNote: s.statusNote ?? null,
          roles: [],
          os: { name, version, kernel: s.id === MAC_SERVER ? 'Darwin 26.2.0' : '6.14.11-2-pve' },
          ...(s.osFamily ? { osFamily: s.osFamily } : {}),
          cpu: s.cpu,
          memory: { totalGb: s.memory.totalGb ?? 0, type: 'DDR5' },
          uptimeS: s.uptimeS ?? null,
          lastBoot: at('09:00', -19),
          address: `10.100.1.${10 + servers.indexOf(s)}`,
          location: null,
          agent: { version: s.agent.version, lastSyncSAgo: 4, connected: true },
          platform: s.platform,
          remoteControl: s.remoteControl,
          ...(hostsThisWhombat ? { hostsThisWhombat } : {}),
          asksFirst: asks.of(s.id),
        },
        ...dashboards.detailExtras(s.id),
        banner:
          s.status === 'bad'
            ? {
                severity: 'critical',
                title: 'Disk array failed',
                detail: 'The parity disk is disabled. Replace it soon.',
                section: 'array',
              }
            : null,
        disks: [],
        virtualization: null,
        hints: [...HINTS.filter((h) => h.serverId === s.id), ...iuHints],
        alerts: alerts.filter((a) => a.serverId === s.id),
        ...extra,
        ...(s.id === MAC_SERVER ? { macos: macFx.macos() } : {}),
      }),
    );
  }

  function chatSummaries(archived: boolean, subjectId: string | null): ChatSummary[] {
    return [...chats.values()]
      .filter((c) => !!c.conversation.chat?.archivedAt === archived)
      .filter((c) => !subjectId || c.conversation.chat?.subject?.id === subjectId)
      .map((c) => {
        const last = c.messages.at(-1);
        return {
          id: c.conversation.id,
          title: c.conversation.chat?.title ?? c.conversation.title,
          subject: c.conversation.chat?.subject ?? null,
          lastAt: last?.createdAt ?? null,
          ...(last ? { lastText: last.text.slice(0, 200) } : {}),
          unread: c.unread,
          default: c.conversation.id === DEFAULT_CHAT_ID,
          archivedAt: c.conversation.chat?.archivedAt ?? null,
        };
      })
      .sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
  }

  /** The assistant answers a message in a chat: “thinking” first, then the reply. */
  function answer(chat: ChatState, text: string) {
    const id = chat.conversation.id;
    emit(`conv:${id}`, {
      type: 'typing',
      conversationId: id,
      threadRootId: null,
      principalId: ASSISTANT_ID,
      active: true,
      expiresAt: new Date(now().getTime() + replyDelayMs + 4000).toISOString(),
    });
    setTimer(() => {
      const reply = message(id, ASSISTANT_ID, new Date(now().getTime() + 1000).toISOString(), text);
      chat.messages.push(reply);
      chat.conversation = { ...chat.conversation, lastMessageAt: reply.createdAt };
      emit(`conv:${id}`, { type: 'message.created', message: reply });
    }, replyDelayMs);
  }

  function setHeat(next: DeviceSkillCard) {
    heat = next;
    rooms?.setHeat(next);
    const chat = chats.get(HEAT_CHAT_ID);
    if (!chat) return;
    chat.messages = chat.messages.map((m) => (m.card?.kind === 'device_skill' ? { ...m, card: next } : m));
    const carrying = chat.messages.find((m) => m.card?.kind === 'device_skill');
    if (carrying) emit(`conv:${HEAT_CHAT_ID}`, { type: 'message.updated', message: carrying });
    emit(`me:${mara.id}`, { type: 'home.changed', parts: ['needsYou', 'things', 'working'] });
  }

  function approval(decision: 'approve' | 'decline', executeAt: string | undefined): Approval {
    const base = deployApproval();
    return {
      ...base,
      id: 'apr_restart-arnica',
      number: RESTART_APPROVAL,
      title: 'Restart arnica-prod-nest-01?',
      question: 'Restart arnica-prod-nest-01?',
      target: 'arnica-prod-nest-01 on pve-02',
      state: decision === 'approve' ? 'approved' : 'declined',
      decidedById: mara.id,
      decidedAt: now().toISOString(),
      executeAt: executeAt ?? null,
      conversationId: DEFAULT_CHAT_ID,
      messageId: null,
    };
  }

  const hostsTopic = `hosts:${BURROW_ID}`;
  // A guest's screen: its detail, configuration, snapshots, backups, tasks and backup jobs (AP-1501).
  const guestManage = createGuestManageFixtures({
    now,
    emit,
    setTimer,
    hostsTopic,
    servers,
    guests,
    json,
    notFound,
    bodyOf,
  });

  // studio, a Mac: its screen as the Mac's agent answers it (macos-servers.md MAC-36) and its Find My, on the demo
  // world's clock (a read and a picture take a couple of seconds of it).
  const macFx = createMacFixture(now().getTime(), 'ready', () => now().getTime());
  // Tool tiers set since the demo started, and Find My's timeline, whose assistant switch is `findmy_timeline`'s tier.
  const toolTiers = new Map<string, string>();
  const timelineFx = createFindMyTimelineFixture({
    clock: () => now().getTime(),
    assistantReads: () =>
      (toolTiers.get(`${FIND_MY_CONNECTION_ID}/${FIND_MY_TIMELINE_TOOL.name}`) ?? 'can') === 'can',
  });
  // thetitan's Incus instances and blackbox's Unraid, containers and VMs (incus-unraid-mobile.md AP-1640).
  const iu = createIuFixtures({ now, emit, setTimer, hostsTopic, guests, json, notFound, bodyOf });
  // The servers' Summaries: figures, sensors, storages and history of the dashboards' servers (AP-2135).
  const dashboards = createServerDashboardFixtures(now);
  // A server's updates: the web's fixture world of them behind the phone's endpoints (AP-2886).
  const updatesFx = createUpdatesFixtures({ now, emit, setTimer, hostsTopic, json, bodyOf });
  // Each server's agent keeping up to date, and “Keep server agents up to date” (agent-updates-app.md AP-2993).
  const agentsFx = createAgentUpdatesFixtures({ now, json, bodyOf });
  // The connections' and devices' own pages (connection-pages-mobile.md AP-1966).
  const thingPages = createThingPageFixtures({
    now,
    json,
    notFound,
    bodyOf,
    heatOn: () => heat.status === 'on',
    assistant: () => ({ id: assistant.id, name: assistant.name }),
    heatChatHref: rooms?.heatHref ?? `/chats/${HEAT_CHAT_ID}`,
  });
  // Monitoring (monitoring.md MON-04, MON-07, MON-09, MON-15): things kept quiet, a cause, history and limits.
  const monitoring = createMonitoringFixtures({ now, timeZone: ZONE });
  // Home's Done recently, Everything I did and a pinned panel (home-redesign-mobile.md AP-2266).
  const homeParts = createHomeRedesignFixtures({
    now,
    json,
    notFound,
    changed: (parts) => emit(`me:${mara.id}`, { type: 'home.changed', parts }),
    assistant: () => ({ id: assistant.id, name: assistant.name }),
    chats: { pve: PVE_CHAT_ID, main: DEFAULT_CHAT_ID },
  });

  // Connecting from the phone (phone-connect.md AP-2916): identify, sign in once, the scan, Email (IMAP).
  const connect = createConnectFixtures({ now, json, burrowId: BURROW_ID });

  // Quiet notices on servers (contracts 0.122; quiet-notices-mobile.md AP-4870): Ignore, Remind me tomorrow, Stop
  // watching and What Whombat watches for `server:<id>`, and a server's page read through them (the client's store).
  const hostQuiet = withQuietFixtures((req) => {
    const seg = req.path.split('/').filter(Boolean);
    if (req.method !== 'GET' || seg[0] !== 'servers' || seg.length !== 2) return null;
    const s = servers.find((x) => x.id === decodeURIComponent(seg[1] ?? ''));
    return s ? { status: 200, body: detail(s) } : null;
  });
  /** `things.quiet`, `things.watch` and `things.setWatch` for a server, else null. */
  async function serverQuiet(
    id: string,
    params: Record<string, string>,
    init: RequestInit | undefined,
  ): Promise<Response | null> {
    const thing = parseThingId(params.thing ?? '');
    if (thing?.kind !== 'server') return null;
    const what =
      id === 'things.quiet' ? 'quiet' : id === 'things.watch' || id === 'things.setWatch' ? 'watch' : null;
    if (!what) return null;
    const method = id === 'things.watch' ? 'GET' : 'POST';
    const body = method === 'POST' ? await bodyOf<Record<string, unknown>>(init) : {};
    const answer = hostQuiet.things({ method, serverId: thing.id, what, body });
    // What Whombat watches with the limits of the checks that have one (MON-15).
    const watched =
      what === 'watch' && answer.status === 200
        ? monitoring.withLimits(params.thing ?? '', answer.body as ThingWatch)
        : answer.body;
    return json(watched, answer.status);
  }
  /** Keep quiet, End now, What happened and a server check's limit (monitoring.md), else null. */
  async function monitored(
    id: string,
    params: Record<string, string>,
    init: RequestInit | undefined,
    url: URL,
  ): Promise<Response | null> {
    const thing = params.thing ?? '';
    const changed = () => {
      emit(`me:${mara.id}`, { type: 'home.changed', parts: ['things', 'needsYou', 'watch'] });
      if (thing.startsWith('server:')) emit(`hosts:${BURROW_ID}`, { type: 'hosts.changed' });
    };
    switch (id) {
      case 'things.keepQuiet': {
        const answer = monitoring.keepQuiet(thing, await bodyOf<KeepQuietBody>(init));
        if (answer.status === 200) changed();
        return json(answer.body, answer.status);
      }
      case 'things.endQuiet': {
        const answer = monitoring.endQuiet(thing);
        if (answer.status === 200) changed();
        return json(answer.body, answer.status);
      }
      case 'things.history':
        return json(monitoring.history(thing, Number(url.searchParams.get('days') ?? 30) === 90 ? 90 : 30));
      case 'things.setWatchLimit': {
        const ref = parseThingId(thing);
        const watchOf = () =>
          ref?.kind === 'server'
            ? (hostQuiet.things({ method: 'GET', serverId: ref.id, what: 'watch', body: {} }).body as ThingWatch)
            : null;
        const answer = monitoring.setWatchLimit(thing, await bodyOf<SetThingWatchLimitBody>(init), watchOf);
        return json(answer.body, answer.status);
      }
      case 'changes.undo': {
        const answer = monitoring.undo(params.changeId ?? '');
        return answer ? json(answer.body, answer.status) : null;
      }
      default:
        return null;
    }
  }

  /** The answer for a request this world serves, or null (the rest of the demo world answers). */
  async function handle(
    id: string | undefined,
    params: Record<string, string>,
    init: RequestInit | undefined,
    url: URL,
  ): Promise<Response | null> {
    if (!id) return null;
    const localAnswer = local.handle(id, init) ?? webSearch.handle(id, init);
    if (localAnswer) return localAnswer;
    const watching = await monitored(id, params, init, url);
    if (watching) return watching;
    const pages = await thingPages.handle(id, params, init, url);
    // A page whose look Neo looked into carries what it found (AP-5925); a renamed connection's page its new name; every
    // page its week, and its window or its cause (monitoring.md).
    const research = id === 'things.page' && pages?.ok ? looks?.research(params.thing ?? '') : undefined;
    const ref = id === 'things.page' ? parseThingId(params.thing ?? '') : null;
    const label = ref?.kind === 'connection' ? labels.get(ref.id) : undefined;
    if (pages && id === 'things.page' && pages.ok)
      return json({
        ...monitoring.withPage((await pages.json()) as ThingPage),
        ...(research ? { research } : {}),
        ...(label ? { name: label } : {}),
      });
    if (pages) return pages;
    if (id === 'looks.fix' && looks) {
      const { key } = await bodyOf<{ key: string }>(init);
      const answer = looks.fix(key);
      return json(answer.body, answer.status);
    }
    const quietServer = await serverQuiet(id, params, init);
    if (quietServer) return quietServer;
    const homeAnswer = homeParts.handle(id, params, url);
    if (homeAnswer) return homeAnswer;
    const updating = await updatesFx.handle(id, params, init, url);
    if (updating) return updating;
    const agentUpdating = await agentsFx.handle(id, params, init);
    if (agentUpdating) return agentUpdating;
    const incusUnraid = await iu.handle(id, params, init, url);
    if (incusUnraid) return incusUnraid;
    const managed = await guestManage.handle(id, params, init, url);
    if (managed) return managed;
    const adding = await si.handle(id, params, init, url);
    if (adding) return adding;
    const history = dashboards.handle(id, params, url);
    if (history) return json(history);
    const inRooms = await rooms?.handle(id, params, init, url);
    if (inRooms) return inRooms;
    const connecting = await connect.handle(id, params, init);
    if (connecting) return connecting;
    const conversationId = params.conversationId ?? '';
    const chat = chats.get(conversationId);
    switch (id) {
      case 'home.overview':
        return json(overview());
      // Arranging the Overview (overview-arranged.md): its layout and its tiles' figures.
      case 'overview.arrange': {
        const { layout } = await bodyOf<{ layout: OverviewLayout }>(init);
        const answer = arranging.arrange(layout);
        emit(`me:${mara.id}`, { type: 'home.changed', parts: ['things'] });
        return json(answer);
      }
      case 'overview.views':
        return json(arranging.views(url.searchParams.get('show') ?? ''));
      case 'overview.figures':
        return json(arranging.figures(url.searchParams.get('thing') ?? undefined));
      case 'watch.list':
        return json({ items: watch(url.searchParams.get('state') === 'open' ? 'open' : 'all') });
      case 'needsYou.snooze': {
        const { ref, until } = await bodyOf<{ ref: { kind: string; id: string }; until: string }>(init);
        snoozed.set(`${ref.kind}:${ref.id}`, until);
        if (ref.kind === 'automation_run') failedAutomationSnoozed = until;
        emit(`me:${mara.id}`, { type: 'home.changed', parts: ['needsYou', 'watch'] });
        return json({ ref, snoozedUntil: until });
      }
      case 'needsYou.discuss': {
        // Talk to Neo about it (inbox.md IBX-07): a thread Neo opens with the item's words.
        const { ref } = await bodyOf<{ ref: { kind: string; id: string } }>(init);
        const home = overview();
        const item = (home.needsYouList ?? home.needsYou).find(
          (i) => i.ref.kind === ref.kind && i.ref.id === ref.id,
        );
        if (!item) return notFound('Not in your Inbox any more');
        const text = `${discussHead(item)}\n\nWhat would you like to know or do about it?`;
        if (rooms) return json(rooms.discussInChat(text, item.subject ?? null), 201);
        chatSeq += 1;
        const newId = `cnv_chat-new${chatSeq}`;
        const first = message(newId, ASSISTANT_ID, now().toISOString(), text);
        const title = item.title.slice(0, 60);
        const state: ChatState = {
          conversation: conversation(
            newId,
            title,
            { title, subject: item.subject ?? null, archivedAt: null },
            first.createdAt,
          ),
          messages: [first],
          unread: 0,
        };
        chats.set(newId, state);
        return json({ conversation: state.conversation, message: first }, 201);
      }
      case 'needsYou.ignore': {
        // Ignored for good (ONE-24): a snooze that never ends here; taking it back removes it.
        const { ref, ignored = true } = await bodyOf<{
          ref: { kind: string; id: string };
          ignored?: boolean;
        }>(init);
        if (ignored) snoozed.set(`${ref.kind}:${ref.id}`, '9999-12-31T00:00:00.000Z');
        else snoozed.delete(`${ref.kind}:${ref.id}`);
        emit(`me:${mara.id}`, { type: 'home.changed', parts: ['needsYou', 'watch'] });
        return json({ ref, ignored });
      }
      case 'watch.acknowledge': {
        // Watch again: a snooze or Ignore taken back.
        const { ref, acknowledged = true } = await bodyOf<{
          ref: { kind: string; id: string };
          acknowledged?: boolean;
        }>(init);
        if (acknowledged) snoozed.set(`${ref.kind}:${ref.id}`, '9999-12-31T00:00:00.000Z');
        else snoozed.delete(`${ref.kind}:${ref.id}`);
        if (!acknowledged && ref.kind === 'automation_run') failedAutomationSnoozed = null;
        emit(`me:${mara.id}`, { type: 'home.changed', parts: ['needsYou', 'watch'] });
        return json({ ref, state: acknowledged ? 'acknowledged' : 'open' });
      }
      case 'approvals.get':
        if (Number(params.number) === SERVER_ASKS_APPROVAL)
          return json({ approval: asks.approval(), eventId: null });
        if (Number(params.number) !== RESTART_APPROVAL) return null;
        return json({
          approval: {
            ...approval('approve', undefined),
            state: 'pending',
            decidedById: null,
            decidedAt: null,
          },
          eventId: null,
        });
      case 'approvals.decide': {
        if (Number(params.number) === SERVER_ASKS_APPROVAL) {
          const body = await bodyOf<{ decision: 'approve' | 'decline'; scope?: string }>(init);
          const next = asks.decide(body.decision, body.scope);
          const docker = chats.get(DOCKER_CHAT_ID);
          if (docker) {
            docker.messages = docker.messages.map((m) =>
              m.card?.kind === 'approval' ? { ...m, card: { kind: 'approval', approval: next } } : m,
            );
            const carrying = docker.messages.find((m) => m.card?.kind === 'approval');
            if (carrying) emit(`conv:${DOCKER_CHAT_ID}`, { type: 'message.updated', message: carrying });
          }
          emit(`burrow:${BURROW_ID}`, { type: 'approval.updated', approval: next });
          const beast = servers.find((x) => x.id === 'thetitan');
          if (beast)
            emit(hostsTopic, {
              type: 'hosts.server',
              serverId: beast.id,
              server: { ...named(beast), asksFirst: asks.of(beast.id) },
            });
          return json({ approval: next, eventId: null });
        }
        if (Number(params.number) !== RESTART_APPROVAL) return null;
        const body = await bodyOf<{ decision: 'approve' | 'decline'; executeAt?: string }>(init);
        restartDecided = true;
        emit(`me:${mara.id}`, { type: 'home.changed', parts: ['needsYou'] });
        return json({ approval: approval(body.decision, body.executeAt), eventId: null });
      }
      case 'chats.list': {
        const subjectId = url.searchParams.get('subjectId');
        const archived = ['true', '1'].includes(url.searchParams.get('archived') ?? '');
        return json({ chats: chatSummaries(archived, subjectId) });
      }
      case 'chats.start': {
        const { text, subject } = await bodyOf<{ text: string; subject?: ChatSubject }>(init);
        chatSeq += 1;
        const newId = `cnv_chat-new${chatSeq}`;
        const first = message(newId, mara.id, now().toISOString(), text);
        const title = (text.split('\n').find((l) => l.trim()) ?? 'New chat').trim().slice(0, 60);
        const state: ChatState = {
          conversation: conversation(
            newId,
            title,
            { title, subject: subject ?? null, archivedAt: null },
            first.createdAt,
          ),
          messages: [first],
          unread: 0,
        };
        chats.set(newId, state);
        answer(
          state,
          subject
            ? `I’m looking at ${subject.name} now. I’ll tell you what I find.`
            : 'On it. I’ll tell you when I know more.',
        );
        return json({ conversation: state.conversation, message: first }, 201);
      }
      case 'chats.rename': {
        if (!chat?.conversation.chat) return notFound(`No chat ${conversationId}`);
        const { title } = await bodyOf<{ title: string }>(init);
        chat.conversation = { ...chat.conversation, title, chat: { ...chat.conversation.chat, title } };
        return json({ conversation: chat.conversation });
      }
      case 'chats.archive': {
        if (!chat?.conversation.chat) return notFound(`No chat ${conversationId}`);
        chat.conversation = {
          ...chat.conversation,
          chat: { ...chat.conversation.chat, archivedAt: now().toISOString() },
        };
        return json({ conversation: chat.conversation });
      }
      case 'conversations.get': {
        if (!chat) return null;
        const detailOf: ConversationDetail = {
          conversation: chat.conversation,
          summary: summaryOf(chat.conversation),
          pr: null,
          lastReadMessageId: null,
        };
        return json(detailOf);
      }
      case 'messages.list':
        if (!chat) return null;
        if (url.searchParams.has('before')) return json({ messages: [], before: null, hasMore: false });
        chat.unread = 0;
        return json({ messages: chat.messages, before: null, hasMore: false });
      case 'messages.send': {
        if (!chat) return null;
        const body = await bodyOf<{ text: string; clientId?: string }>(init);
        const sent = {
          ...message(conversationId, mara.id, now().toISOString(), body.text),
          clientId: body.clientId ?? null,
        };
        chat.messages.push(sent);
        chat.conversation = { ...chat.conversation, lastMessageAt: sent.createdAt };
        answer(chat, 'Got it. I’ll come back to you here.');
        return json({ message: sent, dispatches: [] }, 201);
      }
      case 'deviceSkills.decide': {
        if (params.proposalId !== HEAT_PROPOSAL) return notFound('No such skill');
        const body = await bodyOf<{ actions: DeviceSkillCard['decided']; switchOn: boolean }>(init);
        setHeat({
          ...heat,
          status: body.switchOn ? 'on' : 'proposed',
          ...(body.actions ? { decided: body.actions } : {}),
          ...(body.switchOn ? { connectionId: HEAT_CONNECTION } : {}),
        });
        return json({ card: heat, connectionId: body.switchOn ? HEAT_CONNECTION : null });
      }
      case 'deviceSkills.decline':
        if (params.proposalId !== HEAT_PROPOSAL) return notFound('No such skill');
        setHeat({ ...heat, status: 'declined' });
        return json({ card: heat, connectionId: null });
      case 'connections.update': {
        // A label changed where the connection is listed; its fields are the connect fixtures' (none here).
        const id = params.connectionId ?? '';
        const was = labelled(connectionTools(id, heat.status === 'on'));
        if (!was) return null;
        const { label } = await bodyOf<{ label?: unknown }>(init);
        if (label !== undefined) {
          const parsed = ConnectionLabel.safeParse(label);
          if (!parsed.success)
            return json(
              {
                error: {
                  code: 'validation_failed',
                  message: 'Give it a name.',
                  fields: { label: ['Give it a name.'] },
                },
              },
              422,
            );
          labels.set(id, parsed.data);
        }
        emit(`me:${mara.id}`, { type: 'home.changed', parts: ['things'] });
        return json({
          connection: { ...was.connection, label: labels.get(id) ?? was.connection.label },
          eventId: null,
        });
      }
      case 'connections.tools': {
        const tools = labelled(connectionTools(params.connectionId ?? '', heat.status === 'on', toolTiers));
        const made = connect.added().find((c) => c.id === params.connectionId);
        return tools ? json(tools) : made ? json(addedTools(made)) : null;
      }
      // A tool's tier (the Find My timeline's “can read it” switch sets `findmy_timeline`'s).
      case 'connections.setTool': {
        const connectionId = params.connectionId ?? '';
        const was = connectionTools(connectionId, heat.status === 'on', toolTiers);
        if (!was?.tools.some((t) => t.name === params.tool))
          return notFound('That tool isn’t one of this connection’s.');
        const { tier } = await bodyOf<{ tier: string }>(init);
        toolTiers.set(`${connectionId}/${params.tool}`, tier);
        return json(labelled(connectionTools(connectionId, heat.status === 'on', toolTiers)));
      }
      // Find My's timeline (findmy-timeline.md §1): Noor and Ruben kept, on the demo world's clock.
      case 'connections.findMyTimeline':
      case 'connections.findMyTimelineSet':
      case 'connections.findMyTimelineDelete':
      case 'connections.findMyTimelineMap': {
        if (params.connectionId !== FIND_MY_CONNECTION_ID)
          return notFound('That isn’t a Find My connection.');
        const query = Object.fromEntries(url.searchParams);
        const answer =
          id === 'connections.findMyTimeline'
            ? timelineFx.timeline(query)
            : id === 'connections.findMyTimelineSet'
              ? timelineFx.set(await bodyOf<unknown>(init))
              : id === 'connections.findMyTimelineDelete'
                ? timelineFx.remove(await bodyOf<unknown>(init))
                : timelineFx.map(query);
        return json(answer.body, answer.status);
      }
      // Settings → Connections (connections-more-android.md AP-2815): the burrow's catalog connections (Mail is Mara's
      // Google, a device lives on its own page), the catalog's statuses and Mara's own accounts.
      case 'connections.list':
        return json(
          demoConnectionsList([
            ...DEMO_CATALOG_CONNECTIONS.flatMap(
              (id) => labelled(connectionTools(id, false))?.connection ?? [],
            ),
            ...connect.added(),
          ]),
        );
      case 'connections.catalog':
        return json(demoCatalogStatus());
      case 'connectors.status':
        return json(connect.accounts(demoConnectorsStatus()));
      case 'agent.get': {
        const profile: AgentProfile = {
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
        return json(profile);
      }
      case 'agent.setKeys': {
        const body = await bodyOf<{ grants: GrantInput[] }>(init);
        const saved = body.grants.map((g) => ({ ...g, agentId: ASSISTANT_ID }) as Grant);
        const events = diffGrants(grants, saved).map((change, i) => ({
          id: `evt_one-keys-${++keysSeq}-${i}`,
          text: describeGrantChange(assistant.name, change),
        }));
        grants = saved;
        return json({ grants, events });
      }
      case 'agent.update': {
        const body = await bodyOf<{ name?: string; face?: AgentFace; runtime?: AgentModelRuntimeUpdate }>(
          init,
        );
        const name = body.name?.trim();
        // The server's checks (OA-08): not “Whombat”, one capitalised word; there is no other agent to clash with.
        if (name !== undefined) {
          if (isReservedAgentName(name)) return refused('name', AGENT_NAME_RESERVED_TEXT);
          if (!AGENT_NAME_PATTERN.test(name)) return refused('name', AGENT_NAME_FORM_TEXT);
        }
        assistant = {
          ...assistant,
          ...(name !== undefined ? { name } : {}),
          ...(body.face !== undefined ? { face: body.face } : {}),
          // Its model runtime as a whole (ME-01): Runs on and “Make this Neo’s default” (chat-runtime-android.md
          // AP-2732).
          ...(body.runtime ? { runtime: withModelRuntime(assistant.runtime, body.runtime) } : {}),
        };
        if (body.runtime) rooms?.runtime.setDefault(assistant.runtime);
        // Mara's Chat is called after the agent (AN-07).
        const dm = chats.get(DEFAULT_CHAT_ID);
        if (dm && name !== undefined) dm.conversation = { ...dm.conversation, title: name };
        emit(`burrow:${BURROW_ID}`, { type: 'agent.updated', agent: assistant });
        return json({ agent: assistant });
      }
      case 'host.agents':
        // Runs on (AP-2732): Claude Code and ChatGPT ready, with their models, where Chat has its runtime fixtures.
        return rooms ? json(rooms.runtime.agentSetup()) : null;
      case 'hosts.status':
        return json({
          present: true,
          healthy: true,
          version: '0.1.0',
          servers: servers.length,
          canManage: true,
        });
      case 'hosts.fleet':
        return json(fleet());
      case 'hosts.screen':
      case 'hosts.screenLook': {
        if (params.serverId !== MAC_SERVER) return notFound(`${params.serverId} isn’t a Mac`);
        const answer =
          id === 'hosts.screen'
            ? macFx.screen(await bodyOf<Record<string, unknown>>(init))
            : macFx.look(Object.fromEntries(url.searchParams));
        return json(answer.body, answer.status);
      }
      case 'hosts.findMy':
      case 'hosts.findMyRefresh':
      case 'hosts.findMyExact':
      case 'hosts.findMyMap':
      case 'hosts.findMyPicture': {
        if (params.serverId !== MAC_SERVER) return notFound(`${params.serverId} isn’t a Mac`);
        const fm = macFx.findMy;
        const query = Object.fromEntries(url.searchParams);
        const answer =
          id === 'hosts.findMy'
            ? fm.state()
            : id === 'hosts.findMyRefresh'
              ? fm.refresh()
              : id === 'hosts.findMyExact'
                ? fm.exact(await bodyOf<unknown>(init))
                : id === 'hosts.findMyMap'
                  ? fm.map(query)
                  : fm.picture(query);
        return json(answer.body, answer.status);
      }
      case 'hosts.getServer': {
        const s = servers.find((x) => x.id === params.serverId);
        if (!s) return notFound(`No server ${params.serverId}`);
        // Read through what is quiet or not watched (AP-4870).
        const answer = hostQuiet.handle({
          method: 'GET',
          path: `/servers/${encodeURIComponent(s.id)}`,
          query: {},
          body: {},
        });
        return json(monitoring.withServer((answer?.body ?? detail(s)) as HostServerDetail));
      }
      case 'hosts.listGuests': {
        const server = url.searchParams.get('server');
        const list = server ? (guests.get(server) ?? []) : [...guests.values()].flat();
        const count = (state: HostGuest['state']) => list.filter((g) => g.state === state).length;
        return json({
          guests: list,
          total: list.length,
          nextCursor: null,
          counts: {
            all: list.length,
            running: count('running'),
            stopped: count('stopped'),
            unhealthy: count('unhealthy'),
          },
        });
      }
      case 'hosts.guestAction': {
        const list = guests.get(params.serverId ?? '') ?? [];
        const guest = list.find((g) => g.id === params.guestId);
        if (!guest) return notFound(`No guest ${params.guestId}`);
        const { action } = await bodyOf<{ action: string }>(init);
        const nextState: HostGuest['state'] | null =
          action === 'start' || action === 'resume' || action === 'reboot' || action === 'restart'
            ? 'running'
            : action === 'pause'
              ? 'paused'
              : action === 'shutdown' || action === 'stop' || action === 'force_stop'
                ? 'stopped'
                : null;
        const noop = nextState === guest.state && action !== 'reboot' && action !== 'restart';
        setTimer(() => {
          if (!nextState) return;
          const at2 = list.indexOf(guest);
          const on = nextState === 'running';
          list[at2] = {
            ...guest,
            state: nextState,
            cpuPct: on ? (guest.cpuPct ?? 2) : null,
            memoryUsedMb: nextState === 'stopped' ? null : (guest.memoryUsedMb ?? 512),
            uptimeS: on ? 5 : 0,
          };
          emit(hostsTopic, {
            type: 'hosts.guest',
            serverId: guest.serverId,
            guestId: guest.id,
            state: nextState,
          });
          emit(hostsTopic, {
            type: 'hosts.task',
            serverId: guest.serverId,
            guestId: guest.id,
            actionId: `act_${guest.vmid ?? 0}_${action}`,
            op: action,
            result: 'ok',
          });
        }, 1200);
        return json({ actionId: `act_${guest.vmid ?? 0}_${action}`, ...(noop ? { noop: true } : {}) }, 202);
      }
      case 'hosts.ackAlert': {
        const a = alerts.find((x) => x.id === params.alertId);
        if (!a) return notFound(`No alert ${params.alertId}`);
        const { minutes = 0, note = '' } = await bodyOf<{ minutes?: number; note?: string }>(init);
        a.acknowledged = {
          at: now().toISOString(),
          by: 'Mara Okafor',
          note,
          until: minutes > 0 ? new Date(now().getTime() + minutes * 60_000).toISOString() : null,
        };
        a.attention = false;
        emit(`me:${mara.id}`, { type: 'home.changed', parts: ['needsYou', 'watch'] });
        return json(a);
      }
      case 'hosts.serverSettings': {
        const s = servers.find((x) => x.id === params.serverId);
        return s
          ? json(agentsFx.settings(asks.settings(s.id, s.group)))
          : notFound(`No server ${params.serverId}`);
      }
      case 'hosts.updateServer': {
        const s = servers.find((x) => x.id === params.serverId);
        if (!s) return notFound(`No server ${params.serverId}`);
        const problem = asks.patch(
          s.id,
          await bodyOf<HostServerSettingsPatch>(init),
          servers.map((x) => x.id),
        );
        if (problem) {
          const taken = problem === SERVER_NAME_TAKEN;
          return json(
            {
              error: {
                code: taken ? 'conflict' : 'validation_failed',
                message: problem,
                fields: { name: [problem] },
              },
            },
            taken ? 409 : 422,
          );
        }
        return json(asks.settings(s.id, s.group));
      }
      // Settings → AI's provider cards (less-is-more.md AP-1814): Mara signed in to Claude Code with her subscription,
      // not to ChatGPT; Claude Code the one client on this Whombat (ChatGPT needs none, chatgpt-no-client.md AP-5619).
      // Her usage is the demo world's (`usage.list`).
      case 'signins.list':
        return json({
          signIns: [
            {
              provider: 'claude',
              authMode: 'subscription_cli',
              ownerAccountId: 'acc_mara',
              createdAt: at('09:00', -30),
              expiresAt: null,
              verified: 'valid',
              login: 'mara@lumio.example',
              state: 'ready',
              explanation: null,
            },
          ],
          logins: [],
          modes: [],
          consoles: [],
        });
      case 'clients.list':
        return json({
          clients: [
            {
              provider: 'claude',
              installed: { version: '2.1.40', installedAt: at('09:00', -6), source: 'whombat' },
              latest: null,
              state: 'installed',
              progress: null,
              error: null,
            },
          ],
          checkedAt: at('10:22'),
          canManage: true,
        });
      case 'hosts.unackAlert': {
        const a = alerts.find((x) => x.id === params.alertId);
        if (!a) return notFound(`No alert ${params.alertId}`);
        a.acknowledged = null;
        a.attention = true;
        emit(`me:${mara.id}`, { type: 'home.changed', parts: ['needsYou', 'watch'] });
        return json(a);
      }
      default:
        return null;
    }
  }

  return {
    handle,
    /** The agent's name as this world has it now (a rename in Settings → Agent). */
    agentName: () => assistant.name,
    /** A read the rest of the demo world answered, as this world has it: Mara's SSH keys in the Vault (AP-1714). */
    after(id: string | undefined, data: unknown): unknown {
      if (id === 'vault.list' && data && typeof data === 'object' && 'entries' in data)
        return { ...data, entries: si.vaultEntries((data as { entries: VaultEntry[] }).entries) };
      if (id === 'burrows.get' && data && typeof data === 'object' && 'burrow' in data)
        return {
          ...data,
          burrow: webSearch.burrow(
            local.burrow((data as { burrow: { localModel?: null; webSearch?: null } }).burrow),
          ),
        };
      return data;
    },
    /**
     * The bootstrap of this world: Neo as the burrow's one agent (OA-01), Mara's Chat and Feedback room as her rooms
     * with it (OA-04; only Chat without the threaded rooms), the burrow Lumio.
     */
    bootstrap<
      B extends { burrow: { name: string }; principals: unknown[]; sidebar: { dms: ConversationSummary[] } },
    >(b: B): B {
      const dm = chats.get(DEFAULT_CHAT_ID);
      const principals = (b.principals as Principal[]).map((p) => (p.id === assistant.id ? assistant : p));
      return {
        ...b,
        burrow: { ...b.burrow, name: 'Lumio', localModel: local.view(), webSearch: webSearch.view() },
        principals: principals.some((p) => p.id === assistant.id) ? principals : [...principals, assistant],
        sidebar: {
          ...b.sidebar,
          dms: rooms ? rooms.summaries() : dm ? [summaryOf(dm.conversation)] : [],
        },
      };
    },
  };
}

/** The item in a sentence or two, named by its thing, as the Whombat's opener of a Talk thread says it. */
function discussHead(item: { title: string; body: string; subject?: { name: string } }): string {
  const sentence = (t: string) => (/[.?!…]$/.test(t) ? t : `${t}.`);
  const name = item.subject?.name;
  const head = name && !item.title.includes(name) ? `${name}: ${item.title}` : item.title;
  return [sentence(head), item.body.trim() ? sentence(item.body.trim()) : ''].filter(Boolean).join(' ');
}
