/**
 * The frame's end of the bridge (docs/decisions/feedback.md FB-05, FB-06). The frame runs only when it is framed
 * by the exact origin its URL names (`parent`, checked against `location.ancestorOrigins` where the browser has
 * it), talks only to `window.parent` with that exact target origin, and accepts only its instance's messages.
 */
import { normalizeOrigin } from '@whombat/core/feedback/sanitize';
import {
  envelopeOf,
  type FrameMessage,
  type HostMessage,
  INSTANCE,
  parseHostMessage,
  SITE_ID,
  SITE_KEY,
  type Theme,
} from '../shared/protocol';
import {
  browserLanguage,
  type LanguagePreferences,
  supportedVisitorLanguage,
} from '../shared/visitor-language';

export function frameLanguage(
  win: Pick<FrameWindowLike, 'location'> & { navigator: LanguagePreferences },
): string {
  const query = new URLSearchParams(win.location.search);
  return supportedVisitorLanguage(query.get('lang')) ?? browserLanguage(win.navigator);
}

export interface FrameParams {
  site: string;
  /** The embedding page's origin, canonical. */
  parent: string;
  theme: Theme;
  instance: string;
  /** The site key pin (`key=`, Whombat FD-27): drop mode when present, the direct widget otherwise. */
  key: string | null;
}

/** What `frameParams` needs of `window`. */
export interface FrameWindowLike {
  location: { search: string; hash: string; ancestorOrigins?: { length: number; [i: number]: string } };
  parent: unknown;
  top?: unknown;
}

/** The frame's parameters, or why it refuses to run. */
export function frameParams(win: FrameWindowLike): FrameParams | { refused: string } {
  if (win.parent === win || !win.parent) return { refused: 'not framed' };
  const query = new URLSearchParams(win.location.search);
  const site = query.get('site') ?? '';
  if (!SITE_ID.test(site)) return { refused: 'bad site' };
  const parent = query.get('parent') ?? '';
  if (normalizeOrigin(parent) !== parent) return { refused: 'bad parent' };
  const ancestors = win.location.ancestorOrigins;
  if (ancestors && ancestors.length > 0 && ancestors[0] !== parent) return { refused: 'parent mismatch' };
  const hash = new URLSearchParams(win.location.hash.replace(/^#/, ''));
  const instance = hash.get('instance') ?? '';
  if (!INSTANCE.test(instance)) return { refused: 'bad instance' };
  const key = query.get('key');
  if (key !== null && !SITE_KEY.test(key)) return { refused: 'bad key' };
  const theme = query.get('theme');
  return {
    site,
    parent,
    instance,
    theme: theme === 'light' || theme === 'dark' ? theme : 'auto',
    key,
  };
}

export interface FrameBridge {
  post(message: FrameMessage): void;
  close(): void;
}

/**
 * Listens for the loader's messages (exact origin and source, this instance) and posts back to it only.
 * `onMessage` gets the message's `event.origin` too: drop mode seals it as the bridge origin (FD-15, FD-28).
 */
export function connectBridge(
  win: Window,
  params: FrameParams,
  onMessage: (message: HostMessage, origin: string) => void,
): FrameBridge {
  const listener = (event: MessageEvent) => {
    if (event.origin !== params.parent || event.source !== win.parent || event.source === null) return;
    const message = parseHostMessage(event.data, params.instance);
    if (message) onMessage(message, event.origin);
  };
  win.addEventListener('message', listener);
  return {
    post(message) {
      win.parent.postMessage(envelopeOf(params.instance, message), params.parent);
    },
    close() {
      win.removeEventListener('message', listener);
    },
  };
}
