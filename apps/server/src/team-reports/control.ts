/**
 * The way to control for reports to the Whombat Team (docs/decisions/team-reports.md): the manager's
 * `team.reports.*` routes, which boot hands over, only while Whombat Link is on or in grace. The plain words a
 * person reads when that isn't so, or when control refused, and what the box adds to a new report about itself.
 */
import type { TeamReportRefusalCode } from '@whombat/control-contracts/device';
import { type TeamReportContext, TeamReportContext as TeamReportContextSchema } from '@whombat/core/domain';
import { ApiError } from '../lib/errors';
import { ManagerCallError, type ManagerPort } from '../managed/ports';
import type { Services } from '../services';
import { buildInfo } from '../version';

export type TeamPort = Required<
  Pick<
    ManagerPort,
    'teamReportsList' | 'teamReportsGet' | 'teamReportsCreate' | 'teamReportsReply' | 'teamReportsAct'
  >
>;

interface TeamSetup {
  port: TeamPort;
  /** Whether Link runs now (on or grace): reports are a Link account's. */
  linkOn: () => boolean;
  /** The box's update channel, when the manager says it. */
  channel: () => Promise<TeamReportContext['channel'] | null>;
}

const setups = new WeakMap<Services, TeamSetup>();

/**
 * The manager's team report routes for this runtime, and how to tell whether Link runs (boot hands them over); none on
 * a Whombat without control.
 */
export function useTeamReports(
  services: Services,
  manager: Partial<ManagerPort> | null | undefined,
  linkOn: () => boolean,
): void {
  if (
    !manager?.teamReportsList ||
    !manager.teamReportsGet ||
    !manager.teamReportsCreate ||
    !manager.teamReportsReply ||
    !manager.teamReportsAct
  )
    return;
  const updateChannel = manager.updateChannel?.bind(manager);
  setups.set(services, {
    port: {
      teamReportsList: manager.teamReportsList.bind(manager),
      teamReportsGet: manager.teamReportsGet.bind(manager),
      teamReportsCreate: manager.teamReportsCreate.bind(manager),
      teamReportsReply: manager.teamReportsReply.bind(manager),
      teamReportsAct: manager.teamReportsAct.bind(manager),
    },
    linkOn,
    channel: async () => {
      if (!updateChannel) return null;
      try {
        const { channel } = await updateChannel();
        return channel === 'development' || channel === 'production' ? channel : null;
      } catch {
        return null;
      }
    },
  });
}

/** The way to control, while Link runs; null otherwise (and on a Whombat without control). */
export function teamPortOf(services: Services): TeamPort | null {
  const setup = setups.get(services);
  return setup?.linkOn() ? setup.port : null;
}

/** Whether this Whombat can reach the team at all (Link aside). */
export function teamReportsHere(services: Services): boolean {
  return setups.has(services);
}

/** The plain words for what a person can't do now, or what went wrong. */
export const TEAM_REPORT_WORDS = {
  linkOff: 'Reports to the Whombat Team need Whombat Link. Turn it on in Settings first.',
  off: 'The Whombat Team isn’t taking new reports for a little while. Try again later.',
  unreachable: 'Couldn’t reach Whombat’s servers. Try again in a moment.',
  refused: 'Whombat’s servers didn’t take it. Try again in a moment.',
  unknown: 'That report isn’t there any more.',
  closed: 'This report can’t take that now.',
  rateLimited: 'That’s a lot for one day. Try again tomorrow.',
  invalid: 'Whombat’s servers didn’t accept those words. Shorten them and try again.',
} as const;

/** Control's own code in a manager's refusal (first in its message, “refused report_unknown: …”). */
export function refusalCode(err: unknown): TeamReportRefusalCode | null {
  if (!(err instanceof ManagerCallError) || err.status !== 502) return null;
  const hit =
    /\b(team_reports_unavailable|report_unknown|report_closed|validation_failed|rate_limited)\b/.exec(
      err.message,
    );
  return (hit?.[1] as TeamReportRefusalCode | undefined) ?? null;
}

/** Whether a call failed only because control (or the manager) can't be reached now. */
export function controlUnreachable(err: unknown): boolean {
  return err instanceof ManagerCallError && (err.status === 0 || err.status === 503);
}

/** A failed call to control, in the person's words. */
export function controlFailure(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ManagerCallError) {
    if (err.status === 404 || err.status === 501)
      return new ApiError('unavailable', TEAM_REPORT_WORDS.linkOff);
    if (controlUnreachable(err)) return new ApiError('unavailable', TEAM_REPORT_WORDS.unreachable);
    switch (refusalCode(err)) {
      case 'team_reports_unavailable':
        return new ApiError('not_allowed', TEAM_REPORT_WORDS.off);
      case 'report_unknown':
        return new ApiError('not_found', TEAM_REPORT_WORDS.unknown);
      case 'report_closed':
        return new ApiError('conflict', TEAM_REPORT_WORDS.closed);
      case 'rate_limited':
        return new ApiError('rate_limited', TEAM_REPORT_WORDS.rateLimited);
      case 'validation_failed':
        return new ApiError('bad_request', TEAM_REPORT_WORDS.invalid);
      default:
        return new ApiError('unavailable', TEAM_REPORT_WORDS.refused);
    }
  }
  return new ApiError('unavailable', TEAM_REPORT_WORDS.refused);
}

/** What the box says about itself with a new report: its version and update channel, each when it knows it. */
export async function boxContext(services: Services): Promise<TeamReportContext> {
  const version = TeamReportContextSchema.shape.runtimeVersion.safeParse(buildInfo().version);
  const channel = (await setups.get(services)?.channel()) ?? null;
  return {
    ...(version.success && version.data ? { runtimeVersion: version.data } : {}),
    ...(channel ? { channel } : {}),
  };
}
