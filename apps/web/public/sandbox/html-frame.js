/*
 * The HTML preview frame (AP-320): /sandbox/html-frame.html inside <iframe sandbox="allow-scripts"> (an opaque origin:
 * no cookies, storage or access to the app; no popups, forms or top navigation), under its own Content-Security-Policy
 * (inline scripts and styles, bundled runtimes and embedded assets only).
 *
 * Protocol, with the parent only: the frame says {type: 'whombat.ready'} when it starts, the parent answers
 * {type: 'whombat.html', html}, the frame writes it as its own document and reports {type: 'whombat.height', height}
 * whenever the page's height changes. After that the parent may send {type: 'whombat.theme', css}: its text replaces the
 * page's theme style (<style id="whombat-page">, docs/decisions/visual-replies.md), so the page follows the app between
 * light and dark. Nothing else is read. A frame moved in the parent's document reloads this page, which asks again
 * (AP-5348).
 */
(() => {
  const host = window.parent;
  if (host === window) return; // opened on its own: nothing to show

  function write(event) {
    if (event.source !== host) return;
    const data = event.data;
    if (data?.type !== 'whombat.html' || typeof data.html !== 'string') return;
    window.removeEventListener('message', write);

    let last = -1;
    const report = () => {
      // The page's own height (not scrollHeight of the root: that is never less than the frame's).
      const root = document.documentElement;
      const height = Math.ceil(
        Math.max(
          root ? root.getBoundingClientRect().height : 0,
          document.body ? document.body.scrollHeight : 0,
        ),
      );
      if (height === last) return;
      last = height;
      host.postMessage({ type: 'whombat.height', height }, '*');
    };

    document.open();
    document.write(data.html);
    document.close();

    // document.open() dropped every listener on this window: observe the new page from here.
    const observer = new ResizeObserver(report);
    const watch = () => {
      if (document.documentElement) observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
      report();
    };
    watch();
    document.addEventListener('DOMContentLoaded', watch);
    window.addEventListener('load', watch);
    // A new theme from the app: only text for the theme style the app put in, never markup.
    window.addEventListener('message', (e) => {
      if (e.source !== host || e.data?.type !== 'whombat.theme' || typeof e.data.css !== 'string') return;
      const style = document.getElementById('whombat-page');
      if (style instanceof HTMLStyleElement) style.textContent = e.data.css;
    });
    // Pages that size themselves against the viewport don't always resize their root: check now and then.
    setInterval(report, 1000);
  }

  window.addEventListener('message', write);
  host.postMessage({ type: 'whombat.ready' }, '*');
})();
