/**
 * Where attachment bytes come from (AP-12, AP-16). Legacy self-hosted: the browser loads the same-origin
 * `Attachment.url` itself (cookie). Managed: bytes are streamed through the appliance session and shown from
 * `blob:` object URLs (images) or read as text (previews); downloads are `<a download>` clicks on a blob.
 * Nothing uploaded is ever rendered as a document of the app's origin: no navigation to blobs, SVG never inline: an
 * SVG is shown only as an `<img>` with a `data:` URL (AP-100), where its scripts don't run and a tab can't open it.
 * An HTML page or a diagram is read as text and handed to the sandboxed preview frame (AP-320), never put in a frame
 * as a URL; a PDF is read as bytes and drawn on a canvas (AP-325); audio and video play from object URLs typed as
 * their media (AP-326).
 */
import { SVG_PREVIEW_MAX_BYTES, svgDataUri } from '@whombat/client';
import { type ApplianceSession, readResource, resourceFromUrl } from '@whombat/client/session';
import { type ObjectUrlCache, saveResource } from '@whombat/client/web';
import { type Attachment, baseContentType, PREVIEW_AUDIO_TYPES, PREVIEW_VIDEO_TYPES } from '@whombat/core';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

export type AttachmentSource =
  | { mode: 'url' }
  | { mode: 'session'; session: ApplianceSession; resources: ObjectUrlCache };

const Ctx = createContext<AttachmentSource>({ mode: 'url' });

export function AttachmentSourceProvider({
  value,
  children,
}: {
  value: AttachmentSource;
  children?: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAttachmentSource(): AttachmentSource {
  return useContext(Ctx);
}

/**
 * The `src` for an image attachment: its URL (legacy) or an object URL once streamed (managed). `null`: nothing
 * to load (the caller shows something else).
 */
export function useImageSrc(
  attachment: Pick<Attachment, 'url' | 'thumbnailUrl'> | null,
  options: { preview?: boolean } = {},
): {
  src: string | null;
  failed: boolean;
} {
  const source = useAttachmentSource();
  // The Whombat's thumbnail (contracts 0.55 CT-298; web-messages.md WX-03): its own URL, or the download's `preview`
  // variant over a session (cached apart from the file), as the phone asks for it.
  const preview = !!options.preview && !!attachment?.thumbnailUrl;
  const url = (preview && source.mode === 'url' ? attachment?.thumbnailUrl : attachment?.url) ?? null;
  const [state, setState] = useState<{ src: string | null; failed: boolean }>(() =>
    source.mode === 'url' ? { src: url, failed: false } : { src: null, failed: false },
  );
  useEffect(() => {
    if (url === null) return;
    if (source.mode === 'url') {
      setState({ src: url, failed: false });
      return;
    }
    const file = resourceFromUrl(url);
    if (!file) {
      setState({ src: null, failed: true });
      return;
    }
    const ref = preview && file.kind === 'attachment' ? { ...file, variant: 'preview' as const } : file;
    let live = true;
    const controller = new AbortController();
    setState({ src: null, failed: false });
    source.resources
      .get(ref, { signal: controller.signal })
      .then((e) => live && setState({ src: e.url, failed: false }))
      .catch(() => live && setState({ src: null, failed: true }));
    return () => {
      live = false;
      controller.abort();
    };
  }, [source, url, preview]);
  return state;
}

/** A photo is at most `AVATAR_MAX_BYTES` (32 KiB); this bounds what a runtime may send for one. */
const PHOTO_MAX_BYTES = 1024 * 1024;

/**
 * The `src` of a person's photo (CT-265 `Person.avatarUrl`, docs/decisions/person-avatars.md PA-03): loaded like an
 * image attachment — its URL (legacy), or an object URL from the session's resource cache (managed), shared by every
 * avatar of that person and drawn at once when already held. Not aborted when an avatar goes: the read is shared and
 * small. `null`: no photo, still loading, or it failed (the avatar shows the initials).
 */
/** A photo that is already in the page (the fixture worlds keep theirs as object or `data:` URLs): shown as it is. */
const LOCAL_PHOTO = /^(blob|data):/;

export function usePhotoSrc(url: string | null | undefined): string | null {
  const source = useAttachmentSource();
  const held = (): string | null => {
    if (!url) return null;
    if (source.mode === 'url' || LOCAL_PHOTO.test(url)) return url;
    const ref = resourceFromUrl(url);
    return ref ? (source.resources.peek(ref)?.url ?? null) : null;
  };
  const [state, setState] = useState<{ url: string; src: string } | null>(() => {
    const src = held();
    return url && src ? { url, src } : null;
  });
  useEffect(() => {
    if (!url || source.mode === 'url' || LOCAL_PHOTO.test(url)) return;
    const ref = resourceFromUrl(url);
    if (!ref) return;
    const hit = source.resources.peek(ref);
    if (hit) {
      setState({ url, src: hit.url });
      return;
    }
    let live = true;
    source.resources.get(ref, { maxBytes: PHOTO_MAX_BYTES }).then(
      (e) => live && setState({ url, src: e.url }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [source, url]);
  if (!url) return null;
  if (source.mode === 'url') return url;
  return state?.url === url ? state.src : held();
}

/** The bytes of an SVG attachment, up to `SVG_PREVIEW_MAX_BYTES` (larger: an error, it stays a download). */
async function readSvg(source: AttachmentSource, attachment: Pick<Attachment, 'url'>): Promise<Uint8Array> {
  // Not aborted with the component: the read is shared (cache) and bounded.
  if (source.mode === 'url') {
    const res = await fetch(attachment.url, { credentials: 'include' });
    if (!res.ok) throw new Error(String(res.status));
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > SVG_PREVIEW_MAX_BYTES) throw new Error('too large');
    return bytes;
  }
  const ref = resourceFromUrl(attachment.url);
  if (!ref) throw new Error('not an attachment');
  const r = await readResource(source.session, ref, { maxBytes: SVG_PREVIEW_MAX_BYTES });
  if (r.truncated) throw new Error('too large');
  return r.bytes;
}

/** SVGs already shown, by URL (the thumbnail and the lightbox share one read), the newest 32. */
const svgCache = new Map<string, Promise<string>>();
const SVG_CACHE_ITEMS = 32;

/** Forget every SVG read (sign-out, account or appliance switch, revocation: AP-17). */
export function clearSvgCache(): void {
  svgCache.clear();
}

/**
 * The `src` of an SVG attachment as a picture (AP-100): its bytes as a `data:image/svg+xml` URL, for an `<img>`
 * only. Not a `blob:` URL: that has the app's origin, and “Open image in new tab” would run the SVG's scripts there.
 */
export function useSvgSrc(attachment: Pick<Attachment, 'url'> | null): {
  src: string | null;
  failed: boolean;
} {
  const source = useAttachmentSource();
  const url = attachment?.url ?? null;
  const [state, setState] = useState<{ src: string | null; failed: boolean }>({ src: null, failed: false });
  useEffect(() => {
    if (url === null) return;
    let live = true;
    const key = `${source.mode}:${url}`;
    let pending = svgCache.get(key);
    if (!pending) {
      pending = readSvg(source, { url }).then(svgDataUri);
      svgCache.set(key, pending);
      pending.catch(() => svgCache.delete(key));
      for (const old of svgCache.keys()) {
        if (svgCache.size <= SVG_CACHE_ITEMS) break;
        svgCache.delete(old);
      }
    }
    setState({ src: null, failed: false });
    pending.then(
      (src) => live && setState({ src, failed: false }),
      () => live && setState({ src: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [source, url]);
  return state;
}

/** The first `bytes` of a text attachment, as text (never HTML). */
export async function readTextPreview(
  source: AttachmentSource,
  attachment: Pick<Attachment, 'url' | 'size'>,
  bytes: number,
  signal: AbortSignal,
): Promise<{ text: string; complete: boolean }> {
  if (source.mode === 'url') {
    const res = await fetch(attachment.url, {
      credentials: 'include',
      headers: { range: `bytes=0-${bytes - 1}` },
      signal,
    });
    if (!res.ok) throw new Error(String(res.status));
    return { text: await res.text(), complete: res.status === 200 || attachment.size <= bytes };
  }
  const ref = resourceFromUrl(attachment.url);
  if (!ref) throw new Error('not an attachment');
  const r = await readResource(source.session, ref, {
    maxBytes: bytes,
    range: { start: 0, end: bytes },
    signal,
  });
  return { text: new TextDecoder().decode(r.bytes), complete: attachment.size <= bytes };
}

/** Managed downloads: stream, then save. */
export function saveAttachment(
  source: Extract<AttachmentSource, { mode: 'session' }>,
  attachment: Attachment,
) {
  const ref = resourceFromUrl(attachment.url, { download: true });
  if (!ref) return Promise.reject(new Error('not an attachment'));
  return saveResource(source.session, ref, attachment.name);
}

/** The whole of an attachment, up to `maxBytes` (larger: an error; it stays a download). */
export async function readAttachmentBytes(
  source: AttachmentSource,
  attachment: Pick<Attachment, 'url' | 'size'>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (attachment.size > maxBytes) throw new Error('too large');
  if (source.mode === 'url') {
    const res = await fetch(attachment.url, { credentials: 'include', ...(signal && { signal }) });
    if (!res.ok) throw new Error(String(res.status));
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('too large');
    return bytes;
  }
  const ref = resourceFromUrl(attachment.url);
  if (!ref) throw new Error('not an attachment');
  const r = await readResource(source.session, ref, { maxBytes, ...(signal && { signal }) });
  if (r.truncated) throw new Error('too large');
  return r.bytes;
}

export type Loaded<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error' };

/** An attachment's bytes, turned into what a preview needs (`convert` may throw: an error). */
export function useAttachmentBytes<T>(
  attachment: Pick<Attachment, 'url' | 'size'>,
  maxBytes: number,
  convert: (bytes: Uint8Array) => T,
): Loaded<T> {
  const source = useAttachmentSource();
  const [state, setState] = useState<Loaded<T>>({ state: 'loading' });
  const { url, size } = attachment;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `convert` is a pure function of the bytes
  useEffect(() => {
    const controller = new AbortController();
    setState({ state: 'loading' });
    readAttachmentBytes(source, { url, size }, maxBytes, controller.signal)
      .then((bytes) => {
        if (!controller.signal.aborted) setState({ state: 'ready', value: convert(bytes) });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ state: 'error' });
      });
    return () => controller.abort();
  }, [source, url, size, maxBytes]);
  return state;
}

/** Media a player may be given: the attachment's type when it is one of the preview types, else nothing. */
export function mediaType(contentType: string): string | null {
  const type = baseContentType(contentType);
  return (PREVIEW_AUDIO_TYPES as readonly string[]).includes(type) ||
    (PREVIEW_VIDEO_TYPES as readonly string[]).includes(type)
    ? type
    : null;
}

/** Largest audio or video played in the page (managed: it is held in memory while shown). */
export const MEDIA_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The `src` of an audio or video attachment: its URL (legacy), or an object URL of its bytes typed as `type`
 * (managed; revoked when the player goes). `type` is the media type the player plays (`mediaType`).
 */
export function useMediaSrc(
  attachment: Pick<Attachment, 'url' | 'size'>,
  type: string,
): { src: string | null; failed: boolean } {
  const source = useAttachmentSource();
  const { url, size } = attachment;
  const [state, setState] = useState<{ src: string | null; failed: boolean }>(() =>
    source.mode === 'url' ? { src: url, failed: false } : { src: null, failed: false },
  );
  useEffect(() => {
    if (source.mode === 'url') {
      setState({ src: url, failed: false });
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ src: null, failed: false });
    readAttachmentBytes(source, { url, size }, MEDIA_MAX_BYTES, controller.signal)
      .then((bytes) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
        setState({ src: objectUrl, failed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ src: null, failed: true });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, url, size, type]);
  return state;
}
