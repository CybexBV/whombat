/**
 * A Windows PC's page on the web and the phone (Whombat windows-servers.md): its tabs, the System line, and its own
 * facts for Technical details (“This PC”): the model, the virus protection and how old its definitions are, when
 * Windows Update last looked and installed, and BitLocker per drive. Whombat only reads these; the person changes them
 * on the PC. Pure, shared by both apps.
 */
import type { HostServerDetail, HostWindowsDetail } from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { HOSTS_WINDOWS_WORDS } from '../i18n/messages/connectionsHosts/windows';
import { formatAgoIso } from './format';
import type { ServerTab } from './model';
import type { HostTone } from './thresholds';

/** A Windows PC: the hub says so (`windows`), or its agent runs on Windows, or its page carries a PC's facts. */
export function isWindowsServer(
  d:
    | { server: Pick<HostServerDetail['server'], 'platform' | 'osFamily'>; windows?: unknown }
    | null
    | undefined,
): boolean {
  if (!d) return false;
  return d.server.platform === 'windows' || d.server.osFamily === 'windows' || !!d.windows;
}

/**
 * A PC's tabs: no machines, backups or sensors of its own (Whombat reaches no guests on a PC, and Windows doesn't tell
 * its temperatures without the maker's own tools).
 */
export const WINDOWS_SERVER_TABS: readonly ServerTab[] = ['summary', 'storage', 'system'];

/** “Windows 11 Pro 24H2 (26100.2605)”. */
export function windowsSystemLine(
  w: Pick<HostWindowsDetail, 'product' | 'displayVersion' | 'build'>,
): string {
  const product = w.product.trim() || 'Windows';
  return `${product}${w.displayVersion ? ` ${w.displayVersion}` : ''}${w.build ? ` (${w.build})` : ''}`;
}

/** Why Whombat leaves the PC's updates alone, beside its Updates line. */
export function windowsUpdatesNote(locale?: string | null): string {
  return clientTree(locale, HOSTS_WINDOWS_WORDS).updatesNote;
}

/** What the page's facts panel is called. */
export function windowsFactsTitle(locale?: string | null): string {
  return clientTree(locale, HOSTS_WINDOWS_WORDS).thisPc;
}

export interface WindowsProtectionView {
  text: string;
  tone: HostTone;
}

/** The virus protection in a few words: the product that is on, Off, or Not known (a Windows Server's own). */
export function windowsProtection(
  p: HostWindowsDetail['protection'],
  locale?: string | null,
): WindowsProtectionView {
  const v = clientTree(locale, HOSTS_WINDOWS_WORDS).values;
  if (p.state === 'on')
    return { text: p.product ? interpolate(v.productOn, { product: p.product }) : v.on, tone: 'ok' };
  if (p.state === 'off') return { text: v.off, tone: 'bad' };
  return { text: v.notKnown, tone: 'mut' };
}

export interface WindowsFact {
  label: string;
  value: string;
}

/**
 * A PC's own facts for Technical details (“This PC”): the model, the virus protection with its definitions' age and last
 * quick scan (Defender's), when Windows Update last looked and installed, and BitLocker per drive. Its Windows is the
 * System line above them.
 */
export function windowsFacts(w: HostWindowsDetail, now: number, locale?: string | null): WindowsFact[] {
  const t = clientTree(locale, HOSTS_WINDOWS_WORDS);
  const out: WindowsFact[] = [];
  const ago = (iso: string | null | undefined) => (iso ? formatAgoIso(iso, now, locale) : null);
  const model = [w.manufacturer, w.model].filter(Boolean).join(' ');
  if (model) out.push({ label: t.facts.model, value: model });
  out.push({ label: t.facts.protection, value: windowsProtection(w.protection, locale).text });
  const d = w.protection.defender;
  // Defender's definitions and scan only while it is the PC's antivirus.
  if (d && d.mode === 'normal') {
    const sigs = ago(d.signaturesAt);
    if (sigs) out.push({ label: t.facts.definitions, value: sigs });
    const scan = ago(d.quickScanAt);
    if (scan) out.push({ label: t.facts.quickScan, value: scan });
  }
  const checked = ago(w.updatesCheckedAt);
  if (checked) out.push({ label: t.facts.updatesChecked, value: checked });
  const installed = ago(w.updatesInstalledAt);
  if (installed) out.push({ label: t.facts.updatesInstalled, value: installed });
  if (w.bitlocker?.length) {
    const state = { on: t.values.driveOn, off: t.values.driveOff, unknown: t.values.driveUnknown };
    out.push({
      label: t.facts.bitlocker,
      value: w.bitlocker
        .map((v) => interpolate(t.values.drive, { drive: v.drive, state: state[v.protection] }))
        .join(' · '),
    });
  }
  return out;
}
