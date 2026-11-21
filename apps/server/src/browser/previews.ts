/**
 * Folders asked of a turn's runner for `browser_preview` (docs/decisions/browser.md BT-48; hermes-engine.md HE-S142):
 * the agent's build is in its working directory, which only its runner reads. The tool waits here; the runner learns of
 * the folder on its next progress beat (`ProgressResponse.previews`), with `render` opens it in the agent's Chromium
 * and takes the screenshot, and sends the files and the screenshot (`runner.submitPreview`), or says why not. A page for
 * `page_preview` takes the same way, without a folder (docs/decisions/visual-replies.md). In memory,
 * per server process: a restart drops the wait and the agent asks again.
 */
import { randomBytes } from 'node:crypto';
import {
  BROWSER_PREVIEW_MAX_BYTES,
  BROWSER_PREVIEW_MAX_FILES,
  type PageSetManifest,
  type PreviewFile,
  type PreviewPage,
  type PreviewRequest,
  type PreviewShot,
} from '@whombat/core';
import type { StagedFile } from '../files/store';
import type { Services } from '../services';

/** A page set the runner sent (`show_pages`, docs/decisions/page-sets.md): staged bytes, checked, and what it says. */
export interface StagedPages {
  staged: StagedFile;
  manifest: PageSetManifest;
}

export type PreviewUpload =
  | { files: PreviewFile[]; shot?: PreviewShot }
  | { pages: StagedPages }
  | { error: string };

interface Pending {
  id: string;
  dispatchId: string;
  /** A folder (`browser_preview`), a page (`page_preview`) or a folder as a page set (`show_pages`). */
  dir?: string;
  page?: PreviewPage;
  pages?: NonNullable<PreviewRequest['pages']>;
  render: PreviewRequest['render'];
  resolve: (upload: PreviewUpload) => void;
  timer: NodeJS.Timeout;
}

/** How long a preview waits for the runner (a few beats, and the upload). */
export const PREVIEW_WAIT_MS = 60_000;
/** A page set may be far larger than a build: reading, drawing its cover and sending take longer. */
export const PAGES_WAIT_MS = 180_000;

export const PREVIEW_RUNNER_SILENT =
  'Your runner didn’t send the folder in time. Tell the person the branch to look at instead.';

export const PAGES_RUNNER_SILENT =
  'Your runner didn’t send the pages in time. Try again, or show a smaller folder.';

export class PreviewBroker {
  readonly #pending = new Map<string, Pending>();

  /**
   * Asks the turn's runner for `dir` — with `render`, its screenshot in the agent's Chromium too — and waits for its
   * upload (or its refusal, or the time to run out).
   */
  request(
    dispatchId: string,
    dir: string,
    render?: PreviewRequest['render'],
    waitMs = PREVIEW_WAIT_MS,
  ): Promise<PreviewUpload> {
    return this.#wait({ dispatchId, dir, render }, waitMs);
  }

  /**
   * Asks the turn's runner for `dir` as a page set (`show_pages`) that opens on `pages.open`, its cover drawn offline in
   * the agent's Chromium, and waits for the set's bytes (`PAGES_TRANSFER`) or the runner's refusal.
   */
  requestPages(
    dispatchId: string,
    dir: string,
    pages: NonNullable<PreviewRequest['pages']>,
    waitMs = PAGES_WAIT_MS,
  ): Promise<PreviewUpload> {
    return this.#wait(
      { dispatchId, dir, pages, render: { path: encodeURI(`/${pages.open}`), find: null, online: false } },
      waitMs,
    );
  }

  /** Whether a page set of this dispatch with this id is still waited for (before its bytes are read). */
  waitsForPages(dispatchId: string, id: string): boolean {
    const p = this.#pending.get(id);
    return !!p && p.dispatchId === dispatchId && !!p.pages;
  }

  /** Asks the turn's runner to draw `page` in the agent's Chromium (`page_preview`) and waits for its screenshot. */
  requestPage(dispatchId: string, page: PreviewPage, waitMs = PREVIEW_WAIT_MS): Promise<PreviewUpload> {
    return this.#wait({ dispatchId, page, render: { path: '/', find: null, online: false } }, waitMs);
  }

  #wait(
    want: Pick<Pending, 'dispatchId' | 'dir' | 'page' | 'pages' | 'render'>,
    waitMs: number,
  ): Promise<PreviewUpload> {
    const id = `pvw_${randomBytes(12).toString('base64url')}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ error: want.pages ? PAGES_RUNNER_SILENT : PREVIEW_RUNNER_SILENT });
      }, waitMs);
      timer.unref?.();
      this.#pending.set(id, { id, ...want, resolve, timer });
    });
  }

  /** What the dispatch's runner should upload, on its beat (again on every beat until it has). */
  forRunner(dispatchId: string): PreviewRequest[] {
    return [...this.#pending.values()]
      .filter((p) => p.dispatchId === dispatchId)
      .slice(0, 4)
      .map((p) => ({
        id: p.id,
        ...(p.dir !== undefined ? { dir: p.dir } : {}),
        ...(p.page ? { page: p.page } : {}),
        ...(p.pages ? { pages: p.pages } : {}),
        ...(p.render ? { render: p.render } : {}),
      }));
  }

  /** The runner's upload. False when nothing waits for it (too late, another dispatch's id). */
  fulfil(dispatchId: string, id: string, upload: PreviewUpload): boolean {
    const p = this.#pending.get(id);
    if (!p || p.dispatchId !== dispatchId) return false;
    this.#pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(p.pages ? checkPages(upload) : p.page ? checkPage(upload) : checkUpload(upload));
    return true;
  }
}

/** A page set comes back as its staged bytes, or why not. */
function checkPages(upload: PreviewUpload): PreviewUpload {
  if ('error' in upload || 'pages' in upload) return upload;
  return { error: 'The runner sent files instead of a page set.' };
}

/** A page comes back as its screenshot alone. */
function checkPage(upload: PreviewUpload): PreviewUpload {
  if ('error' in upload) return upload;
  if ('pages' in upload) return { error: 'The runner sent a page set instead of a page.' };
  return { files: [], ...(upload.shot ? { shot: upload.shot } : {}) };
}

/** The caps hold whatever the runner sent. */
function checkUpload(upload: PreviewUpload): PreviewUpload {
  if ('error' in upload) return upload;
  if ('pages' in upload) return { error: 'The runner sent a page set instead of a folder.' };
  if (upload.files.length === 0)
    return { error: 'That folder has no files. Build first, then preview the built folder.' };
  if (upload.files.length > BROWSER_PREVIEW_MAX_FILES)
    return { error: `That folder has more than ${BROWSER_PREVIEW_MAX_FILES} files.` };
  const bytes = upload.files.reduce((n, f) => n + Math.floor((f.data.length * 3) / 4), 0);
  if (bytes > BROWSER_PREVIEW_MAX_BYTES)
    return { error: `That folder is larger than ${BROWSER_PREVIEW_MAX_BYTES / 1024 / 1024} MB.` };
  return upload;
}

const brokers = new WeakMap<Services, PreviewBroker>();

export function previewsFor(services: Services): PreviewBroker {
  let b = brokers.get(services);
  if (!b) {
    b = new PreviewBroker();
    brokers.set(services, b);
  }
  return b;
}
