/**
 * Reading a PDF's text (`mail_attachment_open`): each PDF in a `worker_threads` worker of its own (`pdf-worker.ts`) with
 * a heap limit and a time limit, one at a time, so a costly or hostile file can neither block the server's event loop
 * nor grow its heap. A file that takes too long or kills its worker is told as one that can't be read.
 */
import { type ResourceLimits, Worker } from 'node:worker_threads';
import { PDF_WORKER_ROLE, type PdfJob, type PdfReply } from './pdf-worker';

/** How long one PDF may take, from when its worker starts. */
export const PDF_READ_TIMEOUT_MS = 20_000;
/** At most this many pages are read. */
export const PDF_MAX_PAGES = 50;

const PDF_WORKER_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
};

export type PdfRead = PdfReply | { ok: false; why: 'too_slow' };

/** The worker's module for code at `from`: the source file, or the release's own bundle next to `app/server.mjs`. */
export function pdfWorkerUrl(from: string = import.meta.url): URL {
  return /\.m?js$/.test(new URL(from).pathname)
    ? new URL('./pdf-worker.mjs', from)
    : new URL('./pdf-worker.ts', from);
}

/** PDFs are read one after another. */
let queue: Promise<unknown> = Promise.resolve();

/** The text of a PDF, read in a worker of its own. */
export function readPdf(
  bytes: Uint8Array,
  maxChars: number,
  options: { url?: URL; timeoutMs?: number } = {},
): Promise<PdfRead> {
  const run = queue.then(() => readInWorker(bytes, maxChars, options));
  queue = run.catch(() => {});
  return run;
}

function readInWorker(
  bytes: Uint8Array,
  maxChars: number,
  options: { url?: URL; timeoutMs?: number },
): Promise<PdfRead> {
  return new Promise<PdfRead>((resolve) => {
    // A copy of its own, moved to the worker rather than cloned.
    const copy = new Uint8Array(bytes);
    const job: PdfJob = { role: PDF_WORKER_ROLE, bytes: copy, maxPages: PDF_MAX_PAGES, maxChars };
    let worker: Worker;
    try {
      worker = new Worker(options.url ?? pdfWorkerUrl(), {
        workerData: job,
        transferList: [copy.buffer as ArrayBuffer],
        resourceLimits: PDF_WORKER_LIMITS,
      });
    } catch {
      resolve({ ok: false, why: 'broken' });
      return;
    }
    let done = false;
    const finish = (reply: PdfRead) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(reply);
      void worker.terminate().catch(() => {});
    };
    const timer = setTimeout(
      () => finish({ ok: false, why: 'too_slow' }),
      options.timeoutMs ?? PDF_READ_TIMEOUT_MS,
    );
    worker.once('message', (reply: PdfReply) => finish(reply));
    // Out of memory, a crash, or an exit without an answer: the file's doing.
    worker.once('error', () => finish({ ok: false, why: 'broken' }));
    worker.once('exit', () => finish({ ok: false, why: 'broken' }));
  });
}
