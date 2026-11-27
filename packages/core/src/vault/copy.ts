/**
 * The Vault's words (docs/decisions/vault.md VT-51, VT-52, VT-70…VT-72). Signed audit text stays neutral — “a private
 * Vault entry”, never a name, tool, path or status (a log can be read by support with remote help on) — and only the
 * person's views add the detail.
 */
import type { MessageVaultSave } from '../domain/message.js';
import { coreTranslator, coreWords } from '../i18n/catalog.js';
import { type DateInput, formatAgo, formatRecent, toDate } from '../text/time.js';
import { vaultEntryAddress } from './network.js';
import { VAULT_FAILURE_TEXT } from './request.js';
import {
  type AuditVaultDetail,
  VAULT_CALL_DEADLINE_MS,
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

const VAULT_COPY_KEYS = [
  'title',
  'intro',
  'entries',
  'noEntries',
  'add',
  'homeNetwork',
  'homeNetworkIntro',
  'noNetworks',
  'descriptionLabel',
  'secret',
  'connection',
  'tools',
  'keys',
  'recentUse',
  'manage',
  'replace',
  'checkAgain',
  'newBadge',
  'remove',
  'notSet',
  'notChecked',
  'queryWarning',
  'httpWarning',
  'secretsOnWeb',
] as const;

/** `VAULT_COPY` in a locale. */
export function vaultCopy(locale?: string | null): {
  [K in (typeof VAULT_COPY_KEYS)[number]]: string;
} & {
  keysNote: (agentName: string) => string;
  toolsIgnored: (n: number) => string;
  setBy: (name: string) => string;
} {
  const tr = coreTranslator(locale);
  const words = Object.fromEntries(VAULT_COPY_KEYS.map((key) => [key, tr.t(`vault.copy.${key}`)])) as {
    [K in (typeof VAULT_COPY_KEYS)[number]]: string;
  };
  return {
    ...words,
    keysNote: (agentName: string) => tr.t('vault.copy.keysNote', { agent: agentName }),
    toolsIgnored: (n: number) => tr.tp('vault.copy.toolsIgnored', n),
    setBy: (name: string) => tr.t('vault.copy.setBy', { name }),
  };
}

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

/** A use's outcome in a locale (“done”, “klaar”). */
function outcomeLabel(outcome: VaultUse['outcome'], locale?: string | null): string {
  return coreTranslator(locale).language === 'en'
    ? VAULT_USE_OUTCOME_LABELS[outcome]
    : coreTranslator(locale).t(`vault.outcome.${outcome}`);
}

/**
 * What kind of entry it is, in a person's words (“Connection”, “Sign-in key”, “Password”, “Website login”, “Server
 * key”, “Secret”): the template's label, the same on the web and the phone.
 */
export function vaultEntryLabel(
  entry: {
    kind: VaultEntryKind;
    auth: Pick<VaultAuth, 'type'> | null;
  },
  locale?: string | null,
): string {
  const template = vaultTemplateOf(entry.kind, entry.auth);
  const tr = coreTranslator(locale);
  return tr.language === 'en'
    ? VAULT_TEMPLATE_DEFS[template].label
    : tr.t(`vault.template.${template}.label`);
}

/** A template's description with the agent by its name (“A website Dusty signs in to in its browser. …”). */
export function vaultTemplateDescription(
  template: VaultTemplate,
  agentName: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  if (tr.language === 'en')
    return VAULT_TEMPLATE_DEFS[template].description.split('the agent').join(agentName);
  return tr.t(`vault.template.${template}.description`).split('de assistent').join(agentName);
}

/**
 * The card's meta line: “Connection · 192.168.1.10:8123 · on for Dusty”, “Password · 192.168.1.20 · off for Dusty”,
 * “Server key · 3 servers · on for Dusty”, “Secret · nothing uses it”. The key's algorithm is the entry's
 * technical detail, not the card's.
 */
export function vaultEntryMeta(
  entry: Pick<VaultEntry, 'kind' | 'auth' | 'url' | 'agentOn'> & { serverCount?: number },
  agentName: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const label = vaultEntryLabel(entry, locale);
  const agent = tr.t(entry.agentOn ? 'vault.meta.on' : 'vault.meta.off', { agent: agentName });
  if (entry.kind === 'ssh') {
    const servers = entry.serverCount ?? 0;
    return [label, vaultSshServerCount(servers, locale), agent].join(' · ');
  }
  if (entry.kind === 'secret') return tr.t('vault.meta.unused', { label });
  return [label, entry.url ? vaultEntryAddress(entry.url) : null, agent].filter(Boolean).join(' · ');
}

const vaultSshServerCount = (n: number, locale?: string | null) =>
  n === 0 ? coreTranslator(locale).t('vault.noServers') : coreTranslator(locale).tp('vault.servers', n);

/**
 * The card's quieter line: where the entry points (“192.168.1.10:8123”) or how many servers a key has (“2 servers”);
 * null for an old `secret` entry.
 */
export function vaultEntryWhere(
  entry: Pick<VaultEntry, 'kind' | 'url'> & { serverCount?: number },
  locale?: string | null,
): string | null {
  if (entry.kind === 'ssh') return vaultSshServerCount(entry.serverCount ?? 0, locale);
  return entry.url ? vaultEntryAddress(entry.url) : null;
}

/**
 * Why a failing entry's dot is red, in words, from what its last check reported (`check.summary`, written by
 * `vaultCheckSummary` and `vaultSshEntryCheck`): “The password stopped working.”, “Whombat can’t reach it right now.”,
 * “One of its servers isn’t working.”. Null unless the entry is failing.
 */
export function vaultEntryProblem(
  entry: {
    kind: VaultEntryKind;
    auth: Pick<VaultAuth, 'type'> | null;
    check: Pick<VaultCheck, 'status' | 'summary'>;
  },
  locale?: string | null,
): string | null {
  if (entry.check.status !== 'failing') return null;
  const summary = entry.check.summary.trim();
  const problem = vaultProblemOf(entry, summary);
  const tr = coreTranslator(locale);
  if (problem === null) {
    if (!summary) return null;
    // A summary Whombat didn't write in a known form is the check's own words: shown as they are in English.
    return tr.language === 'en' ? summary : tr.t('vault.problem.other');
  }
  if (problem.kind === 'servers') return tr.tp('vault.problem.servers', problem.count);
  return tr.t(`vault.problem.${problem.kind}`);
}

type VaultProblem =
  | {
      kind:
        | 'password'
        | 'key'
        | 'unreachable'
        | 'timeout'
        | 'notAllowed'
        | 'badAnswer'
        | 'sshRejected'
        | 'hostChanged';
    }
  | { kind: 'servers'; count: number };

/**
 * What a failing check's summary says went wrong. The summaries are Whombat's own English (`vaultCheckSummary`,
 * `vaultSshEntryCheck`), stored with the check, so they are read here once and the words come from the catalog.
 */
function vaultProblemOf(
  entry: { kind: VaultEntryKind; auth: Pick<VaultAuth, 'type'> | null },
  summary: string,
): VaultProblem | null {
  if (summary.startsWith('The server rejected the secret'))
    return { kind: entry.auth?.type === 'basic' || entry.auth?.type === 'form' ? 'password' : 'key' };
  if (summary === VAULT_FAILURE_TEXT.unreachable) return { kind: 'unreachable' };
  if (summary === VAULT_FAILURE_TEXT.timeout) return { kind: 'timeout' };
  if (summary.startsWith('Not allowed:')) return { kind: 'notAllowed' };
  if (summary.startsWith('It answered, but not as')) return { kind: 'badAnswer' };
  if (entry.kind === 'ssh') {
    const several = /^(\d+) of \d+ servers failing$/.exec(summary);
    if (several) return { kind: 'servers', count: Number(several[1]) };
    if (summary === VAULT_FAILURE_TEXT.rejected) return { kind: 'sshRejected' };
    if (/host key changed|look like the same server/.test(summary)) return { kind: 'hostChanged' };
  }
  return null;
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
export function vaultCheckLine(
  check: VaultCheck,
  now: DateInput,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  if (check.status === 'unchecked' || !check.checkedAt) return tr.t('vault.copy.notChecked');
  return tr.t('vault.checkLine', {
    ago: formatAgo(check.checkedAt, now, timeZone, locale),
    summary: check.summary,
  });
}

/** SECRET: “Set · replaced 2 days ago”, “Set · added just now”, “Not set”. */
export function vaultSecretLine(
  entry: Pick<VaultEntry, 'secret' | 'createdAt'>,
  now: DateInput,
  timeZone: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const { set, setAt } = entry.secret;
  if (!set || !setAt) return tr.t('vault.copy.notSet');
  const replaced = toDate(setAt).getTime() - toDate(entry.createdAt).getTime() > 1000;
  return tr.t(replaced ? 'vault.secretLine.replaced' : 'vault.secretLine.added', {
    ago: formatAgo(setAt, now, timeZone, locale),
  });
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
export function vaultUseOutcomeText(use: Pick<VaultUse, 'outcome'>, locale?: string | null): string {
  return outcomeLabel(use.outcome, locale);
}

/**
 * A use's `what` in a locale: the forms `vaultTurnUseWhat` stores are Whombat's own English, so they are read here and
 * worded again; anything else (a tool's name) is shown as stored.
 */
function vaultUseWhatText(what: string, locale?: string | null): string {
  const tr = coreTranslator(locale);
  if (tr.language === 'en') return what;
  const m = /^in (.+)’s (browser|tools|commands) for this turn$/.exec(what);
  if (!m) return what;
  const place = m[2] as 'browser' | 'tools' | 'commands';
  return tr.t(`vaultUse.what.${place}`, { agent: m[1] as string });
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
    locale?: string | null;
  },
): { agent: string; what: string; when: string; outcome: string; line: string } {
  const agent = ctx.names(use.agentId)?.shortName ?? coreTranslator(ctx.locale).t('vault.theAgent');
  const when = formatRecent(use.at, ctx.now, ctx.timeZone, ctx.locale);
  const outcome = vaultUseOutcomeText(use, ctx.locale);
  const what = vaultUseWhatText(use.what, ctx.locale);
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
  locale?: string | null,
): string | null {
  return lastUsedAt
    ? coreTranslator(locale).t('vault.lastUsed', { when: formatRecent(lastUsedAt, now, timeZone, locale) })
    : null;
}

/* SSH keys (VT-S05, VT-S12, VT-S13) -------------------------------------------------------------- */

/** How a key type is written: “ED25519”, “RSA”, “ECDSA” (as `ssh-keygen -l` does). */
export const VAULT_SSH_KEY_TYPE_LABELS: Record<VaultSshKeyType, string> = vaultSshKeyTypeLabels('en');

/** `VAULT_SSH_KEY_TYPE_LABELS` in a locale. */
export function vaultSshKeyTypeLabels(locale?: string | null): Record<VaultSshKeyType, string> {
  return coreWords(locale, 'vaultSsh.keyType', ['ed25519', 'rsa', 'ecdsa']);
}

const VAULT_SSH_COPY_KEYS = [
  /** The form's segmented control, and the import fields. */
  'key',
  'generate',
  'useOwn',
  'privateKey',
  'passphrase',
  'generateHint',
  'passphraseHint',
  /** PUBLIC KEY. */
  'publicKey',
  'authorizedKeysHint',
  'copy',
  'copied',
  'generateNew',
  'replaceOwn',
  'replaceWarning',
  /** SERVERS. */
  'servers',
  'noServers',
  'addServer',
  'editServer',
  'serverName',
  'serverNameHint',
  'host',
  'port',
  'username',
  'check',
  'edit',
  'remove',
  'removeServer',
  'hostChangeNote',
  /** The trust card: its question is `vaultSshTrustQuestion`, the fingerprint is under Technical details. */
  'trustQuestion',
  'trust',
  'hostKeyUnconfirmed',
  'hostKeyChanged',
  /** The agent's key. */
  'serversChooser',
  'allServers',
  /** Android (VT-S13). */
  'sshOnWeb',
] as const;

/** The `ssh` entry's form and detail in a locale. */
export function vaultSshCopy(
  locale?: string | null,
): Readonly<Record<(typeof VAULT_SSH_COPY_KEYS)[number], string>> {
  return coreWords(locale, 'vaultSsh.copy', VAULT_SSH_COPY_KEYS);
}

/** The `ssh` entry's form and detail (VT-S13). */
export const VAULT_SSH_COPY = vaultSshCopy('en');

/** A server's check line in the words of its last check (VT-S05). */
export function vaultSshCheckSummary(
  outcome: VaultCheckOutcome,
  facts: { username?: string; reason?: string } = {},
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  // A check stores the English summary; the failure words are the request's own there.
  const english = tr.language === 'en';
  switch (outcome) {
    case 'reached':
      return facts.username
        ? tr.t('vaultSsh.check.signedInAs', { username: facts.username })
        : tr.t('vaultSsh.check.signedIn');
    case 'host_key_unconfirmed':
      return tr.t('vaultSsh.copy.hostKeyUnconfirmed');
    case 'host_key_changed':
      return tr.t('vaultSsh.copy.hostKeyChanged');
    case 'rejected':
      return english ? VAULT_FAILURE_TEXT.rejected : tr.t('vaultSsh.check.rejected');
    case 'unreachable':
      return english ? VAULT_FAILURE_TEXT.unreachable : tr.t('vaultSsh.check.unreachable');
    case 'timeout':
      return english
        ? VAULT_FAILURE_TEXT.timeout
        : tr.t('vaultSsh.check.timeout', { seconds: VAULT_CALL_DEADLINE_MS / 1000 });
    case 'not_allowed':
      return tr.t('vaultSsh.check.notAllowed', {
        reason: facts.reason ?? tr.t('vaultSsh.check.notAllowedReason'),
      });
    case 'bad_answer':
      return tr.t('vaultSsh.check.badAnswer');
  }
}

/**
 * A server's stored summary in a locale: Whombat's own English forms are worded again from the outcome, anything else
 * (a reason the server wrote) is shown as stored.
 */
function vaultSshSummaryText(
  outcome: VaultCheckOutcome | null,
  summary: string,
  locale?: string | null,
): string {
  if (outcome === null || coreTranslator(locale).language === 'en') return summary;
  if (outcome === 'reached') {
    const as = /^Signed in as (.+)$/.exec(summary);
    if (as) return vaultSshCheckSummary('reached', { username: as[1] as string }, locale);
  }
  return summary === vaultSshCheckSummary(outcome) ? vaultSshCheckSummary(outcome, {}, locale) : summary;
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
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  if (!server.check.checkedAt) return tr.t('vault.copy.notChecked');
  const { outcome, summary } = server.check;
  const said =
    outcome === 'host_key_unconfirmed' || outcome === 'host_key_changed'
      ? vaultSshCheckSummary(outcome, {}, locale)
      : vaultSshSummaryText(outcome, summary, locale);
  return tr.t('vault.checkLine', {
    ago: formatAgo(server.check.checkedAt, now, timeZone, locale),
    summary: said,
  });
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
  locale?: string | null,
): string {
  const host = server.host.includes(':') ? `[${server.host}]` : server.host;
  const where = server.port === 22 ? host : `${host}:${server.port}`;
  return coreTranslator(locale).t(changed ? 'vaultSsh.trust.changed' : 'vaultSsh.trust.ask', {
    name: server.name,
    where,
  });
}

/**
 * The trust card (VT-S13): “Is this your server? SHA256:… (ED25519). Compare it with `ssh-keygen -lf
 * /etc/ssh/ssh_host_ed25519_key.pub` on the server.” In parts, so the command can be set as code; `text` is the whole
 * sentence without code marks.
 */
export function vaultSshTrustCopy(
  hostKey: Pick<VaultSshHostKey, 'algorithm' | 'fingerprint'>,
  locale?: string | null,
): {
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
  const tr = coreTranslator(locale);
  const parts = {
    question: tr.t('vaultSsh.copy.trustQuestion'),
    fingerprint,
    compare: tr.t('vaultSsh.trust.compare'),
    command,
    after: tr.t('vaultSsh.trust.after'),
  };
  return {
    ...parts,
    text: `${parts.question} ${parts.fingerprint} ${parts.compare} ${parts.command} ${parts.after}`,
    action: tr.t('vaultSsh.copy.trust'),
  };
}

/** A key's servers in its row (“All servers”, “web-1, nas”). Unknown ids (removed servers) are left out. */
export function vaultKeyServersText(
  servers: readonly string[] | null | undefined,
  entryServers: readonly Pick<VaultSshServer, 'id' | 'name'>[],
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  if (servers === null || servers === undefined) return tr.t('vaultSsh.copy.allServers');
  const names = entryServers.filter((s) => servers.includes(s.id)).map((s) => s.name);
  return names.length ? names.join(', ') : tr.t('vaultSsh.keyServers.none');
}

/* The agent runs a person's Vault in their turn (0.112.0, Whombat vault-self-serve.md VS-04…VS-13; OA-10) -------- */

/** The switch on an entry for the agent (CT-786; since 0.125 on or off, CT-1240; VS-03; OA-09), in its order. */
export const VAULT_AGENT_ACCESS = ['on', 'off'] as const;
export type VaultAgentAccess = (typeof VAULT_AGENT_ACCESS)[number];

/**
 * The one row an entry shows for the agent (CT-786, CT-1240; VS-03; OA-09): “Dusty can use this”, On / Off, and the line
 * under the chosen one.
 */
export function vaultAgentAccessCopy(
  agentName: string,
  locale?: string | null,
): {
  title: string;
  choices: Record<VaultAgentAccess, string>;
  hints: Record<VaultAgentAccess, string>;
} {
  const tr = coreTranslator(locale);
  return {
    title: tr.t('vault.access.title', { agent: agentName }),
    choices: { on: tr.t('vault.access.on'), off: tr.t('vault.access.off') },
    hints: {
      on: tr.t('vault.access.hintOn', { agent: agentName }),
      off: tr.t('vault.access.hintOff', { agent: agentName }),
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
export function vaultSavedIntro(agentName: string, locale?: string | null): string {
  return coreTranslator(locale).t('vault.savedIntro', { agent: agentName });
}

/**
 * The line under a message for each `vaultSaved` item (CT-783; VS-07, VS-11): “Saved to your Vault · Plex”, “Used once
 * to put “Servers” on web-1, not kept”.
 */
export function vaultSavedLine(
  save: Pick<MessageVaultSave, 'name' | 'how' | 'server'>,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  if (save.how === 'used_once')
    return tr.t('vault.saved.usedOnce', {
      name: save.name,
      server: save.server ?? tr.t('vault.saved.aServer'),
    });
  return tr.t('vault.saved.kept', { name: save.name });
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
export const VAULT_KEYS_COPY = vaultKeysCopy('en');

/** `VAULT_KEYS_COPY` in a locale. */
export function vaultKeysCopy(
  locale?: string | null,
): Readonly<Record<'envName' | 'envNameHint' | 'sshHint' | 'loginHint' | 'mcpHint', string>> {
  return coreWords(locale, 'vaultKeys.copy', ['envName', 'envNameHint', 'sshHint', 'loginHint', 'mcpHint']);
}

/**
 * Taking a key back (AC-34): the agent may have kept a copy. “Banjo had “Cloudflare API token” in its commands and may
 * have kept a copy. Change the token where it was made to be sure.” For an SSH key: generate a new one.
 */
export function vaultRotateNotice(
  facts: { agentName: string; entryName: string; kind: VaultEntryKind },
  locale?: string | null,
): {
  text: string;
  action: string | null;
} {
  const tr = coreTranslator(locale);
  const had = tr.t('vaultKeys.rotate.had', { agent: facts.agentName, entry: facts.entryName });
  if (facts.kind === 'ssh')
    return { text: tr.t('vaultKeys.rotate.ssh', { had }), action: tr.t('vaultSsh.copy.generateNew') };
  if (facts.kind === 'login') return { text: tr.t('vaultKeys.rotate.login', { had }), action: null };
  return { text: tr.t('vaultKeys.rotate.other', { had }), action: null };
}

/** The Production switch of an SSH server (AC-11). */
export const VAULT_SSH_PRODUCTION_COPY = vaultSshProductionCopy('en');

/** `VAULT_SSH_PRODUCTION_COPY` in a locale. */
export function vaultSshProductionCopy(
  locale?: string | null,
): Readonly<Record<'label' | 'hint' | 'badge', string>> {
  return coreWords(locale, 'vaultSsh.production', ['label', 'hint', 'badge']);
}
