/**
 * A server's mark (CT-399; Whombat marks.md MK-01): what it runs, drawn as its maker's logo in the sidebar, on Home and
 * in a server's page head; a Mac as Whombat's own screen glyph (`mac`, no maker's logo), a Windows PC as its own
 * computer glyph (`pc`). Proxmox VE and Unraid are known
 * by the server's platform (a Proxmox host's os-release says
 * Debian); any other server by its operating system's name (os-release `PRETTY_NAME`: “Debian GNU/Linux 13 (trixie)”,
 * “Ubuntu 24.04.1 LTS”), Tux for a Linux nobody has a mark for. The names are the clients' brand marks
 * (`@whombat/brand`, Simple Icons slugs); the server sends one as `ThingSummary.icon`.
 */
import type { HostServerPlatform } from './hosts.js';

/** Operating systems by a word in their name, the more specific first (Kubuntu before Ubuntu, Raspbian before Debian). */
const OS_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // A Mac is Whombat's own screen glyph, never Apple's logo (a trademark; Whombat macos-servers.md).
  [/\bmacos\b|\bmac os\b|\bos x\b/i, 'mac'],
  // A Windows PC is Whombat's own computer glyph, never Microsoft's logo (a trademark; Whombat windows-servers.md).
  [/\bwindows\b/i, 'pc'],
  [/\bproxmox\b/i, 'proxmox'],
  [/\bunraid\b/i, 'unraid'],
  [/\btruenas\b/i, 'truenas'],
  [/\bopenmediavault\b/i, 'openmediavault'],
  [/\braspbian\b|\braspberry pi os\b/i, 'raspberrypi'],
  [/\bkubuntu\b/i, 'kubuntu'],
  [/\bxubuntu\b/i, 'xubuntu'],
  [/\blubuntu\b/i, 'lubuntu'],
  [/\bubuntu mate\b/i, 'ubuntumate'],
  [/\bpop!?_?os\b/i, 'popos'],
  [/\belementary os\b/i, 'elementary'],
  [/\bzorin\b/i, 'zorin'],
  [/\blinux mint\b|\blmde\b/i, 'linuxmint'],
  [/\bkde neon\b/i, 'kdeneon'],
  [/\bkali\b/i, 'kalilinux'],
  [/\bparrot\b/i, 'parrotsecurity'],
  [/\bdeepin\b/i, 'deepin'],
  [/\btails\b/i, 'tails'],
  [/\bubuntu\b/i, 'ubuntu'],
  [/\bdebian\b/i, 'debian'],
  [/\basahi\b/i, 'asahilinux'],
  [/\bnobara\b/i, 'nobaralinux'],
  [/\bqubes\b/i, 'qubesos'],
  [/\bfedora\b/i, 'fedora'],
  [/\brocky\b/i, 'rockylinux'],
  [/\balmalinux\b/i, 'almalinux'],
  [/\bcentos\b/i, 'centos'],
  [/\bred hat\b|\brhel\b/i, 'redhat'],
  [/\bopensuse\b/i, 'opensuse'],
  [/\bsuse\b|\bsles\b/i, 'suse'],
  [/\bendeavouros\b/i, 'endeavouros'],
  [/\bmanjaro\b/i, 'manjaro'],
  [/\bcachyos\b/i, 'cachyos'],
  [/\bartix\b/i, 'artixlinux'],
  [/\barch\b/i, 'archlinux'],
  [/\balpine\b/i, 'alpinelinux'],
  [/\bnixos\b/i, 'nixos'],
  [/\bgentoo\b/i, 'gentoo'],
  [/\bvoid\b/i, 'voidlinux'],
  [/\bslackware\b/i, 'slackware'],
  [/\bsolus\b/i, 'solus'],
  [/\bopenwrt\b/i, 'openwrt'],
  [/\btalos\b/i, 'talos'],
  [/\bfreebsd\b/i, 'freebsd'],
  [/\bopenbsd\b/i, 'openbsd'],
  [/\bnetbsd\b/i, 'netbsd'],
];

/** Every mark `hostOsMark` answers; each one has a drawing in `@whombat/brand`. */
export const HOST_OS_MARKS = [
  ...new Set([...OS_PATTERNS.map(([, mark]) => mark), 'linux', 'linuxcontainers', 'qemu']),
] as readonly string[];

/**
 * The mark of an operating system by its name (`Debian GNU/Linux 13 (trixie)` → `debian`), Tux for another Linux, or
 * null for a name it doesn't know.
 */
export function osMark(os: string | null | undefined): string | null {
  if (!os) return null;
  for (const [pattern, mark] of OS_PATTERNS) if (pattern.test(os)) return mark;
  return /\blinux\b|\bgnu\b/i.test(os) ? 'linux' : null;
}

/**
 * A server's mark: Proxmox VE, Unraid, a Mac or a Windows PC by its platform, else its operating system's (`osMark`);
 * an Incus or a libvirt server whose system isn't known shows Linux Containers' or QEMU's mark, any other one null (the
 * clients draw a server).
 */
export function hostOsMark(server: {
  platform: HostServerPlatform;
  os: string | null | undefined;
}): string | null {
  if (server.platform === 'proxmox') return 'proxmox';
  if (server.platform === 'unraid') return 'unraid';
  if (server.platform === 'macos') return 'mac';
  if (server.platform === 'windows') return 'pc';
  const mark = osMark(server.os);
  if (mark) return mark;
  if (server.platform === 'incus') return 'linuxcontainers';
  if (server.platform === 'libvirt') return 'qemu';
  return null;
}
