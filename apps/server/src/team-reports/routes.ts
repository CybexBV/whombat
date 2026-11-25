/**
 * REST for reports to the Whombat Team (`api.teamReports.*`, docs/decisions/team-reports.md): the person's own reports,
 * people only. Each call goes to control first, outside any transaction; what it answered is kept through the commit
 * pipeline (`service.ts`, `commands.ts`). An answer with a whole report fits one session message: a long conversation
 * comes with its newest messages and the count of those left out, and the list with long titles cut shorter (`fit.ts`).
 */
import { api } from '@whombat/core';
import { type RouteDef, route } from '../routes/define';
import { fitTeamReport, fitTeamReportsList } from './fit';
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
    return fitTeamReportsList(await listTeamReports(services, access.burrow.id, access.principal.id));
  }),

  route(api.teamReports.get, async ({ services, access, params }) => {
    personOnly(access.principal.kind);
    return fitTeamReport(
      await getTeamReport(services, access.burrow.id, access.principal.id, params.reportId),
    );
  }),

  route(api.teamReports.create, async ({ services, access, body }) => {
    personOnly(access.principal.kind);
    return fitTeamReport(await createTeamReport(services, access.burrow.id, access.principal.id, body));
  }),

  route(api.teamReports.reply, async ({ services, access, params, body }) => {
    personOnly(access.principal.kind);
    return fitTeamReport(
      await replyToTeamReport(
        services,
        access.burrow.id,
        access.principal.id,
        params.reportId,
        body.text,
        body.requestId,
      ),
    );
  }),

  route(api.teamReports.act, async ({ services, access, params, body }) => {
    personOnly(access.principal.kind);
    const report = await actOnTeamReport(
      services,
      access.burrow.id,
      access.principal.id,
      params.reportId,
      body.action,
      body.requestId,
    );
    return report ? fitTeamReport(report) : { report: null, earlier: 0 };
  }),

  route(api.teamReports.draft, async ({ services, access, params }) => {
    personOnly(access.principal.kind);
    return {
      draft: await teamReportDraftView(services, access.burrow.id, access.principal.id, params.draftId),
    };
  }),
];
