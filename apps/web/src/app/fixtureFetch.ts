/**
 * Fixture mode (`VITE_FIXTURES=1`, Storybook, tests): the mock world from `@whombat/fixtures` served
 * over the real REST contract, so the UI runs without a server. `createFixtureFetch()` covers the
 * burrow read surface; this wrapper adds the account endpoints the shell needs (session, sign-in,
 * sign-out, preferences, your photo) and work supervision (`@whombat/client/work-fixtures`: plans, activity, `work.overview`).
 * Signing in accepts any email and any 6-digit code or link token; the
 * viewer is always Mara, who owns Burrow HQ.
 */

import { askTitle, needsYouListItems } from '@whombat/client';
import type { FakeMachine } from '@whombat/client/host/fake';
import { createSkillLibraryWorld } from '@whombat/client/skill-library/fixtures';
import type { FakeVoiceWorld } from '@whombat/client/voice/fake';
import { createWorkFixtures } from '@whombat/client/work-fixtures';
import {
  DEFAULT_PREFERENCES,
  HANDOFF_STATES,
  type HandoffState,
  type HomeOverview,
  type HomeRef,
  type LooksAheadView,
  type Membership,
  type Preferences,
} from '@whombat/core';
import { API_ENDPOINTS, matchPath } from '@whombat/core/contracts';
import { burrow, createServicePages, mara, vaultSignInEntries, vaultSshDeployKey } from '@whombat/fixtures';
import { createFixtureFetch, type FixtureFetchOptions } from '@whombat/fixtures/fetch';
import { createFakeAi, FAKE_AI_OPS, type FakeAi, type FakeAiOptions, restAnswer } from '../managed/fake/ai';
import { createAutomationFixtures } from './automationFixtures';
import { createAvatarFixtures } from './avatarFixtures';
import { type BackupWorld, backupsSeeded, createBackupWorld } from './backupFixtures';
import type { FakeBackupPatch } from './backupOptionsFixtures';
import { createCatalogFixtures } from './catalogFixtures';
import { createChatChannelFixtures } from './chatChannelFixtures';
import { codeSeeded } from './codeFixtures';
import { createCommandFixtures } from './commandFixtures';
import { createConnectorFixtures } from './connectorFixtures';
import { councilSeeded } from './councilFixtures';
import { type CouncilSetupWorldOptions, createCouncilSetupFixtures } from './councilSetupFixtures';
import { type DelegationFixture, delegationSeeded } from './delegationFixtures';
import { type DeskFixtureKind, deskFixtureHasBattery, deskFixtureKind } from './deskFixtures';
import { createEssentialsFixtures } from './essentialsFixtures';
import { createEssentialsSettingsFixtures } from './essentialsSettingsFixtures';
import { createFeedbackChatFixtures } from './feedbackChatFixtures';
import { createFilesWorld, type FilesWorld, handleFilesRequest, markMessageFiles } from './filesFixtures';
import { type FirstDayFixture, firstDayFixtureOf } from './firstDayFixtures';
import { createGatewayFixtures, type GatewayFixtureKind } from './gatewayFixtures';
import { createHostFixtures } from './hostFixtures';
import { createHostsFixtureLayer, type HostsFixtureLayer } from './hostsFixtures';
import { createInboxFixtures } from './inboxFixtures';
import { createKeptSiteFixtures } from './keptSiteFixtures';
import { createLocalModelFixtures } from './localModelFixtures';
import { createLookFixtures, looksSeeded } from './lookFixtures';
import { createLooksAheadFixtures } from './looksAheadFixtures';
import { createModelFixtures } from './modelFixtures';
import { createMonitoringFixtures, monitoringSeeded } from './monitoringFixtures';
import { ASSISTANT_NAME, createOneFixtures, DEFAULT_CHAT_ID } from './oneFixtures';
import {
  createOnePasswordFixtures,
  ONEPASSWORD_FIXTURE_ENTRIES,
  type OnePasswordFixtureKind,
  onePasswordFixtureOf,
} from './onePasswordFixtures';
import { createPlaceNewsFixtures } from './placeNewsFixtures';
import { createPromptFixtures, type PromptWorldOptions } from './promptFixtures';
import { createResourcefulFixtures } from './resourcefulFixtures';
import { createRichFixtures } from './richFixtures';
import { createSettleFixtures } from './settleFixtures';
import { createShareFixtures } from './shareFixtures';
import { type StatusFixture, statusFixture, statusFixtureLayer } from './statusFixtures';
import { createTeamReportFixtures, type TeamReportFixtureKind } from './teamReportFixtures';
import { createThingPageFixtures, HOME_ASSISTANT_THING } from './thingPageFixtures';
import { createUnreadFixtures } from './unreadFixtures';
import { createVaultAssistantFixtures } from './vaultAssistantFixtures';
import { createWebSearchFixtures } from './webSearchFixtures';

export const FIXTURE_BASE_URL = 'http://fixtures.local';

/** `VITE_FIXTURE_T3`'s state of the hand-over to T3 Code (AP-6616), null when unset or unknown. */
function handoffFixtureOf(value: string | undefined): HandoffState | null {
  return HANDOFF_STATES.find((s) => s === value) ?? null;
}

export interface WebFixtureOptions {
  /** Start signed in (default true, so screens render straight away). */
  signedIn?: boolean;
  /**
   * The box answers backup options and the list of backups (app backup-options.md AP-6800); false: a box from before
   * (`unknown_op`). Default true.
   */
  backupOptions?: boolean;
  /** What the fake backup service starts with (tests and review shots): not answering, earlier places, … */
  backupFake?: FakeBackupPatch;
  /**
   * A Whombat just claimed (Whombat first-day.md): Chat holds only the welcome — with what the network scan found
   * (`found`) or while it still looks (`looking`) — and Needs you only the backup proposal. Default:
   * `VITE_FIXTURE_FIRST_DAY`.
   */
  firstDay?: FirstDayFixture;
  /** Initial per-user preferences. */
  preferences?: Partial<Preferences>;
  /** Delay before every burrow-read response, for exercising loading skeletons (TODO 16.4). */
  latencyMs?: FixtureFetchOptions['latencyMs'];
  /** Endpoint ids that should 500, for exercising error-with-retry states (TODO 16.4). */
  failing?: FixtureFetchOptions['failing'];
  /** The signed-in account's burrows (default: Burrow HQ). */
  memberships?: Membership[];
  /**
   * The AI side (`signins.*`, `clients.*`): a fake to share with the test, or its options. Default: Claude Code
   * installed (the only client; ChatGPT needs none), Mara signed in to neither, and she may install Claude Code and add
   * organization keys.
   */
  ai?: FakeAi | FakeAiOptions;
  /**
   * Add Pretzel's rich messages to #general (`richFixtures.ts`: an HTML page, a table, a task list, a diagram, a gallery,
   * a PDF and audio; AP-329). Default: `VITE_FIXTURE_RICH=1`, so the mock's screens stay as drawn otherwise.
   */
  rich?: boolean;
  /**
   * Seed the essentials' message states (`essentialsFixtures.ts`: an edited message with a link preview and emoji
   * reactions, a deleted thread root with replies, a pinned message, paged search; AP-453). Default:
   * `VITE_FIXTURE_ESSENTIALS=1`, so the mock's screens stay as drawn otherwise. Editing, deleting, pinning, reactions,
   * the pins list, search filters and new canvases work either way.
   */
  essentials?: boolean;
  /**
   * Add the essentials' settings world (`essentialsSettingsFixtures.ts`: a failed turn with Try again, two repos with a
   * PR #1 each, GitHub through Mara's own sign-in, a retired agent, the notification capabilities; AP-499). Default: `VITE_FIXTURE_ESSENTIALS_SETTINGS=1`, so the mock's screens stay as drawn.
   */
  essentialsSettings?: boolean;
  /**
   * Put the shared fixtures' “Deploy key” SSH key in Mara's Vault (`vaultSshDeployKey`: web-1 trusted, staging waiting
   * for trust, Neo on All servers, Dusty on staging; AP-604). Default: `VITE_FIXTURE_VAULT_SSH=1`, so the Vault's
   * baselines stay as they are otherwise.
   */
  vaultSsh?: boolean;
  /**
   * Add the agent's commands (`commandFixtures.ts`: its always-allowed commands, its `run_command` card in a thread of
   * PR #482's room, the Deploy key with web-1 in production; AP-626, AP-5690). `'no-containers'`: a Whombat without a
   * container engine (`HostInfo.services` and `services.list` say so). Default: `VITE_FIXTURE_COMMANDS` (`1` or
   * `no-containers`), so the mock's screens stay as drawn otherwise.
   */
  commands?: boolean | 'no-containers';
  /**
   * Serve `/connectors` (`connectorFixtures.ts`): Google set up, Mara's account `connected` or `none` (AP-673); and the
   * connections catalog (`catalogFixtures.ts`, AP-764) with its connections or none. Default:
   * `VITE_FIXTURE_CONNECTORS`; the shared world serves none, so Connections says it couldn't load otherwise.
   */
  connectors?: 'connected' | 'none';
  /**
   * Seed the resourceful agents' world (`resourcefulFixtures.ts`: Mara's profile, Neo's and Banjo's notes, Neo's
   * schedules with a card in #incidents, published ports and keep-awake with the computers world; AP-686). Default:
   * `VITE_FIXTURE_RESOURCEFUL=1`. The profile, notes, schedules, the LAN switch, ports, skills from a link and “Always
   * allow” work either way; unseeded they start empty, so the mock's screens stay as drawn.
   */
  resourceful?: boolean;
  /**
   * Seed cards that settle into a line (`settleFixtures.ts`: a report's thread in #incidents with settled lines, runs
   * with what they did inside them, a compact live run, a run that needs a person, work in the reply rows; AP-730…).
   * Default: `VITE_FIXTURE_SETTLE=1`. `runs.list` is served either way.
   */
  settle?: boolean;
  /**
   * Seed Files (`filesFixtures.ts`: #billing-v2's drawings, a brief and a screenshot, Dusty's DM, #general; AP-779).
   * Default: `VITE_FIXTURE_FILES=1`. `files.*` is served either way; unseeded every space starts empty, so the sidebar
   * has no Files row and the mock's screens stay as drawn.
   */
  files?: boolean;
  /** The Files world to serve (the fake managed world shares its own, so its uploads can be saved into Files). */
  filesWorld?: FilesWorld;
  /**
   * Put the seed's read markers on the conversations (`unreadFixtures.ts`: #incidents, Dusty's DM, and #general with
   * `rich`), so the “New” divider and “New messages ↓” show (WX-07). Default: `VITE_FIXTURE_UNREAD=1`.
   */
  unread?: boolean;
  /**
   * Seed automations (`automationFixtures.ts`: some made from recipes, one never turned on, one with steps, their runs,
   * a run of a deleted one, the issues Try it takes, and plans in Chat; AP-975), and serve their endpoints and
   * `repos.list`. Default:
   * `VITE_FIXTURE_AUTOMATIONS=1`; off, the sidebar has no Automations row, as the mock draws it.
   */
  automations?: boolean;
  /**
   * In the assistant shell, move the billing portal to its chat with Mara's assistant, with two reports in it
   * (`feedbackChatFixtures.ts`, feedback-chat.md AP-1837). Default: `VITE_FIXTURE_FEEDBACK_SOURCES=1`.
   */
  feedbackSources?: boolean;
  /**
   * The burrow's AI gateway (`gatewayFixtures.ts`, ai-gateway.md AP-1125): Fusebox with Claude Code switched on and its
   * pool in Usage, or a generic AI gateway. Default: `VITE_FIXTURE_GATEWAY` (`fusebox` or `ai_gateway`); best with
   * `connectors: 'connected'`, whose list it joins. Off, the burrow has none, as the mock draws it.
   */
  gateway?: GatewayFixtureKind;
  /**
   * A 1Password vault kept in step with Mara's Vault (`onePasswordFixtures.ts`, app onepassword-sync.md): the
   * connection, its page part as the last pass left it (`synced`, `waiting`, `failing`, `paused` with removals and the
   * Inbox's card), and the entries it keeps in step. Default: `VITE_FIXTURE_ONEPASSWORD`; best with
   * `connectors: 'connected'`, whose list it joins. Off, Mara has no 1Password, as the mock draws it.
   */
  onePassword?: OnePasswordFixtureKind;
  /**
   * A runner with Claude Code's and Codex's models (`modelFixtures.ts`, model-effort.md AP-1134): the agent on Fable at
   * High effort with the note that its last turn ran on the default. Default: `VITE_FIXTURE_MODELS=1`. Off, the world
   * has no `host.agents`, as the mock draws it.
   */
  models?: boolean;
  /**
   * A model on the burrow's network saved and tested (`localModelFixtures.ts`, hermes-engine-app.md AP-5047): “Llama on
   * the NAS”, and Local in the Chat picker. Default: `VITE_FIXTURE_LOCAL_MODEL=1`. Off, there is none until the person sets
   * one up (served either way).
   */
  localModel?: boolean;
  /**
   * Web search on with a Brave Search key, checked (`webSearchFixtures.ts`, web-search.md). Default:
   * `VITE_FIXTURE_WEB_SEARCH=1`. Off, it is off until the person pastes a key (served either way).
   */
  webSearch?: boolean;
  /**
   * A box with a manager (`hostFixtures.ts`, box-status.md AP-1147): `host.metrics` answers like the approved mock, and
   * spend is the mock's fortnight with today's agents. Default: `VITE_FIXTURE_HOST=1`. Off, `spend.daily` follows the
   * shared world's turns and This Whombat's “How it’s doing” shows only Tokens, as on a self-hosted server.
   */
  host?: boolean;
  /**
   * The box's own screen as a desk display (`deskFixtures.ts`, desk-display-web.md AP-3012, AP-3110): its world
   * (`DeskFixtureKind`). Default: `VITE_FIXTURE_DESK`; off, This Whombat has no SCREEN section.
   */
  desk?: DeskFixtureKind | false;
  /**
   * Voice typing (`voiceFixtures.ts`, docs/decisions/dictation.md): the fake speech service's world (`FakeVoiceWorld`),
   * so the composers have a mic and This Whombat its VOICE TYPING section. Default: `VITE_FIXTURE_VOICE`; off, the box
   * answers `voice.get` as one without it, and the screens stay as the mocks draw them.
   */
  voice?: FakeVoiceWorld | false;
  /**
   * With the box: its battery in “How it’s doing” (AP-3021), plugged in (`ac`) or on battery. Default:
   * `VITE_FIXTURE_POWER`, else plugged in when there is a desk (a laptop has a battery), else none.
   */
  power?: 'ac' | 'battery';
  /**
   * The machine's network and hardware report (`machineFixtures.ts`, hardware-support-web.md AP-3221): `z13`, `vm` or
   * `nodriver`. Default: `VITE_FIXTURE_MACHINE`; off, This Whombat has no NETWORK or HARDWARE section.
   */
  machine?: FakeMachine | false;
  /**
   * Backup files (`backupFixtures.ts`, backup-file.md AP-1205): `api.backups` and the raw transfers are served either
   * way; seeded, Mara has a ready file and a finished restore that needs her. Default: `VITE_FIXTURE_BACKUPS=1`.
   */
  backups?: boolean;
  /** The backup world to serve (the fake managed world shares it with its download and upload streams). */
  backupWorld?: BackupWorld;
  /**
   * Servers (`hostsFixtures.ts`, AP-1340): the mock's five servers through `hosts.*`, Whombat, and a chat about pve-02
   * for the Ask pane. Default: `VITE_FIXTURE_HOSTS=1`, so the mock's other screens stay as drawn.
   */
  hosts?: boolean;
  /**
   * With `hosts`: John's servers for the dashboards (dashboards-web.md AP-2066) — pve-02 and blackbox as the mocks draw
   * them, the-titan, kvm-lab, the-falcon and raspi. Default: `VITE_FIXTURE_DASHBOARDS=1`. Off, the mock's five servers.
   */
  dashboards?: boolean;
  /**
   * Service pages (`@whombat/fixtures` `createServicePages`, contracts 0.121 CT-1011; service-dashboards.md AP-4571):
   * Plex, Seerr, SABnzbd, UniFi Protect and Pi-hole in the sidebar and Connections, and Home Assistant's Controls at the
   * top of its page. Default: `VITE_FIXTURE_SERVICES=1`. Off, their pages still answer by address
   * (`/things/connection:con_plex`), and Home Assistant's page stays as the mock draws it.
   */
  services?: boolean;
  /**
   * Monitoring's states to look at (`monitoringFixtures.ts`): blackbox and UniFi kept quiet, Home Assistant down while
   * its machine is stopped, each page's week and what happened. Default: `VITE_FIXTURE_MONITORING=1` or the visual
   * suite's `whombat:fixture-monitoring`.
   */
  monitoring?: boolean;
  /**
   * With Chat: Mara's thread about tonight's server work (`chatChannelFixtures.ts`, task-feedback.md AP-4304), its task
   * cards running, done, done with warnings and failed. Default: `VITE_FIXTURE_TASKS=1`, so Chat stays as drawn
   * otherwise.
   */
  tasks?: boolean;
  /**
   * With Chat: setting things up from the chat (`chatChannelFixtures.ts`, Whombat connect-in-chat.md), the connect card
   * and the Vault card, open and saved. Default: `VITE_FIXTURE_CONNECT=1`, so Chat stays as drawn otherwise.
   */
  connect?: boolean;
  /**
   * With Chat: pve-02's thread has Neo's last two answers new to Mara (`chatChannelFixtures.ts`, Whombat
   * thread-unread.md), a dot on its reply row. Default: `VITE_FIXTURE_NEW_REPLIES=1`, so Chat stays as drawn otherwise.
   */
  newReplies?: boolean;
  /**
   * With Chat: Mara's Settle bug that Neo handed to T3 Code, in this state (`chatChannelFixtures.ts`, Whombat
   * t3code.md T3-24, t3code-handoff.md AP-6616). Default: `VITE_FIXTURE_T3` (`working`, `asked`, `needs_ok`, `checks`,
   * `ended`), so Chat stays as drawn otherwise.
   */
  handoff?: HandoffState | null;
  /**
   * With Chat: four threads with a council each (`councilFixtures.ts`, Whombat council.md): live at research, building
   * with its checklist waiting under it, building with its tasks at work under it, and the final card with its picture.
   * Default: `VITE_FIXTURE_COUNCIL=1` or the visual suite's `whombat:fixture-council`, so Chat stays as drawn otherwise.
   */
  council?: boolean;
  /**
   * Settings → the assistant → Council (`councilSetupFixtures.ts`): Mara's council set (or none, Whombat seating its
   * own), and what T3 Code runs. Default: set, T3 Code ready.
   */
  councilSetups?: CouncilSetupWorldOptions;
  /** Settings → the assistant → Looks ahead (`looksAheadFixtures.ts`): what differs from Mara's (on, two calendars). */
  looksAhead?: Partial<LooksAheadView>;
  /** Optional Looks ahead findings injected into Mara's Inbox for tests (`looksAheadFixtures.ts`). */
  looksAheadInbox?: readonly import('@whombat/core').NeedsYouItem[];
  /**
   * The person's prompts (`promptFixtures.ts`, Whombat prompts.md): the six Whombat ships and one of Mara's own, T3 Code's
   * projects. Default: known, T3 Code ready (`VITE_FIXTURE_PROMPTS_T3` says otherwise).
   */
  prompts?: PromptWorldOptions;
  /**
   * With Chat: threads in which the assistant offers coding tasks to hand to T3 Code (`delegationFixtures.ts`, Whombat
   * delegate.md): the checklist, at work, ended, or `all` three. Default: `VITE_FIXTURE_DELEGATION` or the visual
   * suite's `whombat:fixture-delegation`, so Chat stays as drawn otherwise.
   */
  delegation?: DelegationFixture | null;
  /**
   * With Chat: five threads with software work going on, a council, a checklist and T3 Code's jobs (`codeFixtures.ts`).
   * Default: `VITE_FIXTURE_CODE=1` or the visual suite's `whombat:fixture-code`, so Chat stays as drawn otherwise.
   */
  code?: boolean;
  /**
   * Looks Neo looked into (`lookFixtures.ts`, look-research-web.md AP-5909): Home Assistant found with its step, UniFi
   * found that only Mara can fix, pve-02 being looked into, each on Home, its page and in a thread of Chat. Default:
   * `VITE_FIXTURE_LOOKS=1` or the visual suite's `whombat:fixture-looks`, so Home and Chat stay as drawn otherwise.
   */
  looks?: boolean;
  /**
   * The status sentence (`statusFixtures.ts`, status-line.md): all good or as the world is, and whether Neo finished things
   * today. Default: `VITE_FIXTURE_STATUS`, `VITE_FIXTURE_DONE` or their `whombat:fixture-*` keys.
   */
  status?: Partial<StatusFixture>;
  /**
   * Reports to the Whombat Team (`teamReportFixtures.ts`, Whombat team-reports.md): `seeded`, `empty`, `stale` or `off`.
   * Default: `VITE_FIXTURE_TEAM_REPORTS` or the visual suite's `whombat:fixture-team-reports`, else off, so the entry
   * stays out of every other screen.
   */
  teamReports?: TeamReportFixtureKind;
}

/** The box's battery in fixture mode (AP-3021): `power`, `VITE_FIXTURE_POWER`, else plugged in with a desk. */
export function powerSeeded(
  options: Pick<WebFixtureOptions, 'power' | 'desk'> = {},
): 'ac' | 'battery' | null {
  const env = import.meta.env.VITE_FIXTURE_POWER;
  const power = options.power ?? (env === 'ac' || env === 'battery' ? env : null);
  return power ?? (deskFixtureHasBattery(deskFixtureKind(options.desk)) ? 'ac' : null);
}

/** Whether fixture mode has a box to measure (`host`, or `VITE_FIXTURE_HOST=1`). */
export function hostSeeded(options: Pick<WebFixtureOptions, 'host'> = {}): boolean {
  return options.host ?? import.meta.env.VITE_FIXTURE_HOST === '1';
}

/** The Deploy key in the commands world (AP-626): web-1 is a production server. */
const COMMANDS_DEPLOY_KEY: typeof vaultSshDeployKey = {
  ...vaultSshDeployKey,
  servers: vaultSshDeployKey.servers.map((s) => (s.name === 'web-1' ? { ...s, production: true } : s)),
};

/** The fixture world's AI endpoints, matched like the server's router. */
const AI_ENDPOINTS = API_ENDPOINTS.filter((e) => FAKE_AI_OPS.has(e.id));

const ACCOUNT = {
  id: 'acc_mara',
  email: mara.email,
  name: mara.name,
  title: '',
  createdAt: '2026-01-05T09:00:00.000Z',
};

const MEMBERSHIPS: Membership[] = [
  {
    burrowId: burrow.id,
    burrowSlug: burrow.slug,
    burrowName: burrow.name,
    principalId: mara.id,
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function unauthorized(): Response {
  return json({ error: { code: 'unauthorized', message: 'Sign in first.' } }, 401);
}

export function createWebFixtureFetch(options: WebFixtureOptions = {}): typeof fetch {
  const commandsOption =
    options.commands ??
    (import.meta.env.VITE_FIXTURE_COMMANDS === '1'
      ? true
      : import.meta.env.VITE_FIXTURE_COMMANDS === 'no-containers'
        ? 'no-containers'
        : false);
  const commands = commandsOption
    ? createCommandFixtures({ containers: commandsOption !== 'no-containers' })
    : null;
  const vaultSsh = options.vaultSsh ?? import.meta.env.VITE_FIXTURE_VAULT_SSH === '1';
  // The sign-in cards' world (`connect`) has the login with its authenticator key and prod-1's kept password too.
  const signIns = options.connect ?? import.meta.env.VITE_FIXTURE_CONNECT === '1';
  const onePassword = options.onePassword ?? onePasswordFixtureOf(import.meta.env.VITE_FIXTURE_ONEPASSWORD);
  const vaultEntries = commands
    ? [COMMANDS_DEPLOY_KEY]
    : signIns
      ? vaultSignInEntries
      : vaultSsh
        ? [vaultSshDeployKey]
        : [];
  const world = createFixtureFetch({
    latencyMs: options.latencyMs,
    failing: options.failing,
    // The entries 1Password brought in (app onepassword-sync.md) join whichever Vault the world has.
    ...(vaultEntries.length || onePassword
      ? { vaultEntries: [...vaultEntries, ...(onePassword ? ONEPASSWORD_FIXTURE_ENTRIES : [])] }
      : {}),
  });
  // Plans, activity and `work.overview` (contracts 0.12), which the shared fixture world doesn't serve.
  const work = createWorkFixtures();
  /**
   * Layers that add a card to Mara's Chat (the failed turn): the Chat layers further out answer its messages by
   * themselves, so these decorate that answer again over them (each keeps its card once, by id).
   */
  const chatCardLayers: { decorate(req: Request, response: Response): Promise<Response> }[] = [];
  const rich = (options.rich ?? import.meta.env.VITE_FIXTURE_RICH === '1') ? createRichFixtures() : null;
  const essentials = createEssentialsFixtures({
    seed: options.essentials ?? import.meta.env.VITE_FIXTURE_ESSENTIALS === '1',
  });
  const failing = new Set(options.failing ?? []);
  const signedIn = options.signedIn ?? true;
  let preferences: Preferences = { ...DEFAULT_PREFERENCES, ...options.preferences };
  const memberships = options.memberships ?? MEMBERSHIPS;
  const models = options.models ?? import.meta.env.VITE_FIXTURE_MODELS === '1';
  const ai: FakeAi =
    options.ai && 'call' in options.ai
      ? options.ai
      : createFakeAi({
          // With the models (AP-1134), Claude Code installed as the runner reports it, Mara signed in to both providers.
          ...(models
            ? {
                installed: { claude: '2.1.296' },
                signedIn: [
                  { provider: 'claude', authMode: 'subscription_cli' },
                  { provider: 'codex', authMode: 'chatgpt' },
                ],
              }
            : { installed: { claude: '2.1.278' } }),
          ...options.ai,
        });

  async function webFixtureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url, FIXTURE_BASE_URL);
    const route = `${req.method} ${url.pathname.replace(/^\/api\/v1/, '')}`;

    switch (route) {
      case 'GET /me':
        return signedIn ? json({ account: ACCOUNT, memberships, preferences }) : unauthorized();
      case 'GET /me/preferences':
        return signedIn ? json(preferences) : unauthorized();
      case 'PATCH /me/preferences': {
        if (!signedIn) return unauthorized();
        preferences = { ...preferences, ...((await req.json()) as Partial<Preferences>) };
        return json(preferences);
      }
    }

    if (!signedIn) return unauthorized();
    const path = url.pathname.replace(/^\/api\/v1/, '');
    for (const ep of AI_ENDPOINTS) {
      if (ep.method !== req.method) continue;
      const params = matchPath(ep.path, path);
      if (!params) continue;
      const text = req.method === 'GET' || req.method === 'DELETE' ? '' : await req.text();
      const answer = await ai.call(
        ep.id,
        params,
        Object.fromEntries(url.searchParams),
        text ? (JSON.parse(text) as Record<string, unknown>) : {},
      );
      if (answer) {
        const r = restAnswer(answer);
        return json(r.body, r.status);
      }
    }
    const supervised = await work.handle(req.clone());
    if (supervised) {
      if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));
      const id = API_ENDPOINTS.find((e) => e.method === req.method && matchPath(e.path, path))?.id;
      if (id && failing.has(id))
        return json({ error: { code: 'internal', message: 'Fixture failure.' } }, 500);
      return supervised;
    }
    const essential = await essentials.handle(req.clone(), world);
    if (essential) return essential;
    const response = await essentials.decorate(req, await world(req));
    if (route === `GET /burrows/${burrow.slug}/bootstrap` && response.ok) {
      // The viewer's stored preferences travel with the bootstrap, as on the server.
      const data = (await response.json()) as Record<string, unknown>;
      return json({ ...data, preferences });
    }
    return response;
  }
  let out: typeof fetch = webFixtureFetch;
  const firstDayWorld = options.firstDay ?? firstDayFixtureOf(import.meta.env.VITE_FIXTURE_FIRST_DAY);
  if (firstDayWorld || (options.automations ?? import.meta.env.VITE_FIXTURE_AUTOMATIONS === '1')) {
    // Innermost: a layer that serves repositories itself (the essentials' settings world) answers `repos.list` first.
    const inner = out;
    // The first day has none yet, but the page answers (first-day.md).
    const automations = createAutomationFixtures({ empty: !!firstDayWorld });
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await automations.handle(req.clone());
        if (own) return own;
      }
      // The automations' own principals in the bootstrap, and a run's thread in #incidents (AP-997).
      return automations.decorate(req, await inner(req.clone()));
    };
  }
  if (commands) {
    // Command allowances, the command card and whether containers run (AP-626, AP-5690) answer first.
    const inner = out;
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await commands.handle(req.clone());
        if (own) return own;
      }
      return commands.decorate(req, await inner(req.clone()));
    };
  }
  if (rich) {
    const inner = out;
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return rich.decorate(req, await inner(req.clone()));
    };
  }
  if (options.unread ?? import.meta.env.VITE_FIXTURE_UNREAD === '1') {
    // Read markers for the “New” divider (WX-07), over Pretzel's messages when they are there.
    const inner = out;
    const unread = createUnreadFixtures({ rich: !!rich });
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return unread.decorate(req, await inner(req.clone()));
    };
  }
  if (options.essentialsSettings ?? import.meta.env.VITE_FIXTURE_ESSENTIALS_SETTINGS === '1') {
    const inner = out;
    const settings = createEssentialsSettingsFixtures(ai);
    chatCardLayers.push(settings);
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await settings.handle(req.clone());
        if (own) return own;
      }
      return settings.decorate(req, await inner(req.clone()));
    };
  }
  const connectors =
    options.connectors ??
    (import.meta.env.VITE_FIXTURE_CONNECTORS === 'connected' ||
    import.meta.env.VITE_FIXTURE_CONNECTORS === 'none'
      ? import.meta.env.VITE_FIXTURE_CONNECTORS
      : undefined);
  if (connectors) {
    // The connections catalog's endpoints (AP-764): its connections with `connected`, none with `none`.
    const catalog = createCatalogFixtures({ connected: connectors === 'connected' });
    const beforeCatalog = out;
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await catalog.handle(req.clone());
        if (own) return own;
      }
      return beforeCatalog(req);
    };
    // The connectors' status, Email (IMAP)'s discover and connect, Check again and Disconnect (AP-2764…).
    const inner = out;
    const accounts = createConnectorFixtures(connectors === 'connected');
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await accounts.handle(req.clone());
        if (own) return own;
      }
      return inner(req);
    };
  }
  {
    // Files (AP-779): its own routes, before the photos so its people wear them too; messages' files say whether they
    // are in Files (AP-834).
    const inner = out;
    const files =
      options.filesWorld ??
      createFilesWorld({ seed: options.files ?? import.meta.env.VITE_FIXTURE_FILES === '1' });
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await handleFilesRequest(req.clone(), files);
        if (own) return own;
      }
      return markMessageFiles(req, await inner(req), files);
    };
  }
  {
    // The Inbox (web-efficiency.md WE-11): Mara's notifications of the mobile mock, read state in the closure.
    const inner = out;
    const inbox = createInboxFixtures();
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await inbox.handle(req.clone());
        if (own) return own;
      }
      return inner(req);
    };
  }
  const gatewayKind =
    options.gateway ??
    (import.meta.env.VITE_FIXTURE_GATEWAY === 'fusebox' ||
    import.meta.env.VITE_FIXTURE_GATEWAY === 'ai_gateway'
      ? import.meta.env.VITE_FIXTURE_GATEWAY
      : undefined);
  if (gatewayKind) {
    // The AI gateway (AP-1125): its switches, its connection and its pool, over every other layer's answers.
    const inner = out;
    const gateway = createGatewayFixtures({ kind: gatewayKind });
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await gateway.handle(req.clone(), (r) => inner(r));
        if (own) return own;
      }
      return gateway.decorate(req, await inner(req));
    };
  }

  const onePasswordFixtures = onePassword ? createOnePasswordFixtures({ kind: onePassword }) : null;
  if (onePasswordFixtures) {
    // The Vault kept in step with 1Password (app onepassword-sync.md): its connection, its page part and its entries'
    // tags, inside the connections' own pages, which find it in the list.
    const inner = out;
    const fixtures = onePasswordFixtures;
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await fixtures.handle(req.clone(), (r) => inner(r));
        if (own) return own;
      }
      return fixtures.decorate(req, await inner(req.clone()));
    };
  }

  {
    // How the box is doing (AP-1147): `spend.daily` always; with the box, the mock's spend for the Tokens card.
    const inner = out;
    const host = createHostFixtures({ box: hostSeeded(options) });
    const daily = `/burrows/${burrow.slug}/spend/daily`;
    const overview = `/burrows/${burrow.slug}/spend`;
    out = (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const path = new URL(req.url, FIXTURE_BASE_URL).pathname.replace(/^\/api\/v1/, '');
      if (signedIn && req.method === 'GET' && path === daily) return Promise.resolve(json(host.daily()));
      if (signedIn && req.method === 'GET' && path === overview && host.overview)
        return Promise.resolve(json(host.overview()));
      return inner(req);
    };
  }
  {
    // Backup files (AP-1205): their own routes, Mara's only.
    const inner = out;
    const backups = options.backupWorld ?? createBackupWorld({ seed: backupsSeeded(options.backups) });
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await backups.handle(req.clone());
        if (own) return own;
      }
      return inner(req);
    };
  }
  let hostsLayer: HostsFixtureLayer | null = null;
  if (options.hosts ?? import.meta.env.VITE_FIXTURE_HOSTS === '1') {
    // Servers and the Ask pane's chats (AP-1340) answer first; the rest is the world's.
    const inner = out;
    const layer = createHostsFixtureLayer(Date.now(), {
      dashboards: options.dashboards ?? import.meta.env.VITE_FIXTURE_DASHBOARDS === '1',
    });
    hostsLayer = layer;
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return signedIn ? layer.fetch(req, (r) => inner(r)) : inner(req);
    };
  }
  {
    // The one-Whombat world (AP-1278): Mara's Whombat, Home, Watch, chats, changes, widgets and the device skill card.
    const inner = out;
    // Service pages (service-dashboards.md AP-4571): answered by address always, listed with `services`.
    const services = createServicePages({ homeAssistant: HOME_ASSISTANT_THING });
    const listServices = options.services ?? import.meta.env.VITE_FIXTURE_SERVICES === '1';
    // “Don’t ask again on pve-02” on the restart card sets the server to Never in the servers' world (AP-1719).
    const firstDay = options.firstDay ?? firstDayFixtureOf(import.meta.env.VITE_FIXTURE_FIRST_DAY);
    const one = createOneFixtures({
      stopAsking: (serverId) => hostsLayer?.stopAsking(serverId),
      ...(listServices ? { moreThings: () => services.things() } : {}),
      ...(firstDay ? { firstDay } : {}),
    });
    // Connections' and devices' own pages over the same world (connection-pages-web.md AP-1900…).
    const pages = createThingPageFixtures(one, { services, controls: listServices });
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const page = await pages.handle(req.clone(), (r) => inner(r));
        if (page) return page;
        const own = await one.handle(req.clone());
        if (own) return own;
      }
      return one.decorate(req, await inner(req.clone()));
    };
  }
  {
    // Monitoring: keeping quiet, what happened and a server's limits, over
    // the servers and the one-Whombat world, whose pages, servers and Home it reads through.
    const inner = out;
    const monitoring = createMonitoringFixtures({ seeded: monitoringSeeded(options.monitoring) });
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return signedIn ? monitoring.fetch(req, (r) => inner(r)) : inner(req);
    };
  }
  if (models) {
    // The agent's model and effort (AP-1134): `host.agents` with the tools' models, the agent's model runtime. Over the
    // one-Whombat layer, which serves the agent itself (one-agent.md AP-4921).
    const inner = out;
    const fixtures = createModelFixtures();
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await fixtures.handle(req.clone(), (r) => inner(r));
        if (own) return own;
      }
      return fixtures.decorate(req, await inner(req));
    };
  }
  {
    // The agent holds a key to each of Mara's entries by itself (vault-self-serve.md AP-4006), as the runtime gives.
    const inner = out;
    const vault = createVaultAssistantFixtures();
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await vault.handle(req.clone(), (r) => inner(r));
        if (own) return own;
      }
      return vault.decorate(req, await inner(req.clone()));
    };
  }
  {
    // Chat (chat-channel.md AP-2411): the default chat is one threaded room, answered here over the one-Whombat layer's
    // chat; the Feedback room is the feedback chat layer's, outside.
    const inner = out;
    const firstDay = options.firstDay ?? firstDayFixtureOf(import.meta.env.VITE_FIXTURE_FIRST_DAY);
    const chat = createChatChannelFixtures({
      tasks: options.tasks ?? import.meta.env.VITE_FIXTURE_TASKS === '1',
      connect: options.connect ?? import.meta.env.VITE_FIXTURE_CONNECT === '1',
      newReplies: options.newReplies ?? import.meta.env.VITE_FIXTURE_NEW_REPLIES === '1',
      handoff: options.handoff ?? handoffFixtureOf(import.meta.env.VITE_FIXTURE_T3),
      council: councilSeeded(options.council),
      delegation: delegationSeeded(options.delegation),
      code: codeSeeded(options.code),
      ...(firstDay ? { firstDay } : {}),
    });
    const discussPath = `/burrows/${burrow.slug}/needs-you/discuss`;
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const path = new URL(req.url, FIXTURE_BASE_URL).pathname.replace(/^\/api\/v1/, '');
        // Talk to Neo about it (Whombat inbox.md IBX-07): the item as Home has it, in a thread Neo opens.
        if (req.method === 'POST' && path === discussPath) {
          const { ref } = (await req.clone().json()) as { ref: HomeRef };
          const home = await inner(
            new Request(new URL(`/api/v1/burrows/${burrow.slug}/home`, FIXTURE_BASE_URL)),
          );
          const overview = (await home.json()) as Pick<HomeOverview, 'needsYou' | 'needsYouList'>;
          const item = needsYouListItems(overview).find(
            (i) => i.ref.kind === ref.kind && i.ref.id === ref.id,
          );
          if (!item)
            return json({ error: { code: 'not_found', message: 'That isn’t in the Inbox any more.' } }, 404);
          const about = item.body ? `${askTitle(item)}. ${item.body}` : `${askTitle(item)}.`;
          return chat.discuss(
            `${about}\n\nWhat would you like to know or do about it?`,
            item.subject ?? null,
          );
        }
        const own = await chat.handle(req.clone());
        if (own) return own;
      }
      return inner(req);
    };
  }
  if (looksSeeded(options.looks)) {
    // What Neo found out about Mara's looks (AP-5909): over Home, the thing pages and Chat, which it adds to.
    const inner = out;
    const looks = createLookFixtures();
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return signedIn ? looks.fetch(req, (r) => inner(r)) : inner(req);
    };
  }
  {
    // The top of Chat (status-line.md): all good or not, and what Neo finished today, over Home's answers.
    const inner = out;
    // Nothing done yet on the first day.
    const firstDayDone =
      (options.firstDay ?? firstDayFixtureOf(import.meta.env.VITE_FIXTURE_FIRST_DAY)) ? { done: false } : {};
    const status = statusFixtureLayer({ ...statusFixture(), ...firstDayDone, ...options.status });
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const res = await inner(req.clone());
      return signedIn ? status(req, res) : res;
    };
  }
  {
    // Settings → Skills (HE-41, HSK-12; AP-5524): the client's world to look at (both groups, switches, edits, removes,
    // restores, shares and Hermes's hub — search, preview, install, the update check and update — in memory).
    const inner = out;
    const library = createSkillLibraryWorld({ agentName: ASSISTANT_NAME });
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn && new URL(req.url).pathname.includes('/skills/')) {
        const own = await library.handle(req.clone());
        if (own) return own;
      }
      return inner(req);
    };
  }
  {
    // Website feedback in a chat (feedback-chat.md AP-1838): the billing portal's reports land in Mara's chat with the
    // agent, added to the one-Whombat layer's chats.
    const inner = out;
    const chat = createFeedbackChatFixtures({
      seed: options.feedbackSources ?? import.meta.env.VITE_FIXTURE_FEEDBACK_SOURCES === '1',
    });
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await chat.handle(req.clone());
        if (own) return own;
      }
      return chat.decorate(req, await inner(req.clone()));
    };
  }
  {
    // Profiles, notes, schedules, the LAN switch, ports and keep-awake, skills from a link, “Always allow” (AP-686):
    // over every other world (the agent's computer, the one-Whombat world, Chat), so it can read and decorate their
    // answers.
    const inner = out;
    const resourceful = createResourcefulFixtures({
      seed: options.resourceful ?? import.meta.env.VITE_FIXTURE_RESOURCEFUL === '1',
    });
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await resourceful.handle(req.clone(), (r) => inner(r));
        if (own) return own;
      }
      return resourceful.decorate(req, await inner(req.clone()));
    };
  }
  {
    // A model on the network (AP-5047): set, test, clear, and its parts of the burrow and the Chat picker; outside Chat,
    // which answers `chats.runtime`, and every layer whose answers carry the burrow.
    const inner = out;
    const local = createLocalModelFixtures({
      seeded: options.localModel ?? import.meta.env.VITE_FIXTURE_LOCAL_MODEL === '1',
    });
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await local.handle(req.clone(), (r) => inner(r));
        if (own) return own;
      }
      return local.decorate(req, await inner(req));
    };
  }
  {
    // Web search (web-search.md): set, check, remove, and its part of the burrow; outside the model on the network so the
    // burrow it answers carries both.
    const inner = out;
    const webSearch = createWebSearchFixtures({
      seeded: options.webSearch ?? import.meta.env.VITE_FIXTURE_WEB_SEARCH === '1',
    });
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await webSearch.handle(req.clone(), (r) => inner(r));
        if (own) return own;
      }
      return webSearch.decorate(req, await inner(req));
    };
  }
  {
    // Where this Whombat is and the news it reads (weather-news.md): its ops and its part of the burrow, outside web
    // search so the burrow it answers carries both.
    const inner = out;
    const placeNews = createPlaceNewsFixtures();
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await placeNews.handle(req.clone(), (r) => inner(r));
        if (own) return own;
      }
      return placeNews.decorate(req, await inner(req));
    };
  }
  {
    // Settled cards (AP-730…) and `runs.list`: outermost, after the resourceful layer, so its schedule's Cancel is here.
    const inner = out;
    const settle = createSettleFixtures({ seed: settleSeeded(options) });
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await settle.handle(req.clone());
        if (own) return own;
      }
      return settle.decorate(req, await inner(req.clone()));
    };
  }
  if (chatCardLayers.length > 0) {
    const inner = out;
    const chatMessages = `/burrows/${burrow.slug}/conversations/${DEFAULT_CHAT_ID}/messages`;
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      let res = await inner(req.clone());
      if (req.method !== 'GET' || !new URL(req.url).pathname.endsWith(chatMessages)) return res;
      for (const layer of chatCardLayers) res = await layer.decorate(req.clone(), res);
      return res;
    };
  }
  {
    // Mara's council (Settings → the assistant → Council): kept in memory, saved and reset as the server does.
    const inner = out;
    const councils = createCouncilSetupFixtures(options.councilSetups);
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await councils.handle(req.clone());
        if (own) return own;
      }
      return inner(req);
    };
  }
  {
    // Shared links (share-links.md): the Share sheet and Settings → You → Shared links.
    const inner = out;
    const shareLinks = createShareFixtures();
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await shareLinks.handle(req.clone());
        if (own) return own;
      }
      return inner(req);
    };
  }
  {
    // Reports to the Whombat Team (Whombat team-reports.md): Your reports, a report, the form and the assistant's draft.
    const inner = out;
    const teamReports = createTeamReportFixtures(
      options.teamReports === undefined ? {} : { kind: options.teamReports },
    );
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await teamReports.handle(req.clone());
        if (own) return own;
      }
      return inner(req);
    };
  }
  {
    // Kept sites (Whombat kept-sites.md): Settings → the assistant → What it may do.
    const inner = out;
    const kept = createKeptSiteFixtures();
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await kept.handle(req.clone());
        if (own) return own;
      }
      return inner(req);
    };
  }
  {
    // Looks ahead (Whombat looks-ahead.md): Settings → the assistant → Looks ahead, and Inbox finding actions.
    const inner = out;
    const ahead = createLooksAheadFixtures(options.looksAhead, options.looksAheadInbox);
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await ahead.handle(req.clone(), (r) => inner(r));
        if (own) return own;
      }
      return inner(req);
    };
  }
  {
    // The person's prompts (Whombat prompts.md): the list, keeping one, T3 Code's projects, and using one, which posts
    // through the worlds inside it.
    const inner = out;
    const prompts = createPromptFixtures(options.prompts);
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await prompts.handle(req.clone(), (r) => inner(r));
        if (own) return own;
      }
      return inner(req);
    };
  }
  if (onePasswordFixtures) {
    // The 1Password guard's card and the connection's page (app onepassword-sync.md): over the one-Whombat layer, which
    // answers Home and the connections' own pages.
    const inner = out;
    const fixtures = onePasswordFixtures;
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const page = fixtures.page(req);
        if (page) return page;
      }
      return fixtures.decorateInbox(req, await inner(req.clone()));
    };
  }
  {
    // People's photos (CT-265, PA-07): outermost, so every answer's people carry them.
    const inner = out;
    const avatars = createAvatarFixtures(ACCOUNT);
    out = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (signedIn) {
        const own = await avatars.handle(req.clone());
        if (own) return own;
      }
      return avatars.decorate(await inner(req));
    };
  }
  return out;
}

/** Whether the settled cards' world is seeded (`settle`, or `VITE_FIXTURE_SETTLE=1`). */
export function settleSeeded(options: Pick<WebFixtureOptions, 'settle'> = {}): boolean {
  return options.settle ?? import.meta.env.VITE_FIXTURE_SETTLE === '1';
}
