/**
 * REST for reports to the Whombat Team (`api.teamReports.*`, docs/decisions/team-reports.md): the person's own reports,
 * people only. Each call goes to control first, outside any transaction; what it answered is kept through the commit
 * pipeline (`service.ts`, `commands.ts`).
 */
import { api } from '@whombat/core';
import { type RouteDef, route } from '../routes/define';
import {
  actOnTeamReport,
  createTeamReport,
  getTeamReport,
  listTeamReports,
  personOnly,
  replyToTeamReport,
  teamReportDraftView,
} from './service';

export const teamReportRoutes: RouteDef[] = [
  route(api.teamReports.list, async ({ services, access }) => {
    personOnly(access.principal.kind);
    return listTeamReports(services, access.burrow.id, access.principal.id);
  }),

  route(api.teamReports.get, async ({ services, access, params }) => {
    personOnly(access.principal.kind);
    return { report: await getTeamReport(services, access.burrow.id, access.principal.id, params.reportId) };
  }),

  route(api.teamReports.create, async ({ services, access, body }) => {
    personOnly(access.principal.kind);
    if (body.draftId)
      await teamReportDraftView(services, access.burrow.id, access.principal.id, body.draftId);
    return { report: await createTeamReport(services, access.burrow.id, access.principal.id, body) };
  }),

  route(api.teamReports.reply, async ({ services, access, params, body }) => {
    personOnly(access.principal.kind);
    return {
      report: await replyToTeamReport(
        services,
        access.burrow.id,
        access.principal.id,
        params.reportId,
        body.text,
      ),
    };
  }),

  route(api.teamReports.act, async ({ services, access, params, body }) => {
    personOnly(access.principal.kind);
    return {
      report: await actOnTeamReport(
        services,
        access.burrow.id,
        access.principal.id,
        params.reportId,
        body.action,
      ),
    };
  }),

  route(api.teamReports.draft, async ({ services, access, params }) => {
    personOnly(access.principal.kind);
    return {
      draft: await teamReportDraftView(services, access.burrow.id, access.principal.id, params.draftId),
    };
  }),
];
