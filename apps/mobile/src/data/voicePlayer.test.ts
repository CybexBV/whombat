/**
 * Listen's player on the phone (desk-display-android.md AP-3426): the page that plays a sample, what it says back, and
 * the WebView's settings.
 */
import { base64 } from '@whombat/client';
import { deskToneWav } from '@whombat/client/desk/fake';
import { describe, expect, it } from 'vitest';
import {
  VOICE_PLAYER_CSP,
  VOICE_PLAYER_WEBVIEW_PROPS,
  voicePlayerEvent,
  voicePlayerHtml,
  voicePlayerMayLoad,
} from './voicePlayer';

describe('the voice player', () => {
  it('plays the sample from a data: URL in a page that may load nothing else', () => {
    const wav = base64(deskToneWav(440, 0.05));
    const html = voicePlayerHtml(wav);
    expect(html.indexOf(VOICE_PLAYER_CSP)).toBeLessThan(html.indexOf('<audio'));
    expect(VOICE_PLAYER_CSP).toContain("default-src 'none'");
    expect(VOICE_PLAYER_CSP).toContain('media-src data:');
    expect(html).toContain(`src="data:audio/wav;base64,${wav}"`);
    expect(html).toContain('ReactNativeWebView.postMessage');
    expect(() => voicePlayerHtml('"><script>alert(1)</script>')).toThrow();
  });

  it('hears only what the page says', () => {
    expect(['playing', 'ended', 'error'].map(voicePlayerEvent)).toEqual(['playing', 'ended', 'error']);
    expect(voicePlayerEvent('ended ')).toBeNull();
    expect(voicePlayerEvent({ type: 'ended' })).toBeNull();
  });

  it('plays without a tap in the page, and goes nowhere', () => {
    expect(VOICE_PLAYER_WEBVIEW_PROPS.mediaPlaybackRequiresUserAction).toBe(false);
    expect(VOICE_PLAYER_WEBVIEW_PROPS.allowFileAccess).toBe(false);
    expect(VOICE_PLAYER_WEBVIEW_PROPS.domStorageEnabled).toBe(false);
    expect(voicePlayerMayLoad('about:blank')).toBe(true);
    expect(voicePlayerMayLoad('https://example.com/')).toBe(false);
    expect(VOICE_PLAYER_WEBVIEW_PROPS.onShouldStartLoadWithRequest({ url: 'data:text/html,hi' })).toBe(false);
  });
});
