/**
 * Guide cards in the personal assistant's DM on the phone (docs/decisions/assistant-guides.md AG-02, AG-15, AG-17):
 * the view model of a card (label row, paragraphs, locked state, the answer row), the form's rules (required
 * fields, Google's client_secret JSON) and where links go (the web for sign-ins and settings, SUB-11; Add a server in
 * the app, AP-1704). Pure.
 */
import { addServerPrefillFromHref } from '@whombat/client/hosts';
import { applianceLink } from '@whombat/client/managed';
import { GUIDE_VALUE_MAX } from '@whombat/core/contracts';
import {
  type GuideBlock,
  type GuideCard,
  type GuideConnectBlock,
  type GuideField,
  guideCardLabel,
} from '@whombat/core/domain';
import { connectCardAppUrl } from '../navigation/connectionLinks';
import { addServerAppUrl } from '../navigation/routes';

export const GUIDE_TEXT = {
  expired: 'This expired. Ask me any time.',
  fillIn: 'Fill this in.',
  copy: 'Copy',
  copied: 'Copied',
  chooseFile: 'Choose the JSON file',
  fileTooBig: 'That file is too big to be Google’s client_secret JSON.',
  fileUnreadable: 'That file couldn’t be read. Try again.',
  failed: 'That didn’t go through',
} as const;

export interface GuideView {
  /** `SET UP · EMAIL · STEP 2 OF 6`. */
  label: string;
  title: string;
  /** The body split on blank lines. */
  paragraphs: string[];
  blocks: readonly GuideBlock[];
  /** `done` or `expired`: nothing to act on, only the answer row. */
  locked: boolean;
  /** The quiet row on a locked card (“You chose Google”), or null. */
  answer: string | null;
  /** The options the answer chose (marked on the locked card). */
  chosen: readonly string[];
}

/** The quiet row of a locked card: “You chose Google”, a button's label as is, or the expiry note. */
export function guideAnswerText(card: Pick<GuideCard, 'state' | 'answer'>): string | null {
  if (card.answer) return card.answer.optionIds ? `You chose ${card.answer.label}` : card.answer.label;
  return card.state === 'expired' ? GUIDE_TEXT.expired : null;
}

export function guideParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function guideView(card: GuideCard): GuideView {
  return {
    label: guideCardLabel(card),
    title: card.title,
    paragraphs: guideParagraphs(card.body),
    blocks: card.blocks,
    locked: card.state !== 'open',
    answer: card.state === 'open' ? null : guideAnswerText(card),
    chosen: card.answer?.optionIds ?? [],
  };
}

/** Ticks or unticks an option of a `multi` choice. */
export function toggleOption(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

/* The form ------------------------------------------------------------------------------------------- */

/** “Fill this in.” under each required field left empty, by field id. */
export function missingFields(
  fields: readonly GuideField[],
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) if (!f.optional && !(values[f.id] ?? '').trim()) out[f.id] = GUIDE_TEXT.fillIn;
  return out;
}

/** What `guides.act` gets: the filled fields as typed (not trimmed, CT-81), empty ones left out. */
export function formValues(
  fields: readonly GuideField[],
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.id] ?? '';
    if (v.trim()) out[f.id] = v;
  }
  return out;
}

export type ClientSecretFile =
  | { ok: true; clientId: string; clientSecret: string }
  | { ok: false; error: string };

export const DESKTOP_CLIENT_ERROR = 'This is a Desktop app client. Create one of type Web application.';
export const NOT_A_CLIENT_FILE = 'That isn’t the client_secret JSON file Google lets you download.';

/**
 * Google's `client_secret_*.json`, read on the phone (as the web's `parseClientSecretFile`): a Web application
 * client has a `web` key; a Desktop client has `installed` and doesn't work with a redirect URI.
 */
export function parseClientSecretFile(text: string): ClientSecretFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: NOT_A_CLIENT_FILE };
  }
  if (!data || typeof data !== 'object') return { ok: false, error: NOT_A_CLIENT_FILE };
  const record = data as Record<string, unknown>;
  if ('installed' in record && !('web' in record)) return { ok: false, error: DESKTOP_CLIENT_ERROR };
  const web = record.web as Record<string, unknown> | undefined;
  const clientId = typeof web?.client_id === 'string' ? web.client_id.trim() : '';
  const clientSecret = typeof web?.client_secret === 'string' ? web.client_secret.trim() : '';
  if (!clientId || !clientSecret) return { ok: false, error: NOT_A_CLIENT_FILE };
  return { ok: true, clientId, clientSecret };
}

/**
 * A picked JSON file into the form: the file's text goes in the `json_file` field (CT-81) and its Client ID and
 * secret fill the form's first `text` and first `secret` fields, so the person sees what will be saved. A file
 * that isn't a Web client fills nothing and returns the error to show under the file field.
 */
export function applyClientFile(
  fields: readonly GuideField[],
  fileField: string,
  text: string,
): { values: Record<string, string>; error: string | null } {
  if (text.length > GUIDE_VALUE_MAX) return { values: {}, error: GUIDE_TEXT.fileTooBig };
  const file = parseClientSecretFile(text);
  if (!file.ok) return { values: {}, error: file.error };
  const values: Record<string, string> = { [fileField]: text };
  const id = fields.find((f) => f.kind === 'text');
  const secret = fields.find((f) => f.kind === 'secret');
  if (id) values[id.id] = file.clientId;
  if (secret) values[secret.id] = file.clientSecret;
  return { values, error: null };
}

/* Where links go ------------------------------------------------------------------------------------- */

/** How this phone reaches the web: the Whombat through the hosted UI, or none (the demo world). */
export interface GuideWeb {
  /** The Whombat's id (`/appliances/<id>/…` on the hosted UI). */
  applianceId: string | null;
  /** The hosted UI's origin. */
  uiOrigin: string;
}

/** A path on this Whombat opened in the browser; null where there is no web (the demo world). */
export function guideWebUrl(web: GuideWeb, path: string): string | null {
  const p = path.startsWith('/') ? path : `/${path}`;
  return web.applianceId ? applianceLink(web.uiOrigin, web.applianceId, p) : null;
}

/** A button's or row's `href`: an https page as it is, a path on this Whombat on the web (or null without one). */
export function guideHrefUrl(web: GuideWeb, href: string): string | null {
  if (/^https:\/\//i.test(href)) return href;
  return href.startsWith('/') ? guideWebUrl(web, href) : null;
}

/**
 * A link the phone opens at its own screen rather than on the web (server-signin-mobile.md AP-1704): Add a server
 * (`/things/servers?add=1&address=…`, the assistant's card from `server_add`, SI-10), filled in, and Connect {Name}
 * (`/settings?tab=connections&connection=…`, the card from `connection_add`, connect-in-chat.md). Every other path on
 * this Whombat keeps opening the web (SUB-11). Null when it isn't one.
 */
export function guideAppUrl(href: string): string | null {
  const prefill = href.startsWith('/') ? addServerPrefillFromHref(href) : null;
  if (prefill) return addServerAppUrl(prefill);
  // The connect card's form (connect-in-chat.md): Connect {Name} filled in, on the phone.
  return connectCardAppUrl(href);
}

/**
 * The connect block on the phone (AG-15, SUB-11): the Chat on the web, where Google sign-in happens. The path with
 * the card's thread only: the web opens the thread, the person connects there.
 */
export function connectWebUrl(web: GuideWeb, block: Pick<GuideConnectBlock, 'returnTo'>): string | null {
  const [path = '/', query = ''] = block.returnTo.split('#')[0]?.split('?') ?? [];
  const thread = new URLSearchParams(query).get('thread');
  return guideWebUrl(web, `${path || '/'}${thread ? `?thread=${encodeURIComponent(thread)}` : ''}`);
}

const PROVIDER_NAMES: Record<string, string> = { google: 'Google', microsoft: 'Microsoft' };

export function connectLabel(block: Pick<GuideConnectBlock, 'provider' | 'reconnect'>): string {
  const name = PROVIDER_NAMES[block.provider] ?? block.provider;
  return `${block.reconnect ? 'Reconnect' : 'Connect'} ${name} on the web`;
}

/** The phone's own sign-in (PC-05, AP-2907): the web card's “Connect Google” / “Reconnect Google”. */
export function connectAppLabel(block: Pick<GuideConnectBlock, 'provider' | 'reconnect'>): string {
  if (block.provider === 'imap') return 'Connect email';
  const name = PROVIDER_NAMES[block.provider] ?? block.provider;
  return `${block.reconnect ? 'Reconnect' : 'Connect'} ${name}`;
}

/** When the sign-in couldn't start: “Couldn’t start connecting Google. Try again in a moment.” */
export function connectStartProblem(block: Pick<GuideConnectBlock, 'provider'>): string {
  const name = PROVIDER_NAMES[block.provider] ?? block.provider;
  return `Couldn’t start connecting ${name}. Try again in a moment.`;
}

export function connectNote(block: Pick<GuideConnectBlock, 'provider'>): string {
  const name = PROVIDER_NAMES[block.provider] ?? block.provider;
  return `${name} sign-in opens in your browser.`;
}
