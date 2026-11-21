/**
 * PDF pages drawn on a canvas (AP-325), loaded lazily (`import('./pdf')`, with pdf.js and its worker in chunks of
 * their own). The bytes come from the attachment (read through the session on a managed Whombat); nothing is framed
 * or navigated to, which the hosted CSP forbids (`frame-src 'self'`, `object-src 'none'`). pdf.js uses no eval; its
 * worker is a file of this origin (`worker-src 'self'`); without WebAssembly (the CSP has no `wasm-unsafe-eval`) and
 * without fetching font data (`connect-src` doesn't allow it), it falls back to its JavaScript decoders and the
 * system's fonts.
 */
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfDocument = PDFDocumentProxy;

export function openPdf(bytes: Uint8Array): Promise<PdfDocument> {
  return getDocument({
    // pdf.js transfers the buffer to its worker: give it a copy.
    data: bytes.slice(),
    useWasm: false,
    useSystemFonts: true,
    stopAtErrors: false,
  }).promise;
}

/**
 * Draws page `n` (1-based) at `width` CSS pixels on `canvas`; returns the page's CSS height. `signal` cancels the
 * drawing (a canvas takes one drawing at a time).
 */
export async function drawPage(
  doc: PdfDocument,
  n: number,
  canvas: HTMLCanvasElement,
  width: number,
  signal?: AbortSignal,
): Promise<number> {
  const page = await doc.getPage(n);
  signal?.throwIfAborted();
  const base = page.getViewport({ scale: 1 });
  const scale = width / base.width;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: scale * ratio });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const task = page.render({ canvas, viewport });
  const cancel = () => task.cancel();
  signal?.addEventListener('abort', cancel);
  try {
    await task.promise;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  page.cleanup();
  return viewport.height / ratio;
}
