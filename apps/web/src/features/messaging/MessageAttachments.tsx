/**
 * Files on a message (docs/decisions/bp-attachments.md BP-A12, contracts CT-152): images as thumbnails (a gallery
 * grid when there are several) that open in a lightbox with a download; HTML pages and Mermaid diagrams as live
 * previews in the sandboxed frame (AP-320, AP-323); PDFs with their first page (AP-325); audio and video in the
 * browser's players (AP-326); text and logs as a short preview (fetched as text, rendered as text, never as HTML)
 * with a chip; other files as chips with an icon, name, size and download. People's uploads and agents' artifacts
 * look the same. SVGs up to 1 MB show as pictures too, only ever through an `<img>` (AP-100). How each shows is
 * `attachmentPreview` (@whombat/core): the sniffed type, the kind and, for files sniffed as text, the name. A page set
 * (docs/decisions/page-sets.md) is a tile with its cover that opens the set's viewer (`PageSetViewer`).
 *
 * Every file of a message has Download and, where the Whombat says whether it is in its conversation's Files, “Save to
 * Files” or “In Files” (contracts 0.59 CT-312; docs/decisions/files-space.md AP-834…): quiet 28px icons at a chip's end
 * and in a small frame over a picture's corner that shows on hover or focus, words in the lightbox's bar and on a
 * preview card. Nothing is put into Files unless someone asks.
 */
import { FILES_COPY, inFilesLabel, saveActionOf, saveToFilesLabel, showsSvgPreview } from '@whombat/client';
import {
  type Attachment,
  type AttachmentPreview,
  attachmentPreview,
  formatFileSize,
  HTML_PREVIEW_MAX,
  isHtmlPreviewable,
  isPageSet,
  MERMAID_PREVIEW_MAX,
  pageSetTitle,
} from '@whombat/core';
import { Layers, Maximize2 } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { Modal, ModalClose, ModalTitle } from '../../components/Modal';
import {
  mediaType,
  readTextPreview,
  saveAttachment,
  useAttachmentBytes,
  useAttachmentSource,
  useImageSrc,
  useMediaSrc,
  useSvgSrc,
} from './attachmentSource';
import { ActionLabel, DiagramFrame, HtmlPreviewCard, MermaidPreview, PageFrame } from './HtmlPreview';
import styles from './MessageAttachments.module.css';
import { useMessageFiles } from './messageFiles';
import { PageSetViewer } from './PageSetViewer';
import { PdfPages, PdfPreview } from './PdfPreview';

/** Thumbnails fit this box, keeping their shape. */
export const THUMB_MAX = { width: 360, height: 240 };
/** Lines a text preview shows. */
export const PREVIEW_LINES = 10;
const PREVIEW_BYTES = 4096;

export function thumbSize(a: Pick<Attachment, 'width' | 'height'>): { width: number; height: number } {
  const w = a.width ?? THUMB_MAX.width;
  const h = a.height ?? THUMB_MAX.height;
  const scale = Math.min(1, THUMB_MAX.width / w, THUMB_MAX.height / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export function downloadUrl(a: Pick<Attachment, 'url'>): string {
  return `${a.url}${a.url.includes('?') ? '&' : '?'}download=1`;
}

/** The first lines of a text preview; whether there is more. */
export function previewLines(text: string, complete: boolean): { lines: string; more: boolean } {
  const all = text.replace(/\r\n/g, '\n').split('\n');
  // A cut-off last line may end mid-character; drop it unless the file ended there.
  if (!complete && all.length > 1) all.pop();
  const shown = all.slice(0, PREVIEW_LINES);
  return { lines: shown.join('\n').replace(/\n+$/, ''), more: !complete || all.length > PREVIEW_LINES };
}

function DownloadLink({
  attachment,
  label,
  icon = false,
}: {
  attachment: Attachment;
  label?: ReactNode;
  /** A quiet 28px icon (a chip's end, a picture's corner) with “Download” as its tooltip. */
  icon?: boolean;
}) {
  const source = useAttachmentSource();
  const [busy, setBusy] = useState(false);
  const className = icon ? styles.iconAction : styles.download;
  const glyph = <Icon name="download" size={icon ? 16 : 14} />;
  if (source.mode === 'session')
    return (
      <button
        type="button"
        className={className}
        aria-label={`Download ${attachment.name}`}
        title={icon ? FILES_COPY.download : undefined}
        aria-busy={busy || undefined}
        onClick={() => {
          setBusy(true);
          void saveAttachment(source, attachment)
            .catch(() => {})
            .finally(() => setBusy(false));
        }}
      >
        {glyph}
        {label}
      </button>
    );
  return (
    <a
      className={className}
      href={downloadUrl(attachment)}
      download={attachment.name}
      aria-label={`Download ${attachment.name}`}
      title={icon ? FILES_COPY.download : undefined}
    >
      {glyph}
      {label}
    </a>
  );
}

/** The conversation of the message whose files these are (Save to Files needs it); null outside a message. */
const MessageConversation = createContext<string | null>(null);

/**
 * “Save to Files”, or “In Files” once the file is there (opens the conversation's Files), where the Whombat says which
 * (`saveActionOf`); nothing outside a message. One button in both states, so focus stays on it after a click; busy
 * (`aria-busy`) while the save is on its way, already showing it saved. `icon`: 28px with a tooltip; `label`: icon and
 * words (the lightbox); `card`: a preview card's action, whose words hide when the card is narrow.
 */
function SaveToFiles({ attachment, look }: { attachment: Attachment; look: 'icon' | 'label' | 'card' }) {
  const files = useMessageFiles();
  const conversationId = useContext(MessageConversation);
  if (!files || !conversationId) return null;
  const action = saveActionOf(attachment);
  if (!action) return null;
  const saved = action === 'saved';
  const busy = files.busy.has(attachment.id);
  const words = saved ? FILES_COPY.inFiles : FILES_COPY.saveToFiles;
  return (
    <button
      type="button"
      className={cx(look === 'icon' ? styles.iconAction : styles.download, saved && styles.inFiles)}
      // Worded buttons keep their words first in the name (voice control says what it sees).
      aria-label={
        look === 'icon'
          ? saved
            ? inFilesLabel(attachment.name)
            : saveToFilesLabel(attachment.name)
          : `${words}: ${attachment.name}`
      }
      title={look === 'icon' ? words : undefined}
      aria-busy={busy || undefined}
      data-save-to-files={action}
      onClick={() => {
        if (busy) return;
        if (saved) files.openFiles(conversationId);
        else files.save(attachment, conversationId);
      }}
    >
      <Icon name={saved ? 'folderCheck' : 'folderPlus'} size={look === 'icon' ? 16 : 14} />
      {look === 'label' ? words : look === 'card' ? <ActionLabel>{words}</ActionLabel> : null}
    </button>
  );
}

/** A file's two quiet actions: Save to Files (when offered), then Download. */
function FileActions({ attachment, className }: { attachment: Attachment; className?: string }) {
  return (
    <span className={cx(styles.actions, className)} data-file-actions="">
      <SaveToFiles attachment={attachment} look="icon" />
      <DownloadLink attachment={attachment} icon />
    </span>
  );
}

function FileChip({ attachment }: { attachment: Attachment }) {
  const pdf = attachmentPreview(attachment) === 'pdf';
  return (
    <div className={styles.chip}>
      <Icon
        name={attachment.kind === 'file' && !pdf ? 'file' : 'fileText'}
        size={16}
        className={styles.chipIcon}
      />
      <span className={styles.chipName} title={attachment.name}>
        {attachment.name}
      </span>
      <span className={styles.chipSize}>
        {pdf ? 'PDF · ' : ''}
        {formatFileSize(attachment.size)}
      </span>
      <FileActions attachment={attachment} />
    </div>
  );
}

type Preview = { state: 'loading' } | { state: 'ready'; lines: string; more: boolean } | { state: 'error' };

function TextPreview({ attachment }: { attachment: Attachment }) {
  const [preview, setPreview] = useState<Preview>({ state: 'loading' });
  const source = useAttachmentSource();
  useEffect(() => {
    const controller = new AbortController();
    readTextPreview(source, attachment, PREVIEW_BYTES, controller.signal)
      .then(({ text, complete }) => setPreview({ state: 'ready', ...previewLines(text, complete) }))
      .catch(() => {
        if (!controller.signal.aborted) setPreview({ state: 'error' });
      });
    return () => controller.abort();
  }, [source, attachment]);

  return (
    <figure className={styles.text}>
      {preview.state === 'ready' ? (
        <pre className={styles.pre}>
          {preview.lines}
          {preview.more ? '\n…' : ''}
        </pre>
      ) : (
        <p className={styles.previewNote}>
          {preview.state === 'loading' ? 'Loading preview…' : 'Preview isn’t available.'}
        </p>
      )}
      <figcaption>
        <FileChip attachment={attachment} />
      </figcaption>
    </figure>
  );
}

/** How an attachment shows here: `attachmentPreview`, with an SVG over 1 MB as text (or a chip). */
export function previewOf(a: Attachment): AttachmentPreview | null {
  const preview = attachmentPreview(a);
  if (preview === 'svg' && !showsSvgPreview(a)) return a.kind === 'text' ? 'text' : null;
  return preview;
}

/** A picture: raster attachments (AVIF too) load by URL, an SVG through `useSvgSrc` (AP-100). */
function isPicture(a: Attachment): boolean {
  const preview = previewOf(a);
  return preview === 'image' || preview === 'svg';
}

function usePictureSrc(attachment: Attachment, preview = false) {
  const svg = previewOf(attachment) === 'svg';
  const raster = useImageSrc(svg ? null : attachment, { preview });
  const vector = useSvgSrc(svg ? attachment : null);
  return svg ? vector : raster;
}

/** Where a gallery's tile is drawn at most (two or three columns in 420px). */
const TILE_PX = 210;

/**
 * `srcset` over the browser's own URLs (self-hosted, no session): the thumbnail at its width and the file at its own, so
 * a screen that needs more than the thumbnail (3×) takes the file. Unknown widths: the thumbnail alone.
 */
export function thumbSrcSet(
  a: Pick<Attachment, 'url' | 'width' | 'thumbnailUrl' | 'thumbnailWidth'>,
): string | undefined {
  if (!a.thumbnailUrl || !a.thumbnailWidth || !a.width || a.width <= a.thumbnailWidth) return undefined;
  return `${a.thumbnailUrl} ${a.thumbnailWidth}w, ${a.url} ${a.width}w`;
}

function ImageThumb({
  attachment,
  onOpen,
  tile = false,
}: {
  attachment: Attachment;
  onOpen: () => void;
  /** A cell of the gallery grid: the grid sizes it (a square crop). */
  tile?: boolean;
}) {
  const svg = previewOf(attachment) === 'svg';
  // An SVG's size is known once it has loaded (its own width/height or viewBox).
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const size = thumbSize(natural ?? attachment);
  const [broken, setBroken] = useState(false);
  // The Whombat's thumbnail first (WX-03); when it won't load (none made, an older server), the file. An SVG is always
  // the file (drawn as a `data:` URL, AP-100).
  const [whole, setWhole] = useState(false);
  const thumbnail = !whole && !svg && !!attachment.thumbnailUrl;
  const image = usePictureSrc(attachment, thumbnail);
  const urlMode = useAttachmentSource().mode === 'url';
  const failed = () => (thumbnail ? setWhole(true) : setBroken(true));
  // A session that has no thumbnail for it (`variant_unavailable`): the file.
  useEffect(() => {
    if (image.failed && thumbnail) setWhole(true);
  }, [image.failed, thumbnail]);
  if (broken || (image.failed && !thumbnail))
    return svg ? <TextPreview attachment={attachment} /> : <FileChip attachment={attachment} />;
  const srcSet = urlMode && thumbnail ? thumbSrcSet(attachment) : undefined;
  // The picture opens the lightbox; its actions sit beside that button (never inside it), over its top right corner.
  return (
    <div className={cx(styles.thumbBox, tile && styles.tileBox)}>
      <button
        type="button"
        className={cx(styles.thumb, svg && styles.vector, tile && styles.tile)}
        // Narrow places (the thread pane) shrink it, keeping its shape.
        style={tile ? undefined : { width: size.width, aspectRatio: `${size.width} / ${size.height}` }}
        onClick={onOpen}
        aria-label={`Open ${attachment.name}`}
      >
        <img
          src={image.src ?? undefined}
          srcSet={srcSet}
          sizes={srcSet ? `${tile ? TILE_PX : size.width}px` : undefined}
          alt={attachment.name}
          width={size.width}
          height={size.height}
          loading="lazy"
          decoding="async"
          onLoad={
            svg
              ? (e) => {
                  const { naturalWidth: width, naturalHeight: height } = e.currentTarget;
                  if (width > 0 && height > 0) setNatural({ width, height });
                }
              : undefined
          }
          onError={failed}
        />
      </button>
      <FileActions attachment={attachment} className={styles.overlay} />
    </div>
  );
}

function FullImage({ attachment }: { attachment: Attachment }) {
  const image = usePictureSrc(attachment);
  return <LightboxImage src={image.src} alt={attachment.name} />;
}

/**
 * The lightbox (BP-A12): the picture on `sf2` above a bar with its title, a meta line and actions. Attachments and
 * the images in a message's text (AP-101) share it.
 */
export function ImageLightbox({
  open,
  onClose,
  title,
  meta,
  actions,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} width="lg" padded={false}>
      {open && (
        <div className={styles.lightbox}>
          <div className={styles.stage}>{children}</div>
          <div className={styles.lightboxBar}>
            <ModalTitle className={styles.lightboxTitle}>{title}</ModalTitle>
            {meta && <span className={styles.chipSize}>{meta}</span>}
            {actions}
            <ModalClose asChild>
              <button type="button" className={styles.close} aria-label="Close">
                <Icon name="close" size={16} />
              </button>
            </ModalClose>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** A picture in the lightbox, fitted to the window. */
export function LightboxImage({ src, alt }: { src: string | null; alt: string }) {
  return <img className={styles.full} src={src ?? undefined} alt={alt} />;
}

/** What the lightbox shows: an image attachment, or other content of one (a PDF's pages). */
interface Opened {
  attachment: Attachment;
  content?: ReactNode;
  meta?: string;
}

function Lightbox({ opened, onClose }: { opened: Opened | null; onClose: () => void }) {
  const attachment = opened?.attachment;
  return (
    <ImageLightbox
      open={!!attachment}
      onClose={onClose}
      title={attachment?.name ?? ''}
      meta={
        attachment &&
        (opened?.meta ? `${opened.meta} · ` : '') +
          `${attachment.width && attachment.height ? `${attachment.width} × ${attachment.height} · ` : ''}${formatFileSize(attachment.size)}`
      }
      actions={
        attachment && (
          <>
            <SaveToFiles attachment={attachment} look="label" />
            <DownloadLink attachment={attachment} label={FILES_COPY.download} />
          </>
        )
      }
    >
      {attachment && (opened?.content ?? <FullImage attachment={attachment} />)}
    </ImageLightbox>
  );
}

/** Whether `AttachmentViewer` can show it: a picture, a PDF, an HTML page, a diagram or a page set (the rest downloads). */
export function viewable(a: Attachment): boolean {
  if (isPageSet(a)) return true;
  const preview = previewOf(a);
  return (
    preview === 'image' ||
    preview === 'svg' ||
    preview === 'pdf' ||
    preview === 'html' ||
    preview === 'mermaid'
  );
}

/** An HTML page or a diagram in the viewer, live in the sandbox (docs/decisions/visual-replies.md). */
function PageViewerContent({ attachment, kind }: { attachment: Attachment; kind: 'html' | 'mermaid' }) {
  const max = kind === 'html' ? HTML_ATTACHMENT_MAX_BYTES : MERMAID_PREVIEW_MAX * 4;
  const text = useAttachmentBytes(attachment, max, decode);
  if (text.state !== 'ready') return <PreviewNote state={text.state} />;
  const fits =
    kind === 'html'
      ? text.value.length <= HTML_PREVIEW_MAX && isHtmlPreviewable(text.value)
      : !!text.value.trim() && text.value.length <= MERMAID_PREVIEW_MAX;
  if (!fits) return <PreviewNote state="error" />;
  return (
    <div className={styles.pageStage}>
      {kind === 'html' ? (
        <PageFrame html={text.value} title={attachment.name} />
      ) : (
        <DiagramFrame source={text.value} title={attachment.name} />
      )}
    </div>
  );
}

/**
 * One attachment in the lightbox on its own, from outside a message (Files, docs/decisions/files-space.md AP-777): a
 * picture, a PDF's pages, or a live HTML page or diagram; `null` keeps it closed. Download is in its bar, as for a message's.
 * A page set opens in its own viewer, as from its message.
 */
export function AttachmentViewer({
  attachment,
  onClose,
}: {
  attachment: Attachment | null;
  onClose: () => void;
}) {
  const download = useDownloadAttachment();
  if (attachment && isPageSet(attachment))
    return (
      <PageSetViewer attachment={attachment} open onClose={onClose} download={() => download(attachment)} />
    );
  const preview = attachment ? previewOf(attachment) : null;
  return (
    <Lightbox
      opened={
        attachment
          ? preview === 'pdf'
            ? { attachment, content: <PdfPages attachment={attachment} />, meta: 'PDF' }
            : preview === 'html' || preview === 'mermaid'
              ? {
                  attachment,
                  content: <PageViewerContent attachment={attachment} kind={preview} />,
                  meta: preview === 'html' ? 'HTML page' : 'Diagram',
                }
              : { attachment }
          : null
      }
      onClose={onClose}
    />
  );
}

/** Downloads an attachment: the session's save on a managed Whombat, the browser's download of its URL otherwise. */
export function useDownloadAttachment(): (attachment: Attachment) => void {
  const source = useAttachmentSource();
  return (attachment) => {
    if (source.mode === 'session') {
      void saveAttachment(source, attachment).catch(() => {});
      return;
    }
    const a = document.createElement('a');
    a.href = downloadUrl(attachment);
    a.download = attachment.name;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  };
}

/** Largest HTML page read for a preview, in bytes (`HTML_PREVIEW_MAX` characters of UTF-8, at most). */
export const HTML_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function PreviewNote({ state }: { state: 'loading' | 'error' }) {
  return (
    <p className={styles.previewNote}>
      {state === 'loading' ? 'Loading preview…' : 'Preview isn’t available.'}
    </p>
  );
}

/** A preview card's file actions, in its own style: Save to Files (when offered), then Download. */
function CardActions({ attachment }: { attachment: Attachment }) {
  return (
    <>
      <SaveToFiles attachment={attachment} look="card" />
      <DownloadLink attachment={attachment} label={<ActionLabel>{FILES_COPY.download}</ActionLabel>} />
    </>
  );
}

/** An `.html` attachment (CT-152): the page in the sandboxed preview, titled by its `<title>` or its name. */
function HtmlAttachment({ attachment }: { attachment: Attachment }) {
  const page = useAttachmentBytes(attachment, HTML_ATTACHMENT_MAX_BYTES, decode);
  if (page.state === 'error') return <FileChip attachment={attachment} />;
  if (page.state === 'loading') return <PreviewNote state="loading" />;
  const html = page.value;
  // Too long, or no markup at all: its text, as any text file.
  if (html.length > HTML_PREVIEW_MAX || !isHtmlPreviewable(html))
    return <TextPreview attachment={attachment} />;
  return (
    <HtmlPreviewCard
      html={html}
      fallbackTitle={attachment.name}
      meta={`${attachment.name} · ${formatFileSize(attachment.size)}`}
      download={<CardActions attachment={attachment} />}
    />
  );
}

/** An `.mmd` attachment: the diagram. */
function MermaidAttachment({ attachment }: { attachment: Attachment }) {
  const source = useAttachmentBytes(attachment, MERMAID_PREVIEW_MAX * 4, decode);
  if (source.state === 'error') return <TextPreview attachment={attachment} />;
  if (source.state === 'loading') return <PreviewNote state="loading" />;
  if (!source.value.trim() || source.value.length > MERMAID_PREVIEW_MAX)
    return <TextPreview attachment={attachment} />;
  return (
    <MermaidPreview
      source={source.value}
      title={attachment.name}
      meta={`Diagram · ${formatFileSize(attachment.size)}`}
      download={<CardActions attachment={attachment} />}
    />
  );
}

/**
 * A page set (docs/decisions/page-sets.md): the cover of the page it opens on (the Whombat's thumbnail; a quiet
 * placeholder without one), its title and size, Open, and the file's own actions. The cover and Open open the viewer.
 */
function PageSetTile({ attachment }: { attachment: Attachment }) {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const download = useDownloadAttachment();
  const cover = useImageSrc(attachment.thumbnailUrl ? attachment : null, { preview: true });
  const title = pageSetTitle(attachment.name);
  const picture = !!attachment.thumbnailUrl && !broken && !cover.failed;
  return (
    <figure className={styles.pageSet} aria-label={title} data-page-set="">
      <button
        type="button"
        className={styles.pageSetCover}
        // Open beside it is the keyboard's way in: one stop, not two.
        tabIndex={-1}
        aria-label={`Open ${title}`}
        onClick={() => setOpen(true)}
      >
        {picture ? (
          cover.src && (
            <img
              className={styles.pageSetImage}
              src={cover.src}
              alt=""
              width={attachment.thumbnailWidth ?? undefined}
              height={attachment.thumbnailHeight ?? undefined}
              loading="lazy"
              decoding="async"
              onError={() => setBroken(true)}
            />
          )
        ) : (
          <span className={styles.pageSetPlaceholder} data-page-set-placeholder="">
            <Icon icon={Layers} size={24} />
          </span>
        )}
      </button>
      <figcaption className={styles.pageSetCaption}>
        <span className={styles.pageSetTitles}>
          <span className={styles.pageSetTitle} title={title}>
            {title}
          </span>
          <span className={styles.chipSize}>Pages · {formatFileSize(attachment.size)}</span>
        </span>
        <button type="button" className={styles.download} onClick={() => setOpen(true)}>
          <Icon icon={Maximize2} size={14} />
          Open
        </button>
        <FileActions attachment={attachment} />
      </figcaption>
      <PageSetViewer
        attachment={attachment}
        open={open}
        onClose={() => setOpen(false)}
        download={() => download(attachment)}
      />
    </figure>
  );
}

/** Audio or video (AP-326): the browser's player, the chip under it. */
function MediaAttachment({ attachment, kind }: { attachment: Attachment; kind: 'audio' | 'video' }) {
  const type = mediaType(attachment.contentType);
  const media = useMediaSrc(attachment, type ?? 'application/octet-stream');
  const [broken, setBroken] = useState(false);
  if (!type || media.failed || broken) return <FileChip attachment={attachment} />;
  return (
    <figure className={cx(styles.media, kind === 'video' && styles.videoFigure)}>
      {media.src === null ? (
        <PreviewNote state="loading" />
      ) : kind === 'audio' ? (
        // biome-ignore lint/a11y/useMediaCaption: an attachment has no captions to offer
        <audio
          className={styles.audio}
          controls
          preload="metadata"
          src={media.src}
          aria-label={attachment.name}
          onError={() => setBroken(true)}
        />
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: an attachment has no captions to offer
        <video
          className={styles.video}
          controls
          preload="metadata"
          playsInline
          src={media.src}
          aria-label={attachment.name}
          onError={() => setBroken(true)}
        />
      )}
      <figcaption>
        <FileChip attachment={attachment} />
      </figcaption>
    </figure>
  );
}

function FileAttachment({
  attachment,
  onOpen,
}: {
  attachment: Attachment;
  onOpen: (opened: Opened) => void;
}) {
  if (isPageSet(attachment)) return <PageSetTile attachment={attachment} />;
  const preview = previewOf(attachment);
  switch (preview) {
    case 'html':
      return <HtmlAttachment attachment={attachment} />;
    case 'mermaid':
      return <MermaidAttachment attachment={attachment} />;
    case 'pdf':
      return (
        <PdfPreview
          attachment={attachment}
          chip={<FileChip attachment={attachment} />}
          lightbox={(content, meta) => onOpen({ attachment, content, meta })}
        />
      );
    case 'audio':
    case 'video':
      return <MediaAttachment attachment={attachment} kind={preview} />;
    case 'text':
      return <TextPreview attachment={attachment} />;
    default:
      return <FileChip attachment={attachment} />;
  }
}

export function MessageAttachments({
  attachments,
  conversationId,
}: {
  attachments: readonly Attachment[];
  /** The message's conversation: its files offer Save to Files there (AP-834). */
  conversationId?: string;
}) {
  const [open, setOpen] = useState<Opened | null>(null);
  if (!attachments.length) return null;
  const images = attachments.filter(isPicture);
  const others = attachments.filter((a) => !isPicture(a));
  // Several pictures: a gallery grid of square crops (two columns, three from three pictures on).
  const gallery = images.length > 1;
  // The lightbox shows the file as the message has it now (“In Files” after a save).
  const opened = open && {
    ...open,
    attachment: attachments.find((a) => a.id === open.attachment.id) ?? open.attachment,
  };
  return (
    <MessageConversation.Provider value={conversationId ?? null}>
      <div className={styles.attachments}>
        {images.length > 0 && (
          <ul
            className={cx(
              styles.images,
              gallery && styles.gallery,
              gallery && (images.length === 2 || images.length === 4 ? styles.cols2 : styles.cols3),
            )}
            aria-label="Images"
          >
            {images.map((a) => (
              <li key={a.id}>
                <ImageThumb attachment={a} tile={gallery} onOpen={() => setOpen({ attachment: a })} />
              </li>
            ))}
          </ul>
        )}
        {others.length > 0 && (
          <ul className={styles.files} aria-label="Files">
            {others.map((a) => (
              <li key={a.id}>
                <FileAttachment attachment={a} onOpen={setOpen} />
              </li>
            ))}
          </ul>
        )}
        <Lightbox opened={opened} onClose={() => setOpen(null)} />
      </div>
    </MessageConversation.Provider>
  );
}
