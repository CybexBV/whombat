/**
 * Installation snippets and public identifiers for Whombat Feedback (docs/decisions/feedback.md FB-02, FB-11,
 * FB-26). The loader API these examples use is frozen in `WhombatFeedbackApi`: every example and the loader
 * itself must match it.
 */
import { randomBytes } from '@noble/hashes/utils.js';
import type { FeedbackLauncher, FeedbackPosition, FeedbackTheme } from '../domain/feedback.js';

/** Context a site may give the widget with `setContext` (all optional, all unverified evidence). */
export interface WhombatFeedbackContextInput {
  app?: { version?: string | null; environment?: string | null; build?: string | null };
  /** Flat scalar values; only keys the integration allowlists are sent. */
  custom?: Record<string, string | number | boolean | null>;
  /** Diagnostic references (request or error ids). */
  references?: string[];
}

/**
 * `window.WhombatFeedback`, the loader's only global. Defined synchronously when `widget.js` runs; the loader
 * also dispatches `whombat-feedback:ready` on `document` then. Before the frame has loaded, `open` mounts it
 * and opens once it is ready, `setContext` is kept and applied, `close` is a no-op. After `destroy` every
 * method is a no-op and `ready` rejects.
 */
export interface WhombatFeedbackApi {
  readonly version: string;
  /** Resolves with the API once the loader is initialized (immediately after `widget.js` ran). */
  ready(): Promise<WhombatFeedbackApi>;
  /** Opens the panel (mounting the frame on first use), optionally preselecting a report type. */
  open(options?: { type?: 'bug' | 'feature' }): void;
  close(): void;
  isOpen(): boolean;
  /** Replaces the site-supplied context sent with the next report. */
  setContext(context: WhombatFeedbackContextInput): void;
  /** Removes the launcher, the frame and every listener; restores focus; the global stays but is inert. */
  destroy(): void;
}

/** The loader's `data-*` attributes. */
export const WIDGET_ATTRIBUTES = {
  site: 'data-site',
  theme: 'data-theme',
  position: 'data-position',
  launcher: 'data-launcher',
  label: 'data-label',
  /**
   * The site key pin (`fbk_…`, Whombat FD-07): present on a managed Whombat's snippet, where the frame runs in drop
   * mode and verifies the site card against it; absent on a self-hosted one (direct mode).
   */
  key: 'data-key',
  /**
   * `"off"`: the loader records no navigation trail and removes a stored one (CT-161). Absent or any other value: it
   * records the last page views, and the frame sends them when the site's config has `trail: true`.
   */
  trail: 'data-trail',
  /** On any element of the page: a click opens the widget (`"bug"`, `"feature"` or empty). */
  trigger: 'data-whombat-feedback',
} as const;

export const WIDGET_READY_EVENT = 'whombat-feedback:ready';

export interface SnippetInput {
  /** Public base address of this Whombat (`PUBLIC_URL`), origin only. */
  publicUrl: string;
  /**
   * Where the widget is served from, when that isn't `publicUrl`: a managed Whombat's embed origin
   * (`WHOMBAT_EMBED_URL`, else the hosted app's origin; Whombat FD-26, FD-31). Origin only.
   */
  embedUrl?: string | null;
  siteId: string;
  /** The site key pin (`fbk_…`, FD-07): adds `data-key`. Managed Whombat only. */
  siteKey?: string | null;
  theme: FeedbackTheme;
  position: FeedbackPosition;
  launcher: FeedbackLauncher;
  launcherLabel: string;
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

/** The origin the snippet loads the widget from: `embedUrl` when set, else `publicUrl` (without a trailing slash). */
export function snippetBase(input: Pick<SnippetInput, 'publicUrl' | 'embedUrl'>): string {
  return base(input.embedUrl || input.publicUrl);
}

function siteLines(input: SnippetInput): string[] {
  const lines = [`  data-site="${attr(input.siteId)}"`];
  if (input.siteKey) lines.push(`  data-key="${attr(input.siteKey)}"`);
  return lines;
}

/** The basic installation: one script tag. */
export function basicSnippet(input: SnippetInput): string {
  const lines = [
    '<script',
    `  src="${attr(snippetBase(input))}/embed/v1/widget.js"`,
    ...siteLines(input),
    `  data-theme="${attr(input.theme)}"`,
    `  data-position="${attr(input.position)}"`,
  ];
  if (input.launcher === 'custom') lines.push('  data-launcher="custom"');
  if (input.launcherLabel !== 'Feedback') lines.push(`  data-label="${attr(input.launcherLabel)}"`);
  lines.push('  defer', '></script>');
  return lines.join('\n');
}

/** No floating launcher: the site's own button opens it, and its code supplies safe context. */
export function customLauncherSnippet(input: SnippetInput): string {
  return [
    '<!-- 1. The widget, without its floating button -->',
    '<script',
    `  src="${attr(snippetBase(input))}/embed/v1/widget.js"`,
    ...siteLines(input),
    `  data-theme="${attr(input.theme)}"`,
    '  data-launcher="custom"',
    '  defer',
    '></script>',
    '',
    '<!-- 2. Any element with data-whombat-feedback opens it ("bug", "feature" or empty) -->',
    '<button type="button" data-whombat-feedback="bug">Report a problem</button>',
    '',
    '<!-- 3. Optional, in your own script file: context for reports. Never tokens or customer records. -->',
    '<!--',
    'function withFeedback(fn) {',
    '  if (window.WhombatFeedback) fn(window.WhombatFeedback);',
    "  else document.addEventListener('whombat-feedback:ready', () => fn(window.WhombatFeedback), { once: true });",
    '}',
    'withFeedback((feedback) => {',
    "  feedback.setContext({ app: { version: '1.4.2', environment: 'production' } });",
    "  document.querySelector('#help-menu-feedback')?.addEventListener('click', () => feedback.open({ type: 'feature' }));",
    '});',
    '-->',
  ].join('\n');
}

/**
 * What the website's Content-Security-Policy needs (if it has one): the origin the widget is served from, as a string
 * or as the snippet's input (`snippetBase`). No connect-src: the frame makes the calls (to this Whombat, or in drop
 * mode to Whombat's cloud).
 */
export function cspAdvice(from: string | Pick<SnippetInput, 'publicUrl' | 'embedUrl'>): string {
  const origin = typeof from === 'string' ? base(from) : snippetBase(from);
  return `script-src ${origin}; frame-src ${origin};`;
}

/** The 32 characters of a report reference (Crockford's base32, no I, L, O, U); a byte maps by its low 5 bits. */
export const FEEDBACK_REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CROCKFORD = FEEDBACK_REFERENCE_ALPHABET;

/** A new report reference, `FB-XXXX-XXXX` (40 random bits). Uniqueness is enforced by the database. */
export function newFeedbackReference(): string {
  const bytes = randomBytes(8);
  let body = '';
  for (const b of bytes) body += CROCKFORD[b & 31];
  return `FB-${body.slice(0, 4)}-${body.slice(4)}`;
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A new public site id, `fbs_` + 24 alphanumerics (~143 bits, unbiased). */
export function newFeedbackSiteId(): string {
  let out = '';
  while (out.length < 24) {
    for (const b of randomBytes(32)) {
      const v = b & 63;
      if (v < ALNUM.length && out.length < 24) out += ALNUM[v];
    }
  }
  return `fbs_${out}`;
}
