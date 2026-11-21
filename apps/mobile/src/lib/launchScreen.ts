/**
 * When Android's launch screen (the logo on the theme's `bg`) gives way (one-layout-android.md AP-2643): not at the
 * first frame, but at the first frame drawn without a placeholder of the start — the fonts, the kept sign-in, the
 * Whombat being opened, its burrow, the saved place — each a `hold` while it shows. At the latest after `LAUNCH_MAX_MS`,
 * when the waiting is shown as before. Once it has gone it stays gone. Pure: the native calls are injected.
 */

/** The longest the logo stays. */
export const LAUNCH_MAX_MS = 3000;

export interface LaunchScreenDeps {
  /** Keeps the native launch screen up past the first frame. */
  keep(): void;
  /** Lets it go. */
  hide(): void;
  setTimer(fn: () => void, ms: number): () => void;
  /** Runs `fn` once what is committed now has been drawn. */
  afterDraw(fn: () => void): void;
}

export interface LaunchScreen {
  /** Keeps the logo (call once, before the first render), with the `LAUNCH_MAX_MS` limit. */
  start(): void;
  /** A placeholder shows: the logo stays until it goes. Returns its release. */
  hold(): () => void;
  /** The app has committed its first frame: the logo goes once a frame is drawn with nothing held. */
  settle(): void;
  readonly gone: boolean;
}

export function createLaunchScreen(deps: LaunchScreenDeps): LaunchScreen {
  let started = false;
  let settled = false;
  let gone = false;
  let holds = 0;
  let checking = false;
  let stopTimer = () => {};
  const hide = () => {
    if (gone) return;
    gone = true;
    stopTimer();
    deps.hide();
  };
  // Checked once the frame is drawn: a placeholder replaced by the next in the same commit doesn't let the logo go.
  const check = () => {
    if (gone || checking || !settled) return;
    checking = true;
    deps.afterDraw(() => {
      checking = false;
      if (holds === 0) hide();
    });
  };
  return {
    start() {
      if (started) return;
      started = true;
      deps.keep();
      stopTimer = deps.setTimer(hide, LAUNCH_MAX_MS);
    },
    hold() {
      if (gone) return () => {};
      holds++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
        check();
      };
    },
    settle() {
      settled = true;
      check();
    },
    get gone() {
      return gone;
    },
  };
}
