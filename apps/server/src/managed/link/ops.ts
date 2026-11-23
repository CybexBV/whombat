/**
 * Reach and Updates in Settings → This Whombat (contracts 4.4 `session/reach.ts`; docs/decisions/whombat-link.md):
 *
 * - `reach.get {}` (any of the person's devices): Link's state (null on a box that can't have Link), the own address
 *   (null while it has none) and Tailscale (null where the box can't use it), in one answer.
 * - `link.whombats {}` (any of the person's devices): the other Whombats linked to the same account, for the menu under
 *   the box's name; an empty list while Link doesn't run or control can't be asked.
 * - `link.on {}`, `link.off {}` (the owner): Whombat Link on or off, through the manager, each a signed appliance event
 *   (`link.on`, `link.off`). Refusals carry `details.code` from `LINK_ERROR_CODES`.
 * - `updates.channel.get {}`, `updates.channel.set {channel}` (the owner sets): the update channel the helper keeps;
 *   `staysOn` says the box keeps a newer release until Production passes it. A set is signed (`update.channel_set`).
 *   A manager that can't choose answers `update_channel_unavailable`.
 * - `link.mail.set {offline?, notifications?}` (the owner): which emails Whombat Link sends (`mail.ts`), a signed
 *   appliance event (`link.mail_set`); answers Link with the choices.
 * - `push.token.set {token}`, `push.token.clear {}` (the device itself): push through the box (`push-tokens.ts`).
 */
import { LOCAL_API_VERSION } from '@whombat/control-contracts/local';
import type {
  LinkMailSetInput,
  LinkOutput,
  LinkWhombatsOutput,
  PushTokenSetInput,
  PushTokenSetOutput,
  ReachGetOutput,
  UpdateChannelAuditPayload,
  UpdatesChannelOutput,
  UpdatesChannelSetInput,
} from '@whombat/protocol/session';
import type { z } from 'zod';
import { ApiError } from '../../lib/errors';
import { appendApplianceEvent } from '../audit';
import type { SessionOpContext } from '../dispatcher';
import { ManagerCallError } from '../ports';
import { requireEnrolled, requirePerson } from '../trust';
import { LinkRefusal, refusalOf } from './service';

export const UPDATES_CHANNEL_WORDS = {
  unavailable: 'This Whombat can’t choose where its updates come from yet. It needs an update first.',
  busy: 'An update is being installed. Try again when it’s done.',
  noAnswer: 'Your Whombat didn’t answer. Try again in a moment.',
} as const;

const REFUSAL_STATUS = {
  whombat_link_unavailable: 'unavailable',
  whombat_link_busy: 'conflict',
  whombat_link_rate_limited: 'rate_limited',
  control_unreachable: 'unavailable',
} as const;

function linkError(err: unknown): ApiError {
  const refusal = err instanceof LinkRefusal ? err : refusalOf(err);
  return new ApiError(REFUSAL_STATUS[refusal.code], refusal.message, { details: { code: refusal.code } });
}

function channelUnavailable(): ApiError {
  return new ApiError('unavailable', UPDATES_CHANNEL_WORDS.unavailable, {
    details: { code: 'update_channel_unavailable' },
  });
}

/** The manager's refusal of a channel call as the op's. */
function channelError(err: unknown): ApiError {
  if (err instanceof ManagerCallError) {
    if (err.status === 404) return channelUnavailable();
    if (err.status === 409) return new ApiError('conflict', UPDATES_CHANNEL_WORDS.busy);
  }
  return new ApiError('unavailable', UPDATES_CHANNEL_WORDS.noAnswer);
}

const channelOut = (a: { channel: UpdatesChannelOutput['channel']; staysOn?: string | undefined }) =>
  ({ channel: a.channel, ...(a.staysOn ? { staysOn: a.staysOn } : {}) }) as UpdatesChannelOutput;

export const LINK_SESSION_HANDLERS = {
  'reach.get': async (c: SessionOpContext): Promise<z.input<typeof ReachGetOutput>> => {
    // The person's devices, and their assistant reading it for them.
    requirePerson(c.principal);
    const tailscale = c.tailscale?.managed ? await c.tailscale.refresh().catch(() => null) : null;
    return {
      link: c.link?.summary() ?? null,
      ownAddress: c.ownAddress?.summary() ?? null,
      tailscale: tailscale ?? null,
    };
  },
  'link.whombats': async (c: SessionOpContext): Promise<LinkWhombatsOutput> => {
    requirePerson(c.principal);
    return { whombats: (await c.link?.whombats()) ?? [] };
  },
  'link.on': async (c: SessionOpContext): Promise<LinkOutput> => {
    const { account, endpointId } = requirePerson(c.principal);
    if (!c.link) throw linkError(new LinkRefusal('whombat_link_unavailable', 'no Link'));
    try {
      await c.link.turnOn({ accountId: account.id, endpointId });
    } catch (err) {
      throw linkError(err);
    }
    const link = c.link.summary();
    if (!link) throw linkError(new LinkRefusal('whombat_link_unavailable', 'no Link'));
    c.services.log.info({ state: link.state }, 'link: the owner turned Whombat Link on');
    return { link };
  },
  'link.off': async (c: SessionOpContext): Promise<LinkOutput> => {
    const { account, endpointId } = requirePerson(c.principal);
    if (!c.link) throw linkError(new LinkRefusal('whombat_link_unavailable', 'no Link'));
    try {
      await c.link.turnOff({ accountId: account.id, endpointId });
    } catch (err) {
      throw linkError(err);
    }
    const link = c.link.summary();
    if (!link) throw linkError(new LinkRefusal('whombat_link_unavailable', 'no Link'));
    c.services.log.info({ state: link.state }, 'link: the owner turned Whombat Link off');
    return { link };
  },
  'link.mail.set': async (
    c: SessionOpContext,
    input: z.output<typeof LinkMailSetInput>,
  ): Promise<LinkOutput> => {
    const { account, endpointId } = requirePerson(c.principal);
    if (!c.link || !c.linkEmail) throw linkError(new LinkRefusal('whombat_link_unavailable', 'no Link'));
    await c.linkEmail.set({ accountId: account.id, endpointId }, input);
    const link = c.link.summary();
    if (!link) throw linkError(new LinkRefusal('whombat_link_unavailable', 'no Link'));
    return { link };
  },
  'updates.channel.get': async (c: SessionOpContext): Promise<UpdatesChannelOutput> => {
    requirePerson(c.principal);
    const read = c.manager?.updateChannel?.bind(c.manager);
    if (!read) throw channelUnavailable();
    try {
      return channelOut(await read());
    } catch (err) {
      throw channelError(err);
    }
  },
  'updates.channel.set': async (
    c: SessionOpContext,
    input: z.output<typeof UpdatesChannelSetInput>,
  ): Promise<UpdatesChannelOutput> => {
    const { account, endpointId } = requirePerson(c.principal);
    const set = c.manager?.updateChannelSet?.bind(c.manager);
    if (!set) throw channelUnavailable();
    let answer: Awaited<ReturnType<typeof set>>;
    try {
      answer = await set({ v: LOCAL_API_VERSION, channel: input.channel });
    } catch (err) {
      throw channelError(err);
    }
    const payload: UpdateChannelAuditPayload = { byAccountId: account.id, channel: answer.channel };
    try {
      await c.services.pipeline.transactAccount(async (tx) => {
        await appendApplianceEvent(tx, c.services.custody, {
          type: 'update.channel_set',
          actorAccountId: account.id,
          endpointId,
          payload,
          at: c.services.clock(),
        });
      });
    } catch (err) {
      c.services.log.error(
        { err: String(err).slice(0, 200) },
        'update: the owner’s channel wasn’t recorded in the audit log',
      );
    }
    c.services.log.info(
      { channel: answer.channel, staysOn: answer.staysOn },
      'update: the owner chose a channel',
    );
    return channelOut(answer);
  },
  'push.token.set': async (
    c: SessionOpContext,
    input: z.output<typeof PushTokenSetInput>,
  ): Promise<PushTokenSetOutput> => {
    const { endpoint } = requireEnrolled(c.principal);
    if (!c.pushTokens) return { registered: false };
    return { registered: await c.pushTokens.set(endpoint.id, input.token) };
  },
  'push.token.clear': async (c: SessionOpContext): Promise<{ ok: true }> => {
    const { endpoint } = requireEnrolled(c.principal);
    await c.pushTokens?.clear(endpoint.id);
    return { ok: true };
  },
} as const;
