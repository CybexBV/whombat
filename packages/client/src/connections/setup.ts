/**
 * Setting up a connection (Whombat connections-setup.md CS-50, CS-51; contracts 0.61.0, CT-314; app AP-843…): the
 * connect form's steps, what an identified address says, the guided token's values, links and paste box, the access
 * levels, and Found on your network's progress and rows (connected ones left out and hidden ones apart: CS-52, CS-53;
 * contracts 0.63.0, CT-316; app AP-871…). Pure: the components and the tests read it.
 */
import type { ConnectionDiscovery, IdentifyConnectionResponse } from '@whombat/core/contracts';
import {
  accessText,
  type CatalogEntry,
  type CatalogSignIn,
  CONNECTION_ACCESS_LABELS,
  type ConnectionAccessLevel,
  catalogEntry,
  FOUND_SERVER_ID,
  FOUND_SERVER_TAGLINE,
  fillTemplate,
  foundServerName,
  isAgentConnection,
  pasteValues,
  resolveTokenUrl,
} from '@whombat/core/domain';
import { CONNECT_FORM_TEXT } from './draft';
import type { SignInChoice } from './form';
import { codeSignInOf, type SecretWords, secretWord } from './signInAgain';
import { type ConnectionWords, connectionWords } from './words';

/* The steps (CS-50) ------------------------------------------------------------------------------- */

export type SetupStep = 'where' | 'signIn' | 'access';

/** The step titles, in the form's words. */
export const SETUP_STEP_TITLES: Record<SetupStep, string> = {
  where: 'Where is it?',
  signIn: 'How should Whombat sign in?',
  access: 'What may your agent do?',
};

/** The sign-in step of an entry read through a Mac (Find My): nothing to sign in to, only how it reads. */
export const READ_THROUGH_MAC_STEP_TITLE = 'How should Whombat read it?';

/** The sign-in step of an entry without an address and nothing to sign in to (“Website or address”): what it checks. */
export const WHAT_TO_CHECK_STEP_TITLE = 'What should Whombat check?';

/**
 * A step's title for this entry: an entry checked through a Mac (Find My) has nothing to sign in to, so its sign-in
 * step asks how Whombat reads it; one with neither an address nor a sign-in asks what Whombat checks. `access` is the
 * caller's, by the assistant's name.
 */
export function setupStepTitle(
  entry: Pick<CatalogEntry, 'check' | 'signIn' | 'fields'>,
  step: Exclude<SetupStep, 'access'>,
): string {
  if (step !== 'signIn') return SETUP_STEP_TITLES[step];
  if (entry.check?.kind === 'mac') return READ_THROUGH_MAC_STEP_TITLE;
  const nothingToSignIn = entry.signIn.length > 0 && entry.signIn.every((m) => m.kind === 'none');
  if (nothingToSignIn && !entry.fields.some((f) => f.id === 'url')) return WHAT_TO_CHECK_STEP_TITLE;
  return SETUP_STEP_TITLES[step];
}

/** Whether the entry is somewhere on the person's network or server (it has an address): cloud services have none. */
export function hasAddress(entry: CatalogEntry): boolean {
  return entry.fields.some((f) => f.id === 'url');
}

/**
 * Whether Whombat identifies the address before the rest of the form (`connections.identify`, CS-13): every entry with an
 * address except the Custom ones (a Custom MCP server has its own “Check the address”, CX-61).
 */
export function identifies(entry: CatalogEntry): boolean {
  return hasAddress(entry) && entry.category !== 'custom';
}

/**
 * The sign-ins that take `access` (CT-314): `connections.create`'s, and signing in on the service's own page, whose start
 * carries the level (contracts 0.111 CT-738; AP-3903). Another sign-in elsewhere connects at Manage: Nextcloud's login is
 * set to the level once it connects, an OAuth sign-in is set on the connection's page.
 */
export function asksAccess(choice: Pick<SignInChoice, 'kind'>): boolean {
  return (
    choice.kind === 'token' ||
    choice.kind === 'none' ||
    choice.kind === 'password' ||
    choice.kind === 'client_credentials' ||
    choice.kind === 'service_login'
  );
}

/**
 * The form's steps for this entry (CS-50): Where is it? only with an address; then What may agents do?, then How should
 * Whombat sign in? — the level comes before the sign-in because both ways of signing in depend on it: sign in once asks
 * the service for a key at that level (CS-07), and the guided token's link and steps make one for it (CS-15, AP-844).
 * An entry only automations use (a report tracker, Whombat TA-02) has no level to choose: agents never use it.
 */
export function setupSteps(entry: CatalogEntry): SetupStep[] {
  // Nothing to choose when both levels let the assistant do the same (“Website or address” only reads).
  const same = !!entry.access && entry.access.read === entry.access.manage;
  const access: SetupStep[] = isAgentConnection(entry) && !same ? ['access'] : [];
  return hasAddress(entry) ? ['where', ...access, 'signIn'] : [...access, 'signIn'];
}

/**
 * The name field's help: how agents see it, or — only automations using it (TA-02) — how automations name it; an AI
 * gateway's names its switches and its part of Usage; the Vault's sync (1Password) is named only here.
 */
export function nameHelp(
  entry: CatalogEntry,
  words: Pick<ConnectionWords, 'nameHelp'> = connectionWords(undefined),
): string {
  if (entry.use === 'gateway')
    return 'How it’s listed here, in its switches and in Usage. You can change it later.';
  if (entry.use === 'vault') return 'How it’s listed here. You can change it later.';
  return isAgentConnection(entry)
    ? words.nameHelp
    : 'How it’s listed here and in automations. You can change it later.';
}

/* Where is it? (CS-13) ---------------------------------------------------------------------------- */

export interface IdentifyNote {
  tone: 'ok' | 'warn' | 'bad';
  /** “Proxmox VE 9.0.10”, or what was found instead. */
  title: string;
  text: string;
}

/** What `connections.identify` found, in two lines (CS-50): recognised, something else, or nothing answering. */
export function identifyNote(entry: CatalogEntry, found: IdentifyConnectionResponse): IdentifyNote {
  const server = found.message ? ` ${found.message}` : '';
  if (!found.reachable)
    return {
      tone: 'bad',
      title: 'Nothing answered',
      text: `Whombat couldn’t reach ${found.url}.${server || ' Check the address and that it’s switched on.'}`,
    };
  if (found.catalogId === entry.id)
    return {
      tone: 'ok',
      title: found.version ? `${entry.name} ${found.version}` : entry.name,
      text: `Found at ${found.url}.`,
    };
  const other = found.catalogId ? catalogEntry(found.catalogId) : null;
  if (other)
    return {
      tone: 'warn',
      title: `This looks like ${other.name}`,
      text: `${found.url} answers like ${other.name}, not ${entry.name}. Check the address and the port.`,
    };
  // An entry Whombat has no probes for can't be recognised: that it answers is all there is to say.
  if (!entry.discovery) return { tone: 'ok', title: 'It answers', text: `Whombat reaches ${found.url}.` };
  return {
    tone: 'warn',
    title: 'Something else answers here',
    text: `${found.url} doesn’t look like ${entry.name}.${server || ' Check the address and the port, or go on if you’re sure.'}`,
  };
}

/**
 * Where the person finds the certificate's fingerprint in the service, from the entry's fingerprint field (“Proxmox →
 * node → System → Certificates”); null for an entry that can't pin a certificate.
 */
export function fingerprintWhere(entry: CatalogEntry): string | null {
  const field = entry.fields.find((f) => f.id === 'fingerprint');
  if (!field) return null;
  return /fingerprint \(([^)]+)\)/.exec(field.help)?.[1] ?? null;
}

/**
 * The fields once the address is identified: its address, and the certificate a home-network server made for itself
 * trusted at once (Whombat docs/decisions/connections-setup.md; an internet address with such a certificate is refused
 * before this). A fingerprint already typed stays.
 */
export function identifiedFields(
  entry: CatalogEntry,
  fields: Readonly<Record<string, string>>,
  found: Pick<IdentifyConnectionResponse, 'url' | 'certificate'>,
): Record<string, string> {
  const next: Record<string, string> = { ...fields, url: found.url };
  const cert = found.certificate;
  if (
    cert &&
    !cert.trusted &&
    entry.fields.some((f) => f.id === 'fingerprint') &&
    !fields.fingerprint?.trim()
  )
    next.fingerprint = cert.sha256;
  return next;
}

/** “Compare it with what Proxmox VE shows (Proxmox → node → System → Certificates), then trust it.” */
export function trustText(entry: CatalogEntry): string {
  const where = fingerprintWhere(entry);
  return `Compare it with what ${entry.name} shows${where ? ` (${where})` : ''}, then trust it.`;
}

/* How should Whombat sign in? (CS-15) ------------------------------------------------------------- */

/**
 * The first sign-in is the recommended one when it makes Whombat's own lasting key: sign in once, an OAuth client, or
 * signing in on the service's own page (Plex's, which handles two-step codes and Google or Apple accounts; AP-3904).
 */
export function recommended(choice: Pick<SignInChoice, 'index' | 'kind'>): boolean {
  return (
    choice.index === 0 &&
    (choice.kind === 'password' || choice.kind === 'client_credentials' || choice.kind === 'service_login')
  );
}

/**
 * Looking only with a sign-in elsewhere (CT-314: `startOAuth` and `startNextcloud` take no level): what happens to the
 * level. Null when the sign-in takes it (the service's own page does, CT-738), or the level is Manage.
 */
export function elsewhereLevelNote(
  entry: CatalogEntry,
  choice: Pick<SignInChoice, 'kind'>,
  level: ConnectionAccessLevel,
): string | null {
  if (level !== 'read' || asksAccess(choice)) return null;
  return choice.kind === 'nextcloud_login'
    ? 'Whombat sets it to Look only as soon as Nextcloud lets it in.'
    : `Signing in at ${entry.name} connects it to manage: set it to Look only on its page afterwards.`;
}

type GuidedMethod = Extract<CatalogSignIn, { kind: 'token' | 'client_credentials' }>;

/** A sign-in's line on its radio card. */
export function signInNote(entry: CatalogEntry, method: CatalogSignIn): string {
  switch (method.kind) {
    case 'password':
      return method.creates;
    case 'token':
      return method.steps.length
        ? `Make it in ${entry.name} with the steps below, then paste it here.`
        : method.secretHelp;
    case 'client_credentials':
      return method.secretHelp;
    case 'nextcloud_login':
      return 'Log in to Nextcloud in a new tab and grant access.';
    case 'service_login':
      // The entry's own sentence (SG-05): “Sign in to Plex in a new tab and allow Whombat.”
      return method.note;
    case 'none':
      return 'The server needs no sign-in.';
    default:
      return `Sign in at ${entry.name} and allow access.`;
  }
}

/** One value to copy in a guided step, its template filled from the form's fields (`{url}`). */
export interface StepValue {
  label: string;
  value: string;
}

/**
 * The guided token's steps (or a secret's own, T3 Code's pairing code's) with their values filled (CS-15); a value whose
 * field is still empty stays as written.
 */
export function guidedSteps(
  entry: CatalogEntry,
  method: Pick<GuidedMethod, 'steps'> | Pick<SecretWords, 'steps'>,
  fields: Readonly<Record<string, string>>,
): { text: string; values: StepValue[] }[] {
  return method.steps.map((step) => ({
    text: step.text,
    values: (step.values ?? []).map((v) => ({
      label: v.label,
      value: fillTemplate(entry, v.value, fields) ?? v.value,
    })),
  }));
}

/**
 * Where the key is made (CS-15): the level's link when the service fills its form from it (Cloudflare's permissions,
 * GitLab's scopes), else the entry's `tokenUrl`; null while a field the link needs is empty.
 */
export function guidedLink(
  entry: CatalogEntry,
  method: GuidedMethod,
  level: ConnectionAccessLevel,
  fields: Readonly<Record<string, string>>,
): string | null {
  const link = method.kind === 'token' ? method.links?.[level] : undefined;
  return link ? fillTemplate(entry, link, fields) : resolveTokenUrl(entry, fields);
}

/** What a paste filled: field values by id, the secret, and their labels in the form's words. */
export interface PasteFill {
  fields: Record<string, string>;
  secret: string | null;
  filled: string[];
}

/**
 * A pasted block or a dropped file (CS-15): the method's paste patterns fill the fields and the secret
 * (`pasteValues`); text none of them matches is taken as the secret itself when it is one word (a token), else null
 * (nothing to fill).
 */
export function readPaste(entry: CatalogEntry, method: GuidedMethod, text: string): PasteFill | null {
  const found = pasteValues(method, text);
  const word = text.trim();
  if (Object.keys(found).length === 0) {
    if (!word || /\s/.test(word)) return null;
    return { fields: {}, secret: word, filled: [method.secretLabel] };
  }
  const fields: Record<string, string> = {};
  const filled: string[] = [];
  for (const f of entry.fields) {
    const value = found[f.id];
    if (value) {
      fields[f.id] = value;
      filled.push(f.label);
    }
  }
  const secret = found.secret ?? null;
  if (secret) filled.push(method.secretLabel);
  return filled.length ? { fields, secret, filled } : null;
}

/** “Filled in Token ID and Secret.” */
export function filledText(labels: readonly string[]): string {
  const list =
    labels.length <= 1
      ? (labels[0] ?? '')
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  return `Filled in ${list}.`;
}

/** The paste box's label (CS-15): “Paste what Proxmox VE shows, or drop the file”. */
export function pasteLabel(entry: CatalogEntry): string {
  return `Paste what ${entry.name} shows, or drop the file`;
}

/**
 * Whether the guided steps end in the paste box (CS-15): not for a password Whombat signs in with for a session
 * (Nginx Proxy Manager, Synology, QNAP; AP-3807) — the person chose it, the service shows nothing to paste — unless the
 * sign-in has paste patterns of its own.
 */
export function takesPaste(method: GuidedMethod): boolean {
  return method.paste.length > 0 || !(method.kind === 'token' && method.auth.type === 'session');
}

/** The guided steps' name for assistive technology: “Making the token secret”, or for a session “Making a user for Whombat”. */
export function guideLabel(method: GuidedMethod): string {
  return method.kind === 'token' && method.auth.type === 'session'
    ? 'Making a user for Whombat'
    : CONNECT_FORM_TEXT.making(method.secretLabel);
}

/* What may agents do? (CS-10) --------------------------------------------------------------------- */

export interface AccessChoice {
  value: ConnectionAccessLevel;
  label: string;
  text: string;
}

/** Look only, then Manage, each with what it means for this service (`accessText`). */
export function accessChoices(entry: CatalogEntry): AccessChoice[] {
  return (['read', 'manage'] as const).map((value) => ({
    value,
    label: CONNECTION_ACCESS_LABELS[value],
    text: accessText(entry, value),
  }));
}

/**
 * Sign in once with a service that can't limit a key (CS-07, `serviceLimits: false`): Whombat holds agents to the level
 * itself. Null where the service limits the key, or for another sign-in.
 */
export function limitNote(
  entry: CatalogEntry,
  method: CatalogSignIn,
  words: Pick<ConnectionWords, 'limitNote'> = connectionWords(undefined),
): string | null {
  if (method.kind !== 'password' || method.serviceLimits) return null;
  return words.limitNote(entry.name);
}

/**
 * Raising a connection to Manage (CS-11): where sign in once asks the service for a key at the level
 * (`serviceLimits`), a key made to look only stays that way. Null where Whombat alone keeps the level.
 */
export function raiseNote(entry: CatalogEntry): string | null {
  const once = entry.signIn.find((m) => m.kind === 'password');
  if (once?.kind !== 'password' || !once.serviceLimits) return null;
  // A sign-in with a code signs this connection in again below (T3 Code's pairing code), never with a new connection.
  if (codeSignInOf(entry) === once)
    return `If Whombat signed in at Look only, ${entry.name} itself keeps it to looking. Sign in again below with a new ${secretWord(once)} to manage.`;
  return `If this key was made by signing in once at Look only, ${entry.name} itself keeps it to looking. Sign in again to make one that can manage.`;
}

/* Found on your network (CS-14, CS-51…CS-53) ------------------------------------------------------ */

/** How often a running scan is asked again. */
export const DISCOVERY_POLL_MS = 1_500;

/** The wait before asking again: while it scans; null once done (or idle). */
export function discoveryPollDelay(d: Pick<ConnectionDiscovery, 'state'> | null | undefined): number | null {
  return d?.state === 'scanning' ? DISCOVERY_POLL_MS : null;
}

/** 1016 → “1 016” (a no-break space, as the product writes numbers). */
export function groupDigits(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** “Looking at 312 of 1 016 addresses…”; before it knows how many, “Looking around your network…”. */
export function discoveryProgressText(d: Pick<ConnectionDiscovery, 'progress'>): string {
  const p = d.progress;
  if (!p || p.total === 0) return 'Looking around your network…';
  const total = groupDigits(p.total);
  return `Looking at ${groupDigits(Math.min(p.done, p.total))} of ${total} ${p.total === 1 ? 'address' : 'addresses'}…`;
}

/** One service found, as its row shows it. */
export interface FoundRow {
  key: string;
  catalogId: string;
  name: string;
  /** What it is to a person, in a few words (“Storage, Docker and VMs”; Whombat desk-found.md DF-08, AP-3802); null when
   * the entry has none (a runtime older than contracts 0.110). */
  tagline: string | null;
  version: string | null;
  url: string;
  /** A manager of the burrow hid it (CS-53): listed only when the hidden ones are shown, with Unhide. */
  hidden: boolean;
  /**
   * Its button (Whombat connect-in-chat.md): `connect` the connect page with the address filled in; `server` Add a
   * server with `serverAddress` filled in — a computer that answers SSH, or an entry Whombat looks after best as a
   * server (Proxmox VE, its Backup Server, Unraid).
   */
  action: 'connect' | 'server';
  /** The address Add a server opens with (the host, `:port` when SSH isn't on 22); null with `connect`. */
  serverAddress: string | null;
  /** The address as the row shows it: a found server's own address (not `ssh://`), else `url`. */
  where: string;
}

/** What the list shows of a scan's answer (CS-52, CS-53). */
export interface FoundList {
  /** The new ones, to connect or hide, in the scan's order. */
  rows: FoundRow[];
  /** The hidden ones, after the others when shown. */
  hidden: FoundRow[];
  /** How many found services are connected (or servers added) already (left out). */
  connected: number;
}

/** The address Add a server opens with for a find: its host, with `:port` from an `ssh://` address off 22. */
export function foundServerAddress(s: Pick<ConnectionDiscovery['found'][number], 'host' | 'url'>): string {
  const port = /^ssh:\/\/(?:\[[^\]]+\]|[^:/]+):(\d+)/.exec(s.url)?.[1];
  const host = s.host.includes(':') ? `[${s.host}]` : s.host;
  return port ? `${host}:${port}` : s.host;
}

/**
 * The found services the app knows (an entry of a newer runtime is skipped), in the scan's order. A connected one is
 * left out (CS-52: the caller's connection of that entry on that host, or a Custom API on that host and port), hidden
 * or not; a hidden one that isn't connected goes to `hidden` (CS-53).
 */
export function foundList(d: Pick<ConnectionDiscovery, 'found'>): FoundList {
  const list: FoundList = { rows: [], hidden: [], connected: 0 };
  for (const s of d.found) {
    const server = s.catalogId === FOUND_SERVER_ID;
    const entry = server ? null : catalogEntry(s.catalogId);
    if (!server && (!entry || entry.transport === 'builtin')) continue;
    // Connected, or already one of the Whombat's servers (a runtime before contracts' `serverIds` sends none).
    if (s.connectionIds.length > 0 || (s.serverIds?.length ?? 0) > 0) {
      list.connected += 1;
      continue;
    }
    const hidden = s.hidden === true;
    const asServer = server || entry?.asServer === true;
    const row: FoundRow = {
      key: `${s.catalogId}@${s.url}`,
      catalogId: s.catalogId,
      name: entry ? entry.name : foundServerName(s.version),
      tagline: entry ? taglineOf(entry) : FOUND_SERVER_TAGLINE,
      // A server's system is its name already.
      version: server ? null : s.version,
      url: s.url,
      hidden,
      action: asServer ? 'server' : 'connect',
      serverAddress: asServer ? foundServerAddress(s) : null,
      where: server ? foundServerAddress(s) : s.url,
    };
    (hidden ? list.hidden : list.rows).push(row);
  }
  return list;
}

/** The entry's short line on what it is (DF-08), when it has one. */
export function taglineOf(entry: Pick<CatalogEntry, 'tagline'>): string | null {
  return entry.tagline || null;
}

/**
 * The card's line when a done scan lists nothing new (null when it lists some): nothing it knows turned up, all of it is
 * connected, or all of it is connected or hidden.
 */
export function foundEmptyText(list: FoundList): string | null {
  if (list.rows.length > 0) return null;
  if (list.hidden.length > 0) return 'Everything Whombat found on your network is connected or hidden.';
  if (list.connected > 0) return 'Everything Whombat found on your network is connected already.';
  return 'Nothing Whombat knows how to connect turned up on your network.';
}

/** The footer's toggle for the hidden ones: “Show 2 hidden” / “Hide 2 hidden”. */
export function hiddenToggleText(count: number, shown: boolean): string {
  return `${shown ? 'Hide' : 'Show'} ${count} hidden`;
}

/** “Couldn’t hide that just now.” or, for Unhide, “Couldn’t show that again just now.” (CS-53). */
export function hideTroubleText(hidden: boolean): string {
  return hidden
    ? 'Couldn’t hide that just now. Try again in a moment.'
    : 'Couldn’t show that again just now. Try again in a moment.';
}

/** “Looked in 192.168.1.0/24 and 10.0.0.0/24.” */
export function networksText(networks: readonly string[]): string | null {
  if (networks.length === 0) return null;
  const list =
    networks.length === 1
      ? networks[0]
      : networks.length <= 3
        ? `${networks.slice(0, -1).join(', ')} and ${networks[networks.length - 1]}`
        : `${networks.slice(0, 2).join(', ')} and ${networks.length - 2} more networks`;
  return `Looked in ${list}`;
}

const PRIVATE = [
  [10, 0, 8],
  [172, 16, 12],
  [192, 168, 16],
] as const;

/**
 * A network to look in (CS-14): an IPv4 CIDR in a private range with at most 1 024 addresses. Null when fine, else what
 * to fix. The server checks again.
 */
export function cidrProblem(text: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(text.trim());
  if (!m) return 'Write it like 192.168.2.0/24.';
  const octets = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return 'Write it like 192.168.2.0/24.';
  if (prefix < 22) return `Look in at most ${groupDigits(1024)} addresses at a time: a /22 or smaller.`;
  const [a = 0, b = 0] = octets;
  const ip = (a << 24) | (b << 16);
  const inPrivate = PRIVATE.some(([pa, pb, bits]) => {
    const net = (pa << 24) | (pb << 16);
    const mask = (~0 << (32 - bits)) >>> 0;
    return (ip & mask) >>> 0 === (net & mask) >>> 0 && prefix >= bits;
  });
  return inPrivate ? null : 'Only home network addresses: 10.…, 172.16–31.… or 192.168.….';
}

/** The connect page for a found service, its address filled in (`?url=`, CS-51). */
export function foundSearch(catalogId: string, url: string) {
  return { tab: 'connections' as const, connection: catalogId, url };
}

/**
 * The connect page of an entry Whombat looks after best as a server (Proxmox VE, its Backup Server, Unraid;
 * connect-in-chat.md): its note above the form, and the address Add a server opens with (the connect address's host).
 */
export function asServerNote(entry: Pick<CatalogEntry, 'name' | 'asServer'>, url: string | null | undefined) {
  if (!entry.asServer) return null;
  return {
    title: 'Add it as a server instead',
    text: `Whombat looks after ${entry.name} best as a server: its helper there sees everything, with no sign-in key to keep.`,
    label: 'Add as a server',
    address: hostOf(url ?? ''),
  };
}

/** The host of an address (`https://10.0.0.5:8006` → `10.0.0.5`, IPv6 in brackets), or '' when there is none. */
function hostOf(url: string): string {
  const text = url.trim();
  if (!text) return '';
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(\[[^\]]+\]|[^:/?#]+)/i.exec(text);
  return m?.[1] ?? '';
}

/**
 * Add a server filled in from a found row (connect-in-chat.md): Connections' `?add=1&address=…` (`add` a number, so the
 * router writes it as `1`, not as the quoted string).
 */
export function foundServerSearch(address: string) {
  return { add: 1 as const, address };
}
