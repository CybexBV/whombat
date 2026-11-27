/**
 * The loader ↔ frame bridge (docs/decisions/feedback.md FB-06) and the constants both sides share. The loader
 * bundles this file, so it imports nothing but `@whombat/core/feedback/sanitize` (which is dependency-free);
 * the constants that also live in `@whombat/core` (behind Zod) are repeated here and a test keeps them equal.
 */
import { FEEDBACK_CONTEXT_LIMITS as LIMITS } from '@whombat/core/feedback/sanitize';

/** `FEEDBACK_BRIDGE_TAG` of `@whombat/core/contracts/feedback`. */
export const BRIDGE_TAG = 'whombat-feedback/1';
/** `WIDGET_READY_EVENT` of `@whombat/core/feedback/install`. */
export const READY_EVENT = 'whombat-feedback:ready';
/** Attributes understood by the loader. */
export const ATTRS = {
  site: 'data-site',
  theme: 'data-theme',
  position: 'data-position',
  launcher: 'data-launcher',
  label: 'data-label',
  lang: 'data-lang',
  trigger: 'data-whombat-feedback',
  key: 'data-key',
  trail: 'data-trail',
} as const;
/** `FeedbackSiteId` of `@whombat/core/domain/feedback`. */
export const SITE_ID = /^fbs_[A-Za-z0-9]{24}$/;
/** `FEEDBACK_SITE_KEY_PATTERN` of `@whombat/core/feedback/drop`: the `data-key` pin of a managed Whombat (FD-07). */
export const SITE_KEY = /^fbk_[A-Za-z0-9_-]{22}$/;
/** `FeedbackReference` of `@whombat/core/domain/feedback-card`. */
export const REFERENCE = /^FB-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
/** The per-instance nonce: 128 random bits, base64url (22 characters). */
export const INSTANCE = /^[A-Za-z0-9_-]{22}$/;

export type ReportType = 'bug' | 'feature';
export type Theme = 'auto' | 'light' | 'dark';

export type Scalar = string | number | boolean | null;

/**
 * One page view before reporting (`FeedbackTrailStep` of `@whombat/core`, CT-161): the sanitized page URL (origin +
 * path), its title and when the visitor got there (their clock).
 */
export interface TrailStep {
  url: string;
  title: string | null;
  at: string;
}

/** `Timestamp` of `@whombat/core` (`z.iso.datetime({ offset: true })`), without Zod. */
export const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/;

/** What the loader collects (FB-07). The frame re-applies the integration's rules before anything is sent. */
export interface WidgetContext {
  page: { url: string; title: string | null } | null;
  browser: {
    name: string;
    language: string | null;
    viewport: { width: number; height: number } | null;
    timeZone: string | null;
  } | null;
  app: { version: string | null; environment: string | null; build: string | null } | null;
  custom: Record<string, Scalar>;
  references: string[];
  /** The last page views on the site, oldest first, the current page last; absent with `data-trail="off"`. */
  trail?: TrailStep[];
}

export type FrameMessage =
  | { type: 'ready'; payload: Record<string, never> }
  | { type: 'close'; payload: Record<string, never> }
  | { type: 'submitted'; payload: { reference: string } }
  | { type: 'unavailable'; payload: Record<string, never> }
  | { type: 'request-context'; payload: Record<string, never> };

export type HostMessage =
  | { type: 'open'; payload: { type?: ReportType; context: WidgetContext } }
  | { type: 'context'; payload: { context: WidgetContext } }
  | { type: 'close'; payload: Record<string, never> };

export interface Envelope<M extends { type: string; payload: unknown }> {
  wb: typeof BRIDGE_TAG;
  instance: string;
  type: M['type'];
  payload: M['payload'];
}

type Obj = Record<string, unknown>;

/** A plain data object (what structured clone gives for `{…}`), not an array, class instance or null. */
function isPlainObject(value: unknown): value is Obj {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Only these keys (all optional here; callers check the required ones). */
function onlyKeys(value: Obj, keys: readonly string[]): boolean {
  return Object.keys(value).every((k) => keys.includes(k));
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return isPlainObject(value) && Object.keys(value).length === 0;
}

function shortString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function nullableString(value: unknown, max: number): value is string | null {
  return value === null || shortString(value, max);
}

function dimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 20_000;
}

/**
 * A valid navigation trail (at most `LIMITS.trail` steps of exactly `url`, `title`, `at`), copied, or null. The loader
 * reads its stored trail with it too.
 */
export function parseTrail(value: unknown): TrailStep[] | null {
  if (!Array.isArray(value) || value.length > LIMITS.trail) return null;
  const out: TrailStep[] = [];
  for (const step of value) {
    if (!isPlainObject(step) || !onlyKeys(step, ['url', 'title', 'at'])) return null;
    const { url, title, at } = step;
    if (!shortString(url, LIMITS.url) || !url || !nullableString(title, LIMITS.title)) return null;
    if (!shortString(at, 40) || !TIMESTAMP.test(at)) return null;
    out.push({ url, title, at });
  }
  return out;
}

/** A structurally valid context (types and caps), or null. Values are copied, never shared. */
export function parseContext(value: unknown): WidgetContext | null {
  if (!isPlainObject(value)) return null;
  if (!onlyKeys(value, ['page', 'browser', 'app', 'custom', 'references', 'trail'])) return null;
  const { page, browser, app, custom, references } = value;
  let trail: TrailStep[] | null = null;
  if (value.trail !== undefined) {
    trail = parseTrail(value.trail);
    if (!trail) return null;
  }

  let outPage: WidgetContext['page'] = null;
  if (page !== null) {
    if (!isPlainObject(page) || !onlyKeys(page, ['url', 'title'])) return null;
    if (!shortString(page.url, LIMITS.url) || !nullableString(page.title, LIMITS.title)) return null;
    outPage = { url: page.url, title: page.title };
  }

  let outBrowser: WidgetContext['browser'] = null;
  if (browser !== null) {
    if (!isPlainObject(browser) || !onlyKeys(browser, ['name', 'language', 'viewport', 'timeZone']))
      return null;
    const { name, language, viewport, timeZone } = browser;
    if (!shortString(name, 80) || !nullableString(language, 35) || !nullableString(timeZone, 64)) return null;
    let outViewport: { width: number; height: number } | null = null;
    if (viewport !== null) {
      if (!isPlainObject(viewport) || !onlyKeys(viewport, ['width', 'height'])) return null;
      if (!dimension(viewport.width) || !dimension(viewport.height)) return null;
      outViewport = { width: viewport.width, height: viewport.height };
    }
    outBrowser = { name, language, viewport: outViewport, timeZone };
  }

  let outApp: WidgetContext['app'] = null;
  if (app !== null) {
    if (!isPlainObject(app) || !onlyKeys(app, ['version', 'environment', 'build'])) return null;
    const { version, environment, build } = app;
    if (
      !nullableString(version, LIMITS.appField) ||
      !nullableString(environment, LIMITS.appField) ||
      !nullableString(build, LIMITS.appField)
    )
      return null;
    outApp = { version, environment, build };
  }

  if (!isPlainObject(custom)) return null;
  const keys = Object.keys(custom);
  if (keys.length > LIMITS.customEntries) return null;
  const outCustom: Record<string, Scalar> = {};
  for (const key of keys) {
    const v = custom[key];
    if (key.length > LIMITS.customKey) return null;
    if (typeof v === 'string') {
      if (v.length > LIMITS.customValue) return null;
    } else if (!(v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))))
      return null;
    outCustom[key] = v as Scalar;
  }

  if (!Array.isArray(references) || references.length > LIMITS.references) return null;
  if (!references.every((r) => shortString(r, LIMITS.reference))) return null;

  const out: WidgetContext = {
    page: outPage,
    browser: outBrowser,
    app: outApp,
    custom: outCustom,
    references: [...references],
  };
  if (trail) out.trail = trail;
  return out;
}

/** The envelope's type and payload when `data` is a message of this instance, else null. */
function envelope(data: unknown, instance: string): { type: string; payload: unknown } | null {
  if (!isPlainObject(data) || !onlyKeys(data, ['wb', 'instance', 'type', 'payload'])) return null;
  if (data.wb !== BRIDGE_TAG) return null;
  if (typeof data.instance !== 'string' || !INSTANCE.test(data.instance) || data.instance !== instance)
    return null;
  if (typeof data.type !== 'string') return null;
  return { type: data.type, payload: data.payload };
}

/** A message from the frame (for the loader), or null for anything else. The caller checks origin and source. */
export function parseFrameMessage(data: unknown, instance: string): FrameMessage | null {
  const e = envelope(data, instance);
  if (!e) return null;
  switch (e.type) {
    case 'ready':
    case 'close':
    case 'unavailable':
    case 'request-context':
      return isEmptyObject(e.payload) ? { type: e.type, payload: {} } : null;
    case 'submitted': {
      const p = e.payload;
      if (!isPlainObject(p) || !onlyKeys(p, ['reference'])) return null;
      return typeof p.reference === 'string' && REFERENCE.test(p.reference)
        ? { type: 'submitted', payload: { reference: p.reference } }
        : null;
    }
    default:
      return null;
  }
}

/** A message from the loader (for the frame), or null for anything else. The caller checks origin and source. */
export function parseHostMessage(data: unknown, instance: string): HostMessage | null {
  const e = envelope(data, instance);
  if (!e) return null;
  switch (e.type) {
    case 'close':
      return isEmptyObject(e.payload) ? { type: 'close', payload: {} } : null;
    case 'context': {
      const p = e.payload;
      if (!isPlainObject(p) || !onlyKeys(p, ['context'])) return null;
      const context = parseContext(p.context);
      return context ? { type: 'context', payload: { context } } : null;
    }
    case 'open': {
      const p = e.payload;
      if (!isPlainObject(p) || !onlyKeys(p, ['type', 'context'])) return null;
      if (p.type !== undefined && p.type !== 'bug' && p.type !== 'feature') return null;
      const context = parseContext(p.context);
      if (!context) return null;
      return { type: 'open', payload: p.type ? { type: p.type, context } : { context } };
    }
    default:
      return null;
  }
}

export function envelopeOf<M extends FrameMessage | HostMessage>(instance: string, message: M): Envelope<M> {
  return { wb: BRIDGE_TAG, instance, type: message.type, payload: message.payload };
}

/** 128 random bits, base64url without padding (22 characters). */
export function randomToken(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
