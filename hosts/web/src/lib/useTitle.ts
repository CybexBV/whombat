import { useEffect } from 'react';
import { PRODUCT_NAME } from './product';

// The document title is "<page> · Rackoon", prefixed with the number of
// alerts that need attention ("(2) Overview · Rackoon"), and the favicon
// gets a dot while there are any, so a background tab shows them.

let page: string | null = null;
let badge = 0;
let baseIcon: string | null = null;

function apply(): void {
  const base = page ? `${page} · ${PRODUCT_NAME}` : PRODUCT_NAME;
  document.title = badge > 0 ? `(${badge}) ${base}` : base;
}

/** Sets the page part of document.title. */
export function useTitle(p: string | null): void {
  useEffect(() => {
    page = p;
    apply();
  }, [p]);
}

/** Sets the attention count shown in the title and the favicon. */
export function setAttentionBadge(n: number): void {
  if (n === badge) return;
  badge = n;
  apply();
  setFaviconDot(n > 0);
}

function setFaviconDot(on: boolean): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  if (baseIcon === null) baseIcon = link.href;
  if (!on) {
    link.href = baseIcon;
    return;
  }
  // The favicon is our own SVG: add a red dot in its corner.
  void fetch(baseIcon)
    .then((r) => r.text())
    .then((svg) => {
      if (badge === 0) return;
      const dotted = svg.replace('</svg>', '<circle cx="19.5" cy="5" r="4.5" fill="#d03b3b" stroke="#0a0b0d" stroke-width="1.5"/></svg>');
      link.href = `data:image/svg+xml,${encodeURIComponent(dotted)}`;
    })
    .catch(() => undefined);
}
