/**
 * A turn's `progress` beats: they keep "{name} is thinking" alive and carry what the server hasn't heard yet — the
 * session, an assessment's exported commit, observed activity (work-supervision WS-11, WS-12), rate-limit readings,
 * the follow-ups taken — and bring back what it says: stop (pause, take over, cancel), follow-ups
 * to offer (steering.md SX-04), folders to read for a preview. A runner that can't beat for a lease period stops the
 * turn: the server hands the dispatch out again then.
 */

import type { PreviewPage, PreviewRequest, PreviewShot } from '@whombat/core';
import { ACTIVITY_FLUSH_MS, type ActivityRecorder } from '../activity';
import { CdpClient } from '../cdp';
import { PAGES_LIMITS, PAGES_NO_FOLDER, packPages } from '../pages';
import { PREVIEW_NO_FOLDER, previewSourceOf, readFolderFiles, readPreviewFolder } from '../preview';
import { pageShot, previewShot } from '../preview-shot';
import type { TurnFollowUps } from '../steering';
import type { TurnScope } from './scope';
import { stopManaged } from './stop';

/** What a `page_preview` hears from a turn without the agent's Chromium. */
export const PAGE_NO_BROWSER =
  'This turn has no browser to draw the page in. Post it if you’re confident it’s right.';

type ProgressTurn = Pick<
  TurnScope,
  'ctx' | 'deps' | 'id' | 'lease' | 'stop' | 'session' | 'reply' | 'verdict' | 'readings' | 'resources'
>;

export class TurnProgress {
  /** An assessment's exported commit, reported with the beats until one reaches the server (feedback.md, review-2 F9). */
  workspaceCommit: string | undefined;
  /** Observed activity of this attempt (activity.ts, work-supervision WS-11…WS-15); set once the cwd is known. */
  activity: ActivityRecorder | null = null;
  /** Same-person follow-ups this turn may take (steering.md SX-03); set once the turn is built. */
  followUps: TurnFollowUps | null = null;
  readonly #turn: ProgressTurn;
  #commitReported = false;
  #lastBeat = Date.now();
  #interval: NodeJS.Timeout | null = null;
  #flushTimer: NodeJS.Timeout | null = null;
  /**
   * Folders a browser_preview of this turn asked for: each read once, from the turn's own
   * folder — its checkout, or the agent's work folder in any turn without a checkout
   * (`previewSourceOf`, resourceful-agents.md RA-DS70) — or from an automation step's own folder (RN-R2).
   */
  readonly #previewsSent = new Set<string>();

  constructor(turn: ProgressTurn) {
    this.#turn = turn;
  }

  /** Beats every `progressMs` from now until `stopTimers`. */
  start(): void {
    this.#interval = setInterval(() => void this.beat(), this.#turn.deps.progressMs ?? 2000);
  }

  stopTimers(): void {
    if (this.#interval) clearInterval(this.#interval);
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
  }

  /** What watches the running turn: its activity and the follow-ups it takes. */
  watch(activity: ActivityRecorder, followUps: TurnFollowUps | null): void {
    this.activity = activity;
    this.followUps = followUps;
  }

  /**
   * One progress beat, carrying the activity reports the server hasn't taken yet (a failed beat keeps them for the
   * next one; a runner that lost its lease changes nothing). `final`: the last word before `complete`, which must
   * not turn a finished turn into a stopped one.
   */
  async beat(opts: { final?: boolean } = {}): Promise<void> {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    const { ctx, deps, id, lease, stop, session, reply, readings } = this.#turn;
    try {
      const commit = this.#commitReported ? undefined : this.workspaceCommit;
      const injected = this.followUps?.injected() ?? [];
      const reports = this.activity?.pending() ?? [];
      const limits = readings.unsent();
      const res = await deps.api.progress(id, {
        state: 'running',
        thinking: reply.thinking,
        ...session.forBeat(),
        ...(commit ? { workspaceCommit: commit } : {}),
        ...(reports.length ? { activity: reports } : {}),
        ...(limits ? { rateLimits: limits } : {}),
        ...(injected.length ? { injected } : {}),
        ...lease,
      });
      if (commit) this.#commitReported = true;
      readings.sent(limits);
      if (reports.length) this.activity?.ack(reports);
      this.#lastBeat = Date.now();
      if (res.cancel && !opts.final) stop.stop(res.reason ?? 'cancelled');
      // What the server offers now (steering.md SX-04); a stopping turn takes nothing more.
      else if (!opts.final) this.followUps?.offer(res.inject ?? []);
      for (const p of res.previews ?? []) {
        if (this.#previewsSent.has(p.id)) continue;
        this.#previewsSent.add(p.id);
        if (p.page) void this.#sendPage(p.id, p.page);
        else if (p.dir && p.pages) void this.#sendPages(p.id, p.dir, p.pages, p.render);
        else if (p.dir) void this.#sendPreview(p.id, p.dir, p.render);
      }
    } catch (err) {
      deps.log('warn', 'progress failed', { dispatchId: id, err: String(err) });
      if (!opts.final && Date.now() - this.#lastBeat > (deps.managed.leaseMs ?? 60_000)) {
        deps.log('warn', `${ctx.agent.name} · lease lost (no beat for a lease period): stopping the task`, {
          dispatchId: id,
        });
        stopManaged(this.#turn, 'lease_lost');
      }
    }
  }

  /** New activity goes out within ACTIVITY_FLUSH_MS instead of waiting for the next beat (WS-12). */
  flushSoon(): void {
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.beat();
    }, ACTIVITY_FLUSH_MS);
    this.#flushTimer.unref?.();
  }

  /** What the server hasn't heard before the turn ends: activity, follow-ups taken. */
  get unsaid(): boolean {
    return !!(this.activity?.hasPending || this.followUps?.injected().length);
  }

  /**
   * A page a `page_preview` asked for (docs/decisions/visual-replies.md): drawn in the agent's Chromium and sent back as
   * its screenshot, height and console lines; a turn without a browser says so.
   */
  async #sendPage(previewId: string, page: PreviewPage): Promise<void> {
    const { deps, id, lease, resources } = this.#turn;
    const submit = deps.api.submitPreview;
    if (!submit) return;
    const browser = resources.browser ?? resources.pod?.browser ?? null;
    let body: { shot?: PreviewShot } | { error: string } = { error: PAGE_NO_BROWSER };
    if (browser) {
      const cdp = await CdpClient.open(browser.socket).catch((err: unknown) => {
        deps.log('warn', `page preview: no browser (${String(err)})`, { dispatchId: id });
        return null;
      });
      try {
        if (cdp) body = { shot: await pageShot(cdp, page) };
      } catch (err) {
        deps.log('warn', `page preview: no screenshot (${String(err)})`, { dispatchId: id });
        body = {
          error: `The page couldn’t be drawn: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            500,
          ),
        };
      } finally {
        cdp?.close();
      }
    }
    await submit(id, previewId, { ...body, ...lease }).catch((err: unknown) =>
      deps.log('warn', 'could not send a page preview', { dispatchId: id, err: String(err) }),
    );
  }

  /**
   * A page set a `show_pages` asked for (docs/decisions/page-sets.md): the folder read from the turn's own folder within
   * the set's limits, the page it opens on drawn in the agent's Chromium for its cover (offline; a turn without a browser
   * makes a set without one), packed and sent; or why not.
   */
  async #sendPages(
    previewId: string,
    dir: string,
    want: NonNullable<PreviewRequest['pages']>,
    render?: PreviewRequest['render'],
  ): Promise<void> {
    const { deps, id, lease, resources } = this.#turn;
    const submit = deps.api.submitPreview;
    if (!submit) return;
    const refuse = (error: string) =>
      submit(id, previewId, { error: error.slice(0, 500), ...lease }).catch((err: unknown) =>
        deps.log('warn', 'could not send a page set refusal', { dispatchId: id, err: String(err) }),
      );
    const upload = deps.api.submitPages;
    if (!upload) return void (await refuse('This runner can’t send page sets yet.'));
    const source = previewSourceOf(resources.prepared);
    if (!source) return void (await refuse(PAGES_NO_FOLDER));
    const folder = await readFolderFiles(source, dir, PAGES_LIMITS).catch((err: unknown) => ({
      error: `Couldn’t read ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    }));
    if ('error' in folder) return void (await refuse(folder.error));
    let cover: Buffer | null = null;
    const browser = resources.browser ?? resources.pod?.browser ?? null;
    if (render && browser) {
      const cdp = await CdpClient.open(browser.socket).catch((err: unknown) => {
        deps.log('warn', `page set: no browser (${String(err)})`, { dispatchId: id });
        return null;
      });
      try {
        if (cdp) {
          const shot = await previewShot(
            cdp,
            folder.files.map((f) => ({ path: f.path, data: f.bytes })),
            { ...render, online: false },
          );
          cover = Buffer.from(shot.png, 'base64');
        }
      } catch (err) {
        deps.log('warn', `page set: no cover (${String(err)})`, { dispatchId: id });
      } finally {
        cdp?.close();
      }
    }
    const packed = packPages(folder.files, want, dir, cover);
    if ('error' in packed) return void (await refuse(packed.error));
    await upload(id, previewId, lease, packed.parts).catch(async (err: unknown) => {
      deps.log('warn', 'could not send a page set', { dispatchId: id, err: String(err) });
      await refuse(`The pages couldn’t be sent: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * A folder a `browser_preview` asked for (BT-48): read from the turn's own folder and, with `render`, opened in the
   * agent's Chromium for its screenshot (hermes-engine.md HE-S142; the pod's, or an assessment's own); a turn without a
   * browser sends the files without one, and the tool says so.
   */
  async #sendPreview(previewId: string, dir: string, render?: PreviewRequest['render']): Promise<void> {
    const { deps, id, lease, resources } = this.#turn;
    const submit = deps.api.submitPreview;
    if (!submit) return;
    const source = previewSourceOf(resources.prepared);
    const folder = source
      ? await readPreviewFolder(source, dir).catch((err: unknown) => ({
          error: `Couldn’t read ${dir}: ${err instanceof Error ? err.message : String(err)}`,
        }))
      : { error: PREVIEW_NO_FOLDER };
    let shot: PreviewShot | null = null;
    const browser = resources.browser ?? resources.pod?.browser ?? null;
    if (render && !('error' in folder) && browser) {
      const cdp = await CdpClient.open(browser.socket).catch((err: unknown) => {
        deps.log('warn', `preview: no browser (${String(err)})`, { dispatchId: id });
        return null;
      });
      try {
        if (cdp) shot = await previewShot(cdp, folder.files, render);
      } catch (err) {
        deps.log('warn', `preview: no screenshot (${String(err)})`, { dispatchId: id });
      } finally {
        cdp?.close();
      }
    }
    const body =
      'error' in folder ? { error: folder.error.slice(0, 500) } : { ...folder, ...(shot ? { shot } : {}) };
    await submit(id, previewId, { ...body, ...lease }).catch((err: unknown) =>
      deps.log('warn', 'could not send a preview', { dispatchId: id, err: String(err) }),
    );
  }
}
