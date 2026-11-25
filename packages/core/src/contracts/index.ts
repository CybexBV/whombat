/**
 * `@whombat/core/contracts` — the full REST contract (`api`), realtime frames and events, the runner
 * protocol and the MCP tools. Server registers `ALL_ENDPOINTS`; `@whombat/client` calls them by `api.*`.
 */
import { agentEndpoints } from './agent.js';
import { attachmentEndpoints } from './attachments.js';
import { auditEndpoints } from './audit.js';
import { automationEndpoints } from './automations.js';
import { backupEndpoints } from './backups.js';
import { burrowEndpoints, onboardingEndpoints, repoEndpoints } from './burrows.js';
import { canvasEndpoints } from './canvas.js';
import { changeWindowEndpoints } from './care.js';
import { clientEndpoints } from './clients.js';
import { connectionCatalogEndpoints, connectorAppEndpoints } from './connections.js';
import { connectionEndpoints, connectorEndpoints } from './connectors.js';
import { conversationEndpoints, messageEndpoints, uploadEndpoints } from './conversations.js';
import { councilEndpoints } from './councils.js';
import { delegationEndpoints } from './delegations.js';
import { deploymentEndpoints } from './deployments.js';
import { dispatchEndpoints } from './dispatches.js';
import type { AnyEndpoint } from './endpoint.js';
import { feedbackEndpoints } from './feedback.js';
import { filesEndpoints } from './files.js';
import { findMyTimelineEndpoints } from './findmy-timeline.js';
import { findMyWatchEndpoints } from './findmy-watch.js';
import { githubEndpoints } from './github.js';
import { guideEndpoints } from './guides.js';
import { healthEndpoints } from './health.js';
import {
  changeEndpoints,
  chatEndpoints,
  deviceSkillEndpoints,
  homeEndpoints,
  lookEndpoints,
  needsYouEndpoints,
  overviewEndpoints,
  thingEndpoints,
  watchEndpoints,
  widgetEndpoints,
} from './home.js';
import { hostEndpoints } from './host.js';
import { hostsEndpoints } from './hosts.js';
import { keptSiteEndpoints, keptSiteRunnerEndpoints } from './kept-sites.js';
import { meEndpoints } from './me.js';
import { memoryEndpoints } from './memory.js';
import { deviceEndpoints, notificationEndpoints } from './notifications.js';
import { onePasswordEndpoints } from './onepassword.js';
import { promptEndpoints } from './prompts.js';
import { providerSignInEndpoints } from './providers.js';
import { runnerEndpoints } from './runner.js';
import { scheduleEndpoints } from './schedules.js';
import { searchEndpoints } from './search.js';
import { serviceEndpoints } from './services.js';
import { shareEndpoints } from './shares.js';
import { skillLibraryEndpoints } from './skills-library.js';
import { spendEndpoints } from './spend.js';
import { teamReportEndpoints } from './team-reports.js';
import { trackerEndpoints } from './tracker.js';
import { usageEndpoints } from './usage.js';
import { vaultEndpoints, vaultNetworkEndpoints } from './vault.js';
import {
  activityEndpoints,
  approvalEndpoints,
  planEndpoints,
  prEndpoints,
  runEndpoints,
  workEndpoints,
} from './work.js';

export * from './agent.js';
export * from './attachments.js';
export * from './audit.js';
export * from './automations.js';
export * from './backups.js';
export * from './burrows.js';
export * from './canvas.js';
export * from './care.js';
export * from './clients.js';
export * from './connections.js';
export * from './connectors.js';
export * from './conversations.js';
export * from './councils.js';
export * from './delegations.js';
export * from './deployments.js';
export * from './dispatches.js';
export * from './distribution.js';
export * from './endpoint.js';
export * from './errors.js';
export * from './feedback.js';
export * from './files.js';
export * from './findmy-timeline.js';
export * from './findmy-watch.js';
export * from './github.js';
export * from './guides.js';
export * from './health.js';
export * from './hermes-home.js';
export * from './home.js';
export * from './host.js';
export * from './hosts.js';
export * from './kept-sites.js';
export * from './live-activity.js';
export * from './mcp.js';
export * from './mcp-attachments.js';
export * from './mcp-backup.js';
export * from './mcp-changes.js';
export * from './mcp-connection-look.js';
export * from './mcp-connections.js';
export * from './mcp-connectors.js';
export * from './mcp-council.js';
export * from './mcp-delegate.js';
export * from './mcp-deploy.js';
export * from './mcp-feedback.js';
export * from './mcp-guides.js';
export * from './mcp-one.js';
export * from './mcp-pages.js';
export * from './mcp-preview.js';
export * from './mcp-schedules.js';
export * from './mcp-settings.js';
export * from './mcp-setup.js';
export * from './mcp-shares.js';
export * from './mcp-tailnet.js';
export * from './mcp-team-reports.js';
export * from './mcp-tracker.js';
export * from './mcp-vault.js';
export * from './me.js';
export * from './memory.js';
export * from './notifications.js';
export * from './onepassword.js';
export * from './prompts.js';
export * from './providers.js';
export * from './realtime.js';
export * from './runner.js';
export * from './schedules.js';
export * from './search.js';
export * from './services.js';
export * from './shares.js';
export * from './skills-library.js';
export * from './spend.js';
export * from './team-reports.js';
export * from './tracker.js';
export * from './usage.js';
export * from './vault.js';
export * from './work.js';

/**
 * The type of `api`, spelled out by name so declaration emit refers to each area's type instead of expanding the
 * whole contract (TS7056 once it grew past the compiler's limit in 0.12).
 */
export interface Api {
  health: typeof healthEndpoints;
  me: typeof meEndpoints;
  burrows: typeof burrowEndpoints;
  onboarding: typeof onboardingEndpoints;
  repos: typeof repoEndpoints;
  github: typeof githubEndpoints;
  conversations: typeof conversationEndpoints;
  messages: typeof messageEndpoints;
  uploads: typeof uploadEndpoints;
  files: typeof filesEndpoints;
  prs: typeof prEndpoints;
  runs: typeof runEndpoints;
  approvals: typeof approvalEndpoints;
  plans: typeof planEndpoints;
  activity: typeof activityEndpoints;
  work: typeof workEndpoints;
  agent: typeof agentEndpoints;
  audit: typeof auditEndpoints;
  search: typeof searchEndpoints;
  canvases: typeof canvasEndpoints;
  notifications: typeof notificationEndpoints;
  devices: typeof deviceEndpoints;
  host: typeof hostEndpoints;
  signins: typeof providerSignInEndpoints;
  clients: typeof clientEndpoints;
  connectors: typeof connectorEndpoints & typeof connectorAppEndpoints;
  connections: typeof connectionEndpoints &
    typeof connectionCatalogEndpoints &
    typeof findMyTimelineEndpoints &
    typeof findMyWatchEndpoints &
    typeof onePasswordEndpoints;
  attachments: typeof attachmentEndpoints;
  memory: typeof memoryEndpoints;
  skills: typeof skillLibraryEndpoints;
  automations: typeof automationEndpoints;
  feedback: typeof feedbackEndpoints;
  guides: typeof guideEndpoints;
  vault: typeof vaultEndpoints;
  vaultNetworks: typeof vaultNetworkEndpoints;
  spend: typeof spendEndpoints;
  usage: typeof usageEndpoints;
  dispatches: typeof dispatchEndpoints;
  services: typeof serviceEndpoints;
  schedules: typeof scheduleEndpoints;
  deployments: typeof deploymentEndpoints;
  tracker: typeof trackerEndpoints;
  backups: typeof backupEndpoints;
  shares: typeof shareEndpoints;
  teamReports: typeof teamReportEndpoints;
  keptSites: typeof keptSiteEndpoints;
  prompts: typeof promptEndpoints;
  councils: typeof councilEndpoints;
  delegations: typeof delegationEndpoints;
  home: typeof homeEndpoints;
  overview: typeof overviewEndpoints;
  watch: typeof watchEndpoints;
  needsYou: typeof needsYouEndpoints;
  looks: typeof lookEndpoints;
  changeWindow: typeof changeWindowEndpoints;
  changes: typeof changeEndpoints;
  widgets: typeof widgetEndpoints;
  chats: typeof chatEndpoints;
  deviceSkills: typeof deviceSkillEndpoints;
  things: typeof thingEndpoints;
  hosts: typeof hostsEndpoints;
}

/** Every REST endpoint, grouped by area. */
export const api: Api = {
  health: healthEndpoints,
  me: meEndpoints,
  burrows: burrowEndpoints,
  onboarding: onboardingEndpoints,
  repos: repoEndpoints,
  github: githubEndpoints,
  conversations: conversationEndpoints,
  messages: messageEndpoints,
  uploads: uploadEndpoints,
  /** A conversation's shared Files (Whombat files-space.md FS-04, 0.49, CT-274); session ops too (`files.*`). */
  files: filesEndpoints,
  prs: prEndpoints,
  runs: runEndpoints,
  approvals: approvalEndpoints,
  plans: planEndpoints,
  activity: activityEndpoints,
  work: workEndpoints,
  agent: agentEndpoints,
  audit: auditEndpoints,
  search: searchEndpoints,
  canvases: canvasEndpoints,
  notifications: notificationEndpoints,
  devices: deviceEndpoints,
  host: hostEndpoints,
  /** Provider sign-ins and the Claude sign-in console (CT-70, CT-71); session ops too (`signins.*`). */
  signins: providerSignInEndpoints,
  /** Claude Code installed at the latest tested version (CT-72; ChatGPT needs none); session ops too (`clients.*`). */
  clients: clientEndpoints,
  /** Google and Microsoft apps; since 0.48 an `app_oauth` catalog entry's app (`setApp`, `removeApp`, CX-14). */
  connectors: { ...connectorEndpoints, ...connectorAppEndpoints },
  /**
   * Google and Microsoft connections; since 0.48 the connections catalog (Whombat connections-catalog.md, CT-266…):
   * shared and personal connections of catalog entries, their tools and tiers, OAuth and Nextcloud sign-ins; a Find My
   * connection's timeline (Whombat findmy-timeline.md) and the one-time watch's Cancel (findmy-watch.md); a 1Password
   * connection's sync (Whombat onepassword-sync.md).
   */
  connections: {
    ...connectionEndpoints,
    ...connectionCatalogEndpoints,
    ...findMyTimelineEndpoints,
    ...findMyWatchEndpoints,
    ...onePasswordEndpoints,
  },
  // Buzz-parity workstreams (docs/implementation/buzz-parity/PLAN.md): each file is owned by one workstream.
  attachments: attachmentEndpoints,
  memory: memoryEndpoints,
  /**
   * Settings → Skills on Hermes's skills (since 0.125, CT-1210…CT-1216; since 2.0 Hermes's own hub, CT-1410…CT-1419;
   * Whombat HE-41, HSK-05…HSK-13): for everyone and learned with the caller, sharing, and Hermes's hub
   * (`./skills-library`).
   */
  skills: skillLibraryEndpoints,
  automations: automationEndpoints,
  /** Whombat Feedback (docs/decisions/feedback.md). The public widget surface is not here: see FEEDBACK_PUBLIC_PATHS. */
  feedback: feedbackEndpoints,
  /** Guide cards in a person's Chat (docs/decisions/assistant-guides.md AG-03). */
  guides: guideEndpoints,
  /** The Vault: a person's own entries in a burrow (docs/decisions/vault.md); session ops too (`vault.*`). */
  vault: vaultEndpoints,
  /** This Whombat's home network list for Vault entries (VT-12), account-level like connectors. */
  vaultNetworks: vaultNetworkEndpoints,
  /** What agents' turns used (Whombat spend.md SP-01, SP-02); session ops too (`spend.*`). */
  spend: spendEndpoints,
  /** Subscription usage: the person's windows (CT-154); session ops too. */
  usage: usageEndpoints,
  /** “Try again” on a failed turn (0.26, CT-167); a session op too (`dispatches.retry`). */
  dispatches: dispatchEndpoints,
  /** The agent's services: containers that stay up (Whombat one-person.md OP-19, 3.0, CT-1533); session ops too. */
  services: serviceEndpoints,
  /** Turns agents schedule for themselves (Whombat resourceful-agents.md RA-30, 0.44); session ops too (`schedules.*`). */
  schedules: scheduleEndpoints,
  /** Recorded deploys: Work · Deploys history and board (Whombat improvement-review RF-02, 0.55, CT-296); session ops too. */
  deployments: deploymentEndpoints,
  /** A run's tracker report, read and answered by people (Whombat report-trackers.md TA-14, TA-15; 0.69, CT-325). */
  tracker: trackerEndpoints,
  /**
   * Backup files (Whombat backup-file.md, 0.79, CT-335): make an encrypted file of chosen categories, download it, upload
   * it again and restore; owners only, people only. Session ops too (`backups.*`, feature `backup.file`).
   */
  backups: backupEndpoints,
  /** Shared links (Whombat share-links.md): share a thread of Chat by link, the caller's links. */
  shares: shareEndpoints,
  /** Reports to the Whombat Team (Whombat team-reports.md): problems and ideas, and the team's answers. */
  teamReports: teamReportEndpoints,
  /** Websites the agent keeps signed in between its turns (Whombat kept-sites.md KS-06): the list, stopping one. */
  keptSites: keptSiteEndpoints,
  /** The person's prompts (Whombat prompts.md): the list after `/` in Chat, keeping one, using one on a project. */
  prompts: promptEndpoints,
  /** The council's Go ahead and Stop (Whombat council.md CNL-20, CNL-43). */
  councils: councilEndpoints,
  /** The delegation card's checklist, hand-over and Stop (Whombat delegate.md). */
  delegations: delegationEndpoints,
  // One Whombat (Whombat one-whombat.md, 0.80, CT-336…CT-343): session ops too, feature `shell.assistant`.
  /** Home for the caller (ONE-05). */
  home: homeEndpoints,
  /** Arranging the Overview (Whombat overview-arranged.md). */
  overview: overviewEndpoints,
  /** Watch: alerts, hints, stopped connections, failed automations (ONE-07). */
  watch: watchEndpoints,
  /** Snoozing a Needs you item (ONE-10). */
  needsYou: needsYouEndpoints,
  /** The step the assistant offers on a look (look-research.md). */
  looks: lookEndpoints,
  /** The quiet hours for changes (care-plan.md). */
  changeWindow: changeWindowEndpoints,
  /** Done recently and Undo (ONE-08). */
  changes: changeEndpoints,
  /** Pinned widgets (ONE-09). */
  widgets: widgetEndpoints,
  /** Task chats with the caller's Whombat (ONE-06). */
  chats: chatEndpoints,
  /** The owner's decision on a proposed device skill (ONE-18). */
  deviceSkills: deviceSkillEndpoints,
  /** A connection's or device's own page and its actions (0.88, CT-390; connection-pages.md CP-01…). */
  things: thingEndpoints,
  /** Servers through the hosts service (ONE-11…ONE-15). */
  hosts: hostsEndpoints,
};

/** Runner-only endpoints (`/internal/runner`), with the kept sites' (Whombat kept-sites.md). */
export const runnerApi = { ...runnerEndpoints, ...keptSiteRunnerEndpoints };

function flatten(groups: Record<string, Record<string, AnyEndpoint>>): AnyEndpoint[] {
  return Object.values(groups).flatMap((g) => Object.values(g));
}

/** Every public REST endpoint. */
export const API_ENDPOINTS: readonly AnyEndpoint[] = flatten(
  api as unknown as Record<string, Record<string, AnyEndpoint>>,
);
/** Every endpoint, public and runner. */
export const ALL_ENDPOINTS: readonly AnyEndpoint[] = [
  ...API_ENDPOINTS,
  ...Object.values(runnerApi as unknown as Record<string, AnyEndpoint>),
];
