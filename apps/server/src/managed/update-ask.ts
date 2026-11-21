/**
 * Ask before updating (docs/decisions/ask-before-updating.md): the owner's switch and their yes to the update waiting
 * for them. The box's manager keeps both and holds the update itself (ABU-02); the runtime only passes the owner's
 * choice on and signs it into the appliance's audit log once the manager took it (ABU-06). The manager then pushes its
 * facts, which move This Whombat's updates and the Inbox item (`update-inbox.ts`).
 *
 * - `appliance.update.ask {askFirst}` → `{askFirst}`: the setting the manager now keeps.
 * - `appliance.update.install {release}` → `{release}`; `conflict` (`update.not_waiting`) when that release no longer
 *   waits for the owner.
 * A manager that can't hold updates (no `askFirst` in its facts, or 404) answers `not_implemented`.
 */
import { LOCAL_API_VERSION } from '@whombat/control-contracts/local';
import type {
  ApplianceUpdateAskInput,
  ApplianceUpdateAskOutput,
  ApplianceUpdateInstallInput,
  ApplianceUpdateInstallOutput,
  UpdateApprovedAuditPayload,
  UpdateAskAuditPayload,
} from '@whombat/protocol/session';
import { ApiError } from '../lib/errors';
import { appendApplianceEvent } from './audit';
import type { SessionOpContext } from './dispatcher';
import { ManagerCallError, type ManagerPort } from './ports';
import { SessionOpError } from './session-error';

export const UPDATE_ASK_WORDS = {
  unavailable: 'This Whombat can’t hold updates for you yet. It needs an update first.',
  noAnswer: 'Your Whombat didn’t answer. Try again in a moment.',
  notWaiting: 'That update isn’t waiting for you any more.',
} as const;

type UpdateManager = Required<Pick<ManagerPort, 'updateAsk' | 'updateApprove'>>;

function managerOf(c: SessionOpContext): { manager: UpdateManager; accountId: string } {
  const account = c.principal.account;
  if (!account) throw new ApiError('unauthorized', 'Enroll this device first.');
  const manager = c.manager;
  // Only a manager that says it keeps the setting can hold updates; offering the switch elsewhere would be a promise
  // nothing keeps.
  if (!manager?.updateAsk || !manager.updateApprove || c.facts.update?.askFirst === undefined)
    throw new SessionOpError('not_implemented', UPDATE_ASK_WORDS.unavailable);
  return { manager: manager as UpdateManager, accountId: account.id };
}

/** The manager's refusal as the op's. */
async function managerCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ManagerCallError && err.status === 409 && err.code === 'not_waiting')
      throw new SessionOpError('conflict', UPDATE_ASK_WORDS.notWaiting, { code: 'update.not_waiting' });
    if (err instanceof ManagerCallError && err.status === 404)
      throw new SessionOpError('not_implemented', UPDATE_ASK_WORDS.unavailable);
    throw new SessionOpError('unavailable', UPDATE_ASK_WORDS.noAnswer);
  }
}

/** The signed record, once the manager took the change. A lost record is logged: the change holds either way. */
async function signed(
  c: SessionOpContext,
  accountId: string,
  event:
    | { type: 'update.ask_set'; payload: UpdateAskAuditPayload }
    | { type: 'update.approved'; payload: UpdateApprovedAuditPayload },
): Promise<void> {
  try {
    await c.services.pipeline.transactAccount(async (tx) => {
      await appendApplianceEvent(tx, c.services.custody, {
        type: event.type,
        actorAccountId: accountId,
        endpointId: c.principal.endpoint?.id ?? null,
        payload: event.payload,
        at: c.services.clock(),
      });
    });
  } catch (err) {
    c.services.log.error(
      { err: String(err).slice(0, 200), type: event.type },
      'update: the owner’s choice wasn’t recorded in the audit log',
    );
  }
}

export const UPDATE_ASK_SESSION_HANDLERS = {
  'appliance.update.ask': async (
    c: SessionOpContext,
    input: ApplianceUpdateAskInput,
  ): Promise<ApplianceUpdateAskOutput> => {
    const { manager, accountId } = managerOf(c);
    const { askFirst } = await managerCall(() =>
      manager.updateAsk({ v: LOCAL_API_VERSION, askFirst: input.askFirst }),
    );
    await signed(c, accountId, { type: 'update.ask_set', payload: { byAccountId: accountId, askFirst } });
    c.services.log.info({ askFirst }, 'update: the owner changed Ask before updating');
    return { askFirst };
  },
  'appliance.update.install': async (
    c: SessionOpContext,
    input: ApplianceUpdateInstallInput,
  ): Promise<ApplianceUpdateInstallOutput> => {
    const { manager, accountId } = managerOf(c);
    const { release } = await managerCall(() =>
      manager.updateApprove({ v: LOCAL_API_VERSION, release: input.release }),
    );
    await signed(c, accountId, { type: 'update.approved', payload: { byAccountId: accountId, release } });
    c.services.log.info({ release }, 'update: the owner approved the update that waited');
    return { release };
  },
};
