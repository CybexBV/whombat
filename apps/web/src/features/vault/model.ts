/**
 * The Vault's display rules on the web (docs/decisions/vault.md VT-70…VT-72; AP-111). Pure: status tones, the Add to
 * Vault form's body and its field problems (the contract's own schema, so the form refuses what the server would),
 * the words of a refusal, the agents a key may go to, and the ports field.
 */
import {
  ApiError,
  type VaultFieldProblems,
  vaultAuthOf,
  vaultFieldProblems,
  vaultProblemOf,
} from '@whombat/client';
import {
  AddVaultSshServerBody,
  CreateVaultEntryBody,
  ReplaceVaultSshKeyBody,
  type UpdateVaultSshServerBody,
} from '@whombat/core/contracts';
import {
  defaultVaultEnvName,
  VAULT_COPY,
  VAULT_NETWORK_PORTS_MAX,
  VAULT_SSH_DEFAULT_PORT,
  VAULT_SSH_FIELD_TEXT,
  VAULT_TEMPLATE_DEFS,
  type VaultAuthType,
  type VaultCheckStatus,
  type VaultEntryDetail,
  type VaultKeyView,
  type VaultSshServer,
  type VaultTemplate,
  type VaultUseOutcome,
  vaultEnvNameProblem,
  vaultKeyDeliverable,
} from '@whombat/core/vault';
import type { z } from 'zod';
import type { DotTone } from '../../components/StatusDot';
import type { TagTone } from '../../components/Tag';
import { TEMPLATE_AUTHS } from './copy';

/** The status dot of an entry: reached, failing, or not checked yet (VT-70). */
export const CHECK_TONES: Record<VaultCheckStatus, DotTone> = {
  reached: 'ok',
  failing: 'bad',
  unchecked: 'mut',
};

/** What the dot says to a screen reader. */
export const CHECK_LABELS: Record<VaultCheckStatus, string> = {
  reached: 'Reached',
  failing: 'Failing',
  unchecked: VAULT_COPY.notChecked,
};

/** A RECENT USE row's outcome color. */
export const OUTCOME_TONES: Record<VaultUseOutcome, TagTone> = {
  done: 'ok',
  failed: 'bad',
  refused: 'bad',
  timed_out: 'warn',
};

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
  /** An SSH key (VT-S03): Whombat generates it, or you paste your own with its passphrase. */
  sshMode: SshKeyMode;
  privateKey: string;
  passphrase: string;
}

/** “Generate a new key” / “Use my own key”. */
export type SshKeyMode = 'generate' | 'import';

export function emptyForm(template: VaultTemplate): VaultForm {
  return {
    name: '',
    description: '',
    url: '',
    auth: TEMPLATE_AUTHS[template][0] ?? 'bearer',
    headerName: '',
    queryName: '',
    username: '',
    secret: '',
    sshMode: 'generate',
    privateKey: '',
    passphrase: '',
  };
}

/**
 * The kind the add form saves when nobody chose one under Advanced: a username means a website login (it signs in in
 * its browser), none a sign-in key. A server key and an MCP connection are chosen, never guessed.
 */
export function guessTemplate(form: Pick<VaultForm, 'username'>): VaultTemplate {
  return form.username.trim() ? 'login' : 'token';
}

/**
 * An address typed without its scheme (“portal.example.com”, “192.168.1.20:8080”): https, or http for a device on
 * your own network (a private IPv4 address, a `.local` or `.lan` name, a bare name). An address with a scheme stays.
 */
export function addressUrl(typed: string): string {
  const text = typed.trim();
  if (text === '' || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  const host = (text.split(/[/:?#]/)[0] ?? '').toLowerCase();
  const local =
    /^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /\.(local|lan|home|internal)$/.test(host) ||
    (host !== '' && !host.includes('.'));
  return `${local ? 'http' : 'https'}://${text}`;
}

/**
 * The form as a kind saves it: a sign-in the kind offers (the one chosen under Advanced, else the kind's first) and the
 * address with its scheme.
 */
export function formFor(template: VaultTemplate, form: VaultForm): VaultForm {
  const auths = TEMPLATE_AUTHS[template];
  return {
    ...form,
    auth: auths.includes(form.auth) ? form.auth : (auths[0] ?? form.auth),
    url: addressUrl(form.url),
  };
}

/** A private key pasted where a password goes (a password field drops its line breaks, so it can't be used). */
export const looksLikePrivateKey = (text: string): boolean =>
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text);

export type CreateVaultBody = z.input<typeof CreateVaultEntryBody>;

/** `vault.create`'s body for a template: kind and sign-in from the template, the secret unless it signs in with nothing. */
export function createBody(template: VaultTemplate, form: VaultForm): CreateVaultBody {
  const def = VAULT_TEMPLATE_DEFS[template];
  const secret = form.secret.length > 0 ? form.secret : undefined;
  // An SSH key has no address, sign-in or secret of its own: the server makes or reads the key (VT-S02, VT-S03).
  if (def.kind === 'ssh')
    return {
      name: form.name.trim(),
      description: form.description.trim(),
      kind: 'ssh',
      sshKey:
        form.sshMode === 'generate'
          ? { mode: 'generate' }
          : {
              mode: 'import',
              privateKey: form.privateKey,
              ...(form.passphrase ? { passphrase: form.passphrase } : {}),
            },
    };
  if (def.kind === 'secret')
    return { name: form.name.trim(), description: form.description.trim(), kind: 'secret', secret };
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
export function formProblems(template: VaultTemplate, form: VaultForm): FieldProblems {
  const parsed = CreateVaultEntryBody.safeParse(createBody(template, form));
  return parsed.success ? {} : vaultFieldProblems(parsed.error.issues);
}

/** The ports field (“80, 8123”): 1–16 numbers 1–65535, or null. */
export function parsePorts(text: string): number[] | null {
  const parts = text
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > VAULT_NETWORK_PORTS_MAX) return null;
  const ports = parts.map(Number);
  return ports.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535) ? ports : null;
}

/* SSH keys (VT-S03…VT-S07; AP-598…AP-602) -------------------------------------------------------- */

/**
 * The import fields where the form shows them: create puts the key under `sshKey`, Replace at the top. The private key
 * and passphrase problems read as the form's own fields, `privateKey` and `passphrase`.
 */
export function sshKeyFields(fields: FieldProblems): FieldProblems {
  const out: FieldProblems = {};
  for (const [key, message] of Object.entries(fields)) out[key.replace(/^sshKey\./, '')] ??= message;
  return out;
}

/** “Replace with my own key”'s body and its problems before sending (the contract's own schema). */
export function replaceKeyBody(privateKey: string, passphrase: string) {
  return { privateKey, ...(passphrase ? { passphrase } : {}) };
}

export function replaceKeyProblems(privateKey: string, passphrase: string): FieldProblems {
  const parsed = ReplaceVaultSshKeyBody.safeParse(replaceKeyBody(privateKey, passphrase));
  return parsed.success ? {} : vaultFieldProblems(parsed.error.issues);
}

/** “Add server” / “Edit server”, as typed. */
export interface ServerForm {
  name: string;
  host: string;
  port: string;
  username: string;
  /** The Production switch (AC-11, AP-618): the agent's commands reach it only after your yes. */
  production: boolean;
}

export function serverFormOf(server?: VaultSshServer): ServerForm {
  return server
    ? {
        name: server.name,
        host: server.host,
        port: String(server.port),
        username: server.username,
        production: server.production ?? false,
      }
    : { name: '', host: '', port: String(VAULT_SSH_DEFAULT_PORT), username: '', production: false };
}

function portOf(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? VAULT_SSH_DEFAULT_PORT : /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** `vault.addSshServer`'s body (an empty port is 22, as the contract's default). */
export function serverBody(form: ServerForm) {
  return {
    name: form.name.trim(),
    host: form.host.trim(),
    port: portOf(form.port),
    username: form.username.trim(),
    production: form.production,
  };
}

/** The contract's refusals of a server before sending: core's sentences for name, host and username. */
export function serverProblems(form: ServerForm): FieldProblems {
  const parsed = AddVaultSshServerBody.safeParse(serverBody(form));
  if (parsed.success) return {};
  const out = vaultFieldProblems(parsed.error.issues);
  if (out.port) out.port = VAULT_SSH_FIELD_TEXT.port;
  return out;
}

/** Edit's body: only what changed, or null when nothing did. */
export function serverChanges(server: VaultSshServer, form: ServerForm): UpdateVaultSshServerBody | null {
  const next = serverBody(form);
  const body: UpdateVaultSshServerBody = {
    ...(next.name !== server.name ? { name: next.name } : {}),
    ...(next.host !== server.host ? { host: next.host } : {}),
    ...(next.port !== server.port ? { port: next.port } : {}),
    ...(next.username !== server.username ? { username: next.username } : {}),
    ...(next.production !== (server.production ?? false) ? { production: next.production } : {}),
  };
  return Object.keys(body).length ? body : null;
}

/** Whether Edit moves the server (a new host or port forgets its trusted host key, VT-S04). */
export function serverMoves(server: VaultSshServer, form: ServerForm): boolean {
  const next = serverBody(form);
  return next.host !== server.host || next.port !== server.port;
}

/**
 * A server refusal where it belongs: the destination rules' sentence under Host (VT-S06), a taken name under Name, the
 * rest as the message.
 */
export function serverProblemOf(error: unknown): { message: string | null; fields: FieldProblems } {
  const p = vaultProblemOf(error);
  const fields: FieldProblems = {};
  for (const [key, message] of Object.entries(p.fields)) fields[key === 'url' ? 'host' : key] ??= message;
  if (
    error instanceof ApiError &&
    (error.details as { code?: string } | undefined)?.code === 'server_name_taken'
  )
    return { message: null, fields: { ...fields, name: error.message || VAULT_SSH_FIELD_TEXT.nameTaken } };
  return { message: p.message, fields };
}

/* An entry in the agent's commands (AC-30, AC-31; since contracts 0.125 CT-1240, AP-5241; 3.0 CT-1532) ----------- */

/** Whether an entry switched on for the agent names an environment variable in its commands (an API's value). */
export const hasEnvName = (entry: Pick<VaultEntryDetail, 'kind'>): boolean => entry.kind === 'http';

/** The variable a key's value is in: its own, or the entry's default. */
export function envNameOf(
  entry: Pick<VaultEntryDetail, 'name'>,
  key?: Pick<VaultKeyView, 'envName'> | null,
): string {
  return key?.envName ?? defaultVaultEnvName(entry.name);
}

/** `vault.setKeyEnvName`'s body, or the field's problem (core's `vaultEnvNameProblem`, checked before it is sent). */
export function envNameBody(typed: string): { body: { envName: string } } | { problem: string } {
  const envName = typed.trim();
  const problem = vaultEnvNameProblem(envName);
  return problem ? { problem } : { body: { envName } };
}

/** Whether switching the entry off for the agent asks to change the secret: it was in its commands (AC-34). */
export const inCommands = (entry: Pick<VaultEntryDetail, 'kind'>): boolean => vaultKeyDeliverable(entry);
