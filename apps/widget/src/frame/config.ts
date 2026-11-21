/**
 * The frame's view of `GET /embed/v1/sites/:site/config` (`FeedbackPublicConfig` of `@whombat/core`). Checked by
 * hand so the frame bundle stays free of Zod; a wrong shape counts as “not available”. Values only a newer server
 * sends are read tolerantly (AP-262, updates.md UP-B3b): report types and attachment types this widget doesn't know
 * are left out (no type left: not available), an unknown theme is `auto`, position `bottom-right`, launcher `custom`
 * (the widget adds no button of its own) and contact field `optional`. A drop-mode card is verified before this.
 */
import type { ReportType, Theme } from '../shared/protocol';

export type ContactField = 'off' | 'optional';
export type AttachmentType = 'image/png' | 'image/jpeg';

export interface PublicConfig {
  productLabel: string;
  reportTypes: ReportType[];
  theme: Theme;
  position: 'bottom-right' | 'bottom-left';
  launcher: 'floating' | 'custom';
  launcherLabel: string;
  privacyUrl: string | null;
  contactFields: { name: ContactField; email: ContactField };
  attachments: { max: number; maxBytes: number; types: AttachmentType[] };
  text: { description: number; expected: number; steps: number };
  redactPaths: string[];
  contextKeys: string[];
  /** The frame may send the navigation trail (CT-161). False when absent: an older server. */
  trail: boolean;
  /** The frame may offer reporter sign-in (CT-162). False when absent: an older server. */
  reporters: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown, min: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const contact = (v: unknown): v is ContactField => v === 'off' || v === 'optional';
const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T => values.includes(v as T);

/** The config, or null when it doesn't have the shape the widget needs. */
export function parseConfig(value: unknown): PublicConfig | null {
  if (!isObj(value)) return null;
  const { productLabel, reportTypes, theme, position, launcher, launcherLabel, privacyUrl } = value;
  const { contactFields, attachments, text, redactPaths, contextKeys } = value;
  if (!isStr(productLabel) || !isStr(launcherLabel)) return null;
  if (!Array.isArray(reportTypes) || !reportTypes.every(isStr)) return null;
  const types = [...new Set(reportTypes)].filter((t) => t === 'bug' || t === 'feature');
  if (types.length === 0) return null;
  if (!isStr(theme) || !isStr(position) || !isStr(launcher)) return null;
  if (privacyUrl !== null && !(isStr(privacyUrl) && privacyUrl.startsWith('https://'))) return null;
  if (!isObj(contactFields) || !isStr(contactFields.name) || !isStr(contactFields.email)) return null;
  if (!isObj(attachments) || !isInt(attachments.max, 0) || !isInt(attachments.maxBytes, 1)) return null;
  const attachmentTypes = attachments.types;
  if (!Array.isArray(attachmentTypes) || !attachmentTypes.every(isStr)) return null;
  if (!isObj(text) || !isInt(text.description, 1) || !isInt(text.expected, 0) || !isInt(text.steps, 0))
    return null;
  if (!strings(redactPaths) || !strings(contextKeys)) return null;
  return {
    productLabel,
    reportTypes: types as ReportType[],
    theme: oneOf(theme, ['auto', 'light', 'dark'] as const) ? theme : 'auto',
    position: oneOf(position, ['bottom-right', 'bottom-left'] as const) ? position : 'bottom-right',
    launcher: oneOf(launcher, ['floating', 'custom'] as const) ? launcher : 'custom',
    launcherLabel,
    privacyUrl,
    contactFields: {
      name: contact(contactFields.name) ? contactFields.name : 'optional',
      email: contact(contactFields.email) ? contactFields.email : 'optional',
    },
    attachments: {
      max: attachments.max,
      maxBytes: attachments.maxBytes,
      types: attachmentTypes.filter((t): t is AttachmentType => t === 'image/png' || t === 'image/jpeg'),
    },
    text: { description: text.description, expected: text.expected, steps: text.steps },
    redactPaths: [...redactPaths],
    contextKeys: [...contextKeys],
    trail: value.trail === true,
    reporters: value.reporters === true,
  };
}

/** `3 MB`, `512 KB`: how the limits are written for visitors. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = Math.round((bytes / (1024 * 1024)) * 10) / 10;
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
