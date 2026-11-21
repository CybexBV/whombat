/**
 * A picture on a thing's page (contracts 0.121 `ThingImage`, CT-1000; Whombat service-dashboards.md SD-06;
 * service-dashboards.md AP-4562, AP-4563): a poster, a camera's snapshot, a thumbnail. It keeps its shape's box (2:3,
 * 16:9, 1:1) from the start, a quiet shimmer while it loads; it is read only once its box comes near the screen, through
 * the session like a managed attachment (`thingImages`, an object URL; drawn at once when already held); one that
 * fails, or an item without one, leaves the box with the title's first letter — nothing else on the page breaks. `alt`
 * names it (empty when the words beside it already say it).
 */
import { THING_IMAGE_RATIO, thingImageInitial } from '@whombat/client';
import { thingImageResource } from '@whombat/client/session';
import type { ThingImage, ThingImageShape } from '@whombat/core';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { useOptionalAppServices } from '../../../app/providers';
import { cx } from '../../../components/cx';
import styles from './Service.module.css';

/** Larger than the server ever sends (480 px on the long side, 3 MB at most; SD-S03). */
const PICTURE_MAX_BYTES = 3 * 1024 * 1024;
/** How far below the screen a box starts its read. */
const NEAR_SCREEN = '300px';

/** Whether the box is on or near the screen; once it was, it stays (the read is made). Without an observer: at once. */
function useNearScreen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (near || !ref.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: NEAR_SCREEN },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

type PictureState = { ref: string; src: string } | { ref: string; failed: true } | null;

/** The picture's object URL once read; `failed` when it can't be (gone, refused, not a picture). */
export function useThingPicture(
  burrow: string,
  thing: string,
  ref: string | null,
  near: boolean,
): { src: string | null; failed: boolean } {
  const cache = useOptionalAppServices()?.thingImages ?? null;
  const held = () => {
    if (!ref || !cache) return null;
    const hit = cache.peek(thingImageResource(burrow, thing, ref));
    return hit ? { ref, src: hit.url } : null;
  };
  const [state, setState] = useState<PictureState>(held);
  useEffect(() => {
    if (!ref || !near) return;
    if (!cache) {
      setState({ ref, failed: true });
      return;
    }
    const resource = thingImageResource(burrow, thing, ref);
    const hit = cache.peek(resource);
    if (hit) {
      setState({ ref, src: hit.url });
      return;
    }
    let live = true;
    // Not aborted when the box goes: the read is shared (the same picture twice on a page) and small.
    cache.get(resource, { maxBytes: PICTURE_MAX_BYTES }).then(
      (e) => live && setState({ ref, src: e.url }),
      () => live && setState({ ref, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [cache, burrow, thing, ref, near]);
  if (!ref || state?.ref !== ref) return { src: held()?.src ?? null, failed: false };
  return 'src' in state ? { src: state.src, failed: false } : { src: null, failed: true };
}

export function Picture({
  burrow,
  thing,
  image,
  shape,
  title,
  className,
  muted,
}: {
  burrow: string;
  thing: string;
  /** None: the empty box with the title's first letter. */
  image: ThingImage | null | undefined;
  shape: ThingImageShape;
  /** Whose first letter an empty box shows. */
  title?: string;
  className?: string;
  /** Greyed (an offline camera). */
  muted?: boolean;
}) {
  const [box, near] = useNearScreen<HTMLSpanElement>();
  const { src, failed } = useThingPicture(burrow, thing, image?.ref ?? null, near);
  const [broken, setBroken] = useState<string | null>(null);
  const shown = src && broken !== src ? src : null;
  const empty = !image || failed || (src !== null && broken === src);
  const initial = title ? thingImageInitial(title) : '';
  return (
    <span
      ref={box}
      className={cx(styles.pic, muted && styles.picMuted, className)}
      style={{ aspectRatio: THING_IMAGE_RATIO[shape] } as CSSProperties}
      data-shape={shape}
      {...(empty && image?.alt ? { role: 'img', 'aria-label': image.alt } : {})}
    >
      {shown ? (
        <img
          src={shown}
          alt={image?.alt ?? ''}
          className={styles.picImg}
          decoding="async"
          draggable={false}
          onError={() => setBroken(shown)}
        />
      ) : empty ? (
        <span className={styles.picEmpty} aria-hidden="true">
          {initial}
        </span>
      ) : (
        <span className={styles.picLoading} aria-hidden="true" />
      )}
    </span>
  );
}
