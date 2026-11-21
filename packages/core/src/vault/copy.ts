/**
 * The Vault's words (docs/decisions/vault.md VT-51, VT-52, VT-70…VT-72). Signed audit text stays neutral — “a private
 * Vault entry”, never a name, tool, path or status (a log can be read by support with remote help on) — and only the
 * person's views add the detail.
 */
import type { MessageVaultSave } from '../domain/message.js';
import { type DateInput, formatAgo, formatRecent, toDate } from '../text/time.js';
import { vaultEntryAddress } from './network.js';
import { VAULT_FAILURE_TEXT } from './request.js';
import {
  type AuditVaultDetail,
  VAULT_TEMPLATE_DEFS,
  VAULT_USE_OUTCOME_LABELS,
  type VaultAuth,
  type VaultCheck,
  type VaultCheckOutcome,
  type VaultCheckStatus,
  type VaultEntry,
  type VaultEntryKind,
  type VaultSshHostKey,
  type VaultSshKeyType,
  type VaultSshServer,
  type VaultTemplate,
  type VaultUse,
  vaultTemplateOf,
} from './schemas.js';
import { vaultSshHostKeyFile, vaultSshHostKeyLabel } from './ssh.js';

/** How every signed text names an entry. */
export const VAULT_PRIVATE_ENTRY = 'a private Vault entry';

/** Page and section copy (VT-70…VT-73). */
export const VAULT_COPY = {
  title: 'Vault',
  intro:
    'What the agent can sign in to when it works for you. Only you can see these, and only your own chats use them.',
  entries: 'YOUR ENTRIES',
  noEntries: 'Nothing in your Vault yet.',
  add: 'Add to Vault',
  homeNetwork: 'HOME NETWORK',
  homeNetworkIntro:
    'When the agent may not reach your whole local network, it reaches only these networks and ports.',
  noNetworks: 'No home networks listed.',
  descriptionLabel: 'What should the agent know?',
  secret: 'SECRET',
  connection: 'CONNECTION',
  tools: 'TOOLS',
  keys: 'AGENT',
  recentUse: 'RECENT USE',
  manage: 'Manage in your Vault →',
  keysNote: (agentName: string) => `${agentName} uses it only when it works for you.`,
  replace: 'Replace',
  checkAgain: 'Check again',
  newBadge: 'New',
  remove: 'Remove from Vault',
  notSet: 'Not set',
  notChecked: 'Not checked yet',
  queryWarning: 'Query strings end up in server logs. Use a header if the service allows it.',
  httpWarning: 'This address uses http: the secret crosses your network unencrypted.',
  secretsOnWeb: 'Secrets are set on the web, in the Vault.',
  toolsIgnored: (n: number) =>
    `${n} more ${n === 1 ? 'tool was' : 'tools were'} ignored: an entry keeps at most 64.`,
  setBy: (name: string) => `Set by ${name}`,
} as const;

/* Signed audit text (VT-51) --------------------------------------------------------------------- */

/** Every Vault audit line. */
export const VAULT_AUDIT_TEXTS = [
  'entry.added',
  'entry.changed',
  'entry.secret_replaced',
  'entry.removed',
  'key.given',
  'key.changed',
  'key.taken',
  'used',
  'refused',
  /** 0.112.0 (CT-784; Whombat vault-self-serve.md VS-07): the agent saved an entry for the person a turn is for. */
  'entry.saved',
] as const;
export type VaultAuditTextKind = (typeof VAULT_AUDIT_TEXTS)[number];

/** The event type each text is signed as. */
export const VAULT_AUDIT_EVENT_TYPES = {
  'entry.added': 'vault.entry.added',
  'entry.changed': 'vault.entry.changed',
  'entry.secret_replaced': 'vault.entry.secret_replaced',
  'entry.removed': 'vault.entry.removed',
  'key.given': 'vault.key.given',
  'key.changed': 'vault.key.changed',
  'key.taken': 'vault.key.taken',
  used: 'vault.used',
  refused: 'vault.refused',
  'entry.saved': 'vault.entry.saved',
} as const satisfies Record<VaultAuditTextKind, string>;

/**
 * The neutral, signed text of a Vault event (VT-51): “Switched on a private Vault entry for Dusty”, “Used a private Vault
 * entry”. `agentName` is the agent a key event is about.
 */
export function vaultAuditText(kind: VaultAuditTextKind, ctx: { agentName?: string } = {}): string {
  const agent = ctx.agentName ?? 'the agent';
  switch (kind) {
    case 'entry.added':
      return `Added ${VAULT_PRIVATE_ENTRY}`;
    case 'entry.changed':
      return `Changed ${VAULT_PRIVATE_ENTRY}`;
    case 'entry.secret_replaced':
      return `Replaced the secret of ${VAULT_PRIVATE_ENTRY}`;
    case 'entry.removed':
      return `Removed ${VAULT_PRIVATE_ENTRY}`;
    case 'key.given':
      return `Switched on ${VAULT_PRIVATE_ENTRY} for ${agent}`;
    case 'key.changed':
      return `Changed how ${agent} uses ${VAULT_PRIVATE_ENTRY}`;
    case 'key.taken':
      return `Switched off ${VAULT_PRIVATE_ENTRY} for ${agent}`;
    case 'used':
      return `Used ${VAULT_PRIVATE_ENTRY}`;
    case 'refused':
      return `Couldn’t use ${VAULT_PRIVATE_ENTRY}`;
    case 'entry.saved':
      return `Saved ${VAULT_PRIVATE_ENTRY}`;
  }
}

/**
 * The person's line for a Vault event that carries the detail (VT-52): the neutral text with the entry named, and for a
 * use what it was and how it ended — “Used “Home Assistant” · HassTurnOn · done”. Null without detail.
 */
export function vaultAuditDetailText(event: {
  text: string | null;
  vault?: AuditVaultDetail | null | undefined;
}): string | null {
  const detail = event.vault;
  if (!detail) return null;
  const named = (event.text ?? '').includes(VAULT_PRIVATE_ENTRY)
    ? (event.text ?? '').replace(VAULT_PRIVATE_ENTRY, `“${detail.entryName}”`)
    : `“${detail.entryName}”`;
  return [named, detail.what, detail.outcome ? VAULT_USE_OUTCOME_LABELS[detail.outcome] : null]
    .filter((p): p is string => !!p)
    .join(' · ');
}

/* The person's views (VT-70, VT-71) ------------------------------------------------------------- */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What kind of entry it is, in a person's words (“Connection”, “Sign-in key”, “Password”, “Website login”, “Server
 * key”, “Secret”): the template's label, the same on the web and the phone.
 */
export function vaultEntryLabel(entry: {
  kind: VaultEntryKind;
  auth: Pick<VaultAuth, 'type'> | null;
}): string {
  return VAULT_TEMPLATE_DEFS[vaultTemplateOf(entry.kind, entry.auth)].label;
}

/** A template's description with the agent by its name (“A website Dusty signs in to in its browser. …”). */
export function vaultTemplateDescription(template: VaultTemplate, agentName: string): string {
  return VAULT_TEMPLATE_DEFS[template].description.split('the agent').join(agentName);
}

/**
 * The card's meta line: “Connection · 192.168.1.10:8123 · on for Dusty”, “Password · 192.168.1.20 · off for Dusty”,
 * “Server key · 3 servers · on for Dusty”, “Secret · nothing uses it”. The key's algorithm is the entry's
 * technical detail, not the card's.
 */
export function vaultEntryMeta(
  entry: Pick<VaultEntry, 'kind' | 'auth' | 'url' | 'agentOn'> & { serverCount?: number },
  agentName: string,
): string {
  const label = vaultEntryLabel(entry);
  const agent = `${entry.agentOn ? 'on' : 'off'} for ${agentName}`;
  if (entry.kind === 'ssh') {
    const servers = entry.serverCount ?? 0;
    return [label, vaultSshServerCount(servers), agent].join(' · ');
  }
  if (entry.kind === 'secret') return `${label} · nothing uses it`;
  return [label, entry.url ? vaultEntryAddress(entry.url) : null, agent].filter(Boolean).join(' · ');
}

const vaultSshServerCount = (n: number) => (n === 0 ? 'no servers' : plural(n, 'server', 'servers'));

/**
 * The card's quieter line: where the entry points (“192.168.1.10:8123”) or how many servers a key has (“2 servers”);
 * null for an old `secret` entry.
 */
export function vaultEntryWhere(
  entry: Pick<VaultEntry, 'kind' | 'url'> & { serverCount?: number },
): string | null {
  if (entry.kind === 'ssh') return vaultSshServerCount(entry.serverCount ?? 0);
  return entry.url ? vaultEntryAddress(entry.url) : null;
}

/**
 * Why a failing entry's dot is red, in words, from what its last check reported (`check.summary`, written by
 * `vaultCheckSummary` and `vaultSshEntryCheck`): “The password stopped working.”, “Whombat can’t reach it right now.”,
 * “One of its servers isn’t working.”. Null unless the entry is failing.
 */
export function vaultEntryProblem(entry: {
  kind: VaultEntryKind;
  auth: Pick<VaultAuth, 'type'> | null;
  check: Pick<VaultCheck, 'status' | 'summary'>;
}): string | null {
  if (entry.check.status !== 'failing') return null;
  const summary = entry.check.summary.trim();
  if (summary.startsWith('The server rejected the secret'))
    return entry.auth?.type === 'basic' || entry.auth?.type === 'form'
      ? 'The password stopped working.'
      : 'The sign-in key stopped working.';
  if (summary === VAULT_FAILURE_TEXT.unreachable) return 'Whombat can’t reach it right now.';
  if (summary === VAULT_FAILURE_TEXT.timeout) return 'It didn’t answer in time.';
  if (summary.startsWith('Not allowed:')) return 'Whombat isn’t allowed to reach its address.';
  if (summary.startsWith('It answered, but not as')) return 'It answered, but not the way Whombat expected.';
  if (entry.kind === 'ssh') {
    const several = /^(\d+) of \d+ servers failing$/.exec(summary);
    if (several) {
      const n = Number(several[1]);
      return n === 1 ? 'One of its servers isn’t working.' : `${n} of its servers aren’t working.`;
    }
    if (summary === VAULT_FAILURE_TEXT.rejected) return 'The server didn’t take the key.';
    if (/host key changed|look like the same server/.test(summary))
      return 'The server doesn’t look like the same server any more.';
  }
  return summary || null;
}

/**
 * What a check reports (VT-44): “Reached · 12 tools”, “Reached · answered 200”, “The server rejected the secret
 * (401).”, “Couldn’t reach it.”, “Not allowed: …”.
 */
export function vaultCheckSummary(
  outcome: VaultCheckOutcome,
  facts: {
    kind: VaultEntryKind;
    toolCount?: number | null;
    httpStatus?: number | null;
    reason?: string;
    /** `ssh`: the user it signed in as. */
    username?: string;
  },
): string {
  if (facts.kind === 'ssh')
    return vaultSshCheckSummary(outcome, {
      ...(facts.username !== undefined ? { username: facts.username } : {}),
      ...(facts.reason !== undefined ? { reason: facts.reason } : {}),
    });
  switch (outcome) {
    case 'reached':
      return facts.kind === 'mcp'
        ? `Reached · ${plural(facts.toolCount ?? 0, 'tool', 'tools')}`
        : `Reached · answered ${facts.httpStatus ?? 200}`;
    case 'rejected':
      return `The server rejected the secret${facts.httpStatus ? ` (${facts.httpStatus})` : ''}.`;
    case 'unreachable':
      return VAULT_FAILURE_TEXT.unreachable;
    case 'timeout':
      return VAULT_FAILURE_TEXT.timeout;
    case 'not_allowed':
      return `Not allowed: ${facts.reason ?? 'this address isn’t allowed.'}`;
    case 'bad_answer':
      return 'It answered, but not as an MCP server.';
    case 'host_key_unconfirmed':
    case 'host_key_changed':
      return vaultSshCheckSummary(outcome);
  }
}

/** CONNECTION: “Checked 3 min ago · Reached · 12 tools”, or “Not checked yet”. */
export function vaultCheckLine(check: VaultCheck, now: DateInput, timeZone: string): string {
  if (check.status === 'unchecked' || !check.checkedAt) return VAULT_COPY.notChecked;
  return `Checked ${formatAgo(check.checkedAt, now, timeZone)} · ${check.summary}`;
}

/** SECRET: “Set · replaced 2 days ago”, “Set · added just now”, “Not set”. */
export function vaultSecretLine(
  entry: Pick<VaultEntry, 'secret' | 'createdAt'>,
  now: DateInput,
  timeZone: string,
): string {
  const { set, setAt } = entry.secret;
  if (!set || !setAt) return VAULT_COPY.notSet;
  const replaced = toDate(setAt).getTime() - toDate(entry.createdAt).getTime() > 1000;
  return `Set · ${replaced ? 'replaced' : 'added'} ${formatAgo(setAt, now, timeZone)}`;
}

/**
 * What one turn's use of an entry records as `what` (0.125, CT-1244; since 3.0 CT-1532): where the entry was for that
 * turn — “in Dusty’s commands for this turn” (an API's value, an SSH key), “in Dusty’s browser for this turn” (a website
 * login), “in Dusty’s tools for this turn” (an MCP server).
 */
export function vaultTurnUseWhat(kind: VaultEntryKind, agentName: string): string {
  if (kind === 'login') return `in ${agentName}’s browser for this turn`;
  if (kind === 'mcp') return `in ${agentName}’s tools for this turn`;
  return `in ${agentName}’s commands for this turn`;
}

/** A use's outcome: “done”, “failed”, “refused”, “timed out”. */
export function vaultUseOutcomeText(use: Pick<VaultUse, 'outcome'>): string {
  return VAULT_USE_OUTCOME_LABELS[use.outcome];
}

/**
 * A RECENT USE row (VT-71): agent · what · when · outcome (“Dusty · in Dusty’s commands … · done”); since 3.0 (CT-1511)
 * without “for whom”: every use is for the person.
 */
export function vaultUseRow(
  use: VaultUse,
  ctx: {
    names: (principalId: string) => { shortName: string } | undefined;
    now: DateInput;
    timeZone: string;
  },
): { agent: string; what: string; when: string; outcome: string; line: string } {
  const agent = ctx.names(use.agentId)?.shortName ?? 'The agent';
  const when = formatRecent(use.at, ctx.now, ctx.timeZone);
  const outcome = vaultUseOutcomeText(use);
  const what = use.what;
  return {
    agent,
    what,
    when,
    outcome,
    line: [agent, what, when, outcome].join(' · '),
  };
}

/** When the entry was last used, for a card (“Used 10:48”), or null. */
export function vaultLastUsedText(
  lastUsedAt: string | null,
  now: DateInput,
  timeZone: string,
): string | null {
  return lastUsedAt ? `Used ${formatRecent(lastUsedAt, now, timeZone)}` : null;
}

/* SSH keys (VT-S05, VT-S12, VT-S13) -------------------------------------------------------------- */

/** How a key type is written: “ED25519”, “RSA”, “ECDSA” (as `ssh-keygen -l` does). */
export const VAULT_SSH_KEY_TYPE_LABELS: Record<VaultSshKeyType, string> = {
  ed25519: 'ED25519',
  rsa: 'RSA',
  ecdsa: 'ECDSA',
};

/** The `ssh` entry's form and detail (VT-S13). */
export const VAULT_SSH_COPY = {
  /** The form's segmented control, and the import fields. */
  key: 'Key',
  generate: 'Generate a new key',
  useOwn: 'Use my own key',
  privateKey: 'Private key',
  passphrase: 'Passphrase (if it has one)',
  generateHint: 'Whombat makes the key. Its private half never leaves this Whombat.',
  passphraseHint: 'Used once to open the key. Whombat doesn’t keep it.',
  /** PUBLIC KEY. */
  publicKey: 'PUBLIC KEY',
  authorizedKeysHint:
    'Add this line to ~/.ssh/authorized_keys for the user the agent signs in as, on every server below.',
  copy: 'Copy',
  copied: 'Copied',
  generateNew: 'Generate a new key',
  replaceOwn: 'Replace with my own key',
  replaceWarning: 'The old key stops working on every server at once. The servers and their host keys stay.',
  /** SERVERS. */
  servers: 'SERVERS',
  noServers: 'No servers yet. Add the servers this key signs in to.',
  addServer: 'Add server',
  editServer: 'Edit server',
  serverName: 'Name',
  serverNameHint: 'The agent uses this name, like web-1.',
  host: 'Host',
  port: 'Port',
  username: 'Username',
  check: 'Check',
  edit: 'Edit',
  remove: 'Remove',
  removeServer: 'Remove this server? The agent can’t reach it with this key any more.',
  hostChangeNote: 'Changing the host or port forgets its trusted host key.',
  /** The trust card: its question is `vaultSshTrustQuestion`, the fingerprint is under Technical details. */
  trustQuestion: 'Is this your server?',
  trust: 'Yes, trust it',
  hostKeyUnconfirmed: 'Not trusted yet',
  hostKeyChanged: 'It doesn’t look like the same server any more. Check it before the agent uses it again.',
  /** The agent's key. */
  serversChooser: 'Servers',
  allServers: 'All servers',
  /** Android (VT-S13). */
  sshOnWeb: 'SSH keys and servers are set up on the web, in the Vault.',
} as const;

/** A server's check line in the words of its last check (VT-S05). */
export function vaultSshCheckSummary(
  outcome: VaultCheckOutcome,
  facts: { username?: string; reason?: string } = {},
): string {
  switch (outcome) {
    case 'reached':
      return facts.username ? `Signed in as ${facts.username}` : 'Signed in';
    case 'host_key_unconfirmed':
      return VAULT_SSH_COPY.hostKeyUnconfirmed;
    case 'host_key_changed':
      return VAULT_SSH_COPY.hostKeyChanged;
    case 'rejected':
      return VAULT_FAILURE_TEXT.rejected;
    case 'unreachable':
      return VAULT_FAILURE_TEXT.unreachable;
    case 'timeout':
      return VAULT_FAILURE_TEXT.timeout;
    case 'not_allowed':
      return `Not allowed: ${facts.reason ?? 'this address isn’t allowed.'}`;
    case 'bad_answer':
      return 'It answered, but not as an SSH server.';
  }
}

/**
 * The status dot a server's check outcome gives: signed in → reached; a host key waiting for its first trust →
 * unchecked (nothing is wrong yet); everything else, a changed host key included → failing.
 */
export function vaultSshCheckStatus(outcome: VaultCheckOutcome): VaultCheckStatus {
  if (outcome === 'reached') return 'reached';
  if (outcome === 'host_key_unconfirmed') return 'unchecked';
  return 'failing';
}

/**
 * A server's check line: “Checked 3 min ago · Signed in as deploy”, or “Not checked yet”. A host key waiting or
 * changed reads in today's words whatever words the check was stored with.
 */
export function vaultSshServerCheckLine(
  server: Pick<VaultSshServer, 'check'>,
  now: DateInput,
  timeZone: string,
): string {
  if (!server.check.checkedAt) return VAULT_COPY.notChecked;
  const { outcome, summary } = server.check;
  const said =
    outcome === 'host_key_unconfirmed' || outcome === 'host_key_changed'
      ? vaultSshCheckSummary(outcome)
      : summary;
  return `Checked ${formatAgo(server.check.checkedAt, now, timeZone)} · ${said}`;
}

/**
 * The one question a server whose key isn't trusted asks, in words: “Is staging the server at staging.example.com?”,
 * or for a key that changed “web-1 at web1.example.com doesn’t look like the server Whombat knew. Did you set it up
 * again or replace it?”; the answer is `VAULT_SSH_COPY.trust` (“Yes, trust it”). The fingerprint and how to compare it
 * (`vaultSshTrustCopy`) are its technical details.
 */
export function vaultSshTrustQuestion(
  server: Pick<VaultSshServer, 'name' | 'host' | 'port'>,
  changed: boolean,
): string {
  const host = server.host.includes(':') ? `[${server.host}]` : server.host;
  const where = server.port === 22 ? host : `${host}:${server.port}`;
  return changed
    ? `${server.name} at ${where} doesn’t look like the server Whombat knew. Did you set it up again or replace it?`
    : `Is ${server.name} the server at ${where}?`;
}

/**
 * The trust card (VT-S13): “Is this your server? SHA256:… (ED25519). Compare it with `ssh-keygen -lf
 * /etc/ssh/ssh_host_ed25519_key.pub` on the server.” In parts, so the command can be set as code; `text` is the whole
 * sentence without code marks.
 */
export function vaultSshTrustCopy(hostKey: Pick<VaultSshHostKey, 'algorithm' | 'fingerprint'>): {
  question: string;
  fingerprint: string;
  compare: string;
  command: string;
  after: string;
  text: string;
  action: string;
} {
  const fingerprint = `${hostKey.fingerprint} (${vaultSshHostKeyLabel(hostKey.algorithm)}).`;
  const command = `ssh-keygen -lf ${vaultSshHostKeyFile(hostKey.algorithm)}`;
  const parts = {
    question: VAULT_SSH_COPY.trustQuestion,
    fingerprint,
    compare: 'Compare it with',
    command,
    after: 'on the server.',
  };
  return {
    ...parts,
    text: `${parts.question} ${parts.fingerprint} ${parts.compare} ${parts.command} ${parts.after}`,
    action: VAULT_SSH_COPY.trust,
  };
}

/** A key's servers in its row (“All servers”, “web-1, nas”). Unknown ids (removed servers) are left out. */
export function vaultKeyServersText(
  servers: readonly string[] | null | undefined,
  entryServers: readonly Pick<VaultSshServer, 'id' | 'name'>[],
): string {
  if (servers === null || servers === undefined) return VAULT_SSH_COPY.allServers;
  const names = entryServers.filter((s) => servers.includes(s.id)).map((s) => s.name);
  return names.length ? names.join(', ') : 'No servers';
}

/* The agent runs a person's Vault in their turn (0.112.0, Whombat vault-self-serve.md VS-04…VS-13; OA-10) -------- */

/** The switch on an entry for the agent (CT-786; since 0.125 on or off, CT-1240; VS-03; OA-09), in its order. */
export const VAULT_AGENT_ACCESS = ['on', 'off'] as const;
export type VaultAgentAccess = (typeof VAULT_AGENT_ACCESS)[number];

/**
 * The one row an entry shows for the agent (CT-786, CT-1240; VS-03; OA-09): “Dusty can use this”, On / Off, and the line
 * under the chosen one.
 */
export function vaultAgentAccessCopy(agentName: string): {
  title: string;
  choices: Record<VaultAgentAccess, string>;
  hints: Record<VaultAgentAccess, string>;
} {
  return {
    title: `${agentName} can use this`,
    choices: { on: 'On', off: 'Off' },
    hints: {
      on: `${agentName} uses it when it works for you, never for anyone else.`,
      off: `${agentName} can’t use it.`,
    },
  };
}

/**
 * The Vault intro's line (CT-786; VS-08), `{agent}` the agent's name (`vaultSavedIntro` fills it in): what saving from
 * chat does, and the one thing it can't undo.
 */
export const VAULT_SAVED_INTRO =
  'When you send {agent} a password in your chat, it keeps it here and hides it in your message. The AI service it runs on has still seen that one message.';

/** `VAULT_SAVED_INTRO` with the agent's name. */
export function vaultSavedIntro(agentName: string): string {
  return VAULT_SAVED_INTRO.split('{agent}').join(agentName);
}

/**
 * The line under a message for each `vaultSaved` item (CT-783; VS-07, VS-11): “Saved to your Vault · Plex”, “Used once
 * to put “Servers” on web-1, not kept”.
 */
export function vaultSavedLine(save: Pick<MessageVaultSave, 'name' | 'how' | 'server'>): string {
  if (save.how === 'used_once')
    return `Used once to put “${save.name}” on ${save.server ?? 'a server'}, not kept`;
  return `Saved to your Vault · ${save.name}`;
}

/* Entries off for the agent (0.33.0, Whombat vault.md VT-G01…VT-G05) ---------------------------------------------- */

/**
 * The last line of an entry that is off for the agent (VT-G03, VS-13): “John switched you off for it: they can switch
 * “Dusty can use this” back on in the Vault → “Server Access Key”.” `entryName` is entry text: pass it already defused
 * for the prompt (BP-07).
 */
export function vaultUnheldAskLine(facts: {
  personFirstName: string;
  entryName: string;
  agentName: string;
}): string {
  return `${facts.personFirstName} switched you off for it: they can switch “${vaultAgentAccessCopy(facts.agentName).title}” back on in the Vault → “${facts.entryName}”.`;
}

/* Keys for the agent's commands (0.36.0, Whombat agent-computer.md AC-30…AC-34; since 3.0 CT-1532) --------------- */

/**
 * How an entry reaches the agent in your chats (AC-31, AC-34; CT-1240), by kind (`VAULT_COMPUTER_COPY` until 3.0):
 * the agent's commands on your Whombat get the value or the key; nothing is swept after.
 */
export const VAULT_KEYS_COPY = {
  envName: 'ENVIRONMENT VARIABLE',
  envNameHint: 'Set in every command of your chats. Basic auth gets _USERNAME and _PASSWORD.',
  sshHint:
    'The agent’s commands on your Whombat get the key and an SSH configuration with your servers’ names during your chats.',
  loginHint: 'It signs in for you in its browser. It never sees the password.',
  mcpHint: 'Its tools that are on can be used in your chats.',
} as const;

/**
 * Taking a key back (AC-34): the agent may have kept a copy. “Banjo had “Cloudflare API token” in its commands and may
 * have kept a copy. Change the token where it was made to be sure.” For an SSH key: generate a new one.
 */
export function vaultRotateNotice(facts: { agentName: string; entryName: string; kind: VaultEntryKind }): {
  text: string;
  action: string | null;
} {
  const had = `${facts.agentName} had “${facts.entryName}” in its commands and may have kept a copy.`;
  if (facts.kind === 'ssh')
    return {
      text: `${had} Generate a new key and put its public key on the servers below to be sure.`,
      action: VAULT_SSH_COPY.generateNew,
    };
  if (facts.kind === 'login')
    return { text: `${had} Change the password on the website to be sure.`, action: null };
  return { text: `${had} Change the secret where it was made to be sure.`, action: null };
}

/** The Production switch of an SSH server (AC-11). */
export const VAULT_SSH_PRODUCTION_COPY = {
  label: 'Production',
  hint: 'The agent’s commands can’t reach this server until you say yes to one.',
  badge: 'PRODUCTION',
} as const;
