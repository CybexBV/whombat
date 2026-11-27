/**
 * Share to Whombat (AP-715): what another app's share sheet handed over (Android SEND / SEND_MULTIPLE, the iPhone's
 * share extension, ios-parity.md AP-6322: text, a link, photos, any files), turned into the share screen's prefill, and held here until that screen sends it or it is
 * cancelled. In memory only: file contents never travel in navigation params, and a share someone makes before they
 * are signed in waits here until the navigator is up. Pure: no React Native imports, unit-tested.
 *
 * The copies made of the shared files (on Android expo-share-intent copies a `content://` share into the app's cache, on
 * iPhone the share extension copies it into the app group's folder) are deleted once the share is sent, cancelled or
 * replaced by a newer one, and when the scope guard wipes what the phone keeps (MX-07) — only files directly in that
 * folder, never a file the other app shared by its own path.
 */
import { mobileTranslator } from '../i18n/translate';
import { type PickedFile, photoName } from './attachments';

/** One file of a share, as expo-share-intent parses it (Android copies it into the app's cache first). */
export interface SharedFileIn {
  path: string | null;
  mimeType: string | null;
  fileName: string | null;
  size: number | null;
}

/** A share as expo-share-intent parses it: `text` from EXTRA_TEXT, `meta.title` from EXTRA_TITLE or EXTRA_SUBJECT. */
export interface ShareIntentIn {
  text?: string | null;
  meta?: { title?: string | null } | null;
  files?: readonly SharedFileIn[] | null;
}

export interface SharedPayload {
  /** Which share this is: a new one replaces what the share screen shows. */
  id: number;
  /** The composer's text: the shared text or link, with the page's or mail's title above it. */
  text: string;
  /** What goes up through the composer's upload path (sizes and errors as the composer shows them). */
  files: PickedFile[];
  /** Files past `MAX_SHARED_FILES`, left out. */
  dropped: number;
  /** Files the phone couldn't hand over (no path or no size). */
  unreadable: number;
}

/** As many files as the photo picker takes at once. */
export const MAX_SHARED_FILES = 10;

/** The app group the iPhone's share extension and the app share (app.config.cjs). */
export const SHARE_APP_GROUP = 'group.com.whombat.mobile';

/**
 * Whether `url` is the iPhone share extension opening the app (`whombat://dataUrl=<key>#<kind>`): the share waits in the
 * app group, and the link opens no screen of its own.
 */
export function isShareUrl(url: string | null | undefined): boolean {
  return !!url && /^whombat:\/\/dataUrl=/i.test(url);
}

/**
 * The text to prefill: the shared text, with the title on its own line above it when the text doesn't already say it
 * (a browser shares a page's address with its title as the subject).
 */
export function shareText(intent: Pick<ShareIntentIn, 'text' | 'meta'>): string {
  const text = intent.text?.trim() ?? '';
  const title = intent.meta?.title?.trim() ?? '';
  if (!title || text.includes(title)) return text;
  return text ? `${title}\n${text}` : title;
}

/**
 * The shared files as the composer's picked files: photos named as the photo picker names them (`photoName`), other
 * files by their own name. A file without a path or a size can't be uploaded and is counted, not added.
 */
export function sharedFiles(
  files: readonly SharedFileIn[],
  now: Date = new Date(),
  locale?: string,
): Pick<SharedPayload, 'files' | 'dropped' | 'unreadable'> {
  const readable = files.filter((f) => !!f.path && !!f.size && f.size > 0);
  const kept = readable.slice(0, MAX_SHARED_FILES);
  return {
    files: kept.map((f, i) => {
      const type = f.mimeType ?? '';
      const ext = type.startsWith('image/')
        ? (type.split('/')[1]?.replace('jpeg', 'jpg').replace(/\+.*$/, '') ?? 'jpg')
        : '';
      return {
        uri: f.path ?? '',
        name: ext
          ? photoName(f.fileName, ext, i, now, locale)
          : f.fileName?.trim() || mobileTranslator(locale).t('data.shareInbox.fileName'),
        type,
        size: f.size ?? 0,
      };
    }),
    dropped: readable.length - kept.length,
    unreadable: files.length - readable.length,
  };
}

/** A share's prefill; null when it carries nothing at all. */
export function sharePayload(
  intent: ShareIntentIn,
  now: Date = new Date(),
  locale?: string,
): Omit<SharedPayload, 'id'> | null {
  const text = shareText(intent);
  const files = sharedFiles(intent.files ?? [], now, locale);
  if (!text && !files.files.length && !files.unreadable) return null;
  return { text, ...files };
}

const LINK = /^https?:\/\/\S+$/i;

/** The share screen's line under its title: “2 photos · A link”, “1 file · Text”. */
export function shareSummary(payload: Pick<SharedPayload, 'text' | 'files'>, locale?: string): string {
  const { t, tp } = mobileTranslator(locale);
  const photos = payload.files.filter((f) => f.type.startsWith('image/')).length;
  const others = payload.files.length - photos;
  const parts = [
    photos ? tp('data.shareInbox.photos', photos) : null,
    others ? tp('data.shareInbox.files', others) : null,
    payload.text ? (LINK.test(payload.text) ? t('data.shareInbox.link') : t('data.shareInbox.text')) : null,
  ].filter((p): p is string => p !== null);
  return parts.join(' · ') || t('data.shareInbox.nothing');
}

/** A quiet note for files that were left out, or null. */
export function shareNote(
  payload: Pick<SharedPayload, 'dropped' | 'unreadable'>,
  locale?: string,
): string | null {
  const { t, tp } = mobileTranslator(locale);
  const notes = [
    payload.dropped ? t('data.shareInbox.dropped', { max: MAX_SHARED_FILES }) : null,
    payload.unreadable ? tp('data.shareInbox.unreadable', payload.unreadable) : null,
  ].filter((n): n is string => n !== null);
  return notes.length ? notes.join(' ') : null;
}

/* The copies in the cache (MX-07) ------------------------------------------------------------------------------------ */

const bare = (path: string) => path.replace(/^file:\/\//i, '');

/**
 * The files of a share that are copies in the app's cache (`cacheDir`, a path or `file://` URI): directly in it, no `..`.
 * Anything else (a photo the gallery shared by its own path) is the other app's and stays.
 */
export function cachedShareFiles(files: readonly Pick<PickedFile, 'uri'>[], cacheDir: string): string[] {
  const dir = bare(cacheDir).replace(/\/*$/, '/');
  if (dir === '/') return [];
  return files
    .map((f) => bare(f.uri))
    .filter((p) => p.startsWith(dir) && p.length > dir.length && !p.slice(dir.length).includes('/'))
    .filter((p) => !p.split('/').includes('..'));
}

interface FileCleaner {
  cacheDir: string;
  remove(paths: readonly string[]): void;
}

let cleaner: FileCleaner | null = null;

/** How the phone deletes the copies (set once by `startShareCapture`; nothing is deleted without it). */
export function setShareFileCleaner(next: FileCleaner | null): void {
  cleaner = next;
}

/** Deletes `share`'s copies, except those `keep` still uses (the same file shared again lands at the same name). */
function removeCopies(share: SharedPayload | null, keep: SharedPayload | null = null): void {
  if (!share || !cleaner) return;
  const kept = new Set(keep ? cachedShareFiles(keep.files, cleaner.cacheDir) : []);
  const gone = cachedShareFiles(share.files, cleaner.cacheDir).filter((p) => !kept.has(p));
  if (!gone.length) return;
  try {
    cleaner.remove(gone);
  } catch {
    // Already gone, or the cache was cleared: nothing left to delete.
  }
}

/* The pending share ------------------------------------------------------------------------------------------------- */

let pending: SharedPayload | null = null;
let seq = 0;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

/** Holds a new share (replacing one not yet sent, whose copies go); an empty one is ignored. */
export function putShare(payload: Omit<SharedPayload, 'id'> | null): SharedPayload | null {
  if (!payload) return null;
  const replaced = pending;
  pending = { ...payload, id: ++seq };
  removeCopies(replaced, pending);
  notify();
  return pending;
}

/** The share waiting to be sent, if any. */
export function currentShare(): SharedPayload | null {
  return pending;
}

/** Sent or cancelled: forgets that share and deletes its copies (never a newer one that arrived meanwhile). */
export function clearShare(id: number): void {
  if (pending?.id !== id) return;
  const done = pending;
  pending = null;
  removeCopies(done);
  notify();
}

/** The scope guard's wipe (sign-out, another Whombat, revocation): the waiting share and its copies go (MX-07). */
export function wipeShares(): void {
  const gone = pending;
  pending = null;
  removeCopies(gone);
  if (gone) notify();
}

/** Called when a share arrives or goes. */
export function subscribeShare(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
