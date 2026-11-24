/**
 * Every handler of the contract's endpoints (`ROUTES`): the session dispatcher runs the client ones in-process (MR-05);
 * the loopback listener registers only the runner's (`registerApiRoutes`).
 */
import { ALL_ENDPOINTS, type AnyEndpoint } from '@whombat/core';
import type { FastifyInstance } from 'fastify';
import { agentCommandRoutes } from '../agent-commands/routes';
import { agentServiceRoutes } from '../agent-services/routes';
import { automationRoutes } from '../automations/routes';
import { backupRoutes } from '../backups/routes';
import { keptSiteRoutes } from '../browser/kept-site-routes';
import { careRoutes } from '../care/routes';
import { clientRoutes } from '../clients/routes';
import { connectionCatalogRoutes } from '../connections/routes';
import { councilRoutes } from '../council/routes';
import { delegationRoutes } from '../delegate/routes';
import { deploymentRoutes } from '../deployments/routes';
import { deviceSkillRoutes } from '../devices/routes';
import { feedbackRoutes } from '../feedback/routes';
import { filesRoutes } from '../files/space-routes';
import { localRepoRoutes } from '../github/local-repos';
import { githubRoutes } from '../github/routes';
import { guideRoutes } from '../guides/routes';
import { hermesHomeRoutes } from '../hermes-home/routes';
import { oneWhombatRoutes } from '../home/routes';
import { findMyTimelineRoutes } from '../hosts/findmy-timeline-routes';
import { hostsRoutes } from '../hosts/routes';
import { isApplianceLocalPath } from '../lib/local-paths';
import { signInRoutes } from '../managed/providers/routes';
import { signInApiRoutes } from '../managed/providers/signin-routes';
import { memoryRoutes } from '../memory/routes';
import { promptRoutes } from '../prompts/routes';
import { runnerRoutes } from '../runtime/routes';
import { scheduleRoutes } from '../schedules/routes';
import type { Services } from '../services';
import { shareRoutes } from '../shares/routes';
import { skillHubRoutes } from '../skills/hub-routes';
import { libraryRoutes } from '../skills/library-routes';
import { thingRoutes } from '../things/routes';
import { trackerRoutes } from '../trackers/routes';
import { usageRoutes } from '../usage/routes';
import { onePasswordRoutes } from '../vault/onepassword/routes';
import { vaultRoutes } from '../vault/routes';
import { burrowRoutes } from './burrows';
import { connectorRoutes } from './connectors';
import { contentRoutes } from './content';
import { conversationRoutes } from './conversations';
import { notImplemented, type RouteDef, registerRoute } from './define';
import { meRoutes } from './me';
import { peopleRoutes } from './people';
import { supervisionRoutes } from './supervision';
import { workRoutes } from './work';

export const ROUTES: RouteDef[] = [
  // The caller's own account, preferences, profile and photo.
  ...meRoutes,
  ...burrowRoutes,
  ...conversationRoutes,
  // A conversation's Files (docs/decisions/files-space.md).
  ...filesRoutes,
  ...workRoutes,
  ...supervisionRoutes,
  ...contentRoutes,
  // The agent's services: containers it keeps up (one-person.md OP-19).
  ...agentServiceRoutes,
  ...runnerRoutes,
  // The agent's commands: the turn's keys, job wakes, command approvals and allowances (one-person.md OP-07).
  ...agentCommandRoutes,
  ...signInRoutes,
  ...hermesHomeRoutes,
  ...signInApiRoutes,
  ...clientRoutes,
  ...githubRoutes,
  // Repositories created on the Whombat (docs/decisions/repositories.md).
  ...localRepoRoutes,
  ...connectorRoutes,
  // The connections catalog (docs/decisions/connections-catalog.md).
  ...connectionCatalogRoutes,
  // A Find My connection's timeline (docs/decisions/findmy-timeline.md).
  ...findMyTimelineRoutes,
  // What the agent remembers about the person, and the person's notes for it (hermes-engine.md HE-39).
  ...memoryRoutes,
  ...automationRoutes,
  // A run's tracker report, read and answered by the person (docs/decisions/report-trackers.md TA-14, TA-15).
  ...trackerRoutes,
  ...skillHubRoutes,
  // Settings → Skills on Hermes's skills (hermes-engine.md HE-41).
  ...libraryRoutes,
  ...feedbackRoutes,
  ...guideRoutes,
  ...vaultRoutes,
  ...onePasswordRoutes,
  ...usageRoutes,
  // Notification levels (docs/decisions/essentials-people.md).
  ...peopleRoutes,
  // Turns agents schedule for themselves (docs/decisions/resourceful-agents.md RA-30).
  ...scheduleRoutes,
  // Recorded deploys: the Deploys screen (docs/decisions/review-features.md).
  ...deploymentRoutes,
  // Backup files: Settings → Backups (docs/decisions/backup-file.md).
  ...backupRoutes,
  // Shared links (share-links.md).
  ...shareRoutes,
  ...keptSiteRoutes,
  // The person's prompts (prompts.md).
  ...promptRoutes,
  ...councilRoutes,
  ...delegationRoutes,
  // One Whombat: task chats, Home, Watch, changes and widgets (one-whombat-assistant.md).
  ...oneWhombatRoutes,
  ...careRoutes,
  // Servers through the hosts service (docs/decisions/one-whombat-servers.md).
  ...hostsRoutes,
  // Device skills: the person's choice on the card (docs/decisions/one-whombat-devices.md).
  ...deviceSkillRoutes,
  // A connection's or device's own page, its actions and what it runs on (docs/decisions/connection-pages.md).
  ...thingRoutes,
];

/**
 * Registers the endpoints the loopback listener serves (the runner protocol, `isApplianceLocalPath`); a runner endpoint
 * without a handler answers 501. Client endpoints run only over sessions (`managed/dispatcher.ts`).
 */
export function registerApiRoutes(
  app: FastifyInstance,
  services: Services,
): { implemented: number; stubbed: string[] } {
  const byEndpoint = new Map<AnyEndpoint, RouteDef>();
  for (const def of ROUTES) {
    if (byEndpoint.has(def.endpoint)) throw new Error(`Two handlers for ${def.endpoint.id}`);
    byEndpoint.set(def.endpoint, def);
  }
  const stubbed: string[] = [];
  const local = ALL_ENDPOINTS.filter((ep) => isApplianceLocalPath(`${ep.base}${ep.path}`));
  for (const ep of local) {
    let def = byEndpoint.get(ep);
    if (!def) {
      stubbed.push(ep.id);
      def = notImplemented(ep, 'no handler yet');
    }
    registerRoute(app, services, def);
  }
  return { implemented: local.length - stubbed.length, stubbed };
}
