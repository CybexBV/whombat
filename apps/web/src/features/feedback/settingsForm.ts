/**
 * The integration editor's form model (Settings → Feedback): strings as the fields hold them, turned into
 * `FeedbackIntegrationSettings` input and validated with the same Zod schema the server uses, so the form
 * shows exactly the problems the server would refuse. Server field errors (`settings.allowedOrigins.1`) map
 * onto the same fields. Pure.
 */
import {
  type Agent,
  DEFAULT_FEEDBACK_LIMITS,
  type FeedbackContactField,
  FeedbackIntegrationSettings,
  type FeedbackIntegrationSettingsInput,
  type FeedbackLauncher,
  FeedbackLimits,
  type FeedbackPosition,
  type FeedbackReportType,
  type FeedbackSwitch,
  type FeedbackTheme,
} from '@whombat/core/domain';
import { normalizeOrigin } from '@whombat/core/feedback';

export type LimitKey = keyof FeedbackLimits;

/** The limits in the order the form shows them. */
export const LIMIT_KEYS: readonly LimitKey[] = [
  'reportsPerHour',
  'reportsPerDay',
  'perSourcePerHour',
  'maxAttachments',
  'maxAttachmentBytes',
  'assessmentsPerDay',
  'maxConcurrentAssessments',
  'assessmentTimeoutMinutes',
];

/** Attachment size is edited in KB; every other limit as the schema holds it. */
const KB = 1024;
const scaleOf = (key: LimitKey) => (key === 'maxAttachmentBytes' ? KB : 1);

/** A limit's bounds and default, in the unit the form shows (from `FeedbackLimits`). */
export function limitBounds(key: LimitKey): { min: number; max: number; fallback: number } {
  const schema = FeedbackLimits.shape[key].unwrap();
  const scale = scaleOf(key);
  return {
    min: Math.ceil((schema.minValue ?? 0) / scale),
    max: Math.floor((schema.maxValue ?? Number.MAX_SAFE_INTEGER) / scale),
    fallback: DEFAULT_FEEDBACK_LIMITS[key] / scale,
  };
}

export interface SettingsForm {
  name: string;
  productLabel: string;
  /** One origin per line. */
  origins: string;
  /** '' = no repository. */
  repoId: string;
  projectContext: string;
  types: Record<FeedbackReportType, boolean>;
  theme: FeedbackTheme;
  position: FeedbackPosition;
  launcher: FeedbackLauncher;
  launcherLabel: string;
  privacyUrl: string;
  contactName: FeedbackContactField;
  contactEmail: FeedbackContactField;
  /** One template per line. */
  redactPaths: string;
  /** One key per line. */
  contextKeys: string;
  limits: Record<LimitKey, string>;
  retention: 'off' | 'days';
  retentionDays: string;
  /** Pages visited (CT-161). Shown only on runtimes with `feedback.reporters`; older ones strip it. */
  trail: FeedbackSwitch;
  /** Reporter sign-in (CT-162); as `trail`. */
  reporterSignIn: FeedbackSwitch;
}

export const DEFAULT_RETENTION_DAYS = 90;

function limitsForm(limits: FeedbackLimits): Record<LimitKey, string> {
  return Object.fromEntries(LIMIT_KEYS.map((k) => [k, String(limits[k] / scaleOf(k))])) as Record<
    LimitKey,
    string
  >;
}

/** A new integration: the schema's defaults, bug reports and feature requests. */
export function emptyForm(): SettingsForm {
  return {
    name: '',
    productLabel: '',
    origins: '',
    repoId: '',
    projectContext: '',
    types: { bug: true, feature: true },
    theme: 'auto',
    position: 'bottom-right',
    launcher: 'floating',
    launcherLabel: 'Feedback',
    privacyUrl: '',
    contactName: 'optional',
    contactEmail: 'optional',
    redactPaths: '',
    contextKeys: '',
    limits: limitsForm(DEFAULT_FEEDBACK_LIMITS),
    retention: 'off',
    retentionDays: String(DEFAULT_RETENTION_DAYS),
    trail: 'on',
    reporterSignIn: 'on',
  };
}

/** The form for an existing integration's settings. */
export function formOf(s: FeedbackIntegrationSettings): SettingsForm {
  return {
    name: s.name,
    productLabel: s.productLabel,
    origins: s.allowedOrigins.join('\n'),
    repoId: s.repoId ?? '',
    projectContext: s.projectContext,
    types: { bug: s.reportTypes.includes('bug'), feature: s.reportTypes.includes('feature') },
    theme: s.theme,
    position: s.position,
    launcher: s.launcher,
    launcherLabel: s.launcherLabel,
    privacyUrl: s.privacyUrl ?? '',
    contactName: s.contactFields.name,
    contactEmail: s.contactFields.email,
    redactPaths: s.redactPaths.join('\n'),
    contextKeys: s.contextKeys.join('\n'),
    limits: limitsForm(s.limits),
    retention: s.retentionDays === null ? 'off' : 'days',
    retentionDays: String(s.retentionDays ?? DEFAULT_RETENTION_DAYS),
    trail: s.trail,
    reporterSignIn: s.reporterSignIn,
  };
}

/** Non-empty trimmed lines. */
export function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** `''` → NaN, so an emptied number field is refused rather than read as 0. */
function num(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

/**
 * How the form is sent (feedback-chat.md AP-1830; one-agent.md AP-4935, AP-4936): never with a channel — reports come
 * to your Feedback — and whether the agent builds the fix once you say yes (`handoff`): off while it
 * can't assess read-only (`assessorProblem`).
 */
export interface SettingsInputOptions {
  handoff?: 'on' | 'off';
}

/** The settings the form describes, before validation (AP-1830, AP-4935). */
export function settingsInput(
  form: SettingsForm,
  options: SettingsInputOptions = {},
): FeedbackIntegrationSettingsInput {
  const reportTypes = (['bug', 'feature'] as const).filter((t) => form.types[t]);
  return {
    name: form.name,
    productLabel: form.productLabel,
    allowedOrigins: lines(form.origins),
    repoId: form.repoId || null,
    projectContext: form.projectContext.trim(),
    reportTypes,
    theme: form.theme,
    position: form.position,
    launcher: form.launcher,
    launcherLabel: form.launcherLabel,
    privacyUrl: form.privacyUrl.trim() || null,
    contactFields: { name: form.contactName, email: form.contactEmail },
    redactPaths: lines(form.redactPaths),
    contextKeys: lines(form.contextKeys),
    limits: Object.fromEntries(
      LIMIT_KEYS.map((k) => [k, num(form.limits[k]) * scaleOf(k)]),
    ) as FeedbackLimits,
    retentionDays: form.retention === 'off' ? null : num(form.retentionDays),
    handoff: options.handoff ?? 'on',
    trail: form.trail,
    reporterSignIn: form.reporterSignIn,
  };
}

/** Fields that show errors. Limits are `limits.<key>`. */
export type FieldKey =
  | 'name'
  | 'productLabel'
  | 'allowedOrigins'
  | 'agentId'
  | 'repoId'
  | 'projectContext'
  | 'reportTypes'
  | 'theme'
  | 'position'
  | 'launcher'
  | 'launcherLabel'
  | 'privacyUrl'
  | 'contactFields'
  | 'redactPaths'
  | 'contextKeys'
  | `limits.${LimitKey}`
  | 'retentionDays'
  | 'handoffAgentId'
  | 'trail'
  | 'reporterSignIn';

export type FieldErrors = Partial<Record<FieldKey, string[]>>;

const LIST_FIELDS = new Set(['allowedOrigins', 'redactPaths', 'contextKeys']);

/** What a refused field says, in the form's words (Zod's generic messages are replaced). */
const PLAIN: Partial<Record<FieldKey, string>> = {
  name: 'Give the integration a name (at most 80 characters).',
  productLabel: 'Say what visitors know the product as (at most 60 characters).',
  allowedOrigins: 'Add at least one origin, at most 20.',
  agentId: 'Your agent can’t assess these reports.',
  repoId: 'Choose a repository from the list.',
  projectContext: 'Keep the project context under 4000 characters.',
  reportTypes: 'Choose at least one kind of report.',
  launcherLabel: 'Give the button a label (at most 40 characters).',
  privacyUrl: 'Use a full https:// address.',
  redactPaths: 'At most 20 path templates.',
  contextKeys: 'At most 20 keys.',
  retentionDays: 'Keep content between 7 and 3650 days.',
  handoffAgentId: 'Your agent can’t build fixes for these reports.',
};

function keyOf(path: readonly PropertyKey[]): FieldKey | null {
  const [head, second] = path.map(String);
  if (!head) return null;
  if (head === 'limits' && second) return `limits.${second as LimitKey}`;
  return head as FieldKey;
}

function plainOf(key: FieldKey): string | undefined {
  if (key.startsWith('limits.')) {
    const { min, max } = limitBounds(key.slice('limits.'.length) as LimitKey);
    return `Between ${min} and ${max}.`;
  }
  return PLAIN[key];
}

function add(errors: FieldErrors, key: FieldKey, message: string) {
  const list = errors[key] ?? [];
  if (!list.includes(message)) errors[key] = [...list, message];
}

/**
 * Maps issues (Zod's, or the server's `fields`) onto form fields. A list entry's problem names the entry:
 * `“ftp://x”: Use an exact origin …`.
 */
export function errorsOf(
  issues: readonly { path: readonly PropertyKey[]; message: string; code?: string }[],
  input: FeedbackIntegrationSettingsInput,
): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = keyOf(issue.path);
    if (!key) continue;
    const index = issue.path[1];
    if (LIST_FIELDS.has(key) && index !== undefined && /^\d+$/.test(String(index))) {
      const list = (input as Record<string, unknown>)[key] as string[] | undefined;
      const value = list?.[Number(index)];
      add(errors, key, value === undefined ? issue.message : `“${value}”: ${issue.message}`);
      continue;
    }
    add(errors, key, (issue.code !== undefined && issue.code !== 'custom' && plainOf(key)) || issue.message);
  }
  return errors;
}

/** The server's `fields` (`settings.allowedOrigins.1` or `allowedOrigins.1`) as form errors. */
export function serverErrors(
  fields: Record<string, string[]>,
  input: FeedbackIntegrationSettingsInput,
): FieldErrors {
  const issues = Object.entries(fields).flatMap(([path, messages]) => {
    const parts = path.split('.').filter(Boolean);
    const rest = parts[0] === 'settings' ? parts.slice(1) : parts;
    return messages.map((message) => ({ path: rest, message }));
  });
  return errorsOf(issues, input);
}

export type Validation =
  | { ok: true; settings: FeedbackIntegrationSettings }
  | { ok: false; errors: FieldErrors };

/** Validates the form with the server's schema. */
export function validateForm(form: SettingsForm, options: SettingsInputOptions = {}): Validation {
  const input = settingsInput(form, options);
  const parsed = FeedbackIntegrationSettings.safeParse(input);
  if (parsed.success) return { ok: true, settings: parsed.data };
  return { ok: false, errors: errorsOf(parsed.error.issues, input) };
}

/** Live check of the origins field, line by line: the canonical origin, or null when it isn't one. */
export function originLines(text: string): { line: string; origin: string | null }[] {
  return lines(text).map((line) => ({ line, origin: normalizeOrigin(line) }));
}

/**
 * Why the agent can't assess reports (FB-18, FB-A03; one-agent.md AP-4935), or null when it can: Claude Code or ChatGPT,
 * which Whombat keeps read-only (Whombat hermes-engine.md HE-36; a model on the network isn't one of them,
 * hermes-engine-app.md AP-5045) — the same rule the server applies (`feedback/rules.ts`).
 */
export function assessorProblem(agent: Pick<Agent, 'runtime'>): string | null {
  if (agent.runtime.provider !== 'claude' && agent.runtime.provider !== 'codex')
    return 'needs Claude Code or ChatGPT';
  return null;
}
