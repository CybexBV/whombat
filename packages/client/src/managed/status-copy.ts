/**
 * Words of a managed Whombat's own state (AP-22): connection, recovery kit, backups (“Unprotected” without a
 * destination), updates, AI provider sign-ins (each state worded differently), devices and removals. Shared by
 * the web's Settings tabs and the phone's This Whombat and Devices screens. Curly quotes and the middle dot as in
 * the mocks.
 */

import { clientTranslator } from '../i18n/catalog';

export const MANAGED_TEXT = {
  connection: 'CONNECTION',
  connected: 'Connected · end-to-end encrypted',
  fingerprint: (fp: string) => `Fingerprint ${fp}`,
  version: (v: string) => `Software ${v}`,
  kit: 'RECOVERY KIT',
  kitSaved: 'Recovery kit saved',
  kitSavedMeta: 'Keep it somewhere safe and offline.',
  /**
   * No kit is not a warning (BX-01): a quiet row on a Whombat from before the passkey; it lets a device in, and says
   * nothing of the backups (their key is the passkey's now, Whombat backup-passkey.md).
   */
  kitMissing: 'No recovery kit',
  kitMissingMeta:
    'Not needed to get in: your Whombat’s screen lets a device in. A kit helps if it has no screen.',
  kitMake: 'Make a kit',
  kitRotationPending: 'A new kit waits to be confirmed · the previous one still works until then',
  backups: 'BACKUPS',
  backup: {
    unprotected: 'Unprotected',
    unprotectedMeta:
      'No place for backups is set up. If this Whombat breaks, its data can’t be brought back.',
    pending: 'Waiting for the first backup',
    protected: 'Protected',
    stale: 'Backups are behind',
    failing: 'Backups are failing',
    last: (ago: string) => `Last backup ${ago}`,
    none: 'No backup has finished yet',
    covers: 'Covers',
    notCovered: 'Not covered',
    onPurpose: 'Left out on purpose',
    onPurposeMeta: (names: string) =>
      `${names}. A Whombat brought back makes these itself, and your passkey holds the key to the backups.`,
    relogin: 'After a restore, people sign in to their AI providers again.',
    recoverable: 'It can be brought back.',
  },
  updates: 'UPDATES',
  update: {
    Healthy: 'Up to date',
    Assigned: 'An update is on its way',
    Downloading: 'Downloading an update',
    Verified: 'Update downloaded',
    Staged: 'Update ready',
    WaitingForSafeBoundary: 'Update ready · waiting for work to finish',
    Activating: 'Updating now',
    Verifying: 'Checking the update',
    Failed: 'The last update didn’t work · still on the previous version',
    RolledBack: 'The last update was undone · still on the previous version',
    Quarantined: 'An update was held back',
    ForwardRepairRequired: 'Updated · can’t go back to the previous version',
  } as Record<string, string>,
  deferred: {
    task_running: 'An agent is working; the update waits for it to finish.',
  } as Record<string, string>,
  providers: 'AI PROVIDERS',
  provider: {
    ready: 'Ready',
    not_signed_in: 'Not signed in',
    quota_exhausted: 'Out of quota for now',
    auth_expired: 'Sign-in expired · sign in again',
    auth_revoked: 'Sign-in was revoked · sign in again',
    outage: 'The provider is down right now',
    version_drift: 'Being updated · back shortly',
    gated: 'Not available on this Whombat',
  } as Record<string, string>,
  providerNames: { claude: 'Claude', codex: 'ChatGPT', synthetic: 'Scripted' } as Record<string, string>,
  revocations: 'REMOVED DEVICES',
  revocationsPending: (n: number) => `${n} not told yet · they’re cleared when they next connect`,
  revocationsApplied: (n: number) => `${n} cleared`,
  policy: 'NOT ON A MANAGED WHOMBAT',
  devices: 'THIS DEVICE',
  otherDevices: 'OTHER DEVICES',
  thisBrowser: 'This browser',
  seen: (ago: string) => `Last seen ${ago}`,
  remove: 'Remove',
  removeConfirm:
    'Remove this device? It loses access at once and clears what it stored when it next connects.',
  removedPending: 'Removed · cleared when it next connects',
  removedApplied: 'Removed · cleared',
  add: 'ADD A DEVICE',
  addHelp: 'On the new device, choose “Let this device in”, then type the code it shows.',
  code: 'Code shown on the new device',
  lookUp: 'Continue',
  askedBy: 'THE DEVICE ASKING',
  checkFingerprint: 'Check this matches the fingerprint on the other device. If it doesn’t, decline.',
  otherCode: 'Use another code',
  approve: 'Let it in',
  decline: 'Decline',
  approved: 'Let in.',
  declined: 'Declined.',
  badCode: 'No device is showing that code. Check it and try again.',
  expired: 'That code expired. Show a new one on the other device.',
  fingerprintChanged: 'Another device now shows that code. Nothing was let in. Type the code again.',
  rateLimited: 'Too many tries. Wait a few minutes, then try again.',
  failed: 'That didn’t work. Try again.',
  clientFloor: 'Oldest app builds let in',
  clientFloorMeta: (floors: { platform: string; minBuild: number }[]) =>
    floors
      .map(
        (f) =>
          `${({ web: 'Web', android: 'Android', ios: 'iPhone', desktop: 'Desktop', cli: 'Command line' } as Record<string, string>)[f.platform] ?? f.platform} ${f.minBuild}`,
      )
      .join(' · '),
  loadError: 'Couldn’t load this. Check the connection and try again.',
  retry: 'Try again',
} as const;

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

export const ACCOUNTS_TEXT = {
  setUp: 'Set up backups',
  runNow: 'Back up now',
  /** `backup.runNow` answers once the backup is made. */
  backedUp: 'Backed up just now.',
  repository: 'Where backups go',
  repositoryHint: 'A restic REST server, e.g. rest:https://backup.example.com/whombat/ — no password in it.',
  user: 'User (optional)',
  password: 'Password (optional)',
  adopt: 'Joining the backups of a Whombat you had? The key from its paper copy',
  save: 'Save and check',
  cancel: 'Cancel',
  appendOnly: {
    verified: 'Connected. Old backups can’t be deleted from here.',
    'not-enforced':
      'Connected, but old backups can be deleted from here. Ask whoever runs that place to keep them from being deleted.',
    unknown: 'Connected. Whether old backups can be deleted from here couldn’t be checked.',
  } as Record<string, string>,
  /** A Whombat from before the passkey: its recovery kit holds the backups' key, so a new place needs a new kit. */
  newKit: 'A new place needs a new recovery kit.',
  saveKit: 'Save a new kit',
  errors: {
    backup_destination_failed:
      'Whombat couldn’t reach or use that place. Check the address and the password.',
    backup_unavailable: 'The backup service isn’t running on this Whombat right now.',
    backup_busy: 'A backup is running already.',
    backup_unprotected: 'Set up a place for backups first.',
    backup_failed: 'The backup failed. Try again later.',
    failed: 'That didn’t work. Try again.',
  } as Record<string, string>,
  signIns: 'YOUR AI SIGN-INS',
  signInsHelp: 'Agents you ask run on your own sign-in. Nobody else can use it.',
  signOut: 'Sign out',
  signInShort: 'Sign in',
  signIn: (provider: string, mode: string) =>
    `Sign in to ${provider}${mode === 'api_key' ? ' with a key' : ''}`,
  device: (uri: string, code: string) => `On any computer, open ${uri} and enter ${code}.`,
  waiting: 'Waiting for you to finish signing in…',
  key: 'API key',
  submitKey: 'Save key',
  keyValid: 'Signed in. The key works.',
  keyUnverified: 'Saved. It’s checked the first time an agent uses it.',
  loginFailed: 'That sign-in didn’t work.',
  loadError: 'Couldn’t load this. Try again.',
  providerNames: { claude: 'Claude', codex: 'ChatGPT', github: 'GitHub' } as Record<string, string>,
  states: {
    ready: 'Ready',
    not_signed_in: 'Not signed in',
    quota_exhausted: 'Out of quota for now',
    auth_expired: 'Sign-in expired',
    auth_revoked: 'Sign-in was revoked',
    outage: 'The provider is down right now',
    version_drift: 'Being updated',
    gated: 'Not available on this Whombat',
  } as Record<string, string>,
} as const;
