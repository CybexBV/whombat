/**
 * The Vault's tools (docs/decisions/vault.md; since 0.125 only the two the agent runs a person's Vault with, CT-1242).
 * Spread into `MCP_TOOLS` (`./mcp`).
 *
 * `vault_save` and `vault_add_server` (0.112.0, CT-780, CT-781; Whombat vault-self-serve.md VS-04…VS-12): the agent
 * saves a login, password or API token the person a turn is for sent it into their Vault, and adds a server to one of
 * their SSH keys. `personal: true`, `requiredKey: null`: the server checks that the turn is for that person (and, for a
 * secret, that only they read the room and wrote it). The relayed `vault_request`, `ssh_exec`, `ssh_read_file`,
 * `ssh_write_file`, `ssh_upload`, `request_vault_key` and bridged `vt_*` tools are gone: an entry switched on reaches the
 * agent in the person's turns (`DispatchContext.vault`).
 *
 * Nothing an agent gets back ever holds the secret.
 */
import { z } from 'zod';
import { EventId, VaultEntryId } from '../ids.js';
import { VAULT_FAILURES } from '../vault/request.js';
import {
  VAULT_SSH_SERVER_NAME_MAX,
  VAULT_SSH_SERVER_PASSWORD_MAX,
  VaultEntryDescription,
  VaultEntryName,
  VaultSecretValue,
  VaultUrl,
  VaultUsername,
} from '../vault/schemas.js';
import { VaultSshAddress, VaultSshServerName, VaultSshUsername } from '../vault/ssh.js';
import type { McpTool } from './mcp.js';

export const VaultFailureReason = z.enum(VAULT_FAILURES);

/**
 * Why a Vault tool didn't do it: `blocked` (not the person's own turn, a room others read: a signed `vault.refused`
 * event) or `failed` (`reason`; `message` a summary, never a remote side's words).
 */
export const VaultToolRefusal = z.discriminatedUnion('status', [
  z.object({ status: z.literal('blocked'), eventId: EventId, message: z.string() }),
  z.object({ status: z.literal('failed'), reason: VaultFailureReason, message: z.string() }),
]);
export type VaultToolRefusal = z.infer<typeof VaultToolRefusal>;

/** An entry as the tools take it: its id (`vlt_…`), as the instructions list it. */
export const VaultEntryRef = VaultEntryId.describe(
  'The Vault entry’s id (vlt_…), as your instructions list it',
);

/* The assistant runs its person's Vault (0.112.0, Whombat vault-self-serve.md VS-04…VS-12) ------------------------ */

/**
 * What `vault_save` saves (CT-780): `login` a website signed in to in the browser (a `login` entry, `form` sign-in),
 * `token` an API token sent as Bearer (`http` + `bearer`), `basic` an API with a username and password (`http` + `basic`).
 */
export const VAULT_SAVE_KINDS = ['login', 'token', 'basic'] as const;
export const VaultSaveKind = z.enum(VAULT_SAVE_KINDS);
export type VaultSaveKind = z.infer<typeof VaultSaveKind>;

/**
 * `vault_save`'s input (CT-780; VS-04…VS-06). Without `entry` it makes a new entry: `name` and `address` are required,
 * and `username` for `login` and `basic`. With `entry` it gives one of the person's own entries of the same kind the new
 * secret (and `username`): no `address` (where a saved login points is the person's to change), no `name`, and `made`
 * stays false (a password the assistant made itself only ever makes a new entry, VS-05). The secret is taken as it is,
 * never trimmed: it must match what the person wrote (VS-05).
 */
export const VaultSaveInput = z
  .object({
    kind: VaultSaveKind.describe(
      'login: a website signed in to in the browser; token: an API token sent as Bearer; basic: an API with a username and password',
    ),
    name: VaultEntryName.optional().describe(
      'A short name for a new entry, like Plex or Cloudflare API (leave out with entry)',
    ),
    description: VaultEntryDescription.optional().describe(
      'For a new entry: what you should know about it, in a sentence (optional)',
    ),
    address: VaultUrl.optional().describe(
      'For a new entry: the sign-in page (login) or the API’s base URL (token, basic), like https://plex.example.com (leave out with entry)',
    ),
    username: VaultUsername.optional().describe(
      'The username or email it signs in with (login and basic; a token has none)',
    ),
    secret: VaultSecretValue.describe('The password or token, exactly as the person wrote it'),
    entry: VaultEntryRef.optional().describe(
      'A saved entry of the same kind that gets this new password or token (its vlt_… id); leave out for a new entry',
    ),
    made: z
      .boolean()
      .default(false)
      .describe(
        'true only for a password you made yourself (say, for a new database user); it always makes a new entry',
      ),
  })
  .superRefine((i, ctx) => {
    const problem = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', message, path: [path] });
    if (i.entry === undefined) {
      if (i.name === undefined) problem('name', 'A new entry needs a name.');
      if (i.address === undefined)
        problem(
          'address',
          'A new entry needs its address: the sign-in page for a login, the API’s base URL for a token or basic.',
        );
      if (i.kind !== 'token' && i.username === undefined)
        problem('username', 'A login or basic entry needs the username.');
      return;
    }
    if (i.address !== undefined)
      problem(
        'address',
        'You can’t change where a saved login or token points; the person can, in the Vault.',
      );
    if (i.name !== undefined) problem('name', 'Leave out name when a saved entry gets a new secret.');
    if (i.made) problem('made', 'made is only for a new entry.');
  });
export type VaultSaveInput = z.input<typeof VaultSaveInput>;

/**
 * `vault_save`'s answer (CT-780): the entry (`created` false when an existing one got the new secret) and how many
 * messages had the secret blanked (`VAULT_BLANKED`, VS-07; 0 for a password the assistant made), or a refusal: `blocked`
 * not the person's own assistant in their turn, or a room others read (VS-04); `failed` not in a message the person wrote
 * here (VS-05), an address the Vault doesn't allow (`not_allowed`), a full Vault, an entry that isn't theirs or of
 * another kind.
 */
export const VaultSaveOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    entryId: VaultEntryId,
    name: z.string(),
    created: z.boolean(),
    blanked: z.number().int().min(0),
  }),
  ...VaultToolRefusal.options,
]);
export type VaultSaveOutput = z.infer<typeof VaultSaveOutput>;

/**
 * `vault_add_server`'s input (CT-781; VS-09…VS-11). `entry` is the SSH key (left out: the person's only one, or a new
 * “Servers” key when they have none); `address` a host or IP with `:port` (`parseVaultSshAddress`, 22 by default);
 * `username` left out: the one the key's servers share, else `root`; `name` left out: the server's own short host name,
 * else the address with dashes. `password` is ignored since 3.14: a refused key answers `key_refused`
 * and the agent asks with a `server` card.
 */
export const VaultAddServerInput = z.object({
  entry: VaultEntryRef.optional().describe(
    'The SSH key’s Vault entry (vlt_… id); leave out when the person has one SSH key or none',
  ),
  address: VaultSshAddress.describe(
    'The server’s host name or IP address, with :port when it isn’t 22 (like 192.168.1.20 or web1.example.com:2222)',
  ),
  username: VaultSshUsername.optional().describe(
    'The user to sign in as; leave out for the one the key’s servers share, else root',
  ),
  name: VaultSshServerName.optional().describe(
    'The name you use for it, like web-1; leave out for the server’s own host name',
  ),
  /**
   * Ignored since 3.14 (Whombat vault-simplify.md): kept so older callers still validate, until the next
   * major. A server's password comes only from the `server` card (`vault_ask`).
   */
  password: z
    .string()
    .min(1)
    .max(VAULT_SSH_SERVER_PASSWORD_MAX)
    .optional()
    .describe(
      'Ignored. Never put a password here: when the key is refused, ask with vault_ask (kind server)',
    ),
});
export type VaultAddServerInput = z.input<typeof VaultAddServerInput>;

/**
 * How `vault_add_server` ended (CT-781): `signed_in` the key already opens the server; `key_added` the password put the
 * key on it and the key signed in (since 3.14 the tool takes no password, so only older servers answer it);
 * `key_refused` the server is added (and its host key trusted) but refuses the key — `publicKey` is the
 * `authorized_keys` line, and the agent asks with a `server` card (`vault_ask`); `already` the key had that
 * host, port and user.
 */
export const VAULT_ADD_SERVER_OUTCOMES = ['signed_in', 'key_added', 'key_refused', 'already'] as const;
export const VaultAddServerOutcome = z.enum(VAULT_ADD_SERVER_OUTCOMES);
export type VaultAddServerOutcome = z.infer<typeof VaultAddServerOutcome>;

/**
 * `vault_add_server`'s answer (CT-781): the key's entry, the server's name and `user@host:port`, the outcome, and the
 * `authorized_keys` line with `key_refused` only (null otherwise); or a refusal — `failed` `host_key_changed` (another
 * key than the one pinned for that host and port: nothing added, nothing sent, VS-10), `not_allowed`, `unreachable`, …;
 * `blocked` not its person's turn, several SSH keys and no `entry` (the message names them).
 */
export const VaultAddServerOutput = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      entryId: VaultEntryId,
      entryName: z.string(),
      server: z.string().min(1).max(VAULT_SSH_SERVER_NAME_MAX),
      target: z.string().min(1).max(300),
      outcome: VaultAddServerOutcome,
      publicKey: z.string().min(1).max(2200).nullable(),
    })
    .refine((o) => (o.outcome === 'key_refused') === (o.publicKey !== null), {
      message: 'publicKey comes with key_refused, and only with it.',
      path: ['publicKey'],
    }),
  ...VaultToolRefusal.options,
]);
export type VaultAddServerOutput = z.infer<typeof VaultAddServerOutput>;

function vaultTool<I extends z.ZodObject, O extends z.ZodType>(def: McpTool<I, O>): McpTool<I, O> {
  return def;
}

export const VAULT_MCP_TOOLS = {
  vault_save: vaultTool({
    name: 'vault_save',
    title: 'Save to the Vault',
    description:
      'Save a login, password or API token to the Vault of the person this turn is for, so it can be used from now on. Use it right away when they send you one in a room only they read; Whombat blanks it in their message. Never repeat the secret in your reply.',
    input: VaultSaveInput,
    output: VaultSaveOutput,
    requiredKey: null,
    readOnly: false,
    personal: true,
  }),
  vault_add_server: vaultTool({
    name: 'vault_add_server',
    title: 'Add a server to an SSH key',
    description:
      'Add a server to an SSH key in the person’s Vault and sign in to it, so ssh in your commands reaches it in the person’s chats. Use it before working on a host the key doesn’t list yet. Whombat trusts the server’s key the first time it connects. When the server refuses the key (key_refused), ask with vault_ask (kind server, reason key_refused): never ask for its password in a message.',
    input: VaultAddServerInput,
    output: VaultAddServerOutput,
    requiredKey: null,
    readOnly: false,
    personal: true,
  }),
} as const;
