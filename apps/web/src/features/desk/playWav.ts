/**
 * Listen's sample in the browser (desk-display-web.md AP-3402): the WAV as a Blob URL of `audio/wav` in an `Audio`
 * element (the app's policy allows `media-src blob:`), revoked once it ended, failed or was stopped. Settles when it
 * ended, at once when `signal` aborts; rejects when the browser can't play it (no sound device, a refused autoplay).
 */
export function playWav(wav: Uint8Array, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve();
    const url = URL.createObjectURL(new Blob([wav.slice()], { type: 'audio/wav' }));
    const audio = new Audio();
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', stop);
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      URL.revokeObjectURL(url);
      if (error === undefined) resolve();
      else reject(error);
    };
    const stop = () => finish();
    signal.addEventListener('abort', stop, { once: true });
    audio.onended = () => finish();
    audio.onerror = () => finish(new Error('The browser couldn’t play the sample.'));
    audio.src = url;
    // A browser from before media promises answers nothing; `ended` or `error` still settle it.
    audio
      .play()
      ?.catch((error: unknown) => finish(error ?? new Error('The browser didn’t play the sample.')));
  });
}
