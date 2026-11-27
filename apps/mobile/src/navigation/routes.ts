/** Navigation params and where a `LinkRef` opens on mobile. Pure. */
import {
  agentPartPlace,
  appPath,
  BURROW_SECTIONS,
  overviewSectionForTab,
  parseChatShellLink,
  splitBurrowPath,
  withBurrow,
} from '@whombat/client';
import { type AddServerPrefill, addServerPrefill, repointRequested } from '@whombat/client/hosts';
import {
  type ConversationLink,
  type ConversationSummary,
  DEPLOYS_SECTION,
  type LinkRef,
  MessageId,
  parseThingId,
  TeamReportId,
  thingId,
} from '@whombat/core';
import type { ConversationFilesTarget } from '../data/files';
import { INBOX_TAB } from '../data/shell';
import { type AccountPage, connectionsScreenUrl, legacyConnectionsTabUrl } from './connectionLinks';

/**
 * The bar's tabs (one-layout-android.md, `data/shell.ts`): Chat, Inbox, Overview, Automations, Settings. `ChatRoom` is
 * the Chat tab: `Chat` is a task chat's screen. `Dashboard` is the Overview tab: `Connections` is Settings' list of
 * connections, and the names in code stay.
 */
export type TabParamList = {
  ChatRoom: undefined;
  NeedsYou: undefined;
  /** `tab`: the section to scroll to, as the web's old `?tab=` names it (`servers`, `services`, `connections`, `pinned`). */
  Dashboard: { tab?: string } | undefined;
  Automations: undefined;
  Settings: undefined;
};

/**
 * A branch room by id, or by PR number and repository (`owner/name`, contracts CT-170; resolved from the sidebar, else
 * `prs.get`). A number without a repo that more than one room has asks which one (AP-514). The person's Chat and
 * Feedback room are their own screens (Whombat one-agent.md OA-04; app one-agent.md AP-4962).
 */
export type ConversationParams = ({ conversationId: string } | { prNumber: number; repo?: string }) &
  Anchored;

/**
 * A message to open the conversation at (MX-03): a message link, a mention push, a pinned message or a search result
 * names it; the screen loads pages until it is there (bounded), scrolls to it and highlights it, then drops the param.
 */
export interface Anchored {
  anchor?: string;
}

export type RootStackParamList = {
  Tabs: { screen?: keyof TabParamList; params?: TabParamList[keyof TabParamList] } | undefined;
  /**
   * `back` is the label of the "‹ …" button (the mock's "‹ Inbox"). A link — including the live
   * notification's Approve action — only ever opens this screen; approving always needs an explicit tap
   * on its Approve button (see `stripLinkedActionParams`).
   */
  Approval: { number: number; back?: string };
  Conversation: ConversationParams;
  Run: { number: number; back?: string };
  /**
   * What the agent remembers about the viewer (hermes-engine-app.md AP-5271): its own address, which opens the
   * assistant's Memory part (Settings → {assistant} → Memory).
   */
  Memory: undefined;
  /**
   * One automation: what it does, step by step, its switch, runs and buttons (automation-page.md AP-6331); `back` is
   * the “‹ …” label. The list is the Automations tab.
   */
  Automation: { id: string; back?: string };
  /** One run of an automation (docs/decisions/bp-automations.md). */
  AutomationRun: { number: number; back?: string };
  /** A shared plan (work-supervision WS-09), opened from its card or a `plan` link; `stepId` focuses a step. */
  Plan: { planId: string; stepId?: string; back?: string };
  /**
   * Every plan the viewer can see, Open or All (AP-718); with `conversationId` one conversation's plans, from its menu,
   * `back` naming it (work-removal-android.md AP-857, AP-859).
   */
  Plans: { back?: string; conversationId?: string } | undefined;
  /** What is live where and every recorded deploy (MQ-07, work-removal-android.md AP-858). */
  Deploys: { back?: string } | undefined;
  /** A thread: its root and replies, answered in the thread; `anchor` a reply to open it at (MX-03). */
  Thread: { messageId: string; back?: string } & Anchored;
  /** A conversation's pinned messages, newest pin first (essentials CT-174, AP-509). */
  Pins: { conversationId: string; title: string };
  /** Share to Whombat (AP-715): pick a conversation for what another app shared (held in `data/shareInbox`). */
  Share: undefined;
  /**
   * The agent's skill library (Settings → Skills; Whombat one-agent.md OA-18, hermes-skills.md HSK-12; app one-agent.md
   * AP-4947, AP-4967, hermes-skills.md AP-5570), and one skill by its name (skill-store.md AP-4150); `whombat://skills`,
   * `whombat://skills/notion`.
   */
  Skills: undefined;
  /** One skill by its name (one list, one-person-android.md AP-5765). */
  Skill: { name: string };
  /** The viewer's Vault (docs/decisions/vault.md VT-73), and one of its entries (`title` shows while it loads). */
  /** `back`: the page it was opened from (Places), its “‹ …”. */
  Vault: { back?: string } | undefined;
  VaultEntry: { entryId: string; title: string; back?: string };
  /**
   * Connections, read-only (connections-catalog.md CX-74): what you have, Add a connection (its own screen since
   * connections-redesign-android.md AP-1170), and one catalog connection (`title` shows while it loads).
   */
  Connections: undefined;
  AddConnection: undefined;
  /** `thingId`: the page it was opened from (a device's), for What Whombat watches (quiet-notices-mobile.md AP-4865). */
  Connection: { connectionId: string; title: string; back?: string; thingId?: string };
  /* Connecting from the phone (phone-connect.md PC-01…PC-11, AP-2900…) ------------------------------------------- */
  /**
   * Connect {Name} (PC-03): a connectable catalog entry's form, `whombat://settings/connections/connect/proxmox`;
   * `url` fills in the address (Found on your network, CS-51), `error` is a sign-in's `connect_error=` said once.
   * Strings as a link gives them: the screen checks them. A link only fills in; nothing is sent before a tap.
   */
  Connect: {
    catalogId: string;
    url?: string;
    error?: string;
    back?: string;
    access?: string;
    returnTo?: string;
  };
  /**
   * A builtin connection's screen (PC-02): Google, Microsoft 365 and Email (IMAP) — the person's own account, connected
   * here — GitHub and Website feedback; `whombat://settings/connections/account/google`. `thingId`: the account's page
   * it was opened from (its Connection), whose What Whombat watches it shows under the account.
   */
  ConnectAccount: { page: AccountPage | (string & {}); error?: string; back?: string; thingId?: string };
  /**
   * Files (files-space.md FS-07, AP-772…): the conversations with files the viewer may see, and one conversation's
   * Files — by id from the list and the conversation menu, by what a `/files/…` address names (`whombat://files/dm/chat`),
   * at `folder` (`''` the top).
   */
  Files: { back?: string } | undefined;
  ConversationFiles: ConversationFilesTarget & { folder?: string };
  /**
   * Managed only (AP-27): This Whombat in parts (this-whombat-sections-android.md AP-1240, AP-1250) — the Overview
   * (`Whombat`, where pushes about the Whombat itself land), Backups (`setUp` opens the destination form at once),
   * Devices (`at` opens it at a section) and About — and the backup file (on a Whombat with `backup.file`: download a
   * file of what you choose, restore from one; backup-file-android.md AP-1211). The one-time
   * params are dropped once the screen read them.
   */
  Whombat: undefined;
  /** `bringBack`: a bring back waits (the Inbox's Finish, `finish`, or Try again, `again`): its flow opens where it stands. */
  WhombatBackups: { setUp?: true; bringBack?: 'finish' | 'again' } | undefined;
  Devices: { at?: 'passkeys' } | undefined;
  /** Sharing a thread of Chat by link (share-links.md): the whole thread, or from one of its messages on. */
  ShareLink: { rootId: string; fromMessageId?: string };
  /** Settings → You → Shared links. */
  SharedLinks: undefined;
  /**
   * Reports to the Whombat Team (Whombat team-reports.md), from Settings → You and About: the person's reports
   * (`whombat://reports`), a new one (`reports/new`; `draftId` the assistant's draft its card's Edit opens, the web's
   * `/reports/new?draft=`) and one report (`reports/<reportId>`, where its Inbox item and push lead; `sent` says once
   * that it went). `back` names the page under it. Strings as a link gives them: the screens check them.
   */
  TeamReports: { back?: string } | undefined;
  TeamReportNew: { draftId?: string; back?: string } | undefined;
  TeamReport: { reportId: string; sent?: boolean; back?: string };
  /** Settings → You → Prompts (prompts-phone.md): the person's prompts. */
  SettingsPrompts: undefined;
  /**
   * A prompt being kept or changed: `promptId` one of the list, else a new one, with `fromText` a message's words (Save
   * as prompt, which goes back to the chat once saved).
   */
  PromptEdit: { promptId?: string; fromText?: string } | undefined;
  /** `at`: opened at HARDWARE (a link from before the Hardware screen) or at REACH (a connection that needs it). */
  WhombatAbout: { at?: 'hardware' | 'reach' } | undefined;
  /** The machine and every part (About's HARDWARE row, NETWORK's and BLUETOOTH's See hardware); `back` names the way back. */
  WhombatHardware: { back?: string } | undefined;
  /** Remote help in full: turning it on, and what support did visit by visit (About's REMOTE HELP card). */
  WhombatRemoteHelp: undefined;
  BackupFile: undefined;
  /**
   * Backups' options and one backup (backup-options-android.md AP-6853, AP-6856), from Backups; on a Whombat and in the
   * demo world.
   */
  BackupOptions: undefined;
  BackupDetail: { checkpointId: string };
  /** Bringing things back from one backup (backup-look.md AP-6950), from its page; never restored after a restart. */
  BackupBringBack: { checkpointId: string; createdAt: string };
  /* Stream C (android-work: AP-712) ------------------------------------------------------------------------------ */
  /** A pull request: checks, reviewers, files changed, Merge into main (AP-712); `repo` is `owner/name`. */
  PullRequest: { number: number; repo?: string; back?: string };
  /** One of its files, view only (AP-712); `whombat://pr/482/file?path=…` opens it from a link (MX-06). */
  PullRequestFile: { number: number; repo?: string; path: string };
  /* Parity screens (mobile-parity.md MQ-02, MQ-03) -------------------------------------------------------------- */
  /** Spend (MQ-02): the agent's spend, Settings → AI's (AP-4948, AP-4968). */
  Spend: { back?: string } | undefined;
  /**
   * Search (phone-shell-final.md): chats, things, settings and places; `q` what is typed (a link's `/search?q=`, and
   * kept while a result is open), `back` the page it was opened from.
   */
  Search: { q?: string; back?: string } | undefined;
  /** The audit log (MQ-03): filters as the web's `?actor=&kind=&who=&open=`, strings checked by the screen. */
  AuditLog: { actor?: string; kind?: string; who?: string; open?: string } | undefined;
  /**
   * Settings → the assistant by its name (Whombat one-agent.md OA-09; the web's `?tab=agent`): its page, in parts as the
   * web's (`part`: Name and face by default, `ai` AI sign-in, `memory`, `may` What it may do). An old part opens where it
   * went (`notes` Memory; `keys` with `key` the keys' page; `model`, `services`, `spend` and `skills` Advanced's;
   * `schedules` Automations).
   * `whombat://settings/agent?part=may`. Strings as a link gives them: the screen checks them.
   */
  SettingsAgent: { part?: string; key?: string } | undefined;
  /**
   * The council of Settings → the assistant → Council being changed: its seats, builder, rounds and score (Whombat
   * council.md CNL-50…CNL-54; app council-phone.md).
   */
  SettingsCouncil: undefined;
  /**
   * The Settings tab's pages (settings-tab-android.md AP-2625): You (`SettingsProfile`; `SettingsNotifications` is the
   * same page, its old address), the AI sign-in's old address (`SettingsAi`, the assistant's AI sign-in) and — on a
   * self-hosted server or in the demo world — This Whombat (a managed Whombat's is `Whombat`, its Overview).
   */
  SettingsProfile: undefined;
  SettingsNotifications: undefined;
  SettingsAi: undefined;
  /**
   * Settings → Advanced: the expert pages the phone has a screen for (`advancedRowsOnPhone`); `SettingsAdvancedPart` one
   * of the pages it draws itself (`part`: model, ai, running, and keys — a page under What it may do; `key` a key row
   * Keys scrolls to).
   */
  SettingsAdvanced: undefined;
  SettingsAdvancedPart: { part: string; key?: string };
  /**
   * In the demo world, a state its desk screen starts over in (`desk`, `fixtures/desk.ts`, desk-display-android.md
   * AP-3061), the machine it starts over as (`machine`, `fixtures/machine.ts`, hardware-support-android.md AP-3262) or
   * its remote help's (`help`, `fixtures/remoteHelp.ts`, app remote-help.md AP-4478).
   */
  SettingsWhombat: { desk?: string; machine?: string; help?: string; voice?: string } | undefined;
  /**
   * Settings → Screen (desk-display-android.md AP-5860): the box's screen, `part` one of its parts (`shows`, `lock`,
   * `night`, `talk`; checked by the page); in the demo world `desk` a state its screen starts over in.
   */
  SettingsDesk: { part?: string; desk?: string } | undefined;
  /** Settings → News and weather: where the Whombat is, for the weather, and the news sources it reads. */
  SettingsNews: undefined;
  /**
   * Settings → Screens → a screen (desk-display-android.md AP-6004): `screen` its id (`box`, `out_…`, `scr_…`), `part`
   * one of the box's parts (`bar`, `lock`, `night`, `talk`; checked by the page).
   */
  SettingsScreen: { screen: string; part?: string };
  /** A screen's layout in the editor (AP-6010); `back` the page it goes back to, in words. */
  SettingsScreenLayout: { screen: string; back?: string };
  /** A canvas, read-only (MQ-05, contracts 0.55 `canvases.content`); `title` shows while it loads. */
  Canvas: { slug: string; title?: string };
  /* One Whombat (one-whombat-mobile.md AP-1357, AP-1363) ------------------------------------------------------------ */
  /**
   * A task chat with the viewer's Whombat (ONE-06); `title` shows while it loads. In the Chat shell its address opens the
   * Chat or Feedback room it now is, and an older task chat as before (chat-channel.md AP-2457).
   */
  Chat: { conversationId: string; title?: string; back?: string } & Anchored;
  /* Chat (Whombat chat-channel.md CHT-22; chat-channel.md AP-2450…) ------------------------------------------------- */
  /** The Feedback room, from Chat's header (CHT-03): `whombat://feedback`. */
  Feedback: undefined;
  /** A room's new chat, from its list's New chat button: Chat's by default, `room: 'feedback'` the Feedback room's. */
  NewChat: { room?: 'chat' | 'feedback' } | undefined;
  /** A room's settled threads, the latest first: Chat's by default, `room: 'feedback'` the Feedback room's. */
  Settled: { room?: 'chat' | 'feedback' } | undefined;
  /** Everything I did (home-redesign-mobile.md AP-2261): every change the assistant made, `whombat://done`. */
  /** `back`: the page it was opened from (Chat's head), else Overview. */
  Done: { back?: string } | undefined;
  /**
   * A Needs you item by id, as a page: with two pages a row opens it on the right page instead of its sheet
   * (docs/app/decisions/iphone-duo.md), and a push or a link about it lands on it (`whombat://needs-you/<id>`, NYL-09).
   */
  /** `back`: the page it was opened from when that isn't the Inbox (Overview's headline). */
  NeedsYouItem: { itemId: string; back?: string };
  /**
   * A thing by its id (`server:pve-02`, `connection:con_…`, `device:con_…`, contracts `thingId`): a server's page; a
   * connection or device its own page (connection-pages-mobile.md AP-1950), on `tab` when given (`?tab=logs`), or its
   * Connection screen on an older Whombat.
   */
  Thing: { thingId: string; title?: string; back?: string; tab?: string };
  /**
   * A guest on a server (proxmox-mobile.md AP-1485): `things/server%3Apve-02/guests/pve%3A118`, the server's thing id
   * in the address and its server id in the params; `title` shows while it loads, `back` names the screen under it.
   */
  Guest: {
    serverId: string;
    guestId: string;
    title?: string;
    back?: string;
    /** The tab it opens on (`snapshots` from “Set a schedule”, incus-unraid-mobile.md AP-1633). */
    tab?: string;
  };
  /**
   * Add a server (server-signin-mobile.md AP-1697): `whombat://servers/add`, from Connections' Servers, its “wants to be
   * added” and the assistant's card (`/things/servers?add=1&address=…&user=…&control=…&name=…`), which fill the form in. Strings
   * as a link gives them; the screen reads them with the shared `addServerPrefill`.
   */
  AddServer: { address?: string; user?: string; control?: string; name?: string; back?: string } | undefined;
  /**
   * Point them here (Whombat backup-file.md BF-15, BF-16; app backup-file.md AP-4421): `whombat://servers/repoint`, BF-16's
   * Needs you item (`/things/servers?repoint=1`); `back` names the screen under it.
   */
  RepointServers: { back?: string } | undefined;
  /**
   * A server's operating-system updates (Whombat server-updates.md SWU-12; server-updates-app.md AP-2880):
   * `things/server%3Apve-02/updates`, the web's `/things/server%3Apve-02?tab=updates`; `back` names the screen under it.
   */
  ServerUpdates: { serverId: string; title?: string; back?: string };
};

/**
 * Which screen a route is, for the stack's `getId`: another thread or conversation opened on top of one (a link in a
 * message, a tapped notification) is a screen of its own, not the same screen with new params, which would keep the
 * first one's state (its earlier pages, where it had been read, its “New” line, its scroll). Opening one already in
 * the stack brings that one back.
 */
export const SCREEN_IDS = {
  // An approval's “may have gone through” is that approval's; another one opened from a push is answered on its own.
  Approval: ({ params }: { params?: RootStackParamList['Approval'] }) =>
    params ? String(params.number) : undefined,
  Thread: ({ params }: { params?: RootStackParamList['Thread'] }) => params?.messageId,
  // Another report opened from a push while one is open is a screen of its own.
  TeamReport: ({ params }: { params?: RootStackParamList['TeamReport'] }) => params?.reportId,
  Conversation: ({ params }: { params?: ConversationParams }) =>
    !params
      ? undefined
      : 'conversationId' in params
        ? params.conversationId
        : `pr:${params.repo ?? ''}#${params.prNumber}`,
};

export type Route =
  | { name: 'Approval'; params: RootStackParamList['Approval'] }
  | { name: 'Conversation'; params: ConversationParams }
  | { name: 'SettingsAgent'; params: NonNullable<RootStackParamList['SettingsAgent']> }
  | { name: 'Feedback'; params: undefined }
  | { name: 'Run'; params: RootStackParamList['Run'] }
  | { name: 'AutomationRun'; params: RootStackParamList['AutomationRun'] }
  | { name: 'Plan'; params: RootStackParamList['Plan'] }
  | { name: 'Deploys'; params: NonNullable<RootStackParamList['Deploys']> }
  | { name: 'AuditLog'; params: NonNullable<RootStackParamList['AuditLog']> }
  | { name: 'Canvas'; params: RootStackParamList['Canvas'] }
  | { name: 'Thread'; params: RootStackParamList['Thread'] }
  | { name: 'Chat'; params: RootStackParamList['Chat'] }
  | { name: 'Search'; params: NonNullable<RootStackParamList['Search']> }
  | {
      name: 'Tabs';
      params: { screen: 'NeedsYou' | 'Dashboard' | 'ChatRoom' };
    };

export interface SidebarLookup {
  branchRooms: readonly (ConversationSummary & { prNumber: number | null; repo?: string })[];
  dms: readonly ConversationSummary[];
}

/**
 * The branch room a `pr` link means (CT-170): by number and repository when the link names one (a room from an older
 * server without `repo` counts when it is the only one with that number), by number alone when only one room has it.
 * Null when the sidebar can't tell: none has it, or several have it and the link names no repository.
 */
export function branchRoomFor<R extends { prNumber: number | null; repo?: string }>(
  rooms: readonly R[],
  number: number,
  repo: string | undefined,
): R | null {
  const same = rooms.filter((r) => r.prNumber === number);
  if (repo) {
    const exact = same.find((r) => r.repo === repo);
    if (exact) return exact;
    return same.length === 1 && !same[0]?.repo ? (same[0] ?? null) : null;
  }
  return same.length === 1 ? (same[0] ?? null) : null;
}

/** `{anchor}` for a message id, nothing for anything else (MX-03). */
export function anchorParam(messageId: string | null | undefined): Anchored {
  return messageId && MessageId.safeParse(messageId).success ? { anchor: messageId } : {};
}

function conversationRoute(link: ConversationLink, sidebar: SidebarLookup | null, at?: string): Route | null {
  const anchor = anchorParam(at);
  switch (link.type) {
    case 'dm':
      // The person's own room with the agent (OA-04): Chat, or the Feedback room. A message in it is a thread (every
      // question is its own, CHT-02): it opens there (AP-4962).
      if (anchor.anchor) return { name: 'Thread', params: { messageId: anchor.anchor } };
      return link.room === 'feedback'
        ? { name: 'Feedback', params: undefined }
        : { name: 'Tabs', params: { screen: 'ChatRoom' } };
    case 'pr': {
      const room = branchRoomFor(sidebar?.branchRooms ?? [], link.number, link.repo);
      if (room) return { name: 'Conversation', params: { conversationId: room.id, ...anchor } };
      // Not in the sidebar, or several rooms have that number: the screen asks the server, or which one (AP-514).
      return {
        name: 'Conversation',
        params: link.repo
          ? { prNumber: link.number, repo: link.repo, ...anchor }
          : { prNumber: link.number, ...anchor },
      };
    }
    case 'chat':
      // A task chat with the person's Whombat (contracts 0.80.1, CT-348): that chat, not the default DM — opened as a chat,
      // as a row of Chats opens it, so a report's push lands in its feedback chat (feedback-chat.md AP-1836).
      return { name: 'Chat', params: { conversationId: link.id, ...anchor } };
  }
}

/** What the Whombat has, where a link's screen depends on it. Absent means it has it (a self-hosted server). */
export interface LinkFeatures {
  /** It records deploys (`deployments`, contracts 0.55). */
  deployments?: boolean;
}

/**
 * The screen a link opens. External links have no mobile screen; they return null and `useOpenLink` opens them in the
 * browser (`webUrlForLink`, AP-709) — or, for an external link to the web app, its screen (`urlTarget`). The audit log
 * has one since MQ-03 (a receipt's link opens it at its event), a canvas since MQ-05 (read-only; `useOpenLink` opens it
 * on the web where the Whombat can't give its text, `canvases.content`).
 */
export function routeForLink(
  link: LinkRef,
  sidebar: SidebarLookup | null,
  back?: string,
  features: LinkFeatures = {},
): Route | null {
  switch (link.type) {
    case 'approval':
      return { name: 'Approval', params: back ? { number: link.number, back } : { number: link.number } };
    case 'run':
      return { name: 'Run', params: back ? { number: link.number, back } : { number: link.number } };
    case 'dm':
    case 'pr':
    case 'chat':
      return conversationRoute(link, sidebar);
    case 'message':
      // A reply opens its thread; a top-level message its conversation (in Chat, its own thread). Both open at the
      // message (MX-03): a mention push, an inbox row, a search result or a copied link lands on it.
      return link.threadRootId
        ? {
            name: 'Thread',
            params: {
              messageId: link.threadRootId,
              ...(back ? { back } : {}),
              ...(link.messageId !== link.threadRootId ? anchorParam(link.messageId) : {}),
            },
          }
        : conversationRoute(link.in, sidebar, link.messageId);
    case 'agent':
      // The agent's own address (AgentLink): Settings → Agent (OA-09, AP-4961).
      return { name: 'SettingsAgent', params: {} };
    case 'search':
      // Search, with what the link looks for (phone-shell-final.md).
      return { name: 'Search', params: { q: link.q.slice(0, SEARCH_QUERY_MAX), ...(back ? { back } : {}) } };
    case 'automation_run':
      return {
        name: 'AutomationRun',
        params: back ? { number: link.number, back } : { number: link.number },
      };
    case 'plan':
      return {
        name: 'Plan',
        params: {
          planId: link.planId,
          ...(link.stepId ? { stepId: link.stepId } : {}),
          ...(back ? { back } : {}),
        },
      };
    case 'work':
      // The Work view is gone (work-removal-android.md AP-860): its Deploys has a screen of its own where the Whombat
      // records deploys; anything else in it was what needs the viewer, now in Needs you.
      return link.section === DEPLOYS_SECTION && features.deployments !== false
        ? { name: 'Deploys', params: back ? { back } : {} }
        : { name: 'Tabs', params: { screen: INBOX_TAB } };
    case 'log':
      return {
        name: 'AuditLog',
        params: { ...(link.who ? { who: link.who } : {}), ...(link.eventId ? { open: link.eventId } : {}) },
      };
    case 'canvas':
      return { name: 'Canvas', params: { slug: link.slug } };
    case 'external':
      return null;
  }
}

/** Deep links (`whombat://approvals/12`) for notifications and the settings "open" actions. */
export const APP_SCHEME = 'whombat';
export const LINKING_PREFIXES = [`${APP_SCHEME}://`];

export const LINKING_SCREENS = {
  Tabs: {
    screens: {
      // Chat; the old tab's task chats (`chats`) open it, and so does the Code tab's old address (`code`): software work
      // is in Chat's threads.
      ChatRoom: { path: 'chat', alias: ['chats', 'code'] },
      // Needs you (NYL-05, NYL-09), Watch's old address, and the inbox's, where pushes, unknown paths and the inbox's
      // own links land (AP-1351).
      NeedsYou: { path: 'needs-you', alias: ['watch', 'inbox'] },
      // Connections (AP-2550): the Dashboard's and Things' old addresses.
      Dashboard: { path: 'connections', alias: ['dashboard', 'home', 'things'] },
      Automations: 'automations',
      Settings: 'settings',
    },
  },
  Approval: { path: 'approvals/:number', parse: { number: Number } },
  // One item of the Needs you list, where a push or a link about it lands (NYL-09).
  NeedsYouItem: 'needs-you/:itemId',
  // Branch rooms by number and `?repo=` (CT-170).
  Conversation: { path: 'pr/:prNumber', parse: { prNumber: Number } },
  Run: { path: 'runs/:number', parse: { number: Number } },
  // A pull request's Files changed and one of its files (`?path=…&repo=…`, MX-06).
  PullRequest: { path: 'pr/:number/files', parse: { number: Number } },
  PullRequestFile: { path: 'pr/:number/file', parse: { number: Number } },
  Automation: 'automations/:id',
  AutomationRun: { path: 'automation-runs/:number', parse: { number: Number } },
  Plan: 'plans/:planId',
  Deploys: 'deploys',
  Thread: 'threads/:messageId',
  Vault: 'vault',
  // The agent's skills and one skill (AP-2361, AP-4967): the web's `/skills` opens the list. A skill is its name (AP-4150).
  Skills: 'skills',
  Skill: 'skills/:name',
  Files: 'files',
  // A conversation's Files by the address the web uses (`/files/dm/chat`, `/files/dm/feedback`, `/files/direct/<id>` a
  // task chat, `/files/pr/482?repo=…`); `?folder=` opens a folder.
  ConversationFiles: {
    path: 'files/dm/:room',
    alias: ['files/direct/:conversationId', { path: 'files/pr/:prNumber', parse: { prNumber: Number } }],
  },
  // Parity screens (MQ-02, MQ-03): Spend (shown as Usage), the audit log.
  Spend: 'spend',
  // Search (phone-shell-final.md): `search?q=…`.
  Search: 'search',
  AuditLog: 'log',
  // Settings → the assistant (AP-4961): `?part=may`.
  SettingsAgent: 'settings/agent',
  // The council being changed, from Settings → the assistant → Council.
  SettingsCouncil: 'settings/agent/council',
  // The Settings tab's pages and Settings → Connections (settings-tab-android.md AP-2625): the web's `?tab=` names them.
  SettingsProfile: { path: 'settings/profile', alias: ['settings/you'] },
  // Settings → You → Prompts (prompts-phone.md): the web's `/settings?part=prompts`.
  SettingsPrompts: 'settings/prompts',
  // What the agent remembers about you (AP-5271): the assistant's Memory part.
  Memory: 'settings/memory',
  SettingsNotifications: 'settings/notifications',
  SettingsAi: 'settings/ai',
  // Settings → Advanced and its own pages (`settings/advanced/keys?key=…`).
  SettingsAdvanced: 'settings/advanced',
  SettingsAdvancedPart: 'settings/advanced/:part',
  SettingsWhombat: 'settings/whombat',
  // This Whombat → Backups (`?bringBack=finish|again`: the Inbox's Finish and Try again, backup-options.md BKO-28, BKO-34).
  WhombatBackups: 'settings/whombat/backups',
  // Settings → Screen (AP-5860), Settings → Screens where the Whombat has them (AP-6000): the web's `?tab=screen`.
  SettingsDesk: { path: 'settings/screen', alias: ['settings/screens'] },
  // Settings → News and weather: the web's `?tab=news`.
  SettingsNews: 'settings/news',
  // Settings → Screens → a screen and its layout (AP-6004, AP-6010): the web's `/settings/screens/:id(/layout)`.
  SettingsScreen: 'settings/screens/:screen',
  SettingsScreenLayout: 'settings/screens/:screen/layout',
  Connections: 'settings/connections',
  // Connecting from the phone (AP-2902): Add a connection, Connect {Name}, a builtin's screen.
  AddConnection: 'settings/connections/add',
  Connect: 'settings/connections/connect/:catalogId',
  ConnectAccount: 'settings/connections/account/:page',
  Canvas: 'canvases/:slug',
  // One Whombat (AP-1357, AP-1363): a task chat and a thing (`things/server%3Apve-02`).
  Chat: 'chats/:conversationId',
  // Chat: the Feedback room and a room's settled threads (`settled?room=feedback`); a thread is
  // `threads/:messageId`.
  Feedback: 'feedback',
  Settled: 'settled',
  Thing: 'things/:thingId',
  // Everything I did (AP-2261): the web's `/done`.
  Done: 'done',
  // Reports to the Whombat Team (team-reports.md): the web's `/reports`, `/reports/new` and `/reports/<reportId>`.
  TeamReports: 'reports',
  TeamReportNew: 'reports/new',
  TeamReport: 'reports/:reportId',
  // Add a server (AP-1697): `servers/add?address=…&user=…&control=…`.
  AddServer: 'servers/add',
  // Point them here (AP-4421): BF-16's Needs you item.
  RepointServers: 'servers/repoint',
  // A guest's screen (AP-1485): the address has the server's thing id (`server%3Apve-02`), the params its server id.
  Guest: {
    path: 'things/:serverId/guests/:guestId',
    parse: { serverId: serverOfThingParam },
    stringify: { serverId: (id: string) => thingId('server', id) },
  },
  // A server's updates (AP-2880): the address has the server's thing id, as a guest's does.
  ServerUpdates: {
    path: 'things/:serverId/updates',
    parse: { serverId: serverOfThingParam },
    stringify: { serverId: (id: string) => thingId('server', id) },
  },
} as const;

/** A guest address's server part: `server:pve-02` → `pve-02` (a bare server id stays as it is). */
export function serverOfThingParam(value: string): string {
  const thing = parseThingId(value);
  return thing?.kind === 'server' ? thing.id : value;
}

/** The shape `getStateFromPath` returns, as much of it as this needs: a (partial) navigation state, nested
 * per screen. Kept loose (not React Navigation's own, more precise, generic `ResultState`) so this stays
 * a plain, dependency-free function `RootNavigator.tsx` can wrap the real one with. */
interface LinkedRouteState {
  routes?: readonly LinkedRoute[];
}
interface LinkedRoute {
  params?: Record<string, unknown>;
  state?: LinkedRouteState;
}

/** Route params a URL is never allowed to set because they make a screen act rather than just open. */
const ACTION_PARAMS = new Set(['decide']);

/**
 * Strips action params (`decide`, from a naive reading of `whombat://approvals/12?decide=approve`) out of
 * a link's parsed state before it reaches a screen's route params. `whombat://` is a public, unauthenticated
 * scheme: any web page, chat message, QR code or other app can open it (`APP_SCHEME`), and React
 * Navigation's `getStateFromPath` merges every query-string key straight into route params. A link may
 * only ever open a screen — the approval screen included — never decide anything on it; approving always
 * needs an explicit tap on its Approve button. Pure and generic (keyed on the param name, not a specific
 * screen) so the same guarantee holds for whatever screen or param is added next, not just this one.
 */
export function stripLinkedActionParams<T>(state: T): T {
  const s = state as LinkedRouteState | undefined;
  if (!s?.routes) return state;
  return {
    ...s,
    routes: s.routes.map((route) => {
      const next: LinkedRoute = { ...route };
      if (next.params) {
        const params = { ...next.params };
        for (const key of ACTION_PARAMS) delete params[key];
        next.params = params;
      }
      if (next.state) next.state = stripLinkedActionParams(next.state);
      return next;
    }),
  } as T;
}

/**
 * A link's escaped part, decoded; null when it isn't a valid escape (a stray `%`, as in “100%”). Links come from
 * messages, previews and other apps, so a bad one must open nothing rather than throw while a row draws or a tap runs.
 */
function decoded(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/** A query's key or value, decoded; as written when it isn't a valid escape. */
const queryPart = (part: string): string => decoded(part) ?? part;

/** A query's `key=value` pair; the value keeps any `=` of its own (“?q=a=b”). */
function queryPair(pair: string): [string, string] {
  const at = pair.indexOf('=');
  return at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
}

/** `?key=` of a web path's query, decoded; null when absent. */
function queryOf(search: string): Map<string, string> {
  return new Map(
    search
      .split('&')
      .filter(Boolean)
      .map((pair) => {
        const [k, v] = queryPair(pair);
        return [queryPart(k), queryPart(v.replace(/\+/g, ' '))] as const;
      }),
  );
}

/**
 * The burrow a web path names (AP-366): the first segment of the old form (`/burrow-hq/c/general`, what the servers
 * write), or `?burrow=` on the burrow-less form (`/canvases/plan?burrow=burrow-hq`). Null when it names none: the
 * burrow-less path is the open burrow's.
 */
export function burrowOfPath(path: string): string | null {
  const [beforeHash = ''] = path.split('#');
  const [pathname = '', search = ''] = beforeHash.split('?');
  const split = splitBurrowPath(pathname);
  if (split?.form === 'old') return split.burrow;
  return queryOf(search).get('burrow') || null;
}

/**
 * The app screen for a web path, in either form (AP-366): the burrow-less `/pr/482?approval=12`, `/runs/1907`,
 * or the old `/burrow-hq/pr/482?approval=12` (`linkPath()`, a push's path), `/burrow-hq/chat?thread=msg_…`.
 * Needs-you rows for an approval open the approval; paths without a mobile screen open the inbox. Which burrow is
 * `burrowOfPath`'s business.
 */
export function appUrlForPath(path: string): string {
  return appScreenUrlForPath(path) ?? `${APP_SCHEME}://inbox`;
}

/**
 * The message a web path's fragment names (`/pr/482#msg_1`, `/chat?thread=msg_0#msg_2`, MX-03), checked as a
 * message id; null for any other fragment.
 */
export function anchorOfPath(path: string): string | null {
  const hash = path.split('#')[1];
  return anchorParam(hash).anchor ?? null;
}

/** `?anchor=` (or `&anchor=` after other params) for the app link, or nothing. */
function withAnchor(url: string, anchor: string | null): string {
  if (!anchor) return url;
  return `${url}${url.includes('?') ? '&' : '?'}anchor=${anchor}`;
}

/** A file path from a link (`?file=`, the web's file view, AP-664): up to 4096 characters, no control characters. */
function filePathParam(value: string | undefined): string | null {
  if (!value || value.length > 4096) return null;
  for (let i = 0; i < value.length; i++)
    if (value.charCodeAt(i) < 32 || value.charCodeAt(i) === 127) return null;
  return value;
}

/** The longest query a link may carry into Search (the web's search takes 500 characters). */
const SEARCH_QUERY_MAX = 500;

/** `appUrlForPath` without the fallback: null when the phone has no screen for the path (the canvases' list). */
export function appScreenUrlForPath(path: string): string | null {
  const [beforeHash = ''] = path.split('#');
  const [pathname = '', search = ''] = beforeHash.split('?');
  const query = queryOf(search);
  const base = `${APP_SCHEME}://`;
  const anchor = anchorOfPath(path);
  const approval = Number(query.get('approval'));
  if (Number.isInteger(approval) && approval > 0) return `${base}approvals/${approval}`;
  // A thread (`?thread=msg_…`) opens the thread screen, at the reply the fragment names (MX-03).
  const thread = query.get('thread');
  if (thread && /^[A-Za-z0-9_-]{1,80}$/.test(thread))
    return withAnchor(`${base}threads/${thread}`, anchor === thread ? null : anchor);
  // A plan in its conversation's plan pane (`?plan=…&step=…`, WS-09) opens the plan screen.
  const plan = query.get('plan');
  if (plan && /^[A-Za-z0-9_-]{1,80}$/.test(plan)) {
    const step = query.get('step');
    const focus = step && /^[A-Za-z0-9_-]{1,80}$/.test(step) ? `?stepId=${step}` : '';
    return `${base}plans/${plan}${focus}`;
  }
  const work = oldWorkScreenUrl(pathname);
  if (work) return work;
  // Connections with Point them here open (the web's `/connections?repoint=1`, AP-4421).
  if (/^\/connections\/?$/.test(pathname) && repointRequested(Object.fromEntries(query)))
    return `${base}servers/repoint`;
  // A connection's page, which the web opens on its Connections page (`/connections?connection=google`): its screen.
  if (
    /^\/connections\/?$/.test(pathname) &&
    ['connection', 'found', 'connect_error'].some((k) => query.has(k))
  )
    return connectionsScreenUrl(search);
  const settingsTab = settingsTabScreenUrl(pathname, search);
  if (settingsTab) return settingsTab;
  const chat = chatShellScreenUrl(pathname, query);
  if (chat) return chat;
  const assistant = assistantScreenUrl(pathname, anchor, query);
  if (assistant) return assistant;
  const split = splitBurrowPath(pathname);
  if (!split) return null;
  const [section, id] = split.path.split('/').filter(Boolean);
  const number = Number(id);
  switch (section) {
    case undefined:
      return `${base}inbox`;
    case 'runs':
      if (Number.isInteger(number) && number > 0) return `${base}runs/${number}`;
      break;
    case 'automation-runs':
      if (Number.isInteger(number) && number > 0) return `${base}automation-runs/${number}`;
      break;
    case 'canvases': {
      // A canvas, read-only (MQ-05); the list of canvases stays on the web.
      const canvas = id ? decoded(id) : null;
      if (canvas) return `${base}canvases/${encodeURIComponent(canvas)}`;
      break;
    }
    case 'automations':
      // One automation (`/automations/<id>`) opens its page (automation-page.md AP-6331), the list without one.
      if (!id) return `${base}automations`;
      return `${base}automations/${encodeURIComponent(decoded(id) ?? id)}`;
    case 'vault':
      return `${base}vault`;
    // The web's Search (`/search?q=…`): the phone's, with what it looks for.
    case 'search': {
      const q = (query.get('q') ?? '').slice(0, SEARCH_QUERY_MAX);
      return q ? `${base}search?q=${encodeURIComponent(q)}` : `${base}search`;
    }
    // The web's Inbox (`/inbox?filter=…`, the phone's Inbox has no filter) and its Deploys page (AP-850, AP-862).
    case 'inbox':
      return `${base}inbox`;
    case 'deploys':
      return `${base}deploys`;
    case 'files':
      return filesScreenUrl(split.path, query);
    case 'pr': {
      // The room's repository rides along (`?repo=owner/name`, CT-170); without it the screen asks which room.
      if (!Number.isInteger(number) || number <= 0) break;
      const repo = query.get('repo');
      const named = repo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : null;
      const repoParam = named ? `repo=${encodeURIComponent(named)}` : null;
      // The Files changed tab and one of its files (`?tab=files&file=…`, AP-664) open the phone's screens (MX-06).
      if (query.get('tab') === 'files') {
        const file = filePathParam(query.get('file'));
        const params = [
          ...(file ? [`path=${encodeURIComponent(file)}`] : []),
          ...(repoParam ? [repoParam] : []),
        ];
        return `${base}pr/${number}/${file ? 'file' : 'files'}${params.length ? `?${params.join('&')}` : ''}`;
      }
      return withAnchor(`${base}pr/${number}${repoParam ? `?${repoParam}` : ''}`, anchor);
    }
    case 'log':
      // The audit log at an event or “Only Banjo” (MQ-03).
      return logScreenUrl(query);
    case 'settings':
      return settingsScreenUrl(query.get('tab'), search);
    case 'skills':
      // The agent's skills (Settings → Skills, AP-4947, AP-4967, AP-5571).
      return `${base}skills`;
    case 'reports':
      return reportsScreenUrl(id, query);
    // `/search` has no screen on the phone (one-layout-android.md AP-2645): it stays on the web.
  }
  return null;
}

/** An assistant's draft of a report, as `teamReports.draft` names it. */
const DRAFT_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Reports to the Whombat Team (Whombat team-reports.md): `/reports` the list, `/reports/new?draft=<id>` the form with
 * the assistant's draft (`?draft=` on the list's address too), `/reports/<reportId>` one report, where its Inbox item
 * and push lead. Anything else under `/reports` opens the list.
 */
function reportsScreenUrl(id: string | undefined, query: Map<string, string>): string {
  const base = `${APP_SCHEME}://reports`;
  const draft = query.get('draft');
  const draftParam = draft && DRAFT_ID.test(draft) ? `?draftId=${draft}` : '';
  if (id === 'new' || (id === undefined && draftParam)) return `${base}/new${draftParam}`;
  if (id && TeamReportId.safeParse(id).success) return `${base}/${id}`;
  return base;
}

/**
 * The web's Settings and its tabs (`/settings?tab=…`) on the phone (settings-tab-android.md AP-2625): the four groups —
 * You (no tab, or `you`, with `&part=notifications` or `devices`), the assistant (`agent`, with `&part=` and `&key=`),
 * This Whombat (`appliance`, its `&section=`) and Advanced (`advanced`, with `&part=`) — open their pages; the tabs from
 * before where the web sends them (SS-02: `usage` and `ai` to the AI sign-in, `about` to Memory, `spend` to Spend,
 * `repos` and `dev` to GitHub's screen, `feedback` to Website feedback's, `devices` and `notifications` to You,
 * `screen` to the box's screen; AP-2902), and Settings without one (or an unknown one) the Settings tab. Connections'
 * pages are `connectionLinks.ts`'s.
 */
function settingsScreenUrl(tab: string | undefined, search = ''): string {
  const base = `${APP_SCHEME}://`;
  const query = queryOf(search);
  // Connections' pages open the phone's own screens (phone-connect.md PC-02, AP-2902).
  if (tab === 'connections') return connectionsScreenUrl(search);
  const legacy = tab ? legacyConnectionsTabUrl(tab) : null;
  if (legacy) return legacy;
  switch (tab) {
    case undefined:
      return query.get('part') ? youScreenUrl(query.get('part')) : `${base}settings`;
    case 'you':
      return youScreenUrl(query.get('part'));
    case 'agent':
      return agentSettingsUrl(query);
    case 'advanced':
      return advancedScreenUrl(query.get('part'), query.get('key'));
    case 'appliance':
      return whombatSectionUrl(query.get('section'), query);
    case 'skills':
      return `${base}skills`;
    case 'spend':
      return `${base}spend`;
    case 'general':
    case 'profile':
    case 'devices':
      return `${base}settings/profile`;
    case 'about':
      return `${base}settings/agent?part=memory`;
    case 'usage':
    case 'ai':
      return `${base}settings/agent?part=ai`;
    case 'notifications':
      return `${base}settings/notifications`;
    case 'screen':
      return `${base}settings/screen`;
    case 'news':
      return `${base}settings/news`;
    default:
      return `${base}settings`;
  }
}

/** You's part (`&part=`): Notifications its old page, which is You; Prompts its own page; Devices is a row on You. */
function youScreenUrl(part: string | undefined): string {
  if (part === 'prompts') return `${APP_SCHEME}://settings/prompts`;
  return `${APP_SCHEME}://settings/${part === 'notifications' ? 'notifications' : 'profile'}`;
}

/**
 * This Whombat's part (`&section=`): Devices is You's, the assistant's access its What it may do, the box's screen
 * Settings → Screen; anything else This Whombat (a managed Whombat's Overview).
 */
function whombatSectionUrl(section: string | undefined, query: Map<string, string> = new Map()): string {
  const base = `${APP_SCHEME}://`;
  switch (section) {
    case 'backups': {
      // A bring back that waits for the person (finish it, try again) opens its flow from Backups.
      const bringBack =
        query.get('finish') === 'restore' ? 'finish' : query.get('restore') === 'again' ? 'again' : null;
      return `${base}settings/whombat/backups${bringBack ? `?bringBack=${bringBack}` : ''}`;
    }
    case 'devices':
      return `${base}settings/profile`;
    case 'access':
      return `${base}settings/agent?part=may`;
    case 'screen':
      return `${base}settings/screen`;
    default:
      return `${base}settings/whombat`;
  }
}

/** A key row's name in a link (`&key=deploy`), when it looks like one; the screen checks it again. */
const KEY_PARAM = /^[a-z][a-z0-9._-]{0,63}$/;

/**
 * Advanced's page (`&part=`) on the phone: its own pages (the model, the AI on this Whombat, what runs), the screens it
 * had for the others; where a page that moved out of Advanced is now (the keys at `&key=` a page under What it may do,
 * the schedules the Automations tab, the home network ranges the Vault's list, GitHub and Website feedback their
 * connection pages); the list for one without a phone screen (diagnostics) or none.
 */
function advancedScreenUrl(part: string | undefined, key: string | undefined): string {
  const base = `${APP_SCHEME}://`;
  switch (part) {
    case 'model':
    case 'ai':
    case 'running':
      return `${base}settings/advanced/${part}`;
    case 'schedules':
      return `${base}automations`;
    case 'network':
      return `${base}vault`;
    case 'keys':
      return `${base}settings/advanced/keys${key && KEY_PARAM.test(key) ? `?key=${key}` : ''}`;
    case 'spend':
      return `${base}spend`;
    case 'skills':
      return `${base}skills`;
    case 'accounts':
      // Advanced's old list of every connection is Settings → Connections (sidebar-tabs.md).
      return `${base}settings/connections`;
    case 'github':
    case 'feedback':
      return `${base}settings/connections/account/${part}`;
    case 'audit':
      return `${base}log`;
    default:
      return `${base}settings/advanced`;
  }
}

/**
 * `/settings/<tab>`, as a mail account's thing links to Settings → Connections (`/settings/connections`,
 * connections-more-android.md AP-2814) and the agent's link to Settings → Agent (`/settings/agent?part=keys`, AP-4961):
 * the tab's page, as `?tab=<tab>` would open; burrow-less or after the burrow. A first segment that is a screen's isn't a
 * burrow, and a deeper path (a feedback report) isn't a tab.
 */
function settingsTabScreenUrl(pathname: string, search = ''): string | null {
  const m = /^(?:\/([^/]+))?\/settings\/([a-z]+)\/?$/.exec(pathname);
  if (!m?.[2] || (m[1] !== undefined && BURROW_SECTIONS.includes(m[1]))) return null;
  return settingsScreenUrl(m[2], ['agent', 'advanced', 'you', 'appliance'].includes(m[2]) ? search : '');
}

/**
 * The assistant's page's app link (AP-4961): its part (Name and face without one); an old part where it went (the
 * shared `agentPartPlace`: Notes is Memory, the model, what runs, spend and skills Advanced's, schedules Automations);
 * the keys, and What it may do with a key row named, open the phone's keys page at that row.
 */
function agentSettingsUrl(query: Map<string, string>): string {
  const asked = query.get('part');
  const key = query.get('key');
  if (asked === 'keys' || (asked === 'may' && key)) return advancedScreenUrl('keys', key);
  const place = agentPartPlace(asked);
  if (place.group === 'advanced') return advancedScreenUrl(place.part, query.get('key'));
  const part = place.part && place.part !== 'profile' ? `?part=${place.part}` : '';
  return `${APP_SCHEME}://settings/agent${part}`;
}

/**
 * The Work view's addresses, which the servers still write (work-removal-android.md AP-860): `/work/deploys` opens
 * Deploys, `/work` the Inbox, burrow-less or after the burrow (`/burrow-hq/work`). Read before the shared route list, so
 * they open the same whether it still lists them or not; a first segment that is a screen's isn't a burrow (`/pr/work`
 * is no Work view).
 */
function oldWorkScreenUrl(pathname: string): string | null {
  const m = /^(?:\/([^/]+))?\/work(\/deploys)?\/?$/.exec(pathname);
  if (!m || (m[1] !== undefined && BURROW_SECTIONS.includes(m[1]))) return null;
  return `${APP_SCHEME}://${m[2] ? 'deploys' : 'inbox'}`;
}

/**
 * Chat's places (contracts 0.93 CT-445; AP-2456): `/chat`, `/feedback` and `/dashboard` (the shared
 * `parseChatShellLink`; the Dashboard is Connections now, AP-2550), burrow-less or after the burrow; a thread in a room
 * (`?thread=`) is read before this.
 */
function chatShellScreenUrl(pathname: string, query: Map<string, string>): string | null {
  const split = splitBurrowPath(pathname);
  const link = split ? parseChatShellLink(split.path) : null;
  if (!link) return null;
  if (link.place !== 'dashboard') return `${APP_SCHEME}://${link.room}`;
  return overviewAppUrl(query.get('tab'));
}

/** Overview, scrolled to the section an old `?tab=` names (overview-one-page.md OVP-01); else at its top. */
function overviewAppUrl(tab: string | null | undefined): string {
  const section = overviewSectionForTab(tab);
  return section ? `${APP_SCHEME}://connections?tab=${section}` : `${APP_SCHEME}://connections`;
}

/**
 * The one-Whombat shell's addresses (contracts 0.80 `HomeHref`, 0.94 `CONNECTIONS_HREF`; AP-1351, AP-2550):
 * `/connections` (and its old names `/home`, `/things`, `/things/servers`, `/things?add=server`), `/needs-you` (one of
 * its items with `?item=`, NYL-09; Watch's `/watch` too),
 * `/things/server%3Apve-02`, `/chats`, `/chats/cnv_…#msg_…`, `/done` (Everything I did, home-redesign-mobile.md
 * AP-2261), burrow-less or after the burrow. Read before the shared route list, which doesn't list them yet; a first
 * segment that is a screen’s isn’t a burrow (`/pr/watch` is not Watch).
 */
function assistantScreenUrl(
  pathname: string,
  anchor: string | null,
  query: Map<string, string>,
): string | null {
  // The burrow-less form first, then after a burrow (a first segment that isn't a screen's).
  const bare = /^\/(home|connections|needs-you|watch|things|chats|done)(?:\/([^/]+))?\/?$/.exec(pathname);
  const old = bare
    ? null
    : /^\/([^/]+)\/(home|connections|needs-you|watch|things|chats|done)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!bare && (!old?.[1] || BURROW_SECTIONS.includes(old[1]))) return null;
  const base = `${APP_SCHEME}://`;
  const section = bare ? bare[1] : old?.[2];
  const raw = bare ? bare[2] : old?.[3];
  let id: string | null = null;
  if (raw) {
    try {
      id = decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  switch (section) {
    case 'things': {
      // `/things/servers` was the servers' list: Connections now (CN-09). A server's `?guest=` opens the guest (AP-1485).
      // `/things/servers?add=1` is Add a server (AP-1697), filled in from `address`, `user`, `control` and `name`.
      const add = query.get('add');
      if (id === 'servers' && (add === '1' || add === 'server'))
        return addServerAppUrl(addServerPrefill(Object.fromEntries(query)));
      // `/things/servers?repoint=1` is Point them here (BF-16's Needs you item, AP-4421).
      if (id === 'servers' && repointRequested(Object.fromEntries(query))) return `${base}servers/repoint`;
      const guest = query.get('guest');
      if (id && guest && /^server:/.test(id) && guest.length <= 200)
        return `${base}things/${encodeURIComponent(id)}/guests/${encodeURIComponent(guest)}`;
      // A server's updates (`?tab=updates`, AP-2880) have their own screen on the phone.
      if (id && /^server:/.test(id) && query.get('tab') === 'updates')
        return `${base}things/${encodeURIComponent(id)}/updates`;
      // A connection's or device's tab rides along (`?tab=logs`, connection-pages-mobile.md AP-1963).
      const tab = query.get('tab');
      const on =
        tab && /^[a-z][a-z0-9_-]{0,39}$/.test(tab) && !/^server:/.test(id ?? '') ? `?tab=${tab}` : '';
      if (id && id !== 'servers') return `${base}things/${encodeURIComponent(id)}${on}`;
      // The servers' old list is Overview's Servers section.
      return overviewAppUrl(id === 'servers' ? 'servers' : null);
    }
    case 'chats':
      return id && /^[A-Za-z0-9_-]{1,80}$/.test(id)
        ? withAnchor(`${base}chats/${id}`, anchor)
        : `${base}chats`;
    case 'home':
    case 'connections':
      return id ? null : overviewAppUrl(query.get('tab'));
    // The one Needs you list (NYL-05), Watch's address too; `?item=` opens that item (a push, a link; NYL-09).
    case 'needs-you':
    case 'watch': {
      if (id) return null;
      const item = query.get('item');
      return item && item.length <= 200 ? `${base}needs-you/${encodeURIComponent(item)}` : `${base}needs-you`;
    }
    default:
      return id ? null : `${base}${section}`;
  }
}

/**
 * Add a server's app link (AP-1697) for what the web's address fills in (`addServerPrefill`, shared with the web: the
 * address, user name, level and name, clipped; the level only when it is one): `whombat://servers/add?address=…`.
 */
export function addServerAppUrl(p: AddServerPrefill): string {
  const params = [
    ...(p.address ? [`address=${encodeURIComponent(p.address)}`] : []),
    `user=${encodeURIComponent(p.username)}`,
    `control=${p.control}`,
    ...(p.name ? [`name=${encodeURIComponent(p.name)}`] : []),
  ];
  return `${APP_SCHEME}://servers/add?${params.join('&')}`;
}

/** The audit log's address: `?who=` a handle, `?open=` an event, `?actor=` and `?kind=` its filters (MQ-03). */
function logScreenUrl(query: Map<string, string>): string {
  const params: string[] = [];
  for (const key of ['actor', 'kind', 'who', 'open']) {
    const value = query.get(key);
    if (value && /^[A-Za-z0-9_.-]{1,80}$/.test(value)) params.push(`${key}=${encodeURIComponent(value)}`);
  }
  return `${APP_SCHEME}://log${params.length ? `?${params.join('&')}` : ''}`;
}

/**
 * A Files address (files-space.md FS-07): `/files` the list; `/files/dm/chat`, `/files/dm/feedback`,
 * `/files/direct/<id>` (a task chat), `/files/pr/482?repo=owner/name` one conversation's Files, `?folder=Drawings/2024`
 * a folder in it. Anything else under `/files` opens the list.
 */
function filesScreenUrl(path: string, query: Map<string, string>): string {
  const base = `${APP_SCHEME}://files`;
  const [, kind, raw, extra] = path.split('/').filter(Boolean);
  if (!kind || !raw || extra !== undefined) return base;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return base;
  }
  const folder = query.get('folder');
  const params = folder ? [`folder=${encodeURIComponent(folder)}`] : [];
  const tail = (q: string[]) => (q.length ? `?${q.join('&')}` : '');
  switch (kind) {
    case 'dm':
      return id === 'chat' || id === 'feedback' ? `${base}/dm/${id}${tail(params)}` : base;
    case 'direct':
      return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? `${base}/direct/${id}${tail(params)}` : base;
    case 'pr': {
      const number = Number(id);
      if (!Number.isInteger(number) || number <= 0) return base;
      const repo = query.get('repo');
      const named = repo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : null;
      return `${base}/pr/${number}${tail([...(named ? [`repo=${encodeURIComponent(named)}`] : []), ...params])}`;
    }
  }
  return base;
}

/**
 * The web app's origins whose links open the app's screens (AP-709): the build's hosted UI (`EXPO_PUBLIC_WHOMBAT_UI_URL`)
 * and Whombat's own, prod and dev, so a link written by either opens on the phone. Lower case, no trailing slash.
 */
export const WHOMBAT_WEB_ORIGINS = ['https://app.whombat.com', 'https://dev.whombat.com'] as const;

export function appOrigins(uiOrigins: readonly string[]): string[] {
  return [
    ...new Set([...uiOrigins, ...WHOMBAT_WEB_ORIGINS].map((o) => o.trim().replace(/\/+$/, '').toLowerCase())),
  ].filter(Boolean);
}

/**
 * What tapping a URL does (AP-709): a screen of the app (`url` is the `whombat://` link the linking config reads;
 * `burrow` the burrow the link names, if any), or the system's handler — the browser for web pages, the mail app for
 * `mailto:`, and the app itself for hosted-UI links it claims (sign-in, claim, invitations, appliance links, which the
 * managed root handles). Null for anything else: other schemes (`intent:`, `javascript:`, `file:`…) open nothing.
 */
export type UrlTarget =
  /** `path` is the web path the link named (null for a `whombat://` link): a switch to its burrow takes it along. */
  | { kind: 'app'; url: string; burrow: string | null; path: string | null }
  | { kind: 'system'; url: string }
  | null;

/** The `/path?query#hash` of a URL on one of `origins`, or null when it is on another origin (or no URL). */
function pathOnOrigins(url: string, origins: readonly string[]): string | null {
  const m = /^(https?:\/\/[^/?#]+)([/?#].*)?$/i.exec(url);
  if (!m?.[1] || !origins.includes(m[1].toLowerCase())) return null;
  const rest = m[2] ?? '/';
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/**
 * Where a link in a message (or a link preview, a digest item, an external `LinkRef`) goes: Whombat web links
 * (`https://app.whombat.com/chat`, the old `/<burrow>/runs/12`, a bare `/runs/12`) and `whombat://` links open
 * the app's screen when the phone has one; everything else that is a web page opens in the browser.
 */
export function urlTarget(href: string, origins: readonly string[]): UrlTarget {
  const url = href.trim();
  if (!url) return null;
  if (/^whombat:\/\//i.test(url)) {
    // `whombat://appliances/…` names a Whombat and `whombat://auth/…` signs in: the managed root opens those.
    if (/^whombat:\/\/(appliances|auth)\//i.test(url)) return { kind: 'system', url };
    // A notification's URL in a message opens its screen, without marking anything read; a push's means nothing here.
    const notification = parseNotificationUrl(url);
    if (notification) return { kind: 'app', url: notification.url, burrow: null, path: null };
    if (parsePushTapUrl(url) || /^whombat:\/\/(open|push)\b/i.test(url)) return null;
    return { kind: 'app', url, burrow: null, path: null };
  }
  const path = url.startsWith('/') && !url.startsWith('//') ? url : pathOnOrigins(url, origins);
  if (path !== null) {
    const screen = appScreenUrlForPath(path);
    if (screen) return { kind: 'app', url: screen, burrow: burrowOfPath(path), path };
    // A page the phone has no screen for (settings, canvases, the audit log, sign-in links): the web app's.
    const origin = origins[0];
    if (url.startsWith('/')) return origin ? { kind: 'system', url: `${origin}${path}` } : null;
    return { kind: 'system', url };
  }
  return /^(https?:\/\/[^/?#\s]+|mailto:|tel:)/i.test(url) ? { kind: 'system', url } : null;
}

/**
 * The app screen an external link opens (a tapped push's, an Inbox notification's): a page of the app by its path,
 * wherever the person's Whombat lives, or by its address on the web app; null for any other link or page.
 */
export function appScreenOfLink(link: LinkRef, origins: readonly string[]): string | null {
  if (link.type !== 'external') return null;
  const target = urlTarget(link.url, origins);
  return target?.kind === 'app' ? target.url : null;
}

/**
 * The web page of a link (AP-709): a canvas or the audit log on the web app, in the burrow it belongs to (`?burrow=`),
 * and an external link's own URL; null for the rest. Only links `routeForLink` has no screen for are opened with it.
 */
export function webUrlForLink(link: LinkRef, burrow: string, origin: string): string | null {
  switch (link.type) {
    case 'external':
      return link.url;
    case 'canvas':
    case 'log':
      return `${origin.replace(/\/+$/, '')}${withBurrow(appPath(link), burrow)}`;
    default:
      return null;
  }
}

/** A tapped inbox notification: `whombat://open?path=…&burrow=…&notification=…`. */
export interface OpenedNotification {
  /** The app screen to show. */
  url: string;
  burrow: string | null;
  notificationId: string | null;
}

/** Parses the URL an inbox notification opens; null for every other URL. */
export function parseNotificationUrl(url: string | null | undefined): OpenedNotification | null {
  const prefix = `${APP_SCHEME}://open?`;
  if (!url?.startsWith(prefix)) return null;
  const params = new Map<string, string>();
  for (const pair of url.slice(prefix.length).split('&')) {
    const [k, v] = queryPair(pair);
    if (k) params.set(queryPart(k), queryPart(v.replace(/\+/g, ' ')));
  }
  return {
    url: appUrlForPath(params.get('path') ?? ''),
    burrow: params.get('burrow') || null,
    notificationId: params.get('notification') || null,
  };
}

/** The URL an inbox notification should open, for platforms where the app builds it (iOS taps). */
export function notificationUrl(input: {
  path: string;
  burrow: string;
  notificationId: string | null;
}): string {
  const q = [
    `path=${encodeURIComponent(input.path)}`,
    `burrow=${encodeURIComponent(input.burrow)}`,
    ...(input.notificationId ? [`notification=${encodeURIComponent(input.notificationId)}`] : []),
  ];
  return `${APP_SCHEME}://open?${q.join('&')}`;
}

/**
 * A tapped managed push (content-free, MA-10): `whombat://push?kind=…&ref=…`. It names only a generic kind and an
 * opaque ref; what to open is decided from the session (`pushTarget` in `@whombat/client/managed`).
 */
export interface PushTap {
  kind: string;
  ref: string;
}

/**
 * Where a managed push's tap goes when the Whombat names no screen for it (`push.resolve` answered `not_found`, or
 * couldn't be asked): a push about the Whombat itself (`security`: the desk screen asking to unlock, a passkey made)
 * This Whombat, where it is (desk-display-android.md AP-3055); any other the inbox, Needs you (NYL-09).
 */
export function pushTapFallback(kind: string): 'whombat' | 'inbox' {
  if (kind === 'security') return 'whombat';
  return 'inbox';
}

export function pushTapUrl(tap: PushTap): string {
  return `${APP_SCHEME}://push?kind=${encodeURIComponent(tap.kind)}&ref=${encodeURIComponent(tap.ref)}`;
}

export function parsePushTapUrl(url: string | null | undefined): PushTap | null {
  const prefix = `${APP_SCHEME}://push?`;
  if (!url?.startsWith(prefix)) return null;
  const params = new Map<string, string>();
  for (const pair of url.slice(prefix.length).split('&')) {
    const [k, v] = queryPair(pair);
    if (k) params.set(queryPart(k), queryPart(v));
  }
  const kind = params.get('kind');
  const ref = params.get('ref');
  // The ref is opaque, 22–43 base64url characters (CT-32); anything else is not ours.
  if (!kind || !/^[a-z]{1,20}$/.test(kind) || !ref || !/^[A-Za-z0-9_-]{22,43}$/.test(ref)) return null;
  return { kind, ref };
}

/** iOS: the URL for a tapped push's data, or null when it is not a Whombat push. */
export function urlFromPushData(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  // A managed Whombat's APNs push carries `w: {kind, ref}` (control's generic alert).
  const w = (data as { w?: unknown }).w;
  if (w && typeof w === 'object') {
    const { kind, ref } = w as Record<string, unknown>;
    if (typeof kind === 'string' && typeof ref === 'string') {
      const url = pushTapUrl({ kind, ref });
      return parsePushTapUrl(url) ? url : null;
    }
  }
  const { path, burrow, notificationId } = data as Record<string, unknown>;
  if (typeof path !== 'string' || !path) return null;
  return notificationUrl({
    path,
    burrow: typeof burrow === 'string' ? burrow : '',
    notificationId: typeof notificationId === 'string' && notificationId ? notificationId : null,
  });
}

/**
 * What TalkBack says for a “‹ …” button: “Back to Inbox”, or just “Back” when the button names no place
 * (its label is “Back” itself).
 */
export function backButtonLabel(label: string): string {
  const place = label.trim();
  return !place || place.toLowerCase() === 'back' ? 'Back' : `Back to ${place}`;
}
