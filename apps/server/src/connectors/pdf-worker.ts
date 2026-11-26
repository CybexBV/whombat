/**
 * The PDF reader's worker (`pdf-read.ts` starts one per PDF): PDF.js reads the text of a PDF someone mailed, in a
 * `worker_threads` worker with its own heap limit, so a costly or hostile file can neither block the server's event loop
 * nor grow its heap. In a release it is `app/pdf-worker.mjs`, its own esbuild entry (scripts/package).
 *
 * It imports nothing of Whombat's, so Node runs this file as it is (types stripped) in tests and in development.
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

/** What `workerData.role` says, so loading this module anywhere else does nothing. */
export const PDF_WORKER_ROLE = 'whombat-pdf-reader';

export interface PdfJob {
  role: typeof PDF_WORKER_ROLE;
  bytes: Uint8Array;
  maxPages: number;
  maxChars: number;
}

export type PdfReply =
  | { ok: true; pages: number; text: string; truncated: boolean }
  | { ok: false; why: 'password' | 'broken' };

/**
 * A 2D `DOMMatrix`, enough for PDF.js to load in Node: it makes one as it loads, and Node has none. PDF.js takes the
 * native canvas package's when that is installed (in development); a release ships no canvas, and reading text draws
 * nothing.
 */
class Matrix2D {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  readonly is2D = true;
  constructor(init?: ArrayLike<number>) {
    if (!init || init.length < 6) return;
    // A 4×4 matrix's 2D part sits at 0, 1, 4, 5, 12 and 13.
    const at = init.length === 16 ? [0, 1, 4, 5, 12, 13] : [0, 1, 2, 3, 4, 5];
    const v = (i: number) => Number(init[at[i] ?? 0]);
    this.#set(v(0), v(1), v(2), v(3), v(4), v(5));
  }
  get isIdentity(): boolean {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }
  #set(a: number, b: number, c: number, d: number, e: number, f: number): this {
    Object.assign(this, { a, b, c, d, e, f });
    return this;
  }
  multiplySelf(m: Matrix2D): this {
    const { a, b, c, d, e, f } = this;
    return this.#set(
      a * m.a + c * m.b,
      b * m.a + d * m.b,
      a * m.c + c * m.d,
      b * m.c + d * m.d,
      a * m.e + c * m.f + e,
      b * m.e + d * m.f + f,
    );
  }
  preMultiplySelf(m: Matrix2D): this {
    const { a, b, c, d, e, f } = this;
    return this.#set(
      m.a * a + m.c * b,
      m.b * a + m.d * b,
      m.a * c + m.c * d,
      m.b * c + m.d * d,
      m.a * e + m.c * f + m.e,
      m.b * e + m.d * f + m.f,
    );
  }
  translateSelf(x = 0, y = 0): this {
    return this.multiplySelf(new Matrix2D([1, 0, 0, 1, x, y]));
  }
  scaleSelf(x = 1, y = x): this {
    return this.multiplySelf(new Matrix2D([x, 0, 0, y, 0, 0]));
  }
  invertSelf(): this {
    const { a, b, c, d, e, f } = this;
    const det = a * d - b * c;
    if (!det) return this.#set(Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN);
    return this.#set(d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det);
  }
  #copy(): Matrix2D {
    return new Matrix2D([this.a, this.b, this.c, this.d, this.e, this.f]);
  }
  multiply(m: Matrix2D): Matrix2D {
    return this.#copy().multiplySelf(m);
  }
  translate(x?: number, y?: number): Matrix2D {
    return this.#copy().translateSelf(x, y);
  }
  scale(x?: number, y?: number): Matrix2D {
    return this.#copy().scaleSelf(x, y);
  }
  inverse(): Matrix2D {
    return this.#copy().invertSelf();
  }
}

/** The text of a PDF: its pages in order, a blank line between them, cut at `maxChars` or after `maxPages`. */
export async function pdfText(bytes: Uint8Array, maxPages: number, maxChars: number): Promise<PdfReply> {
  const dom = globalThis as { DOMMatrix?: unknown };
  dom.DOMMatrix ??= Matrix2D;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // The parser runs here, in this thread: PDF.js looks for it on `globalThis` before it would start a worker of its own.
  const g = globalThis as { pdfjsWorker?: unknown };
  // @ts-expect-error The worker build ships without types; only its module object is handed over.
  g.pdfjsWorker ??= await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const task = pdfjs.getDocument({
    data: bytes,
    // Nothing from outside the file (fonts, forms' scripts), and no drawing: only its text is read.
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => {});
    return {
      ok: false,
      why: (err as { name?: string }).name === 'PasswordException' ? 'password' : 'broken',
    };
  }
  try {
    const pages: string[] = [];
    let length = 0;
    let truncated = doc.numPages > maxPages;
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
      page.cleanup();
      text = tidy(text);
      if (!text) continue;
      pages.push(text);
      length += text.length + 2;
      if (length >= maxChars) {
        truncated = truncated || length > maxChars || n < doc.numPages;
        break;
      }
    }
    const text = pages.join('\n\n');
    return {
      ok: true,
      pages: doc.numPages,
      text: text.length > maxChars ? text.slice(0, maxChars) : text,
      truncated: truncated || text.length > maxChars,
    };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

/** Spaces run together, lines trimmed, at most one blank line in a row. */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

if (!isMainThread && parentPort && (workerData as Partial<PdfJob> | null)?.role === PDF_WORKER_ROLE) {
  const port = parentPort;
  // PDF.js says what it can't do (fonts, a canvas it has no use for here) on the console: nothing a person needs.
  console.log = () => {};
  console.warn = () => {};
  const job = workerData as PdfJob;
  pdfText(job.bytes, job.maxPages, job.maxChars).then(
    (reply) => port.postMessage(reply),
    () => port.postMessage({ ok: false, why: 'broken' } satisfies PdfReply),
  );
}
