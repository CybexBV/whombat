/**
 * The owner's “Check for updates” (docs/decisions/check-for-updates.md): the box looks for a newer release now instead
 * of at its next hourly look. The manager does the looking and offers what it finds as any update: a release still
 * waits for the owner where “Ask before updating” is on. The runtime only asks and says what came of it; the manager
 * then pushes its facts, which move This Whombat's updates.
 *
 * - `appliance.update.check {}` → `{outcome}`: `found`, `upToDate`, `nothingNewer` or `refused`.
 * A manager that can't check on demand (none here, or 404) answers `not_implemented`; one that couldn't read the release
 * list or reach control, `unavailable`.
 */
import type { UpdateCheckResponse, UpdateFacts } from '@whombat/control-contracts/local';
import type { ApplianceUpdateCheckInput, ApplianceUpdateCheckOutput } from '@whombat/protocol/session';
import { ApiError } from '../lib/errors';
import type { SessionOpContext } from './dispatcher';
import { ManagerCallError } from './ports';
import { SessionOpError } from './session-error';

export const UPDATE_CHECK_WORDS = {
  unavailable: 'This Whombat can check for updates after its next update. Until then it looks once an hour.',
  noAnswer: 'Couldn’t check for updates just now. Try again in a little while.',
} as const;

/**
 * What came of a check, from the manager's answer and its last facts: a release it started or queued was found; one it
 * won't take was refused; otherwise nothing newer — up to date unless an update is already under way.
 */
export function updateCheckOutcome(
  res: Pick<UpdateCheckResponse, 'decision'>,
  update: Pick<UpdateFacts, 'candidate'> | null | undefined,
): ApplianceUpdateCheckOutput['outcome'] {
  if (res.decision === 'started' || res.decision === 'queued') return 'found';
  if (res.decision === 'refused') return 'refused';
  return update?.candidate ? 'nothingNewer' : 'upToDate';
}

export const UPDATE_CHECK_SESSION_HANDLERS = {
  'appliance.update.check': async (
    c: SessionOpContext,
    _input: ApplianceUpdateCheckInput,
  ): Promise<ApplianceUpdateCheckOutput> => {
    if (!c.principal.account) throw new ApiError('unauthorized', 'Enroll this device first.');
    const manager = c.manager;
    if (!manager?.updateCheck) throw new SessionOpError('not_implemented', UPDATE_CHECK_WORDS.unavailable);
    let res: UpdateCheckResponse;
    try {
      res = await manager.updateCheck();
    } catch (err) {
      if (err instanceof ManagerCallError && err.status === 404)
        throw new SessionOpError('not_implemented', UPDATE_CHECK_WORDS.unavailable);
      c.services.log.warn({ err: String(err).slice(0, 200) }, 'update: the owner’s check didn’t get through');
      throw new SessionOpError('unavailable', UPDATE_CHECK_WORDS.noAnswer);
    }
    const outcome = updateCheckOutcome(res, c.facts.update);
    c.services.log.info(
      { result: res.result, decision: res.decision ?? null, outcome },
      'update: the owner checked',
    );
    return { outcome };
  },
};
