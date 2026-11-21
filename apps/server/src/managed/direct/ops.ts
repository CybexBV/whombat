/**
 * The direct connection's session ops (contracts 1.0.0, CT-1254, CT-1257; direct-connection.md DC-13, DC-17):
 *
 * - `host.tailscale`, `.on`, `.off {signOut?}`, `.signIn` (the person): Tailscale for This Whombat, through the manager.
 *   No manager (a development runtime): `host.tailscale` answers `{tailscale: null, reason: 'not_managed'}`, a change
 *   `tailscale.unavailable`; the manager not answering: `reason: 'unavailable'`, or `tailscale.unavailable`; a change
 *   running: `tailscale.busy`.
 * - `enroll.dev` (the `enroll` channel): a development runtime lets a browser on its own machine in — only on a direct
 *   connection over loopback; anywhere else `dev_only`.
 */
import {
  type EnrollDevInput,
  type HostTailscaleChangeOutput,
  type HostTailscaleOnInput,
  type HostTailscaleOutput,
  normalizeTailscaleLoginServer,
  type TailscaleAuditPayload,
  type TailscaleStatus,
} from '@whombat/protocol/session';
import { ApiError } from '../../lib/errors';
import { appendApplianceEvent } from '../audit';
import type { SessionOpContext as DispatchedOpContext } from '../dispatcher';
import { ManagerCallError } from '../ports';
import { SessionOpError } from '../session-error';
import type { TailscaleService } from './tailscale';

function requireEnrolledDevice(c: DispatchedOpContext): void {
  if (!c.principal.account) throw new ApiError('unauthorized', 'Enroll this device first.');
}

function tailscaleOf(c: DispatchedOpContext): TailscaleService {
  requireEnrolledDevice(c);
  const tailscale = c.tailscale;
  if (!tailscale?.managed)
    throw new SessionOpError('unavailable', 'This Whombat can’t use Tailscale.', {
      code: 'tailscale.unavailable',
    });
  return tailscale;
}

/** The manager's refusal as the op's (`tailscale.busy` while a change runs; anything else: it didn't answer). */
async function change<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ManagerCallError && err.code === 'tailscale.busy')
      throw new SessionOpError('conflict', 'Tailscale is still changing. Try again in a moment.', {
        code: 'tailscale.busy',
      });
    throw new SessionOpError('unavailable', 'Tailscale didn’t answer. Try again in a moment.', {
      code: 'tailscale.unavailable',
    });
  }
}

/**
 * The signed record of the person's Tailscale change (contracts 1.1 `tailscale.*`, CT-1306; HE-S219), once the manager took
 * it: who, the login server after it (null: Tailscale's own), whether an `on` moved the box to another one, whether an
 * `off` signed it out. Never a login link, key or certificate.
 */
async function signed(
  c: DispatchedOpContext,
  type: 'tailscale.on' | 'tailscale.off' | 'tailscale.sign_in',
  what: Omit<TailscaleAuditPayload, 'byAccountId'>,
): Promise<void> {
  const account = c.principal.account;
  if (!account) return;
  const payload: TailscaleAuditPayload = { byAccountId: account.id, ...what };
  await c.services.pipeline.transactAccount(async (tx) => {
    await appendApplianceEvent(tx, c.services.custody, {
      type,
      actorAccountId: account.id,
      endpointId: c.principal.endpoint?.id ?? null,
      payload,
      at: c.services.clock(),
    });
  });
}

/** The server the person asked for (`undefined`: keep the box's; `null`: Tailscale's own), normalized (CT-1306). */
function wantedServer(input: HostTailscaleOnInput | undefined): string | null | undefined {
  const raw = input?.loginServer;
  if (raw === undefined || raw === null) return raw;
  const normal = normalizeTailscaleLoginServer(raw);
  if (!normal.ok)
    throw new ApiError('validation_failed', 'That isn’t a login server address Whombat can use.', {
      fields: { loginServer: [normal.problem] },
    });
  return normal.value;
}

const serverOf = (status: TailscaleStatus) => status.loginServer ?? null;

export const DIRECT_SESSION_HANDLERS = {
  'host.tailscale': async (c: DispatchedOpContext): Promise<HostTailscaleOutput> => {
    requireEnrolledDevice(c);
    if (!c.tailscale?.managed) return { tailscale: null, reason: 'not_managed' };
    const tailscale = await c.tailscale.refresh();
    return tailscale ? { tailscale } : { tailscale: null, reason: 'unavailable' };
  },
  'host.tailscale.on': async (
    c: DispatchedOpContext,
    input: HostTailscaleOnInput,
  ): Promise<HostTailscaleChangeOutput> => {
    const tailscale = tailscaleOf(c);
    const wanted = wantedServer(input);
    const on = await change(() => tailscale.turnOn(wanted));
    await signed(c, 'tailscale.on', {
      loginServer: on.loginServer,
      loginServerChanged: on.changed,
      signOut: false,
    });
    return { tailscale: on.status };
  },
  'host.tailscale.off': async (
    c: DispatchedOpContext,
    input: { signOut?: boolean },
  ): Promise<HostTailscaleChangeOutput> => {
    const tailscale = tailscaleOf(c);
    const signOut = input?.signOut === true;
    const status = await change(() => tailscale.turnOff(signOut));
    await signed(c, 'tailscale.off', { loginServer: serverOf(status), loginServerChanged: false, signOut });
    return { tailscale: status };
  },
  'host.tailscale.signIn': async (c: DispatchedOpContext): Promise<HostTailscaleChangeOutput> => {
    const tailscale = tailscaleOf(c);
    const status = await change(() => tailscale.signIn());
    await signed(c, 'tailscale.sign_in', {
      loginServer: serverOf(status),
      loginServerChanged: false,
      signOut: false,
    });
    return { tailscale: status };
  },
  'enroll.dev': (c: DispatchedOpContext, input: EnrollDevInput) => {
    const transport = c.session?.transport;
    if (
      c.services.config.NODE_ENV !== 'development' ||
      transport?.via !== 'direct' ||
      transport.network !== 'loopback'
    )
      throw new ApiError('forbidden', 'Only a Whombat in development lets a device in this way.', {
        details: { code: 'dev_only' },
      });
    return c.trust.developmentEnrol({ peerId: c.principal.peerId, publicKey: c.principal.publicKey }, input);
  },
} as const;
