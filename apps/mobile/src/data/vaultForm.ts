/**
 * Adding to the Vault and replacing a secret on Android (AP-718; the web's Add to Vault and Replace, docs/decisions/
 * vault.md VT-70, VT-71, VT-04). The web's rules, ported: the templates as choices, the form's body for `vault.create`
 * and its field problems from the contract's own schema (the form refuses what the server would), a refusal in words,
 * and `vault.setSecret`'s body. An SSH key stays on the web (its servers and public key are set up there). Nothing makes a
 * `secret` entry any more (contracts CT-823; skill-store.md AP-4156). Pure: no secret is kept here, the sheets hold it
 * only while open.
 */

import { type VaultFieldProblems, vaultAuthOf, vaultFieldProblems, vaultProblemOf } from '@whombat/client';
import { CreateVaultEntryBody } from '@whombat/core/contracts';
import {
  VAULT_COPY,
  VAULT_NEW_TEMPLATES,
  VAULT_TEMPLATE_DEFS,
  type VaultAuth,
  type VaultAuthType,
} from '@whombat/core/vault';
import type { z } from 'zod';
import { mobileTranslator } from '../i18n/translate';

/** The web's form words that core doesn't hold, verbatim. */
export function vaultFormText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    kicker: t('vaultForm.vaultFormText.kicker'),
    chooseTemplate: t('vaultForm.vaultFormText.chooseTemplate'),
    change: t('vaultForm.vaultFormText.change'),
    save: t('vaultForm.vaultFormText.save'),
    cancel: t('vaultForm.vaultFormText.cancel'),
    name: t('vaultForm.vaultFormText.name'),
    address: t('vaultForm.vaultFormText.address'),
    signInPage: t('vaultForm.vaultFormText.signInPage'),
    signsIn: t('vaultForm.vaultFormText.signsIn'),
    headerName: t('vaultForm.vaultFormText.headerName'),
    queryName: t('vaultForm.vaultFormText.queryName'),
    username: t('vaultForm.vaultFormText.username'),
    namePlaceholder: {
      token: 'Grafana',
      basic: 'Printer admin',
      login: 'Supplier portal',
    } satisfies Record<PhoneVaultTemplate, string>,
    addressPlaceholder: {
      token: 'https://api.example.com/v1',
      basic: 'http://192.168.1.20',
      login: 'https://portal.example.com/sign-in',
    } satisfies Record<PhoneVaultTemplate, string>,
    descriptionPlaceholder: t('vaultForm.vaultFormText.descriptionPlaceholder'),
    secretLabel: {
      token: t('vaultForm.vaultFormText.secretLabel.token'),
      password: t('vaultForm.vaultFormText.secretLabel.password'),
      secret: t('vaultForm.vaultFormText.secretLabel.secret'),
    },
    secretPlaceholder: t('vaultForm.vaultFormText.secretPlaceholder'),
    secretHint: t('vaultForm.vaultFormText.secretHint'),
    added: (name: string) => t('vaultForm.vaultFormText.added', { name }),
    addedChecked: (name: string, summary: string) =>
      t('vaultForm.vaultFormText.addedChecked', { name, summary }),
    failed: t('vaultForm.vaultFormText.failed'),
    secretReplaced: t('vaultForm.vaultFormText.secretReplaced'),
    replaceHint: t('vaultForm.vaultFormText.replaceHint'),
    signsInWithNothing: t('vaultForm.vaultFormText.signsInWithNothing'),
    /** What the phone leaves to the web (AP-718). */
    sshOnWeb: t('vaultForm.vaultFormText.sshOnWeb'),
  } as const;
}
export const VAULT_FORM_TEXT = vaultFormText();

/** The sign-in choices of each template: an API never signs in with nothing (VT-03). */
export const TEMPLATE_AUTHS: Record<PhoneVaultTemplate, VaultAuthType[]> = {
  token: ['bearer', 'header', 'query'],
  basic: ['basic'],
  login: ['form'],
};

/**
 * What Add to Vault offers on the phone: core's `VAULT_NEW_TEMPLATES` (no `secret`, CT-823; AP-4156; no Connection: an
 * MCP server is a Custom MCP server in Connections, Whombat vault-simplify.md VLT-30) but an SSH key, which is set up on
 * the web.
 */
export type PhoneVaultTemplate = Exclude<(typeof VAULT_NEW_TEMPLATES)[number], 'ssh'>;

/** The template a new form starts with before one is chosen: core's first. */
export const FIRST_PHONE_TEMPLATE: PhoneVaultTemplate = phoneVaultTemplates()[0] ?? 'token';

/** The templates the phone offers, in core's order: every new one but an SSH key (set up on the web). */
export function phoneVaultTemplates(): PhoneVaultTemplate[] {
  return VAULT_NEW_TEMPLATES.flatMap((t) => (t === 'ssh' ? [] : [t]));
}

/** The template choice's row: “MCP server” and what it is. */
export function vaultTemplateChoice(template: PhoneVaultTemplate): { title: string; body: string } {
  const def = VAULT_TEMPLATE_DEFS[template];
  return { title: def.label, body: def.description };
}

/** The Add to Vault form, as typed. */
export interface VaultForm {
  name: string;
  description: string;
  url: string;
  auth: VaultAuthType;
  headerName: string;
  queryName: string;
  username: string;
  secret: string;
}

export function emptyVaultForm(template: PhoneVaultTemplate): VaultForm {
  return {
    name: '',
    description: '',
    url: '',
    auth: TEMPLATE_AUTHS[template][0] ?? 'bearer',
    headerName: '',
    queryName: '',
    username: '',
    secret: '',
  };
}

/** Which fields the form shows for a template and its sign-in choice. */
export interface VaultFormFields {
  /** “Sign-in page” for a website login, “Address” otherwise: every template the phone offers has one. */
  addressLabel: string;
  /** The sign-in choices, when there is more than one. */
  auths: VaultAuthType[];
  headerName: boolean;
  queryName: boolean;
  username: boolean;
  /** Whether it takes a secret (every template the phone offers does). */
  secret: boolean;
  secretLabel: string;
  /** An http address: the secret crosses the network unencrypted (core's warning). */
  httpWarning: string | null;
  /** A query parameter ends up in server logs (core's warning). */
  queryWarning: string | null;
}

export function vaultFormFields(template: PhoneVaultTemplate, form: VaultForm): VaultFormFields {
  const login = template === 'login';
  const withUsername = template === 'basic' || login;
  const auths = TEMPLATE_AUTHS[template];
  return {
    addressLabel: login ? VAULT_FORM_TEXT.signInPage : VAULT_FORM_TEXT.address,
    auths: auths.length > 1 ? auths : [],
    headerName: form.auth === 'header',
    queryName: form.auth === 'query',
    username: withUsername,
    secret: form.auth !== 'none',
    secretLabel: withUsername ? VAULT_FORM_TEXT.secretLabel.password : VAULT_FORM_TEXT.secretLabel.token,
    httpWarning: /^\s*http:\/\//i.test(form.url) ? VAULT_COPY.httpWarning : null,
    queryWarning: form.auth === 'query' ? VAULT_COPY.queryWarning : null,
  };
}

/** A public address needs https; addresses on your network need the home network list (VT-11, VT-12). */
export function vaultAddressHint(networks: readonly { cidr: string; ports: readonly number[] }[]): string {
  return networks.length
    ? `Public addresses need https. On your network: ${networks
        .map((n) => `${n.cidr} · ${n.ports.length === 1 ? 'port' : 'ports'} ${n.ports.join(', ')}`)
        .join('; ')}.`
    : 'Public addresses need https. Nothing on your network is on the home network list yet.';
}

export type CreateVaultBody = z.input<typeof CreateVaultEntryBody>;

/** `vault.create`'s body: kind and sign-in from the template, the secret unless it signs in with nothing. */
export function vaultCreateBody(template: PhoneVaultTemplate, form: VaultForm): CreateVaultBody {
  const def = VAULT_TEMPLATE_DEFS[template];
  const secret = form.secret.length > 0 ? form.secret : undefined;
  const auth = vaultAuthOf(form);
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    kind: def.kind,
    url: form.url.trim(),
    auth,
    ...(auth.type === 'none' ? {} : { secret }),
  };
}

/** Field problems keyed like the form's fields (`name`, `url`, `auth.name`, `auth.username`, `secret`). */
export type FieldProblems = VaultFieldProblems;

/** The contract's own refusals of the body (`CreateVaultEntryBody`): what the server would say, before sending. */
export function vaultFormProblems(template: PhoneVaultTemplate, form: VaultForm): FieldProblems {
  const parsed = CreateVaultEntryBody.safeParse(vaultCreateBody(template, form));
  return parsed.success ? {} : vaultFieldProblems(parsed.error.issues);
}

/** Whether Save runs “Check connection” after creating (nothing checks a login or an SSH key from here). */
export function checksAfterAdd(kind: string): boolean {
  return kind !== 'login' && kind !== 'ssh' && kind !== 'secret';
}

/* Replace (VT-04, VT-71) ---------------------------------------------------------------------------------------- */

export interface ReplaceSecretModel {
  /** Signs in with nothing: no secret to replace. */
  none: boolean;
  /** Basic auth or a website login: the username can change with the password. */
  withUsername: boolean;
  /** The username as it is, to start the field with. */
  username: string;
  label: string;
}

export function replaceSecretModel(auth: VaultAuth | null): ReplaceSecretModel {
  const withUsername = auth?.type === 'basic' || auth?.type === 'form';
  return {
    none: auth?.type === 'none',
    withUsername,
    username: withUsername ? auth.username : '',
    label: withUsername ? VAULT_FORM_TEXT.secretLabel.password : VAULT_FORM_TEXT.secretLabel.secret,
  };
}

/** `vault.setSecret`'s body: the value, and the username only when it changed. */
export function setSecretBody(
  auth: VaultAuth | null,
  value: string,
  username: string,
): { value: string; username?: string } {
  const next = username.trim();
  return {
    value,
    ...((auth?.type === 'basic' || auth?.type === 'form') && next && next !== auth.username
      ? { username: next }
      : {}),
  };
}

/** A Replace refusal where it shows: the value's problem under the secret field. */
export function replaceProblemOf(error: unknown): { message: string | null; fields: FieldProblems } {
  const p = vaultProblemOf(error);
  const fields = p.fields.value ? { secret: p.fields.value } : p.fields;
  return {
    message: p.message ?? (Object.keys(fields).length ? null : VAULT_FORM_TEXT.failed),
    fields,
  };
}
