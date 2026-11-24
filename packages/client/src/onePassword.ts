/**
 * A 1Password vault kept in step with the Vault, as the web and the phone show it (Whombat onepassword-sync.md; app
 * docs/app/decisions/onepassword-sync.md): a synced entry's tag and its page's line, the 1Password connection's page part
 * (`connections.onePassword`) as one model, what removing the connection asks, and the toasts of the guard's answers.
 * The words the spec quotes are core's (`ONEPASSWORD_WORDS` and its line helpers); only the few it leaves to the apps
 * are here. Pure.
 */
import { type CatalogEntry, isVaultSyncConnection } from '@whombat/core/domain';
import {
  ONEPASSWORD_WORDS,
  type OnePasswordDisconnectChoice,
  type OnePasswordRemovalAnswer,
  type OnePasswordSyncView,
  onePasswordCheckedLine,
  onePasswordEntryLine,
  onePasswordGoneTitle,
  onePasswordKeptLine,
  onePasswordSkipText,
  onePasswordStatusLines,
  type VaultEntry,
} from '@whombat/core/vault';
import { ApiError } from './http/errors';

/** The words the spec leaves to the apps. */
export const ONEPASSWORD_APP_TEXT = {
  /** The connection page's section with the sync. */
  section: 'KEPT IN STEP',
  /** Above the vault's name. */
  vaultLabel: 'VAULT IN 1PASSWORD',
  /** Before the first check named the vault. */
  vaultUnknown: 'Your 1Password vault',
  /** The footer while a pass runs or is asked for. */
  syncing: 'Syncing with 1Password…',
  /** What Remove asks first, above the two choices. */
  removeAsk: (label: string) =>
    `Remove ${label}? Your Vault stops following it. Nothing changes in 1Password.`,
  /** The two choices' group, for screen readers. */
  removeChoice: 'The entries it keeps in step',
  /** After the guard's answer. */
  removed: 'Removed them from your Vault too.',
  kept: 'Kept them in your Vault.',
  /** The set changed since the person saw it (`conflict`): the new one is shown, nothing was changed. */
  changed: 'The list changed since you saw it. Look again before you choose.',
  /** The page part didn't load. */
  failed: 'Couldn’t read how 1Password is kept in step. Try again in a moment.',
} as const;

/** The guard's answer was refused because the set changed since it was shown (`conflict`): nothing was removed. */
export function onePasswordSetChanged(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'conflict';
}

/* The Vault ------------------------------------------------------------------------------------------------------ */

/** A Vault entry's tag after its name: “1Password” while it is kept in step there, else null. */
export function vaultEntryTag(entry: Pick<VaultEntry, 'source'>): string | null {
  return entry.source?.kind === 'onepassword' ? ONEPASSWORD_WORDS.tag : null;
}

/** A line with how loud it is: `warn` for what needs a look, `bad` only for what has stopped working. */
export interface ToneLine {
  text: string;
  tone: 'plain' | 'warn' | 'bad';
}

/**
 * A synced entry's line on its page: “Kept in step with 1Password · 2 min ago”, the waiting line, or the problem in the
 * warning colour (the entry itself still works). Null for an entry kept only in Whombat, or a place this app doesn't
 * know.
 */
export function vaultEntrySourceLine(
  entry: Pick<VaultEntry, 'source'>,
  now: Date | number | string,
  timeZone: string,
): ToneLine | null {
  const source = entry.source;
  if (source?.kind !== 'onepassword') return null;
  return {
    text: onePasswordEntryLine(source, now, timeZone),
    tone: source.state === 'problem' ? 'warn' : 'plain',
  };
}

/* The connection's page ------------------------------------------------------------------------------------------ */

/** The 1Password connection's page part, as both apps draw it. */
export interface OnePasswordPage {
  /** The vault's name in 1Password. */
  vault: string;
  /** “12 logins and API tokens kept in step”. */
  kept: string;
  /** The waiting, failing and read-only lines, under the counts; the paused one is `removals`' title. */
  status: ToneLine[];
  /** The footer: “Last checked 3 min ago”, or that a pass is on its way. */
  checked: string;
  /** A pass is running or asked for: Sync now waits. */
  syncing: boolean;
  /** The guard's pause: what 1Password says is gone, and the set's token for the answer. */
  removals: { title: string; names: string[]; token: string } | null;
  /** “Not in your Vault”: each item's title and why. */
  notInVault: { id: string; title: string; reason: string }[];
}

export function onePasswordPage(
  view: OnePasswordSyncView,
  now: Date | number | string,
  timeZone: string,
): OnePasswordPage {
  const paused = view.outcome === 'paused' && view.removals ? view.removals : null;
  // The paused line is the removals' own title, with their names and the two answers under it: not here again. A
  // failing pass has stopped keeping them in step (`bad`); waiting for the limit and a read-only token need a look.
  const status = onePasswordStatusLines({ ...view, removals: null }, timeZone).map(
    (text): ToneLine => ({
      text,
      tone: text !== ONEPASSWORD_WORDS.readOnly && view.outcome === 'failing' ? 'bad' : 'warn',
    }),
  );
  return {
    vault: view.vaultTitle?.trim() || ONEPASSWORD_APP_TEXT.vaultUnknown,
    kept: onePasswordKeptLine(view.kept),
    status,
    checked: view.syncing
      ? ONEPASSWORD_APP_TEXT.syncing
      : onePasswordCheckedLine(view.checkedAt, now, timeZone),
    syncing: view.syncing,
    removals: paused
      ? {
          title: onePasswordGoneTitle(paused.entries.length),
          names: paused.entries.map((e) => e.name),
          token: paused.token,
        }
      : null,
    notInVault: view.notInVault.map((item) => ({
      id: item.itemId,
      title: item.title,
      reason: onePasswordSkipText(item.reason),
    })),
  };
}

/* Removing the connection ---------------------------------------------------------------------------------------- */

/** The two choices Remove offers for the Vault's sync, “Keep the entries in your Vault” first (the default). */
export const ONEPASSWORD_DISCONNECT_OPTIONS: readonly {
  value: OnePasswordDisconnectChoice;
  label: string;
}[] = [
  { value: 'keep', label: ONEPASSWORD_WORDS.disconnectKeep },
  { value: 'remove', label: ONEPASSWORD_WORDS.disconnectRemove },
];

/**
 * What `connections.disconnect` carries: the person's choice for the Vault's sync, nothing for any other connection (the
 * server ignores it there).
 */
export function disconnectQuery(
  entry: CatalogEntry | string,
  vaultEntries: OnePasswordDisconnectChoice,
): { vaultEntries: OnePasswordDisconnectChoice } | undefined {
  return isVaultSyncConnection(entry) ? { vaultEntries } : undefined;
}

/** The toast after the guard's answer. */
export function onePasswordAnsweredText(answer: OnePasswordRemovalAnswer): string {
  return answer === 'remove' ? ONEPASSWORD_APP_TEXT.removed : ONEPASSWORD_APP_TEXT.kept;
}
