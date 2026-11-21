/**
 * What a box answers by itself, without control (contracts 1.1.0, CT-1302…CT-1308; hermes-engine.md HE-59…HE-61,
 * HE-S206…HE-S229):
 *
 * - `enroll.claim.local.start`, `.begin`, `.prove`, `enroll.claim.local` (enrollment channel, a community box, or a box
 *   inside A3 on a page it served; at its own address with the claim link): the claim on the box's own page with the
 *   letters on its screen (`trust.ts`).
 * - `enroll.link.create` (any enrolled device) and `enroll.link.accept` (enrollment channel): a QR code or link that lets
 *   one more device of the same account in, for five minutes, once.
 * - `host.mail`, `.set`, `.test`, `.remove` (the person): the person's own mail server (`mail/box.ts`). The test goes
 *   to the person's own email only.
 */
import type {
  EnrollClaimLocalBeginInput,
  EnrollClaimLocalInput,
  EnrollClaimLocalProveInput,
  EnrollClaimLocalStartInput,
  EnrollLinkAcceptInput,
  HostMailOutput,
  HostMailTestOutput,
  MailSettingsInput,
} from '@whombat/protocol/session';
import type { z } from 'zod';
import type { SessionOpContext } from './dispatcher';
import { requireEnrolled, requirePerson } from './trust';

const identityOf = (c: SessionOpContext) => ({
  peerId: c.principal.peerId,
  publicKey: c.principal.publicKey,
});

/** The person acting, as the signed events name them. */
function actor(c: SessionOpContext) {
  const { account, endpoint } = requireEnrolled(c.principal);
  return { account, by: { accountId: account.id, endpointId: endpoint.id } };
}

export const LOCAL_SESSION_HANDLERS = {
  'enroll.claim.local.start': (c: SessionOpContext, i: z.output<typeof EnrollClaimLocalStartInput>) =>
    c.trust.localClaimStart(identityOf(c), c.session, i ?? {}, c.principal.protocolMinor),
  'enroll.claim.local.begin': (c: SessionOpContext, i: z.output<typeof EnrollClaimLocalBeginInput>) =>
    c.trust.localClaimBegin(identityOf(c), c.session, i),
  'enroll.claim.local.prove': (c: SessionOpContext, i: z.output<typeof EnrollClaimLocalProveInput>) =>
    c.trust.localClaimProve(identityOf(c), c.session, i),
  'enroll.claim.local': (c: SessionOpContext, i: z.output<typeof EnrollClaimLocalInput>) =>
    c.trust.localClaim(identityOf(c), c.session, i),
  'enroll.link.create': (c: SessionOpContext) => c.trust.linkCreate(c.principal),
  'enroll.link.accept': (c: SessionOpContext, i: z.output<typeof EnrollLinkAcceptInput>) =>
    c.trust.linkAccept(identityOf(c), i),
  'host.mail': async (c: SessionOpContext): Promise<HostMailOutput> => {
    requirePerson(c.principal);
    return { mail: await c.services.boxMail.view() };
  },
  'host.mail.set': async (c: SessionOpContext, i: MailSettingsInput): Promise<HostMailOutput> => {
    const { by } = actor(c);
    return { mail: await c.services.boxMail.set(by, i) };
  },
  'host.mail.test': async (
    c: SessionOpContext,
    i: { draft?: MailSettingsInput },
  ): Promise<HostMailTestOutput> => {
    const { account } = actor(c);
    return { test: await c.services.boxMail.test(account.email, i.draft) };
  },
  'host.mail.remove': async (c: SessionOpContext): Promise<HostMailOutput> => {
    const { by } = actor(c);
    return { mail: await c.services.boxMail.remove(by) };
  },
} as const;
