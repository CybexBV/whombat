/**
 * Settings → Skills → Add skills on Hermes's hub (contracts 2.0 CT-1413…CT-1416; hermes-skills.md HSK-06…HSK-09), the
 * person only (`mayAddSkills`): browse and search Hermes's three sources, preview a skill with Hermes's scan and what its
 * install policy decides, install it (`skill.installed`), ask Hermes's update check (at most once an
 * hour, `SKILL_UPDATE_CHECK_MS`) and update an installed one through the same scan (`skill.updated`). An identifier
 * outside the three sources (ClawHub, LobeHub, a link, another repository) is refused before the runner is asked.
 */
import {
  api,
  type HermesHubResult,
  SKILL_HUB_RESULTS_MAX,
  SKILL_UPDATE_CHECK_MS,
  type SkillHubPreview,
  type SkillHubUpdatesResponse,
  SkillName,
  skillHubSourceOf,
  skillPolicyReasonText,
} from '@whombat/core';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import type { PrincipalRow } from '../read/principals';
import { commitAs } from '../routes/burrows';
import { type RouteDef, route } from '../routes/define';
import type { Services } from '../services';
import { recordSkillInstall } from './commands';
import { skillsCall } from './hermes';
import {
  findSkill,
  hubUpdated,
  hubUpdatesOf,
  itemOf,
  libraryFacts,
  type SkillViewer,
  setHubUpdates,
  viewerOf,
} from './library';

/** Who may add skills: the person (`mayAddSkills`). */
export function mayAddSkills(principal: PrincipalRow): SkillViewer {
  const viewer = viewerOf(principal);
  if (!viewer.isPerson) throw forbidden('Only you add skills.');
  return viewer;
}

/** Only Hermes's three sources (HSK-06): anything else is refused here, before the runner is asked. */
function checkedIdentifier(identifier: string): string {
  if (!skillHubSourceOf(identifier))
    throw badRequest(
      'Skills come only from Hermes’s own skills, its trusted GitHub repositories and skills.sh.',
    );
  return identifier;
}

/** A hub search row as the contract's (the runner's is the same shape). */
const resultOf = (r: HermesHubResult) => ({ ...r });

/**
 * Hermes's update check (HSK-09): run again when the last is older than an hour, else answered as it was. A check that
 * can't run (no real Hermes, the hub away) answers what the last one found.
 */
export async function hubUpdates(services: Services): Promise<SkillHubUpdatesResponse> {
  const last = hubUpdatesOf(services);
  const fresh = last && services.clock().getTime() - Date.parse(last.checkedAt) < SKILL_UPDATE_CHECK_MS;
  let now = last;
  if (!fresh) {
    try {
      const checked = await skillsCall(services, 'skills.hubCheck', {});
      const named = (status: string) =>
        new Set(
          checked.skills
            .filter((s) => s.status === status && SkillName.safeParse(s.name).success)
            .map((s) => s.name),
        );
      now = {
        checkedAt: services.clock().toISOString(),
        available: named('update_available'),
        unreachable: named('unavailable'),
      };
      setHubUpdates(services, now);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'unavailable')) throw err;
    }
  }
  return {
    checkedAt: now?.checkedAt ?? null,
    available: [...(now?.available ?? [])].sort(),
    unreachable: [...(now?.unreachable ?? [])].sort(),
  };
}

export const skillHubRoutes: RouteDef[] = [
  route(api.skills.hubSearch, async ({ services, access, query }) => {
    mayAddSkills(access.principal);
    const found = await skillsCall(services, 'skills.hubSearch', {
      query: query.q ?? '',
      source: query.source ?? null,
      limit: SKILL_HUB_RESULTS_MAX,
    });
    return {
      results: found.results.slice(0, SKILL_HUB_RESULTS_MAX).map(resultOf),
      unreachable: found.unreachable,
    };
  }),

  route(api.skills.hubPreview, async ({ services, access, query }): Promise<SkillHubPreview> => {
    mayAddSkills(access.principal);
    const seen = await skillsCall(services, 'skills.hubInspect', {
      identifier: checkedIdentifier(query.identifier),
    });
    const decision = seen.scan.decision === 'allow' ? 'allow' : 'block';
    return {
      result: resultOf(seen.result),
      text: seen.text,
      files: seen.files,
      needs: seen.needs,
      platforms: seen.platforms,
      scan: {
        verdict: seen.scan.verdict,
        findings: seen.scan.findings,
        findingsTotal: seen.scan.findingsTotal,
      },
      policy: {
        decision,
        reason: skillPolicyReasonText({ verdict: seen.scan.verdict, trust: seen.scan.trust, decision }),
      },
      nameTaken: seen.taken,
    };
  }),

  route(api.skills.hubInstall, async (ctx) => {
    const { services, access, body } = ctx;
    const viewer = mayAddSkills(access.principal);
    const s = await skillsCall(services, 'skills.hubInstall', {
      identifier: checkedIdentifier(body.identifier),
      by: access.principal.accountId ?? null,
    });
    const item = itemOf(s, await libraryFacts(services, viewer));
    if (!item || !s.hub) throw new ApiError('internal', 'Hermes installed the skill, but it can’t be shown.');
    await commitAs(ctx, recordSkillInstall, {
      type: 'skill.installed',
      name: item.name,
      source: s.hub.source,
      identifier: s.hub.identifier,
      trust: s.hub.trust,
      verdict: s.hub.verdict,
    });
    return { item };
  }),

  route(api.skills.hubUpdates, async ({ services, access }) => {
    mayAddSkills(access.principal);
    return hubUpdates(services);
  }),

  route(api.skills.hubUpdate, async (ctx) => {
    const { services, access, body } = ctx;
    const viewer = mayAddSkills(access.principal);
    const found = await findSkill(services, body.name);
    if (found.origin !== 'hub') throw notFound('Skill');
    const s = await skillsCall(services, 'skills.hubUpdate', {
      path: found.path,
      by: access.principal.accountId ?? null,
    });
    hubUpdated(services, body.name);
    const item = itemOf(s, await libraryFacts(services, viewer));
    if (!item || !s.hub) throw new ApiError('internal', 'Hermes updated the skill, but it can’t be shown.');
    if (s.version !== found.version)
      await commitAs(ctx, recordSkillInstall, {
        type: 'skill.updated',
        name: item.name,
        source: s.hub.source,
        identifier: s.hub.identifier,
        trust: s.hub.trust,
        verdict: s.hub.verdict,
      });
    return { item };
  }),
];
