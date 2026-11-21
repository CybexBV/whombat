/**
 * The browser in a Whombat Feedback assessment (docs/decisions/feedback.md FB-28; hermes-engine.md HE-S140): an
 * assessor holding “Use a web browser” at `can` may look at the reported website — the sites of the integration's
 * allowed origins, and nothing else — with Hermes's browser in the turn's own sandbox, which the runner keeps to those
 * sites (Chromium's own proxy script and the CDP relay) and the turn's policy to looking. An assessment is an
 * outsiders' turn (one-person.md OP-17, OP-S59): it never signs in with the person's Vault logins.
 */
import { BrowserSite } from '@whombat/core/contracts';
import { and, eq, like } from 'drizzle-orm';
import { siteOf } from '../browser/sites';
import { activities, feedbackIntegrations, feedbackReports } from '../db/schema/index';
import { loadGrants } from '../read/principals';
import type { Services } from '../services';

export interface AssessorBrowser {
  /** The sites the assessor may open (the integration's allowed origins), in the person's order. */
  sites: string[];
}

/**
 * Whether an assessment turn may use the browser, and where: the dispatch is the report's running assessment, its
 * agent holds `browser.use` at `can` (an `ask` would put an approval in front of a person for each call a visitor's
 * report steers), and the integration has at least one allowed origin with a site. Null for anything else.
 */
export async function assessorBrowser(
  services: Services,
  dispatch: { id: string; trigger: string; agentId: string },
): Promise<AssessorBrowser | null> {
  if (dispatch.trigger !== 'feedback') return null;
  const grants = await loadGrants(services.db, dispatch.agentId);
  if (!grants.some((g) => g.keyId === 'browser.use' && g.tier === 'can')) return null;
  const [row] = await services.db
    .select({ state: feedbackReports.assessmentState, settings: feedbackIntegrations.settings })
    .from(feedbackReports)
    .innerJoin(feedbackIntegrations, eq(feedbackIntegrations.id, feedbackReports.integrationId))
    .where(eq(feedbackReports.assessmentDispatchId, dispatch.id));
  if (row?.state !== 'running') return null;
  // Only a site the turn's browser can be kept to (a registrable domain, `BrowserSite`): an origin by its IP address or
  // a single-label name (`localhost`) gives the assessor no browser rather than an assessment that can't start.
  const sites = row.settings.allowedOrigins
    .map((origin) => siteOf(origin))
    .filter((s): s is string => Boolean(s) && BrowserSite.safeParse(s).success);
  if (!sites.length) return null;
  return { sites: [...new Set(sites)] };
}

/** Whether an assessment opened a page in its browser (FB-28): an activity row of Hermes's `browser_navigate`. */
export async function assessorBrowsed(db: Services['db'], dispatchId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: activities.id })
    .from(activities)
    .where(and(eq(activities.dispatchId, dispatchId), like(activities.tool, '%browser_navigate%')))
    .limit(1);
  return row !== undefined;
}
