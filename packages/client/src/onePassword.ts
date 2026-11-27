/**
 * A 1Password vault kept in step with the Vault, as the web and the phone show it (Whombat onepassword-sync.md; app
 * docs/app/decisions/onepassword-sync.md): a synced entry's tag and its page's line, the 1Password connection's page part
 * (`connections.onePassword`) as one model, what removing the connection asks, and the toasts of the guard's answers.
 * The words the spec quotes are core's (`ONEPASSWORD_WORDS` and its line helpers); only the few it leaves to the apps
 * are here. Pure.
 */
import { type CatalogEntry, isVaultSyncConnection } from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import {
  type OnePasswordDisconnectChoice,
  type OnePasswordRemovalAnswer,
  type OnePasswordSyncView,
  onePasswordCheckedLine,
  onePasswordEntryLine,
  onePasswordGoneTitle,
  onePasswordKeptLine,
  onePasswordSkipText,
  onePasswordStatusLines,
  onePasswordWords,
  type VaultEntry,
} from '@whombat/core/vault';
import { ApiError } from './http/errors';
import { clientTree } from './i18n/catalog';
import { SETTINGS_AREA_WORDS } from './i18n/messages/chatWork/settings';

/** The words the spec leaves to the apps, in a locale (English when none). */
export function onePasswordAppText(locale?: string | null) {
  const w = clientTree(locale, SETTINGS_AREA_WORDS).onePassword;
  return {
    /** The connection page's section with the sync. */
    section: w.section,
    /** Above the vault's name. */
    vaultLabel: w.vaultLabel,
    /** When the vault's name isn't known yet. */
    vaultUnknown: w.vaultUnknown,
    /** A pass is running or asked for. */
    syncing: w.syncing,
    /** What removing the connection asks, above the two choices. */
    removeAsk: (label: string) => interpolate(w.removeAsk, { label }),
    /** The two choices' group, for screen readers. */
    removeChoice: w.removeChoice,
    /** After the guard's answer. */
    removed: w.removed,
    kept: w.kept,
    /** The set changed since the person saw it (`conflict`): the new one is shown, nothing was changed. */
    changed: w.changed,
    /** The page part didn't load. */
    failed: w.failed,
  };
}

export const ONEPASSWORD_APP_TEXT = onePasswordAppText();

/** The guard's answer was refused because the set changed since it was shown (`conflict`): nothing was removed. */
export function onePasswordSetChanged(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'conflict';
}

/* The Vault ------------------------------------------------------------------------------------------------------ */

/** A Vault entry's tag after its name: “1Password” while it is kept in step there, else null. */
export function vaultEntryTag(entry: Pick<VaultEntry, 'source'>, locale?: string | null): string | null {
  return entry.source?.kind === 'onepassword' ? onePasswordWords(locale).tag : null;
}

/**
 * What removing a synced entry also does, said in its confirmation: only for an entry paired with an item now (one
 * waiting to go, or from a box that doesn't say, has no item there to archive); null otherwise.
 */
export function vaultEntryRemoveNote(
  entry: Pick<VaultEntry, 'source'>,
  locale?: string | null,
): string | null {
  return entry.source?.kind === 'onepassword' && entry.source.paired === true
    ? onePasswordWords(locale).removeArchives
    : null;
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
  locale?: string | null,
): ToneLine | null {
  const source = entry.source;
  if (source?.kind !== 'onepassword') return null;
  return {
    text: onePasswordEntryLine(source, now, timeZone, locale),
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
  locale?: string | null,
): OnePasswordPage {
  const words = onePasswordWords(locale);
  const app = onePasswordAppText(locale);
  const paused = view.outcome === 'paused' && view.removals ? view.removals : null;
  // The paused line is the removals' own title, with their names and the two answers under it: not here again. A sync
  // failing now (the second pass in a row that couldn't finish) has stopped keeping them in step (`bad`), as the head
  // says; one failed pass, waiting for the limit and a read-only token need a look.
  const status = onePasswordStatusLines({ ...view, removals: null }, timeZone, locale).map(
    (text): ToneLine => ({
      text,
      tone: text !== words.readOnly && view.outcome === 'failing' && view.failing ? 'bad' : 'warn',
    }),
  );
  return {
    vault: view.vaultTitle?.trim() || app.vaultUnknown,
    kept: onePasswordKeptLine(view.kept, locale),
    status,
    checked: view.syncing ? app.syncing : onePasswordCheckedLine(view.checkedAt, now, timeZone, locale),
    syncing: view.syncing,
    removals: paused
      ? {
          title: onePasswordGoneTitle(paused.entries.length, locale),
          names: paused.entries.map((e) => e.name),
          token: paused.token,
        }
      : null,
    notInVault: view.notInVault.map((item) => ({
      id: item.itemId,
      title: item.title,
      reason: onePasswordSkipText(item.reason, locale),
    })),
  };
}

/* Removing the connection ---------------------------------------------------------------------------------------- */

/** The two choices Remove offers for the Vault's sync, “Keep the entries in your Vault” first (the default). */
export function onePasswordDisconnectOptions(
  locale?: string | null,
): readonly { value: OnePasswordDisconnectChoice; label: string }[] {
  const words = onePasswordWords(locale);
  return [
    { value: 'keep', label: words.disconnectKeep },
    { value: 'remove', label: words.disconnectRemove },
  ];
}

export const ONEPASSWORD_DISCONNECT_OPTIONS = onePasswordDisconnectOptions();

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
export function onePasswordAnsweredText(answer: OnePasswordRemovalAnswer, locale?: string | null): string {
  const app = onePasswordAppText(locale);
  return answer === 'remove' ? app.removed : app.kept;
}
