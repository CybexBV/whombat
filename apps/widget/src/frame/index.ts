/** The frame document's script (`assets/frame.<hash>.js`, docs/decisions/feedback.md FB-03). */
import { applyTheme, FrameApp } from './app';
import { connectBridge, frameParams } from './bridge';
import { ancestorOriginsOf, controlOrigin } from './drop';

const root = document.getElementById('wb-root') ?? document.body;
const params = frameParams(window);
if ('refused' in params) {
  // Not framed by the page its URL names: show nothing interactive and never talk to anyone.
  const p = document.createElement('p');
  p.className = 'refused';
  p.textContent = 'Feedback isn’t available on this site right now.';
  root.replaceChildren(p);
} else {
  applyTheme(document, params.theme);
  let app: FrameApp | null = null;
  const bridge = connectBridge(window, params, (message, origin) => app?.handle(message, origin));
  app = new FrameApp({
    params,
    bridge,
    fetch: (url, init) => fetch(url, init),
    baseUrl: location.href,
    root,
    // Drop mode (a site key in the URL, Whombat FD-27): control's origin from frame.html, the frame's ancestors.
    ...(params.key
      ? { drop: { control: controlOrigin(document), ancestorOrigins: ancestorOriginsOf(location) } }
      : {}),
  });
  bridge.post({ type: 'ready', payload: {} });
  void app.load();
}
