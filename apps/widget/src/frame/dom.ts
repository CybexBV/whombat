/** A tiny DOM builder for the frame (no framework, no innerHTML: every string is text). */

type Child = Node | string | null | undefined | false;
type AttrValue = string | number | boolean | null | undefined;
export type Attrs = Record<string, AttrValue | ((event: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false && value !== null && value !== undefined) el.setAttribute(key, String(value));
  }
  append(el, ...children);
  return el;
}

export function append(el: Element, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

const SVG = 'http://www.w3.org/2000/svg';

/** A 1.75px line icon (Lucide geometry), hidden from assistive technology. */
export function icon(paths: string[], size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    width: String(size),
    height: String(size),
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.75',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }))
    svg.setAttribute(k, v);
  for (const d of paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

export const ICONS = {
  close: ['M18 6 6 18', 'm6 6 12 12'],
  check: ['M20 6 9 17l-5-5'],
  image: [
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
    'M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21',
  ],
  external: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  alert: ['M12 8v4', 'M12 16h.01', 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z'],
} as const;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** The elements Tab can reach inside `root`, in order (not hidden, not inside a closed `<details>`). */
export function focusables(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.tabIndex < 0 || el.closest('[hidden]')) return false;
    // A radio group is one tab stop: its checked radio (the frame always checks one).
    if (el instanceof HTMLInputElement && el.type === 'radio' && !el.checked) return false;
    const details = el.closest('details');
    return !details || details.open || (el.tagName === 'SUMMARY' && el.parentElement === details);
  });
}
