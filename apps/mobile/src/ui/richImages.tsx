/**
 * Images in a message's text on mobile (CT-90, docs/decisions/app-managed.md AP-101): `![alt](src)` as an image,
 * an SVG an agent drew as a drawing with its code a toggle away. Raster images through `<Image>`, SVG through
 * react-native-svg's `SvgXml` after `svgForNative` (nothing in it runs or fetches). Remote (`http(s)`) images load on
 * a self-hosted Whombat only; on a managed one they are a link with their description and host, as on the web.
 */

import { svgForNative, svgFromDataUri, svgIntrinsicSize } from '@whombat/client';
import { svgImageDocument } from '@whombat/core';
import { type ReactNode, useEffect, useState } from 'react';
import { Image, Linking, Text as RNText, useWindowDimensions, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { imageBox } from '../data/attachments';
import { useMobileT } from '../i18n';
import { useManaged } from '../managed/context';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import { Touchable } from './Touchable';

/** Pictures in a bubble: at most 260dp or 62% of the screen wide, 220dp tall. */
function useMaxWidth(): number {
  const window = useWindowDimensions();
  return Math.min(260, Math.round(window.width * 0.62));
}

function hostOf(src: string): string {
  return /^[a-z]+:\/\/([^/?#]+)/i.exec(src)?.[1] ?? src;
}

/** A picture's frame: the attachment thumbnail's 16dp radius on `sf2`. */
function Frame({ width, height, children }: { width: number; height: number; children?: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        width,
        height,
        borderRadius: 16,
        overflow: 'hidden',
        backgroundColor: theme.colors.sf2,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </View>
  );
}

function SvgPicture({ xml, label, maxWidth }: { xml: string; label: string; maxWidth: number }) {
  const [failed, setFailed] = useState(false);
  const box = imageBox(svgIntrinsicSize(xml) ?? { width: null, height: null }, maxWidth);
  if (failed) return null;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label}>
      <Frame width={box.width} height={box.height}>
        <SvgXml
          xml={svgForNative(xml)}
          width={box.width}
          height={box.height}
          onError={() => setFailed(true)}
        />
      </Frame>
    </View>
  );
}

function RasterPicture({ src, alt, maxWidth }: { src: string; alt: string; maxWidth: number }) {
  const { t: tMobile } = useMobileT();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    Image.getSize(
      src,
      (width, height) => live && setSize({ width, height }),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [src]);
  if (failed) return <ImageLink src={src} alt={alt} />;
  const box = imageBox(size ?? { width: null, height: null }, maxWidth);
  return (
    <Frame width={box.width} height={box.height}>
      <Image
        source={{ uri: src }}
        style={{ width: box.width, height: box.height }}
        resizeMode="contain"
        accessibilityLabel={alt || tMobile('ui.image')}
        onError={() => setFailed(true)}
      />
    </Frame>
  );
}

/** A remote image that isn't loaded here: its description and host, opening it in the browser. */
function ImageLink({ src, alt }: { src: string; alt: string }) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const remote = /^https?:\/\//i.test(src);
  if (!remote) return alt ? <Text size={15.5}>{alt}</Text> : null;
  const host = hostOf(src);
  return (
    <Touchable
      onPress={() => void Linking.openURL(src)}
      feedback="wash"
      ringRadius={12}
      accessibilityRole="link"
      accessibilityLabel={tMobile('screens2.rich.imageOn', {
        alt: alt || tMobile('screens2.rich.image'),
        host,
      })}
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 44,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
      }}
    >
      <Text size={14} weight={500} numberOfLines={1} style={{ flexShrink: 1 }}>
        {alt || tMobile('ui.image')}
      </Text>
      <Text size={11} mono color={theme.colors.mut}>
        {host}
      </Text>
    </Touchable>
  );
}

/** `![alt](src)` as its own row in the bubble. */
export function MessageImage({ src, alt }: { src: string; alt: string }) {
  const { t: tMobile } = useMobileT();
  const managed = useManaged();
  const maxWidth = useMaxWidth();
  const svg = svgFromDataUri(src);
  if (svg) return <SvgPicture xml={svg} label={alt || tMobile('ui.image')} maxWidth={maxWidth} />;
  if (/^https?:\/\//i.test(src) && managed) return <ImageLink src={src} alt={alt} />;
  return <RasterPicture src={src} alt={alt} maxWidth={maxWidth} />;
}

/**
 * An SVG code block (`lang: 'svg'`) that `svgImageDocument` accepts: the drawing, then “View code” / “Hide code”.
 * `null` when it isn't a drawing (the caller shows the code block).
 */
export function SvgDrawing({ text, codeBlock }: { text: string; codeBlock: ReactNode }) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const maxWidth = useMaxWidth();
  const [code, setCode] = useState(false);
  const doc = svgImageDocument(text);
  if (!doc) return <>{codeBlock}</>;
  return (
    <View style={{ gap: 4, alignItems: 'flex-start' }}>
      <SvgPicture xml={doc} label={tMobile('ui.drawing')} maxWidth={maxWidth} />
      <Touchable
        onPress={() => setCode((c) => !c)}
        feedback="wash"
        ringRadius={8}
        accessibilityRole="button"
        accessibilityState={{ expanded: code }}
        accessibilityLabel={code ? tMobile('ui.hide-code') : tMobile('ui.view-code')}
        style={{ minHeight: 44, minWidth: 44, justifyContent: 'center' }}
      >
        <RNText style={[textMetrics({ size: 12, family: 'mono' }), { color: theme.colors.mut }]}>
          {code ? tMobile('ui.hide-code') : tMobile('ui.view-code')}
        </RNText>
      </Touchable>
      {code ? <View style={{ alignSelf: 'stretch' }}>{codeBlock}</View> : null}
    </View>
  );
}
