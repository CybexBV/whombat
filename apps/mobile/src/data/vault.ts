/**
 * The Vault on Android (docs/decisions/vault.md VT-73; not mocked): your entries as list rows, one entry's screen
 * (CONNECTION, SECRET, TOOLS, “Neo can use this”, RECENT USE; an old `secret` entry only says that nothing uses it,
 * skill-store.md AP-4156), the home network list and Settings → Agent → Keys' VAULT rows. An entry is switched on for
 * the one agent or not (Whombat one-agent.md OA-09, hermes-engine.md HE-43; app AP-4992, AP-5280), and reaches it in
 * your chats, by kind: an API's value in an environment variable of its commands on your Whombat (named here,
 * `vault.setKeyEnvName`; one-person-android.md AP-5768), an SSH key as a file there, a login in its browser's sign-ins,
 * an MCP server's tools.
 * Adding entries and replacing secrets are `vaultForm.ts`'s (AP-718). An SSH key (VT-S13; AP-605) shows its
 * fingerprint, its servers read-only with their status, and which servers each key covers; keys, servers and host keys
 * are set up on the web, and a production server carries PRODUCTION, read-only. Pure: the screens render these, and the
 * words come from core's `VAULT_COPY`, `VAULT_SSH_COPY`, `VAULT_KEYS_COPY` and formatters.
 */

import {
  AGENT_FALLBACK_NAME,
  VAULT_TOTP_TEXT,
  vaultEntryStaysMcp,
  vaultKeptPasswordLine,
  vaultTotpLine,
} from '@whombat/client';
import { type Principal, shortNameOf, type Tone } from '@whombat/core';
import { SetVaultKeyEnvNameBody } from '@whombat/core/contracts';
import {
  defaultVaultEnvName,
  VAULT_AGENT_ACCESS,
  VAULT_COPY,
  VAULT_KEYS_COPY,
  VAULT_SSH_COPY,
  VAULT_SSH_KEY_TYPE_LABELS,
  VAULT_SSH_PRODUCTION_COPY,
  type VaultAgentAccess,
  type VaultAuth,
  type VaultCheckStatus,
  type VaultEntry,
  type VaultEntryDetail,
  type VaultNetwork,
  vaultAgentAccessCopy,
  vaultCheckLine,
  vaultEntryAddress,
  vaultEntryMeta,
  vaultKeyDeliverable,
  vaultKeyEnvNames,
  vaultKeyServersText,
  vaultLastUsedText,
  vaultRotateNotice,
  vaultSavedIntro,
  vaultSecretLine,
  vaultSshHostKeyLabel,
  vaultSshServerCheckLine,
  vaultSshServerTarget,
  vaultUseRow,
} from '@whombat/core/vault';
import type { ViewContext } from './people';

export interface VaultStatus {
  /** The status dot: reached → ok, failing → bad, not checked → neutral (mut). */
  tone: Tone;
  /** What TalkBack says for the dot. */
  label: string;
}

const STATUS: Record<VaultCheckStatus, VaultStatus> = {
  reached: { tone: 'ok', label: 'Reached' },
  failing: { tone: 'bad', label: 'Failing' },
  unchecked: { tone: 'neutral', label: VAULT_COPY.notChecked },
};

export function vaultStatus(status: VaultCheckStatus): VaultStatus {
  return STATUS[status];
}

/* YOUR ENTRIES ----------------------------------------------------------------------------------- */

export interface VaultEntryRow {
  id: string;
  name: string;
  /** “MCP server · 192.168.1.10:8123”, “Login · shop.example.com · off for Neo”, “Secret · nothing uses it”. */
  meta: string;
  status: VaultStatus;
  /** “Used 10:48”, or null when nothing has used it. */
  lastUsed: string | null;
  accessibilityLabel: string;
}

/**
 * What saving from chat does, under the intro (VS-08, core's `vaultSavedIntro`; AP-4040): only where the Whombat does it
 * (`vault.self_serve`), as on the web (AP-4009).
 */
export function vaultSavedIntroFor(agent: string, selfServe: boolean): string | null {
  return selfServe ? vaultSavedIntro(agent) : null;
}

/**
 * The meta line (AP-1822, AP-4992): core's line (`vaultEntryMeta`, the agent by name), and only what differs from the
 * usual about the agent: nothing while the entry is on for it, “off for Neo” when switched Off. An old `secret` entry
 * says that nothing uses it.
 */
export function vaultMetaFor(entry: VaultEntry, agent: string): string {
  return entry.agentOn ? bareMeta(entry) : vaultEntryMeta(entry, agent);
}

/** Core's meta line without whether it is on for the agent: the entry screen's row says that (AP-4036). */
function bareMeta(
  entry: Pick<VaultEntry, 'kind' | 'auth' | 'url' | 'agentOn'> & { serverCount?: number },
): string {
  const meta = vaultEntryMeta(entry, '');
  return entry.kind === 'secret' ? meta : meta.slice(0, meta.lastIndexOf(' · '));
}

export function vaultEntryRow(entry: VaultEntry, now: Date, timeZone: string, agent: string): VaultEntryRow {
  const meta = vaultMetaFor(entry, agent);
  const status = vaultStatus(entry.check.status);
  const lastUsed = vaultLastUsedText(entry.lastUsedAt, now, timeZone);
  return {
    id: entry.id,
    name: entry.name,
    meta,
    status,
    lastUsed,
    accessibilityLabel: [`${entry.name}, ${status.label}`, meta, lastUsed].filter(Boolean).join('. '),
  };
}

/** The entries in the server's order (by name). */
export function vaultEntryRows(
  entries: readonly VaultEntry[],
  now: Date,
  timeZone: string,
  agent: string,
): VaultEntryRow[] {
  return entries.map((e) => vaultEntryRow(e, now, timeZone, agent));
}

/* HOME NETWORK ----------------------------------------------------------------------------------- */

export interface VaultNetworkRow {
  id: string;
  cidr: string;
  /** “ports 80, 8123”, “port 8123”. */
  ports: string;
  note: string | null;
  /** “192.168.1.0/24 · ports 80, 8123 · Home Assistant and the printer” */
  line: string;
}

export function vaultNetworkRows(networks: readonly VaultNetwork[]): VaultNetworkRow[] {
  return networks.map((n) => {
    const ports = `${n.ports.length === 1 ? 'port' : 'ports'} ${n.ports.join(', ')}`;
    const note = n.note.trim() || null;
    return { id: n.id, cidr: n.cidr, ports, note, line: [n.cidr, ports, note].filter(Boolean).join(' · ') };
  });
}

/* One entry -------------------------------------------------------------------------------------- */

/**
 * CONNECTION's line about signing in, in the web's words: “Signs in with a bearer token”, “Signs in as admin with a
 * password”, “Signs in as buyer@example.com in the browser” (a website login, VT-D28).
 */
export function signsInText(auth: VaultAuth): string {
  switch (auth.type) {
    case 'bearer':
      return 'Signs in with a bearer token';
    case 'header':
      return `Signs in with the ${auth.name} header`;
    case 'query':
      return `Signs in with the ${auth.name} query parameter`;
    case 'basic':
      return `Signs in as ${auth.username} with a password`;
    case 'form':
      return `Signs in as ${auth.username} in the browser`;
    case 'none':
      return 'Signs in with nothing';
    // An SSH key (contracts 0.32.0, VT-S02): its servers are set up on the web.
    case 'ssh_key':
      return 'Signs in with an SSH key';
  }
}

/**
 * An old `secret` entry (Whombat skill-store.md SST-09, contracts CT-823; AP-4156): packs used it and went, nothing makes
 * one any more. The web's words (AP-4113).
 */
export const VAULT_SECRET_UNUSED = 'Nothing uses this any more. You can remove it.';

/** Remove from Vault on the phone, for an old `secret` entry only (AP-4157): the web's words, no keys to lose. */
export const VAULT_REMOVE_COPY = {
  action: VAULT_COPY.remove,
  confirm: (name: string) => `Remove “${name}”?`,
  confirmBody: 'The audit log keeps that it was used.',
  removed: (name: string) => `Removed “${name}” from your Vault.`,
} as const;

export interface VaultToolRow {
  name: string;
  description: string;
  enabled: boolean;
  /** Appeared or changed since you last decided: off, with the “New” badge (VT-44). */
  isNew: boolean;
  accessibilityLabel: string;
}

/**
 * The one row where the keys were (vault-self-serve.md VS-03; one-agent.md OA-09; hermes-engine.md HE-43; AP-4030…,
 * AP-4992, AP-5280): the agent, whether the entry is switched on for it (On / Off), the hint for that choice and how it
 * reaches the agent in your chats.
 */
export interface VaultAgentAccessRow {
  agentId: string;
  principal: Principal;
  name: string;
  /** “Neo can use this” */
  title: string;
  value: VaultAgentAccess;
  options: readonly { value: VaultAgentAccess; label: string }[];
  /** The hint under the control for each choice. */
  hints: Record<VaultAgentAccess, string>;
  /**
   * An SSH key's key that covers only some servers (chosen on the web): “Servers · staging”, as on the web (AP-4002). Null
   * for All servers and every other kind: switching it on from the row covers All servers.
   */
  servers: string | null;
  /** How it reaches the agent while on (`VAULT_KEYS_COPY`'s line for its kind); null while off. */
  how: string | null;
  /**
   * An API's environment variable while on (AC-31): its name (the key's, else the one the entry's name gives) and the
   * variables it sets (`_USERNAME` and `_PASSWORD` for basic auth); null for the other kinds and while off.
   */
  env: { name: string; variables: string[] } | null;
  /**
   * Said after Off when the entry reached its commands in your chats (AC-34): “Neo had “Grafana” in its commands and may
   * have kept a copy. …”; null for a login or an MCP server, which never land there.
   */
  offNotice: string | null;
}

/** The env variable's sheet (AP-5281): the phone's words around `VAULT_KEYS_COPY`'s. */
export const VAULT_ENV_TEXT = {
  change: 'Change',
  changeHint: 'Changes the name of the environment variable',
  save: 'Save',
} as const;

/** A typed variable name as `vault.setKeyEnvName` takes it (the contract's own check), or why not. */
export function vaultEnvNameCheck(
  typed: string,
): { ok: true; name: string } | { ok: false; problem: string } {
  const parsed = SetVaultKeyEnvNameBody.safeParse({ envName: typed.trim() });
  if (parsed.success) return { ok: true, name: parsed.data.envName };
  return { ok: false, problem: parsed.error.issues[0]?.message ?? 'That name won’t work.' };
}

/** What switching sends (CT-1240): On switches it on (an SSH key for All servers), Off off. Null when nothing changes. */
export function vaultAccessChange(
  from: VaultAgentAccess,
  to: VaultAgentAccess,
): { give: { servers: null } } | { take: true } | null {
  if (from === to) return null;
  return to === 'off' ? { take: true } : { give: { servers: null } };
}

export interface VaultUseRowModel {
  id: string;
  agent: string;
  what: string;
  when: string;
  outcome: string;
  /** “Neo · HassTurnOff · 10:48 · done” */
  line: string;
}

export interface VaultEntryScreenModel {
  id: string;
  name: string;
  /** What the agent should know about it, or null when empty. */
  description: string | null;
  meta: string;
  status: VaultStatus;
  /**
   * CONNECTION: the address, how it signs in, the last check (“Checked 3 min ago · Reached · 5 tools”) and whether
   * Check again works — never for a website login, which nothing checks (CT-1235); null for an old `secret` entry.
   */
  connection: { address: string; signsIn: string | null; line: string | null; canCheck: boolean } | null;
  /** SECRET: “Set · replaced 2 days ago”, “Not set”. */
  secretLine: string;
  /** TOOLS of an MCP entry (empty for other kinds and before a check listed any). */
  tools: VaultToolRow[];
  /** “3 more tools were ignored: an entry keeps at most 64.”, or null. */
  toolsIgnored: string | null;
  /** “Neo can use this” (VS-03): null for an old `secret` entry (nothing uses it), and while the agent isn't known. */
  access: VaultAgentAccessRow | null;
  /**
   * An old `secret` entry (made for packs, which went; Whombat skill-store.md SST-09): one line that nothing uses it, and
   * Remove (AP-4156, AP-4157). Null for every other kind.
   */
  unused: string | null;
  /** RECENT USE, newest first. */
  recentUse: VaultUseRowModel[];
  /**
   * A website login's AUTHENTICATOR KEY (VLT-46; AP-6661): whether one is set (“Set · added 2 days ago”, never the key)
   * or what adding one does; null for every other kind.
   */
  totp: { set: boolean; line: string } | null;
  /** An MCP server the Vault couldn't move to Connections (VLT-30): its screen says “Move it to Connections”. */
  moveToConnections: boolean;
  /** An SSH key's PUBLIC KEY and SERVERS (VT-S13), read-only; null for other kinds. */
  ssh: VaultSshModel | null;
}

/** One server of an SSH key, as the phone shows it: no Check, Edit or trust here (VT-S13). */
export interface VaultServerRow {
  id: string;
  /** The name the agent uses (“web-1”). */
  name: string;
  /** `deploy@web1.example.com:22` */
  target: string;
  status: VaultStatus;
  /** “Checked 3 min ago · Signed in as deploy”, “Not checked yet”. */
  line: string;
  /** The host key waiting for you: “Host key to confirm: SHA256:… (ED25519)”, or null. */
  hostKey: string | null;
  /** “PRODUCTION” on a production server (AC-11): the agent's commands reach it only after your yes. */
  production: string | null;
  /** “Signs in with a kept password · 2 days ago” (CT-1664): shown as set, never the value; null with the key alone. */
  keptPassword: string | null;
  accessibilityLabel: string;
}

export interface VaultSshModel {
  /** `SHA256:…` */
  fingerprint: string | null;
  /** “ED25519 · made by Whombat · added 5 days ago” */
  keyMeta: string | null;
  servers: VaultServerRow[];
  /** “No servers yet. Add the servers this key signs in to.” when there are none. */
  empty: string | null;
}

/** Keys, servers and trusting host keys happen on the web (VT-S13). */
export const VAULT_SSH_ON_WEB = VAULT_SSH_COPY.sshOnWeb;

const SSH_ORIGIN = { generated: 'made by Whombat', imported: 'your own key' } as const;

export function vaultServerRow(
  server: VaultEntryDetail['servers'][number],
  now: Date,
  timeZone: string,
): VaultServerRow {
  const status = vaultStatus(server.check.status);
  const target = vaultSshServerTarget(server);
  const line = vaultSshServerCheckLine(server, now, timeZone);
  const seen = server.seenHostKey;
  const hostKey = seen
    ? `${server.hostKey ? 'New host key' : 'Host key to confirm'}: ${seen.fingerprint} (${vaultSshHostKeyLabel(seen.algorithm)})`
    : null;
  const production = server.production ? VAULT_SSH_PRODUCTION_COPY.badge : null;
  const keptPassword = vaultKeptPasswordLine(server.password, now, timeZone);
  return {
    id: server.id,
    name: server.name,
    target,
    status,
    line,
    hostKey,
    production,
    keptPassword,
    accessibilityLabel: [
      `${server.name}, ${status.label}`,
      production ? VAULT_SSH_PRODUCTION_COPY.label : null,
      target,
      line,
      keptPassword,
      hostKey,
    ]
      .filter(Boolean)
      .join('. '),
  };
}

function sshModel(entry: VaultEntryDetail, now: Date, timeZone: string): VaultSshModel {
  const auth = entry.auth?.type === 'ssh_key' ? entry.auth : null;
  return {
    fingerprint: auth?.fingerprint ?? null,
    keyMeta: auth
      ? [
          VAULT_SSH_KEY_TYPE_LABELS[auth.keyType],
          SSH_ORIGIN[auth.origin],
          vaultSecretLine(entry, now, timeZone).replace(/^Set · /, ''),
        ].join(' · ')
      : null,
    servers: entry.servers.map((s) => vaultServerRow(s, now, timeZone)),
    empty: entry.servers.length === 0 ? VAULT_SSH_COPY.noServers : null,
  };
}

function namesOf(ctx: ViewContext) {
  return (id: string) => {
    const p = ctx.people.get(id);
    return p ? { shortName: shortNameOf(p) } : undefined;
  };
}

/**
 * The agent's row (VS-03; OA-09; HE-43; AP-4030…AP-4033, AP-4992, AP-5280): On with a key, Off without one.
 */
export function vaultAccessRow(entry: VaultEntryDetail, ctx: ViewContext): VaultAgentAccessRow | null {
  if (entry.kind === 'secret') return null;
  const agent = ctx.people.agent;
  if (!agent) return null;
  const key = entry.key;
  const name = shortNameOf(agent);
  const copy = vaultAgentAccessCopy(name);
  const value: VaultAgentAccess = key ? 'on' : 'off';
  const ssh = entry.kind === 'ssh';
  const how =
    entry.kind === 'http'
      ? VAULT_KEYS_COPY.envNameHint
      : ssh
        ? VAULT_KEYS_COPY.sshHint
        : entry.kind === 'login'
          ? VAULT_KEYS_COPY.loginHint
          : VAULT_KEYS_COPY.mcpHint;
  const envName = key && entry.kind === 'http' ? (key.envName ?? defaultVaultEnvName(entry.name)) : null;
  return {
    agentId: agent.id,
    principal: agent,
    name,
    title: copy.title,
    value,
    options: VAULT_AGENT_ACCESS.map((v) => ({ value: v, label: copy.choices[v] })),
    hints: copy.hints,
    servers:
      ssh && key && key.servers !== null
        ? `Servers · ${vaultKeyServersText(key.servers, entry.servers)}`
        : null,
    how: key ? how : null,
    env: envName ? { name: envName, variables: vaultKeyEnvNames(envName, entry) } : null,
    offNotice: vaultKeyDeliverable(entry)
      ? vaultRotateNotice({ agentName: name, entryName: entry.name, kind: entry.kind }).text
      : null,
  };
}

/** One entry's screen. */
export function vaultEntryScreen(entry: VaultEntryDetail, ctx: ViewContext): VaultEntryScreenModel {
  const names = namesOf(ctx);
  const secretOnly = entry.kind === 'secret';
  const ssh = entry.kind === 'ssh';
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description.trim() || null,
    meta: bareMeta(entry),
    status: vaultStatus(entry.check.status),
    connection:
      !secretOnly && entry.url
        ? {
            address: vaultEntryAddress(entry.url),
            signsIn: entry.auth ? signsInText(entry.auth) : null,
            line: entry.kind === 'login' ? null : vaultCheckLine(entry.check, ctx.now, ctx.timeZone),
            canCheck: entry.kind !== 'login',
          }
        : null,
    secretLine: vaultSecretLine(entry, ctx.now, ctx.timeZone),
    tools:
      entry.kind === 'mcp'
        ? entry.tools.map((t) => ({
            name: t.name,
            description: t.description,
            enabled: t.enabled,
            isNew: t.isNew,
            accessibilityLabel: `${t.name}${t.isNew ? `, ${VAULT_COPY.newBadge.toLowerCase()}` : ''}. ${t.description}`,
          }))
        : [],
    toolsIgnored:
      entry.kind === 'mcp' && entry.toolsIgnored > 0 ? VAULT_COPY.toolsIgnored(entry.toolsIgnored) : null,
    access: vaultAccessRow(entry, ctx),
    unused: secretOnly ? VAULT_SECRET_UNUSED : null,
    recentUse: entry.recentUses.map((u) => {
      const row = vaultUseRow(u, { names, now: ctx.now, timeZone: ctx.timeZone });
      return { id: u.id, ...row };
    }),
    ssh: ssh ? sshModel(entry, ctx.now, ctx.timeZone) : null,
    totp: entry.kind === 'login' ? totpModel(entry, ctx) : null,
    moveToConnections: vaultEntryStaysMcp(entry),
  };
}

function totpModel(entry: VaultEntryDetail, ctx: ViewContext): { set: boolean; line: string } {
  const line = vaultTotpLine(entry.totp, ctx.now, ctx.timeZone);
  const agent = ctx.people.agent;
  return line
    ? { set: true, line }
    : { set: false, line: VAULT_TOTP_TEXT.notSet(agent ? shortNameOf(agent) : AGENT_FALLBACK_NAME) };
}

/* Settings → Agent → Keys' VAULT --------------------------------------------------------------- */

export interface VaultAgentRow {
  entryId: string;
  name: string;
  /** “MCP server · 192.168.1.10:8123”: what the entry is and where. */
  meta: string;
  accessibilityLabel: string;
}

/**
 * Your entries that are on for the agent (VT-72; OA-09, AP-4992), in the list's order: Settings → Agent
 * → Keys lists them, each opening its entry (where it is switched On or Off). Old `secret` entries, which
 * nothing uses, aren't listed.
 */
export function vaultAgentRows(entries: readonly VaultEntry[]): VaultAgentRow[] {
  return entries
    .filter((e) => e.agentOn && e.kind !== 'secret')
    .map((e) => {
      const meta = bareMeta(e);
      return { entryId: e.id, name: e.name, meta, accessibilityLabel: `${e.name}, ${meta}` };
    });
}
