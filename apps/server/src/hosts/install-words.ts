/**
 * “Add a server by signing in once” in words and lines (docs/decisions/server-signin.md SI-06, SI-08, SI-11;
 * server-signin-server.md SI-S04…SI-S07): a control level as the hub's switches and in a change's words, the
 * installer's machine-readable lines, its failures as SI-11's codes (contracts' `hostInstallErrorText`, with the few
 * cases the server knows better), and its last lines for “More detail” with the password and token removed. Pure: the
 * install job (`install.ts`) and its tests use it.
 */
import {
  HOST_CONTROL_LEVEL_SWITCHES,
  HOST_CONTROL_LEVEL_WORDS,
  HOST_INSTALL_DETAIL_MAX,
  type HostControlLevel,
  type HostInstallErrorCode,
  hostInstallErrorText,
} from '@whombat/core';

export const ADDRESS_FIELD_TEXT = 'Type the server’s address, like 10.100.0.14 or pve-03.lan:2222.';

/* Control levels (SI-06, §2.1) --------------------------------------------------------------------------------------- */

export type HubSwitches = Record<
  'console' | 'power' | 'host_shell' | 'host_power' | 'manage' | 'diagnose',
  boolean
>;

/** A level's hub switches in the hub's words, exactly: lowering a level turns the rest off. */
export function hubSwitches(level: HostControlLevel): HubSwitches {
  const s = HOST_CONTROL_LEVEL_SWITCHES[level];
  return {
    console: s.console,
    power: s.power,
    host_shell: s.hostShell,
    host_power: s.hostPower,
    manage: s.manage,
    diagnose: s.diagnose,
  };
}

/** A level as a change's words say it: “full control”, “restart and consoles”, “watch only”. */
export const controlWords = (level: HostControlLevel) => HOST_CONTROL_LEVEL_WORDS[level].title.toLowerCase();

/** The signed line and Done recently's title (SI-07, SI-08). */
export function installChangeText(name: string, level: HostControlLevel, already: boolean): string {
  if (already) return `Updated ${name}’s agent and set ${controlWords(level)}`;
  return level === 'watch' ? `Added ${name} to watch only` : `Added ${name} with ${controlWords(level)}`;
}

/** The signed line of a repoint (backup-file.md BF-15, BF-S36): “Pointed pve-03 at this Whombat”. */
export const repointChangeText = (name: string) => `Pointed ${name} at this Whombat`;

/* The installer's lines (§2.2) --------------------------------------------------------------------------------------- */

export type InstallResult =
  | { kind: 'added'; id: string }
  | { kind: 'kept'; id: string }
  | { kind: 'waiting'; id: string }
  | { kind: 'other-whombat' };

const RESULT_LINE = /^whombat-agent: (?:(added|kept|waiting) (\S{1,200})|(other-whombat))$/;
const OS_LINE = /^whombat-agent: os (.{1,400})$/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal colour codes.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const lines = (text: string) =>
  text
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((l) => l.replace(CONTROLS, '').trimEnd());

/** The result line (the last one that is one) and the OS line the installer printed on stdout. */
export function parseInstallOutput(stdout: string): { result: InstallResult | null; os: string | null } {
  let result: InstallResult | null = null;
  let os: string | null = null;
  for (const raw of lines(stdout)) {
    const line = raw.trim();
    const r = RESULT_LINE.exec(line);
    if (r) {
      result = r[3]
        ? { kind: 'other-whombat' }
        : { kind: r[1] as 'added' | 'kept' | 'waiting', id: r[2] as string };
      continue;
    }
    const o = OS_LINE.exec(line);
    if (o) os = (o[1] as string).trim();
  }
  return { result, os };
}

/** The platform first, then the system and the architecture: “Proxmox VE 9.0 · Debian GNU/Linux 13 (trixie) · amd64”. */
export function systemLine(os: string | null): string | null {
  if (!os) return null;
  const parts = os
    .split(/\s+·\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const platform = (p: string) => /^(Proxmox VE|Unraid|Incus|macOS)\b/i.test(p);
  const ordered = [...parts.filter(platform), ...parts.filter((p) => !platform(p))];
  return ordered.join(' · ').slice(0, 200) || null;
}

/** Why an installer that ran didn't add the server, from its stable `install.sh: …` words and its exit (§2.2). */
export function installProblemOf(out: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}): HostInstallErrorCode {
  const text = `${out.stderr}\n${out.stdout}`;
  if (parseInstallOutput(out.stdout).result?.kind === 'other-whombat') return 'other_whombat';
  if (/curl or wget is required/i.test(text)) return 'no_downloader';
  if (/unsupported (?:architecture|init system|macos|operating system)|not linux/i.test(text))
    return 'unsupported';
  if (/cannot reach /i.test(text)) return 'cant_reach_whombat';
  if (out.timedOut) return 'timed_out';
  if (out.exitCode === 3) return 'other_whombat';
  return 'failed';
}

/** “More detail” replaces every secret with this. */
export const REMOVED = '•••';
const DETAIL_LINES = 40;

/**
 * The installer's last lines for “More detail”: what it printed (stdout, then stderr), colours and control characters
 * out, every secret given (the password, the token) and anything after `--token` replaced, at most 4 KiB from the end.
 */
export function installDetail(
  out: { stdout: string; stderr: string },
  secrets: readonly (string | null | undefined)[],
): string | null {
  const strip = (text: string) => {
    let s = text;
    for (const secret of secrets) if (secret) s = s.split(secret).join(REMOVED);
    return s.replace(/(--token[ =])\S+/g, `$1${REMOVED}`);
  };
  const tail = (text: string) =>
    lines(strip(text))
      .filter((l) => l.trim())
      .slice(-DETAIL_LINES);
  const all = [...tail(out.stdout), ...tail(out.stderr)].slice(-DETAIL_LINES).join('\n');
  if (!all.trim()) return null;
  const bytes = Buffer.from(all, 'utf8');
  if (bytes.length <= HOST_INSTALL_DETAIL_MAX) return all;
  let cut = bytes.subarray(bytes.length - HOST_INSTALL_DETAIL_MAX).toString('utf8');
  while (cut.startsWith('�') || Buffer.byteLength(cut) > HOST_INSTALL_DETAIL_MAX) cut = cut.slice(1);
  const nl = cut.indexOf('\n');
  return nl >= 0 && nl < 200 ? cut.slice(nl + 1) : cut;
}

/** The agents' address from the enrollment's `agent_url` (`wss://10.100.1.160:8443` → `10.100.1.160:8443`). */
export function agentsPlace(agentUrl: string | null | undefined): string | null {
  if (!agentUrl) return null;
  try {
    return new URL(agentUrl).host || null;
  } catch {
    return null;
  }
}

/* Words (SI-11) ------------------------------------------------------------------------------------------------------ */

/** A failure: its code, and words of its own when the server knows better than the code's (SI-S06). */
export interface InstallFailure {
  code: HostInstallErrorCode;
  message?: string;
  /** `timed_out` after the install: only the first report is missing. */
  installed?: boolean;
}

/** What Sign in once read of a Mac (macos-servers.md): its macOS and who is at its screen. */
export interface MacFacts {
  /** `27.2.1`; null when `sw_vers` didn't say. */
  version: string | null;
  /** The user at the screen (`stat -f %Su /dev/console`); null at the login window or when unknown. */
  consoleUser: string | null;
}

/** Reads `sw_vers -productVersion` and `stat -f %Su /dev/console`, one per line, as `MAC_FACTS_COMMAND` prints them. */
export function parseMacFacts(stdout: string): MacFacts {
  const [version, user] = stdout.split(/\r?\n/).map((l) => l.trim());
  return {
    version: version && /^\d{1,3}(?:\.\d{1,4}){0,3}$/.test(version) ? version : null,
    consoleUser: user && user !== 'root' && /^[A-Za-z0-9._-]{1,64}$/.test(user) ? user : null,
  };
}

/** The macOS major version of `27.2.1` (27), or null. */
export const macMajor = (version: string | null): number | null =>
  version ? Number(version.split('.')[0]) : null;

/** What the words need: the address as typed, the server's name once known, the agents' address. */
export interface FailureFacts {
  address: string;
  name?: string | null;
  agents?: string | null;
  withKey?: boolean;
  /** The server is a Mac (its words are a Mac's). */
  mac?: MacFacts | null;
}

export function installFailureText(f: InstallFailure, facts: FailureFacts): string {
  if (f.message) return f.message;
  return hostInstallErrorText(f.code, {
    address: facts.address,
    ...(facts.name ? { name: facts.name } : {}),
    ...(facts.agents ? { whombat: facts.agents } : {}),
    ...(facts.withKey ? { withKey: true } : {}),
    ...(f.installed ? { installed: true } : {}),
    ...(facts.mac ? { mac: { version: facts.mac.version } } : {}),
  });
}

/** The few failures the server words itself (the rest are the contract's). */
export const INSTALL_TEXT = {
  sudoPasswordNotTaken: (address: string) => `Signed in, but sudo on ${address} didn’t take that password.`,
  connectionBroke: (address: string) => `The connection to ${address} broke off. Try again.`,
  waiting: (address: string) =>
    `Whombat’s helper is on ${address}, but it waits to be let in. You find it under Servers.`,
} as const;

/* Limits (SI-S08) ---------------------------------------------------------------------------------------------------- */

export const INSTALL_LIMIT_TEXT = {
  same: (address: string) => `Whombat is adding ${address} already. Wait for it to finish.`,
  person: 'You’re adding two servers already. Wait for one of them to finish.',
  box: 'Whombat is adding four servers already. Try again in a minute.',
} as const;

/** The longest user name a Vault SSH server takes (SI-09 keeps the server there). */
export const VAULT_SSH_USERNAME_MAX = 32;

export const INSTALL_KEY_TEXT = {
  notSsh: 'Choose one of your SSH keys from the Vault.',
  username: 'Whombat can keep a key for user names of up to 32 characters.',
} as const;
