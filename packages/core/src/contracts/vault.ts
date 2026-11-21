/**
 * The Vault's REST contract (docs/decisions/vault.md VT-01…VT-13, VT-20, VT-44, VT-52, VT-70…VT-72).
 *
 * - `api.vault.*` (burrow-scoped): the person's entries (since 3.0 there is nobody else's, Whombat one-person.md OP-03,
 *   CT-1511). An entry that doesn't exist answers 404 `not_found` (VT-01).
 * - `api.vaultNetworks.*` (account-level, like connectors): the home network list of this Whombat; the person reads,
 *   adds and removes. Not a signed burrow event (VT-12).
 *
 * Secrets are write-only: `vault.create`, `vault.setSecret` and `vault.setTotp` (a login's authenticator key, 3.14) take
 * one, nothing returns one (VT-04). They are secret session ops (VT-58). Writes answer the person's view and the signed event (neutral text, VT-51).
 *
 * SSH keys (VT-S02…VT-S13, contracts 0.32.0): `vault.create` with kind `ssh` and `sshKey` (generate or import), the key
 * replaced by `vault.replaceSshKey` (import, a secret op) or `vault.generateSshKey` (an ordinary op: only the public
 * half comes back), servers added, changed, removed, checked and their host keys trusted, and which servers a key
 * covers (`vault.setKeyServers`, or `servers` on `vault.giveKey`).
 */
import { z } from 'zod';
import { Count, Cursor } from '../domain/common.js';
import { EventId, VaultEntryId, VaultNetworkId, VaultSshServerId } from '../ids.js';
import { vaultEntryShapeProblems } from '../vault/entry.js';
import { vaultEnvNameProblem } from '../vault/keys.js';
import { vaultNetworkProblem } from '../vault/network.js';
import {
  VAULT_ENTRIES_MAX,
  VAULT_NETWORK_NOTE_MAX,
  VAULT_NETWORK_PORTS_MAX,
  VAULT_SSH_DEFAULT_PORT,
  VAULT_SSH_SERVER_NAME_MAX,
  VAULT_UNHELD_MAX,
  VaultAuth,
  VaultCheckResult,
  VaultEntry,
  VaultEntryDescription,
  VaultEntryDetail,
  VaultEntryKind,
  VaultEntryName,
  VaultKeyServersChoice,
  VaultNetwork,
  VaultPort,
  VaultSecretValue,
  VaultSshCheckResult,
  VaultSshFingerprint,
  VaultUrl,
  VaultUse,
  VaultUsername,
} from '../vault/schemas.js';
import {
  VaultSshHost,
  VaultSshPassphrase,
  VaultSshPrivateKeyText,
  VaultSshServerName,
  VaultSshUsername,
} from '../vault/ssh.js';
import { VaultTotpInput } from '../vault/totp.js';
import { BurrowParam, endpoint, limitQuery } from './endpoint.js';
import type { ErrorCode } from './errors.js';

/* Dispatch context (VT-33; since 0.125 CT-1243) ------------------------------------------------------------------- */

/**
 * A server of an `ssh` entry that the agent's key covers (VT-S12), by the name it is reached by for the agent's commands
 * (`ssh web-1`), its target (`deploy@web1.example.com:22`) and whether its host key is trusted and unchanged
 * (`vaultSshServerReady`; otherwise its commands have no block for it until the person checks).
 */
export const VaultContextSshServer = z.object({
  name: z.string().min(1).max(VAULT_SSH_SERVER_NAME_MAX),
  target: z.string().max(400),
  ready: z.boolean(),
});
export type VaultContextSshServer = z.infer<typeof VaultContextSshServer>;

/**
 * An entry of the person a turn is for that they switched on for the agent (0.125, CT-1243; Whombat hermes-engine.md
 * HE-21, HE-43): never a secret, and never another person's (OA-10). Name and description are delimited data in the
 * prompt (BP-07). How it reaches the agent in this turn: `http` as `envNames` for the agent's commands, `ssh` as a key and an SSH
 * configuration with `servers` there, `login` in Hermes's credential vault (`DispatchContext.logins`), `mcp` as the MCP
 * server `mcpServer` in Hermes's list (`ComputerKeys.mcpServers`).
 */
export const VaultContextEntry = z.object({
  id: VaultEntryId,
  name: z.string(),
  description: z.string(),
  kind: VaultEntryKind.exclude(['secret']),
  /** `http`: the API's base URL; `login`: the sign-in page; `mcp`: the server; null for `ssh`. */
  url: z.string().nullable(),
  /** `http`: the environment variables its value is in (`vaultComputerEnvNames`). Empty for the other kinds. */
  envNames: z.array(z.string().max(80)).max(4).default([]),
  /** `ssh`: the servers the key covers, in the entry's order (empty: none yet). Absent for the other kinds. */
  servers: z.array(VaultContextSshServer).optional(),
  /** `mcp`: the name Hermes knows its server by (`vault_<entry key>`). Absent for the other kinds. */
  mcpServer: z
    .string()
    .regex(/^vault_[a-z]{8}$/)
    .optional(),
});
export type VaultContextEntry = z.infer<typeof VaultContextEntry>;

/**
 * An entry of the person a turn is for that is switched off for the agent (VT-G02), so the agent can tell them what to
 * switch on: kinds `http`, `mcp`, `login` and `ssh` (never `secret`), at most `VAULT_UNHELD_MAX`, by name. Name and
 * description are delimited data in the prompt (BP-07).
 */
export const VaultUnheldEntry = z.object({
  id: VaultEntryId,
  name: z.string(),
  description: z.string(),
  kind: VaultEntryKind.exclude(['secret']),
  /** `login`: the registrable domain of its sign-in page. Null for the other kinds. */
  site: z.string().max(253).nullable(),
});
export type VaultUnheldEntry = z.infer<typeof VaultUnheldEntry>;

/**
 * `DispatchContext.vault` (CT-1243): in a turn for a person, their entries switched on for the agent and those switched
 * off. Null or absent: a turn for nobody, a search answer, a feedback assessment.
 */
export const VaultDispatchContext = z.object({
  entries: z.array(VaultContextEntry).max(VAULT_ENTRIES_MAX),
  unheld: z.array(VaultUnheldEntry).max(VAULT_UNHELD_MAX).default([]),
});
export type VaultDispatchContext = z.infer<typeof VaultDispatchContext>;

/* Bodies ---------------------------------------------------------------------------------------- */

/** Field errors of a Zod refinement, keyed like the server's `validation_failed` fields (`url`, `secret`). */
function addFieldProblems(
  ctx: z.RefinementCtx,
  problems: readonly { field: string; message: string }[],
  prefix: string[] = [],
) {
  for (const p of problems)
    ctx.addIssue({ code: 'custom', message: p.message, path: [...prefix, ...p.field.split('.')] });
}

/**
 * How an `ssh` entry gets its key (VT-S03): **Generate** (`generate`, the default: an ed25519 pair made on the server;
 * the private half never leaves it) or **Import** (`import`: an OpenSSH or PEM private key, RSA ≥ 2048, ECDSA
 * P-256/384/521 or ed25519, with its passphrase if it has one — used once to open the key, never stored). The server
 * refuses what only parsing finds with `validation_failed` on `sshKey.privateKey` / `sshKey.passphrase`
 * (`VAULT_SSH_KEY_PROBLEM_TEXT`).
 */
export const VaultSshKeySource = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('generate') }),
  z.object({
    mode: z.literal('import'),
    privateKey: VaultSshPrivateKeyText,
    passphrase: VaultSshPassphrase.optional(),
  }),
]);
export type VaultSshKeySource = z.input<typeof VaultSshKeySource>;

/**
 * “Add to Vault” (VT-70, VT-D29, VT-S02): the templates are `kind` + `auth` (MCP server `mcp`; API token `http` +
 * bearer; Basic auth `http` + basic with the username; Login `login` + form with the username and optional selectors,
 * the password as `secret`; SSH key `ssh` with `sshKey` and no `auth`, `url` or `secret`). Kind `secret` is refused
 * since 0.113 (CT-823).
 * The secret is required unless an `mcp` entry signs in with `none`. The server then checks the destination (VT-13,
 * unchanged for `login`) and refuses with `address_not_allowed`; an `ssh` entry has no destination of its own (its
 * servers do, VT-S06).
 */
export const CreateVaultEntryBody = z
  .object({
    name: VaultEntryName,
    description: VaultEntryDescription.default(''),
    kind: VaultEntryKind,
    url: VaultUrl.optional(),
    auth: VaultAuth.optional(),
    secret: VaultSecretValue.optional(),
    sshKey: VaultSshKeySource.optional(),
    /**
     * A `login` entry's authenticator key (3.14; Whombat vault-simplify.md): the setup key or the
     * `otpauth://totp/…` link (`parseVaultTotp`), sealed beside the password. Any other kind refuses it.
     */
    totp: VaultTotpInput.optional(),
  })
  .superRefine((body, ctx) => {
    addFieldProblems(ctx, vaultEntryShapeProblems(body, 'create'));
    if (body.totp !== undefined && body.kind !== 'login')
      ctx.addIssue({ code: 'custom', message: VAULT_TOTP_KIND_TEXT, path: ['totp'] });
  });
export type CreateVaultEntryBody = z.input<typeof CreateVaultEntryBody>;

/**
 * Changes to the entry's own fields (never the secret, never the kind). Changing the URL checks the destination again;
 * switching an `mcp` entry to `none` forgets its secret, switching away from `none` needs `vault.setSecret` next. An
 * `ssh` entry changes only its name and description here (its key and servers have their own ops).
 */
export const UpdateVaultEntryBody = z
  .object({
    name: VaultEntryName.optional(),
    description: VaultEntryDescription.optional(),
    url: VaultUrl.optional(),
    auth: VaultAuth.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to change.');
export type UpdateVaultEntryBody = z.input<typeof UpdateVaultEntryBody>;

/** Replace the secret (the only change a secret gets). A `basic` entry and a `login` entry (`form`) may change their username with it. */
export const SetVaultSecretBody = z.object({
  value: VaultSecretValue,
  username: VaultUsername.optional(),
});
export type SetVaultSecretBody = z.input<typeof SetVaultSecretBody>;

/** Why an entry that isn't a website login can't take an authenticator key. */
export const VAULT_TOTP_KIND_TEXT = 'Only a website login takes an authenticator key.';

/**
 * A `login` entry's authenticator key from its page (3.14): the setup key or `otpauth://totp/…` link,
 * or null to remove it. Write-only like the password: a secret op. Another kind answers `wrong_kind`.
 */
export const SetVaultTotpBody = z.object({ totp: VaultTotpInput.nullable() });
export type SetVaultTotpBody = z.input<typeof SetVaultTotpBody>;

export const SetVaultToolBody = z.object({ enabled: z.boolean() });
/** A key's environment variable (AC-31): `vaultEnvNameProblem` decides. */
export const VaultEnvName = z.string().superRefine((name, ctx) => {
  const problem = vaultEnvNameProblem(name);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

/**
 * Switch an entry on for the agent (CT-1240). `servers` (an `ssh` entry, VT-S07): null is All servers, a list only those;
 * absent keeps an existing key's servers and gives a new key All servers. A list on any other kind is `wrong_kind`; an
 * id that isn't one of the entry's servers is `not_found`. `envName` (an `http` entry): absent keeps the key's, or
 * `defaultVaultEnvName` of the entry's name; on another kind `wrong_kind`.
 */
export const GiveVaultKeyBody = z.object({
  servers: VaultKeyServersChoice.optional(),
  envName: VaultEnvName.optional(),
});
export type GiveVaultKeyBody = z.input<typeof GiveVaultKeyBody>;

/** The environment variable an `http` entry's value is in for the agent's commands (AC-31, CT-1240). */
export const SetVaultKeyEnvNameBody = z.object({ envName: VaultEnvName });
export type SetVaultKeyEnvNameBody = z.input<typeof SetVaultKeyEnvNameBody>;
/** Which of an `ssh` entry's servers a key covers (VT-S07): null is All servers. */
export const SetVaultKeyServersBody = z.object({ servers: VaultKeyServersChoice });
export type SetVaultKeyServersBody = z.input<typeof SetVaultKeyServersBody>;

/** “Replace with my own key” (VT-S03): an import; the old key stops working at once. A secret op. */
export const ReplaceVaultSshKeyBody = z.object({
  privateKey: VaultSshPrivateKeyText,
  passphrase: VaultSshPassphrase.optional(),
});
export type ReplaceVaultSshKeyBody = z.input<typeof ReplaceVaultSshKeyBody>;

/**
 * “Add server” (VT-S04): the name agents use, the host, the port (22 when absent) and the user to sign in as; whether it
 * is a production server (AC-11, 0.36.0; absent: no).
 */
export const AddVaultSshServerBody = z.object({
  name: VaultSshServerName,
  host: VaultSshHost,
  port: VaultPort.default(VAULT_SSH_DEFAULT_PORT),
  username: VaultSshUsername,
  production: z.boolean().optional(),
});
export type AddVaultSshServerBody = z.input<typeof AddVaultSshServerBody>;

/** “Edit” on a server: any of its fields. A new host or port forgets the trusted host key and is checked again. */
export const UpdateVaultSshServerBody = z
  .object({
    name: VaultSshServerName.optional(),
    host: VaultSshHost.optional(),
    port: VaultPort.optional(),
    username: VaultSshUsername.optional(),
    /** Production (AC-11, 0.36.0): the agent's commands reach it only after the person's yes. */
    production: z.boolean().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to change.');
export type UpdateVaultSshServerBody = z.input<typeof UpdateVaultSshServerBody>;

/**
 * “Trust this server” (VT-S05): the fingerprint the person saw on the card. The server fetches the host key again and
 * trusts it only if it still has this fingerprint (else `host_key_mismatch`, and the card shows the new one).
 */
export const TrustVaultSshHostKeyBody = z.object({ fingerprint: VaultSshFingerprint });
export type TrustVaultSshHostKeyBody = z.input<typeof TrustVaultSshHostKeyBody>;

export const AddVaultNetworkBody = z
  .object({
    cidr: z.string().trim().min(1).max(60),
    ports: z.array(VaultPort).min(1).max(VAULT_NETWORK_PORTS_MAX),
    note: z.string().trim().max(VAULT_NETWORK_NOTE_MAX).default(''),
  })
  .superRefine((body, ctx) => {
    const problem = vaultNetworkProblem(body.cidr, body.ports);
    if (problem) ctx.addIssue({ code: 'custom', message: problem.message, path: [problem.field] });
  });
export type AddVaultNetworkBody = z.input<typeof AddVaultNetworkBody>;

/* Responses ------------------------------------------------------------------------------------- */

/** A write on an entry: the person's view and the signed event (neutral text); null when nothing changed. */
export const VaultEntryWriteResponse = z.object({ entry: VaultEntryDetail, eventId: EventId.nullable() });
export type VaultEntryWriteResponse = z.infer<typeof VaultEntryWriteResponse>;

/** A write on one of an `ssh` entry's servers: the entry, the server it was about, and the signed event. */
export const VaultSshServerWriteResponse = VaultEntryWriteResponse.extend({ serverId: VaultSshServerId });
export type VaultSshServerWriteResponse = z.infer<typeof VaultSshServerWriteResponse>;

/**
 * A server's Check, or “Trust this server” (which signs in once right after, VT-S05): the entry with the server's check
 * recorded, and the result. `eventId`: trusting signs `vault.entry.changed`; a check signs nothing (VT-D08).
 */
export const VaultSshCheckResponse = z.object({
  entry: VaultEntryDetail,
  result: VaultSshCheckResult,
  eventId: EventId.nullable().default(null),
});
export type VaultSshCheckResponse = z.infer<typeof VaultSshCheckResponse>;

export const VaultListResponse = z.object({
  /** The person's entries, by name. */
  entries: z.array(VaultEntry),
  /** Whether another fits (under `VAULT_ENTRIES_MAX`). */
  canAdd: z.boolean(),
});
export type VaultListResponse = z.infer<typeof VaultListResponse>;

export const VaultGetResponse = z.object({ entry: VaultEntryDetail });
export type VaultGetResponse = z.infer<typeof VaultGetResponse>;

export const VaultUsesResponse = z.object({
  /** Newest first. */
  uses: z.array(VaultUse),
  before: Cursor.nullable(),
  hasMore: z.boolean(),
});
export type VaultUsesResponse = z.infer<typeof VaultUsesResponse>;

export const VaultNetworksResponse = z.object({
  /** By CIDR. */
  networks: z.array(VaultNetwork),
  /** At most `VAULT_NETWORKS_MAX`. */
  max: Count,
});
export type VaultNetworksResponse = z.infer<typeof VaultNetworksResponse>;

/* Refusals -------------------------------------------------------------------------------------- */

/**
 * Why a Vault endpoint refused, in `error.details.code` over REST and the session alike (CT-21). Another person's entry
 * is plain `not_found` (no code), exactly as one that doesn't exist.
 */
export const VAULT_ERROR_CODES = [
  /** The destination rules refused the URL (`vaultDestinationProblem`); `details.problem`, `details.suggestion`. */
  'address_not_allowed',
  /** `details.limit`: `entries` (50 per person per burrow), `keys` (20 per entry) or `networks` (32). */
  'limit_reached',
  /** The agent can't hold a key to the caller's entries (`vaultKeyHolderProblem`); `details.reason`. */
  /**
   * Not for this kind of entry: tools of a non-`mcp` entry, keys to a `secret` entry, Check connection on a `login`
   * entry; 0.32.0: Check connection or `vault.setSecret` on an `ssh` entry (its servers are checked one by one, its key
   * is replaced with `vault.replaceSshKey` / `vault.generateSshKey`), key and server ops on anything but `ssh`, `servers`
   * on a key to another kind; 0.125: `envName` on anything but `http`; 3.14: `vault.setTotp` on anything but `login`.
   */
  'wrong_kind',
  /** The network is already on the list. */
  'network_listed',
  /** 0.32.0 (VT-S04): the `ssh` entry already has a server with that name. */
  'server_name_taken',
  /** 0.32.0 (VT-S05): trusting a host key the server no longer shows (`details.fingerprint`: the one it shows now). */
  'host_key_mismatch',
] as const;
export const VaultErrorCode = z.enum(VAULT_ERROR_CODES);
export type VaultErrorCode = z.infer<typeof VaultErrorCode>;

export const VAULT_ERROR_STATUS: Record<VaultErrorCode, ErrorCode> = {
  address_not_allowed: 'not_allowed',
  limit_reached: 'conflict',
  wrong_kind: 'conflict',
  network_listed: 'conflict',
  server_name_taken: 'conflict',
  host_key_mismatch: 'conflict',
};

/** `servers`: 20 per `ssh` entry (0.32.0). */
export const VaultLimit = z.enum(['entries', 'networks', 'servers']);
export type VaultLimit = z.infer<typeof VaultLimit>;

/** `error.message` for each refusal when there is nothing more specific. */
export const VAULT_ERROR_MESSAGES: Record<VaultErrorCode, string> = {
  address_not_allowed: 'That address isn’t allowed.',
  limit_reached: 'That’s as many as there can be.',
  wrong_kind: 'That doesn’t apply to this kind of entry.',
  network_listed: 'That network is already on the list.',
  server_name_taken: 'This key already has a server with that name.',
  host_key_mismatch:
    'The server showed a different host key just now. Compare the new one before you trust it.',
};

/** The message for a limit (“You have 50 Vault entries, the most there can be. Remove one first.”). */
export const VAULT_LIMIT_MESSAGES: Record<VaultLimit, string> = {
  entries: 'You have 50 Vault entries, the most there can be. Remove one first.',
  networks: 'The home network list holds at most 32 networks. Remove one first.',
  servers: 'An SSH key can have at most 20 servers. Remove one first.',
};

/** `error.details` of a Vault refusal. */
export const VaultErrorDetails = z.object({
  code: VaultErrorCode,
  /** `address_not_allowed`: `VaultDestinationProblemCode` (`VaultSshDestinationProblemCode` for a server). */
  problem: z.string().optional(),
  suggestion: z.object({ cidr: z.string(), port: VaultPort }).optional(),
  /** `limit_reached`. */
  limit: VaultLimit.optional(),
  max: Count.optional(),
  /** `host_key_mismatch`: the host key the server shows now. */
  hostKey: z.object({ algorithm: z.string(), fingerprint: z.string() }).optional(),
});
export type VaultErrorDetails = z.infer<typeof VaultErrorDetails>;

/* Endpoints ------------------------------------------------------------------------------------- */

const B = z.object({ burrow: BurrowParam });
const BE = B.extend({ entryId: VaultEntryId });
const BES = BE.extend({ serverId: VaultSshServerId });
/** A bridged server's tool name as it lists it (path-encoded). */
const ToolParam = z.string().min(1).max(200);

export const vaultEndpoints = {
  list: endpoint({
    id: 'vault.list',
    method: 'GET',
    path: '/burrows/:burrow/vault',
    summary: 'The caller’s own Vault entries in this burrow (YOUR ENTRIES). Nobody else’s, ever.',
    params: B,
    response: VaultListResponse,
  }),
  get: endpoint({
    id: 'vault.get',
    method: 'GET',
    path: '/burrows/:burrow/vault/:entryId',
    summary:
      'One of the caller’s entries with its tools, the agent’s key and RECENT USE. 404 for anyone else’s.',
    params: BE,
    response: VaultGetResponse,
  }),
  create: endpoint({
    id: 'vault.create',
    method: 'POST',
    path: '/burrows/:burrow/vault',
    summary:
      'Add an entry to the caller’s Vault with its secret (sealed, never returned). The destination is checked (`address_not_allowed`); “Check connection” is `vault.check`. A secret op.',
    params: B,
    body: CreateVaultEntryBody,
    response: VaultEntryWriteResponse,
    status: 201,
  }),
  update: endpoint({
    id: 'vault.update',
    method: 'PATCH',
    path: '/burrows/:burrow/vault/:entryId',
    summary:
      'Change an entry’s name, description, address or how it signs in (never the secret). A new address is checked again and ends the bridged connection.',
    params: BE,
    body: UpdateVaultEntryBody,
    response: VaultEntryWriteResponse,
  }),
  setSecret: endpoint({
    id: 'vault.setSecret',
    method: 'PUT',
    path: '/burrows/:burrow/vault/:entryId/secret',
    summary:
      'Replace an entry’s secret (and a login’s username). Write-only: the value is sealed and never returned. A secret op.',
    params: BE,
    body: SetVaultSecretBody,
    response: VaultEntryWriteResponse,
  }),
  setTotp: endpoint({
    id: 'vault.setTotp',
    method: 'PUT',
    path: '/burrows/:burrow/vault/:entryId/totp',
    summary:
      'Set or remove a website login’s authenticator key (3.14): the setup key or otpauth:// link, sealed beside the password and never returned; null removes it. `wrong_kind` for any other kind. A secret op.',
    params: BE,
    body: SetVaultTotpBody,
    response: VaultEntryWriteResponse,
  }),
  remove: endpoint({
    id: 'vault.remove',
    method: 'DELETE',
    path: '/burrows/:burrow/vault/:entryId',
    summary:
      'Remove an entry: its secret, keys, passes, tools and RECENT USE go with it; the audit log keeps the neutral lines.',
    params: BE,
    response: z.object({ ok: z.literal(true), eventId: EventId }),
  }),
  check: endpoint({
    id: 'vault.check',
    method: 'POST',
    path: '/burrows/:burrow/vault/:entryId/check',
    summary:
      '“Check connection” (VT-44): an `mcp` entry initialises and lists its tools (the first check turns every tool on; new or changed tools are off with “New”); an `http` entry answers a GET of its base URL. `wrong_kind` for a `login` entry.',
    params: BE,
    response: z.object({ entry: VaultEntryDetail, result: VaultCheckResult }),
  }),
  setTool: endpoint({
    id: 'vault.setTool',
    method: 'PUT',
    path: '/burrows/:burrow/vault/:entryId/tools/:tool',
    summary:
      'Turn one of an `mcp` entry’s tools on or off (either clears its “New” badge). Hermes gets only those that are on.',
    params: BE.extend({ tool: ToolParam }),
    body: SetVaultToolBody,
    response: VaultEntryWriteResponse,
  }),
  giveKey: endpoint({
    id: 'vault.giveKey',
    method: 'PUT',
    path: '/burrows/:burrow/vault/:entryId/key',
    summary:
      'Switch the entry on for the agent: from then on it reaches the agent in your chats, never in a turn outsiders started (CT-1240, OP-17).',
    params: BE,
    body: GiveVaultKeyBody,
    response: VaultEntryWriteResponse,
  }),
  takeKey: endpoint({
    id: 'vault.takeKey',
    method: 'DELETE',
    path: '/burrows/:burrow/vault/:entryId/key',
    summary: 'Switch the entry off for the agent.',
    params: BE,
    response: VaultEntryWriteResponse,
  }),
  uses: endpoint({
    id: 'vault.uses',
    method: 'GET',
    path: '/burrows/:burrow/vault/:entryId/uses',
    summary: 'RECENT USE of one of the caller’s entries, newest first, paged.',
    params: BE,
    query: z.object({ before: Cursor.optional(), limit: limitQuery(20, 100) }),
    response: VaultUsesResponse,
  }),
  // SSH keys (VT-S03…VT-S07, contracts 0.32.0). Every one is `wrong_kind` on an entry that isn't `ssh`.
  generateSshKey: endpoint({
    id: 'vault.generateSshKey',
    method: 'POST',
    path: '/burrows/:burrow/vault/:entryId/ssh-key/generate',
    summary:
      '“Generate a new key” (VT-S03): a new ed25519 pair made on the server replaces the key at once (the old one stops working everywhere; servers and host-key trust stay). Only the public half comes back. Signs `vault.entry.secret_replaced`.',
    params: BE,
    response: VaultEntryWriteResponse,
  }),
  replaceSshKey: endpoint({
    id: 'vault.replaceSshKey',
    method: 'PUT',
    path: '/burrows/:burrow/vault/:entryId/ssh-key',
    summary:
      '“Replace with my own key” (VT-S03): an imported private key (and its passphrase, used once) replaces the key at once. Sealed, never returned. Signs `vault.entry.secret_replaced`. A secret op.',
    params: BE,
    body: ReplaceVaultSshKeyBody,
    response: VaultEntryWriteResponse,
  }),
  addSshServer: endpoint({
    id: 'vault.addSshServer',
    method: 'POST',
    path: '/burrows/:burrow/vault/:entryId/servers',
    summary:
      '“Add server” (VT-S04): at most 20 per key, names unique (`server_name_taken`); the address is checked (`address_not_allowed`, VT-S06). It starts unchecked: Check reads its host key for the person to trust. Signs `vault.entry.changed`.',
    params: BE,
    body: AddVaultSshServerBody,
    response: VaultSshServerWriteResponse,
    status: 201,
  }),
  updateSshServer: endpoint({
    id: 'vault.updateSshServer',
    method: 'PATCH',
    path: '/burrows/:burrow/vault/:entryId/servers/:serverId',
    summary:
      'Change a server’s name, host, port, username or Production switch (AC-11). A new host or port is checked again and forgets the trusted host key; open connections to it close. Signs `vault.entry.changed`.',
    params: BES,
    body: UpdateVaultSshServerBody,
    response: VaultSshServerWriteResponse,
  }),
  removeSshServer: endpoint({
    id: 'vault.removeSshServer',
    method: 'DELETE',
    path: '/burrows/:burrow/vault/:entryId/servers/:serverId',
    summary:
      'Remove a server: its connections close, and keys that listed it cover the rest (a key left with none covers nothing). Signs `vault.entry.changed`.',
    params: BES,
    response: VaultEntryWriteResponse,
  }),
  checkSshServer: endpoint({
    id: 'vault.checkSshServer',
    method: 'POST',
    path: '/burrows/:burrow/vault/:entryId/servers/:serverId/check',
    summary:
      'Check a server (VT-S05): connect and read its host key — unknown is `host_key_unconfirmed` (trust it next), different from the trusted one `host_key_changed` — and, when trusted, sign in with the key and run nothing (“Signed in as deploy”). Signs nothing.',
    params: BES,
    response: VaultSshCheckResponse,
  }),
  trustSshHostKey: endpoint({
    id: 'vault.trustSshHostKey',
    method: 'POST',
    path: '/burrows/:burrow/vault/:entryId/servers/:serverId/trust',
    summary:
      '“Trust this server” (VT-S05): the server fetches the host key again and trusts it only if it still has the fingerprint the person saw (`host_key_mismatch` otherwise), then signs in once as a Check does. Signs `vault.entry.changed`.',
    params: BES,
    body: TrustVaultSshHostKeyBody,
    response: VaultSshCheckResponse,
  }),
  setKeyServers: endpoint({
    id: 'vault.setKeyServers',
    method: 'PUT',
    path: '/burrows/:burrow/vault/:entryId/key/servers',
    summary:
      'Which of an `ssh` entry’s servers the agent’s key covers (VT-S07): null is All servers (later ones too), a list only those. Connections to servers it no longer covers close. Signs `vault.key.changed`.',
    params: BE,
    body: SetVaultKeyServersBody,
    response: VaultEntryWriteResponse,
  }),
  // The variable an `http` entry's value is in for the agent's commands (AC-31; since 0.125 the only key setting, CT-1240).
  setKeyEnvName: endpoint({
    id: 'vault.setKeyEnvName',
    method: 'PUT',
    path: '/burrows/:burrow/vault/:entryId/key/env-name',
    summary:
      'The environment variable an `http` entry’s value is in for the agent’s commands during your chats (`wrong_kind` for other kinds). Signs `vault.key.changed`.',
    params: BE,
    body: SetVaultKeyEnvNameBody,
    response: VaultEntryWriteResponse,
  }),
};

const N = z.object({ networkId: VaultNetworkId });

export const vaultNetworkEndpoints = {
  list: endpoint({
    id: 'vaultNetworks.list',
    method: 'GET',
    path: '/vault/networks',
    summary: 'The home network list of this Whombat (everyone reads it, so the Vault form can explain).',
    response: VaultNetworksResponse,
  }),
  add: endpoint({
    id: 'vaultNetworks.add',
    method: 'POST',
    path: '/vault/networks',
    summary:
      'Add a network to the home network list: a private range at most a /16 or /48 wide, 1–16 ports, a note.',
    body: AddVaultNetworkBody,
    response: VaultNetworksResponse,
    status: 201,
  }),
  remove: endpoint({
    id: 'vaultNetworks.remove',
    method: 'DELETE',
    path: '/vault/networks/:networkId',
    summary: 'Remove a network. Entries on it stay, and their calls are refused from now on.',
    params: N,
    response: VaultNetworksResponse,
  }),
};
