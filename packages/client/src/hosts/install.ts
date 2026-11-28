/**
 * Add a server by signing in once (Whombat `server-signin.md` SI-01…SI-12; app `server-signin-web.md` AP-1677…): the
 * three control levels and their words, the Sign in once form (its checks and the `hosts.startInstall` body), the
 * install job's four steps, the host key note and how it ended, the Run a command words, and the `?add=1&address=…`
 * address the assistant's card opens. Pure and platform-neutral: the web's dialog and Android's screen read the same.
 */
import { CONNECTIONS_HREF } from '@whombat/core';
import {
  HOST_CONTROL_LEVEL_DEFAULT,
  HOST_CONTROL_LEVELS,
  type HostControlLevel,
  type HostInstall,
  type HostInstallBody,
  type HostInstallErrorCode,
  type HostInstallState,
  type HostPendingEnrollment,
  hostControlLevelWords,
  hostInstallErrorText,
  parseHostInstallAddress,
} from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { HOSTS_INSTALL_WORDS } from '../i18n/messages/connectionsHosts/install';
import { isMacInstallText } from './macos';
import { SERVERS_HREF } from './model';

/* Control levels (SI-06): `HOST_CONTROL_LEVELS`, `HOST_CONTROL_LEVEL_WORDS` and the default are the contracts' ------ */

/** The question above the three levels. */
export function hostControlQuestion(locale?: string | null): string {
  return clientTree(locale, HOSTS_INSTALL_WORDS).question;
}

export const HOST_CONTROL_QUESTION = hostControlQuestion('en');

export function hostControlLevelOf(value: unknown): HostControlLevel | null {
  return typeof value === 'string' && (HOST_CONTROL_LEVELS as readonly string[]).includes(value)
    ? (value as HostControlLevel)
    : null;
}

/* The address the assistant's card opens (SI-10) ----------------------------------------------------------------- */

export interface AddServerPrefill {
  address: string;
  username: string;
  control: HostControlLevel;
  /** What to call it in Whombat; empty: its host name. */
  name: string;
}

const clip = (v: unknown, max: number): string =>
  (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').trim().slice(0, max);

/** `?add=1&address=10.100.0.40&user=root&control=full&name=…` → the form's start (anything missing: the defaults). */
export function addServerPrefill(search: Record<string, unknown>): AddServerPrefill {
  return {
    address: clip(search.address, 255),
    username: clip(search.user, 64) || 'root',
    control: hostControlLevelOf(search.control) ?? HOST_CONTROL_LEVEL_DEFAULT,
    name: clip(search.name, 63),
  };
}

/** The Servers list's address, where Add a server opens. */
const SERVERS_PLACE_HREF = '/servers';

/**
 * Add a server's address, with only what was given: over the Servers list (`/servers?add=1…`,
 * servers-connections-places.md). The assistant's card says `/things/servers?add=1…` and older messages
 * `/connections?add=1…`, which go there too.
 */
export function addServerHref(p: Partial<AddServerPrefill> = {}): string {
  const pairs: [string, string | undefined][] = [
    ['add', '1'],
    ['address', p.address],
    ['user', p.username],
    ['control', p.control],
    ['name', p.name],
  ];
  const q = pairs
    .filter((x): x is [string, string] => !!x[1])
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${SERVERS_PLACE_HREF}?${q}`;
}

/**
 * The paths Add a server opens on: the Servers list, its old address the servers' cards still use, and the Overview's
 * old one in older messages.
 */
const ADD_SERVER_PATHS: readonly string[] = [SERVERS_PLACE_HREF, SERVERS_HREF, CONNECTIONS_HREF];

/**
 * Whether an in-app link opens Add a server, and with what (Android maps the guide card's href to its screen); null
 * for any other link. No `URL` (React Native's is partial).
 */
export function addServerPrefillFromHref(href: string): AddServerPrefill | null {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/?#]*)?([^?#]*)(?:\?([^#]*))?/i.exec(href.trim());
  if (!m || !ADD_SERVER_PATHS.includes((m[1] ?? '').replace(/\/+$/, ''))) return null;
  const read = (t: string) => {
    try {
      return decodeURIComponent(t.replace(/\+/g, ' '));
    } catch {
      return '';
    }
  };
  const search: Record<string, string> = {};
  for (const part of (m[2] ?? '').split('&')) {
    if (!part) continue;
    const at = part.indexOf('=');
    search[read(at < 0 ? part : part.slice(0, at))] = at < 0 ? '' : read(part.slice(at + 1));
  }
  if (search.add !== '1' && search.add !== 'server') return null;
  return addServerPrefill(search);
}

/* The Sign in once form (SI-02, SI-09) ---------------------------------------------------------------------------- */

/** The SI-09 key picker's last choice: an ed25519 key named “Servers”. */
export const NEW_KEY = 'new';

export interface SignInForm {
  address: string;
  username: string;
  /** A password, or a key from the person's own Vault. */
  method: 'password' | 'vault';
  password: string;
  /** The Vault SSH key to sign in with (`method: 'vault'`). */
  entryId: string;
  /** With a key: the password for `sudo`, only if it asks. */
  sudoPassword: string;
  /** SI-09: leave a Vault key on the server (off by default). */
  keepKey: boolean;
  /** The key to leave: an entry id or `NEW_KEY`; empty until the person picks (`withKeyDefaults`). */
  keepKeyEntry: string;
  name: string;
}

export type SignInField = 'address' | 'username' | 'password' | 'entryId' | 'name';
export type SignInErrors = Partial<Record<SignInField, string>>;

export function signInFormDefaults(prefill: Partial<AddServerPrefill> = {}): SignInForm {
  return {
    address: prefill.address ?? '',
    username: prefill.username || 'root',
    method: 'password',
    password: '',
    entryId: '',
    sudoPassword: '',
    keepKey: false,
    keepKeyEntry: '',
    name: prefill.name ?? '',
  };
}

/** Try again (SI-11): back to the form with the passwords cleared and everything else kept. */
export function signInFormForRetry(f: SignInForm): SignInForm {
  return { ...f, password: '', sudoPassword: '' };
}

const SERVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/;

/** What is wrong with the form, per field (empty: it can be sent). */
export function signInFormErrors(f: SignInForm, locale?: string | null): SignInErrors {
  const w = clientTree(locale, HOSTS_INSTALL_WORDS).errors;
  const e: SignInErrors = {};
  const address = f.address.trim();
  if (!address) e.address = w.address;
  else if (address.length > 255 || !parseHostInstallAddress(address)) e.address = w.notAddress;
  const user = f.username.trim();
  if (!user) e.username = w.username;
  else if (user.length > 64 || /[\s:@/]/.test(user)) e.username = w.notUsername;
  if (f.method === 'password') {
    if (!f.password) e.password = w.password;
    else if (f.password.length > 1024) e.password = w.passwordTooLong;
  } else if (!f.entryId) e.entryId = w.key;
  const name = f.name.trim();
  if (name && !SERVER_NAME.test(name)) e.name = w.name;
  return e;
}

/** The `hosts.startInstall` body. The passwords go as typed (spaces are part of a password). */
export function installBody(f: SignInForm, control: HostControlLevel): HostInstallBody {
  const name = f.name.trim();
  return {
    address: f.address.trim(),
    username: f.username.trim(),
    auth:
      f.method === 'password'
        ? { kind: 'password', password: f.password }
        : { kind: 'vault', entryId: f.entryId, ...(f.sudoPassword ? { password: f.sudoPassword } : {}) },
    control,
    ...(name ? { name } : {}),
    ...(f.keepKey
      ? {
          keepKey:
            !f.keepKeyEntry || f.keepKeyEntry === NEW_KEY
              ? { create: true as const }
              : { entryId: f.keepKeyEntry },
        }
      : {}),
  };
}

/** One of the person's own Vault SSH keys, as the pickers list it. */
export interface SshKeyChoice {
  id: string;
  name: string;
  /** “Deploy key · SHA256:…” */
  label: string;
}

interface VaultEntryLike {
  id: string;
  name: string;
  kind: string;
  auth: { type: string; fingerprint?: string } | null;
}

/** The person's own SSH keys (`vault.list` only ever has the viewer's entries): name · fingerprint, by name. */
export function sshKeyChoices(entries: readonly VaultEntryLike[]): SshKeyChoice[] {
  return entries
    .filter((e) => e.kind === 'ssh' && e.auth?.type === 'ssh_key')
    .map((e) => ({
      id: e.id,
      name: e.name,
      label: e.auth?.fingerprint ? `${e.name} · ${e.auth.fingerprint}` : e.name,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * SI-09's key until the person picks one: the key they sign in with, else one named “Servers” (what “Make a new key”
 * made last time), else a new one.
 */
export function defaultKeepKey(choices: readonly SshKeyChoice[], signInWith = ''): string {
  if (signInWith && choices.some((c) => c.id === signInWith)) return signInWith;
  return choices.find((c) => c.name === 'Servers')?.id ?? NEW_KEY;
}

/**
 * The form with its pickers filled until the person picks: the first key to sign in with, SI-09's `defaultKeepKey`. A
 * pick that is no longer in the list (a key removed meanwhile) falls back too. Computed, not stored, so a refetched key
 * list never overrides a choice.
 */
export function withKeyDefaults(f: SignInForm, keys: readonly SshKeyChoice[]): SignInForm {
  if (!keys.length) return f;
  const entryId = keys.some((k) => k.id === f.entryId) ? f.entryId : (keys[0]?.id ?? '');
  const keepKeyEntry =
    f.keepKeyEntry === NEW_KEY || keys.some((k) => k.id === f.keepKeyEntry)
      ? f.keepKeyEntry
      : defaultKeepKey(keys, f.method === 'vault' ? entryId : '');
  return entryId === f.entryId && keepKeyEntry === f.keepKeyEntry ? f : { ...f, entryId, keepKeyEntry };
}

/** The form's words (shared by the web and the phone). */
export function signInCopy(locale?: string | null) {
  return { ...clientTree(locale, HOSTS_INSTALL_WORDS).signIn };
}

export const SIGN_IN_COPY = signInCopy('en');

/** The Run a command words (the fallback when signing in once can't be used). */
export function commandCopy(locale?: string | null) {
  return { ...clientTree(locale, HOSTS_INSTALL_WORDS).command };
}

export const COMMAND_COPY = commandCopy('en');

/** The Windows PC words: its PowerShell line and how to remove the agent again (windows-servers.md). */
export function windowsCopy(locale?: string | null) {
  return { ...clientTree(locale, HOSTS_INSTALL_WORDS).windows };
}

export const WINDOWS_COPY = windowsCopy('en');

/* The install job (SI-02, SI-04, SI-07, SI-08, SI-11) ------------------------------------------------------------- */

/** How often a running job is read again when no `hosts.install` frame came (brief §2.5). */
export let INSTALL_POLL_MS = 2_000;

/**
 * Tests read the job again after a few milliseconds instead of two seconds, so a screen that follows an install waits
 * on the change and not on the clock. Nothing else calls it.
 */
export function setInstallPollMsForTests(ms: number): void {
  INSTALL_POLL_MS = ms;
}

export function installRunning(i: Pick<HostInstall, 'state'>): boolean {
  return i.state !== 'ready' && i.state !== 'failed';
}

export type InstallStepKey = 'sign_in' | 'install' | 'report' | 'ready';
/** `late`: installed, but its first report hadn't come in when the job stopped waiting. */
export type InstallStepState = 'done' | 'active' | 'todo' | 'failed' | 'late';

export interface InstallStep {
  key: InstallStepKey;
  state: InstallStepState;
  label: string;
  /** The line under it (the system the installer found). */
  sub: string | null;
}

const SIGN_IN_CODES: readonly HostInstallErrorCode[] = [
  'not_allowed',
  'unreachable',
  'host_key_changed',
  'sign_in_failed',
];

/** Installed but quiet: the job stopped waiting for the first report (“It shows up once it does.”). */
export function installLate(i: Pick<HostInstall, 'state' | 'error' | 'serverId'>): boolean {
  return i.state === 'failed' && i.error?.code === 'timed_out' && !!i.serverId;
}

/** Where a failed job stopped. */
function failedAt(i: HostInstall): InstallStepKey {
  const code = i.error?.code;
  if (code && SIGN_IN_CODES.includes(code)) return 'sign_in';
  if (i.serverId) return 'report';
  if (i.hostKey || i.system) return 'install';
  return 'sign_in';
}

const ORDER: readonly InstallStepKey[] = ['sign_in', 'install', 'report', 'ready'];
const AT: Record<Exclude<HostInstallState, 'failed'>, number> = {
  connecting: 0,
  installing: 1,
  waiting: 2,
  ready: 4,
};

/** The four steps of SI-02, each done, under way, still to come or where it stopped. */
export function installSteps(i: HostInstall, locale?: string | null): InstallStep[] {
  const w = clientTree(locale, HOSTS_INSTALL_WORDS).steps;
  const address = i.address;
  const stop = i.state === 'failed' ? ORDER.indexOf(failedAt(i)) : AT[i.state];
  const late = installLate(i);
  return ORDER.map((key, n) => {
    const state: InstallStepState =
      n < stop ? 'done' : n > stop ? 'todo' : i.state === 'failed' ? (late ? 'late' : 'failed') : 'active';
    const done = state === 'done';
    switch (key) {
      case 'sign_in':
        return {
          key,
          state,
          label: interpolate(done ? w.signedIn : w.signingIn, { address }),
          sub: null,
        };
      case 'install':
        return {
          key,
          state,
          label: done ? (i.already ? w.updated : w.installed) : i.already ? w.updating : w.installing,
          sub: i.system,
        };
      case 'report':
        return {
          key,
          state,
          label: done ? w.reported : w.waiting,
          sub: null,
        };
      default:
        return { key, state, label: w.ready, sub: null };
    }
  });
}

/** What the job is called above its steps: the server's name once Whombat has one, else the address. */
export function installTitle(i: Pick<HostInstall, 'serverName' | 'address'>, locale?: string | null): string {
  return interpolate(clientTree(locale, HOSTS_INSTALL_WORDS).title, { name: i.serverName ?? i.address });
}

/**
 * The host key the server showed (SI-04): “First time on this server: it showed key SHA256:….”, with “Whombat
 * remembers it …” only when SI-09 left a key (the Vault then trusts it); a key that matched the Vault's says so.
 */
export function installHostKeyNote(
  i: Pick<HostInstall, 'hostKey' | 'hostKeyNew' | 'keptKey'> & Partial<Pick<HostInstall, 'error'>>,
  locale?: string | null,
): { before: string; fingerprint: string; after: string } | null {
  if (!i.hostKey) return null;
  const w = clientTree(locale, HOSTS_INSTALL_WORDS).hostKey;
  const fingerprint = i.hostKey.fingerprint;
  // A changed key (connect-in-chat.md): the key it shows now, the one “Trust the new one” trusts.
  if (i.error?.code === 'host_key_changed') return { before: w.changed, fingerprint, after: '.' };
  if (!i.hostKeyNew) return { before: w.known, fingerprint, after: w.knownAfter };
  return { before: w.first, fingerprint, after: i.keptKey ? w.remembers : '.' };
}

export type InstallOutcome =
  | { kind: 'added' | 'already' | 'renamed' | 'late'; text: string; serverId: string; serverName: string }
  | { kind: 'failed'; text: string; code: HostInstallErrorCode; detail: string | null };

/** `pve-03-2` and the fleet still has `pve-03`: Whombat gave it a free name (SI-07). */
function takenName(name: string, serverId: string, fleetNames: readonly string[]): string | null {
  const m = /^(.+)-(\d+)$/.exec(name);
  if (!m || Number(m[2]) < 2) return null;
  const base = m[1] as string;
  return fleetNames.includes(base) && base !== serverId ? base : null;
}

/**
 * How a finished job ended (null while it runs): added, updated in place (SI-08), added under a free name (SI-07),
 * installed but not reporting yet, or the refusal in words (SI-11). `fleetNames`: the servers' names and ids now.
 */
export function installOutcome(
  i: HostInstall,
  fleetNames: readonly string[] = [],
  locale?: string | null,
): InstallOutcome | null {
  if (installRunning(i)) return null;
  const w = clientTree(locale, HOSTS_INSTALL_WORDS).outcome;
  const name = i.serverName ?? i.serverId ?? i.address;
  if (i.state === 'ready' && i.serverId) {
    const level = hostControlLevelWords(locale)[i.control].title;
    if (i.already)
      return {
        kind: 'already',
        text: interpolate(w.already, { name, level }),
        serverId: i.serverId,
        serverName: name,
      };
    const base = takenName(name, i.serverId, fleetNames);
    if (base)
      return {
        kind: 'renamed',
        text: interpolate(w.renamed, { name, base }),
        serverId: i.serverId,
        serverName: name,
      };
    return { kind: 'added', text: interpolate(w.added, { name }), serverId: i.serverId, serverName: name };
  }
  if (installLate(i) && i.serverId)
    return {
      kind: 'late',
      text:
        i.error?.message ||
        hostInstallErrorText('timed_out', { address: i.address, installed: true }, locale),
      serverId: i.serverId,
      serverName: name,
    };
  const code = i.error?.code ?? 'failed';
  return {
    kind: 'failed',
    // The server words every refusal (SI-11); its message is shown as it comes.
    text: i.error?.message || hostInstallErrorText(code, { address: i.address, name: i.serverName }, locale),
    code,
    detail: i.detail?.trim() ? i.detail : null,
  };
}

/* A failed install, as one plain card (Whombat connect-in-chat.md) ------------------------------------------------ */

/**
 * The one step a failed install's card offers: `command` the Run a command way (a server that can't reach the Whombat
 * over the sign-in's way), `trust` trusting the key the server showed now and trying again (`host_key_changed`, with
 * the Vault servers that trusted the old one), `retry` the form again.
 */
export type InstallFailureStep = 'command' | 'trust' | 'retry';

export interface InstallFailureCard {
  /** One plain sentence: what happened. */
  title: string;
  /** What to do about it, when there is more to say; null: the button says it. */
  text: string | null;
  step: InstallFailureStep;
  /** The step's button. */
  label: string;
}

/** When “Trust the new one” finds yet another key (the Vault reads it again first). */
export function installKeyChangedAgain(locale?: string | null): string {
  return clientTree(locale, HOSTS_INSTALL_WORDS).keyChangedAgain;
}

export const INSTALL_KEY_CHANGED_AGAIN = installKeyChangedAgain('en');

/**
 * A failed install as one card (pure): a plain sentence, what to do, and the one step that helps. `server` the server's
 * name or address as the person typed it; `outcome` the job's failure (its own words stand where nothing better is known).
 */
export function installFailureCard(
  i: Pick<HostInstall, 'address' | 'serverName' | 'hostKey' | 'pins'>,
  outcome: Pick<Extract<InstallOutcome, { kind: 'failed' }>, 'code' | 'text'>,
  locale?: string | null,
): InstallFailureCard {
  const w = clientTree(locale, HOSTS_INSTALL_WORDS).failure;
  const server = i.serverName || i.address;
  const address = i.address;
  const retry = (title: string, text: string | null = null): InstallFailureCard => ({
    title,
    text,
    step: 'retry',
    label: w.tryAgain,
  });
  switch (outcome.code) {
    case 'cant_reach_whombat':
      return {
        title: interpolate(w.cantReachTitle, { server }),
        text: w.cantReachText,
        step: 'command',
        label: w.cantReachLabel,
      };
    case 'host_key_changed':
      return i.hostKey && i.pins?.length
        ? {
            title: w.keyTrustTitle,
            text: interpolate(w.keyTrustText, { server }),
            step: 'trust',
            label: w.keyTrustLabel,
          }
        : retry(w.keyChangedTitle, w.keyChangedText);
    case 'sign_in_failed':
      return retry(interpolate(w.signInFailed, { address }));
    case 'unreachable':
      return retry(interpolate(w.unreachableTitle, { address }), w.unreachableText);
    case 'sudo_password_needed':
      return retry(interpolate(w.sudoNeededTitle, { address }), w.sudoNeededText);
    case 'sudo_refused':
      // A Mac's words are the server's own (sign in as an administrator of the Mac; macos-servers.md).
      if (isMacInstallText(outcome.text)) return retry(...sentences(outcome.text));
      return retry(interpolate(w.sudoRefusedTitle, { address }), w.sudoRefusedText);
    case 'no_downloader':
      return retry(interpolate(w.noDownloaderTitle, { address }), w.noDownloaderText);
    case 'unsupported':
      // A Mac too old, or one whose macOS couldn't be read: the server says which, in Mac words.
      if (isMacInstallText(outcome.text)) return retry(...sentences(outcome.text));
      return retry(interpolate(w.unsupportedTitle, { address }), w.unsupportedText);
    case 'other_whombat':
      return retry(w.otherWhombatTitle, w.otherWhombatText);
    case 'timed_out':
      return retry(interpolate(w.timedOut, { address }));
    default:
      // The destination rule's own words (`not_allowed`) and the installer's (`failed`) say it best.
      return retry(outcome.text);
  }
}

/** The first sentence of a message as a card's title and the rest as its words (null when there is no rest). */
function sentences(text: string): [string, string | null] {
  const at = text.search(/[.!?]\s/);
  if (at < 0) return [text.trim(), null];
  const rest = text.slice(at + 1).trim();
  return [text.slice(0, at + 1).trim(), rest || null];
}

/** Run a command: what became of this command's server (pre-approved, SI-07), once it ran. */
export function commandOutcome(
  enrollmentId: string | null,
  items: readonly Pick<HostPendingEnrollment, 'id' | 'state' | 'serverId' | 'hostname'>[],
  locale?: string | null,
): { serverId: string; text: string } | null {
  const e = enrollmentId ? items.find((x) => x.id === enrollmentId) : undefined;
  if (e?.state !== 'approved' || !e.serverId) return null;
  return {
    serverId: e.serverId,
    text: interpolate(clientTree(locale, HOSTS_INSTALL_WORDS).outcome.added, { name: e.serverId }),
  };
}
