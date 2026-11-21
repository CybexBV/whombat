import type { Bootstrap } from '@whombat/core';
import { themeColors } from '@whombat/tokens';
import { useEffect, useMemo } from 'react';
import { BASE_TITLE, unreadTitle, unreadTotals } from './unread';

/**
 * Unread shows outside the page (AP-98): the tab title counts what waits for you, the favicon gets a dot while
 * anything is unread, and an installed app (PWA) puts the count on its dock/taskbar icon (Badging API).
 */
export function useUnreadIndicator(sidebar: Bootstrap['sidebar'] | undefined) {
  const totals = useMemo(() => (sidebar ? unreadTotals(sidebar) : { count: 0, any: false }), [sidebar]);

  useEffect(() => {
    document.title = unreadTitle(totals.count);
    setAppBadge(totals);
  }, [totals]);

  useEffect(() => {
    if (!totals.any) return;
    let cancelled = false;
    void badgedFavicon().then((href) => {
      if (!cancelled && href) swapFavicons(href);
    });
    return () => {
      cancelled = true;
      restoreFavicons();
    };
  }, [totals.any]);

  useEffect(
    () => () => {
      document.title = BASE_TITLE;
      setAppBadge({ count: 0, any: false });
    },
    [],
  );
}

type BadgingNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

function setAppBadge({ count, any }: { count: number; any: boolean }) {
  const nav = navigator as BadgingNavigator;
  const ignore = () => {};
  // No count but something unread: the flag (dot) badge.
  if (count > 0) nav.setAppBadge?.(count).catch(ignore);
  else if (any) nav.setAppBadge?.().catch(ignore);
  else nav.clearAppBadge?.().catch(ignore);
}

const ICON_SRC = '/favicon.svg';
const SIZE = 64;
const cache = new Map<string, Promise<string | null>>();

/** The favicon with a dot in its top-right corner, as a PNG data URL (null where canvas can't draw). */
function badgedFavicon(): Promise<string | null> {
  const root = getComputedStyle(document.documentElement);
  const dot = root.getPropertyValue('--bad').trim() || themeColors.light.bad;
  const ring = root.getPropertyValue('--bg').trim() || themeColors.light.bg;
  const key = `${dot}|${ring}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = draw(dot, ring);
    cache.set(key, pending);
  }
  return pending;
}

function draw(dot: string, ring: string): Promise<string | null> {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return resolve(null);
    const context = ctx;
    const img = new Image();
    img.onload = () => {
      context.drawImage(img, 0, 0, SIZE, SIZE);
      const r = SIZE * 0.2;
      const cx = SIZE - r - 2;
      const cy = r + 2;
      context.beginPath();
      context.arc(cx, cy, r + 3, 0, Math.PI * 2);
      context.fillStyle = ring;
      context.fill();
      context.beginPath();
      context.arc(cx, cy, r, 0, Math.PI * 2);
      context.fillStyle = dot;
      context.fill();
      try {
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = ICON_SRC;
  });
}

const ORIGINAL = 'data-original-href';
const ORIGINAL_TYPE = 'data-original-type';

function iconLinks(): HTMLLinkElement[] {
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')];
}

function swapFavicons(href: string) {
  for (const link of iconLinks()) {
    if (!link.hasAttribute(ORIGINAL)) {
      link.setAttribute(ORIGINAL, link.getAttribute('href') ?? '');
      link.setAttribute(ORIGINAL_TYPE, link.getAttribute('type') ?? '');
    }
    link.setAttribute('type', 'image/png');
    link.href = href;
  }
}

function restoreFavicons() {
  for (const link of iconLinks()) {
    const original = link.getAttribute(ORIGINAL);
    if (original === null) continue;
    link.setAttribute('href', original);
    const type = link.getAttribute(ORIGINAL_TYPE);
    if (type) link.setAttribute('type', type);
    else link.removeAttribute('type');
    link.removeAttribute(ORIGINAL);
    link.removeAttribute(ORIGINAL_TYPE);
  }
}
