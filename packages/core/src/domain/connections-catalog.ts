/**
 * The connections catalog (Whombat docs/decisions/connections-catalog.md CX-01…CX-62, contracts 0.48.0, CT-266…): one
 * entry per service a person or a burrow can connect in Settings → Connections — how it signs in, what the form asks,
 * where its API lives, the one cheap read that proves a credential works, the typed tools a server adapter provides, the
 * paths and methods the generic `request` tool may use, a short guide for agents, and the calls that always ask a
 * person. Pure data and helpers: the web, Android and the server read the same catalog. Logos live in the web.
 *
 * Builtin entries (`transport: 'builtin'`, CX-02) keep their own pages and code (GitHub, Google, Microsoft 365, Website
 * feedback); they are here so the overview lists everything from one list.
 */
import { z } from 'zod';
import { ConnectionId, PrincipalId } from '../ids.js';
import type { Tier } from '../keys/catalog.js';
import { parseVaultUrl } from '../vault/network.js';
import { vaultBase64, vaultBasicAuthorization } from '../vault/request.js';
import { JsonObject, type JsonValue, Timestamp } from './common.js';
import {
  type CatalogCheck,
  CatalogEntry,
  CatalogField,
  type CatalogSignIn,
  CONNECTION_ACCESS_DEFAULTS,
  CONNECTION_FIELD_VALUE_MAX,
  CONNECTION_GUIDE_MAX,
  CONNECTION_LABEL_MAX,
  ConnectionAccessLevel,
  ConnectionHandle,
  ConnectionToolAccess,
  ConnectionToolTier,
  ConnectionTransport,
  catalogCheckFor,
  certificateField,
  type DiscoveryProbe,
  jsonPathValue,
  jsonPathValues,
  REQUEST_TOOL_NAME,
  type SensitiveRule,
  type SessionAnswerMatch,
  type SessionApply,
  type SessionLoginFailureReason,
  SignInKind,
  SOCKET_STREAM_SECONDS_DEFAULT,
  SOCKET_STREAM_SECONDS_MAX,
  SOCKET_TOOL_NAME,
  type TokenAuth,
} from './connections-catalog/shared.js';
import { GatewayKind } from './gateway.js';
import { ConnectionToolLimits } from './tool-limits.js';
import { TrackerEnvironment } from './tracker.js';

export { NOTION_VERSION } from './connections-catalog/notion.js';
export {
  ALWAYS_ASKS_LABEL,
  CATALOG_CATEGORIES,
  CATALOG_CATEGORY_LABELS,
  CATALOG_FIELD_KINDS,
  CATALOG_TAGLINE_MAX,
  CATALOG_USES,
  CatalogCategory,
  CatalogCheck,
  CatalogDiscovery,
  CatalogEntry,
  type CatalogEntryInput,
  CatalogField,
  CatalogFieldKind,
  CatalogPaste,
  CatalogSignIn,
  CatalogStep,
  CatalogStepValue,
  CatalogUse,
  CheckFailure,
  CheckForSecret,
  CONNECTION_ACCESS_DEFAULTS,
  CONNECTION_ACCESS_LABELS,
  CONNECTION_ACCESS_LEVELS,
  CONNECTION_CALL_DEADLINE_MS,
  CONNECTION_FIELD_VALUE_MAX,
  CONNECTION_GUIDE_MAX,
  CONNECTION_LABEL_MAX,
  CONNECTION_OUTPUT_MAX,
  CONNECTION_SECRET_MAX,
  CONNECTION_TOOL_ACCESS,
  CONNECTION_TOOL_TIER_LABELS,
  CONNECTION_TOOL_TIERS,
  CONNECTION_TOOLS_MAX,
  CONNECTION_TRANSPORTS,
  CONNECTIONS_MAX,
  ConnectionAccessLevel,
  ConnectionHandle,
  ConnectionLabel,
  ConnectionSecret,
  ConnectionToolAccess,
  ConnectionToolDef,
  ConnectionToolTier,
  ConnectionTransport,
  catalogCheckFor,
  checkFailure,
  DiscoveryProbe,
  defaultToolTier,
  FILES_TOOLS,
  jsonPathValue,
  jsonPathValues,
  NEW_TOOL_LABEL,
  NEXTCLOUD_LOGIN_MAX_MS,
  NEXTCLOUD_POLL_MS,
  OAUTH_SIGN_IN_KINDS,
  OAuthSignInKind,
  QueryRead,
  REQUEST_TOOL_NAME,
  ReadPath,
  RequestSpec,
  SERVICE_LOGIN_MAX_MS,
  SERVICE_LOGIN_POLL_MS,
  SERVICE_LOGIN_USER_CODE_MAX,
  SESSION_LOGIN_FAILURES,
  SensitiveRule,
  SessionAnswerMatch,
  SessionApply,
  SessionFailure,
  SessionLoginFailureReason,
  SessionStale,
  SessionTwoStep,
  SIGN_IN_KINDS,
  SignInKind,
  SOCKET_CONNECT_DEADLINE_MS,
  SOCKET_STREAM_SECONDS_DEFAULT,
  SOCKET_STREAM_SECONDS_MAX,
  SOCKET_TOOL_NAME,
  SocketSpec,
  TokenAuth,
} from './connections-catalog/shared.js';
export { TASKS_TOOLS } from './connections-catalog/todoist.js';
export { SERVERS_SENSITIVE, SERVERS_TOOLS } from './connections-catalog/whombat_servers.js';

import { entry as adguardEntry } from './connections-catalog/adguard.js';
import { entry as aiGatewayEntry } from './connections-catalog/ai_gateway.js';
import { entry as airtableEntry } from './connections-catalog/airtable.js';
import { entry as cloudflareEntry } from './connections-catalog/cloudflare.js';
import { entry as customApiEntry } from './connections-catalog/custom_api.js';
import { entry as customMcpEntry } from './connections-catalog/custom_mcp.js';
import { entry as deviceEntry } from './connections-catalog/device.js';
import { entry as dropboxEntry } from './connections-catalog/dropbox.js';
import { entry as esphomeEntry } from './connections-catalog/esphome.js';
import { entry as feedbackEntry } from './connections-catalog/feedback.js';
import { entry as forgejoEntry } from './connections-catalog/forgejo.js';
import { entry as fuseboxEntry } from './connections-catalog/fusebox.js';
import { entry as githubEntry } from './connections-catalog/github.js';
import { entry as githubActionsEntry } from './connections-catalog/github_actions.js';
import { entry as gitlabEntry } from './connections-catalog/gitlab.js';
import { entry as googleEntry } from './connections-catalog/google.js';
import { entry as grafanaEntry } from './connections-catalog/grafana.js';
import { entry as hetznerEntry } from './connections-catalog/hetzner.js';
import { entry as homeassistantEntry } from './connections-catalog/homeassistant.js';
import { entry as hubspotEntry } from './connections-catalog/hubspot.js';
import { entry as imapEntry } from './connections-catalog/imap.js';
import { entry as immichEntry } from './connections-catalog/immich.js';
import { entry as microsoftEntry } from './connections-catalog/microsoft.js';
import { entry as mollieEntry } from './connections-catalog/mollie.js';
import { entry as moneybirdEntry } from './connections-catalog/moneybird.js';
import { entry as nextcloudEntry } from './connections-catalog/nextcloud.js';
import { entry as nginxProxyManagerEntry } from './connections-catalog/nginx_proxy_manager.js';
import { entry as notionEntry } from './connections-catalog/notion.js';
import { entry as nzbhydraEntry } from './connections-catalog/nzbhydra.js';
import { entry as opnsenseEntry } from './connections-catalog/opnsense.js';
import { entry as overseerrEntry } from './connections-catalog/overseerr.js';
import { entry as paperlessEntry } from './connections-catalog/paperless.js';
import { entry as piholeEntry } from './connections-catalog/pihole.js';
import { entry as pipedriveEntry } from './connections-catalog/pipedrive.js';
import { entry as plausibleEntry } from './connections-catalog/plausible.js';
import { entry as plexEntry } from './connections-catalog/plex.js';
import { entry as portainerEntry } from './connections-catalog/portainer.js';
import { entry as proxmoxEntry } from './connections-catalog/proxmox.js';
import { entry as proxmoxBackupEntry } from './connections-catalog/proxmox_backup.js';
import { entry as ps5Entry } from './connections-catalog/ps5.js';
import { entry as pterodactylEntry } from './connections-catalog/pterodactyl.js';
import { entry as qnapEntry } from './connections-catalog/qnap.js';
import { entry as radarrEntry } from './connections-catalog/radarr.js';
import { entry as sabnzbdEntry } from './connections-catalog/sabnzbd.js';
import { entry as sonarrEntry } from './connections-catalog/sonarr.js';
import { entry as synologyEntry } from './connections-catalog/synology.js';
import { entry as t3codeEntry } from './connections-catalog/t3code.js';
import { entry as tailscaleEntry } from './connections-catalog/tailscale.js';
import { entry as todoistEntry } from './connections-catalog/todoist.js';
import { entry as trackerEntry } from './connections-catalog/tracker.js';
import { entry as truenasEntry } from './connections-catalog/truenas.js';
import { entry as unifiAccessEntry } from './connections-catalog/unifi_access.js';
import { entry as unifiNetworkEntry } from './connections-catalog/unifi_network.js';
import { entry as unifiProtectEntry } from './connections-catalog/unifi_protect.js';
import { entry as unraidEntry } from './connections-catalog/unraid.js';
import { entry as whombatServersEntry } from './connections-catalog/whombat_servers.js';

const ENTRIES = [
  githubEntry,
  googleEntry,
  microsoftEntry,
  imapEntry,
  feedbackEntry,
  whombatServersEntry,
  deviceEntry,
  homeassistantEntry,
  esphomeEntry,
  ps5Entry,
  notionEntry,
  todoistEntry,
  airtableEntry,
  nextcloudEntry,
  dropboxEntry,
  moneybirdEntry,
  paperlessEntry,
  immichEntry,
  plexEntry,
  overseerrEntry,
  sabnzbdEntry,
  nzbhydraEntry,
  sonarrEntry,
  radarrEntry,
  proxmoxEntry,
  proxmoxBackupEntry,
  hetznerEntry,
  unifiNetworkEntry,
  unifiProtectEntry,
  unifiAccessEntry,
  adguardEntry,
  piholeEntry,
  opnsenseEntry,
  nginxProxyManagerEntry,
  tailscaleEntry,
  cloudflareEntry,
  portainerEntry,
  unraidEntry,
  truenasEntry,
  synologyEntry,
  qnapEntry,
  grafanaEntry,
  pterodactylEntry,
  mollieEntry,
  hubspotEntry,
  pipedriveEntry,
  plausibleEntry,
  gitlabEntry,
  forgejoEntry,
  githubActionsEntry,
  t3codeEntry,
  trackerEntry,
  fuseboxEntry,
  aiGatewayEntry,
  customMcpEntry,
  customApiEntry,
];

/**
 * Every entry that can run on the home network takes a certificate fingerprint (one Whombat can find there, or a custom
 * one): a server there uses a certificate it made for itself, and Whombat pins the one it finds when it connects
 * (docs/decisions/connections-setup.md). Entries that say where the service shows its fingerprint keep their own field.
 */
function withCertificateField(e: (typeof ENTRIES)[number]): (typeof ENTRIES)[number] {
  const fields = e.fields ?? [];
  const home = ('discovery' in e && !!e.discovery) || e.category === 'custom';
  if (!home || !fields.some((f) => f.id === 'url') || fields.some((f) => f.id === 'fingerprint')) return e;
  return {
    ...e,
    fields: [...fields, certificateField('your browser shows it under the padlock → certificate')],
  };
}

/** Every catalog entry, validated, in the overview's order (builtins first, then by category in the list's order). */
export const CATALOG: readonly CatalogEntry[] = ENTRIES.map((e) =>
  CatalogEntry.parse(withCertificateField(e)),
);

export const CATALOG_IDS = [
  'github',
  'google',
  'microsoft',
  'imap',
  'feedback',
  'whombat_servers',
  'device',
  'homeassistant',
  'esphome',
  'ps5',
  'notion',
  'todoist',
  'airtable',
  'nextcloud',
  'dropbox',
  'moneybird',
  'paperless',
  'immich',
  'plex',
  'overseerr',
  'sabnzbd',
  'nzbhydra',
  'sonarr',
  'radarr',
  'proxmox',
  'proxmox_backup',
  'hetzner',
  'unifi_network',
  'unifi_protect',
  'unifi_access',
  'adguard',
  'pihole',
  'opnsense',
  'nginx_proxy_manager',
  'tailscale',
  'cloudflare',
  'portainer',
  'unraid',
  'truenas',
  'synology',
  'qnap',
  'grafana',
  'pterodactyl',
  'mollie',
  'hubspot',
  'pipedrive',
  'plausible',
  'gitlab',
  'forgejo',
  'github_actions',
  't3code',
  'tracker',
  'fusebox',
  'ai_gateway',
  'custom_mcp',
  'custom_api',
] as const;
/** A catalog entry's id. Open on the wire elsewhere (`CatalogIdText`): a client may meet ids its catalog lacks. */
export const CatalogId = z.enum(CATALOG_IDS);
export type CatalogId = z.infer<typeof CatalogId>;
/** A catalog id as a payload carries it: any slug, so entries a client's catalog lacks parse (it skips them). */
export const CatalogIdText = z.string().regex(/^[a-z][a-z0-9_]{1,30}$/);

/* Setting up (CT-314) ---------------------------------------------------------------------------- */

/**
 * What a pasted block or a dropped file gives (CT-314): each of the method's paste patterns that matches, by target (a
 * field id or `secret`), the first match winning. A paste that matches nothing gives nothing: the form then takes it as
 * the secret itself.
 */
export function pasteValues(
  method: Extract<CatalogSignIn, { kind: 'token' | 'client_credentials' }>,
  text: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of method.paste) {
    if (out[p.target]) continue;
    const m = new RegExp(p.pattern, 'im').exec(text);
    const value = m?.[1]?.trim();
    if (value) out[p.target] = value;
  }
  return out;
}

/** What Look only or Manage means for this entry (CT-314). */
export function accessText(entry: CatalogEntry, level: ConnectionAccessLevel): string {
  return entry.access?.[level] ?? CONNECTION_ACCESS_DEFAULTS[level];
}

/**
 * What Found on your network calls a computer that answers SSH (Whombat connect-in-chat.md): not a catalog entry, a
 * server to add (`ssh://192.168.1.20`, its system as the SSH banner names it in `version`).
 */
export const FOUND_SERVER_ID = 'server';

/** A found server's address: `ssh://192.168.1.20`, `:port` only when SSH isn't on 22. */
export function foundServerUrl(host: string, port: number): string {
  const h = host.includes(':') ? `[${host}]` : host;
  return `ssh://${h}${port === 22 ? '' : `:${port}`}`;
}

/** A found server's name: its system as its SSH banner says (“Debian server”), else “Server”. */
export function foundServerName(version: string | null | undefined): string {
  const system = version?.trim();
  return system ? `${system} server` : 'Server';
}

/** A found server's few words (DF-08's tagline). */
export const FOUND_SERVER_TAGLINE = 'A computer Whombat can look after';

/** A found service's address (CT-314): `https://192.168.1.10:8006`, the scheme's own port left out. */
export function discoveredUrl(scheme: 'https' | 'http', host: string, port: number): string {
  const h = host.includes(':') ? `[${host}]` : host;
  const own = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80);
  return `${scheme}://${h}${own ? '' : `:${port}`}`;
}

/** Whether a discovery probe's answer matches (CT-314): status, header and body, all that are given. */
export function probeMatches(
  probe: z.output<typeof DiscoveryProbe>,
  answer: { status: number; headers: Readonly<Record<string, string | string[] | undefined>>; body: string },
): boolean {
  if (probe.status && !probe.status.includes(answer.status)) return false;
  if (probe.header) {
    const raw = answer.headers[probe.header.name.toLowerCase()];
    const value = Array.isArray(raw) ? raw.join(', ') : (raw ?? '');
    if (!new RegExp(probe.header.pattern, 'i').test(value)) return false;
  }
  if (probe.bodyPattern && !new RegExp(probe.bodyPattern, 'i').test(answer.body)) return false;
  return true;
}

/** The version a probe's answer names, or null (CT-314). */
export function probeVersion(
  probe: z.output<typeof DiscoveryProbe>,
  answer: { headers: Readonly<Record<string, string | string[] | undefined>>; body: string },
): string | null {
  const v = probe.version;
  if (!v) return null;
  let text: string | null = null;
  if (v.json) {
    let json: unknown = null;
    try {
      json = JSON.parse(answer.body);
    } catch {
      json = null;
    }
    const found = jsonPathValues(json, v.json).find((x) => typeof x === 'string' || typeof x === 'number');
    text = found === undefined ? null : String(found);
  } else if (v.header) {
    const raw = answer.headers[v.header.toLowerCase()];
    text = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
  } else {
    text = answer.body;
  }
  if (text === null) return null;
  if (v.pattern) text = new RegExp(v.pattern, 'i').exec(text)?.[1] ?? null;
  return text ? text.trim().slice(0, 60) : null;
}

/** The entries that connect through this catalog (not builtins). */
export const CATALOG_CONNECTABLE: readonly CatalogEntry[] = CATALOG.filter((e) => e.transport !== 'builtin');

/** The entry with this id, or null (an id from a newer catalog). */
export function catalogEntry(id: string): CatalogEntry | null {
  return CATALOG.find((e) => e.id === id) ?? null;
}

/**
 * Whether agents use connections of this entry (0.69, CT-325, TA-02): every entry but those only automations use
 * (the trackers) and the AI gateways (Fusebox, AI gateway; 0.76, AIG-01). False: the connection is never listed or
 * callable for an agent (`connection_tools`, `connection_call`), never one of `DispatchContext.connections`, never
 * counts as one an agent can use and is looked after by nobody. An id this catalog doesn't know counts as an agents'
 * entry.
 */
export function isAgentConnection(entry: CatalogEntry | string): boolean {
  const e = typeof entry === 'string' ? catalogEntry(entry) : entry;
  return (e?.use ?? 'agents') === 'agents';
}

/**
 * Whether connections of this entry are the burrow's AI gateway (0.76, CT-332; Whombat ai-gateway.md AIG-01): Fusebox
 * and AI gateway. Never an agent's (`isAgentConnection` false), looked after by nobody, at most one per burrow; its page
 * shows the switches of `Burrow.aiGateway` instead of the agents' access lines.
 */
export function isGatewayConnection(entry: CatalogEntry | string): boolean {
  return gatewayKindOf(entry) !== null;
}

/** The gateway kind of an entry (`fusebox`, `ai_gateway`), or null for every other entry (AIG-01). */
export function gatewayKindOf(entry: CatalogEntry | string): GatewayKind | null {
  const e = typeof entry === 'string' ? catalogEntry(entry) : entry;
  if (e?.use !== 'gateway') return null;
  const kind = GatewayKind.safeParse(e.id);
  return kind.success ? kind.data : null;
}

/** An entry's sign-in method of this kind (the first, for `token` entries with several shapes), or null. */
export function catalogSignIn(entry: CatalogEntry, kind: SignInKind): CatalogSignIn | null {
  return entry.signIn.find((m) => m.kind === kind) ?? null;
}

/**
 * The fields the form asks with this sign-in method (CX-71). Never a field filled from the check (`fromCheck`, 0.111,
 * CT-737): nobody is asked for it.
 */
export function fieldsFor(entry: CatalogEntry, kind: SignInKind): z.output<typeof CatalogField>[] {
  return entry.fields
    .map((f) => CatalogField.parse(f))
    .filter((f) => f.fromCheck === undefined && (!f.methods || f.methods.includes(kind)));
}

/**
 * The values of the entry's `fromCheck` fields in a check's JSON answer (0.111, CT-737; SG-15a): each field's first
 * string or number at its path, trimmed, when it is there and fits a field (at most `CONNECTION_FIELD_VALUE_MAX`, no
 * control characters); fields the answer doesn't hold are left out. The server merges them into the connection's fields
 * after every check that passes.
 */
export function fieldsFromCheck(
  entry: Pick<CatalogEntry, 'fields'>,
  answer: unknown,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of entry.fields) {
    if (f.fromCheck === undefined) continue;
    const found = jsonPathValues(answer, f.fromCheck).find(
      (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)),
    );
    const text = found === undefined ? '' : String(found).trim();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
    if (text !== '' && text.length <= CONNECTION_FIELD_VALUE_MAX && !/[\u0000-\u001f\u007f]/.test(text))
      out[f.id] = text;
  }
  return out;
}

/** The `token` sign-in a `password` or `service_login` sign-in's result is stored as (`tokenMethod`), or null. */
export function storedTokenSignIn(
  entry: CatalogEntry,
  method: Extract<CatalogSignIn, { kind: 'password' | 'service_login' }>,
): Extract<CatalogSignIn, { kind: 'token' }> | null {
  const token = entry.signIn.filter((m) => m.kind === 'token')[method.tokenMethod];
  return token?.kind === 'token' ? token : null;
}

/** The transport of a connection made with this sign-in method (Notion's token: `rest`). */
export function connectionTransport(entry: CatalogEntry, kind: SignInKind): ConnectionTransport {
  const method = catalogSignIn(entry, kind);
  return method?.transport ?? entry.transport;
}

/** Whether a connection made this way has the generic `request` tool (CX-33). */
export function hasRequestTool(entry: CatalogEntry, kind: SignInKind): boolean {
  if (!entry.request) return false;
  const transport = connectionTransport(entry, kind);
  return transport === 'rest' || (transport === 'mcp' && entry.request.alongsideMcp && kind !== 'mcp_oauth');
}

/** Whether a connection made this way has the socket's `call` tool (0.97, CT-472). */
export function hasSocketTool(entry: CatalogEntry, kind: SignInKind): boolean {
  return entry.socket !== null && connectionTransport(entry, kind) === 'socket';
}

/* ---------------------------------------------------------------------------------------------- */
/* Helpers                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** `{name}` placeholders of a template, in order. */
export function templateFields(template: string): string[] {
  return [...template.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((m) => m[1] as string);
}

function fieldValue(
  entry: CatalogEntry,
  id: string,
  fields: Readonly<Record<string, string>>,
): string | null {
  const raw = fields[id]?.trim() ?? entry.fields.find((f) => f.id === id)?.default ?? '';
  if (raw === '') return null;
  const field = entry.fields.find((f) => f.id === id);
  return field?.kind === 'url' ? raw.replace(/\/+$/, '') : raw;
}

/** Fills `{field}` placeholders (a URL field without its trailing slash; other values as written), or null. */
export function fillTemplate(
  entry: CatalogEntry,
  template: string,
  fields: Readonly<Record<string, string>>,
  encode = false,
): string | null {
  let missing = false;
  const out = template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, id: string) => {
    const value = fieldValue(entry, id, fields);
    if (value === null) {
      missing = true;
      return '';
    }
    const field = entry.fields.find((f) => f.id === id);
    return encode && field?.kind !== 'url' ? encodeURIComponent(value) : value;
  });
  return missing ? null : out;
}

/**
 * The connection's API base (CX-01): the entry's template over the fields, without a trailing slash; null when a field
 * it needs is missing, the result isn't an http(s) URL Whombat may use (`parseVaultUrl`), or the entry is builtin.
 */
export function resolveBaseUrl(entry: CatalogEntry, fields: Readonly<Record<string, string>>): string | null {
  if (!entry.baseUrl) return null;
  const filled = fillTemplate(entry, entry.baseUrl, fields, true);
  if (filled === null) return null;
  const url = filled.replace(/\/+$/, '');
  return parseVaultUrl(url).ok ? url : null;
}

/** Where the MCP server is (CX-32): a sign-in's fixed URL, else the base plus `mcpPath`; null without one. */
export function resolveMcpUrl(
  entry: CatalogEntry,
  fields: Readonly<Record<string, string>>,
  kind: SignInKind,
): string | null {
  if (connectionTransport(entry, kind) !== 'mcp') return null;
  const method = catalogSignIn(entry, kind);
  if (method?.kind === 'mcp_oauth' && method.mcpUrl) return method.mcpUrl;
  if (entry.mcpPath === null) return null;
  const base = resolveBaseUrl(entry, fields);
  return base === null ? null : `${base}${entry.mcpPath}`;
}

/** The `request` tool's path prefixes with the fields filled in (Moneybird's `/{administration}/`). */
export function resolveRequestPrefixes(
  entry: CatalogEntry,
  fields: Readonly<Record<string, string>>,
): string[] {
  if (!entry.request) return [];
  return entry.request.prefixes
    .map((p) => fillTemplate(entry, p, fields, true))
    .filter((p): p is string => p !== null);
}

/**
 * The check's path with the fields filled in (Plausible's `/api/v1/stats/realtime/visitors?site_id={site}`), or null.
 * With the secret (0.111, CT-736): the path of the request `catalogCheckFor` picks for it.
 */
export function resolveCheckPath(
  entry: CatalogEntry,
  fields: Readonly<Record<string, string>>,
  secret?: string,
): string | null {
  const check = secret === undefined ? entry.check : catalogCheckFor(entry, secret);
  return check?.kind === 'request' ? fillTemplate(entry, check.path, fields, true) : null;
}

/** Where a person makes a token, filled in (`{url}/profile/security`), or null. */
export function resolveTokenUrl(
  entry: CatalogEntry,
  fields: Readonly<Record<string, string>>,
): string | null {
  return entry.tokenUrl === null ? null : fillTemplate(entry, entry.tokenUrl, fields);
}

/** The host a connection is on (“home.lan”, “home.lan:8123”), for its label and row; null for fixed services. */
export function connectionHost(entry: CatalogEntry, fields: Readonly<Record<string, string>>): string | null {
  if (!entry.baseUrl || !templateFields(entry.baseUrl).includes('url')) return null;
  const url = fieldValue(entry, 'url', fields);
  if (url === null) return null;
  const parsed = parseVaultUrl(url);
  if (!parsed.ok) return null;
  const u = parsed.url;
  const host = u.hostKind === 'ipv6' ? `[${u.host}]` : u.host;
  return u.explicitPort ? `${host}:${u.port}` : host;
}

/**
 * A new connection's label when the person gives none (CX-05): “Home Assistant · home.lan”, else the name; a gateway's
 * is always its name (“Fusebox”, 0.76). `onlyOne` (0.91, CT-408; Whombat home-redesign.md HR-07): the burrow has no other
 * connection of this entry, so the service's name alone (“Home Assistant”); the address tells two apart.
 */
export function defaultConnectionLabel(
  entry: CatalogEntry,
  fields: Readonly<Record<string, string>>,
  opts: { onlyOne?: boolean } = {},
): string {
  // A gateway's name goes into sentences (“Send Claude Code through Fusebox”) and a burrow has only one (0.76, AIG-05).
  if (entry.use === 'gateway' || opts.onlyOne) return entry.name;
  const host = connectionHost(entry, fields);
  const label = host ? `${entry.name} · ${host}` : entry.name;
  return label.slice(0, CONNECTION_LABEL_MAX);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
}

/**
 * A new connection's handle (CX-05): the entry's (`homeassistant`; a Custom entry's from its label when it gives one),
 * then `-2`, `-3`, … until it is not in `taken` (the handles of the connections the same agents can see).
 */
export function handleFor(catalogId: string, taken: Iterable<string>, label?: string | null): string {
  const entry = catalogEntry(catalogId);
  const used = new Set(taken);
  const fromLabel = entry?.category === 'custom' && label ? slug(label) : '';
  const fallback = entry?.handle ?? (slug(catalogId) || 'connection');
  const base = fromLabel && ConnectionHandle.safeParse(fromLabel).success ? fromLabel : fallback;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 28)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Why a field's value isn't acceptable, or null (CX-01). A field the service fills is never needed from the person. */
export function fieldProblem(field: CatalogField, value: string | undefined): string | null {
  const v = value?.trim() ?? '';
  if (v === '')
    return field.required && !field.fromService && field.fromCheck === undefined
      ? `${field.label} is needed.`
      : null;
  if (v.length > CONNECTION_FIELD_VALUE_MAX) return `${field.label} is too long.`;
  if (field.kind === 'url') {
    const parsed = parseVaultUrl(v);
    if (!parsed.ok) return parsed.message;
  }
  if (field.guide && v.length > CONNECTION_GUIDE_MAX) return 'Keep it under 1 500 characters.';
  if (field.validation && !new RegExp(`^(?:${field.validation.pattern})$`).test(v))
    return field.validation.message;
  return null;
}

/** Every field problem for a connect form (`field` → message), for the fields this sign-in method asks. */
export function fieldsProblems(
  entry: CatalogEntry,
  kind: SignInKind,
  fields: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fieldsFor(entry, kind)) {
    const problem = fieldProblem(f, fields[f.id]);
    if (problem) out[f.id] = problem;
  }
  for (const id of Object.keys(fields))
    if (!entry.fields.some((f) => f.id === id)) out[id] = 'This connection has no such field.';
  return out;
}

/** A connection's guide for agents (CX-30): the entry's, or a Custom API's own words (CX-62). */
export function connectionGuide(entry: CatalogEntry, fields: Readonly<Record<string, string>>): string {
  const own = entry.fields.find((f) => f.guide);
  const text = own ? (fields[own.id]?.trim() ?? '') : '';
  return (text || entry.guide).slice(0, CONNECTION_GUIDE_MAX);
}

/**
 * The headers and query a token adds to a request (CX-10), last, after the agent's: `bearer`, a header template over
 * `{secret}` and the fields, basic auth with the username field, or a query parameter. Null when a field it needs is
 * missing.
 */
export function tokenCredential(
  entry: CatalogEntry,
  auth: TokenAuth,
  secret: string,
  fields: Readonly<Record<string, string>>,
): { headers: Record<string, string>; query: Record<string, string> } | null {
  switch (auth.type) {
    case 'bearer':
      return { headers: { Authorization: `Bearer ${secret}` }, query: {} };
    case 'header': {
      const filled = fillTemplate(entry, auth.template.replaceAll('{secret}', '\u0000'), fields);
      return filled === null
        ? null
        : { headers: { [auth.name]: filled.replaceAll('\u0000', secret) }, query: {} };
    }
    case 'basic': {
      const username = fieldValue(entry, auth.usernameField, fields);
      return username === null
        ? null
        : { headers: { Authorization: vaultBasicAuthorization(username, secret) }, query: {} };
    }
    case 'query':
      return { headers: {}, query: { [auth.name]: secret } };
    case 'session':
      // The server signs in for a session token first (CM-11): `sessionCredential` puts that on the request.
      return null;
  }
}

/* Session sign-ins (0.97, CT-470; CM-10, CM-11) ------------------------------------------------- */

/**
 * A login template filled in (CT-470): every string inside `template` (an array, an object, nested) with `{secret}` and
 * the fields replaced; keys and other values as they are. Null when a field it names is missing. The secret is put in
 * last, so a field holding `{secret}` stays as it was typed.
 */
export function fillLoginTemplate(
  entry: CatalogEntry,
  template: JsonValue,
  secret: string,
  fields: Readonly<Record<string, string>>,
): JsonValue | null {
  let missing = false;
  const walk = (v: JsonValue, depth: number): JsonValue => {
    if (depth > 8) return v;
    if (typeof v === 'string') {
      const filled = fillTemplate(entry, v.replaceAll('{secret}', '\u0000'), fields);
      if (filled === null) {
        missing = true;
        return '';
      }
      return filled.replaceAll('\u0000', secret);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1)]));
    return v;
  };
  const out = walk(template, 0);
  return missing ? null : out;
}

/** The headers and query a session token goes on a request with (CT-470), as the session's `apply` says. */
export function sessionCredential(
  apply: SessionApply,
  token: string,
): { headers: Record<string, string>; query: Record<string, string> } {
  switch (apply.type) {
    case 'bearer':
      return { headers: { Authorization: `Bearer ${token}` }, query: {} };
    case 'header':
      return { headers: { [apply.name]: apply.template.replaceAll('{token}', token) }, query: {} };
    case 'query':
      return { headers: {}, query: { [apply.name]: token } };
  }
}

/**
 * When a session from this sign-in answer runs out (CT-470), in milliseconds since the epoch: `expiresJsonPath` as a
 * number of seconds from `now` or as an ISO time, else `ttlSeconds`; never more than a day from `now`, never in the past.
 */
export function sessionExpiresAt(
  auth: Extract<TokenAuth, { type: 'session' }>,
  answer: unknown,
  now: number,
): number {
  const day = now + 86_400_000;
  let at = now + auth.ttlSeconds * 1000;
  const raw = auth.expiresJsonPath ? jsonPathValue(answer, auth.expiresJsonPath) : undefined;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) at = now + raw * 1000;
  else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) at = now + Number(raw.trim()) * 1000;
  else if (typeof raw === 'string') {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) at = t;
  }
  return Math.max(now, Math.min(at, day));
}

/**
 * The session token in a sign-in answer (CT-470), or null when the answer has none there: at `tokenJsonPath` of the JSON
 * answer, or (0.110, CT-704) in the `tokenXmlTag` element of the answer's text. `sessionAnswerToken` reads either from
 * the answer's text.
 */
export function sessionToken(auth: Extract<TokenAuth, { type: 'session' }>, answer: unknown): string | null {
  if (auth.tokenXmlTag !== undefined)
    return typeof answer === 'string' ? usableToken(xmlElementText(answer, auth.tokenXmlTag)) : null;
  if (auth.tokenJsonPath === undefined) return null;
  return usableToken(jsonPathValue(answer, auth.tokenJsonPath));
}

/** A token that can go in a header or a query: a non-empty string without control characters. */
function usableToken(v: unknown): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
  return typeof v === 'string' && v.trim() !== '' && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
}

/* Session sign-ins grown for Synology and QNAP (0.110, CT-703…CT-707; Whombat desk-found.md NS-03, NS-04) --------- */

/** `{id}` and `{id:base64}` in a session's sign-in templates (CT-703). */
const SESSION_TEMPLATE_RE = /\{([a-zA-Z][a-zA-Z0-9]*)(:base64)?\}/g;

/** The ids a session sign-in template names, `secret` included, plain or `:base64` (CT-703). */
export function sessionTemplateFields(template: string): string[] {
  return [...template.matchAll(SESSION_TEMPLATE_RE)].map((m) => m[1] as string);
}

/**
 * A session sign-in template filled (CT-703): `{secret}` and the fields (a url field without its trailing slash, a
 * field's default when it is empty), `{id:base64}` as the value's UTF-8 in standard base64 (QNAP's `pwd`). One pass: a
 * value holding `{secret}` stays as typed. Null when the secret or a field it names is empty.
 */
export function fillSessionTemplate(
  entry: CatalogEntry,
  template: string,
  secret: string,
  fields: Readonly<Record<string, string>>,
): string | null {
  let missing = false;
  const out = template.replace(SESSION_TEMPLATE_RE, (_, id: string, base64?: string) => {
    const value = id === 'secret' ? (secret === '' ? null : secret) : fieldValue(entry, id, fields);
    if (value === null) {
      missing = true;
      return '';
    }
    return base64 ? vaultBase64(value) : value;
  });
  return missing ? null : out;
}

/** `a=1&b=2`, each name and value percent-encoded (a query, or an `application/x-www-form-urlencoded` body). */
function formEncode(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** A path with these query parameters added (after any it already has). */
function withQueryText(path: string, query: Readonly<Record<string, string>> | undefined): string {
  const text = query ? formEncode(query) : '';
  if (text === '') return path;
  return `${path}${path.includes('?') ? '&' : '?'}${text}`;
}

/** What a session sign-in sends (CT-707): relative to the connection's base; `body` null for a `GET`. */
export interface SessionLoginRequest {
  method: 'GET' | 'POST' | 'PUT';
  /** The path with its query: `/api/auth`, `/webapi/entry.cgi`, `/cgi-bin/authLogin.cgi`. */
  path: string;
  /** `content-type` (with a body) and `accept`. */
  headers: Record<string, string>;
  /** JSON text, a form, or null. */
  body: string | null;
}

/**
 * What a session sign-in carries besides the password (0.111, CT-732; SG-09): the two-step code the person typed, or
 * the trusted-device token an earlier sign-in with a code was given (`sessionRememberedToken`). Both are credentials.
 */
export interface SessionLoginExtras {
  code?: string;
  remembered?: string;
}

/**
 * The values a session's `twoStep` adds to its sign-in (CT-732): with a code, the code as `code.name` and
 * `remember.body`; else with a remembered token, the token as `remember.name` and `remember.with`. A code replaces a
 * remembered token (it is asked when the token no longer works). Nothing without `twoStep`, or for what it can't carry.
 */
export function sessionTwoStepValues(
  auth: Extract<TokenAuth, { type: 'session' }>,
  extras: SessionLoginExtras = {},
): Record<string, string> {
  const two = auth.twoStep;
  if (!two) return {};
  const code = extras.code?.trim() ?? '';
  if (code !== '') return { [two.code.name]: code, ...(two.remember?.body ?? {}) };
  const remembered = extras.remembered ?? '';
  if (two.remember && usableToken(remembered) !== null)
    return { [two.remember.name]: remembered, ...(two.remember.with ?? {}) };
  return {};
}

/**
 * The sign-in request of a session (CT-707; NS-03): `login`'s method and path, its `query` filled and added to the path,
 * its `body` filled and sent as JSON (absent `encoding`: Pi-hole's `{"password": "…"}`) or as
 * a form; nothing for a `GET`. With `extras` (0.111, CT-732) a two-step code or a remembered token goes with it as the
 * session's `twoStep` says (`sessionTwoStepValues`: after the sign-in's own values, in `body`, or in `query` for a
 * `GET`). Null when the secret or a field it names is empty. The request holds the password: it is never logged.
 */
export function sessionLoginRequest(
  entry: CatalogEntry,
  auth: Extract<TokenAuth, { type: 'session' }>,
  secret: string,
  fields: Readonly<Record<string, string>>,
  extras: SessionLoginExtras = {},
): SessionLoginRequest | null {
  const fill = (values: Readonly<Record<string, string>> | undefined): Record<string, string> | null => {
    const out: Record<string, string> = {};
    for (const [k, t] of Object.entries(values ?? {})) {
      const v = fillSessionTemplate(entry, t, secret, fields);
      if (v === null) return null;
      out[k] = v;
    }
    return out;
  };
  const filledQuery = fill(auth.login.query);
  const filledBody = fill(auth.login.body);
  if (filledQuery === null || filledBody === null) return null;
  const added = sessionTwoStepValues(auth, extras);
  const isGet = auth.login.method === 'GET';
  const query = isGet ? { ...filledQuery, ...added } : filledQuery;
  const body = isGet ? filledBody : { ...filledBody, ...added };
  const accept = auth.tokenXmlTag !== undefined ? 'application/xml, text/xml' : 'application/json';
  const path = withQueryText(auth.login.path, query);
  if (auth.login.method === 'GET') return { method: 'GET', path, headers: { accept }, body: null };
  const form = auth.login.encoding === 'form';
  return {
    method: auth.login.method,
    path,
    headers: {
      'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      accept,
    },
    body: form ? formEncode(body) : JSON.stringify(body),
  };
}

/**
 * The sign-out request of a session (CT-703): `logout`'s method and path with its fixed `query`, the session added as
 * `apply` says (a header, or a query parameter after the others). Null without a `logout`.
 */
export function sessionLogoutRequest(
  auth: Extract<TokenAuth, { type: 'session' }>,
  token: string,
): { method: 'DELETE' | 'POST' | 'GET'; path: string; headers: Record<string, string> } | null {
  const logout = auth.logout;
  if (!logout) return null;
  const credential = sessionCredential(auth.apply, token);
  return {
    method: logout.method,
    path: withQueryText(withQueryText(logout.path, logout.query), credential.query),
    headers: { accept: 'application/json', ...credential.headers },
  };
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/**
 * The text of the first XML element of this name (CT-704): QNAP's `<authSid><![CDATA[x1y2]]></authSid>` → `x1y2`.
 * CDATA unwrapped, entities decoded, trimmed; an empty element is `''`; null when there is none.
 */
export function xmlElementText(xml: string, tag: string): string | null {
  const name = tag.replace(/[.\\-]/g, '\\$&');
  const m = new RegExp(`<${name}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${name}\\s*>)`).exec(xml);
  if (!m) return null;
  const inner = m[1] ?? '';
  let out = '';
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let last = 0;
  const decode = (t: string) =>
    t.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
      }
      return XML_ENTITIES[e.toLowerCase()] ?? all;
    });
  for (const c of inner.matchAll(cdata)) {
    out += decode(inner.slice(last, c.index)) + (c[1] ?? '');
    last = (c.index ?? 0) + c[0].length;
  }
  out += decode(inner.slice(last));
  return out.trim();
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The answer's values a match looks at, as text (CT-705): a JSON string, number or boolean; an XML element's text. */
function answerTexts(match: { json?: string; xml?: string }, body: string, json: () => unknown): string[] {
  if (match.xml !== undefined) {
    const t = xmlElementText(body, match.xml);
    return t === null ? [] : [t];
  }
  if (match.json === undefined) return [];
  return jsonPathValues(json(), match.json).flatMap((v) =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? [String(v)] : [],
  );
}

/** Whether an answer's text holds one of the match's values (CT-705). */
export function sessionAnswerMatches(match: SessionAnswerMatch, body: string): boolean {
  let parsed: unknown;
  let done = false;
  const json = () => {
    if (!done) {
      parsed = parseJsonText(body);
      done = true;
    }
    return parsed;
  };
  return answerTexts(match, body, json).some((t) => match.values.includes(t));
}

/** The session token in a sign-in answer's text (CT-707): JSON at `tokenJsonPath` or the `tokenXmlTag` element. */
export function sessionAnswerToken(
  auth: Extract<TokenAuth, { type: 'session' }>,
  body: string,
): string | null {
  return sessionToken(auth, auth.tokenXmlTag !== undefined ? body : parseJsonText(body));
}

/** `sessionExpiresAt` of a sign-in answer's text (CT-707): its JSON, or the ttl for an XML answer. */
export function sessionAnswerExpiresAt(
  auth: Extract<TokenAuth, { type: 'session' }>,
  body: string,
  now: number,
): number {
  return sessionExpiresAt(auth, auth.tokenXmlTag !== undefined ? undefined : parseJsonText(body), now);
}

/**
 * Whether a call's answer says the session ended although its status is 2xx (CT-705, CT-707; NS-03): one of the
 * session's `stale` rules holds (a rule with a `path` only for calls under it, the request's path without its query).
 * The server then signs in again once and repeats the call, as on a 401. False for any other status and without rules.
 */
export function sessionIsStale(
  auth: Extract<TokenAuth, { type: 'session' }>,
  status: number,
  body: string,
  path = '',
): boolean {
  if (status < 200 || status > 299 || !auth.stale?.length) return false;
  const p = path.split('?')[0] ?? '';
  return auth.stale.some(
    (rule) => (!rule.path || new RegExp(rule.path, 'i').test(p)) && sessionAnswerMatches(rule, body),
  );
}

/**
 * The person's words for a refused session sign-in (CT-706; NS-04), over `{name}` (the entry's name). The server uses
 * them on the connect form and when a connection needs its password again.
 */
export const SESSION_LOGIN_FAILURE_WORDS: Record<SessionLoginFailureReason, string> = {
  refused: '{name} refused the account name or password. Check them and try again.',
  disabled: 'The account Whombat signs in as is switched off on {name}. Turn it on, then try again.',
  denied:
    '{name} doesn’t let the account Whombat signs in as use it. Check the account’s permissions, then try again.',
  two_step:
    '{name} asks for a two-step code for this account. Turn off two-step sign-in for the user Whombat signs in as.',
  locked:
    '{name} blocked Whombat after too many tries. Wait a while or unblock Whombat’s address in {name}, then try again.',
  expired:
    'The password of the account Whombat signs in as has expired. Set a new one in {name}, then enter it here.',
};

/** `SESSION_LOGIN_FAILURE_WORDS` for an entry (CT-706). */
export function sessionLoginFailureText(
  entry: Pick<CatalogEntry, 'name'>,
  reason: SessionLoginFailureReason,
): string {
  return SESSION_LOGIN_FAILURE_WORDS[reason].replaceAll('{name}', entry.name);
}

/**
 * Why a session sign-in was refused, from its answer (CT-706, CT-707; NS-04): the first of the session's `failures`
 * whose value the answer holds, whatever the status (Synology and QNAP answer 200), with the entry's words or
 * `SESSION_LOGIN_FAILURE_WORDS`. A failure with `status` (0.111, CT-734; SG-10) holds only for an answer with one of
 * them, so only when the caller gives the answer's status. Null when none holds: the server reads the status and the
 * token as before. A session with `twoStep` asks `sessionTwoStepAsk` first.
 */
export function sessionLoginFailure(
  entry: Pick<CatalogEntry, 'name'>,
  auth: Extract<TokenAuth, { type: 'session' }>,
  body: string,
  status?: number,
): { reason: SessionLoginFailureReason; text: string } | null {
  for (const f of auth.failures ?? []) {
    if (f.status && (status === undefined || !f.status.includes(status))) continue;
    if (sessionAnswerMatches(f, body))
      return { reason: f.reason, text: f.text ?? sessionLoginFailureText(entry, f.reason) };
  }
  return null;
}

/**
 * Whether a sign-in answer asks for a two-step code (0.111, CT-732; SG-09): `wrong_code` when it holds the session's
 * `twoStep.wrongCode` (a code was sent and didn't work), `asked` when it holds `twoStep.asked`, else null (and always
 * without `twoStep`). Looked at before `sessionLoginFailure`.
 */
export function sessionTwoStepAsk(
  auth: Extract<TokenAuth, { type: 'session' }>,
  body: string,
): 'asked' | 'wrong_code' | null {
  const two = auth.twoStep;
  if (!two) return null;
  if (two.wrongCode && sessionAnswerMatches(two.wrongCode, body)) return 'wrong_code';
  return sessionAnswerMatches(two.asked, body) ? 'asked' : null;
}

/**
 * The trusted-device token in a sign-in answer that carried a code (0.111, CT-732; SG-09): the first usable string at
 * `twoStep.remember.tokenJsonPaths` of its JSON (DSM's `data.device_id`, or `data.did`), or null. A credential: sealed,
 * never shown.
 */
export function sessionRememberedToken(
  auth: Extract<TokenAuth, { type: 'session' }>,
  body: string,
): string | null {
  const remember = auth.twoStep?.remember;
  if (!remember) return null;
  const json = parseJsonText(body);
  for (const path of remember.tokenJsonPaths) {
    const token = usableToken(jsonPathValue(json, path));
    if (token !== null) return token;
  }
  return null;
}

/** What a stored connection says when its service asks for a two-step code again (CT-732; SG-09), over `{name}`. */
export const SESSION_TWO_STEP_AGAIN_WORDS =
  '{name} asks for a two-step code again. Replace the password and enter a code.';

/** A session's `twoStep.again`, or `SESSION_TWO_STEP_AGAIN_WORDS` for the entry (CT-732). */
export function sessionTwoStepAgainText(
  entry: Pick<CatalogEntry, 'name'>,
  auth: Extract<TokenAuth, { type: 'session' }>,
): string {
  return auth.twoStep?.again ?? SESSION_TWO_STEP_AGAIN_WORDS.replaceAll('{name}', entry.name);
}

const FORBIDDEN_CREDENTIAL_HEADERS = ['host', 'content-length', 'cookie', 'transfer-encoding', 'connection'];

/**
 * Why a token shape can't be used, or null (a person's own on Custom entries, every entry's in the catalog's tests):
 * `{secret}` once in a header, known fields only; a session's sign-in names `{secret}` and known fields, and its header
 * holds `{token}` (0.97, CT-470).
 */
export function tokenAuthProblem(entry: CatalogEntry, auth: TokenAuth): string | null {
  if (auth.type === 'header') {
    if (auth.template.split('{secret}').length !== 2) return 'The header value needs {secret} exactly once.';
    for (const id of templateFields(auth.template))
      if (id !== 'secret' && !entry.fields.some((f) => f.id === id)) return `There is no field {${id}}.`;
    if (FORBIDDEN_CREDENTIAL_HEADERS.includes(auth.name.toLowerCase()))
      return 'Whombat can’t send the token in that header.';
  }
  if (auth.type === 'basic' && !entry.fields.some((f) => f.id === auth.usernameField))
    return 'There is no username field.';
  if (auth.type === 'session') {
    const templates = [...Object.values(auth.login.body), ...Object.values(auth.login.query ?? {})];
    if (!templates.some((t) => sessionTemplateFields(t).includes('secret')))
      return 'The sign-in needs {secret}.';
    for (const t of templates)
      for (const id of sessionTemplateFields(t))
        if (id !== 'secret' && !entry.fields.some((f) => f.id === id)) return `There is no field {${id}}.`;
    if (auth.login.method === 'GET' && Object.keys(auth.login.body).length > 0)
      return 'A GET sign-in sends its values in the query.';
    if ((auth.tokenJsonPath === undefined) === (auth.tokenXmlTag === undefined))
      return 'The token is read from JSON or from XML, one of them.';
    if (Object.values(auth.logout?.query ?? {}).some((t) => sessionTemplateFields(t).length > 0))
      return 'The sign-out takes no values from the sign-in.';
    const two = auth.twoStep;
    if (two) {
      // The code and the remembered token go beside the sign-in's own values (CT-732): never over one of them.
      const own = new Set(
        Object.keys(auth.login.method === 'GET' ? (auth.login.query ?? {}) : auth.login.body),
      );
      const withCode = [two.code.name, ...Object.keys(two.remember?.body ?? {})];
      const withToken = two.remember ? [two.remember.name, ...Object.keys(two.remember.with ?? {})] : [];
      for (const names of [withCode, withToken])
        if (names.some((n) => own.has(n)) || new Set(names).size !== names.length)
          return 'The two-step values need names of their own.';
      const fixed = [...Object.values(two.remember?.body ?? {}), ...Object.values(two.remember?.with ?? {})];
      if (fixed.some((v) => sessionTemplateFields(v).length > 0))
        return 'The two-step values are sent as they are.';
    }
    if (auth.apply.type === 'header') {
      if (!auth.apply.template.includes('{token}')) return 'The header value needs {token}.';
      if (FORBIDDEN_CREDENTIAL_HEADERS.includes(auth.apply.name.toLowerCase()))
        return 'Whombat can’t send the token in that header.';
    }
  }
  return null;
}

/* Reads and writes (CX-33) ---------------------------------------------------------------------- */

const re = (source: string) => new RegExp(source, 'i');

/**
 * Whether a GraphQL request's body only reads (0.91, CT-405): one operation `{query, variables?, operationName?}` or a
 * batch of them, as an object or its JSON text (a raw GraphQL document also counts), where every `query` is a string
 * that names no `mutation` or `subscription` anywhere (comments and strings included: a document that says the word is
 * taken for a change). A persisted query without its text, an empty body or anything else isn't a read.
 */
export function graphqlReadsOnly(body: unknown): boolean {
  let value = body;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      // A raw document (`application/graphql`).
    }
  }
  const document = (text: unknown) =>
    typeof text === 'string' && text.trim() !== '' && !/\b(mutation|subscription)\b/i.test(text);
  const operation = (op: unknown) =>
    typeof op === 'object' &&
    op !== null &&
    !Array.isArray(op) &&
    document((op as { query?: unknown }).query);
  if (typeof value === 'string') return document(value);
  if (Array.isArray(value)) return value.length > 0 && value.every(operation);
  return operation(value);
}

/** A query's values for one parameter as strings (a string, or the strings of an array). */
function queryStrings(query: unknown, name: string): string[] | null {
  if (!query || typeof query !== 'object' || Array.isArray(query) || !Object.hasOwn(query, name)) return null;
  const v = (query as Record<string, unknown>)[name];
  if (typeof v === 'string') return [v];
  if (typeof v === 'number' || typeof v === 'boolean') return [String(v)];
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
  return [JSON.stringify(v)];
}

/**
 * What a call's query says about reading (0.97, CT-473; CM-18): null when it carries none of the entry's `queryReads`
 * parameters; else true only when every one it carries has read values only and none of their `writes` holds.
 */
export function queryReadDecision(entry: CatalogEntry, query: unknown): boolean | null {
  let decided: boolean | null = null;
  for (const rule of entry.request?.queryReads ?? []) {
    const values = queryStrings(query, rule.name);
    if (values === null) continue;
    const reads = values.length > 0 && values.every((v) => rule.values.includes(v));
    const writes = rule.writes.some((w) => {
      const lower = w.values.map((x) => x.toLowerCase());
      return (queryStrings(query, w.name) ?? []).some((v) => lower.includes(v.toLowerCase()));
    });
    decided = (decided ?? true) && reads && !writes;
  }
  return decided;
}

/**
 * Whether a `request` call reads (CX-33): its method is one of the entry's reads, or it matches a read path; a GraphQL
 * read path (`graphql`) only with a `body` that only reads (`graphqlReadsOnly`). Without the body such a call is a write.
 * A call whose `query` carries one of the entry's `queryReads` parameters is decided by its query alone (0.97, CT-473).
 */
export function isReadRequest(
  entry: CatalogEntry,
  method: string,
  path: string,
  body?: unknown,
  query?: unknown,
): boolean {
  if (!entry.request) return false;
  const byQuery = queryReadDecision(entry, query);
  if (byQuery !== null) return byQuery;
  const m = method.toUpperCase();
  if (entry.request.readMethods.includes(m)) return true;
  return entry.request.readPaths.some(
    (r) => r.method === m && re(r.path).test(path) && (!r.graphql || graphqlReadsOnly(body)),
  );
}

/** Whether a `request` call's path is under one of the connection's prefixes (CX-33), and its method allowed. */
export function requestAllowed(
  entry: CatalogEntry,
  fields: Readonly<Record<string, string>>,
  method: string,
  path: string,
): boolean {
  if (!entry.request?.methods.includes(method.toUpperCase())) return false;
  const p = path.split('?')[0] ?? '';
  return resolveRequestPrefixes(entry, fields).some((prefix) => p.startsWith(prefix) || `${p}/` === prefix);
}

/* Socket methods (0.97, CT-472; CM-14, CM-16) -------------------------------------------------- */

function wholeName(patterns: readonly string[], method: string): boolean {
  return patterns.some((p) => new RegExp(`^(?:${p})$`, 'i').test(method));
}

/** Whether a socket method only reads (CM-14): it matches one of the entry's `reads`; anything else is a write. */
export function socketReads(entry: CatalogEntry, method: string): boolean {
  return entry.socket !== null && !socketRefused(entry, method) && wholeName(entry.socket.reads, method);
}

/** Whether a socket method streams events until its result (ESPHome's `devices/logs`), read for `seconds`. */
export function socketStreams(entry: CatalogEntry, method: string): boolean {
  return entry.socket !== null && wholeName(entry.socket.streams, method);
}

/** Whether a socket method is never sent (CM-16): signing in again, subscriptions that never end, internals. */
export function socketRefused(entry: CatalogEntry, method: string): boolean {
  return entry.socket === null || wholeName(entry.socket.refused, method);
}

/** What an agent hears for a socket method Whombat never sends (CM-16). */
export function socketRefusedText(method: string, connectionLabel: string): string {
  return `${method} can’t be called through ${connectionLabel}: Whombat signs in itself, and calls that never end aren’t sent.`;
}

/**
 * The `call` tool's definition on a socket connection (CT-472; stored and hashed like any tool): one method of the
 * service's API at the connection's address, its reads and streams named so the agent knows what runs at once.
 */
export function socketToolDef(
  entry: CatalogEntry,
  baseUrl: string,
): { name: string; description: string; inputSchema: JsonObject; access: ConnectionToolAccess } {
  const spec = entry.socket;
  const what = spec?.dialect === 'esphome' ? 'command' : 'JSON-RPC method';
  const params: JsonObject =
    spec?.dialect === 'esphome'
      ? { type: 'object', description: 'The command’s args, as an object' }
      : {
          description: 'The method’s params: an array (positional, the usual) or an object',
          anyOf: [{ type: 'array' }, { type: 'object' }],
        };
  const description = [
    `One ${what} of ${entry.name} at ${baseUrl}, over its WebSocket API; Whombat signs in.`,
    // The reads are patterns; the guide names them in words, so the description doesn't spell out regular expressions.
    'Reads, as the guide names them, run at once; other methods follow this tool’s setting.',
    spec?.streams.length
      ? `Streams (${spec.streams.map((r) => r.replace(/\\/g, '')).join(', ')}) are read for seconds (default ${SOCKET_STREAM_SECONDS_DEFAULT}, at most ${SOCKET_STREAM_SECONDS_MAX}).`
      : '',
    'JSON answers up to 64 KB.',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 1000);
  const inputSchema: JsonObject = {
    type: 'object',
    properties: {
      method: { type: 'string', description: `The ${what}’s name` },
      params,
      seconds: {
        type: 'integer',
        minimum: 1,
        maximum: SOCKET_STREAM_SECONDS_MAX,
        description: `Only for a streaming method: how long to read its events (default ${SOCKET_STREAM_SECONDS_DEFAULT})`,
      },
    },
    required: ['method'],
    additionalProperties: false,
  };
  return { name: SOCKET_TOOL_NAME, description, inputSchema, access: 'write' };
}

/* An MCP server's tools as the entry corrects them (Whombat t3code.md T3-04) ----------------------------------------- */

/** Whether a pattern of `mcpTools` names the whole tool name (case-insensitively). */
function namesTool(pattern: string, name: string): boolean {
  return new RegExp(`^(?:${pattern})$`, 'i').test(name);
}

/** Whether the entry never serves this MCP tool (`mcpTools.hidden`: T3 Code's tools for its own threads only). */
export function mcpToolHidden(entry: Pick<CatalogEntry, 'mcpTools'>, name: string): boolean {
  return entry.mcpTools?.hidden.some((p) => namesTool(p, name)) ?? false;
}

/** Whether every call of this MCP tool reads (`mcpTools.reads` without an argument): its listed access is `read`. */
export function mcpToolReads(entry: Pick<CatalogEntry, 'mcpTools'>, name: string): boolean {
  return entry.mcpTools?.reads.some((r) => r.arg === undefined && namesTool(r.name, name)) ?? false;
}

/**
 * Whether some calls of this MCP tool read by their arguments (`mcpTools.reads` with `arg`): it holds reads and writes
 * in one, like `request`, so its reads run on a connection that looks only and while the tool asks.
 */
export function mcpToolReadsByArgs(entry: Pick<CatalogEntry, 'mcpTools'>, name: string): boolean {
  return entry.mcpTools?.reads.some((r) => r.arg !== undefined && namesTool(r.name, name)) ?? false;
}

/** Whether this call of an MCP tool reads by its arguments (`mcpTools.reads` with `arg`: an `action` of `list`). */
export function mcpCallReads(
  entry: Pick<CatalogEntry, 'mcpTools'>,
  name: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  return (
    entry.mcpTools?.reads.some((r) => {
      if (!namesTool(r.name, name)) return false;
      if (r.arg === undefined) return true;
      const value = args[r.arg];
      if (typeof value !== 'string') return false;
      return r.values === undefined || r.values.includes(value);
    }) ?? false
  );
}

/**
 * The access of one call: a typed tool's, a `request`'s by method, path and query, a socket `call`'s by its method
 * (0.97), an MCP tool's as listed unless the entry says a call of it reads (`mcpTools.reads`, T3-04).
 */
export function callAccess(
  entry: CatalogEntry,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  listedAccess: ConnectionToolAccess = 'write',
): ConnectionToolAccess {
  if (tool === REQUEST_TOOL_NAME && entry.request) {
    const method = typeof args.method === 'string' ? args.method : 'POST';
    const path = typeof args.path === 'string' ? args.path : '';
    return isReadRequest(entry, method, path, args.body, args.query) ? 'read' : 'write';
  }
  if (tool === SOCKET_TOOL_NAME && entry.socket)
    return typeof args.method === 'string' && socketReads(entry, args.method) ? 'read' : 'write';
  if (entry.transport === 'mcp' && mcpCallReads(entry, tool, args)) return 'read';
  return entry.tools.find((t) => t.name === tool)?.access ?? listedAccess;
}

/** The catalog key a call needs (CX-20): `connections.read` for a read, `connections.write` for anything else. */
export function connectionCallKey(access: ConnectionToolAccess): 'connections.read' | 'connections.write' {
  return access === 'read' ? 'connections.read' : 'connections.write';
}

/* Sensitive calls (CX-31) ----------------------------------------------------------------------- */

function glob(pattern: string, name: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`).test(name);
}

function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || out.length > 2000) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out, depth + 1);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) strings(v, out, depth + 1);
  return out;
}

/** Whether a request body (a JSON value, or its JSON text) holds a value at a path (CT-475): `equals`, or any. */
function bodyHolds(body: unknown, want: NonNullable<SensitiveRule['body']>): boolean {
  let value = body;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  const found = jsonPathValues(value, want.path);
  if (want.equals === undefined) return found.length > 0;
  return found.some((v) =>
    typeof v === 'string' && typeof want.equals === 'string'
      ? v.toLowerCase() === want.equals.toLowerCase()
      : v === want.equals,
  );
}

function ruleMatches(rule: SensitiveRule, tool: string, args: Readonly<Record<string, unknown>>): boolean {
  if (rule.tools && !rule.tools.some((t) => glob(t, tool))) return false;
  if (rule.name && !re(rule.name).test(tool)) return false;
  if (rule.methods || rule.path || rule.body) {
    if (tool !== REQUEST_TOOL_NAME) return false;
    const method = typeof args.method === 'string' ? args.method.toUpperCase() : '';
    const path = typeof args.path === 'string' ? (args.path.split('?')[0] ?? '') : '';
    if (rule.methods && !rule.methods.includes(method)) return false;
    if (rule.path && !re(rule.path).test(path)) return false;
    if (rule.body && !bodyHolds(args.body, rule.body)) return false;
  }
  if (rule.argValue) {
    const pattern = re(rule.argValue);
    const values = rule.arg === undefined ? strings(args) : strings(args[rule.arg]);
    if (!values.some((s) => pattern.test(s))) return false;
  }
  return true;
}

/**
 * A tool named for deleting (CT-311): `delete_page`, `files_remove`, `EraseEverything`, `HassShoppingListRemoveItem`.
 * Camel case is split first, so “RemoveItem” counts; “Timeremover” and `list_deleted` don't.
 */
export function deletesByName(tool: string): boolean {
  const words = tool.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return /(^|[^a-z])(delete|remove|destroy|erase|purge|wipe|trash)([^a-z]|$)/i.test(words);
}

/**
 * Why a call always asks a person (CX-31), or null: a typed tool marked sensitive, a tool named for deleting
 * (`deletesByName`), any `DELETE` request, a socket method named for deleting (0.97), or one of the entry's rules
 * (a socket entry's on the method: `tools: ['call'], arg: 'method'`). Since 0.58 (CT-311) an MCP server's
 * `destructiveHint` alone doesn't ask: servers set it on nearly every action (Home Assistant on turning on a light);
 * and a call the caller knows only reads (`hints.access: 'read'`) skips the rules on its arguments, so reading a lock's
 * state doesn't ask.
 */
export function sensitiveReason(
  entry: CatalogEntry,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  /** `destructive`: @deprecated 0.58 (CT-311), ignored. */
  hints: { destructive?: boolean; access?: ConnectionToolAccess } = {},
): string | null {
  if (entry.tools.find((t) => t.name === tool)?.sensitive) return 'Always asks';
  if (deletesByName(tool)) return 'Deletes something';
  if (tool === REQUEST_TOOL_NAME && typeof args.method === 'string' && args.method.toUpperCase() === 'DELETE')
    return 'Deletes something';
  // A socket method named for deleting (0.97, CT-472): `pool.dataset.delete`, `devices/delete`, `disk.wipe`.
  if (
    tool === SOCKET_TOOL_NAME &&
    entry.socket &&
    typeof args.method === 'string' &&
    deletesByName(args.method)
  )
    return 'Deletes something';
  const rules =
    hints.access === 'read' ? entry.sensitive.filter((r) => !r.argValue || r.onReads) : entry.sensitive;
  return rules.find((r) => ruleMatches(r, tool, args))?.reason ?? null;
}

/** Whether a call always asks a person (CX-31). */
export function isSensitiveCall(
  entry: CatalogEntry,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  hints: { destructive?: boolean; access?: ConnectionToolAccess } = {},
): boolean {
  return sensitiveReason(entry, tool, args, hints) !== null;
}

/** Whether a `request` call always asks a person (CX-31): `DELETE`, or a rule on its method and path. */
export function isSensitiveRequest(entry: CatalogEntry, method: string, path: string): boolean {
  return isSensitiveCall(entry, REQUEST_TOOL_NAME, { method, path });
}

/**
 * Whether a tool always asks, for the tools list's “Always asks” mark (CX-72): a typed tool marked so, a tool named for
 * deleting, or a rule that names the tool (or any tool) without looking at arguments. Rules that depend on arguments
 * mark nothing: those calls ask only when their arguments match.
 */
export function toolAlwaysAsks(entry: CatalogEntry, tool: string): boolean {
  if (entry.tools.find((t) => t.name === tool)?.sensitive) return true;
  if (deletesByName(tool)) return true;
  return entry.sensitive.some(
    (r) =>
      !r.argValue &&
      !r.methods &&
      !r.path &&
      !r.body &&
      (!r.tools || r.tools.some((t) => glob(t, tool))) &&
      (!r.name || re(r.name).test(tool)),
  );
}

/* Tiers (CX-20) --------------------------------------------------------------------------------- */

const TIER_RANK: Record<ConnectionToolTier, number> = { off: 0, ask: 1, can: 2 };

/**
 * A `request` call's tool tier (CX-33): the `request` tool's tier covers writes; a read is Allowed unless the tool is
 * Off.
 */
export function requestCallTier(
  toolTier: ConnectionToolTier,
  access: ConnectionToolAccess,
): ConnectionToolTier {
  if (toolTier === 'off') return 'off';
  return access === 'read' ? 'can' : toolTier;
}

/**
 * The tier a call runs at (CX-20, CX-31): the stricter of the agent's key (`cannot` is Off) and the tool's tier; a
 * sensitive call asks whatever both say, unless either is Off.
 */
export function effectiveTier(
  keyTier: Tier,
  toolTier: ConnectionToolTier,
  sensitive: boolean,
): ConnectionToolTier {
  const key: ConnectionToolTier = keyTier === 'cannot' ? 'off' : keyTier;
  const stricter = TIER_RANK[key] <= TIER_RANK[toolTier] ? key : toolTier;
  if (stricter === 'off') return 'off';
  return sensitive ? 'ask' : stricter;
}

/**
 * A call on a connection that looks only (CT-314): a write is Off, whatever the tiers and the key; a read runs at its
 * tier.
 */
export function accessTier(
  level: ConnectionAccessLevel,
  call: ConnectionToolAccess,
  tier: ConnectionToolTier,
): ConnectionToolTier {
  return level === 'read' && call === 'write' ? 'off' : tier;
}

/** What an agent hears when it tries to change something through a connection that looks only (CT-314). */
export function lookOnlyText(connectionLabel: string): string {
  return `${connectionLabel} is set up to look only: the agent can read through it but not change anything. A person can switch it to Manage in Settings → Connections.`;
}

/** What an agent hears when a tool is Off (CX-20): “HassTurnOn is turned off for Home Assistant · home.lan.” */
export function toolOffText(tool: string, connectionLabel: string): string {
  return `${tool} is turned off for ${connectionLabel}.`;
}

/**
 * A connection's line in an agent's instructions (CX-35; since 3.0, CT-1551, one kind of connection: nothing says whose
 * it is): “homeassistant — Home Assistant · home.lan. Use connection_tools to see what it can do.”, with “(look only)”
 * after the label for a connection that looks only.
 */
export function connectionPromptLine(c: {
  handle: string;
  label: string;
  status: 'active' | 'needs_reauth' | 'error';
  access?: ConnectionAccessLevel;
}): string {
  const name = c.access === 'read' ? `${c.label} (look only)` : c.label;
  if (c.status !== 'active') return `${c.handle} — ${name} needs signing in again in Settings → Connections.`;
  return `${c.handle} — ${name}. Use connection_tools to see what it can do.`;
}

/* ---------------------------------------------------------------------------------------------- */
/* Views                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

/** A catalog connection's state (CX-15, CX-72). */
export const CATALOG_CONNECTION_STATES = ['active', 'needs_reauth', 'error'] as const;
export const CatalogConnectionState = z.enum(CATALOG_CONNECTION_STATES);
export type CatalogConnectionState = z.infer<typeof CatalogConnectionState>;

/** Why it needs connecting again (CX-15): the token was refused or revoked, the admin's app was removed, it expired. */
export const CatalogReauthReason = z.enum(['token_invalid', 'revoked', 'app_removed', 'expired']);
export type CatalogReauthReason = z.infer<typeof CatalogReauthReason>;

/** One line of a connection's last check (CX-72): the credential, the MCP server, the address. */
export const CatalogCheckResult = z.object({
  id: z.enum(['credential', 'mcp', 'destination', 'tools']),
  state: z.enum(['ok', 'warning', 'error']),
  message: z.string().max(500).nullable(),
});
export type CatalogCheckResult = z.infer<typeof CatalogCheckResult>;

/**
 * A connection as Settings → Connections shows it (CX-70, CX-72). Secrets never leave the server. Since 3.0 (CT-1550)
 * there is one kind: every connection is this Whombat's, the person changes and removes any of them.
 */
export const ConnectionView = z.object({
  id: ConnectionId,
  catalogId: CatalogIdText,
  label: z.string().max(CONNECTION_LABEL_MAX),
  handle: ConnectionHandle,
  /** Who connected it (“Connected by Mara”); `id` null when that principal is gone. */
  connectedBy: z.object({ id: PrincipalId.nullable(), name: z.string().max(200) }),
  /** The row's detail: the host or the account (“home.lan:8123”, “mara@example.com”); null when there is none. */
  detail: z.string().max(300).nullable(),
  signIn: SignInKind,
  transport: ConnectionTransport,
  /** The form's non-secret values (CX-17); a Custom API's guide too. */
  fields: z.record(z.string(), z.string().max(CONNECTION_FIELD_VALUE_MAX)),
  status: CatalogConnectionState,
  reauthReason: CatalogReauthReason.nullable(),
  checks: z.array(CatalogCheckResult),
  checkedAt: Timestamp.nullable(),
  toolCount: z.number().int().min(0),
  /** What agents may do with it (CT-314); absent: `manage`. */
  access: ConnectionAccessLevel.default('manage'),
  /**
   * What an agent needed and the service hasn't allowed yet (an OAuth scope, Cloudflare's `dns.write`): the page offers
   * to allow it at the service, everything allowed before staying. Empty or absent (older runtimes): nothing waits.
   */
  permissionAsked: z.array(z.string().max(200)).max(20).optional(),
  /**
   * How the poller that reads it for automations is doing (0.69, CT-325; Whombat report-trackers.md TA-03, TA-05):
   * its last check, its last success and, when the last check failed for another reason than a refused token (that
   * shows as “Needs a new token”, `status`), what went wrong (“couldn't reach Acme Desk”). Set only for an entry only
   * automations use (`isAgentConnection` false) while an automation listens to it; null otherwise and from older
   * runtimes.
   */
  poller: z
    .object({
      checkedAt: Timestamp.nullable(),
      succeededAt: Timestamp.nullable(),
      problem: z.string().max(500).nullable(),
      /**
       * Which installation it is and the version it runs, from its `/v1/health` (0.75, CT-331; Whombat
       * report-trackers.md TA-32: “Development · Acme Desk 0.1.174”). Null before the first read.
       */
      environment: TrackerEnvironment.nullable().default(null),
      version: z.string().max(100).nullable().default(null),
    })
    .nullable()
    .default(null),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
});
export type ConnectionView = z.infer<typeof ConnectionView>;

/** One of a connection's tools as the connection page shows it (CX-72) and `connection_tools` lists it (CX-30). */
export const ConnectionToolView = z.object({
  name: z.string().min(1).max(200),
  /** The service's own words, as data (scrubbed like Vault MCP tools). */
  description: z.string().max(1000),
  access: ConnectionToolAccess,
  tier: ConnectionToolTier,
  /** Always asks (CX-31): “Always asks”. */
  sensitive: z.boolean(),
  /** New or changed since the last check (CX-18): “New”. */
  isNew: z.boolean(),
  inputSchema: JsonObject.optional(),
  /**
   * The person's limits on its arguments (0.80, CT-341; one-whombat.md ONE-18): checked before the keys decision, a call
   * outside them is refused in plain words. Null or absent: none.
   */
  limits: ConnectionToolLimits.nullable().optional(),
});
export type ConnectionToolView = z.infer<typeof ConnectionToolView>;

/** The OAuth app an admin registered for an `app_oauth` entry (CX-14). The secret never leaves the server. */
export const CatalogAppStatus = z.object({
  configured: z.boolean(),
  source: z.enum(['settings', 'config']).nullable(),
  clientIdHint: z.string().max(40).nullable(),
  secretSet: z.boolean(),
  /** What to paste into the provider's console. */
  redirectUri: z.string().url(),
  updatedAt: Timestamp.nullable(),
});
export type CatalogAppStatus = z.infer<typeof CatalogAppStatus>;

/** Whether an entry can be connected on this Whombat (CX-14): an `app_oauth` entry needs its app. */
export const CatalogEntryStatus = z.object({
  catalogId: CatalogIdText,
  available: z.boolean(),
  /**
   * Why not: `app_not_configured` (its app isn't registered yet), `off` (this Whombat turned connections off),
   * `no_driver` (a report tracker without a driver installed here: the apps don't offer it). Since 4.5 (Whombat
   * whombat-link.md LNK-16): `needs_secure_address` (its sign-in must come back to a secure address this Whombat
   * doesn't have yet: Whombat Link, or Tailscale with HTTPS), `hosted_only` (its sign-in is registered on the hosted
   * page only, which this Whombat doesn't use). An older app reads a newer reason as null.
   */
  reason: z
    .enum(['app_not_configured', 'off', 'no_driver', 'needs_secure_address', 'hosted_only'])
    .nullable(),
  /** `app_oauth` entries only. */
  app: CatalogAppStatus.optional(),
});
export type CatalogEntryStatus = z.infer<typeof CatalogEntryStatus>;

/** `connections.catalog`: which entries this Whombat offers (CX-14, CX-75). */
export const ConnectionsCatalogStatus = z.object({
  /** `real`, `fake` (tests and the dev box: no provider is called) or `off`. */
  mode: z.enum(['real', 'fake', 'off']),
  entries: z.array(CatalogEntryStatus),
  /** The most connections this Whombat keeps (`CONNECTIONS_MAX`). */
  limit: z.number().int().min(0),
});
export type ConnectionsCatalogStatus = z.infer<typeof ConnectionsCatalogStatus>;

/**
 * A connection an agent can see, for its instructions (CX-35, `DispatchContext.connections`): handle, entry, name and
 * label, and its state. Never a field value or a secret, and never a connection no agent uses (`isAgentConnection`:
 * only automations, 0.69; an AI gateway, 0.76).
 */
export const DispatchConnection = z.object({
  handle: ConnectionHandle,
  catalogId: CatalogIdText,
  /** The entry's name (“Home Assistant”). */
  name: z.string().max(40),
  label: z.string().max(CONNECTION_LABEL_MAX),
  status: CatalogConnectionState,
  /** Look only or manage (CT-314); absent: `manage`. */
  access: ConnectionAccessLevel.optional(),
});
export type DispatchConnection = z.infer<typeof DispatchConnection>;

/** Whether a check's answer holds one of its `okAnswer` values (0.110, CT-709): true without one. */
export function checkAnswerOk(check: CatalogCheck, body: string): boolean {
  return check.kind !== 'request' || !check.okAnswer || sessionAnswerMatches(check.okAnswer, body);
}
