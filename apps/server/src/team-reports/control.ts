/**
 * The way to control for reports to the Whombat Team (docs/decisions/team-reports.md): the manager's
 * `team.reports.*` routes, which boot hands over. Reading the reports and withdrawing one work whenever control knows
 * the box (Link in any state but off): a person whose Link ended can still read and take back what they sent. Sending a
 * report, a reply or an answer to a fix needs Link on or in grace. The plain words a person reads when that isn't so,
 * or when control refused, and what the box adds to a new report about itself.
 */
import { TeamReportRefusalCode } from '@whombat/control-contracts/device';
import {
  TEAM_REPORTS_OPEN_MAX,
  type TeamReportContext,
  TeamReportContext as TeamReportContextSchema,
} from '@whombat/core/domain';
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

/** Where the box stands with Link, as reports need it. */
export interface TeamLink {
  /** Link is on or in grace: the person may send. */
  on: () => boolean;
  /** Control knows the box (any Link state but off): the person may read and withdraw. */
  known: () => boolean;
  /** The manager says the box is out of Link (`teamReportsLeftLink`): control keeps none of its reports. */
  left?: () => boolean;
}

/** What a call needs: reading or withdrawing (`read`), or sending words or answers to the team (`send`). */
export type TeamUse = 'read' | 'send';

interface TeamSetup {
  port: TeamPort;
  link: TeamLink;
  /** The box's update channel, when the manager says it. */
  channel: () => Promise<TeamReportContext['channel'] | null>;
}

const setups = new WeakMap<Services, TeamSetup>();

/**
 * The manager's team report routes for this runtime, and where the box stands with Link (boot hands them over); none on
 * a Whombat without control.
 */
export function useTeamReports(
  services: Services,
  manager: Partial<ManagerPort> | null | undefined,
  link: TeamLink,
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
    link,
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

/**
 * The way to control for `use`: reading and withdrawing while control knows the box, sending while Link is on or in
 * grace; null otherwise (and on a Whombat without control).
 */
export function teamPortOf(services: Services, use: TeamUse = 'send'): TeamPort | null {
  const setup = setups.get(services);
  if (!setup) return null;
  return (use === 'read' ? setup.link.known() : setup.link.on()) ? setup.port : null;
}

/**
 * Whether the box is out of Link as the manager says it (off, or no Link at all): control deleted the box's reports,
 * so the box drops its copies too. A view only assumed (a manager without Link routes) says nothing.
 */
export function teamReportsLeftLink(view: {
  enabled: boolean;
  assumed: boolean;
  link: { state: string };
}): boolean {
  return !view.assumed && (!view.enabled || view.link.state === 'off');
}

/** Whether the box is out of Link now, as the manager says it: its copies have nothing left to follow at control. */
export function teamReportsOutOfLink(services: Services): boolean {
  return setups.get(services)?.link.left?.() ?? false;
}

/** Whether this Whombat can reach the team at all (Link aside). */
export function teamReportsHere(services: Services): boolean {
  return setups.has(services);
}

/** The plain words for what a person can't do now, or what went wrong. */
export const TEAM_REPORT_WORDS = {
  linkOff: 'Reports to the Whombat Team need Whombat Link. Turn it on in Settings first.',
  /** Link ended: what was sent stays readable, but nothing new goes. */
  sendNeedsLink:
    'Sending to the Whombat Team needs Whombat Link on. You can still read and withdraw your reports.',
  off: 'The Whombat Team isn’t taking new reports for a little while. Try again later.',
  notInvited: 'Sending reports to the Whombat Team isn’t open to you yet.',
  tooManyOpen: `You have ${TEAM_REPORTS_OPEN_MAX} open reports. A new one can go once one of them is closed.`,
  unreachable: 'Couldn’t reach Whombat’s servers. Try again in a moment.',
  refused: 'Whombat’s servers didn’t take it. Try again in a moment.',
  unknown: 'That report isn’t there any more.',
  closed: 'This report can’t take that now.',
  rateLimited: 'That’s a lot for one day. Try again tomorrow.',
  invalid: 'Whombat’s servers didn’t accept those words. Shorten them and try again.',
  draftSent: 'This report was sent already. You’ll find it under Reports.',
  /** The card's yes is sending the draft: the form's words would be lost. */
  draftSending: 'This report is being sent already.',
} as const;

const CODES: ReadonlySet<string> = new Set(TeamReportRefusalCode.options);

/**
 * Control's own code in a manager's refusal. The manager's message starts with control's codes (“refused
 * report_unknown: control refused …”; on the way here inside the manager's JSON answer): the earliest code there
 * counts, never one that only shows up later in control's words.
 */
export function refusalCode(err: unknown): TeamReportRefusalCode | null {
  if (!(err instanceof ManagerCallError) || err.status !== 502) return null;
  const message = /"message":"([^"]*)/.exec(err.message)?.[1] ?? err.message;
  const head = message.split(':', 1)[0] ?? '';
  const code = head.split(/\s+/).find((word) => CODES.has(word));
  return (code as TeamReportRefusalCode | undefined) ?? null;
}

/** Whether a call failed only because control (or the manager) can't be reached now. */
export function controlUnreachable(err: unknown): boolean {
  return err instanceof ManagerCallError && (err.status === 0 || err.status === 503);
}

/**
 * Whether the manager says this box has no way to control for reports now: no team report routes (an older manager),
 * or Link off, which it answers 404.
 */
export function managerSaysNoLink(err: unknown): boolean {
  return err instanceof ManagerCallError && (err.status === 404 || err.status === 501);
}

/**
 * A failed call to control, in the person's words. `use` is what the call did: control's `link_off` on a read (or a
 * withdrawal) means the person has no Link to read with, on a send that they can still read but not send.
 */
export function controlFailure(err: unknown, use: TeamUse = 'send'): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ManagerCallError) {
    if (managerSaysNoLink(err)) return new ApiError('unavailable', TEAM_REPORT_WORDS.linkOff);
    if (controlUnreachable(err)) return new ApiError('unavailable', TEAM_REPORT_WORDS.unreachable);
    switch (refusalCode(err)) {
      case 'team_reports_unavailable':
        return new ApiError('not_allowed', TEAM_REPORT_WORDS.off);
      case 'not_invited':
        return new ApiError('not_allowed', TEAM_REPORT_WORDS.notInvited);
      case 'link_off':
        return use === 'read'
          ? new ApiError('unavailable', TEAM_REPORT_WORDS.linkOff)
          : new ApiError('not_allowed', TEAM_REPORT_WORDS.sendNeedsLink);
      case 'too_many_open':
        return new ApiError('conflict', TEAM_REPORT_WORDS.tooManyOpen);
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
