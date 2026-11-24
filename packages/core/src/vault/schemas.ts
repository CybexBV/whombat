/**
 * The Vault (docs/decisions/vault.md): logins and API keys a person keeps for the agent. An entry belongs to one
 * person in one burrow and is readable only by them (VT-01). Since 0.125 (CT-1240; Whombat hermes-engine.md HE-21,
 * HE-43) an entry switched on for the agent reaches it only in the person's own turns (never one outsiders started,
 * OP-17): an API's token and an SSH key in the agent's commands, a website login in Hermes's credential vault, an MCP server in Hermes's list. No
 * Ask, no passes, no relayed requests. These are the entity and view schemas every surface shares; the REST contract is
 * `contracts/vault.ts`.
 */
import { z } from 'zod';
import { Count, Timestamp } from '../domain/common.js';
import {
  DispatchId,
  EventId,
  PrincipalId,
  VaultEntryId,
  VaultNetworkId,
  VaultSshServerId,
  VaultUseId,
} from '../ids.js';

/* Limits (VT-04, VT-07, VT-12, VT-41, VT-43) ------------------------------------------------------ */

/** Entries per person per burrow. */
export const VAULT_ENTRIES_MAX = 50;
/**
 * The requester's own entries an agent holds no key to, named in their own turn (VT-G02, 0.33.0): at most this many,
 * by name (`VaultDispatchContext.unheld`).
 */
export const VAULT_UNHELD_MAX = 20;
/** Tools kept per MCP entry; the rest are ignored with a note (`toolsIgnored`). */
export const VAULT_TOOLS_MAX = 64;
export const VAULT_NAME_MAX = 60;
/** “What should the agent know?” */
export const VAULT_DESCRIPTION_MAX = 500;
export const VAULT_URL_MAX = 2000;
export const VAULT_SECRET_MAX = 8000;
/** A basic-auth username (stored with the entry, not secret). */
export const VAULT_USERNAME_MAX = 200;
/** Networks on the home network list, and ports per network. */
export const VAULT_NETWORKS_MAX = 32;
export const VAULT_NETWORK_PORTS_MAX = 16;
export const VAULT_NETWORK_NOTE_MAX = 200;
/** The widest home network: a /16 (IPv4) or /48 (IPv6). */
export const VAULT_NETWORK_MIN_PREFIX_V4 = 16;
export const VAULT_NETWORK_MIN_PREFIX_V6 = 48;
/** A tool's description as an `mcp` entry's server listed it (shown to the person). */
export const VAULT_TOOL_DESCRIPTION_MAX = 1000;
/** Every outbound call's total deadline (Check connection). */
export const VAULT_CALL_DEADLINE_MS = 30_000;
/** RECENT USE on the Vault page (per entry). */
export const VAULT_RECENT_USES = 20;

/* SSH keys (VT-S02…VT-S11, contracts 0.32.0) ----------------------------------------------------- */

/** Servers per `ssh` entry (VT-S04). */
export const VAULT_SSH_SERVERS_MAX = 20;
/** A server's name, the handle agents use (`web-1`). */
export const VAULT_SSH_SERVER_NAME_MAX = 40;
/** A server's host name or IP literal. */
export const VAULT_SSH_HOST_MAX = 253;
/** The user a server is signed in to as. */
export const VAULT_SSH_USERNAME_MAX = 32;
/** The port a new server gets. */
export const VAULT_SSH_DEFAULT_PORT = 22;
/** The ports public servers may be reached on unless the runtime sets `WHOMBAT_VAULT_SSH_PORTS` (VT-S06). */
export const VAULT_SSH_PORTS_DEFAULT: readonly number[] = Object.freeze([22]);
/** A private key as pasted (OpenSSH or PEM text), and its passphrase (used once at import, never stored). */
export const VAULT_SSH_PRIVATE_KEY_MAX = 16_000;
export const VAULT_SSH_PASSPHRASE_MAX = 1024;
/** The shortest RSA key Whombat accepts (VT-S03). */
export const VAULT_SSH_RSA_MIN_BITS = 2048;
/**
 * `vault_add_server`'s address (0.112.0, CT-781; Whombat vault-self-serve.md VS-09): a host name or IP literal with an
 * optional `:port` (`parseVaultSshAddress`).
 */
export const VAULT_SSH_ADDRESS_MAX = 260;
/**
 * A server's password as the `server` card takes it (Whombat vault-simplify.md): used once to put the key on the
 * server, or kept sealed with it (“Keep the password”). `vault_add_server`'s `password` has the same bound and is ignored.
 */
export const VAULT_SSH_SERVER_PASSWORD_MAX = 1024;
/** Whombat's own SSH connections (a server's check, `vault_add_server`): connect + sign-in deadline. */
export const VAULT_SSH_CONNECT_DEADLINE_MS = 30_000;

/* Kinds, templates and how an entry signs in (VT-02, VT-03) ------------------------------------- */

/**
 * `mcp`: an MCP server over streamable HTTP; `http`: an HTTP API; `login`: a website agents sign in to in the browser
 * (VT-D28, contracts 0.20.0); `ssh`: an SSH key and the servers it opens (VT-S02, contracts 0.32.0); `secret`: one value
 * capability packs used. Since 0.113 (CT-823) no `secret` entry is made; existing ones stay listed and removable.
 */
export const VAULT_ENTRY_KINDS = ['mcp', 'http', 'login', 'ssh', 'secret'] as const;
export const VaultEntryKind = z.enum(VAULT_ENTRY_KINDS);
export type VaultEntryKind = z.infer<typeof VaultEntryKind>;

/**
 * The templates over the kinds: `basic` is `http` with basic auth (called `login` before contracts 0.20.0); `login` is
 * the `login` kind; `ssh` is the `ssh` kind; `secret` names an existing `secret` entry only, nothing makes one any more.
 * Add to Vault offers `VAULT_NEW_TEMPLATES`. Their labels are the kinds in a person's words — Connection,
 * Sign-in key, Password, Website login, Server key — so the web and the phone name an entry the same way.
 */
export const VAULT_TEMPLATES = ['mcp', 'token', 'basic', 'login', 'ssh', 'secret'] as const;
export const VaultTemplate = z.enum(VAULT_TEMPLATES);
export type VaultTemplate = z.infer<typeof VaultTemplate>;

/**
 * The templates Add to Vault offers (CT-823): every one but `secret`, which nothing makes any more, and `mcp`: an MCP
 * server is connected as a Custom MCP server in Connections (Whombat vault-simplify.md VLT-30). An `mcp` entry from
 * before stays readable.
 */
export const VAULT_NEW_TEMPLATES = [
  'token',
  'basic',
  'login',
  'ssh',
] as const satisfies readonly VaultTemplate[];

export interface VaultTemplateDef {
  kind: VaultEntryKind;
  label: string;
  description: string;
  /** How a new entry of this template signs in (null: no address, `secret` entries). */
  auth: VaultAuth['type'] | null;
}

export const VAULT_TEMPLATE_DEFS: Record<VaultTemplate, VaultTemplateDef> = {
  mcp: {
    kind: 'mcp',
    label: 'Connection',
    description: 'A service whose tools the agent can use, like Home Assistant.',
    auth: 'bearer',
  },
  token: {
    kind: 'http',
    label: 'Sign-in key',
    description: 'A key a service gave you, for the agent to use in your chats.',
    auth: 'bearer',
  },
  basic: {
    kind: 'http',
    label: 'Password',
    description: 'A username and password for an app or device the agent talks to.',
    auth: 'basic',
  },
  login: {
    kind: 'login',
    label: 'Website login',
    description: 'A website the agent signs in to in its browser. It never sees the password.',
    auth: 'form',
  },
  ssh: {
    kind: 'ssh',
    label: 'Server key',
    description: 'A key the agent uses to sign in to your servers, in your chats.',
    auth: 'ssh_key',
  },
  secret: {
    kind: 'secret',
    label: 'Secret',
    description: 'A single value kept for an older Whombat feature. Nothing uses it now.',
    auth: null,
  },
};

/** Header names an entry may never sign in with (VT-03), lowercase; `proxy-*` too. */
export const VAULT_FORBIDDEN_HEADER_NAMES: readonly string[] = [
  'host',
  'cookie',
  'content-length',
  'transfer-encoding',
  'connection',
];

/** Why a header name can't carry an entry's secret, or null. */
export function vaultHeaderNameProblem(name: string): string | null {
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name)) return 'Use 1–64 letters, digits and dashes.';
  const lower = name.toLowerCase();
  if (VAULT_FORBIDDEN_HEADER_NAMES.includes(lower) || lower.startsWith('proxy-'))
    return `${name} can’t carry a secret.`;
  return null;
}

export const VaultHeaderName = z.string().superRefine((name, ctx) => {
  const problem = vaultHeaderNameProblem(name);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

/** A basic-auth username: no colon (it separates the password) and no control characters. */
export const VaultUsername = z
  .string()
  .min(1)
  .max(VAULT_USERNAME_MAX)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
  .regex(/^[^:\u0000-\u001f\u007f]+$/, 'A username can’t hold a colon or control characters.');

/** The query parameter an entry's secret travels in (`?<name>=<secret>`). */
export const VaultQueryName = z
  .string()
  .regex(/^[A-Za-z0-9_.~-]{1,64}$/, 'Use 1–64 letters, digits, dots, dashes and underscores.');

/** The kinds of SSH key an `ssh` entry holds (VT-S03): generated keys are always `ed25519`. */
export const VAULT_SSH_KEY_TYPES = ['ed25519', 'rsa', 'ecdsa'] as const;
export const VaultSshKeyType = z.enum(VAULT_SSH_KEY_TYPES);
export type VaultSshKeyType = z.infer<typeof VaultSshKeyType>;

/** Where an `ssh` entry's key came from: made by Whombat (“Generate a new key”) or pasted (“Use my own key”). */
export const VAULT_SSH_KEY_ORIGINS = ['generated', 'imported'] as const;
export const VaultSshKeyOrigin = z.enum(VAULT_SSH_KEY_ORIGINS);
export type VaultSshKeyOrigin = z.infer<typeof VaultSshKeyOrigin>;

/** The OpenSSH public key algorithms each key type is written with (`ssh-ed25519 AAAA…`). */
export const VAULT_SSH_PUBLIC_KEY_ALGORITHMS: Record<VaultSshKeyType, readonly string[]> = {
  ed25519: ['ssh-ed25519'],
  rsa: ['ssh-rsa'],
  ecdsa: ['ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'],
};

/**
 * An OpenSSH public key line without a comment: `ssh-ed25519 AAAAC3Nza…` (the algorithm, one space, the base64 blob).
 * Public: shown to the person, pasted into `authorized_keys`.
 */
export const VaultSshPublicKey = z
  .string()
  .max(2000)
  .regex(
    /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) AAAA[A-Za-z0-9+/]+={0,2}$/,
    'Expected an OpenSSH public key line.',
  );

/** An SSH key fingerprint as `ssh-keygen -l` writes it: `SHA256:` and 43 characters of unpadded base64. */
export const VaultSshFingerprint = z
  .string()
  .regex(/^SHA256:[A-Za-z0-9+/]{43}$/, 'Expected a SHA256:… fingerprint.');

/**
 * How an entry signs in (VT-03). `bearer` is the default; `none` is only for an `mcp` entry on the home network that
 * needs no token; `form` is only for a `login` entry (VT-D28): Hermes's credential vault fills the username and the password
 * (the secret) into the sign-in page (CT-1240); `ssh_key` is only
 * for an `ssh` entry (VT-S02) and is written by the server alone (a client creates the key with `sshKey`): the public
 * half, its fingerprint and where it came from — the private half is the sealed secret.
 * `vaultEntryShapeProblems` enforces which kind takes which.
 */
export const VaultAuth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bearer') }),
  z.object({ type: z.literal('header'), name: VaultHeaderName }),
  z.object({ type: z.literal('basic'), username: VaultUsername }),
  z.object({ type: z.literal('query'), name: VaultQueryName }),
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('form'), username: VaultUsername }),
  z.object({
    type: z.literal('ssh_key'),
    keyType: VaultSshKeyType,
    /** The OpenSSH public key line, no comment. */
    publicKey: VaultSshPublicKey,
    fingerprint: VaultSshFingerprint,
    origin: VaultSshKeyOrigin,
  }),
]);
export type VaultAuth = z.infer<typeof VaultAuth>;
/** An `ssh` entry's `auth`. */
export type VaultSshKeyAuth = Extract<VaultAuth, { type: 'ssh_key' }>;
export type VaultAuthType = VaultAuth['type'];

/** A secret as it is set (write-only; never returned). */
export const VaultSecretValue = z.string().min(1).max(VAULT_SECRET_MAX);

export const VaultEntryName = z.string().trim().min(1).max(VAULT_NAME_MAX);
export const VaultEntryDescription = z.string().trim().max(VAULT_DESCRIPTION_MAX);
export const VaultUrl = z.string().trim().min(1).max(VAULT_URL_MAX);

/**
 * The template an entry reads as: `mcp` → MCP server, `login` → Login, `ssh` → SSH key, `http` with basic auth → Basic
 * auth, other `http` → API token (VT-D29).
 */
export function vaultTemplateOf(kind: VaultEntryKind, auth: Pick<VaultAuth, 'type'> | null): VaultTemplate {
  if (kind === 'mcp') return 'mcp';
  if (kind === 'secret') return 'secret';
  if (kind === 'login') return 'login';
  if (kind === 'ssh') return 'ssh';
  return auth?.type === 'basic' ? 'basic' : 'token';
}

/* The entry as the person sees it (VT-01, VT-70, VT-71) ------------------------------------------ */

/** The status dot and CONNECTION line: reached, failing, or not checked yet. */
export const VaultCheckStatus = z.enum(['reached', 'failing', 'unchecked']);
export type VaultCheckStatus = z.infer<typeof VaultCheckStatus>;

export const VaultCheck = z.object({
  status: VaultCheckStatus,
  /** “Reached · 12 tools”, “Reached · answered 200”, “Couldn’t reach it.”; '' while unchecked. */
  summary: z.string().max(300),
  checkedAt: Timestamp.nullable(),
  /** Tools the MCP server listed at the last check (null for `http` and unchecked entries). */
  toolCount: Count.nullable().default(null),
});
export type VaultCheck = z.infer<typeof VaultCheck>;

export const VaultSecretState = z.object({
  /** Whether a value is stored (never the value). False for an `mcp` entry that signs in with `none`. */
  set: z.boolean(),
  setAt: Timestamp.nullable(),
});
export type VaultSecretState = z.infer<typeof VaultSecretState>;

/** No authenticator key (`VaultEntry.totp`) or no kept password (`VaultSshServer.password`). */
export const VAULT_TOTP_UNSET: Readonly<VaultSecretState> = Object.freeze({ set: false, setAt: null });
/** A server whose commands sign in with the key alone (`VaultSshServer.password`). */
export const VAULT_SSH_PASSWORD_UNSET: Readonly<VaultSecretState> = VAULT_TOTP_UNSET;

/**
 * Where else an entry is kept in step (docs/decisions/onepassword-sync.md): today only a linked 1Password vault. An
 * enum rather than a literal, so an app meets a newer place as something it leaves out, not as a broken entry.
 */
export const VAULT_ENTRY_SOURCE_KINDS = ['onepassword'] as const;
export const VaultEntrySourceKind = z.enum(VAULT_ENTRY_SOURCE_KINDS);
export type VaultEntrySourceKind = z.infer<typeof VaultEntrySourceKind>;

/**
 * How the entry stands with that place: `synced` (both sides agree, since `syncedAt`), `pending` (a change waits for
 * the next pass, or the entry hasn't gone there yet), `problem` (the last pass couldn't keep it in step: `problem`
 * says why in the person's words).
 */
export const VAULT_ENTRY_SOURCE_STATES = ['synced', 'pending', 'problem'] as const;
export const VaultEntrySourceState = z.enum(VAULT_ENTRY_SOURCE_STATES);
export type VaultEntrySourceState = z.infer<typeof VaultEntrySourceState>;

export const VaultEntrySource = z.object({
  kind: VaultEntrySourceKind,
  state: VaultEntrySourceState,
  /** When both sides last agreed; null before the first time. */
  syncedAt: Timestamp.nullable(),
  /** The `problem` state's words (“This token can only read. …”); never a value of the entry. */
  problem: z.string().min(1).max(300).optional(),
});
export type VaultEntrySource = z.infer<typeof VaultEntrySource>;

/** An entry in YOUR ENTRIES. */
export const VaultEntry = z.object({
  id: VaultEntryId,
  name: z.string(),
  description: z.string(),
  kind: VaultEntryKind,
  /** The server's URL (`mcp`), the API's base URL (`http`) or the sign-in page (`login`); null for `ssh` and `secret`. */
  url: z.string().nullable(),
  /** Null for `secret`; `ssh_key` (the public half) for `ssh`. */
  auth: VaultAuth.nullable(),
  /** The password of a `login` entry, the private key of an `ssh` entry, the token of the others. */
  secret: VaultSecretState,
  /**
   * A `login` entry's authenticator key (3.14; Whombat vault-simplify.md): whether one is sealed beside
   * the password and since when, never the key. Set on `vault.create` (`totp`), on the card, or by `vault.setTotp`; the
   * runner's logins service gives Hermes the current code from it. Always unset for the other kinds.
   */
  totp: VaultSecretState.default(() => ({ ...VAULT_TOTP_UNSET })),
  /** For an `ssh` entry, its servers' checks taken together (`vaultSshEntryCheck`). */
  check: VaultCheck,
  /** The entry is switched on for the agent (`mcp`, `http`, `login`, `ssh`; OA-09). */
  agentOn: z.boolean(),
  /** Servers of an `ssh` entry (0 for the other kinds). */
  serverCount: Count.default(0),
  /**
   * An `mcp` entry Whombat couldn't move to a Custom MCP server connection (Whombat vault-simplify.md VLT-30: the
   * 50-connection limit, or a sign-in Custom MCP server lacks): it keeps working, and its page says “Move it to
   * Connections”. False for every other entry.
   */
  moveToConnections: z.boolean().default(false),
  /**
   * Kept in step with a vault elsewhere (a linked 1Password vault): its row's tag and its page's line. Absent: a
   * Whombat-only entry, or an older runtime.
   */
  source: VaultEntrySource.optional(),
  lastUsedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type VaultEntry = z.infer<typeof VaultEntry>;

/**
 * A tool of an MCP entry (VT-44): on or off; a new or changed tool is off with the “New” badge. Hermes gets only the ones
 * that are on (CT-1241).
 */
export const VaultTool = z.object({
  /** The server's own tool name (`HassTurnOn`). */
  name: z.string().min(1).max(200),
  description: z.string(),
  enabled: z.boolean(),
  isNew: z.boolean(),
  /** The tool's definition hash (`vaultToolHash`); a changed hash is a new tool. */
  hash: z.string(),
});
export type VaultTool = z.infer<typeof VaultTool>;

/**
 * The servers a key to an `ssh` entry covers (VT-S07): null is **All servers** (the default, servers added later
 * included), a list is only those — empty once every server it listed was removed (it then covers none). Always null
 * for the other kinds. Bodies take `VaultKeyServersChoice` (at least one).
 */
export const VaultKeyServers = z
  .array(VaultSshServerId)
  .max(VAULT_SSH_SERVERS_MAX)
  .refine((ids) => new Set(ids).size === ids.length, 'List each server once.')
  .nullable();
export type VaultKeyServers = z.infer<typeof VaultKeyServers>;

/** The Servers chooser's answer: All servers (null) or at least one server, each once. */
export const VaultKeyServersChoice = z
  .array(VaultSshServerId)
  .min(1, 'Choose at least one server, or All servers.')
  .max(VAULT_SSH_SERVERS_MAX)
  .refine((ids) => new Set(ids).size === ids.length, 'List each server once.')
  .nullable();

/**
 * The entry switched on for the agent (OA-09; since 0.125 without a tier or a delivery, CT-1240): when, which servers of
 * an `ssh` entry, and the environment variable an `http` entry's value is in for the agent's commands during the person's
 * turns (`CLOUDFLARE_API_TOKEN`; basic auth `<NAME>_USERNAME` and `<NAME>_PASSWORD`). `envName` is null for the other
 * kinds: an SSH key is a file there, a login goes to Hermes's credential vault, an MCP server to Hermes's list.
 */
export const VaultKeyView = z.object({
  givenAt: Timestamp,
  servers: VaultKeyServers,
  envName: z.string().nullable(),
});
export type VaultKeyView = z.infer<typeof VaultKeyView>;

/** How one use ended (VT-52). */
export const VAULT_USE_OUTCOMES = ['done', 'failed', 'refused', 'timed_out'] as const;
export const VaultUseOutcome = z.enum(VAULT_USE_OUTCOMES);
export type VaultUseOutcome = z.infer<typeof VaultUseOutcome>;

/** The words an outcome shows as (“· done”). */
export const VAULT_USE_OUTCOME_LABELS: Record<VaultUseOutcome, string> = {
  done: 'done',
  failed: 'failed',
  refused: 'refused',
  timed_out: 'timed out',
};

/**
 * One use of an entry (`vault_uses`, VT-52): RECENT USE and the person's audit detail. Since 0.125 (CT-1244)
 * one per turn of the person's the entry reached the agent in: `done` it was there, `refused` it couldn't be (an address
 * no longer allowed, a host key that changed), `failed` something else went wrong.
 */
export const VaultUse = z.object({
  id: VaultUseId,
  entryId: VaultEntryId,
  agentId: PrincipalId,
  /** The person the turn was for. */
  requesterId: PrincipalId.nullable(),
  dispatchId: DispatchId.nullable(),
  /** Where it was in that turn (`vaultTurnUseWhat`): “in Dusty’s commands for this turn”. */
  what: z.string().max(300),
  outcome: VaultUseOutcome,
  at: Timestamp,
  /** The signed `vault.used` / `vault.refused` event. */
  eventId: EventId.nullable(),
});
export type VaultUse = z.infer<typeof VaultUse>;

/** How a check ended (VT-44). */
export const VAULT_CHECK_OUTCOMES = [
  /** It answered: MCP initialised and listed tools, or HTTP answered below 400 (or any status but 401/403). */
  'reached',
  /** 401 or 403: the server rejected the secret. */
  'rejected',
  /** Nothing answered (DNS, refused, TLS). */
  'unreachable',
  'timeout',
  /** The destination rules refused the address (`vaultDestinationProblem`). */
  'not_allowed',
  /** It answered, but not as an MCP server (an `mcp` entry) or an SSH server (an `ssh` server). */
  'bad_answer',
  /** An `ssh` server showed a host key nobody confirmed yet: the person compares and trusts it (VT-S05). */
  'host_key_unconfirmed',
  /** An `ssh` server showed a different host key than the one trusted: agents are refused until it is trusted. */
  'host_key_changed',
] as const;
export const VaultCheckOutcome = z.enum(VAULT_CHECK_OUTCOMES);
export type VaultCheckOutcome = z.infer<typeof VaultCheckOutcome>;

/** A TCP port (home networks, SSH servers). */
export const VaultPort = z.number().int().min(1).max(65535);

/* SSH servers (VT-S04, VT-S05) ------------------------------------------------------------------ */

/** A host key a server showed: its algorithm (`ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`) and fingerprint. */
export const VaultSshHostKey = z.object({
  algorithm: z.string().min(1).max(64),
  fingerprint: VaultSshFingerprint,
});
export type VaultSshHostKey = z.infer<typeof VaultSshHostKey>;

/** A server's status dot and check line (VT-S05). */
export const VaultSshServerCheck = z.object({
  /** `unchecked` too while its host key waits for the person (`host_key_unconfirmed`). */
  status: VaultCheckStatus,
  /** How the last check ended; null before the first. */
  outcome: VaultCheckOutcome.nullable(),
  /** `vaultSshCheckSummary`: “Signed in as deploy”, “Host key not confirmed yet”, “The server refused the key.”. */
  summary: z.string().max(300),
  checkedAt: Timestamp.nullable(),
});
export type VaultSshServerCheck = z.infer<typeof VaultSshServerCheck>;

/**
 * A server an `ssh` entry's key signs in to (VT-S04), as the person sees it. `hostKey` is the trusted (pinned) key every
 * connection verifies; `seenHostKey` is a key the last check saw that isn't trusted — unknown (`host_key_unconfirmed`)
 * or different from the pinned one (`host_key_changed`) — and is what “Trust this server” confirms.
 */
export const VaultSshServer = z.object({
  id: VaultSshServerId,
  /** The handle agents use: 1–40, `^[A-Za-z0-9][A-Za-z0-9._-]*$`, unique per entry ignoring case (CT-319). */
  name: z.string().min(1).max(VAULT_SSH_SERVER_NAME_MAX),
  /** Lowercase host name, dotted IPv4, or IPv6 without brackets. */
  host: z.string().min(1).max(VAULT_SSH_HOST_MAX),
  port: VaultPort,
  username: z.string().min(1).max(VAULT_SSH_USERNAME_MAX),
  /**
   * Production (agent-computer.md AC-11, 0.36.0): the agent's commands can't reach its addresses until the person says yes to
   * a command (an approved `run_command` opens it).
   */
  production: z.boolean().default(false),
  /**
   * The server's kept password (3.14; Whombat vault-simplify.md): whether one is
   * sealed with this server and since when, never the value. Set: the commands sign in to it with the password (for
   * servers that don't take keys). Only the `server` card sets it.
   */
  password: VaultSecretState.default(() => ({ ...VAULT_SSH_PASSWORD_UNSET })),
  hostKey: VaultSshHostKey.extend({ trustedAt: Timestamp }).nullable(),
  seenHostKey: VaultSshHostKey.extend({ seenAt: Timestamp }).nullable(),
  check: VaultSshServerCheck,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type VaultSshServer = z.infer<typeof VaultSshServer>;

/** The answer of a server's Check or of “Trust this server” (VT-S05). */
export const VaultSshCheckResult = z.object({
  serverId: VaultSshServerId,
  outcome: VaultCheckOutcome,
  status: VaultCheckStatus,
  /** `vaultSshCheckSummary`. */
  summary: z.string().max(300),
  /** The host key the server showed (null when it showed none: unreachable, refused). */
  hostKey: VaultSshHostKey.nullable(),
  checkedAt: Timestamp,
});
export type VaultSshCheckResult = z.infer<typeof VaultSshCheckResult>;

/** An entry with everything the person manages on it (VT-71). */
export const VaultEntryDetail = VaultEntry.extend({
  /** `mcp` only, in the server's order; at most `VAULT_TOOLS_MAX`. */
  tools: z.array(VaultTool),
  /** Tools the server listed beyond `VAULT_TOOLS_MAX` (ignored). */
  toolsIgnored: Count.default(0),
  /** The agent's key: null while the entry is off for the agent. */
  key: VaultKeyView.nullable(),
  /** Newest first, at most `VAULT_RECENT_USES`. */
  recentUses: z.array(VaultUse),
  /** `ssh` only: its servers by name, at most `VAULT_SSH_SERVERS_MAX` (VT-S04). Empty for the other kinds. */
  servers: z.array(VaultSshServer).default([]),
});
export type VaultEntryDetail = z.infer<typeof VaultEntryDetail>;

/** The answer of “Check connection”. */
export const VaultCheckResult = z.object({
  outcome: VaultCheckOutcome,
  status: VaultCheckStatus.exclude(['unchecked']),
  /** `vaultCheckSummary`. */
  summary: z.string().max(300),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  toolCount: Count.nullable(),
  checkedAt: Timestamp,
});
export type VaultCheckResult = z.infer<typeof VaultCheckResult>;

/* The home network list (VT-12) ----------------------------------------------------------------- */

/** A network entries may reach: instance-level, readable by everyone, changed by admins only. */
export const VaultNetwork = z.object({
  id: VaultNetworkId,
  /** Canonical CIDR (`192.168.1.0/24`, `fd12:3456:789a::/48`). */
  cidr: z.string().max(60),
  /** Ascending, 1–16. */
  ports: z.array(VaultPort).min(1).max(VAULT_NETWORK_PORTS_MAX),
  note: z.string().max(VAULT_NETWORK_NOTE_MAX),
  /** Who added it: their name. */
  addedBy: z.string(),
  addedAt: Timestamp,
});
export type VaultNetwork = z.infer<typeof VaultNetwork>;

/* The person's detail on audit events and approvals (VT-52, VT-72) --------------------------------- */

/**
 * `AuditEvent.vault`: the person's detail of a Vault event, filled only for the person on `audit.list`,
 * `audit.get`, `audit.export` and `audit.appended`. Never signed: the signed text is neutral (VT-51).
 */
export const AuditVaultDetail = z.object({
  entryId: VaultEntryId,
  entryName: z.string(),
  /** A use's tool or `METHOD /path` (null for entry and key events). */
  what: z.string().max(300).nullable(),
  /** A use's outcome (null for entry and key events). */
  outcome: VaultUseOutcome.nullable(),
});
export type AuditVaultDetail = z.infer<typeof AuditVaultDetail>;
