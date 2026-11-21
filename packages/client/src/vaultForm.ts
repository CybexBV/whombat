/**
 * Add to Vault's rules that the web and the phone share: how an entry signs in, in the form's words and as the body
 * says it, the contract's field problems in plain words, and a refusal in words. Each app keeps its own form, templates
 * and body (the phone adds no SSH key). Pure.
 */
import { VAULT_ERROR_MESSAGES, type VaultErrorCode } from '@whombat/core/contracts';
import {
  VAULT_SSH_FIELD_TEXT,
  VAULT_SSH_KEY_PROBLEM_TEXT,
  type VaultAuth,
  type VaultAuthType,
} from '@whombat/core/vault';
import { ApiError, InvalidRequestError } from './http/errors';

/** How an entry signs in, as the form offers it. */
export const VAULT_AUTH_LABELS: Record<VaultAuthType, string> = {
  bearer: 'A bearer token',
  header: 'A header',
  query: 'A query parameter',
  basic: 'Username and password',
  form: 'A sign-in page in the browser',
  none: 'Nothing, it’s on my network',
  ssh_key: 'An SSH key',
};

/** The form's sign-in fields, as typed. */
export interface VaultAuthFields {
  auth: VaultAuthType;
  headerName: string;
  queryName: string;
  username: string;
}

/** The sign-in a form's choice saves. */
export function vaultAuthOf(form: VaultAuthFields): VaultAuth {
  switch (form.auth) {
    case 'header':
      return { type: 'header', name: form.headerName.trim() };
    case 'query':
      return { type: 'query', name: form.queryName.trim() };
    case 'basic':
      return { type: 'basic', username: form.username.trim() };
    case 'form':
      return { type: 'form', username: form.username.trim() };
    case 'none':
      return { type: 'none' };
    default:
      return { type: 'bearer' };
  }
}

/** Field problems keyed like the form's fields (`name`, `url`, `auth.name`, `auth.username`, `secret`). */
export type VaultFieldProblems = Record<string, string>;

/** Zod's own words for an empty or too long field, in ours. */
const PLAIN: Record<string, { empty: string; long: string }> = {
  name: { empty: 'Give it a name.', long: 'Keep the name to 60 characters.' },
  description: { empty: '', long: 'Keep it to 500 characters.' },
  url: { empty: 'Add the address.', long: 'That address is too long.' },
  secret: { empty: 'Paste the secret.', long: 'That secret is too long.' },
  'auth.username': { empty: 'Add the username.', long: 'That username is too long.' },
  'sshKey.privateKey': { empty: VAULT_SSH_KEY_PROBLEM_TEXT.empty, long: VAULT_SSH_KEY_PROBLEM_TEXT.too_long },
  'sshKey.passphrase': { empty: '', long: 'That passphrase is too long.' },
  privateKey: { empty: VAULT_SSH_KEY_PROBLEM_TEXT.empty, long: VAULT_SSH_KEY_PROBLEM_TEXT.too_long },
  passphrase: { empty: '', long: 'That passphrase is too long.' },
  port: { empty: VAULT_SSH_FIELD_TEXT.port, long: VAULT_SSH_FIELD_TEXT.port },
};

/** A schema's issues as field problems, the first per field, an empty or too long field in plain words. */
export function vaultFieldProblems(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): VaultFieldProblems {
  const out: VaultFieldProblems = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || 'form';
    const plain = PLAIN[key];
    const message =
      plain && /^Too small/.test(issue.message)
        ? plain.empty
        : plain && /^Too big/.test(issue.message)
          ? plain.long
          : issue.message;
    out[key] ??= message;
  }
  return out;
}

/** A refusal in words: the server's message for a typed refusal, field problems for a validation failure. */
export function vaultProblemOf(error: unknown): { message: string | null; fields: VaultFieldProblems } {
  if (error instanceof InvalidRequestError)
    return {
      message: null,
      fields: vaultFieldProblems(
        Object.entries(error.fields).map(([path, messages]) => ({
          path: path ? path.split('.') : [],
          message: messages[0] ?? '',
        })),
      ),
    };
  if (error instanceof ApiError) {
    const code = (error.details as { code?: VaultErrorCode } | undefined)?.code;
    // An address the destination rules refuse belongs under Address.
    if (code === 'address_not_allowed') return { message: null, fields: { url: error.message } };
    if (error.code === 'validation_failed' && Object.keys(error.fields).length)
      return {
        message: null,
        fields: vaultFieldProblems(
          Object.entries(error.fields).map(([path, messages]) => ({
            path: path === 'value' ? ['secret'] : path.split('.'),
            message: messages[0] ?? '',
          })),
        ),
      };
    return { message: error.message || (code ? VAULT_ERROR_MESSAGES[code] : null), fields: {} };
  }
  return { message: null, fields: {} };
}
