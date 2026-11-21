/**
 * A person's photo on the phone (contracts CT-265, docs/decisions/person-avatars.md): `Person.avatarUrl` is an
 * attachment URL, loaded exactly like an image attachment — from a legacy server with the session token, from a
 * managed Whombat through its session into a scoped cache file (cleared with the others on sign-out, revocation or a
 * switch, AP-17). A new photo has a new URL, so a cached file is never stale. Null until there is something to draw:
 * the avatar shows the initials meanwhile, and when it fails.
 */
import { resourceFromUrl } from '@whombat/client/session';
import { useEffect, useMemo, useState } from 'react';
import type { ImageSourcePropType } from 'react-native';
import { type FileAccess, useFileAccess } from '../data/fileAccess';
import { expoFileApi } from '../managed/expoFiles';
import { cachedResourceFile, resourceToCacheFile } from '../managed/files';

/** The cache file's name (one photo per attachment directory). */
const PHOTO_NAME = 'photo';
/** A photo is at most `AVATAR_MAX_BYTES` (32 KiB); a runtime's limit may grow, a phone's memory doesn't. */
const PHOTO_MAX_BYTES = 1024 * 1024;

/** Streams in progress by cache path: every avatar of the same person waits for one download. */
const inflight = new Map<string, Promise<string>>();

function sessionPhoto(url: string, access: Extract<FileAccess, { kind: 'session' }>): Promise<string> {
  const ref = resourceFromUrl(url);
  if (!ref) return Promise.reject(new Error('not an attachment'));
  const key = `${access.scope}\n${url}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = resourceToCacheFile(expoFileApi, access.session, ref, {
      scope: access.scope,
      name: PHOTO_NAME,
      maxBytes: PHOTO_MAX_BYTES,
    }).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

/** The file a managed photo is already in (drawn at once, no flash of initials), or null. */
function cachedPhoto(url: string, access: FileAccess | null): string | null {
  if (!access) return null;
  const ref = resourceFromUrl(url);
  return ref ? cachedResourceFile(expoFileApi, ref, { scope: access.scope, name: PHOTO_NAME }) : null;
}

/** The `<Image>` source of a person's photo, or null (none, not loaded yet, or it failed). */
export function usePhotoSource(url: string | null | undefined): ImageSourcePropType | null {
  const access = useFileAccess();
  const [file, setFile] = useState<{ url: string; uri: string } | null>(null);
  const session = access;
  useEffect(() => {
    if (!url || !session) return;
    if (cachedPhoto(url, session)) return;
    let live = true;
    sessionPhoto(url, session).then(
      (uri) => live && setFile({ url, uri }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [url, session]);
  // Computed once per URL and access: a new source object would make `<Image>` load again.
  const immediate = useMemo<ImageSourcePropType | null>(() => {
    if (!url || !access) return null;
    const cached = cachedPhoto(url, access);
    return cached ? { uri: cached } : null;
  }, [url, access]);
  const streamed = useMemo(() => (file && file.url === url ? { uri: file.uri } : null), [file, url]);
  return immediate ?? streamed;
}
