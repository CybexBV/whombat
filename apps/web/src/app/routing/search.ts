/**
 * Typed search params for every route (ARCHITECTURE "Web app"). Validators are forgiving: unknown or
 * malformed values are dropped rather than failing the route, so an old or hand-edited link still opens.
 */

import {
  type AdvancedPart,
  type AgentGroupPart,
  agentPartPlace,
  isAdvancedPart,
  isAgentGroupPart,
  isMovedAdvancedPart,
  isYouPart,
  type MovedAdvancedPart,
  SETTINGS_GROUPS,
  type SettingsGroup,
  type SettingsPlace,
  whombatSectionPlace,
  type YouPart,
} from '@whombat/client';
import {
  AuditActorFilter,
  AuditKindFilter,
  ConnectErrorCode,
  type ConnectionAccessLevel,
  ConnectionConnectError,
  ConnectorProvider,
  catalogEntry,
  connectAccessOf,
  connectReturnPathOf,
  normalizeFilesFolder,
  SearchFilter,
} from '@whombat/core';
import { type AgentPart, validateAgentKey, validateAgentPart } from '../../features/agent/parts';
import { type ScreenPart, validateScreenPart } from '../../features/desk/screenTab';
import { parseSearchFilters, type SearchFilterValues } from '../../features/search/searchFilters';

type Raw = Record<string, unknown>;

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function flag(value: unknown): true | undefined {
  return value === true || value === 1 || value === '1' || value === 'true' ? true : undefined;
}

/** Drops undefined keys so URLs stay clean (`?thread=` never appears empty). */
function clean<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Every burrow route: `?approval=<number>` opens the approval modal over the page; `?burrow=<slug>` opens that burrow
 * first and is then taken out of the address (AP-361).
 */
export interface BurrowSearch {
  approval?: number;
  burrow?: string;
}
export function validateBurrowSearch(raw: Raw): BurrowSearch {
  return clean({ approval: positiveInt(raw.approval), burrow: str(raw.burrow) });
}

/**
 * A conversation (Chat, Feedback, a task chat, a branch room): `?thread=<msgId>` opens the thread pane, `&focus=1` shows
 * it full width instead of the conversation (docs/decisions/ui-improvements.md AP-304); `?plan=<planId>` the plan pane,
 * `&step=<stepId>` focusing one step (work-supervision WS-09); `?pins=1` the pinned messages (essentials-messages.md
 * AP-445). One pane at a time: a plan wins, then the plans list, the pins, then a thread.
 */
export interface ConversationSearch {
  thread?: string;
  /** Only with `thread`: the thread in focus mode. `1`, so the address reads `&focus=1`. */
  focus?: 1;
  plan?: string;
  step?: string;
  /** `?plans=1`: the conversation's plans, in the right pane (the header's “Plans”). */
  plans?: true;
  /** `?pins=1`: the conversation's pinned messages, in the right pane (the header's “Pinned · N”). `1`, like `focus`. */
  pins?: 1;
}
/**
 * Chat and Feedback (chat-channel.md AP-2401; chat-settle.md AP-6252): a conversation's search, `?settled=1` for the
 * room's settled threads in the right pane (a thread wins over it, so a row of the list opens its thread), and `?new=1`
 * for the room's new chat (chat-inbox-web.md), which a pane or the settled threads win over.
 */
export interface RoomSearch extends ConversationSearch {
  settled?: 1;
  new?: 1;
}
export function validateRoomSearch(raw: Raw): RoomSearch {
  const base = validateConversationSearch(raw);
  const pane = base.thread || base.plan || base.plans || base.pins;
  const settled = !pane && flag(raw.settled) ? (1 as const) : undefined;
  return clean({ ...base, settled, new: !pane && !settled && flag(raw.new) ? (1 as const) : undefined });
}

export function validateConversationSearch(raw: Raw): ConversationSearch {
  const plan = id(raw.plan, 'pln_');
  const plans = plan ? undefined : flag(raw.plans);
  const pins = plan || plans ? undefined : flag(raw.pins) && (1 as const);
  const thread = plan || plans || pins ? undefined : str(raw.thread);
  return clean({
    thread,
    focus: thread && flag(raw.focus) ? (1 as const) : undefined,
    plan,
    step: plan ? id(raw.step, 'stp_') : undefined,
    plans,
    pins,
  });
}

/** An address to start a connect form with (`&url=`): http(s), one line, at most 300 characters. */
function address(value: unknown): string | undefined {
  const s = str(value)?.trim();
  return s && s.length <= 300 && /^https?:\/\/[^\s]+$/i.test(s) ? s : undefined;
}

/** An id with its prefix (`pln_…`), short enough for a URL; anything else is dropped. */
function id(value: unknown, prefix: string): string | undefined {
  const s = str(value);
  return s?.startsWith(prefix) && s.length <= 80 && /^[A-Za-z0-9_-]+$/.test(s) ? s : undefined;
}

export type BranchTab = 'conversation' | 'files';
/**
 * Branch room: `?repo=owner/name` names the room's repository (a PR number is unique only within its repo, essentials
 * item 5, AP-496); `?tab=files` shows Files changed, `&file=<path>` one of its files whole (the file view, AP-664).
 */
export interface BranchSearch extends ConversationSearch {
  repo?: string;
  tab?: BranchTab;
  file?: string;
}
export function validateBranchSearch(raw: Raw): BranchSearch {
  const tab = raw.tab === 'files' || raw.tab === 'conversation' ? raw.tab : undefined;
  const repo =
    typeof raw.repo === 'string' &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.repo) &&
    raw.repo.length <= 200
      ? raw.repo
      : undefined;
  // A repository path as git writes it: no control characters, at most the contract's 4096.
  const file =
    tab === 'files' && typeof raw.file === 'string' && raw.file.length <= 4096 && !/\p{Cc}/u.test(raw.file)
      ? raw.file || undefined
      : undefined;
  return clean({
    repo,
    ...validateConversationSearch(raw),
    tab: tab === 'conversation' ? undefined : tab,
    file,
  });
}

/**
 * Settings' pages, the tabs (settings-groups.md, sidebar-tabs.md; `@whombat/client`'s `SETTINGS_GROUPS`): You (no
 * `?tab=`), the assistant (`agent`), Connections (`connections`), This Whombat (`appliance`) and Advanced
 * (`advanced`), and Often used's Phone app (`phone`; settings-phone-link.md SPL-23).
 */
export type SettingsTab = SettingsGroup | 'phone';

export const SETTINGS_TABS: readonly SettingsTab[] = [...SETTINGS_GROUPS, 'phone'];

/**
 * Tabs Settings had before, still taken from old links and redirected (SS-02): `profile`, `general`, `about`,
 * `notifications`, `usage`, `spend`, `repos` (and `dev`), `feedback`, `devices`, `packs`, `skills`, `ai` and `screen`;
 * `vault` goes to `/vault` (AP-671). `connections` is a tab again, but its pages (`&connection=`) still move.
 */
export type LegacySettingsTab =
  | 'profile'
  | 'general'
  | 'about'
  | 'notifications'
  | 'usage'
  | 'spend'
  | 'repos'
  | 'dev'
  | 'feedback'
  | 'devices'
  | 'packs'
  | 'skills'
  | 'ai'
  | 'screen'
  | 'vault';

const LEGACY_SETTINGS_TABS: readonly LegacySettingsTab[] = [
  'profile',
  'general',
  'about',
  'notifications',
  'usage',
  'spend',
  'repos',
  'dev',
  'feedback',
  'devices',
  'packs',
  'skills',
  'ai',
  'screen',
  'vault',
];

/**
 * A builtin page of the connections (`&connection=`): a connector provider (Google, Microsoft 365, Email (IMAP):
 * connections-more-web.md AP-2765), GitHub or Website feedback (SS-05).
 */
export type ConnectionPage = ConnectorProvider | 'github' | 'feedback';

/**
 * Any page of the connections (`&connection=`): a builtin's, a catalog entry's connect page (`homeassistant`,
 * connections-catalog.md CX-71, AP-758) — with `&id=con_…` one of its connections (CX-72) — or Add a connection
 * (`add`, connections-redesign.md AP-1157). They open on the Connections page (`/connections?connection=…`);
 * GitHub's and Website feedback's are Settings → Advanced's.
 */
export type ConnectionsPage = ConnectionPage | 'add' | (string & {});

function isBuiltinPage(value: unknown): value is ConnectionPage {
  return (
    value === 'github' ||
    value === 'feedback' ||
    value === 'imap' ||
    ConnectorProvider.safeParse(value).success
  );
}

/** A catalog entry's id (`homeassistant`), builtin or not; unknown ids are dropped. */
function catalogId(value: unknown): string | undefined {
  return typeof value === 'string' && catalogEntry(value) ? value : undefined;
}

/** `&part=` of every tab, and of the old ones until they are redirected. */
export type SettingsPart =
  | YouPart
  | Exclude<AgentGroupPart, 'profile'>
  | AdvancedPart
  | MovedAdvancedPart
  | Exclude<AgentPart, 'profile'>
  | 'skills'
  | Exclude<ScreenPart, 'shows'>;

/**
 * Settings: `?tab=` one of the four (You without one), an old tab until it is redirected (SS-02).
 * A sign-in elsewhere comes back with `?connected=google` or `?connect_error=<code>` (docs/decisions/connectors.md
 * CN-04), redirected to the Connections page with it.
 */
export interface SettingsSearch {
  tab?: Exclude<SettingsTab, 'you'> | LegacySettingsTab;
  /** Google's or Microsoft's `connected=google`; a catalog entry's after its sign-in (`connected=homeassistant`, CX-15). */
  connected?: string;
  /** Google's codes, and a catalog sign-in's (`ConnectionConnectError`, CT-269). */
  connect_error?: ConnectErrorCode | ConnectionConnectError;
  /** Only to carry an open entry to `/vault` (`?tab=vault&entry=vlt_…`, AP-111, AP-671). */
  entry?: string;
  /** The old Connections tab's page (`?tab=connections&connection=github`, AP-673, SS-05), redirected. */
  connection?: ConnectionsPage;
  /** One catalog connection (`&connection=homeassistant&id=con_…`, CX-72, AP-758). */
  id?: string;
  /**
   * A catalog entry's connect page with its address filled in (`&connection=proxmox&url=https://…`, from Found on your
   * network; CS-51, AP-846).
   */
  url?: string;
  /** The access level chosen by the assistant's card (`&access=read|manage`). */
  access?: ConnectionAccessLevel;
  /** Where to return after connecting (`&returnTo=`, e.g. back to the assistant card's thread). */
  returnTo?: string;
  /**
   * Add a connection showing only On your network (`?tab=connections&found=1`, the link the assistant posts after the
   * first scan; Whombat desk-found.md DF-05, AP-3801). Taken alone or with `connection=add`; another page wins.
   */
  found?: true;
  /** This Whombat: the part that is open (`?tab=appliance&section=backups`, AP-1221); the Overview without. */
  section?: Exclude<WhombatTabPart, 'overview'> | 'devices' | 'access';
  /**
   * The part of the tab that is open (`?part=notifications`, `?tab=agent&part=may`, `?tab=advanced&part=model`); the
   * first without (Advanced: its list). An old Agent or Advanced part (`?tab=agent&part=keys`) until it is redirected. This
   * Whombat → Screen's part (`?tab=appliance&section=screen&part=lock`); What it shows without.
   */
  part?: SettingsPart;
  /** What it may do → KEYS: a key row to show (`&key=deploy`, a skill's “Turn on …” link, AP-250). */
  key?: string;
  /** Screens: a screen's own page (`?tab=appliance&section=screen&screen=scr_…`, AP-5941); the list without. */
  screen?: string;
  /**
   * Backups: bringing a Whombat back, where it stands (the Inbox's Finish, `&finish=restore`, and Try again,
   * `&restore=again`; Whombat backup-options.md BKO-28, BKO-34): the app opens the bring back flow.
   */
  finish?: 'restore';
  restore?: 'again';
}

/** This Whombat's parts on the web: the Overview, Backups, the box's screen and About. */
export type WhombatTabPart = 'overview' | 'backups' | 'screen' | 'about';
const WHOMBAT_TAB_PARTS: readonly WhombatTabPart[] = ['overview', 'backups', 'screen', 'about'];

/** A screen's id as Settings → Screens names it (the contract's `DESK_SCREEN_ID_RE`). */
const SCREEN_ID = /^(box|out_[a-z0-9-]{1,40}|scr_[A-Za-z0-9_-]{8,40})$/;

/** `&part=` as the tab reads it. */
function settingsPart(tab: SettingsSearch['tab'], section: unknown, raw: unknown): SettingsPart | undefined {
  switch (tab) {
    case undefined:
      // Profile stays named: without a part `/settings` is the home.
      return isYouPart(raw) ? raw : undefined;
    case 'notifications':
    case 'devices':
      return isYouPart(raw) && raw !== 'profile' ? raw : undefined;
    case 'agent':
      if (raw === 'skills') return 'skills';
      return isAgentGroupPart(raw) && raw !== 'profile' ? raw : validateAgentPart(raw);
    case 'advanced':
      // A page that moved out of Advanced, until it is redirected to where it is now.
      if (isMovedAdvancedPart(raw)) return raw;
      return isAdvancedPart(raw) ? raw : undefined;
    case 'screen':
      return validateScreenPart(raw);
    case 'appliance':
      return section === 'screen' ? validateScreenPart(raw) : undefined;
    default:
      return undefined;
  }
}

export function validateSettingsSearch(raw: Raw): SettingsSearch {
  const asked = raw.tab;
  const tab =
    asked === 'you'
      ? undefined
      : (SETTINGS_TABS as readonly unknown[]).includes(asked) ||
          (LEGACY_SETTINGS_TABS as readonly unknown[]).includes(asked)
        ? (asked as Exclude<SettingsTab, 'you'> | LegacySettingsTab)
        : undefined;
  const error = ConnectErrorCode.or(ConnectionConnectError).safeParse(raw.connect_error);
  // A catalog sign-in comes back with `connected=<catalogId>&connection=<con_…>` (CT-269): the connection's id may stand
  // where the page is, or next to it when the return path kept the page (AP-758).
  const values = Array.isArray(raw.connection) ? raw.connection : [raw.connection];
  const page = values.find((v) => v === 'add' || isBuiltinPage(v) || catalogId(v) !== undefined) as
    | string
    | undefined;
  const returned = values.map((v) => id(v, 'con_')).find(Boolean);
  const connected = isBuiltinPage(raw.connected) ? raw.connected : catalogId(raw.connected);
  const connectionId = id(raw.id, 'con_') ?? returned;
  const returnedTo = page ?? (connectionId && connected && !isBuiltinPage(connected) ? connected : undefined);
  // `found=1` is Add a connection at On your network (AP-3801): `connection=add` stands for it in the search.
  const found =
    tab === 'connections' && flag(raw.found) && (returnedTo ?? 'add') === 'add' ? true : undefined;
  const open = found ? 'add' : returnedTo;
  const section =
    tab === 'appliance'
      ? raw.section === 'devices' || raw.section === 'access'
        ? raw.section
        : (WHOMBAT_TAB_PARTS as readonly unknown[]).includes(raw.section) && raw.section !== 'overview'
          ? (raw.section as Exclude<WhombatTabPart, 'overview'>)
          : undefined
      : undefined;
  const part = settingsPart(tab, section, raw.part);
  const screens = tab === 'screen' || (tab === 'appliance' && section === 'screen');
  return clean({
    tab,
    connected,
    connect_error: error.success ? error.data : undefined,
    entry: tab === 'vault' ? id(raw.entry, 'vlt_') : undefined,
    connection: tab === 'connections' ? open : undefined,
    id: tab === 'connections' && open && open !== 'add' && !isBuiltinPage(open) ? connectionId : undefined,
    url:
      tab === 'connections' && open && open !== 'add' && !isBuiltinPage(open) && !connectionId
        ? address(raw.url)
        : undefined,
    access:
      tab === 'connections' && open && open !== 'add' && !isBuiltinPage(open) && !connectionId
        ? (connectAccessOf(raw.access) ?? undefined)
        : undefined,
    returnTo:
      tab === 'connections' && open && open !== 'add' && !isBuiltinPage(open)
        ? (connectReturnPathOf(raw.returnTo) ?? undefined)
        : undefined,
    found,
    section,
    part,
    key:
      (tab === 'agent' && (part === 'keys' || part === 'may')) || (tab === 'advanced' && part === 'keys')
        ? validateAgentKey(raw.key)
        : undefined,
    screen: screens && typeof raw.screen === 'string' && SCREEN_ID.test(raw.screen) ? raw.screen : undefined,
    finish: section === 'backups' && raw.finish === 'restore' ? 'restore' : undefined,
    restore: section === 'backups' && raw.restore === 'again' ? 'again' : undefined,
  });
}

/** The tab Settings shows for `?tab=`: one of the five; You without one (an old tab is redirected first, SS-02). */
export function currentSettingsTab(tab: SettingsSearch['tab']): SettingsTab {
  return tab && (SETTINGS_TABS as readonly string[]).includes(tab) ? (tab as SettingsTab) : 'you';
}

/** This Whombat's part for `&section=`: the Overview without one. */
export function currentWhombatPart(section: SettingsSearch['section']): WhombatTabPart {
  return section && (WHOMBAT_TAB_PARTS as readonly string[]).includes(section)
    ? (section as WhombatTabPart)
    : 'overview';
}

/** The local network switch's place on What the assistant may do: the Vault's line and old addresses land there. */
export const LOCAL_NETWORK_ANCHOR = 'local-network';

/** Where an old Settings address goes (SS-02): a path, its search and hash. */
export interface SettingsRedirect {
  to: '/settings' | '/vault' | '/connections' | '/automations';
  /** A flag is the number 1, so the address reads `found=1` (a string “1” would be written `found="1"`). */
  search: Record<string, string | number>;
  hash?: string;
}

/**
 * The new address of an old Settings link (SS-02), or null when it is current. The tabs before the four groups:
 * Profile is You, Notifications and Devices You's parts, About you and Notes the assistant's Memory, AI its AI sign-in
 * (`#clients` and `#spend` Advanced's), Skills and Spend Advanced's pages, GitHub and Website feedback connections,
 * Screen a part of This Whombat; This Whombat's Devices is You's and the assistant's access its What it may do; the old
 * Agent parts (model, what runs, spend) Advanced's, its keys What it may do. The Connections tab's pages open on the
 * Connections page's address (Add a connection, a catalog entry's page, GitHub, Google, Microsoft, Email, Website
 * feedback). Advanced's pages that moved go where they are now. The route redirects with
 * `replace`.
 */
export function settingsRedirect(search: SettingsSearch, hash = ''): SettingsRedirect | null {
  const keep = (rest: Record<string, string | number | undefined>) =>
    Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Record<
      string,
      string | number
    >;
  const outcome = keep({ connected: search.connected, connect_error: search.connect_error });
  // You's first part is named, since `/settings` alone is the home (final-settings-vault-files-usage.md).
  const at = (place: SettingsPlace, extra: Record<string, string | undefined> = {}): SettingsRedirect => ({
    to: '/settings',
    search: keep({
      tab: place.group === 'you' ? undefined : place.group,
      part: place.part ?? (place.group === 'you' ? 'profile' : undefined),
      ...extra,
    }),
    ...(place.hash ? { hash: place.hash } : {}),
  });
  const withHash = (hashOf: string) => (hashOf ? { hash: hashOf } : {});
  const sent = Object.keys(outcome).length > 0;
  switch (search.tab) {
    case 'profile':
    case 'general':
      if (sent) return { to: '/connections', search: { connection: 'google', ...outcome } };
      return hash === 'about-you' ? at({ group: 'agent', part: 'memory' }) : at({ group: 'you' });
    case 'about':
      return at({ group: 'agent', part: 'memory' });
    case 'notifications':
      return at({ group: 'you', part: 'notifications' });
    case 'devices':
      return { ...at({ group: 'you', part: 'devices' }), ...withHash(hash) };
    case 'usage':
      return at({ group: 'agent', part: 'ai' });
    case 'spend':
      return at({ group: 'advanced', part: 'spend' });
    case 'repos':
    case 'dev':
      return { to: '/connections', search: { connection: 'github' } };
    case 'feedback':
      return { to: '/connections', search: { connection: 'feedback' } };
    case 'packs':
    case 'skills':
      return { ...at({ group: 'advanced', part: 'skills' }), ...withHash(hash) };
    case 'ai':
      // `#clients` still opens what is on this Whombat (the shell's “Set up AI provider”).
      if (hash === 'clients') return at({ group: 'advanced', part: 'ai', hash: 'clients' });
      if (hash === 'spend') return at({ group: 'advanced', part: 'spend' });
      return at({ group: 'agent', part: 'ai' });
    case 'screen':
      return at({ group: 'appliance' }, { section: 'screen', part: search.part, screen: search.screen });
    case 'connections': {
      const page = search.connection;
      // The tab itself is current: the restore's “Open Connections” lands on NEEDS YOU (`#connections-needs`).
      if (!page && !sent) return null;
      return {
        to: '/connections',
        search: keep({
          connection: page ?? (search.connect_error ? 'google' : search.connected),
          id: search.id,
          url: search.url,
          access: search.access,
          returnTo: search.returnTo,
          found: search.found ? 1 : undefined,
          ...outcome,
        }),
      };
    }
    case 'appliance': {
      if (hash === 'screen') return at({ group: 'appliance' }, { section: 'screen' });
      const moved = whombatSectionPlace(search.section ?? (hash === 'devices' ? 'devices' : undefined));
      return moved ? { ...at(moved), ...withHash(hash === 'devices' ? '' : hash) } : null;
    }
    case 'advanced':
      switch (search.part) {
        // Advanced's old list of every connection is the Connections group.
        case 'accounts':
          return { ...at({ group: 'connections' }), ...withHash(hash) };
        // The keys and the commands always allowed, and the home network ranges under the local network switch.
        case 'keys':
          return at({ group: 'agent', part: 'may' }, { key: search.key });
        case 'network':
          return { ...at({ group: 'agent', part: 'may' }), hash: LOCAL_NETWORK_ANCHOR };
        // The assistant's own schedules are listed with the automations.
        case 'schedules':
          return { to: '/automations', search: {} };
        case 'github':
        case 'feedback':
          return { to: '/connections', search: { connection: search.part } };
        default:
          return null;
      }
    case 'agent': {
      const place = agentPartPlace(search.part);
      // A part of its own stays; Notes is in Memory now.
      if (place.group === 'agent' && place.part === search.part) return null;
      return { ...at(place, { key: search.key }), ...withHash(hash) };
    }
    case 'vault':
      return { to: '/vault', search: keep({ entry: search.entry }) };
    case undefined:
      if (hash === 'ai-provider') return at({ group: 'agent', part: 'ai' });
      if (hash === 'about-you') return at({ group: 'agent', part: 'memory' });
      return null;
    default:
      return null;
  }
}

/**
 * Whether `/settings` opens its home (Often used and the five groups): nothing after it — no group, part, section,
 * place in the page or a sign-in coming back. Every older “You” address names its part.
 */
export function settingsHome(search: SettingsSearch, hash = ''): boolean {
  return (
    !search.tab &&
    !search.part &&
    !search.section &&
    !search.connected &&
    !search.connect_error &&
    hash.replace(/^#/, '') === ''
  );
}

/**
 * The Vault (`/vault`, AP-671): `?entry=vlt_…` shows that entry open (AP-111); `?add=1` opens Add to Vault (the sidebar's
 * right-click menu, chat-clear.md AP-4507).
 */
export interface VaultSearch {
  entry?: string;
  add?: 1;
}
export function validateVaultSearch(raw: Raw): VaultSearch {
  return clean({ entry: id(raw.entry, 'vlt_'), add: flag(raw.add) && (1 as const) });
}

/** Automations (`/automations`): `?new=1` puts the focus in the field that asks the agent (the sidebar's menu). */
export interface AutomationsSearch {
  new?: 1;
}
export function validateAutomationsSearch(raw: Raw): AutomationsSearch {
  return clean({ new: flag(raw.new) && (1 as const) });
}

/** Audit log filters: `?actor=&kind=&who=&open=` (lowercase values, see core `audit/log.ts`). */
export interface LogSearch {
  actor?: AuditActorFilter;
  kind?: AuditKindFilter;
  /** Agent or person handle ("Only Banjo"). */
  who?: string;
  /** Expanded event id (`evt_9f18`). */
  open?: string;
}
export function validateLogSearch(raw: Raw): LogSearch {
  const actor = AuditActorFilter.safeParse(raw.actor);
  const kind = AuditKindFilter.safeParse(raw.kind);
  return clean({
    actor: actor.success && actor.data !== 'everyone' ? actor.data : undefined,
    kind: kind.success && kind.data !== 'all' ? kind.data : undefined,
    who: str(raw.who),
    open: str(raw.open),
  });
}

/**
 * Search: `?q=&type=`, and the filters `&from=<handle>&in=<conversation>&after=<day>&before=<day>` (contracts CT-180;
 * essentials-messages.md AP-448).
 */
export interface SearchSearch extends SearchFilterValues {
  q?: string;
  type?: SearchFilter;
}
export function validateSearchSearch(raw: Raw): SearchSearch {
  const type = SearchFilter.safeParse(raw.type);
  return clean({
    q: typeof raw.q === 'string' ? raw.q : str(raw.q),
    type: type.success && type.data !== 'all' ? type.data : undefined,
    ...parseSearchFilters(raw),
  });
}

/** Onboarding: `?burrow=&step=` (resume a burrow being set up, e.g. after a reload). */
export interface OnboardingSearch {
  burrow?: string;
  step?: number;
}
export function validateOnboardingSearch(raw: Raw): OnboardingSearch {
  const step = positiveInt(raw.step) ?? (raw.step === 0 || raw.step === '0' ? 0 : undefined);
  return clean({ burrow: str(raw.burrow), step });
}

/**
 * A conversation's Files (`/files/c/:channel`, …; docs/decisions/files-space.md AP-774): `?folder=Drawings/2024` is the
 * open folder (normalized as the contract does; anything that can't be a folder opens the top), `?repo=` names a
 * branch room's repository like `/pr/:number`'s.
 */
export interface FilesSearch {
  folder?: string;
  repo?: string;
}
export function validateFilesSearch(raw: Raw): FilesSearch {
  const folder = typeof raw.folder === 'string' ? normalizeFilesFolder(raw.folder) : null;
  const repo =
    typeof raw.repo === 'string' &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.repo) &&
    raw.repo.length <= 200
      ? raw.repo
      : undefined;
  return clean({ folder: folder || undefined, repo });
}
