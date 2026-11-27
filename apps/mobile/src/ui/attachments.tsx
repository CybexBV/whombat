/**
 * Attachments on mobile (docs/decisions/bp-attachments.md BP-A14, BP-A18–A20): the composer's upload chips
 * (progress, cancel, retry, remove; 44dp targets; a failure says why in full, Retry only when it can help)
 * and a message's files — images loaded with the session token that open full screen, and file chips that
 * download to the cache under their own name and open the system share sheet (open in another app, save,
 * send). Colors only from the theme.
 *
 * On a managed Whombat (AP-16, AP-27) the bytes come through the appliance session instead: streamed into
 * scoped cache files (`resourceToCacheFile`) that `<Image>` and the share sheet open, cleared on sign-out,
 * revocation or a switch. Nothing is fetched from a URL.
 *
 * SVGs up to 1 MB show as pictures (AP-100): their text drawn by react-native-svg's `SvgXml`, after
 * `svgForNative` has removed everything that would fetch or run. How each file shows follows `attachmentPreview`
 * (CT-152, AP-328): AVIF images where the platform draws them, an `.html` page in the confined WebView card
 * (`htmlPreview.tsx`), a Mermaid file as its source; PDFs, audio and video stay rows that open the share sheet.
 *
 * Every file of a message has Download (the share sheet) and, where the Whombat says whether it is in its conversation's
 * Files, “Save to Files” or “In Files” (contracts 0.59 CT-312, files-space.md AP-840): two quiet 32dp rounds over a
 * picture's top right corner, two 44dp icons at a row's end, Save beside Share in the full-screen viewer.
 *
 * A page set (page-sets.md) is a card of its own: the picture of its first page, its title, “Pages · 30 MB” and Open,
 * which opens its pages in the viewer (`pageSetViewer.tsx`); its Download and Save to Files sit over the picture.
 */

import {
  inFilesLabel,
  SVG_PREVIEW_MAX_BYTES,
  saveToFilesLabel,
  showsSvgPreview,
  svgForNative,
  svgIntrinsicSize,
  type UploadItem,
  uploadStatusText,
} from '@whombat/client';
import { resourceFromUrl } from '@whombat/client/session';
import {
  type Attachment,
  attachmentPreview,
  baseContentType,
  HTML_PREVIEW_MAX,
  isHtmlPreviewable,
  MERMAID_PREVIEW_MAX,
  pageSetTitle,
} from '@whombat/core';
import { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  type ImageStyle,
  Platform,
  ScrollView,
  type StyleProp,
  useWindowDimensions,
  View,
} from 'react-native';
import { SvgXml } from 'react-native-svg';
import { attachmentMeta, fileTile, imageBox, localFileName, tilePicture } from '../data/attachments';
import type { FileAccess } from '../data/fileAccess';
import { pageSetMeta, pagesCopy } from '../data/pageSets';
import { supportsAvif } from '../data/richPreview';
import type { MessageFileActions } from '../data/useFiles';
import { mobileTranslator, useI18n, useMobileT } from '../i18n';
import { expoFileApi } from '../managed/expoFiles';
import { resourceToCacheFile } from '../managed/files';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FullScreenModal } from './fullScreen';
import { DiagramPreview, HtmlPreviewCard } from './htmlPreview';
import {
  Camera,
  Download,
  FileIcon,
  FileText,
  FolderCheck,
  FolderPlus,
  ImageIcon,
  Layers,
  type LucideIcon,
  Share2,
  X,
} from './icons';
import { CHAT_GUTTER } from './insets';
import { PageSetViewer } from './pageSetViewer';
import { Button } from './primitives';
import { Sheet } from './sheet';
import { Touchable } from './Touchable';
import { hitSlopFor } from './touchTarget';

export type { FileAccess } from '../data/fileAccess';

/**
 * The attachment as a local file, streamed through the session (managed only); `preview` asks for the thumbnail the
 * Whombat made (the download's `preview` variant, CT-298), cached apart from the file. `name`: the cache file's own (a
 * page set's picture is a PNG, not its ZIP's name).
 */
async function sessionFile(
  a: Attachment,
  access: Extract<FileAccess, { kind: 'session' }>,
  preview = false,
  name = localFileName(a),
  locale?: string | null,
): Promise<string> {
  const ref = resourceFromUrl(a.url);
  if (!ref) throw new Error('not an attachment');
  return resourceToCacheFile(
    expoFileApi,
    access.session,
    preview && ref.kind === 'attachment' ? { ...ref, variant: 'preview' } : ref,
    { scope: access.scope, name, locale },
  );
}

/**
 * An attachment image: with the bearer token (legacy), or from its cache file once streamed (managed). `thumbnail`: a
 * conversation's tile, which shows the Whombat's thumbnail when there is one (MX-09) and the file when it doesn't load.
 */
export function AttachmentImage({
  attachment,
  access,
  style,
  resizeMode,
  accessibilityLabel,
  thumbnail = false,
}: {
  attachment: Attachment;
  access: FileAccess;
  style: StyleProp<ImageStyle>;
  resizeMode: 'cover' | 'contain';
  accessibilityLabel?: string;
  thumbnail?: boolean;
}) {
  const { t: tMobile } = useMobileT();
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // The thumbnail didn't load: the file instead.
  const [whole, setWhole] = useState(false);
  const picture = thumbnail && !whole ? tilePicture(attachment) : { path: attachment.url, preview: false };
  useEffect(() => {
    let live = true;
    setUri(null);
    setFailed(false);
    sessionFile(attachment, access, picture.preview, undefined, rawLocale).then(
      (u) => live && setUri(u),
      () => {
        if (!live) return;
        if (picture.preview) setWhole(true);
        else setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [attachment, access, picture.preview, rawLocale]);
  if (!uri)
    return (
      <View
        style={[
          style as object,
          { alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.sf2 },
        ]}
        accessibilityLabel={tMobile(failed ? 'screens2.attach.couldntLoad' : 'screens2.attach.loading', {
          name: attachment.name,
        })}
      >
        {failed ? (
          <Text size={11} mono color={theme.colors.mut}>
            {tMobile('ui.couldnt-load-it')}
          </Text>
        ) : (
          <ActivityIndicator color={theme.colors.mut} />
        )}
      </View>
    );
  return (
    <Image
      source={{ uri }}
      style={style}
      resizeMode={resizeMode}
      {...(accessibilityLabel ? { accessibilityLabel } : {})}
    />
  );
}

/** An SVG attachment's text, for `SvgXml` (null while loading; an error when it can't be shown). */
async function readSvgText(a: Attachment, access: FileAccess, locale?: string | null): Promise<string> {
  if (a.size > SVG_PREVIEW_MAX_BYTES) throw new Error('too large');
  const text = await new File(await sessionFile(a, access, false, undefined, locale)).text();
  if (text.length > SVG_PREVIEW_MAX_BYTES) throw new Error('too large');
  return svgForNative(text);
}

/** Largest HTML page read for a preview, in bytes. */
const HTML_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;
/** How tall a picture in a message gets (AP-706): full width, but the conversation stays in view. */
const IMAGE_MAX_HEIGHT = 360;

/** A text attachment's whole text, up to `maxBytes` (larger: an error; it stays a row). */
async function readText(
  a: Attachment,
  access: FileAccess,
  maxBytes: number,
  locale?: string | null,
): Promise<string> {
  if (a.size > maxBytes) throw new Error('too large');
  return new File(await sessionFile(a, access, false, undefined, locale)).text();
}

/** An image this device draws: raster (AVIF where the platform supports it, AP-328). */
export function isRaster(a: Attachment): boolean {
  if (attachmentPreview(a) !== 'image') return false;
  return baseContentType(a.contentType) !== 'image/avif' || supportsAvif(Platform.OS, Platform.Version);
}

/** Whether a file opens in the full-screen viewer (a raster image, or an SVG this phone draws); else the share sheet. */
export function opensInViewer(a: Attachment): boolean {
  return isRaster(a) || (attachmentPreview(a) === 'svg' && showsSvgPreview(a));
}

/**
 * An `.html` page (CT-152) in the preview card, or a Mermaid file as its source; the file row until it is read,
 * and when it can't be shown.
 */
function TextPreviewAttachment({
  attachment,
  access,
  kind,
  files,
}: {
  attachment: Attachment;
  access: FileAccess;
  kind: 'html' | 'mermaid';
  files: MessageFileActions | null;
}) {
  const { t: tMobile } = useMobileT();
  const { rawLocale } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setText(null);
    setFailed(false);
    readText(
      attachment,
      access,
      kind === 'html' ? HTML_ATTACHMENT_MAX_BYTES : MERMAID_PREVIEW_MAX * 4,
      rawLocale,
    ).then(
      (t) => live && setText(t),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [attachment, access, kind, rawLocale]);
  const showable =
    text !== null &&
    (kind === 'html'
      ? text.length <= HTML_PREVIEW_MAX && isHtmlPreviewable(text)
      : text.trim() !== '' && text.length <= MERMAID_PREVIEW_MAX);
  if (failed || !showable) return <FileRow attachment={attachment} access={access} files={files} />;
  return (
    <View style={{ width: '100%', gap: 6 }}>
      {kind === 'html' ? (
        <HtmlPreviewCard html={text} fallbackTitle={attachment.name} meta={attachment.name} />
      ) : (
        <DiagramPreview source={text} title={attachment.name} meta={tMobile('screens2.attach.diagram')} />
      )}
      <FileRow attachment={attachment} access={access} files={files} />
    </View>
  );
}

const svgTexts = new Map<string, Promise<string>>();

function useSvgText(attachment: Attachment | null, access: FileAccess, locale: string) {
  const [state, setState] = useState<{ xml: string | null; failed: boolean }>({ xml: null, failed: false });
  useEffect(() => {
    if (!attachment) return;
    let live = true;
    const key = `${access.scope}|${attachment.url}`;
    let pending = svgTexts.get(key);
    if (!pending) {
      pending = readSvgText(attachment, access, locale);
      svgTexts.set(key, pending);
      pending.catch(() => svgTexts.delete(key));
      for (const old of svgTexts.keys()) {
        if (svgTexts.size <= 16) break;
        svgTexts.delete(old);
      }
    }
    setState({ xml: null, failed: false });
    pending.then(
      (xml) => live && setState({ xml, failed: false }),
      () => live && setState({ xml: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [attachment, access, locale]);
  return state;
}

/** The box an SVG is drawn in: its own shape (width/height or viewBox) fitted into `max`. */
function svgBox(xml: string | null, maxWidth: number, maxHeight?: number) {
  return imageBox(svgIntrinsicSize(xml ?? '') ?? { width: null, height: null }, maxWidth, maxHeight);
}

/** An SVG attachment as a picture; `onFail` when it can't be (the caller shows the file row instead). */
function SvgPicture({
  attachment,
  access,
  maxWidth,
  maxHeight,
  onFail,
}: {
  attachment: Attachment;
  access: FileAccess;
  maxWidth: number;
  maxHeight?: number;
  onFail?: () => void;
}) {
  const { t: tMobile } = useMobileT();
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const { xml, failed } = useSvgText(attachment, access, rawLocale);
  useEffect(() => {
    if (failed) onFail?.();
  }, [failed, onFail]);
  const box = svgBox(xml, maxWidth, maxHeight);
  if (!xml)
    return (
      <View
        style={[box, { alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.sf2 }]}
        accessibilityLabel={tMobile(failed ? 'screens2.attach.couldntLoad' : 'screens2.attach.loading', {
          name: attachment.name,
        })}
      >
        {failed ? null : <ActivityIndicator color={theme.colors.mut} />}
      </View>
    );
  return (
    <View style={box} accessible accessibilityRole="image" accessibilityLabel={attachment.name}>
      <SvgXml xml={xml} width={box.width} height={box.height} onError={() => onFail?.()} />
    </View>
  );
}

/* Composer chips ----------------------------------------------------------------------------------- */

export function UploadChips({
  items,
  onRemove,
  onRetry,
  canRetry,
}: {
  items: readonly UploadItem[];
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
  /** Whether a failed chip offers Retry (not for a file that can never go up as it is). */
  canRetry: (localId: string) => boolean;
}) {
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const window = useWindowDimensions();
  if (!items.length) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
      accessibilityLabel={tMobile('ui.attachments')}
    >
      {items.map((item) => {
        const failed = item.state === 'failed';
        return (
          <View
            key={item.localId}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 2,
              // A failure says why in full: its chip may take the composer's width and wrap.
              maxWidth: failed ? window.width - 28 : 280,
              minHeight: 44,
              paddingLeft: 14,
              borderRadius: 22,
              backgroundColor: theme.colors.sf2,
              overflow: 'hidden',
            }}
          >
            <View style={{ flexShrink: 1, paddingVertical: 6 }}>
              <Text size={12.5} weight={500} numberOfLines={1}>
                {item.name}
              </Text>
              <Text
                size={11}
                mono
                {...(failed ? {} : { numberOfLines: 1 })}
                color={failed ? theme.colors.bad : theme.colors.mut}
                accessibilityLiveRegion={failed ? 'assertive' : 'none'}
              >
                {uploadStatusText(item, rawLocale)}
              </Text>
            </View>
            {failed && canRetry(item.localId) ? (
              <Touchable
                onPress={() => onRetry(item.localId)}
                accessibilityLabel={tMobile('screens2.attach.retry', { name: item.name })}
                feedback="wash"
                ringRadius={22}
                style={{
                  minWidth: 44,
                  minHeight: 44,
                  paddingHorizontal: 8,
                  borderRadius: 22,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text size={12.5} weight={600} color={theme.colors.brand}>
                  {tMobile('ui.retry')}
                </Text>
              </Touchable>
            ) : null}
            <Touchable
              onPress={() => onRemove(item.localId)}
              accessibilityLabel={tMobile(
                item.state === 'uploading' ? 'screens2.attach.cancel' : 'screens2.attach.remove',
                { name: item.name },
              )}
              feedback="wash"
              ringRadius={22}
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <X size={15} color={theme.colors.mut} strokeWidth={2} />
            </Touchable>
            {item.state === 'uploading' ? (
              <View
                accessibilityRole="progressbar"
                accessibilityLabel={tMobile('screens2.attach.uploading', { name: item.name })}
                accessibilityValue={{ min: 0, max: 100, now: Math.round(item.progress * 100) }}
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 2,
                  backgroundColor: theme.colors.line,
                }}
              >
                <View
                  style={{
                    width: `${Math.round(item.progress * 100)}%`,
                    height: 2,
                    backgroundColor: theme.colors.brand,
                  }}
                />
              </View>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

/* A message's files -------------------------------------------------------------------------------- */

/** Streams a file through the session into its scoped cache file and opens the share sheet on it. */
export async function shareAttachment(
  a: Attachment,
  access: FileAccess,
  locale?: string | null,
): Promise<void> {
  const uri = await sessionFile(a, access, false, undefined, locale);
  await Sharing.shareAsync(uri, { mimeType: a.contentType, dialogTitle: a.name });
}

/** “Save to Files” / “In Files” for a file (AP-840): what to do on a tap, the button's name, its icon. */
function saveControl(attachment: Attachment, files: MessageFileActions | null, locale?: string | null) {
  const action = files?.actionOf(attachment) ?? null;
  if (!files || !action) return null;
  const busy = files.busy.has(attachment.id);
  const saved = action === 'saved';
  return {
    saved,
    busy,
    label: saved ? inFilesLabel(attachment.name, locale) : saveToFilesLabel(attachment.name, locale),
    onPress: () => {
      if (busy) return;
      if (saved) files.open();
      else files.save(attachment);
    },
  };
}

/**
 * Over a picture's top right corner (AP-840): Save to Files (when offered) and Download, two quiet 32dp rounds on the
 * surface, a little see-through; 44dp to touch.
 */
function PictureActions({
  attachment,
  access,
  files,
}: {
  attachment: Attachment;
  access: FileAccess;
  files: MessageFileActions | null;
}) {
  const { t: tMobile } = useMobileT();
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const [sharing, setSharing] = useState(false);
  const control = saveControl(attachment, files, rawLocale);
  return (
    <View style={{ position: 'absolute', top: 8, right: 8, flexDirection: 'row', gap: 12 }}>
      {control ? (
        <Touchable
          onPress={control.onPress}
          accessibilityLabel={control.label}
          accessibilityState={{ busy: control.busy }}
          hitSlop={hitSlopFor(32)}
          feedback="fade"
          ringRadius={16}
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1,
            borderColor: theme.colors.line,
            backgroundColor: theme.colors.sf,
            opacity: 0.9,
          }}
        >
          {control.saved ? (
            <FolderCheck size={16} color={theme.colors.ok} strokeWidth={1.75} />
          ) : (
            <FolderPlus size={16} color={theme.colors.ink2} strokeWidth={1.75} />
          )}
        </Touchable>
      ) : null}
      <Touchable
        onPress={() => {
          if (sharing) return;
          setSharing(true);
          shareAttachment(attachment, access, rawLocale)
            .catch(() => {})
            .finally(() => setSharing(false));
        }}
        accessibilityLabel={tMobile('screens2.attach.download', { name: attachment.name })}
        accessibilityState={{ busy: sharing }}
        hitSlop={hitSlopFor(32)}
        feedback="fade"
        ringRadius={16}
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: theme.colors.line,
          backgroundColor: theme.colors.sf,
          opacity: 0.9,
        }}
      >
        {sharing ? (
          <ActivityIndicator size="small" color={theme.colors.ink2} />
        ) : (
          <Download size={16} color={theme.colors.ink2} strokeWidth={1.75} />
        )}
      </Touchable>
    </View>
  );
}

/**
 * A file as a row: a tap downloads it to the share sheet (as before), and at its end Save to Files (when offered) and
 * Download, 44dp each (AP-840).
 */
function FileRow({
  attachment,
  access,
  files,
}: {
  attachment: Attachment;
  access: FileAccess;
  files: MessageFileActions | null;
}) {
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const Icon = attachment.kind === 'file' ? FileIcon : FileText;
  const control = saveControl(attachment, files, rawLocale);
  const open = () => {
    if (state === 'busy') return;
    setState('busy');
    shareAttachment(attachment, access, rawLocale).then(
      () => setState('idle'),
      () => setState('failed'),
    );
  };
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'stretch',
        minHeight: 48,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
    >
      <Touchable
        onPress={open}
        feedback="wash"
        ringRadius={14}
        accessibilityLabel={`${attachment.name}, ${attachmentMeta(attachment, rawLocale)}`}
        accessibilityHint={tMobile('ui.downloads-the-file-and-opens-the-share-sheet')}
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          minHeight: 48,
          paddingVertical: 8,
          paddingLeft: 12,
          paddingRight: 4,
        }}
      >
        <Icon size={18} color={theme.colors.mut} strokeWidth={1.75} />
        <View style={{ flexShrink: 1 }}>
          <Text size={14} weight={500} numberOfLines={1}>
            {attachment.name}
          </Text>
          <Text size={11} mono color={state === 'failed' ? theme.colors.bad : theme.colors.mut}>
            {state === 'failed'
              ? tMobile('ui.couldnt-open-it-tap-to-try-again')
              : attachmentMeta(attachment, rawLocale)}
          </Text>
        </View>
      </Touchable>
      {control ? (
        <Touchable
          onPress={control.onPress}
          accessibilityLabel={control.label}
          accessibilityState={{ busy: control.busy }}
          feedback="wash"
          ringRadius={22}
          style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}
        >
          {control.saved ? (
            <FolderCheck size={17} color={theme.colors.ok} strokeWidth={1.75} />
          ) : (
            <FolderPlus size={17} color={theme.colors.mut} strokeWidth={1.75} />
          )}
        </Touchable>
      ) : null}
      <Touchable
        onPress={open}
        accessibilityLabel={tMobile('screens2.attach.download', { name: attachment.name })}
        accessibilityState={{ busy: state === 'busy' }}
        feedback="wash"
        ringRadius={22}
        style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}
      >
        {state === 'busy' ? (
          <ActivityIndicator color={theme.colors.mut} />
        ) : (
          <Download size={17} color={theme.colors.mut} strokeWidth={1.75} />
        )}
      </Touchable>
    </View>
  );
}

/* Page sets ------------------------------------------------------------------------------------------ */

/** A page set's card is never wider than its 16:10 picture at a picture's most in a message. */
const PAGES_TILE_MAX_WIDTH = Math.round((IMAGE_MAX_HEIGHT * 16) / 10);
/** Its picture's height for a width (16:10, as the runner takes it). */
const pagesCoverHeight = (width: number) => Math.round((width * 10) / 16);
/** The line under the picture: title, meta and the 44dp Open, with its padding and the border above it. */
const PAGES_FOOT_HEIGHT = 61;

/**
 * The picture of a set's first page: only the thumbnail the Whombat keeps (never the set's file itself), a quiet `sf2`
 * while it loads, and the set's mark where there is none.
 */
function PageSetCover({ attachment, access }: { attachment: Attachment; access: FileAccess }) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  const [uri, setUri] = useState<string | null>(null);
  const [none, setNone] = useState(!attachment.thumbnailUrl);
  useEffect(() => {
    setUri(null);
    setNone(!attachment.thumbnailUrl);
    if (!attachment.thumbnailUrl) return;
    let live = true;
    sessionFile(attachment, access, true, 'cover.png', rawLocale).then(
      (u) => live && setUri(u),
      () => live && setNone(true),
    );
    return () => {
      live = false;
    };
  }, [attachment, access, rawLocale]);
  if (uri)
    return (
      <Image
        source={{ uri }}
        style={{ width: '100%', height: '100%' }}
        resizeMode="cover"
        onError={() => {
          setUri(null);
          setNone(true);
        }}
      />
    );
  return (
    <View
      style={{
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.sf2,
      }}
    >
      {none ? <Layers size={28} color={theme.colors.mut} strokeWidth={1.5} /> : null}
    </View>
  );
}

/** A page set on a message: its picture, title and size, Open; Download and Save to Files over the picture. */
function PageSetTile({
  attachment,
  access,
  files,
  maxWidth,
}: {
  attachment: Attachment;
  access: FileAccess;
  files: MessageFileActions | null;
  maxWidth: number;
}) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  const copy = pagesCopy(rawLocale);
  const [open, setOpen] = useState(false);
  const title = pageSetTitle(attachment.name);
  const meta = pageSetMeta(attachment, rawLocale);
  const width = Math.min(maxWidth, PAGES_TILE_MAX_WIDTH);
  return (
    <View
      style={{
        width,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
    >
      <View>
        <Touchable
          onPress={() => setOpen(true)}
          accessibilityLabel={`${title}, ${meta}`}
          accessibilityHint={copy.openHint}
          feedback="fade"
          ringRadius={16}
          style={{ width: '100%', height: pagesCoverHeight(width - 2) }}
        >
          <PageSetCover attachment={attachment} access={access} />
        </Touchable>
        <PictureActions attachment={attachment} access={access} files={files} />
      </View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingVertical: 8,
          paddingLeft: 12,
          paddingRight: 8,
          borderTopWidth: 1,
          borderTopColor: theme.colors.line,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text size={14} weight={600} numberOfLines={1}>
            {title}
          </Text>
          <Text size={11} mono color={theme.colors.mut} numberOfLines={1}>
            {meta}
          </Text>
        </View>
        <Button
          label={copy.open}
          variant="secondary"
          onPress={() => setOpen(true)}
          accessibilityLabel={`${copy.open} ${title}`}
          style={{ paddingHorizontal: 18 }}
        />
      </View>
      {open ? (
        <PageSetViewer
          attachment={attachment}
          access={access}
          onClose={() => setOpen(false)}
          onDownload={() => shareAttachment(attachment, access, rawLocale)}
        />
      ) : null}
    </View>
  );
}

/**
 * An image (or a drawable SVG) full screen, with Share; also what a picture in Files opens (AP-772…). A message's
 * picture has Save to Files beside Share where the Whombat offers it (AP-840).
 */
export function ImageViewer({
  attachment,
  access,
  onClose,
  files = null,
}: {
  attachment: Attachment | null;
  access: FileAccess;
  onClose: () => void;
  files?: MessageFileActions | null;
}) {
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const window = useWindowDimensions();
  const [sharing, setSharing] = useState(false);
  if (!attachment) return null;
  const control = saveControl(attachment, files, rawLocale);
  return (
    <FullScreenModal onClose={onClose}>
      {(insets) => {
        const room = {
          width: window.width - insets.left - insets.right,
          height: window.height - insets.top - insets.bottom - 120,
        };
        const box = imageBox(attachment, room.width, room.height);
        return (
          <>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingHorizontal: 8,
                minHeight: 56,
              }}
            >
              <Touchable
                onPress={onClose}
                accessibilityLabel={tMobile('ui.close')}
                feedback="wash"
                ringRadius={22}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <X size={20} color={theme.colors.ink} strokeWidth={2} />
              </Touchable>
              <Text size={15} weight={600} numberOfLines={1} style={{ flex: 1 }} accessibilityRole="header">
                {attachment.name}
              </Text>
              {control ? (
                <Touchable
                  onPress={control.onPress}
                  accessibilityLabel={control.label}
                  accessibilityState={{ busy: control.busy }}
                  feedback="wash"
                  ringRadius={22}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {control.saved ? (
                    <FolderCheck size={19} color={theme.colors.ok} strokeWidth={1.75} />
                  ) : (
                    <FolderPlus size={19} color={theme.colors.ink} strokeWidth={1.75} />
                  )}
                </Touchable>
              ) : null}
              <Touchable
                onPress={() => {
                  setSharing(true);
                  shareAttachment(attachment, access, rawLocale)
                    .catch(() => {})
                    .finally(() => setSharing(false));
                }}
                accessibilityLabel={tMobile('screens2.attach.share', { name: attachment.name })}
                feedback="wash"
                ringRadius={22}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {sharing ? (
                  <ActivityIndicator color={theme.colors.ink} />
                ) : (
                  <Share2 size={19} color={theme.colors.ink} strokeWidth={1.75} />
                )}
              </Touchable>
            </View>
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              {isRaster(attachment) ? (
                <AttachmentImage
                  attachment={attachment}
                  access={access}
                  style={{ width: box.width, height: box.height }}
                  resizeMode="contain"
                  accessibilityLabel={attachment.name}
                />
              ) : (
                <SvgPicture
                  attachment={attachment}
                  access={access}
                  maxWidth={room.width - 32}
                  maxHeight={room.height}
                />
              )}
            </View>
            <Text size={11} mono color={theme.colors.mut} style={{ textAlign: 'center', paddingBottom: 12 }}>
              {attachmentMeta(attachment, rawLocale)}
            </Text>
          </>
        );
      }}
    </FullScreenModal>
  );
}

export function MessageAttachmentsView({
  attachments,
  access,
  files = null,
}: {
  attachments: readonly Attachment[];
  /** `null` while the session token is read: images wait for it (see `FileAccess`). */
  access: FileAccess | null;
  /** Save to Files for this conversation's messages (AP-840); null: Download only. */
  files?: MessageFileActions | null;
}) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const window = useWindowDimensions();
  const [open, setOpen] = useState<Attachment | null>(null);
  // SVGs that couldn't be drawn go back to their file row.
  const [flat, setFlat] = useState<ReadonlySet<string>>(() => new Set());
  const markFlat = useCallback((id: string) => setFlat((f) => (f.has(id) ? f : new Set(f).add(id))), []);
  if (!attachments.length) return null;
  // Images take the message's full width (the list's, AP-706), up to a height that leaves the conversation in view.
  const maxWidth = Math.max(1, window.width - 2 * CHAT_GUTTER);
  const avif = supportsAvif(Platform.OS, Platform.Version);
  const tile = (a: Attachment) => fileTile(a, { avif, svg: !flat.has(a.id) });
  const placeholder = (a: Attachment) => {
    const t = tile(a);
    if (t === 'pages') {
      const width = Math.min(maxWidth, PAGES_TILE_MAX_WIDTH);
      return { width, height: pagesCoverHeight(width - 2) + PAGES_FOOT_HEIGHT + 2, borderRadius: 16 };
    }
    if (t === 'image') return { ...imageBox(a, maxWidth, IMAGE_MAX_HEIGHT), borderRadius: 16 };
    return { width: 220, height: 48, borderRadius: 14 };
  };
  if (!access)
    return (
      <View style={{ gap: 8, alignItems: 'flex-start', width: '100%' }}>
        {attachments.map((a) => (
          <View
            key={a.id}
            accessibilityLabel={tMobile('screens2.attach.loading', { name: a.name })}
            style={[placeholder(a), { backgroundColor: theme.colors.sf2 }]}
          />
        ))}
      </View>
    );
  // The viewer shows the file as the message has it now (“In Files” after a save).
  const shown = open ? (attachments.find((a) => a.id === open.id) ?? open) : null;
  return (
    <View style={{ gap: 8, alignItems: 'flex-start', width: '100%' }}>
      {attachments.map((a) =>
        tile(a) === 'pages' ? (
          <PageSetTile key={a.id} attachment={a} access={access} files={files} maxWidth={maxWidth} />
        ) : tile(a) === 'image' ? (
          // The picture opens the viewer; its actions sit beside that button (never inside it), over its corner.
          <View key={a.id}>
            <Touchable
              onPress={() => setOpen(a)}
              accessibilityLabel={tMobile('screens2.attach.image', { name: a.name })}
              accessibilityHint={tMobile('ui.opens-the-image')}
              feedback="fade"
              ringRadius={16}
              style={{ borderRadius: 16, overflow: 'hidden', backgroundColor: theme.colors.sf2 }}
            >
              <AttachmentImage
                attachment={a}
                access={access}
                style={imageBox(a, maxWidth, IMAGE_MAX_HEIGHT)}
                resizeMode="cover"
                thumbnail
              />
            </Touchable>
            <PictureActions attachment={a} access={access} files={files} />
          </View>
        ) : tile(a) === 'svg' ? (
          <View key={a.id}>
            <Touchable
              onPress={() => setOpen(a)}
              accessibilityLabel={tMobile('screens2.attach.image', { name: a.name })}
              accessibilityHint={tMobile('ui.opens-the-image')}
              feedback="fade"
              ringRadius={16}
              style={{ borderRadius: 16, overflow: 'hidden', backgroundColor: theme.colors.sf2 }}
            >
              <SvgPicture
                attachment={a}
                access={access}
                maxWidth={maxWidth}
                maxHeight={IMAGE_MAX_HEIGHT}
                onFail={() => markFlat(a.id)}
              />
            </Touchable>
            <PictureActions attachment={a} access={access} files={files} />
          </View>
        ) : tile(a) === 'html' || tile(a) === 'mermaid' ? (
          <TextPreviewAttachment
            key={a.id}
            attachment={a}
            access={access}
            kind={tile(a) === 'mermaid' ? 'mermaid' : 'html'}
            files={files}
          />
        ) : (
          <FileRow key={a.id} attachment={a} access={access} files={files} />
        ),
      )}
      <ImageViewer attachment={shown} access={access} onClose={() => setOpen(null)} files={files} />
    </View>
  );
}

export type AttachChoice = 'camera' | 'photos' | 'files';

/** What the paperclip offered (AP-714), now the first lines of the message box's “+”: their words, hints and icons. */
export function attachChoices(locale?: string | null): readonly {
  kind: AttachChoice;
  label: string;
  hint: string;
  Icon: LucideIcon;
  symbol: string;
}[] {
  const tr = mobileTranslator(locale);
  return [
    {
      kind: 'camera',
      label: tr.t('screens2.attach.takePhoto'),
      hint: tr.t('screens2.attach.takePhotoHint'),
      Icon: Camera,
      symbol: 'camera',
    },
    {
      kind: 'photos',
      label: tr.t('screens2.attach.gallery'),
      hint: tr.t('screens2.attach.galleryHint'),
      Icon: ImageIcon,
      symbol: 'photo.on.rectangle',
    },
    {
      kind: 'files',
      label: tr.t('screens2.attach.file'),
      hint: tr.t('screens2.attach.fileHint'),
      Icon: FileIcon,
      symbol: 'doc',
    },
  ];
}

/** A line of the message box's “+”: a way to add a file, or the saved prompts. */
export interface AddChoice {
  id: string;
  label: string;
  hint: string;
  Icon: LucideIcon;
  /** Its SF Symbol in iOS's own menu. */
  symbol: string;
}

/** The “+”'s choices as a sheet (where iOS's own menu isn't), rows in the message menu's style. */
export function AddSheet({
  visible,
  choices,
  label,
  onClose,
  onDismissed,
  onPick,
}: {
  visible: boolean;
  choices: readonly AddChoice[];
  /** What TalkBack calls the sheet. */
  label: string;
  onClose: () => void;
  onDismissed?: () => void;
  onPick: (id: string) => void;
}) {
  const theme = useTheme();
  return (
    <Sheet visible={visible} onClose={onClose} label={label} {...(onDismissed ? { onDismissed } : {})}>
      {choices.map(({ id, label: words, hint, Icon }) => (
        <Touchable
          key={id}
          onPress={() => onPick(id)}
          feedback="wash"
          accessibilityLabel={words}
          accessibilityHint={hint}
          style={{
            minHeight: 52,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 14,
            paddingHorizontal: 22,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
          }}
        >
          <Icon size={19} color={theme.colors.ink2} strokeWidth={1.75} />
          <Text size={16} weight={500}>
            {words}
          </Text>
        </Touchable>
      ))}
    </Sheet>
  );
}
