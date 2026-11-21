/**
 * A page set full screen (docs/decisions/page-sets.md): the set's pages in the preview's sandboxed frame, one frame per
 * page, read out of the set's file by byte range (`PageSetReader`). The frame page is the HTML preview's
 * (`/sandbox/html-frame.html`, `sandbox="allow-scripts"`, sandbox.ts); the app writes a loader into it whose only
 * content is the viewer's script (`pages-runtime.js`), and answers that script's asks for files through `PageSetHost`.
 * A link inside a page never acts by itself: another page of the set opens in a new frame, a file is offered for
 * download, a link to the internet asks first.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { PageSetHost, PageSetReader, type PageTarget, pageFileName, pageTarget } from '@whombat/client/pages';
import pagesRuntimeUrl from '@whombat/client/pages/pages-runtime.js?url';
import { readResource, resourceFromUrl } from '@whombat/client/session';
import { type Attachment, formatFileSize, PAGES_DEFAULT_OPEN, pageSetTitle } from '@whombat/core';
import { ArrowLeft, Download, Layers, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { saveBlob } from '../../lib/saveBlob';
import { type AttachmentSource, useAttachmentSource } from './attachmentSource';
import htmlStyles from './HtmlPreview.module.css';
import styles from './PageSetViewer.module.css';
import { frameReady, type HtmlMessage, SANDBOX_FLAGS, SANDBOX_FRAME_URL } from './sandbox';

/** A page of the set as the viewer shows it. */
interface Shown {
  path: string;
  hash: string;
  /** The page's `?…`, which it reads from its address. */
  query: string;
}

/** The set's file, read by byte range: over the session (a ranged download), else fetched once and sliced. */
export function pageSetReader(source: AttachmentSource, attachment: Pick<Attachment, 'url' | 'size'>) {
  if (source.mode === 'session') {
    const ref = resourceFromUrl(attachment.url);
    return new PageSetReader(async ({ start, end }, signal) => {
      if (!ref) throw new Error('not an attachment');
      const r = await readResource(source.session, ref, {
        maxBytes: end - start,
        range: { start, end },
        ...(signal && { signal }),
      });
      // A short or cut-off read is never taken for the file's bytes.
      if (r.truncated || r.bytes.byteLength !== end - start) throw new Error('short read');
      return r.bytes;
    }, attachment.size);
  }
  // The browser's own URL (fixture mode, the legacy server): a Range header may not be honoured there.
  let whole: Promise<Uint8Array> | null = null;
  return new PageSetReader(async ({ start, end }) => {
    whole ??= fetch(attachment.url, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return new Uint8Array(await res.arrayBuffer());
      })
      .catch((err: unknown) => {
        whole = null;
        throw err;
      });
    const bytes = await whole;
    return bytes.subarray(start, end);
  }, attachment.size);
}

/** The document the frame page writes: the viewer's script, nothing else. */
function loaderHtml(): string {
  const src = new URL(pagesRuntimeUrl, window.location.href).href.replace(/"/g, '&quot;');
  return `<!doctype html><script src="${src}"></script>`;
}

/** Saves bytes as a download, never a navigation: a neutral type, an `<a download>` click (like saveResource). */
function saveBytes(bytes: Uint8Array, name: string): void {
  saveBlob(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), name);
}

interface FrameEvents {
  onOpen: (path: string, hash: string, query: string) => void;
  onExternal: (url: string) => void;
  onShown: (path: string, title: string) => void;
  onFailed: (path: string) => void;
  onEscape: () => void;
}

/**
 * One page of the set in the sandboxed frame. The frame page says it's ready, gets the loader; from then on every
 * message of that frame's window (and no other) goes to the host, and the host's answers go back to it.
 */
export function PagesFrame({
  reader,
  show,
  title,
  events,
}: {
  reader: PageSetReader;
  show: Shown;
  title: string;
  events: FrameEvents;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const latest = useRef(events);
  latest.current = events;
  const { path, hash, query } = show;

  // A layout effect: listening before the frame (inserted in this commit) can run its script and say it's ready.
  useLayoutEffect(() => {
    const host = new PageSetHost(reader, (message, transfer) =>
      ref.current?.contentWindow?.postMessage(message, '*', transfer ?? []),
    );
    host.onOpen = (p, h, q) => latest.current.onOpen(p, h, q);
    host.onExternal = (url) => latest.current.onExternal(url);
    host.onShown = (p, t) => latest.current.onShown(p, t);
    host.onFailed = (p) => latest.current.onFailed(p);
    host.onEscape = () => latest.current.onEscape();
    const onMessage = (event: MessageEvent) => {
      const win = ref.current?.contentWindow;
      if (!win || event.source !== win) return;
      if (frameReady(event.data)) {
        const message: HtmlMessage = { type: 'whombat.html', html: loaderHtml() };
        win.postMessage(message, '*');
        return;
      }
      host.handle(event.data, { path, hash, query });
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      host.close();
    };
  }, [reader, path, hash, query]);

  return (
    <iframe
      ref={ref}
      className={styles.frame}
      src={SANDBOX_FRAME_URL}
      sandbox={SANDBOX_FLAGS}
      title={title}
      referrerPolicy="no-referrer"
    />
  );
}

/** What the bar under the page offers after a link: a file to download, a link to the internet, or nothing there. */
type Offer =
  | { kind: 'file'; path: string; size: number }
  | { kind: 'external'; url: string; host: string }
  | { kind: 'missing' };

type Stage = { state: 'opening' } | { state: 'ready' } | { state: 'missing' } | { state: 'failed' };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function ActionButton({
  icon,
  label,
  onClick,
  busy,
}: {
  icon: typeof X;
  label: string;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button type="button" className={htmlStyles.action} onClick={onClick} aria-busy={busy || undefined}>
      <Icon icon={icon} size={14} />
      <span className={htmlStyles.actionLabel}>{label}</span>
    </button>
  );
}

/**
 * The page set full screen, like the HTML preview's: a bar with the set's title (and the shown page's own), Back
 * through the pages opened here, Download (the whole set) and Close; the page under it. `download` saves the set's file.
 */
export function PageSetViewer({
  attachment,
  open,
  onClose,
  download,
}: {
  attachment: Attachment;
  open: boolean;
  onClose: () => void;
  download: () => void;
}) {
  const title = pageSetTitle(attachment.name);
  // What opened it (Open, the cover, a row in Files) gets focus back: the dialog has no trigger of its own.
  const returnTo = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={htmlStyles.overlay} />
        <Dialog.Content
          className={htmlStyles.full}
          aria-describedby={undefined}
          data-page-set-viewer=""
          onOpenAutoFocus={(event) => {
            returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            // Into the viewer itself, not onto its first button: Tab reaches Back, Download and Close from there.
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnTo.current?.isConnected) returnTo.current.focus();
          }}
        >
          {open && <Viewer attachment={attachment} title={title} download={download} close={onClose} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Viewer({
  attachment,
  title,
  download,
  close,
}: {
  attachment: Attachment;
  title: string;
  download: () => void;
  /** Escape inside the page closes the viewer as it does outside it. */
  close: () => void;
}) {
  const source = useAttachmentSource();
  const { url, size } = attachment;
  const reader = useMemo(() => pageSetReader(source, { url, size }), [source, url, size]);
  const [attempt, setAttempt] = useState(0);
  const [stage, setStage] = useState<Stage>({ state: 'opening' });
  const [shown, setShown] = useState<Shown | null>(null);
  /** Each page a frame of its own: a new key, so nothing of the last page keeps running. */
  const [frameKey, setFrameKey] = useState(0);
  const [history, setHistory] = useState<Shown[]>([]);
  const [pageTitle, setPageTitle] = useState('');
  const [offer, setOffer] = useState<Offer | null>(null);
  const [saving, setSaving] = useState(false);
  /** Whether the frame has said the current page is shown (a page that sends you on before that replaces itself). */
  const landed = useRef(false);

  // The page the set opens on: the manifest's, else index.html.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is Try again
  useEffect(() => {
    let live = true;
    setStage({ state: 'opening' });
    setOffer(null);
    setHistory([]);
    setPageTitle('');
    (async () => {
      const manifest = await reader.manifest();
      const target = await pageTarget(reader, manifest?.open ?? PAGES_DEFAULT_OPEN);
      if (!live) return;
      if (target.kind !== 'page') {
        setStage({ state: 'missing' });
        return;
      }
      landed.current = false;
      setShown({ path: target.path, hash: target.hash, query: '' });
      setFrameKey((k) => k + 1);
    })().catch(() => {
      if (live) setStage({ state: 'failed' });
    });
    return () => {
      live = false;
    };
  }, [reader, attempt]);

  const go = (next: Shown, push: boolean) => {
    if (push && shown && landed.current) setHistory((h) => [...h, shown]);
    landed.current = false;
    setOffer(null);
    setPageTitle('');
    setStage({ state: 'opening' });
    setShown(next);
    setFrameKey((k) => k + 1);
  };

  const opened = (target: PageTarget, query: string) => {
    if (target.kind === 'page') go({ path: target.path, hash: target.hash, query }, true);
    else if (target.kind === 'file') setOffer({ kind: 'file', path: target.path, size: target.size });
    else setOffer({ kind: 'missing' });
  };

  const events: FrameEvents = {
    onOpen: (path, hash, query) => {
      void pageTarget(reader, path, hash).then(
        (target) => opened(target, query),
        () => setStage({ state: 'failed' }),
      );
    },
    onExternal: (link) => setOffer({ kind: 'external', url: link, host: hostOf(link) }),
    onShown: (path, shownTitle) => {
      if (path !== shown?.path) return;
      landed.current = true;
      setPageTitle(shownTitle.trim());
      setStage({ state: 'ready' });
    },
    onEscape: close,
    onFailed: (path) => {
      if (path === shown?.path) setStage({ state: 'failed' });
    },
  };

  // The page that failed again, or the set from the start when it couldn't be read at all.
  const retry = () => (shown ? go(shown, false) : setAttempt((n) => n + 1));

  const back = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((h) => h.slice(0, -1));
    go(previous, false);
  };

  const saveFile = async (path: string) => {
    setSaving(true);
    try {
      const bytes = await reader.file(path);
      if (bytes) saveBytes(bytes, pageFileName(path));
      setOffer(null);
    } catch {
      setStage({ state: 'failed' });
    } finally {
      setSaving(false);
    }
  };

  const subtitle = stage.state === 'ready' && pageTitle && pageTitle !== title ? pageTitle : null;
  const note =
    stage.state === 'opening'
      ? 'Opening…'
      : stage.state === 'failed'
        ? 'Couldn’t open these pages.'
        : stage.state === 'missing'
          ? 'That page isn’t in this set.'
          : null;

  return (
    <>
      <div className={htmlStyles.fullBar}>
        {history.length > 0 && <ActionButton icon={ArrowLeft} label="Back" onClick={back} />}
        <Icon icon={Layers} size={16} className={htmlStyles.headIcon} />
        <span className={styles.titles}>
          <Dialog.Title className={styles.title}>{title}</Dialog.Title>
          {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
        </span>
        <span className={htmlStyles.actions}>
          <ActionButton icon={Download} label="Download" onClick={download} />
          <Dialog.Close asChild>
            <button type="button" className={htmlStyles.action}>
              <Icon icon={X} size={14} />
              <span className={htmlStyles.actionLabel}>Close</span>
            </button>
          </Dialog.Close>
        </span>
      </div>
      <div className={styles.stage}>
        {shown && stage.state !== 'missing' && stage.state !== 'failed' && (
          <PagesFrame
            key={frameKey}
            reader={reader}
            show={shown}
            title={pageTitle ? `${title}: ${pageTitle}` : title}
            events={events}
          />
        )}
        {note && (
          <div className={styles.note} role="status">
            <p>{note}</p>
            {stage.state === 'failed' && (
              <Button size="sm" onClick={retry}>
                Try again
              </Button>
            )}
          </div>
        )}
      </div>
      {offer && (
        <div className={styles.offer} role="status" data-page-set-offer={offer.kind}>
          {offer.kind === 'file' ? (
            <>
              <span className={styles.offerText}>
                <span className={styles.offerName}>{pageFileName(offer.path)}</span>
                {` · ${formatFileSize(offer.size)}`}
              </span>
              <Button
                size="sm"
                iconStart={<Icon icon={Download} size={14} />}
                aria-busy={saving || undefined}
                onClick={() => void saveFile(offer.path)}
              >
                Download
              </Button>
            </>
          ) : offer.kind === 'external' ? (
            <>
              <span className={styles.offerText}>This link goes to {offer.host}.</span>
              <Button
                size="sm"
                onClick={() => {
                  window.open(offer.url, '_blank', 'noopener,noreferrer');
                  setOffer(null);
                }}
              >
                Open
              </Button>
            </>
          ) : (
            <span className={styles.offerText}>That page isn’t in this set.</span>
          )}
        </div>
      )}
    </>
  );
}
