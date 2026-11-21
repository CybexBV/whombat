/**
 * What the home services' provisioners share (docs/decisions/connections-setup.md CS-20…CS-25): request bodies, reading
 * an answer defensively, and the sentences the person reads. Nothing here sees the password except the request bodies
 * the callers build.
 */
import { type ProvisionError, type ProvisionRequest, type ProvisionResponse, refuseSignIn } from './types';

/** The second factor most services ask for (CS-03). */
export const AUTHENTICATOR_CODE = 'Enter the code from your authenticator app.';

/** A code the service refused (`code`). */
export const WRONG_CODE = 'That code didn’t work. Enter the current code from your authenticator app.';

/**
 * A refused password at a service that can't tell a wrong password from an account without one (single sign-on,
 * docs/decisions/connection-signin.md SG-13): the wrong-password words, one sentence more, and the sign-in to switch to
 * (`method`), so the form offers the switch. `instead` is what the sentence ends with (“make a token instead”).
 */
export function wrongPasswordOrSingleSignOn(
  wrong: string,
  service: string,
  method = 'token',
  instead = 'make a token instead',
): ProvisionError {
  return refuseSignIn(
    'password',
    `${wrong} If you sign in to ${service} through another service, ${instead}.`,
    method,
  );
}

/** A form-encoded request (`application/x-www-form-urlencoded`). */
export function formRequest(
  method: string,
  values: Record<string, string>,
  headers: Record<string, string> = {},
): ProvisionRequest {
  return {
    method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(values).toString(),
  };
}

/** A JSON request. */
export function jsonRequest(
  method: string,
  value: unknown,
  headers: Record<string, string> = {},
): ProvisionRequest {
  return {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(value),
  };
}

export const ok = (res: ProvisionResponse) => res.status >= 200 && res.status < 300;

/** An object, or null. */
export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-empty string, or null. */
export function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The service answered something none of its steps expect (a 5xx, a body without the field): Whombat stops, and the
 * person can try again or take the entry's other sign-in (CS-D30). Never the service's own text.
 */
export function unexpected(
  service: string,
  status?: number,
  instead = 'make a token by hand',
): ProvisionError {
  const code = status ? ` (${status})` : '';
  return refuseSignIn(
    'unsupported',
    `${service} gave an answer Whombat didn’t expect${code}, so Whombat stopped. Try again, or ${instead}.`,
  );
}

/** Names to try in turn (CS-06): `whombat`, `whombat-2`, … `whombat-<max>`. */
export function* candidateNames(first: string, separator: string, max = 20): Generator<string> {
  yield first;
  for (let n = 2; n <= max; n++) yield `${first}${separator}${n}`;
}

/** Runs a clean-up step that must not hide the outcome (logout, revoke, deleting a half-made key). */
export async function quietly(step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch {
    // The outcome (a key, or the refusal) matters more than a failed clean-up.
  }
}
