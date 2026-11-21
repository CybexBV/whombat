/**
 * What the web app gives `@whombat/screen/react`'s drawing (Whombat desk-display.md DK-141, DK-142;
 * desk-display-web.md AP-5957): the pictures a view names, loaded the way this page may — the person's app through the
 * session's `thing-image` download (its object URL cache), a screen elsewhere through `screen.image` — and nothing
 * needing the person while there's no answer yet.
 */
import type { DeskAttention, DeskImage, ScreenApi } from '@whombat/client/desk';
import { thingImageResource } from '@whombat/client/session';
import { useCallback, useEffect, useMemo } from 'react';
import { useOptionalAppServices } from '../../app/providers';

export const NO_ATTENTION: DeskAttention = { items: [], more: 0 };

/** The most a picture may be (the contract's pictures are 480 px on their longest side). */
const PICTURE_MAX_BYTES = 4_000_000;

/** Pictures for the person's app (Settings' thumbnails, the editor): the burrow's `thing-image` download. */
export function useScreenImages(burrow?: string): ((image: DeskImage) => Promise<string>) | undefined {
  const cache = useOptionalAppServices()?.thingImages ?? null;
  return useMemo(
    () =>
      cache && burrow
        ? (image: DeskImage) =>
            cache
              .get(thingImageResource(burrow, image.thing, image.ref), { maxBytes: PICTURE_MAX_BYTES })
              .then((e) => e.url)
        : undefined,
    [cache, burrow],
  );
}

/**
 * Pictures for a screen elsewhere (`screen.image`): each read once and kept as an object URL while the page shows,
 * revoked when it goes.
 */
export function useScreenModeImages(api: () => ScreenApi | null): (image: DeskImage) => Promise<string> {
  const held = useMemo(() => new Map<string, Promise<string>>(), []);
  useEffect(
    () => () => {
      for (const url of held.values()) void url.then((u) => URL.revokeObjectURL(u)).catch(() => {});
      held.clear();
    },
    [held],
  );
  return useCallback(
    (image: DeskImage) => {
      const key = `${image.thing}\n${image.ref}`;
      let url = held.get(key);
      if (!url) {
        const now = api();
        if (!now) return Promise.reject(new Error('Not connected.'));
        url = now
          .image({ thing: image.thing, ref: image.ref })
          .then(({ type, bytes }) => URL.createObjectURL(new Blob([bytes as BlobPart], { type })));
        // A picture that couldn't be read is asked again next time.
        url.catch(() => held.delete(key));
        held.set(key, url);
      }
      return url;
    },
    [api, held],
  );
}
