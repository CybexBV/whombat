/**
 * The versions Settings → This Whombat shows on the phone (Whombat settings-simplify.md SS-06, SS-30, SS-61): this
 * app's — the release version from app.config with its build number (the Android `versionCode`, AP-259) — and the
 * Whombat's runtime when it says (a managed Whombat's `welcome` or `appliance.status`, a self-hosted server's health,
 * which tells admins only), and on Android with a Whombat's service where this app's update check stands (AP-2972),
 * then the Hermes Agent the assistant runs on where the Whombat's status was read (`ApplianceInfo.hermes`; Whombat
 * hermes-updates.md HU-02, chat-settle.md AP-6159). Pure.
 */
import type { AppUpdateStatus } from '../managed/appUpdate';

export const VERSION_TEXT = {
  label: 'VERSION',
  app: 'This app',
  whombat: 'Whombat',
  unknown: 'Not known',
  hermes: 'Hermes Agent',
  hermesWhat: 'What your assistant runs on',
  /** Before a runner said which Hermes it runs. */
  hermesUnknown: 'Not known yet',
  /** The “This app” row's button (AP-2972): asks for a newer app now; TalkBack reads `checkLabel`. */
  check: 'Check',
  checkLabel: 'Check for updates',
  /** How Whombat handles personal data, inside the app (App Review 5.1.1): the site's privacy policy. */
  privacy: 'Privacy',
  privacyWhat: 'How Whombat handles your data',
  privacyOpen: 'Read',
  privacyLabel: 'Read the privacy policy',
  /** Under the version, where the check stands (a newer build has its own row; nothing known, nothing said). */
  status: {
    checking: 'Checking…',
    newest: 'Up to date',
    failed: 'Couldn’t check just now',
    newer: null,
    unknown: null,
  } satisfies Record<AppUpdateStatus, string | null>,
} as const;

/** “0.36.0 · build 36000”; the version alone without a build number; null when the app doesn't know its own. */
export function appVersionText(
  version: string | null | undefined,
  build: string | number | null | undefined,
): string | null {
  if (!version) return null;
  return build !== null && build !== undefined && build !== '' ? `${version} · build ${build}` : version;
}

export interface VersionRow {
  title: string;
  /** A plain line under the title, before the version (the Hermes row's “What your assistant runs on”). */
  body?: string;
  meta: string;
}

/**
 * The VERSION card's rows: this app always (“Not known” only if a build lost its config), with where its update check
 * stands on a line under it (a newer build gets a row of its own), then the Whombat when it says which version it runs — never a
 * guess (SS-06) — and, where the Whombat's status was read (`hermes` given), the Hermes Agent after it: its version, or
 * “Not known yet” while no runner said.
 */
export function versionRows(
  app: string | null,
  runtime: string | null,
  update: AppUpdateStatus | null = null,
  hermes?: { version: string } | null,
): VersionRow[] {
  const said = update ? VERSION_TEXT.status[update] : null;
  const own = app ?? VERSION_TEXT.unknown;
  const rows: VersionRow[] = [{ title: VERSION_TEXT.app, meta: said ? `${own}\n${said}` : own }];
  if (runtime) rows.push({ title: VERSION_TEXT.whombat, meta: runtime });
  if (hermes !== undefined)
    rows.push({
      title: VERSION_TEXT.hermes,
      body: VERSION_TEXT.hermesWhat,
      meta: hermes?.version ?? VERSION_TEXT.hermesUnknown,
    });
  return rows;
}
