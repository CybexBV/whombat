/*
 * The page set viewer's script (Whombat docs/decisions/page-sets.md). It runs inside the confined preview — the web's
 * sandboxed frame (`/sandbox/html-frame.html`, an opaque origin) or the phone's WebView — under the page policy, never
 * in the app. The app asks it to show one page of a set; it asks the app for that page's file and every file the page
 * uses, by path, and writes the page as its own document with those files in place: pictures and media as `blob:` URLs
 * made here, stylesheets and scripts inline, fonts as `data:` URLs. A click on a link to another file of the set goes
 * back to the app, which opens it. Nothing is fetched from anywhere: the policy forbids it, and the app answers only
 * for files of this set.
 *
 * The app's side: `@whombat/client/pages` (`PageSetHost`). Messages, with the app only:
 *   frame → app  {type: 'whombat.pages.ready'} when it starts
 *   app → frame  {type: 'whombat.pages.show', path, hash}
 *   frame → app  {type: 'whombat.pages.need', id, path}
 *   app → frame  {type: 'whombat.pages.file', id, ok, contentType, bytes (ArrayBuffer) | base64}
 *   frame → app  {type: 'whombat.pages.open', path, hash} · {type: 'whombat.pages.external', url}
 *                {type: 'whombat.pages.shown', path, title} · {type: 'whombat.pages.failed', path}
 *                {type: 'whombat.pages.escape'} (Escape the page didn't take)
 * On the phone messages travel as JSON strings (`window.ReactNativeWebView.postMessage`; the app answers with
 * `postMessage` or by calling `window.__whombatPages(message)`).
 */
(() => {
  const native = typeof window.ReactNativeWebView !== 'undefined';
  const host = native ? null : window.parent;
  if (!native && host === window) return; // opened on its own: nothing to show

  const send = (message) => {
    if (native) window.ReactNativeWebView.postMessage(JSON.stringify(message));
    else host.postMessage(message, '*');
  };

  /* Files from the app ------------------------------------------------------------------------- */

  const waiting = new Map();
  let nextId = 1;
  const NEED_MS = 60000;

  /** A file of the set: `{type, bytes}` or null when the set has none by that path (or the app didn't answer). */
  const need = (path) =>
    new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve(null);
      }, NEED_MS);
      waiting.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer.ok ? { type: answer.contentType || '', bytes: bytesOf(answer) } : null);
      });
      send({ type: 'whombat.pages.need', id, path });
    });

  const bytesOf = (answer) => {
    if (answer.bytes instanceof ArrayBuffer) return new Uint8Array(answer.bytes);
    if (ArrayBuffer.isView(answer.bytes))
      return new Uint8Array(answer.bytes.buffer, answer.bytes.byteOffset, answer.bytes.byteLength);
    if (typeof answer.base64 === 'string') {
      const text = atob(answer.base64);
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
      return out;
    }
    return new Uint8Array(0);
  };

  /** Each file is asked for once per page. */
  const cache = new Map();
  const file = (path) => {
    if (!cache.has(path)) cache.set(path, need(path));
    return cache.get(path);
  };

  const decoder = new TextDecoder('utf-8');
  const textOf = async (path) => {
    const got = await file(path);
    return got ? decoder.decode(got.bytes) : null;
  };

  const blobUrls = new Map();
  /** A `blob:` URL of this frame for a file (pictures and media), or null. */
  const blobUrl = async (path) => {
    if (blobUrls.has(path)) return blobUrls.get(path);
    const got = await file(path);
    const url = got ? URL.createObjectURL(new Blob([got.bytes], { type: got.type || typeFor(path) })) : null;
    blobUrls.set(path, url);
    return url;
  };

  const base64 = (bytes) => {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };

  /** A `data:` URL for a font (the policy takes fonts only that way). */
  const dataUrl = async (path) => {
    const got = await file(path);
    return got ? `data:${got.type || typeFor(path)};base64,${base64(got.bytes)}` : null;
  };

  const TYPES = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
  };
  const extOf = (path) => (/\.([a-z0-9]+)$/i.exec(path) || [])[1]?.toLowerCase() || '';
  const typeFor = (path) => TYPES[extOf(path)] || 'application/octet-stream';
  const isFont = (path) => /^font\//.test(typeFor(path));
  const isImage = (path) => /^image\//.test(typeFor(path));

  /* Paths, as `@whombat/core` `resolvePageRef` reads them ------------------------------------------ */

  const parts = (path) => {
    if (path.length > 1000 || path.includes('\\') || /\p{Cc}/u.test(path)) return null;
    const out = [];
    for (const part of path.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (out.length === 0) return null;
        out.pop();
      } else out.push(part);
    }
    return out;
  };

  /**
   * `{path, hash, query}` of a file of the set that `ref` in the file at `from` points to, `{same, hash, query}` for the
   * page itself, or null (elsewhere).
   */
  const resolve = (from, ref) => {
    const raw = (ref || '').trim();
    if (raw === '' || raw[0] === '#') return { same: true, hash: raw, query: '' };
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
    const hashAt = raw.indexOf('#');
    const hash = hashAt >= 0 ? raw.slice(hashAt) : '';
    let rest = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
    const queryAt = rest.indexOf('?');
    const query = queryAt >= 0 ? rest.slice(queryAt) : '';
    if (queryAt >= 0) rest = rest.slice(0, queryAt);
    if (rest === '') return { same: true, hash, query };
    try {
      rest = decodeURIComponent(rest);
    } catch {}
    const folder = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
    const p = parts(rest[0] === '/' ? rest : folder + rest);
    if (p === null) return null;
    if (p.length === 0) return { path: 'index.html', hash, query };
    const path = p.join('/');
    return { path: /(^|\/)\.{0,2}$/.test(rest) ? `${path}/index.html` : path, hash, query };
  };

  /**
   * A URL the page's script hands over, as the page meant it: a relative one as written, an address the browser made of
   * it against this frame's own address back to the relative one.
   */
  const relativeOf = (value) => {
    let raw = String(value || '');
    const folder = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
    if (/^https?:/i.test(folder) && raw.startsWith(folder)) raw = raw.slice(folder.length);
    return raw;
  };

  /* Rewriting a page --------------------------------------------------------------------------- */

  const URL_IN_CSS = /url\(\s*(['"]?)([^'")]*)\1\s*\)/g;
  const IMPORT_IN_CSS = /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?([^;]*);/g;

  /** CSS with its `url()`s (fonts as `data:`, the rest as `blob:`) and `@import`s (inline) in place. */
  const rewriteCss = async (css, from, depth = 0) => {
    let out = css;
    if (depth < 4) {
      const imports = [];
      out.replace(IMPORT_IN_CSS, (whole, _q, ref, media) => {
        imports.push({ whole, ref, media: media.trim() });
        return whole;
      });
      for (const imp of imports) {
        const target = resolve(from, imp.ref);
        const text = target?.path ? await textOf(target.path) : null;
        let inlined = '';
        if (text !== null && target?.path) {
          inlined = await rewriteCss(text, target.path, depth + 1);
          if (imp.media) inlined = `@media ${imp.media}{${inlined}}`;
        }
        out = out.replace(imp.whole, () => inlined);
      }
    }
    const refs = new Map();
    out.replace(URL_IN_CSS, (whole, _q, ref) => {
      const target = resolve(from, ref);
      if (target?.path) refs.set(ref, target.path);
      return whole;
    });
    const done = new Map();
    await Promise.all(
      [...refs].map(async ([ref, path]) => {
        done.set(ref, isFont(path) ? await dataUrl(path) : await blobUrl(path));
      }),
    );
    return out.replace(URL_IN_CSS, (whole, _q, ref) => {
      const url = done.get(ref);
      return url ? `url("${url}")` : whole;
    });
  };

  /** CSS can't end the element it is written into either. */
  const cssText = (css) => css.replace(/<\/(style)/gi, '<\\/$1');

  const SRCSET = /\s*([^\s,]+)(\s+[^,]+)?\s*(?:,|$)/g;

  const rewriteSrcset = async (value, from) => {
    const candidates = [];
    value.replace(SRCSET, (_whole, url, descriptor) => {
      candidates.push({ url, descriptor: descriptor || '' });
      return '';
    });
    const out = await Promise.all(
      candidates.map(async (c) => {
        const target = resolve(from, c.url);
        const url = target?.path ? await blobUrl(target.path) : null;
        return `${url || c.url}${c.descriptor}`;
      }),
    );
    return out.join(', ');
  };

  /** Attributes that load a picture or media file. */
  const MEDIA_ATTRS = [
    ['img', 'src'],
    ['source', 'src'],
    ['video', 'src'],
    ['video', 'poster'],
    ['audio', 'src'],
    ['track', 'src'],
    ['input', 'src'],
    ['image', 'href'],
    ['image', 'xlink:href'],
    ['link[rel~="icon"]', 'href'],
    ['link[rel~="apple-touch-icon"]', 'href'],
  ];

  /** The page at `path` as a document with its files in place. */
  const rewritePage = async (html, path) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const el of doc.querySelectorAll('base')) el.remove();
    // A page that sends you on to another (`<meta http-equiv="refresh" content="0;url=…">`) opens that one.
    const refresh = doc.querySelector('meta[http-equiv="refresh" i]');
    const onward = /url\s*=\s*['"]?([^'";]+)/i.exec(refresh?.getAttribute('content') || '');
    if (onward) {
      const target = resolve(path, onward[1]);
      if (target?.path || target?.query) return { redirect: target };
    }
    const jobs = [];
    for (const [selector, attr] of MEDIA_ATTRS)
      for (const el of doc.querySelectorAll(`${selector}[${attr.replace(':', '\\:')}]`)) {
        const target = resolve(path, el.getAttribute(attr));
        if (!target?.path) continue;
        jobs.push(
          blobUrl(target.path).then((url) => {
            if (url) el.setAttribute(attr, url);
          }),
        );
      }
    for (const el of doc.querySelectorAll('img[srcset], source[srcset]'))
      jobs.push(
        rewriteSrcset(el.getAttribute('srcset'), path).then((value) => el.setAttribute('srcset', value)),
      );
    for (const el of doc.querySelectorAll('link[rel~="stylesheet" i][href]')) {
      const target = resolve(path, el.getAttribute('href'));
      if (!target?.path) continue;
      const cssPath = target.path;
      jobs.push(
        textOf(cssPath).then(async (css) => {
          if (css === null) return;
          const style = doc.createElement('style');
          const media = el.getAttribute('media');
          if (media) style.setAttribute('media', media);
          style.textContent = cssText(await rewriteCss(css, cssPath));
          el.replaceWith(style);
        }),
      );
    }
    for (const el of doc.querySelectorAll('style'))
      jobs.push(rewriteCss(el.textContent || '', path).then((css) => (el.textContent = cssText(css))));
    for (const el of doc.querySelectorAll('[style]'))
      jobs.push(
        rewriteCss(el.getAttribute('style') || '', path).then((css) => el.setAttribute('style', css)),
      );
    for (const el of doc.querySelectorAll('script[src]')) {
      const target = resolve(path, el.getAttribute('src'));
      if (!target?.path) continue;
      jobs.push(
        textOf(target.path).then((js) => {
          if (js === null) return;
          el.removeAttribute('src');
          el.removeAttribute('integrity');
          el.removeAttribute('crossorigin');
          // A script's text can't end the element it is written into.
          el.textContent = js.replace(/<\/(script)/gi, '<\\/$1');
        }),
      );
    }
    for (const el of doc.querySelectorAll('a[href], area[href]')) {
      const target = resolve(path, el.getAttribute('href'));
      if (target === null) el.setAttribute('data-whombat-external', '');
      else {
        if (target.path && (target.path !== path || target.query))
          el.setAttribute('data-whombat-path', target.path);
        else if (target.query) el.setAttribute('data-whombat-path', path);
        el.setAttribute('data-whombat-hash', target.hash);
        el.setAttribute('data-whombat-query', target.query);
      }
    }
    // A frame inside the page can't load here (the policy has no frames): it becomes a way to open that page.
    for (const el of doc.querySelectorAll('iframe[src]')) {
      const target = resolve(path, el.getAttribute('src'));
      if (target?.path) el.setAttribute('data-whombat-frame', '');
    }
    await Promise.all(jobs);
    const doctype = doc.doctype ? `<!doctype ${doc.doctype.name}>` : '<!doctype html>';
    return { html: doctype + doc.documentElement.outerHTML };
  };

  /** A picture of the set shown as a page of its own. */
  const imagePage = async (path) => {
    const url = await blobUrl(path);
    if (!url) return null;
    const name = path.split('/').pop() || path;
    const safe = name.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    return `<!doctype html><html><head><title>${safe}</title><style>:root{color-scheme:light dark}html,body{margin:0;height:100%;background:Canvas}body{display:flex;align-items:center;justify-content:center}img{max-width:100%;max-height:100%;object-fit:contain}</style></head><body><img alt="${safe}" src="${url}"></body></html>`;
  };

  /* What the page does after it is written ----------------------------------------------------- */

  let current = null;
  let currentQuery = '';

  /** A file of the set as a `fetch()` answer; null when `input` isn't one of the set's files. */
  const setAnswer = (input) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    const target = resolve(current || '', relativeOf(raw));
    if (!target?.path) return null;
    return file(target.path).then((got) => {
      if (!got) return new Response('Not found', { status: 404, statusText: 'Not Found' });
      const type = got.type || typeFor(target.path);
      return new Response(got.bytes, {
        status: 200,
        headers: { 'content-type': type },
      });
    });
  };

  // `fetch()` of the set's own files is answered from the set (nothing else may be fetched here).
  const realFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  if (realFetch) window.fetch = (input, init) => setAnswer(input) ?? realFetch(input, init);

  /**
   * A script or picture whose address the page's script sets to a file of the set: kept aside (the browser would ask the
   * frame's own server for it) and put in place from the set.
   */
  const SET_SRC = 'data-whombat-src';
  const patchSrc = (proto, onSet) => {
    const own = proto && Object.getOwnPropertyDescriptor(proto, 'src');
    if (!own?.set || !own.get) return;
    Object.defineProperty(proto, 'src', {
      configurable: true,
      enumerable: own.enumerable,
      get() {
        return this.getAttribute(SET_SRC) ?? own.get.call(this);
      },
      set(value) {
        const raw = String(value);
        const target = /^(blob|data):/i.test(raw) ? null : resolve(current || '', relativeOf(raw));
        if (!target?.path) return own.set.call(this, value);
        this.setAttribute(SET_SRC, raw);
        onSet(this, target.path, own);
      },
    });
  };
  patchSrc(window.HTMLImageElement?.prototype, (img, path, own) => {
    void blobUrl(path).then((url) => {
      if (url) own.set.call(img, url);
    });
  });
  patchSrc(window.HTMLScriptElement?.prototype, (script) => {
    // Run when it is in the document (`runScript`).
    if (script.isConnected) runScript(script);
  });

  const running = new WeakSet();
  /** A script of the set's: its text, run in place, then its `load` as the browser would fire it. */
  const runScript = (el) => {
    if (running.has(el)) return;
    const raw = el.getAttribute(SET_SRC) ?? el.getAttribute('src');
    if (!raw || /^(blob|data):/i.test(raw)) return;
    const target = resolve(current || '', relativeOf(raw));
    if (!target?.path) return;
    running.add(el);
    if (el.hasAttribute('src')) {
      // Written as an attribute: the browser tries its own server and fails; this copy runs instead.
      const copy = document.createElement('script');
      for (const a of el.attributes) if (a.name !== 'src') copy.setAttribute(a.name, a.value);
      copy.setAttribute(SET_SRC, raw);
      running.add(copy);
      void textOf(target.path).then((js) => {
        if (js === null) return el.dispatchEvent(new Event('error'));
        copy.textContent = js;
        el.after(copy);
        el.dispatchEvent(new Event('load'));
      });
      return;
    }
    void textOf(target.path).then((js) => {
      if (js === null) return el.dispatchEvent(new Event('error'));
      el.textContent = js;
      el.dispatchEvent(new Event('load'));
    });
  };

  /** Where a page's frame would show another page of the set: a link that opens that page instead. */
  const frameLink = (frame) => {
    const target = resolve(current || '', relativeOf(frame.getAttribute('src')));
    const next = frame.nextElementSibling;
    if (next?.hasAttribute('data-whombat-frame-link')) next.remove();
    if (!target?.path) return;
    const link = document.createElement('a');
    link.setAttribute('data-whombat-frame-link', '');
    link.setAttribute('href', frame.getAttribute('src'));
    link.setAttribute('data-whombat-path', target.path);
    link.setAttribute('data-whombat-hash', target.hash);
    link.setAttribute('data-whombat-query', target.query);
    const name = target.path.split('/').pop() || target.path;
    link.textContent = `Open ${name}`;
    const box = frame.getBoundingClientRect();
    link.style.cssText = `display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:${box.width ? `${Math.round(box.width)}px` : '100%'};min-height:${box.height ? `${Math.round(box.height)}px` : '160px'};border:1px dashed currentColor;border-radius:8px;opacity:.75;font:inherit;color:inherit;text-decoration:underline`;
    frame.style.display = 'none';
    frame.after(link);
  };

  /** One element the page added or changed: its files from the set. */
  const fixElement = (el) => {
    const tag = el.localName;
    if (tag === 'script') return runScript(el);
    if (tag === 'iframe' && el.hasAttribute('src')) return frameLink(el);
    if (tag === 'link' && /\bstylesheet\b/i.test(el.getAttribute('rel') || '')) {
      const raw = el.getAttribute('href');
      const target = raw && !/^(blob|data):/i.test(raw) ? resolve(current || '', relativeOf(raw)) : null;
      if (!target?.path || running.has(el)) return;
      running.add(el);
      const cssPath = target.path;
      void textOf(cssPath).then(async (css) => {
        if (css === null) return;
        const style = document.createElement('style');
        style.textContent = await rewriteCss(css, cssPath);
        running.add(style);
        el.after(style);
        el.dispatchEvent(new Event('load'));
      });
      return;
    }
    if (tag === 'style' && !running.has(el)) {
      const css = el.textContent || '';
      if (!/url\(|@import/i.test(css)) return;
      running.add(el);
      void rewriteCss(css, current || '').then((out) => {
        if (out !== css && el.textContent === css) el.textContent = out;
      });
    }
    for (const attr of ['src', 'srcset', 'poster', 'href', 'xlink:href', 'style'])
      if (el.hasAttribute(attr)) fixAttr(el, attr);
  };

  const MEDIA_TAGS = new Set(['img', 'source', 'video', 'audio', 'track', 'input', 'image']);

  /** An attribute the page set or changed. */
  const fixAttr = (el, attr) => {
    const tag = el.localName;
    const value = el.getAttribute(attr);
    if (!value || /^(blob|data):/i.test(value)) return;
    if (attr === 'style') {
      if (!/url\(/i.test(value)) return;
      void rewriteCss(value, current || '').then((css) => {
        if (css !== value && el.getAttribute('style') === value) el.setAttribute('style', css);
      });
      return;
    }
    if (attr === 'srcset' && (tag === 'img' || tag === 'source')) {
      void rewriteSrcset(value, current || '').then((out) => {
        if (out !== value && el.getAttribute('srcset') === value) el.setAttribute('srcset', out);
      });
      return;
    }
    const media = MEDIA_TAGS.has(tag) && attr !== 'href' ? true : tag === 'image' && /href$/.test(attr);
    const icon = tag === 'link' && attr === 'href' && /\bicon\b/i.test(el.getAttribute('rel') || '');
    if (!media && !icon) {
      if (tag === 'iframe' && attr === 'src') frameLink(el);
      return;
    }
    const target = resolve(current || '', relativeOf(value));
    if (!target?.path) return;
    void blobUrl(target.path).then((url) => {
      if (url && el.getAttribute(attr) === value) el.setAttribute(attr, url);
    });
  };

  const fixTree = (node) => {
    if (node.nodeType !== 1) return;
    fixElement(node);
    for (const el of node.querySelectorAll('*')) fixElement(el);
  };

  let watching = null;
  /** From now on, what the page's scripts add or change gets its files from the set. */
  const watch = () => {
    watching?.disconnect();
    fixTree(document.documentElement);
    watching = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') for (const n of r.addedNodes) fixTree(n);
        else if (r.type === 'attributes' && r.attributeName) {
          if (
            r.target.localName === 'script' ||
            r.target.localName === 'iframe' ||
            r.target.localName === 'link'
          )
            fixElement(r.target);
          else fixAttr(r.target, r.attributeName);
        }
      }
    });
    watching.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'poster', 'href', 'xlink:href', 'style'],
    });
  };

  /* Showing ------------------------------------------------------------------------------------ */

  const scrollTo = (hash) => {
    if (!hash || hash === '#') return;
    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {}
    const target = document.getElementById(id) || document.getElementsByName(id)[0];
    target?.scrollIntoView();
  };

  /** Clicks on links: another file of the set goes to the app; the same page scrolls; elsewhere, the app may open it. */
  const onClick = (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey)
      return;
    // Only the script that is live in this document answers (a document written twice keeps the first one's listeners).
    if (window.__whombatPages !== onData) return;
    const link = event.target instanceof Element ? event.target.closest('a[href], area[href]') : null;
    if (!link) return;
    let path = link.getAttribute('data-whombat-path');
    let hash = link.getAttribute('data-whombat-hash');
    let query = link.getAttribute('data-whombat-query') || '';
    let external = link.hasAttribute('data-whombat-external');
    // A link the page's own script made after it was written: read it now.
    if (path === null && hash === null && !external) {
      const target = resolve(current || '', relativeOf(link.getAttribute('href')));
      if (target === null) external = true;
      else {
        if (target.path && target.path !== current) path = target.path;
        else if (target.query) path = current;
        hash = target.hash;
        query = target.query;
      }
    }
    if (external) {
      event.preventDefault();
      // Only what the person really clicked, never a click a script made.
      const url = link.getAttribute('href') || '';
      if (event.isTrusted && /^https?:\/\//i.test(url)) send({ type: 'whombat.pages.external', url });
      return;
    }
    hash = hash || '';
    event.preventDefault();
    if (path) send({ type: 'whombat.pages.open', path, hash, query });
    else scrollTo(hash);
  };

  const show = async (path, hash, query) => {
    current = path;
    currentQuery = query;
    let html;
    if (isImage(path)) html = await imagePage(path);
    else {
      const text = await textOf(path);
      if (text !== null && current === path) {
        const page = await rewritePage(text, path);
        if (page.redirect) {
          send({
            type: 'whombat.pages.open',
            path: page.redirect.path || path,
            hash: page.redirect.hash,
            query: page.redirect.query,
          });
          return;
        }
        html = page.html;
      }
    }
    if (current !== path) return;
    if (!html) {
      send({ type: 'whombat.pages.failed', path });
      return;
    }
    // The page reads its own address's `?…` as it would on a web server.
    try {
      history.replaceState(null, '', query || location.pathname);
    } catch {}
    document.open();
    document.write(html);
    document.close();
    // document.open() dropped every listener on this window: listen again.
    listen();
    watch();
    document.addEventListener('click', onClick, true);
    // Escape the page itself didn't take closes the viewer, as it would outside the frame.
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented && window.__whombatPages === onData)
        send({ type: 'whombat.pages.escape' });
    });
    const done = () => {
      scrollTo(hash);
      send({ type: 'whombat.pages.shown', path, title: (document.title || '').slice(0, 300) });
    };
    if (document.readyState === 'complete') done();
    else window.addEventListener('load', done, { once: true });
  };

  /* Messages ----------------------------------------------------------------------------------- */

  const onData = (data) => {
    let message = data;
    if (typeof message === 'string') {
      try {
        message = JSON.parse(message);
      } catch {
        return;
      }
    }
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'whombat.pages.show' && typeof message.path === 'string') {
      const query = typeof message.query === 'string' && /^(\?|$)/.test(message.query) ? message.query : '';
      if (current === message.path && currentQuery === query) return;
      void show(message.path, typeof message.hash === 'string' ? message.hash : '', query);
    } else if (message.type === 'whombat.pages.file') {
      const answer = waiting.get(message.id);
      if (!answer) return;
      waiting.delete(message.id);
      answer(message);
    }
  };

  const onMessage = (event) => {
    if (window.__whombatPages !== onData) return;
    if (!native && event.source !== host) return;
    onData(event.data);
  };

  function listen() {
    window.addEventListener('message', onMessage);
    // Android's WebView hands the app's postMessage to the document.
    if (native) document.addEventListener('message', onMessage);
  }

  window.__whombatPages = onData;
  listen();
  send({ type: 'whombat.pages.ready' });
})();
