/**
 * Setting things up from the chat (Whombat connect-in-chat.md). Spread into `MCP_TOOLS` (`./mcp`); both are
 * `personal: true` (only in a turn for the person, acting for them) and need no key: they only put a card in the
 * thread, and the person does the rest there.
 *
 * - `connection_add`: a card that opens the connect form filled in (the service, the address the network scan found,
 *   Look only or Manage by risk), Sign in once first. The password is typed into that form, never into the chat. For an
 *   MCP server or API that isn't in the catalog (`custom_mcp`, `custom_api`) the assistant sets the connection up by
 *   talking: its name, address, how it signs in and notes; the card says what it will be, takes the key in a write-only
 *   field and connects there (Whombat connect-by-talking.md).
 * - `vault_ask`: a card with a write-only form for any sign-in (a password, a sign-in key, a server's password or private
 *   key, a one-time code). What the person types goes straight to their Vault (a code to the sign-in, once); the agent
 *   never sees it and is woken with how it went and the entry's id.
 */
import { z } from 'zod';
import { ConnectionAccessLevel } from '../domain/connections-catalog/shared.js';
import { UptimeFields } from '../domain/connections-catalog/uptime.js';
import { GuideVaultKind, GuideVaultServerReason } from '../domain/guides.js';
import { MessageId } from '../ids.js';
import { VaultEntryDescription, VaultEntryName, VaultUrl, VaultUsername } from '../vault/schemas.js';
import { vaultSshAddressProblem, vaultSshServerNameProblem, vaultSshUsernameProblem } from '../vault/ssh.js';
import type { McpTool } from './mcp.js';
import { VaultEntryRef, VaultToolRefusal } from './mcp-vault.js';

function setupTool<I extends z.ZodObject, O extends z.ZodType>(
  def: McpTool<I, O> & { personal: true },
): McpTool<I, O> & { personal: true } {
  return def;
}

/** Why `connection_add` posted nothing. */
export const CONNECTION_ADD_FAILURES = [
  /** No catalog entry by that name (or more than one). */
  'unknown_service',
  /** Turned off on this Whombat, or something only automations use. */
  'unavailable',
  /** The person has it connected already (`connectionId`). */
  'already_connected',
  /** Not in a turn for the person in their Chat. */
  'not_here',
  /** The address isn't one, or an MCP server or API was named without one. */
  'invalid_address',
  /** Connections may not reach that address (the home-network rule), in its own words. */
  'not_allowed',
  /** The MCP server didn't answer, or not as an MCP server. */
  'unreachable',
  /** The Whombat has as many connections as it may. */
  'full',
  /** The sign-in asked for doesn't fit (a key's name, a username, a sign-in the entry has no such way for). */
  'invalid_sign_in',
] as const;
export const ConnectionAddFailure = z.enum(CONNECTION_ADD_FAILURES);
export type ConnectionAddFailure = z.infer<typeof ConnectionAddFailure>;

/** How an API set up by talking signs in (`connection_add`'s `signIn`). */
export const CONNECTION_ADD_SIGN_INS = ['none', 'bearer', 'header', 'basic', 'query'] as const;

export const ConnectionAddInput = z.object({
  service: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .describe(
      'Its catalog id or name (homeassistant, unifi_network, Synology), else custom_mcp (an MCP server) or custom_api (an HTTP API)',
    ),
  address: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .optional()
    .describe(
      'Its address when the person told you (192.168.1.10, https://ha.lan:8123); leave out to use what Whombat found on the network',
    ),
  access: ConnectionAccessLevel.optional().describe(
    'read (Look only) or manage; leave out and Whombat chooses by risk (Manage for Home Assistant or Pi-hole, Look only for a NAS)',
  ),
  name: z.string().trim().min(1).max(80).optional().describe('custom_* or uptime: what to call it'),
  signIn: z
    .enum(CONNECTION_ADD_SIGN_INS)
    .optional()
    .describe('custom_api: bearer (default), header, basic or query; custom_mcp: leave out'),
  uptime: UptimeFields.optional().describe(
    'For service uptime: kind http (website), tcp (port), ping, dns (name lookup), or heartbeat (check-in). Put the target in uptime.address and leave it out for a heartbeat. every is 1, 5 or 15 minutes, as a string. late gives a heartbeat extra minutes. runner is hub or a watched server id. keyword is optional for a website.',
  ),
  keyName: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe('header or query: its name, like X-Api-Key or appid'),
  keyPrefix: z.string().max(40).optional().describe('header: what goes before the key, like “Token ”'),
  username: z.string().trim().min(1).max(200).optional().describe('basic: the username, when known'),
  notes: z
    .string()
    .trim()
    .max(1500)
    .optional()
    .describe('custom_api: its main endpoints and cautions, from its docs'),
});
export type ConnectionAddInput = z.input<typeof ConnectionAddInput>;

/**
 * `connection_add`'s answer: the card is in the thread (`messageId`), with the entry, the address it was filled with
 * (`found`: from the network scan) and the level; `server: true` when the entry is looked after best as a server, so
 * the card's first button adds it as one; `connectsHere: true` when the card takes the key and connects itself (an MCP
 * server or API set up by talking), and `signIn` how it signs in (`oauth`: the card opens the server's own sign-in).
 * Or why not, in plain words.
 */
export const ConnectionAddOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    messageId: MessageId,
    service: z.string(),
    address: z.string().nullable(),
    found: z.boolean(),
    access: ConnectionAccessLevel,
    server: z.boolean(),
    connectsHere: z.boolean().optional(),
    signIn: z.enum([...CONNECTION_ADD_SIGN_INS, 'oauth']).optional(),
  }),
  z.object({
    status: z.literal('failed'),
    reason: ConnectionAddFailure,
    message: z.string(),
    connectionId: z.string().optional(),
  }),
]);
export type ConnectionAddOutput = z.infer<typeof ConnectionAddOutput>;

/**
 * `vault_ask`'s input (3.14 adds `server` and `code`; Whombat vault-simplify.md).
 *
 * - `login`, `token`, `basic`: without `entry` the card makes a new entry: `name` and `address` are required;
 *   `username` for `login` and `basic` is asked on the card when left out. With `entry` one of the person's own entries
 *   of the same kind gets what they type (a password that stopped working): no `address`, no `name`.
 * - `server`: `address` (`host[:port]`, 22 by default) is required; `username` the user to sign in as (left out: the one
 *   the key's servers share, else root); `name` the server's name (left out: as `vault_add_server` names it); `entry`
 *   the SSH key it goes with (left out: the person's only one, else a new “Servers” key); `reason` `key_refused` when
 *   the key was turned down, else `new`.
 * - `code`: `name` is the site or server that sent the code (github.com); `hint` where it came from. Nothing else.
 */
export const VaultAskInput = z
  .object({
    kind: GuideVaultKind.describe(
      'login: a website signed in to in the browser; token: an API token sent as Bearer; basic: an API with a username and password; server: signing in to an SSH server, new or one that refused your key; code: a one-time code a site or server sent the person',
    ),
    name: VaultEntryName.optional().describe(
      'What it is, as the card says it: UniFi, Plex, Cloudflare API; for server its name, like web-1 (optional); for code the site that sent it, like github.com (leave out with entry)',
    ),
    address: VaultUrl.optional().describe(
      'For a new entry: the sign-in page (login) or the API’s base URL (token, basic), like https://192.168.1.1; for server its host or IP with :port when not 22, like 192.168.1.20 (leave out with entry, and for code)',
    ),
    username: VaultUsername.optional().describe(
      'The username it signs in with, when you know it (login, basic and server); left out, the card asks for it (server: the key’s usual user, else root)',
    ),
    why: VaultEntryDescription.optional().describe(
      'One plain sentence on what you need it for, shown on the card and kept with the entry',
    ),
    entry: VaultEntryRef.optional().describe(
      'A saved entry of the same kind that needs a new password or key (its vlt_… id); for server the SSH key it goes with; leave out for a new entry',
    ),
    reason: GuideVaultServerReason.optional().describe(
      'server only: key_refused when the server turned your key down, else leave out',
    ),
    hint: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'code only: where the code came from, in one short sentence (“It came by text to your phone.”)',
      ),
  })
  .superRefine((i, ctx) => {
    const problem = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', message, path: [path] });
    if (i.kind !== 'server' && i.reason !== undefined) problem('reason', 'reason is only for server.');
    if (i.kind !== 'code' && i.hint !== undefined) problem('hint', 'hint is only for code.');
    if (i.kind === 'server') {
      if (i.address === undefined) problem('address', 'A server needs its address, like 192.168.1.20.');
      else {
        const bad = vaultSshAddressProblem(i.address);
        if (bad) problem('address', bad);
      }
      if (i.username !== undefined) {
        const bad = vaultSshUsernameProblem(i.username);
        if (bad) problem('username', bad);
      }
      if (i.name !== undefined) {
        const bad = vaultSshServerNameProblem(i.name);
        if (bad) problem('name', bad);
      }
      return;
    }
    if (i.kind === 'code') {
      if (i.name === undefined) problem('name', 'Name the site or server that sent the code.');
      if (i.address !== undefined) problem('address', 'A code has no address: name the site instead.');
      if (i.username !== undefined) problem('username', 'A code has no username.');
      if (i.entry !== undefined) problem('entry', 'A code isn’t saved in an entry.');
      return;
    }
    if (i.entry === undefined) {
      if (i.name === undefined) problem('name', 'A new entry needs a name.');
      if (i.address === undefined) problem('address', 'A new entry needs its address.');
      return;
    }
    if (i.address !== undefined)
      problem('address', 'Leave out address when a saved entry gets a new secret.');
    if (i.name !== undefined) problem('name', 'Leave out name when a saved entry gets a new secret.');
  });
export type VaultAskInput = z.input<typeof VaultAskInput>;

/** `vault_ask`'s answer: the card is in the thread, or why not (`failed` in plain words, `blocked` not their turn). */
export const VaultAskOutput = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), messageId: MessageId }),
  ...VaultToolRefusal.options,
]);
export type VaultAskOutput = z.infer<typeof VaultAskOutput>;

export const SETUP_MCP_TOOLS = {
  connection_add: setupTool({
    name: 'connection_add',
    title: 'Ask the person to connect a service',
    description:
      'Put a card in this thread to connect a service; the person signs in on it and you never get the password. For “watch my website” or “tell me if my backup script doesn’t check in”, use service uptime with the uptime settings: the card asks the person to start the check. For other catalog services the card opens the connect form filled in (Proxmox VE, Proxmox Backup Server and Unraid are added as servers first). Anything else you set up yourself from its documentation: custom_mcp (a remote MCP server) or custom_api (an HTTP API), with name and address; ask the person only what only they know. The card takes the key and checks it, and you are woken once it is connected. The card says it all: don’t repeat it, end your turn.',
    input: ConnectionAddInput,
    output: ConnectionAddOutput,
    requiredKey: null,
    readOnly: false,
    personal: true,
  }),
  vault_ask: setupTool({
    name: 'vault_ask',
    title: 'Ask the person for a sign-in',
    description:
      'Put a card in this thread where the person types what you need to sign in: a website’s or API’s password or key, a server’s password or their own private key (server), or a one-time code a site sent them (code). It goes straight to their Vault (a code is used once), and neither you nor the chat ever sees it. Never ask for a secret in a message: use this, say in one sentence what you need and why, and end your turn. Once they answer you are woken with how it went and the Vault entry’s id; a saved value reaches your commands as any entry does.',
    input: VaultAskInput,
    output: VaultAskOutput,
    requiredKey: null,
    readOnly: false,
    personal: true,
  }),
} as const;
