import type { Attachment } from '@whombat/core';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useAttachmentBytes } from './attachmentSource';
import styles from './MessageAttachments.module.css';
import type { PdfDocument } from './pdf';

/*
 * A PDF attachment (AP-325): its first page drawn inline (pdf.js, lazily), a click opens every page (up to
 * PDF_VIEW_PAGES) in the lightbox. Anything that goes wrong leaves the chip, which always downloads.
 */

/** Largest PDF drawn in the page (attachments are at most 10 MB today). */
export const PDF_MAX_BYTES = 20 * 1024 * 1024;
/** Pages the viewer draws; the rest is a download away. */
export const PDF_VIEW_PAGES = 30;
const THUMB_WIDTH = 220;
const VIEW_WIDTH = 700;

const keep = (bytes: Uint8Array) => bytes;

function usePdf(attachment: Attachment): { doc: PdfDocument | null; failed: boolean } {
  const bytes = useAttachmentBytes(attachment, PDF_MAX_BYTES, keep);
  const [state, setState] = useState<{ doc: PdfDocument | null; failed: boolean }>({
    doc: null,
    failed: false,
  });
  useEffect(() => {
    if (bytes.state === 'error') setState({ doc: null, failed: true });
    if (bytes.state !== 'ready') return;
    let live = true;
    let opened: PdfDocument | null = null;
    import('./pdf')
      .then((m) => m.openPdf(bytes.value))
      .then((doc) => {
        opened = doc;
        if (live) setState({ doc, failed: false });
        else void doc.destroy();
      })
      .catch(() => live && setState({ doc: null, failed: true }));
    return () => {
      live = false;
      void opened?.destroy();
    };
  }, [bytes]);
  return state;
}

/** One page on a canvas. */
function PdfPage({ doc, n, width, label }: { doc: PdfDocument; n: number; width: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const controller = new AbortController();
    import('./pdf')
      .then((m) => m.drawPage(doc, n, canvas, width, controller.signal))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [doc, n, width]);
  if (failed) return null;
  return <canvas ref={ref} className={styles.pdfCanvas} role="img" aria-label={label} />;
}

/** Every page (up to `PDF_VIEW_PAGES`) of an open document, as the lightbox shows them. */
function PdfPageList({ doc }: { doc: PdfDocument }) {
  const pages = doc.numPages;
  const shown = Math.min(pages, PDF_VIEW_PAGES);
  return (
    <div className={styles.pdfPages}>
      {Array.from({ length: shown }, (_, i) => (
        <PdfPage
          // biome-ignore lint/suspicious/noArrayIndexKey: pages are positional
          key={i}
          doc={doc}
          n={i + 1}
          width={VIEW_WIDTH}
          label={`Page ${i + 1} of ${pages}`}
        />
      ))}
      {pages > shown && (
        <p className={styles.previewNote}>
          Showing the first {shown} of {pages} pages. Download the file for the rest.
        </p>
      )}
    </div>
  );
}

/** A PDF's pages straight in the lightbox (Files, docs/decisions/files-space.md AP-777): loading, then the pages. */
export function PdfPages({ attachment }: { attachment: Attachment }) {
  const { doc, failed } = usePdf(attachment);
  if (failed) return <p className={styles.previewNote}>Preview isn’t available.</p>;
  if (!doc) return <p className={styles.previewNote}>Loading preview…</p>;
  return <PdfPageList doc={doc} />;
}

export function PdfPreview({
  attachment,
  chip,
  lightbox,
}: {
  attachment: Attachment;
  /** The file chip (name, size, download) under the page. */
  chip: ReactNode;
  /** Opens the viewer: the lightbox with `children`. */
  lightbox: (children: ReactNode, meta: string) => void;
}) {
  const { doc, failed } = usePdf(attachment);
  if (failed) return chip;
  const pages = doc?.numPages ?? 0;
  const pagesText = pages === 1 ? '1 page' : `${pages} pages`;
  return (
    <figure className={styles.pdf}>
      <button
        type="button"
        className={styles.pdfThumb}
        aria-label={`Open ${attachment.name}`}
        disabled={!doc}
        onClick={() => {
          if (!doc) return;
          lightbox(<PdfPageList doc={doc} />, pagesText);
        }}
      >
        {doc ? (
          <PdfPage doc={doc} n={1} width={THUMB_WIDTH} label={`First page of ${attachment.name}`} />
        ) : (
          <span className={styles.previewNote}>Loading preview…</span>
        )}
      </button>
      <figcaption>{chip}</figcaption>
    </figure>
  );
}
