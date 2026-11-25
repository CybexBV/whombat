/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `1` serves the mock world from `@whombat/fixtures` instead of the server (no socket). */
  readonly VITE_FIXTURES?: string;
  /** `1`: fixture mode also serves the delegation world (the “October release notes” plan and its handoffs). */
  readonly VITE_FIXTURE_HANDOFFS?: string;
  /** `1`: fixture mode also serves the skills world (proposals, crew agents' libraries; `app/skillsFixtures.ts`). */
  /** `1`: fixture mode also serves Pretzel's rich messages in #general (`app/richFixtures.ts`). */
  readonly VITE_FIXTURE_RICH?: string;
  readonly VITE_FIXTURE_UNREAD?: string;
  /** `1`: fixture mode also has Mara's own Assistant, Hazel (`app/assistantFixtures.ts`, FA-04). */
  readonly VITE_FIXTURE_ASSISTANT?: string;
  /** `1`: the essentials' message states (edited, deleted, pinned messages, previews; `app/essentialsFixtures.ts`). */
  readonly VITE_FIXTURE_ESSENTIALS?: string;
  /**
   * `1`: fixture mode also serves the essentials conversations (direct conversations, presence, public, private, muted
   * and archived channels, Browse; `app/conversationFixtures.ts`).
   */
  /** `off`: fixture mode's host says the agents' browser is off (no Chromium), for the notes where it is given. */
  /** `1`: Mara's Vault also holds the “Deploy key” SSH key (`vaultSshDeployKey`, AP-604). */
  readonly VITE_FIXTURE_VAULT_SSH?: string;
  /** `1`: the agent's command card and always-allowed commands (AP-626); `no-containers`: no container engine. */
  readonly VITE_FIXTURE_COMMANDS?: string;
  readonly VITE_FIXTURE_RESOURCEFUL?: string;
  readonly VITE_FIXTURE_SETTLE?: string;
  readonly VITE_FIXTURE_FILES?: string;
  /**
   * `1`: in the assistant shell the billing portal posts in its chat with Mara's assistant, “Website feedback · Billing
   * portal” (`feedbackChatFixtures.ts`).
   */
  readonly VITE_FIXTURE_FEEDBACK_SOURCES?: string;
  readonly VITE_FIXTURE_GATEWAY?: string;
  /** A 1Password vault kept in step with the Vault (`onePasswordFixtures.ts`): synced, waiting, failing or paused. */
  readonly VITE_FIXTURE_ONEPASSWORD?: string;
  readonly VITE_FIXTURE_MODELS?: string;
  /** A model on the network saved (`localModelFixtures.ts`, hermes-engine-app.md AP-5047). */
  readonly VITE_FIXTURE_LOCAL_MODEL?: string;
  /** Web search on with a Brave Search key (`webSearchFixtures.ts`, web-search.md). */
  readonly VITE_FIXTURE_WEB_SEARCH?: string;
  /** `1`: fixture mode has a box to measure: This Whombat's “How it’s doing” as the mock (`app/hostFixtures.ts`). */
  readonly VITE_FIXTURE_HOST?: string;
  /**
   * The box's own screen (`app/deskFixtures.ts`, desk-display-web.md AP-3012, AP-3110): `unpaired`, `paired`,
   * `request`, `other` or `nomic` (a runtime before the switch); `auto`, `pinned`, `theirs`, `off`, `vm` or `unplugged`
   * (with it); unset, no SCREEN section.
   */
  readonly VITE_FIXTURE_DESK?: string;
  /** Voice typing in fixture mode (`voiceFixtures.ts`): `ready`, `gpu`, `downloading`, `failed` or `off`. */
  readonly VITE_FIXTURE_VOICE?: string;
  /** With the box: its battery, `ac` or `battery` (AP-3021); plugged in by default when there is a desk. */
  readonly VITE_FIXTURE_POWER?: string;
  /**
   * The machine's network and hardware (`app/machineFixtures.ts`, hardware-support-web.md AP-3221): `z13`, `vm` or
   * `nodriver`; unset, no NETWORK or HARDWARE section.
   */
  readonly VITE_FIXTURE_MACHINE?: string;
  /** Fixture mode and the fake managed world: a ready backup file and a finished restore (backup-file.md AP-1205). */
  readonly VITE_FIXTURE_BACKUPS?: string;
  /** `assistant`: fixture mode draws the one-Whombat shell (one-whombat-shell.md AP-1257); the crew shell otherwise. */
  readonly VITE_FIXTURE_SHELL?: string;
  /** What answers in Chat in fixture mode (chat-runtime.md AP-2711): `codex-off`, `gateway`, `off`, `none` (no AI signed in). */
  readonly VITE_FIXTURE_CHAT_RUNTIME?: string;
  /** `1`: a Chat thread with server tasks running, done, with warnings and failed (task-feedback.md AP-4304). */
  readonly VITE_FIXTURE_TASKS?: string;
  /** `1`: Chat threads with the connect card and the Vault card, open and saved (connect-in-chat.md). */
  readonly VITE_FIXTURE_CONNECT?: string;
  /** `1`: pve-02's Chat thread has new answers from Neo (thread-unread.md). */
  readonly VITE_FIXTURE_NEW_REPLIES?: string;
  /** A thread handed to T3 Code, in this state (t3code-handoff.md AP-6616). */
  readonly VITE_FIXTURE_T3?: string;
  /** `1`: Chat threads with a council each, live, waiting for the go-ahead, building and done (`councilFixtures.ts`). */
  readonly VITE_FIXTURE_COUNCIL?: string;
  /** Fixture mode: five of Mara’s Chat threads with software work going on (`codeFixtures.ts`); `jobs` adds a T3 Code job in every state of the job view. */
  readonly VITE_FIXTURE_CODE?: string;
  /** `none`: Settings → the assistant → Council starts with none set (`councilSetupFixtures.ts`). */
  readonly VITE_FIXTURE_COUNCIL_SETUP?: string;
  /** How T3 Code answers for a prompt's projects in fixture mode: `ready` (default), `not_connected`, `unreachable`. */
  readonly VITE_FIXTURE_PROMPTS_T3?: string;
  /** Chat threads with a delegation to T3 Code: `offer`, `working`, `done`, or `1` for all three (`delegationFixtures.ts`). */
  readonly VITE_FIXTURE_DELEGATION?: string;
  /** `1`: looks Neo looked into, on Home, their pages and in Chat (`lookFixtures.ts`, AP-5909). */
  readonly VITE_FIXTURE_LOOKS?: string;
  readonly VITE_FIXTURE_MONITORING?: string;
  /** Reports to the Whombat Team: `seeded`, `empty`, `stale` or `off` (`teamReportFixtures.ts`). */
  readonly VITE_FIXTURE_TEAM_REPORTS?: string;
  /** `good`: nothing open and every thing fine, for the status sentence (`statusFixtures.ts`, status-line.md). */
  readonly VITE_FIXTURE_STATUS?: string;
  /** `0`: Neo finished nothing today, so nothing was fixed today (`statusFixtures.ts`). */
  readonly VITE_FIXTURE_DONE?: string;
  /** Servers, Whombat and a chat about pve-02 (hostsFixtures.ts, AP-1340). */
  readonly VITE_FIXTURE_HOSTS?: string;
  /** With the servers: John's servers for the dashboards (`dashboardFixtures`; dashboards-web.md AP-2066). */
  readonly VITE_FIXTURE_DASHBOARDS?: string;
  /** `1`: Plex, Seerr, SABnzbd, Protect and Pi-hole listed, Home Assistant's Controls (service-dashboards.md AP-4571). */
  readonly VITE_FIXTURE_SERVICES?: string;
  readonly VITE_FIXTURE_AUTOMATIONS?: string;
  /** `1`: the essentials' settings world in fixture mode (failed turns, PR #1 of two repos, GitHub sign-in, AP-499). */
  readonly VITE_FIXTURE_ESSENTIALS_SETTINGS?: string;
  /** `connected` or `none`: serve `/connectors` with Google set up, Mara's account connected or not (AP-673). */
  readonly VITE_FIXTURE_CONNECTORS?: string;
  /** A Whombat just claimed (`found` | `looking`; Whombat first-day.md). */
  readonly VITE_FIXTURE_FIRST_DAY?: string;
  /**
   * `box` (default): the page a box serves on its direct ways, talking to its own origin (HE-50); `hosted`: the app at
   * app.whombat.com, through control (hermes-engine-app.md AP-5322).
   */
  readonly VITE_WHOMBAT_TARGET?: 'box' | 'hosted';
  /** Managed mode: the control API origin (default https://api.whombat.com). */
  readonly VITE_WHOMBAT_CONTROL_URL?: string;
  /** Managed mode: relay origins allowed in connect-src (space-separated). */
  readonly VITE_WHOMBAT_RELAY_ORIGINS?: string;
  /** `1`: managed mode against the in-browser fake control and appliances (development, e2e; never prod). */
  readonly VITE_WHOMBAT_FAKE?: string;
  /** Build id sent in the session `hello` (release builds set it). */
  readonly VITE_WHOMBAT_BUILD?: string;
  /** The web app's release version (`apps/web/package.json`'s); set by `vite.config.ts` (SS-06). */
  readonly VITE_WHOMBAT_VERSION?: string;
  /** The vendored contracts version the app was built with; set by `vite.config.ts` (SS-06). */
  readonly VITE_WHOMBAT_CONTRACTS?: string;
  /** Integer build counter (CT-53 client security floor); set by `vite.config.ts` (`webBuildNumber`). */
  readonly VITE_WHOMBAT_BUILD_NUMBER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
