/** Mirror xterm's inert style elements into constructable stylesheets under the hosted page's CSP. */
const STYLE_TAG = 'wb-xterm-style';

/** A document whose generated styles use the CSSOM, plus the lifetime of their mirrored stylesheets. */
export function styleSafeDocument(
  doc: Document,
): { document: Document; watch(root: HTMLElement): () => void } | null {
  if (!('adoptedStyleSheets' in doc) || typeof CSSStyleSheet === 'undefined') return null;
  const proxy = new Proxy(doc, {
    get(target, prop) {
      if (prop === 'createElement')
        return (tag: string, options?: ElementCreationOptions) => {
          if (tag.toLowerCase() === 'style') {
            const el = target.createElement(STYLE_TAG);
            el.hidden = true;
            return el;
          }
          // Truecolor cells use style attributes. The CSSOM accepts the same values under the hosted CSP.
          const el = target.createElement(tag, options);
          const setAttribute = el.setAttribute.bind(el);
          el.setAttribute = (name: string, value: string) => {
            if (name.toLowerCase() === 'style' && el instanceof HTMLElement) el.style.cssText = value;
            else setAttribute(name, value);
          };
          return el;
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    document: proxy,
    watch(root) {
      const sheets = new Map<Element, { sheet: CSSStyleSheet; text?: string }>();
      const sync = (dirty: Iterable<Element>) => {
        const present = [...dirty].filter((el) => root.contains(el));
        // Several styles can arrive together. Their cascade follows the DOM, even when one was prepended.
        present.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
        for (const el of present) {
          let mirrored = sheets.get(el);
          if (!mirrored) {
            mirrored = { sheet: new CSSStyleSheet() };
            sheets.set(el, mirrored);
            doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, mirrored.sheet];
          }
          const text = el.textContent ?? '';
          if (mirrored.text === text) continue;
          try {
            mirrored.sheet.replaceSync(text);
            mirrored.text = text;
          } catch {
            // A rule the browser doesn't take: skip it.
          }
        }
        const removed = new Set<CSSStyleSheet>();
        for (const [el, { sheet }] of sheets) {
          if (root.contains(el)) continue;
          sheets.delete(el);
          removed.add(sheet);
        }
        if (removed.size) doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => !removed.has(s));
      };
      const observer = new MutationObserver((records) => {
        const dirty = new Set<Element>();
        for (const record of records) {
          const parent = record.target instanceof Element ? record.target : record.target.parentElement;
          const style = parent?.closest(STYLE_TAG);
          if (style) dirty.add(style);
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.localName === STYLE_TAG) dirty.add(node);
            else for (const el of node.querySelectorAll(STYLE_TAG)) dirty.add(el);
          }
        }
        // Output changes ordinary terminal cells. Only new or edited styles need parsing.
        sync(dirty);
      });
      observer.observe(root, { subtree: true, childList: true, characterData: true });
      sync(root.querySelectorAll(STYLE_TAG));
      return () => {
        observer.disconnect();
        const ours = new Set([...sheets.values()].map(({ sheet }) => sheet));
        sheets.clear();
        doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => !ours.has(s));
      };
    },
  };
}
