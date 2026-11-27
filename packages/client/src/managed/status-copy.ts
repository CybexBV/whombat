/**
 * Words of a managed Whombat's own state (AP-22): connection, recovery kit, backups (“Unprotected” without a
 * destination), updates, AI provider sign-ins (each state worded differently), devices and removals. Shared by
 * the web's Settings tabs and the phone's This Whombat and Devices screens. Curly quotes and the middle dot as in
 * the mocks.
 */

import { interpolate } from '@whombat/core/i18n';
import { clientTranslator, clientTree } from '../i18n/catalog';
import { ACCOUNTS_WORDS, MANAGED_STATUS_WORDS } from '../i18n/messages/managedStatus';

/** A managed Whombat's own state in a locale (English when none is given). */
export function managedText(locale?: string | null) {
  const { platforms, ...w } = clientTree(locale, MANAGED_STATUS_WORDS);
  const f = interpolate;
  return {
    ...w,
    fingerprint: (fp: string) => f(w.fingerprint, { fp }),
    version: (v: string) => f(w.version, { v }),
    backup: {
      ...w.backup,
      last: (ago: string) => f(w.backup.last, { ago }),
      onPurposeMeta: (names: string) => f(w.backup.onPurposeMeta, { names }),
    },
    update: { ...w.update } as Record<string, string>,
    deferred: { ...w.deferred } as Record<string, string>,
    provider: { ...w.provider } as Record<string, string>,
    providerNames: { claude: 'Claude', codex: 'ChatGPT', synthetic: w.providerNames.synthetic } as Record<
      string,
      string
    >,
    revocationsPending: (n: number) => f(w.revocationsPending, { n }),
    revocationsApplied: (n: number) => f(w.revocationsApplied, { n }),
    seen: (ago: string) => f(w.seen, { ago }),
    clientFloorMeta: (floors: { platform: string; minBuild: number }[]) =>
      floors
        .map((fl) => `${(platforms as Record<string, string>)[fl.platform] ?? fl.platform} ${fl.minBuild}`)
        .join(' · '),
  };
}

export const MANAGED_TEXT = managedText('en');

export function ago(iso: string | null, locale?: string | null): string {
  const tr = clientTranslator(locale);
  if (!iso) return tr.t('managed.ago.never');
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return tr.t('managed.ago.justNow');
  if (s < 5400) return tr.tp('managed.ago.minutes', Math.round(s / 60));
  if (s < 129_600) return tr.tp('managed.ago.hours', Math.round(s / 3600));
  return tr.tp('managed.ago.days', Math.round(s / 86_400));
}

export function scopeLabels(locale?: string | null): Record<string, string> {
  const tr = clientTranslator(locale);
  return {
    database: tr.t('managed.scope.database'),
    memory: tr.t('managed.scope.memory'),
    attachments: tr.t('managed.scope.attachments'),
    packs: tr.t('managed.scope.packs'),
    home: tr.t('managed.scope.home'),
    workspaces: tr.t('managed.scope.workspaces'),
    configuration: tr.t('managed.scope.configuration'),
    'provider-sessions': tr.t('managed.scope.provider-sessions'),
    'recovery-references': tr.t('managed.scope.recovery-references'),
    identity: tr.t('managed.scope.identity'),
    'recovery-secrets': tr.t('managed.scope.recovery-secrets'),
    manager: tr.t('managed.scope.manager'),
    'postgres-datadir': tr.t('managed.scope.postgres-datadir'),
    'backup-state': tr.t('managed.scope.backup-state'),
    caches: tr.t('managed.scope.caches'),
  };
}

export const SCOPE_LABELS: Record<string, string> = scopeLabels();

/**
 * What the backup service leaves out by design (the appliance's backup.md BK-02, BK-07): a restored Whombat gets an
 * identity of its own, its recovery secrets live in the recovery kit, the database is in the backup as a consistent
 * copy rather than its raw files, and update records, backup records and caches are made again. These are no gap.
 */
export const LEFT_OUT_ON_PURPOSE: ReadonlySet<string> = new Set([
  'identity',
  'recovery-secrets',
  'manager',
  'postgres-datadir',
  'backup-state',
  'caches',
]);

/** The backup's uncovered parts split into real gaps (a warning) and what it leaves out on purpose (a quiet line). */
export function coverageGaps(unprotected: readonly string[]): { gaps: string[]; onPurpose: string[] } {
  return {
    gaps: unprotected.filter((c) => !LEFT_OUT_ON_PURPOSE.has(c)),
    onPurpose: unprotected.filter((c) => LEFT_OUT_ON_PURPOSE.has(c)),
  };
}

/** Backups and AI sign-ins in Settings, in a locale (English when none is given). */
export function accountsText(locale?: string | null) {
  const { signInKey, ...w } = clientTree(locale, ACCOUNTS_WORDS);
  const f = interpolate;
  return {
    ...w,
    appendOnly: { ...w.appendOnly } as Record<string, string>,
    errors: { ...w.errors } as Record<string, string>,
    signIn: (provider: string, mode: string) => f(mode === 'api_key' ? signInKey : w.signIn, { provider }),
    device: (uri: string, code: string) => f(w.device, { uri, code }),
    providerNames: { claude: 'Claude', codex: 'ChatGPT', github: 'GitHub' } as Record<string, string>,
    states: { ...w.states } as Record<string, string>,
  };
}

export const ACCOUNTS_TEXT = accountsText('en');
