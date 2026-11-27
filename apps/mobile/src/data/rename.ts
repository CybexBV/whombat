/**
 * Renaming a server or a connection on the phone: a long press on its row on Connections offers Open and Rename, a
 * server's page has Rename in its ⋯ menu, and Rename turns the name into a box where it is shown. Which rows can be
 * renamed and what is sent are the shared `thingRenameTarget` and `renameValue` (`@whombat/client`); this module holds
 * the menus, the words and the name a row shows while the list catches up with a rename. Pure (no React Native
 * imports) so it is unit-tested in Node.
 */
import { renameValue, type ThingRenameTarget } from '@whombat/client';
import { mobileTranslator } from '../i18n/translate';
import { type NativeMenuSpec, plainMenu } from './nativeMenu';

export function renameCopy(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    open: t('data.rename.open'),
    rename: t('data.rename.rename'),
    /** The box's name for TalkBack and VoiceOver. */
    label: (name: string) => t('data.rename.label', { name }),
    /** Under a server's box: what an empty box does. */
    serverHint: t('data.rename.serverHint'),
    cancel: t('data.common.cancel'),
    failed: t('data.rename.failed'),
    /** What TalkBack calls a row's menu sheet. */
    rowMenu: (name: string) => t('data.rename.rowMenu', { name }),
    /** The server page's ⋯ button. */
    more: (name: string) => t('data.rename.more', { name }),
  };
}

export const RENAME_COPY = renameCopy();

export type ThingRowPick = 'open' | 'rename';

/** A server's or connection's row held: Open, then Rename, under its name. */
export function thingRowMenu(name: string, locale?: string): NativeMenuSpec {
  const copy = renameCopy(locale);
  return plainMenu(
    [
      [
        { id: 'open', title: copy.open, icon: 'arrow.up.right.square' },
        { id: 'rename', title: copy.rename, icon: 'pencil' },
      ],
    ],
    name,
  );
}

/** A server page's ⋯: Rename first. */
export function serverHeadMenu(locale?: string): NativeMenuSpec {
  return plainMenu([[{ id: 'rename', title: renameCopy(locale).rename, icon: 'pencil' }]]);
}

export function parseThingRowPick(id: string): ThingRowPick | null {
  return id === 'open' || id === 'rename' ? id : null;
}

/** A name that is only its id written otherwise (“BlackBox” for `blackbox`) is set as an id is, in the mono face. */
export function isOwnId(name: string, id: string): boolean {
  return name.toLowerCase() === id.toLowerCase();
}

/** The name a row shows once a rename went: what was typed, a server's id for an empty box; null when nothing changes. */
export function savedName(target: ThingRenameTarget, typed: string): string | null {
  const value = renameValue(target, typed);
  if (!value) return null;
  return value.name ?? target.id;
}

/** Names just saved, by thing id (`server:the-titan`), with the name the list said then. */
export type SavedNames = ReadonlyMap<string, { name: string; was: string }>;

/** What a row shows: the saved name while the list still says the one before it, else the list's. */
export function shownName(saved: SavedNames, thingId: string, listName: string): string {
  const s = saved.get(thingId);
  return s && listName === s.was ? s.name : listName;
}

/** How long a saved name outlasts a list that hasn't caught up (a read that failed, a slow one). */
export const SAVED_NAME_MS = 10_000;
