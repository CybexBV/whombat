/**
 * Organizations (MA-03): since 3.0 (CT-1560; Whombat one-person.md OP-12) an org has one account, which does everything
 * control offers for it (billing, the device directory, cohort consent, tickets) — never content. There are no roles,
 * members or invitations; one account may own several orgs and Whombats.
 */
import { AccountLinkCode } from '@whombat/protocol/session';
import { z } from 'zod';
import { SubscriptionTerms } from './billing.js';
import { DisplayName, OrgId } from './common.js';
import { ClaimTerms } from './directory.js';
import { controlEndpoint } from './endpoint.js';
import { SignupCodeInput } from './signup.js';

export const Org = z.object({
  orgId: OrgId,
  name: DisplayName,
  createdAt: z.iso.datetime({ offset: true }),
});
export type Org = z.infer<typeof Org>;

const P = z.strictObject({ org: OrgId });

/**
 * `orgs.create` (BL-21): the company name, the accepted Subscription Terms, and a signup code (normalised with
 * `normaliseSignupCode`) when the signup mode needs one or it carries a plan.
 */
export const CreateOrgBody = z.strictObject({
  name: DisplayName,
  terms: SubscriptionTerms,
  code: SignupCodeInput.optional(),
});
export type CreateOrgBody = z.infer<typeof CreateOrgBody>;

/** One entry of the org's audit log (metadata only; `detail` values are scalars). */
export const OrgAuditEvent = z.object({
  /** Epoch seconds. */
  at: z.number().int().min(0),
  actorKind: z.enum(['account', 'device', 'provisioning', 'system', 'operator']),
  actorId: z.string().max(64),
  /** `claim.created`, `device.retired`, … */
  action: z.string().min(1).max(64),
  target: z.string().max(128).nullable(),
  detail: z.record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])),
});
export type OrgAuditEvent = z.infer<typeof OrgAuditEvent>;

/** `orgs.createWhombatLink` (4.3): the accepted appliance terms, as `claims.start` carries them. */
export const CreateWhombatLinkBody = z.strictObject({ terms: ClaimTerms });
/** A one-time code the person types at their Whombat to link it to this account (lives 10 minutes, links one box). */
export const WhombatLink = z.object({
  code: AccountLinkCode,
  expiresAt: z.iso.datetime({ offset: true }),
});
export type WhombatLink = z.infer<typeof WhombatLink>;

export const orgApi = {
  create: controlEndpoint({
    id: 'orgs.create',
    method: 'POST',
    path: '/orgs',
    auth: 'session',
    summary:
      'Create an org; it is the caller’s (BL-13, BL-21). Refuses `signup_code_required` (403: `waitlist` or `invite` mode without a code), `signup_code_invalid` (403: unknown, used, expired or revoked, one answer for all), `signup_code_other_email` (403: an invitation for another address, BL-34), `terms_outdated` (409: not the current `SUBSCRIPTION_TERMS_VERSION`), `rate_limited` (429: code attempts).',
    body: CreateOrgBody,
    response: Org,
  }),
  get: controlEndpoint({
    id: 'orgs.get',
    method: 'GET',
    path: '/orgs/:org',
    auth: 'session',
    summary: 'One of the caller’s orgs.',
    response: Org,
  }),
  list: controlEndpoint({
    id: 'orgs.list',
    method: 'GET',
    path: '/orgs',
    auth: 'session',
    summary: 'The caller’s orgs.',
    response: z.object({ orgs: z.array(Org).max(100) }),
  }),
  audit: controlEndpoint({
    id: 'orgs.audit',
    method: 'GET',
    path: '/orgs/:org/audit',
    auth: 'session',
    summary: 'The org’s audit log, newest first.',
    query: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }),
    response: z.object({ events: z.array(OrgAuditEvent).max(500) }),
  }),
  createWhombatLink: controlEndpoint({
    id: 'orgs.createWhombatLink',
    method: 'POST',
    path: '/orgs/:org/whombat-links',
    auth: 'session',
    summary:
      'A one-time code to link a Whombat to this org at the Whombat’s own address (4.3; Whombat own-address.md): the person types it there and the box links itself (`account.link`). The body’s terms must be the current `APPLIANCE_TERMS_VERSION` (`terms_required`). Single use, 10 minutes; at most 3 live codes per account and 20 made an hour (`rate_limited`). Control keeps only the code’s hash.',
    body: CreateWhombatLinkBody,
    response: WhombatLink,
    status: 201,
  }),
};
export const OrgParams = P;
