/**
 * Mail-arrives automation triggers: pure address/domain parsing, attachment-type matching, validation and
 * plain-English trigger phrases shared by the server, web and mobile.
 */
import type {
  MailTrigger,
  MissingMailAttachment,
  MissingMailAttachmentReason,
} from '../domain/automation.js';
import { type CoreMessageKey, type CoreTranslator, coreTranslator, tCore, tpCore } from '../i18n/catalog.js';

/** Fallback name when a mail connection's address isn't available to the viewer. */
export const UNKNOWN_MAIL_CONNECTION = 'a mail account';

export interface MailAttachmentFacts {
  name: string;
  mimeType: string;
}

export interface MailTriggerFacts {
  kind: 'mail';
  connectionId: string;
  /** Raw `From` header (e.g. `Acme Billing <billing@example.com>`) or bare address. */
  from: string;
  subject: string;
  hasAttachments: boolean;
  attachments: readonly MailAttachmentFacts[];
}

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const LOCAL_RE = /^[^\s<>@,;"\\]+$/;
const MIME_TYPE_RE = /^[a-z0-9.+-]+\/(?:[a-z0-9.+-]+|\*)$/;
const EXT_RE = /^[a-z0-9]{1,20}$/;

/** Known MIME types for common short attachment extensions, so a PDF matches whether named `.pdf` or typed `application/pdf`. */
const EXTENSION_MIMES: Readonly<Record<string, readonly string[]>> = {
  pdf: ['application/pdf'],
  csv: ['text/csv', 'application/csv'],
  txt: ['text/plain'],
  json: ['application/json'],
  xml: ['application/xml', 'text/xml'],
  html: ['text/html'],
  htm: ['text/html'],
  zip: ['application/zip', 'application/x-zip-compressed'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  svg: ['image/svg+xml'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ppt: ['application/vnd.ms-powerpoint'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ics: ['text/calendar'],
};

/** Friendly singular phrases for common attachment types (“a PDF”, “an image”). */
const ATTACHMENT_PHRASES: Readonly<Record<string, string>> = {
  pdf: 'a PDF',
  'application/pdf': 'a PDF',
  csv: 'a CSV',
  'text/csv': 'a CSV',
  'image/*': 'an image',
  png: 'a PNG',
  'image/png': 'a PNG',
  jpg: 'a JPEG',
  jpeg: 'a JPEG',
  'image/jpeg': 'a JPEG',
  gif: 'a GIF',
  'image/gif': 'a GIF',
  webp: 'a WebP image',
  'image/webp': 'a WebP image',
  doc: 'a Word document',
  docx: 'a Word document',
  xls: 'a spreadsheet',
  xlsx: 'a spreadsheet',
  zip: 'a ZIP file',
  'application/zip': 'a ZIP file',
  xml: 'an XML file',
  'application/xml': 'an XML file',
  'text/xml': 'an XML file',
  json: 'a JSON file',
  'application/json': 'a JSON file',
  txt: 'a text file',
  'text/plain': 'a text file',
  ics: 'a calendar invite',
  'text/calendar': 'a calendar invite',
};

/**
 * Extracts the real lowercase email address from an RFC 5322 `From` header while ignoring quoted display names and
 * comments, so `"billing@example.com" <attacker@evil.org>` resolves to `attacker@evil.org`.
 */
export function extractMailAddress(raw: string): string | null {
  let inQuotes = false;
  let commentDepth = 0;
  let angleStart = -1;
  let lastAngle: string | null = null;
  let bare = '';

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (inQuotes) {
      if (ch === '\\' && i + 1 < raw.length) {
        i++;
        continue;
      }
      if (ch === '"') inQuotes = false;
      continue;
    }
    if (commentDepth > 0) {
      if (ch === '\\' && i + 1 < raw.length) {
        i++;
        continue;
      }
      if (ch === '(') commentDepth++;
      else if (ch === ')') commentDepth--;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === '(') {
      commentDepth++;
      continue;
    }
    if (ch === '<') {
      angleStart = i + 1;
      continue;
    }
    if (ch === '>' && angleStart >= 0) {
      lastAngle = raw.slice(angleStart, i).trim();
      angleStart = -1;
      continue;
    }
    if (angleStart < 0) bare += ch;
  }

  const candidate = (lastAngle ?? bare).trim().toLowerCase();
  if (!candidate) return null;
  // When no angle brackets were present, pick the address token (there may be an unquoted display name before it).
  const addr = lastAngle
    ? candidate
    : (candidate
        .split(/\s+/)
        .reverse()
        .find((tok) => tok.includes('@')) ?? '');
  const at = addr.indexOf('@');
  if (at <= 0 || at !== addr.lastIndexOf('@')) return null;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1).replace(/\.$/, '');
  if (!LOCAL_RE.test(local) || !DOMAIN_RE.test(domain)) return null;
  return `${local}@${domain}`;
}

/** Normalizes a `from` trigger filter into either a full address or a domain (stripping a leading `@`). */
export function normalizeMailFrom(from: string): { kind: 'address' | 'domain'; value: string } | null {
  const clean = from.trim().toLowerCase().replace(/\.$/, '');
  if (!clean) return null;
  if (clean.startsWith('@')) {
    const domain = clean.slice(1);
    return DOMAIN_RE.test(domain) ? { kind: 'domain', value: domain } : null;
  }
  const at = clean.indexOf('@');
  if (at >= 0) {
    if (at === 0 || at !== clean.lastIndexOf('@')) return null;
    const local = clean.slice(0, at);
    const domain = clean.slice(at + 1);
    return LOCAL_RE.test(local) && DOMAIN_RE.test(domain)
      ? { kind: 'address', value: `${local}@${domain}` }
      : null;
  }
  return DOMAIN_RE.test(clean) ? { kind: 'domain', value: clean } : null;
}

export function mailFromProblem(from: string): string | null {
  return normalizeMailFrom(from)
    ? null
    : 'Give an email address (like billing@example.com) or a domain (like example.com).';
}

/**
 * Checks whether a `From` header matches a sender filter: exact match for an address, or exact domain / subdomain match
 * for a domain (so `example.com` matches `billing@example.com` and `billing@mail.example.com`, never `evil-example.com`
 * or `example.com.evil.org`).
 */
export function mailFromMatches(pattern: string, fromHeader: string): boolean {
  const target = normalizeMailFrom(pattern);
  const sender = extractMailAddress(fromHeader);
  if (!target || !sender) return false;
  if (target.kind === 'address') return sender === target.value;
  const domain = sender.slice(sender.indexOf('@') + 1);
  return domain === target.value || domain.endsWith(`.${target.value}`);
}

/** Normalizes an attachment type filter (`".PDF"` → `"pdf"`, `"application/pdf; charset=binary"` → `"application/pdf"`). */
export function normalizeAttachmentType(type: string): string {
  const base = (type.split(';')[0] ?? '').trim().toLowerCase();
  return base.startsWith('.') ? base.slice(1) : base;
}

export function mailAttachmentTypeProblem(type: string): string | null {
  const norm = normalizeAttachmentType(type);
  if (MIME_TYPE_RE.test(norm) || EXT_RE.test(norm)) return null;
  return `“${type}” isn’t a file type Whombat understands (use e.g. pdf, csv or application/pdf).`;
}

/** Checks whether a single attachment matches a file extension (`pdf`) or MIME type (`application/pdf`, `image/*`). */
export function mailAttachmentMatches(pattern: string, attachment: MailAttachmentFacts): boolean {
  const norm = normalizeAttachmentType(pattern);
  if (!norm) return false;
  const mime = (attachment.mimeType.split(';')[0] ?? '').trim().toLowerCase();
  const name = attachment.name.trim().toLowerCase();
  if (norm.includes('/')) {
    if (norm.endsWith('/*')) return mime.startsWith(norm.slice(0, -1));
    if (mime === norm) return true;
    // Also match by known extension when the sender sent `application/octet-stream` with a clear filename.
    for (const [ext, mimes] of Object.entries(EXTENSION_MIMES)) {
      if (mimes.includes(norm) && name.endsWith(`.${ext}`)) return true;
    }
    return false;
  }
  if (name.endsWith(`.${norm}`)) return true;
  const known = EXTENSION_MIMES[norm];
  return Boolean(known?.includes(mime));
}

/** Pure matcher for a `mail` trigger against an incoming email's headers and attachment metadata. */
export function mailTriggerMatches(trigger: MailTrigger, facts: MailTriggerFacts): boolean {
  if (facts.connectionId !== trigger.connectionId) return false;
  if (trigger.from && !mailFromMatches(trigger.from, facts.from)) return false;
  if (trigger.subjectContains?.length) {
    const subject = facts.subject.toLowerCase();
    if (!trigger.subjectContains.some((w) => subject.includes(w.toLowerCase()))) return false;
  }
  const types = trigger.attachmentTypes?.length ? trigger.attachmentTypes : null;
  if (trigger.hasAttachment || types) {
    const hasAny = facts.hasAttachments || facts.attachments.length > 0;
    if (!hasAny) return false;
    if (types && !facts.attachments.some((a) => types.some((t) => mailAttachmentMatches(t, a)))) return false;
  }
  return true;
}

/** Semantic validation problems for a mail trigger (empty when valid). */
export function mailTriggerProblems(
  trigger: Pick<MailTrigger, 'from' | 'hasAttachment' | 'attachmentTypes'>,
): string[] {
  const problems: string[] = [];
  if (trigger.from !== undefined) {
    const err = mailFromProblem(trigger.from);
    if (err) problems.push(`from: ${err}`);
  }
  if (trigger.attachmentTypes?.length) {
    if (trigger.hasAttachment === false)
      problems.push('attachmentTypes: can’t require attachment types when hasAttachment is false.');
    for (const type of trigger.attachmentTypes) {
      const err = mailAttachmentTypeProblem(type);
      if (err) problems.push(`attachmentTypes: ${err}`);
    }
  }
  return problems;
}

function attachmentPhrase(raw: string): string {
  const norm = normalizeAttachmentType(raw);
  const known = ATTACHMENT_PHRASES[norm];
  if (known) return known;
  if (norm.includes('/')) {
    const [major, minor] = norm.split('/');
    if (minor === '*') return `${/^[aeiou]/.test(major ?? '') ? 'an' : 'a'} ${major} file`;
    return `a ${norm} file`;
  }
  const upper = norm.toUpperCase();
  const article = /^[AEFHILMNORSX]/.test(upper) ? 'an' : 'a';
  return `${article} ${upper} file`;
}

/** What an attachment type is called outside English: a phrase of its own, or its short name in a frame. */
const ATTACHMENT_WORDS: Readonly<Record<string, CoreMessageKey | { named: string } | { file: string }>> = {
  pdf: { named: 'PDF' },
  'application/pdf': { named: 'PDF' },
  csv: { named: 'CSV' },
  'text/csv': { named: 'CSV' },
  'image/*': 'mailWhen.attach.image',
  png: { named: 'PNG' },
  'image/png': { named: 'PNG' },
  jpg: { named: 'JPEG' },
  jpeg: { named: 'JPEG' },
  'image/jpeg': { named: 'JPEG' },
  gif: { named: 'GIF' },
  'image/gif': { named: 'GIF' },
  webp: 'mailWhen.attach.webp',
  'image/webp': 'mailWhen.attach.webp',
  doc: 'mailWhen.attach.word',
  docx: 'mailWhen.attach.word',
  xls: 'mailWhen.attach.sheet',
  xlsx: 'mailWhen.attach.sheet',
  zip: { file: 'ZIP' },
  'application/zip': { file: 'ZIP' },
  xml: { file: 'XML' },
  'application/xml': { file: 'XML' },
  'text/xml': { file: 'XML' },
  json: { file: 'JSON' },
  'application/json': { file: 'JSON' },
  txt: 'mailWhen.attach.text',
  'text/plain': 'mailWhen.attach.text',
  ics: 'mailWhen.attach.calendar',
  'text/calendar': 'mailWhen.attach.calendar',
};

function attachmentPhraseIn(tr: CoreTranslator, raw: string): string {
  const norm = normalizeAttachmentType(raw);
  const known = ATTACHMENT_WORDS[norm];
  if (typeof known === 'string') return tr.t(known);
  if (known && 'named' in known) return tr.t('mailWhen.attach.named', { type: known.named });
  if (known) return tr.t('mailWhen.attach.file', { type: known.file });
  if (norm.includes('/')) {
    const [major, minor] = norm.split('/');
    return tr.t('mailWhen.attach.file', { type: minor === '*' ? (major ?? norm) : norm });
  }
  return tr.t('mailWhen.attach.file', { type: norm.toUpperCase() });
}

function formatAttachmentTypes(types: readonly string[], tr: CoreTranslator): string {
  const english = tr.language === 'en';
  const phrases = [
    ...new Set(types.slice(0, 3).map((t) => (english ? attachmentPhrase(t) : attachmentPhraseIn(tr, t)))),
  ];
  if (phrases.length === 1) return phrases[0] as string;
  // Share a leading article where possible: “a PDF or CSV” reads more naturally than “a PDF or a CSV”. Only English
  // and Dutch phrases are drawn here, so their articles are the ones to share.
  const bare = phrases.map((p, i) => (i === 0 ? p : p.replace(english ? /^an?\s+/ : /^een\s+/, '')));
  return `${listIn(tr, bare)}${types.length > 3 ? '…' : ''}`;
}

/** “a, b or c” in a locale. */
function listIn(tr: CoreTranslator, parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return tr.t('recipe.or', { items: parts.slice(0, -1).join(', '), last: parts.at(-1) ?? '' });
}

function displayFrom(from: string): string {
  const norm = normalizeMailFrom(from);
  return norm ? norm.value : from.trim().replace(/^@/, '');
}

/**
 * Plain-English description of when a mail trigger runs:
 * “When mail from example.com with a PDF arrives in your inbox”, “When mail with “invoice” in the subject and a PDF
 * arrives in your inbox”, “When mail arrives in you@example.com’s inbox”.
 */
export function mailWhenText(
  trigger: Pick<MailTrigger, 'from' | 'subjectContains' | 'hasAttachment' | 'attachmentTypes'>,
  mailbox?: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const fromPart = trigger.from ? tr.t('mailWhen.from', { from: displayFrom(trigger.from) }) : null;
  const subjectPart = trigger.subjectContains?.length
    ? tr.t('mailWhen.subject', {
        words: `${listIn(
          tr,
          trigger.subjectContains.slice(0, 3).map((w) => `“${w}”`),
        )}${trigger.subjectContains.length > 3 ? '…' : ''}`,
      })
    : null;
  const attachPart = trigger.attachmentTypes?.length
    ? formatAttachmentTypes(trigger.attachmentTypes, tr)
    : trigger.hasAttachment
      ? tr.t('mailWhen.attach.any')
      : null;
  const withParts = [subjectPart, attachPart].filter((p): p is string => !!p);
  const withClause = withParts.length
    ? tr.t('mailWhen.with', {
        parts:
          withParts.length === 2
            ? tr.t('recipe.and', { items: withParts[0] ?? '', last: withParts[1] ?? '' })
            : (withParts[0] ?? ''),
      })
    : null;
  const hasFilters = Boolean(fromPart || withClause);
  const core = [tr.t('mailWhen.mail'), fromPart, withClause].filter(Boolean).join(' ');
  if (!hasFilters && mailbox) return tr.t('mailWhen.mailbox', { mailbox });
  return tr.t('mailWhen.inbox', { mail: core });
}

/** Detail line under `whenLine` naming which mailbox is watched (“In you@example.com”). */
export function mailTriggerDetail(mailbox?: string, locale?: string | null): string | null {
  return mailbox ? coreTranslator(locale).t('mailWhen.detail', { mailbox }) : null;
}

/** Default name for a mail recipe when the person hasn't given one (“Handle mail from example.com”). */
export function mailRecipeName(
  trigger: Pick<MailTrigger, 'from' | 'subjectContains' | 'hasAttachment' | 'attachmentTypes'>,
  mailbox?: string,
): string {
  if (trigger.from) return `Handle mail from ${displayFrom(trigger.from)}`;
  if (trigger.subjectContains?.[0]) return `Handle “${trigger.subjectContains[0]}” mail`;
  if (mailbox) return `Handle mail in ${mailbox}`;
  return 'Handle incoming mail';
}

/** Short plain-English reason why a mail attachment couldn't be handed over to an automation run. */
export function missingAttachmentReasonText(
  reason: MissingMailAttachmentReason,
  locale?: string | null,
): string {
  return tCore(locale, `mailMissing.reason.${reason}`);
}

/** Notice for mail attachments that didn't come along with a run (for the run page and summaries). */
export function missingAttachmentsText(
  missing: readonly MissingMailAttachment[],
  omittedCount = 0,
  maxListed = 10,
  locale?: string | null,
): string {
  const omitted = Math.max(0, Math.trunc(omittedCount));
  const limit = Math.max(1, Math.trunc(maxListed));
  if (missing.length === 0 && omitted === 0) return '';
  if (missing.length === 0) return tpCore(locale, 'mailMissing.omitted', omitted);
  const items = missing.slice(0, limit).map((m) =>
    tCore(locale, 'mailMissing.item', {
      name: m.name,
      reason: missingAttachmentReasonText(m.reason, locale),
    }),
  );
  const more = Math.max(0, missing.length - limit) + omitted;
  if (missing.length === 1 && more === 0) return tCore(locale, 'mailMissing.one', { item: items[0] ?? '' });
  return more > 0
    ? tCore(locale, 'mailMissing.manyMore', { items: items.join(', '), more })
    : tCore(locale, 'mailMissing.many', { items: items.join(', ') });
}
