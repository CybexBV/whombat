/**
 * The watchdog of the relay's Chromium (one-person.md OP-S138). A Chromium whose processes died under it (a renderer
 * killed by the syscall filter, a tab stuck in a JavaScript loop, a crashed page) can keep its browser process alive and
 * keep answering the relay, while every page it hands out never answers again. The agent then retries against it for as
 * long as the pod lives. The watchdog notices within a minute or so and either closes the page that stopped answering or
 * has the browser end that Chromium (`restart`), so the next relay connection starts a fresh one.
 *
 * Every `intervalMs`, while a Chromium runs, one check over a fresh connection straight to its DevTools port (never the
 * relay, so it never starts a Chromium and never counts as the agent's use):
 *
 * - **The browser**: `Target.getTargets`. Unanswered `browserStrikes` checks in a row: the browser process is stuck.
 * - **Each page** (type `page`, not `devtools://`): attach, evaluate `1`, detach. A page that doesn't answer gets a
 *   strike, one that answers loses its strikes; at `pageStrikes` it is closed, and one that is still there after
 *   `closeMs` means the browser can't close pages any more.
 * - **A new page**, only when a page didn't answer: a blank page in a throwaway context. Failing `rendererStrikes` checks
 *   in a row: the browser can't start working pages any more.
 *
 * Checks never overlap (the next is scheduled when one ends), its timers never hold the runner, and it logs a page's
 * origin only.
 */
import type { Socket } from 'node:net';
import { CdpClient } from './cdp';

type Log = (level: 'error' | 'warn' | 'info' | 'debug', msg: string, extra?: Record<string, unknown>) => void;

export interface BrowserWatchTimings {
  /** Between the end of one check and the start of the next. */
  intervalMs?: number;
  /** How long one DevTools command (or opening the connection) may take. */
  commandMs?: number;
  /** How long a page that is being closed may still be there. */
  closeMs?: number;
  /** Checks in a row a page doesn't answer before it is closed. */
  pageStrikes?: number;
  /** Checks in a row the browser doesn't answer before it is ended. */
  browserStrikes?: number;
  /** Checks in a row a new page can't be started before the browser is ended. */
  rendererStrikes?: number;
}

/** About a minute for a page, under a minute for the browser (OP-S138). */
export const BROWSER_WATCH: Required<BrowserWatchTimings> = {
  intervalMs: 20_000,
  commandMs: 8_000,
  closeMs: 5_000,
  pageStrikes: 3,
  browserStrikes: 2,
  rendererStrikes: 2,
};

export interface BrowserWatchDeps extends BrowserWatchTimings {
  /** A fresh connection to the Chromium's DevTools port. */
  connect: () => Socket;
  log: Log;
  /** Whose (the journal's lines). */
  name: string;
  /** The Chromium must go, and why (said once; the watch has stopped). */
  restart: (why: string) => void;
}

interface TargetInfo {
  targetId?: string;
  type?: string;
  url?: string;
}

class Timeout extends Error {}

/** `p`, or a `Timeout` once `ms` passed. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Timeout('no answer')), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** What the journal may say of a page: its origin (http/https), else its scheme; never its path or query. */
export function pageLabel(url: unknown): string {
  if (typeof url !== 'string' || !url) return 'a page';
  if (url === 'about:blank') return 'about:blank';
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : `a ${u.protocol} page`;
  } catch {
    return 'a page';
  }
}

const pause = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

export class BrowserWatch {
  readonly #deps: BrowserWatchDeps;
  readonly #t: Required<BrowserWatchTimings>;
  /** Strikes of the pages that didn't answer, by target id. */
  readonly #strikes = new Map<string, number>();
  #browserMisses = 0;
  #rendererMisses = 0;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  /** The connection of the check running now. */
  #cdp: CdpClient | null = null;
  /** The check running now (tests). */
  running: Promise<void> | null = null;

  constructor(deps: BrowserWatchDeps) {
    this.#deps = deps;
    const t = { ...BROWSER_WATCH };
    for (const k of Object.keys(t) as (keyof BrowserWatchTimings)[])
      if (deps[k] !== undefined) t[k] = deps[k];
    this.#t = t;
  }

  start(): void {
    if (this.#stopped || this.#timer || this.running) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.running = this.#tick().finally(() => {
        this.running = null;
        this.start();
      });
    }, this.#t.intervalMs);
    this.#timer.unref?.();
  }

  /** No more checks; the one running is cut short and decides nothing. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#cdp?.close();
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  async #tick(): Promise<void> {
    let why: string | null;
    try {
      why = await this.check();
    } catch (err) {
      why = null;
      this.#deps.log(
        'debug',
        `browser ${this.#deps.name}: a check failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (why && !this.#stopped) {
      this.stop();
      this.#deps.restart(why);
    }
  }

  /** One check: why the Chromium must go, or null. */
  async check(): Promise<string | null> {
    const { commandMs } = this.#t;
    let cdp: CdpClient;
    try {
      cdp = await CdpClient.open(this.#deps.connect, commandMs);
    } catch {
      return this.#stopped ? null : this.#browserMissed('its DevTools didn’t answer');
    }
    if (this.#stopped) {
      cdp.close();
      return null;
    }
    this.#cdp = cdp;
    try {
      let targets: TargetInfo[];
      try {
        targets = await this.#targets(cdp);
      } catch {
        return this.#stopped ? null : this.#browserMissed('it didn’t list its pages');
      }
      this.#browserMisses = 0;
      const pages = targets.filter(
        (t): t is TargetInfo & { targetId: string } =>
          t.type === 'page' &&
          typeof t.targetId === 'string' &&
          !String(t.url ?? '').startsWith('devtools://'),
      );
      for (const id of this.#strikes.keys())
        if (!pages.some((p) => p.targetId === id)) this.#strikes.delete(id);
      // Side by side: a check takes about one command's time however many pages are open.
      const answers = await Promise.all(pages.map((p) => this.#answers(cdp, p.targetId)));
      if (this.#stopped) return null;
      let failed = 0;
      for (const [i, page] of pages.entries()) {
        if (answers[i]) {
          this.#strikes.delete(page.targetId);
          continue;
        }
        failed++;
        const strikes = (this.#strikes.get(page.targetId) ?? 0) + 1;
        this.#strikes.set(page.targetId, strikes);
        if (strikes < this.#t.pageStrikes) continue;
        const label = pageLabel(page.url);
        if (!(await this.#close(cdp, page.targetId)))
          return this.#stopped ? null : `a page of ${label} stopped answering and couldn’t be closed`;
        this.#strikes.delete(page.targetId);
        this.#deps.log(
          'warn',
          `browser ${this.#deps.name}: closed a page of ${label} that stopped answering (${strikes} checks)`,
        );
      }
      if (!failed) {
        this.#rendererMisses = 0;
        return null;
      }
      if (await this.#newPageAnswers(cdp)) {
        this.#rendererMisses = 0;
        return null;
      }
      if (this.#stopped) return null;
      this.#rendererMisses++;
      this.#deps.log(
        'debug',
        `browser ${this.#deps.name}: a new page didn’t answer (${this.#rendererMisses})`,
      );
      return this.#rendererMisses >= this.#t.rendererStrikes ? 'it can’t start a page that answers' : null;
    } finally {
      this.#cdp = null;
      cdp.close();
    }
  }

  #browserMissed(why: string): string | null {
    this.#browserMisses++;
    this.#deps.log('debug', `browser ${this.#deps.name}: ${why} (${this.#browserMisses})`);
    return this.#browserMisses >= this.#t.browserStrikes ? `${why} for ${this.#browserMisses} checks` : null;
  }

  async #targets(cdp: CdpClient): Promise<TargetInfo[]> {
    const got = await within(
      cdp.send<{ targetInfos?: TargetInfo[] }>('Target.getTargets'),
      this.#t.commandMs,
    );
    return Array.isArray(got.targetInfos) ? got.targetInfos : [];
  }

  /** Whether a page runs a trivial expression: attached in a session of the check's own, detached after. */
  async #answers(cdp: CdpClient, targetId: string): Promise<boolean> {
    const ms = this.#t.commandMs;
    let sessionId: string | undefined;
    try {
      ({ sessionId } = await within(
        cdp.send<{ sessionId?: string }>('Target.attachToTarget', { targetId, flatten: true }),
        ms,
      ));
      if (!sessionId) return false;
      const got = await within(
        cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
          'Runtime.evaluate',
          { expression: '1', returnByValue: true },
          sessionId,
        ),
        ms,
      );
      return got.result?.value === 1;
    } catch {
      return false;
    } finally {
      // Not waited for: a page that doesn't answer may not detach either, and the connection goes after the check.
      if (sessionId) cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  }

  /** Closes a page; whether it is gone within `closeMs`. */
  async #close(cdp: CdpClient, targetId: string): Promise<boolean> {
    const until = Date.now() + this.#t.closeMs;
    try {
      await within(cdp.send('Target.closeTarget', { targetId }), this.#t.closeMs);
    } catch {
      return false;
    }
    for (;;) {
      if (this.#stopped) return true;
      const left = until - Date.now();
      try {
        const targets = await this.#targets(cdp);
        if (!targets.some((t) => t.targetId === targetId)) return true;
      } catch {
        return false;
      }
      if (left <= 0) return false;
      await pause(Math.min(250, left));
    }
  }

  /** Whether a blank page in a throwaway context starts and answers; the context goes after it. */
  async #newPageAnswers(cdp: CdpClient): Promise<boolean> {
    const ms = this.#t.commandMs;
    let browserContextId: string | undefined;
    try {
      ({ browserContextId } = await within(
        cdp.send<{ browserContextId?: string }>('Target.createBrowserContext', { disposeOnDetach: true }),
        ms,
      ));
      if (!browserContextId) return false;
      const { targetId } = await within(
        cdp.send<{ targetId?: string }>('Target.createTarget', { url: 'about:blank', browserContextId }),
        ms,
      );
      if (!targetId) return false;
      return await this.#answers(cdp, targetId);
    } catch {
      return false;
    } finally {
      if (browserContextId)
        await within(cdp.send('Target.disposeBrowserContext', { browserContextId }), ms).catch(() => {});
    }
  }
}
