/**
 * Add to Vault's rules that the web and the phone share: how an entry signs in, in the form's words and as the body
 * says it, the contract's field problems in plain words, and a refusal in words. Each app keeps its own form, templates
 * and body (the phone adds no SSH key). Pure.
 */
import { VAULT_ERROR_MESSAGES, type VaultErrorCode } from '@whombat/core/contracts';
import {
  type VaultAuth,
  type VaultAuthType,
  vaultSshFieldText,
  vaultSshKeyProblemText,
} from '@whombat/core/vault';
import { ApiError, InvalidRequestError } from './http/errors';
import { clientTree } from './i18n/catalog';
import { SETTINGS_AREA_WORDS } from './i18n/messages/chatWork/settings';

const words = (locale?: string | null) => clientTree(locale, SETTINGS_AREA_WORDS).vault;

/** How an entry signs in, as the form offers it, in a locale (English when none). */
export function vaultAuthLabels(locale?: string | null): Record<VaultAuthType, string> {
  return { ...words(locale).auth };
}

export const VAULT_AUTH_LABELS: Record<VaultAuthType, string> = vaultAuthLabels();

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
function plainWords(locale?: string | null): Record<string, { empty: string; long: string }> {
  const w = words(locale).plain;
  const ssh = vaultSshKeyProblemText(locale);
  const port = vaultSshFieldText(locale).port;
  return {
    name: { empty: w.nameEmpty, long: w.nameLong },
    description: { empty: '', long: w.descriptionLong },
    url: { empty: w.urlEmpty, long: w.urlLong },
    secret: { empty: w.secretEmpty, long: w.secretLong },
    'auth.username': { empty: w.usernameEmpty, long: w.usernameLong },
    'sshKey.privateKey': { empty: ssh.empty, long: ssh.too_long },
    'sshKey.passphrase': { empty: '', long: w.passphraseLong },
    privateKey: { empty: ssh.empty, long: ssh.too_long },
    passphrase: { empty: '', long: w.passphraseLong },
    port: { empty: port, long: port },
  };
}

/** A schema's issues as field problems, the first per field, an empty or too long field in plain words. */
export function vaultFieldProblems(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  locale?: string | null,
): VaultFieldProblems {
  const out: VaultFieldProblems = {};
  const plainOf = plainWords(locale);
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || 'form';
    const plain = plainOf[key];
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
export function vaultProblemOf(
  error: unknown,
  locale?: string | null,
): { message: string | null; fields: VaultFieldProblems } {
  if (error instanceof InvalidRequestError)
    return {
      message: null,
      fields: vaultFieldProblems(
        Object.entries(error.fields).map(([path, messages]) => ({
          path: path ? path.split('.') : [],
          message: messages[0] ?? '',
        })),
        locale,
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
          locale,
        ),
      };
    return { message: error.message || (code ? VAULT_ERROR_MESSAGES[code] : null), fields: {} };
  }
  return { message: null, fields: {} };
}
