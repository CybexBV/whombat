/**
 * Signups (BL-21…BL-25): the public signup info, the waitlist and signup codes. The gate is org creation
 * (`orgs.create`), never sign-in.
 */
import { z } from 'zod';
import { SignupInfo } from './billing.js';
import { Email } from './common.js';
import { controlEndpoint } from './endpoint.js';

/** Crockford base32 (no I, L, O, U). */
export const SIGNUP_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A normalised code: 8 Crockford characters (40 bits), with an optional dash in the middle as displayed. */
export const SIGNUP_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/;

/**
 * Normalise what a person typed or pasted (BL-22): upper case, spaces and dashes removed, O→0, I and L→1. Answers the
 * 8 canonical characters (no dash), or null when the result isn't a code. Pure and idempotent; control hashes the
 * canonical form.
 */
export function normaliseSignupCode(input: string): string | null {
  if (input.length > 64) return null;
  const canonical = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(canonical) ? canonical : null;
}

/** `XXXX-XXXX`, as shown and linked (`${UI_URL}/signup#code=XXXX-XXXX`), for a code `normaliseSignupCode` accepts. */
export function formatSignupCode(input: string): string | null {
  const canonical = normaliseSignupCode(input);
  return canonical ? `${canonical.slice(0, 4)}-${canonical.slice(4)}` : null;
}

/** A code in a request (`orgs.create`): already normalised by the client, with or without the dash. */
export const SignupCodeInput = z.string().regex(SIGNUP_CODE_PATTERN);

/** A code as shown once on creation: `XXXX-XXXX`. */
export const SignupCodeDisplay = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

/** The last 4 characters of a code, what the panel shows afterwards. */
export const SignupCodeHint = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}$/);

/** `POST /v1/waitlist` (BL-23). */
export const WaitlistBody = z.strictObject({
  email: Email,
  company: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().min(1).max(500).optional(),
});
export type WaitlistBody = z.infer<typeof WaitlistBody>;

export const signupApi = {
  info: controlEndpoint({
    id: 'signup.info',
    method: 'GET',
    path: '/signup',
    auth: 'none',
    summary:
      'The signup mode, billing provider, trial length, current terms version and public plans (BL-25).',
    response: SignupInfo,
  }),
  waitlist: controlEndpoint({
    id: 'signup.waitlist',
    method: 'POST',
    path: '/waitlist',
    auth: 'none',
    summary:
      'Join the waitlist (BL-23). Always `{ok: true}` for a valid body, a repeat included (no enumeration). Refuses `waitlist_closed` (409) outside `waitlist` mode; rate-limited per network and globally (`rate_limited`, 429).',
    body: WaitlistBody,
    response: z.object({ ok: z.literal(true) }),
  }),
};
