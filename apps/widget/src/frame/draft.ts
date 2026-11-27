/**
 * The report a visitor is writing: validation against the site's limits and the exact submission body
 * (`FeedbackSubmission` of `@whombat/core`), including the context after the integration's own rules (FB-07).
 * “Steps to reproduce” left the form with the navigation trail (AP-428): the body always sends `steps: ''`.
 */
import {
  cleanText,
  sanitizeCustomContext,
  sanitizePageUrl,
  sanitizeReferences,
} from '@whombat/core/feedback/sanitize';
import { english, type WidgetTranslator } from '../i18n/catalog';
import type { ReportType, TrailStep, WidgetContext } from '../shared/protocol';
import { formatBytes, type PublicConfig } from './config';

/** `FEEDBACK_TEXT_LIMITS` of `@whombat/core` for the fields the config doesn't carry. */
export const CONTACT_LIMITS = { name: 120, email: 254 } as const;
/** `FeedbackSubmissionAttachment.name` max. */
export const ATTACHMENT_NAME_MAX = 120;

export interface DraftFile {
  /** Local key for the list (never sent). */
  key: string;
  name: string;
  type: string;
  size: number;
  blob: Blob;
}

export interface DraftValues {
  type: ReportType;
  description: string;
  expected: string;
  name: string;
  email: string;
  files: DraftFile[];
}

/** Field keys as the server names them (`FeedbackPublicError.fields`), `attachments.<i>` per screenshot. */
export type FieldKey =
  | 'type'
  | 'description'
  | 'expected'
  | 'name'
  | 'email'
  | 'attachments'
  | `attachments.${number}`;
export type FieldErrors = Partial<Record<FieldKey, string>>;

export function emptyDraft(type: ReportType): DraftValues {
  return { type, description: '', expected: '', name: '', email: '', files: [] };
}

// Deliberately loose (the server validates properly): something@something.tld, no spaces.
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Why a chosen file can't be added (type, size), or null. */
export function fileProblem(
  file: { name: string; type: string; size: number },
  config: PublicConfig,
  words: WidgetTranslator = english,
): string | null {
  const name = displayName(file.name, words.t('screenshotFileName'));
  if (!(config.attachments.types as string[]).includes(file.type)) return words.t('imageType', { name });
  if (file.size > config.attachments.maxBytes)
    return words.t('imageSize', { name, size: formatBytes(config.attachments.maxBytes, words.locale) });
  if (file.size === 0) return words.t('imageEmpty', { name });
  return null;
}

/** A file name fit for the report: printable, at most 120 characters, never empty. */
export function displayName(name: string, fallback = 'screenshot'): string {
  const clean = cleanText(name.replace(/[/\\]/g, '_'), ATTACHMENT_NAME_MAX);
  return clean || fallback;
}

export function tooManyFiles(config: PublicConfig, words: WidgetTranslator = english): string {
  const max = config.attachments.max;
  return words.tp('imageCount', max, { count: max.toLocaleString(words.locale) });
}

/**
 * Every problem the visitor can fix before sending, by field. Signed in, the email field is gone (the session's
 * address is sent).
 */
export function validateDraft(
  values: DraftValues,
  config: PublicConfig,
  signedIn = false,
  words: WidgetTranslator = english,
): FieldErrors {
  const errors: FieldErrors = {};
  const shorten = (max: number) => words.tp('textTooLong', max, { count: max.toLocaleString(words.locale) });
  if (!config.reportTypes.includes(values.type)) errors.type = words.t('chooseKind');
  const description = values.description.trim();
  if (!description) errors.description = words.t(values.type === 'bug' ? 'describeProblem' : 'describeIdea');
  else if (description.length > config.text.description)
    errors.description = shorten(config.text.description);
  if (values.type === 'bug' && values.expected.trim().length > config.text.expected)
    errors.expected = shorten(config.text.expected);
  if (config.contactFields.name === 'optional' && values.name.trim().length > CONTACT_LIMITS.name)
    errors.name = words.t('nameTooLong', { max: CONTACT_LIMITS.name });
  if (config.contactFields.email === 'optional' && !signedIn) {
    const email = values.email.trim();
    if (email && (email.length > CONTACT_LIMITS.email || !EMAIL.test(email)))
      errors.email = words.t('optionalEmailInvalid');
  }
  if (values.files.length > config.attachments.max) errors.attachments = tooManyFiles(config, words);
  values.files.forEach((file, i) => {
    const problem = fileProblem(file, config, words);
    if (problem) errors[`attachments.${i}`] = problem;
  });
  return errors;
}

export interface SubmissionContext {
  page: { url: string; title: string | null } | null;
  browser: WidgetContext['browser'];
  app: WidgetContext['app'];
  custom: WidgetContext['custom'];
  references: string[];
  sentAt: string | null;
  /** The pages visited before reporting (only when the config says `trail: true`). */
  trail?: TrailStep[];
}

/**
 * The context exactly as it will be sent: the site's redact rules and custom-key allowlist applied again, and with
 * `config.trail` the loader's page views with the redact rules applied to each (a step whose address doesn't
 * sanitize is left out). Without `config.trail`, no trail.
 */
export function submissionContext(
  context: WidgetContext | null,
  config: PublicConfig,
  sentAt: string | null = null,
): SubmissionContext {
  const url = context?.page ? sanitizePageUrl(context.page.url, config.redactPaths) : null;
  const out: SubmissionContext = {
    page: url && context?.page ? { url, title: context.page.title } : null,
    browser: context?.browser ?? null,
    app: context?.app ?? null,
    custom: sanitizeCustomContext(context?.custom ?? {}, config.contextKeys),
    references: sanitizeReferences(context?.references ?? []),
    sentAt,
  };
  if (config.trail && context?.trail)
    out.trail = context.trail.flatMap((step) => {
      const stepUrl = sanitizePageUrl(step.url, config.redactPaths);
      return stepUrl ? [{ url: stepUrl, title: step.title, at: step.at }] : [];
    });
  return out;
}

/**
 * What makes a draft this draft (R1-2): its text, type and contact fields, the signed-in address, and its files (by
 * their local key). A retry with the same key resends the body already built; context updates alone don't change it.
 */
export function draftKey(values: DraftValues, signedInEmail: string | null = null): string {
  return JSON.stringify([
    values.type,
    values.description,
    values.expected,
    values.name,
    values.email,
    signedInEmail,
    values.files.map((f) => f.key),
  ]);
}

export interface SubmissionAttachment {
  name: string;
  contentType: 'image/png' | 'image/jpeg';
  data: string;
}

export interface SubmissionBody {
  submissionId: string;
  parentOrigin: string;
  type: ReportType;
  description: string;
  expected: string;
  steps: string;
  reporter: { name: string; email: string };
  context: SubmissionContext;
  attachments: SubmissionAttachment[];
}

export function buildSubmission(input: {
  submissionId: string;
  parentOrigin: string;
  values: DraftValues;
  context: WidgetContext | null;
  config: PublicConfig;
  attachments: SubmissionAttachment[];
  sentAt: string;
  /** Signed in (CT-162): the session's address is the reporter's email, whatever the email field says. */
  signedInEmail?: string | null;
}): SubmissionBody {
  const { values, config } = input;
  const bug = values.type === 'bug';
  return {
    submissionId: input.submissionId,
    parentOrigin: input.parentOrigin,
    type: values.type,
    description: values.description.trim(),
    expected: bug ? values.expected.trim() : '',
    steps: '',
    reporter: {
      name: config.contactFields.name === 'optional' ? values.name.trim() : '',
      email: input.signedInEmail ?? (config.contactFields.email === 'optional' ? values.email.trim() : ''),
    },
    context: submissionContext(input.context, config, input.sentAt),
    attachments: input.attachments,
  };
}

/** A file's bytes as base64 (no `data:` prefix). */
export function fileToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const url = String(reader.result ?? '');
      const comma = url.indexOf(',');
      resolve(comma >= 0 ? url.slice(comma + 1) : '');
    };
    reader.readAsDataURL(blob);
  });
}

/** One “What will be sent” row. */
export interface PreviewRow {
  label: string;
  value: string;
}

/** The context and screenshots the report will carry, in plain words (the “What will be sent” list). */
export function previewRows(
  context: SubmissionContext,
  files: readonly DraftFile[],
  { t }: WidgetTranslator = english,
): PreviewRow[] {
  const rows: PreviewRow[] = [];
  if (context.page) {
    rows.push({ label: t('page'), value: context.page.url });
    if (context.page.title) rows.push({ label: t('pageTitle'), value: context.page.title });
  }
  const b = context.browser;
  if (b) {
    rows.push({ label: t('browser'), value: b.name });
    if (b.language) rows.push({ label: t('language'), value: b.language });
    if (b.viewport) rows.push({ label: t('window'), value: `${b.viewport.width}×${b.viewport.height}` });
    if (b.timeZone) rows.push({ label: t('timeZone'), value: b.timeZone });
  }
  const a = context.app;
  if (a && (a.version || a.environment || a.build)) {
    const parts = [
      a.version && t('version', { version: a.version }),
      a.environment,
      a.build && t('build', { build: a.build }),
    ].filter((v): v is string => Boolean(v));
    rows.push({ label: t('app'), value: parts.join(' · ') });
  }
  for (const [key, value] of Object.entries(context.custom))
    rows.push({ label: key, value: value === null ? '—' : String(value) });
  if (context.references.length) rows.push({ label: t('references'), value: context.references.join(', ') });
  if (files.length)
    rows.push({
      label: t('screenshots'),
      value: files.map((f) => displayName(f.name, t('screenshotFileName'))).join(', '),
    });
  return rows;
}
