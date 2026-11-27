/**
 * A picture on a thing's page (contracts 0.121, CT-1000; Whombat service-dashboards.md SD-06; service-dashboards.md
 * AP-4650…AP-4654): a poster, a camera's snapshot, a thumbnail, loaded as the phone loads attachment images (with the
 * token from a self-hosted server, through the session into a cache file on a managed Whombat, drawn here in the demo
 * world; `data/thingPictures.ts`). Its shape's box (2:3, 16:9, 1:1) in `sf2` from the start, so nothing moves when it
 * arrives; one that doesn't come, or an item without one, shows the title's first letter quietly in the box. A picture
 * that changes (a snapshot read again) keeps the old one on screen until the new one has loaded. TalkBack reads `alt`.
 */
import { THING_IMAGE_ASPECT } from '@whombat/client';
import { resourceKey } from '@whombat/client/session';
import type { ThingImage, ThingImageShape } from '@whombat/core';
import { useContext, useEffect, useMemo, useState } from 'react';
import { Image, type ImageURISource, StyleSheet, View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { useFileAccess } from '../../data/fileAccess';
import {
  createPictureLru,
  DrawnPictures,
  PICTURE_FILE,
  PICTURE_MAX_BYTES,
  type PicturePlan,
  picturePlan,
} from '../../data/thingPictures';
import { useI18n } from '../../i18n';
import { expoFileApi } from '../../managed/expoFiles';
import { cachedResourceFile, resourceCacheDir, resourceToCacheFile } from '../../managed/files';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';

type SessionPlan = Extract<PicturePlan, { kind: 'session' }>;

/** Streams in progress by cache directory: two boxes of the same picture wait for one download. */
const inflight = new Map<string, Promise<string>>();
/** The pictures streamed into the cache, the least recently shown going first (`PICTURES_KEPT`). */
const kept = createPictureLru();

function sessionPicture(plan: SessionPlan, locale: string): Promise<string> {
  const dir = resourceCacheDir(expoFileApi, plan.ref, plan.scope);
  for (const old of kept.touch(dir)) expoFileApi.remove(old);
  let pending = inflight.get(dir);
  if (!pending) {
    pending = resourceToCacheFile(expoFileApi, plan.session, plan.ref, {
      scope: plan.scope,
      name: PICTURE_FILE,
      maxBytes: PICTURE_MAX_BYTES,
      locale,
    }).finally(() => inflight.delete(dir));
    inflight.set(dir, pending);
  }
  return pending;
}

/** The `<Image>` source of a page's picture: null while it loads (or never), `failed` when it can't be had. */
function usePictureSource(
  thing: string,
  ref: string | null,
): { source: ImageURISource | null; failed: boolean } {
  const { slug } = useBurrowBase();
  const { rawLocale } = useI18n();
  const access = useFileAccess();
  const drawn = useContext(DrawnPictures);
  const plan = useMemo<PicturePlan>(
    () => (ref ? picturePlan({ burrow: slug, thing, ref, access, drawn }) : { kind: 'none' }),
    [slug, thing, ref, access, drawn],
  );
  const sessionKey = plan.kind === 'session' ? resourceKey(plan.ref) : null;
  // A picture already in the cache draws at once (no box first).
  const cached = useMemo(
    () =>
      plan.kind === 'session'
        ? cachedResourceFile(expoFileApi, plan.ref, { scope: plan.scope, name: PICTURE_FILE })
        : null,
    [plan],
  );
  const [file, setFile] = useState<{ key: string; uri: string | null } | null>(null);
  useEffect(() => {
    if (plan.kind !== 'session' || !sessionKey || cached) return;
    let live = true;
    sessionPicture(plan, rawLocale).then(
      (uri) => live && setFile({ key: sessionKey, uri }),
      () => live && setFile({ key: sessionKey, uri: null }),
    );
    return () => {
      live = false;
    };
  }, [plan, sessionKey, cached, rawLocale]);
  return useMemo(() => {
    switch (plan.kind) {
      case 'drawn':
        return { source: { uri: plan.uri }, failed: false };
      case 'session': {
        if (cached) return { source: { uri: cached }, failed: false };
        const mine = file && file.key === sessionKey ? file : null;
        return { source: mine?.uri ? { uri: mine.uri } : null, failed: !!mine && !mine.uri };
      }
      case 'wait':
        return { source: null, failed: false };
      case 'none':
        return { source: null, failed: true };
    }
  }, [plan, cached, file, sessionKey]);
}

export function ThingPicture({
  thing,
  image,
  shape,
  initial,
  width,
  radius = 10,
  letterSize = 22,
  muted = false,
}: {
  /** The page's thingId. */
  thing: string;
  image: ThingImage | null;
  shape: ThingImageShape;
  /** The title's first letter, for an empty box. */
  initial: string;
  /** A fixed width (a list line's small picture); else the width it is given. */
  width?: number;
  radius?: number;
  letterSize?: number;
  /** Greyed: an offline camera. */
  muted?: boolean;
}) {
  const theme = useTheme();
  const { source, failed } = usePictureSource(thing, image?.ref ?? null);
  // What is on screen, and a newer picture loading out of sight until it can replace it (a snapshot read again).
  const [shown, setShown] = useState<ImageURISource | null>(null);
  const [broken, setBroken] = useState(false);
  const next = source && source.uri !== shown?.uri ? source : null;
  useEffect(() => {
    if (!source) {
      setShown(null);
      setBroken(false);
    }
  }, [source]);
  const letter = (failed || broken || !image) && !shown;
  const alt = image?.alt.trim() ?? '';
  return (
    <View
      {...(alt
        ? { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel: alt }
        : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const })}
      style={{
        width: width ?? '100%',
        aspectRatio: THING_IMAGE_ASPECT[shape],
        borderRadius: radius,
        overflow: 'hidden',
        backgroundColor: theme.colors.sf2,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {letter && initial ? (
        <Text size={letterSize} weight={600} color={theme.colors.mut}>
          {initial}
        </Text>
      ) : null}
      {shown ? (
        <Image
          source={shown}
          resizeMode="cover"
          style={[StyleSheet.absoluteFill, muted ? { opacity: 0.4 } : null]}
        />
      ) : null}
      {next ? (
        <Image
          key={next.uri}
          source={next}
          resizeMode="cover"
          style={[StyleSheet.absoluteFill, { opacity: 0 }]}
          onLoad={() => {
            setShown(next);
            setBroken(false);
          }}
          onError={() => {
            // The one on screen stays; without one, the box shows the letter.
            if (!shown) setBroken(true);
          }}
        />
      ) : null}
    </View>
  );
}
