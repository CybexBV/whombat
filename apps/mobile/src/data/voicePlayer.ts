/**
 * Listen's sample on the phone (desk-display-android.md AP-3425…): the pure half. The app has no audio module, and a
 * native one would need a new APK build; `react-native-webview` is already in the app and its Chromium plays WAV. So
 * a WebView nobody sees loads a tiny page with the sample as a `data:audio/wav;base64,…` URL, plays it at once
 * (autoplay allowed for this WebView only) and says how it went through `postMessage`: `playing`, `ended` or `error`.
 * The page may load nothing but its own sample (its policy: `media-src data:`, the one inline script), and the WebView
 * no files, storage or navigation. No React Native imports: unit-tested.
 */

/** The page's policy: its sample (a `data:` URL) and its one inline script; nothing loads or goes out. */
export const VOICE_PLAYER_CSP = "default-src 'none'; media-src data:; script-src 'unsafe-inline'";

/** The page that plays `wavBase64` once and reports on it. */
export function voicePlayerHtml(wavBase64: string): string {
  // base64 has no quotes or angle brackets: the URL can't leave its attribute.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(wavBase64)) throw new Error('The sample isn’t base64.');
  return [
    '<!doctype html>',
    `<meta http-equiv="Content-Security-Policy" content="${VOICE_PLAYER_CSP}">`,
    `<audio id="a" preload="auto" src="data:audio/wav;base64,${wavBase64}"></audio>`,
    '<script>',
    'var a=document.getElementById("a");',
    'function post(m){window.ReactNativeWebView.postMessage(m)}',
    'a.onended=function(){post("ended")};',
    'a.onerror=function(){post("error")};',
    'var p=a.play();',
    'if(p&&p.then)p.then(function(){post("playing")},function(){post("error")});',
    '</script>',
  ].join('');
}

export type VoicePlayerEvent = 'playing' | 'ended' | 'error';

/** What the page said, or null for anything else (the WebView's own messages are ignored). */
export function voicePlayerEvent(data: unknown): VoicePlayerEvent | null {
  return data === 'playing' || data === 'ended' || data === 'error' ? data : null;
}

/**
 * How long a sample may take before the player gives up: to start (the WebView loads and decodes it), then to end
 * once it plays (a sample is at most 1 MiB of 24 kHz 16-bit mono: about 22 s).
 */
export const VOICE_PLAYER_START_MS = 10_000;
export const VOICE_PLAYER_END_MS = 30_000;

/** The player's page is the only thing it loads (both platforms load an HTML string as `about:blank`). */
export function voicePlayerMayLoad(url: string): boolean {
  return url === 'about:blank';
}

/**
 * The WebView's settings (react-native-webview 13): the sample plays without a tap inside the page
 * (`mediaPlaybackRequiresUserAction: false`; the person pressed Listen), and nothing else is allowed. `originWhitelist`
 * matches everything so that `onShouldStartLoadWithRequest` refuses other loads instead of handing them to the system.
 */
export const VOICE_PLAYER_WEBVIEW_PROPS = {
  originWhitelist: ['*'] as string[],
  javaScriptEnabled: true,
  javaScriptCanOpenWindowsAutomatically: false,
  setSupportMultipleWindows: false,
  domStorageEnabled: false,
  allowFileAccess: false,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  allowsLinkPreview: false,
  geolocationEnabled: false,
  incognito: true,
  cacheEnabled: false,
  thirdPartyCookiesEnabled: false,
  sharedCookiesEnabled: false,
  mediaPlaybackRequiresUserAction: false,
  allowsInlineMediaPlayback: true,
  mixedContentMode: 'never' as const,
  webviewDebuggingEnabled: false,
  onShouldStartLoadWithRequest: (request: { url: string }) => voicePlayerMayLoad(request.url),
};
