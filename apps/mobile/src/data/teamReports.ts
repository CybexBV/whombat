/**
 * Reports to the Whombat Team on the phone (Whombat docs/decisions/team-reports.md): what the phone says about itself
 * with a new report, a status's tone, and the few words only the phone needs. The rest — the list's order, the
 * conversation, the track, the words people read — is `@whombat/client`'s, the same as the web's. Pure.
 */
import type { TeamReportStatus, Tone } from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';

/** What the phone's report screens say that the web's don't need. */
export function teamReportsPhoneWords(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    /** The ⋯ button's name for screen readers. */
    more: (title: string) => t('data.teamReports.more', { title }),
  } as const;
}
export const TEAM_REPORTS_PHONE_WORDS = teamReportsPhoneWords();

/**
 * The device and its system in a few words (“Pixel 9 · Android 16”, “iPhone 16 Pro · iOS 26.1”), from what the phone
 * says about itself; the system's name from the platform when the phone doesn't say it. Null when nothing is known.
 */
export function phoneDeviceWords(
  device: { modelName?: string | null; osName?: string | null; osVersion?: string | null },
  platform: 'ios' | 'android',
): string | null {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const model = clean(device.modelName);
  const os = clean(device.osName) || (platform === 'ios' ? 'iOS' : 'Android');
  const version = clean(device.osVersion);
  const system = version ? `${os} ${version}` : os;
  return [model, system].filter(Boolean).join(' · ') || null;
}

/** The phone's language as a language tag (`en-GB`), or null when it can't be read. */
export function phoneLanguage(read: () => string | undefined): string | null {
  try {
    return read() || null;
  } catch {
    return null;
  }
}

/** A status's tone on its pill: waiting for the person a warning, a fix there or confirmed good, the rest neutral. */
export function teamReportTone(status: TeamReportStatus): Tone {
  switch (status) {
    case 'needs_information':
      return 'warn';
    case 'available':
    case 'awaiting_release':
    case 'confirmed':
      return 'ok';
    default:
      return 'neutral';
  }
}
