/**
 * The integration page's steps (docs/decisions/ui-improvements.md AP-400…): which settings each step holds, which
 * problems belong to it and where a refused Create sends the person back to. The edit page shows the same sections
 * without the stepper. Pure.
 */
import type { FieldErrors, FieldKey } from './settingsForm';

export type StepKey = 'site' | 'reports' | 'widget' | 'install';
/** The steps before Create (Install comes after, where the integration exists). */
export type SettingsStep = Exclude<StepKey, 'install'>;

export interface StepInfo {
  key: StepKey;
  title: string;
  hint: string;
}

/**
 * Where reports go names Feedback and the code it reads, never a channel (feedback-chat.md AP-1831; one-agent.md
 * AP-4936).
 */
export const STEPS: readonly StepInfo[] = [
  { key: 'site', title: 'Name & site', hint: 'What it’s called and where it runs' },
  { key: 'reports', title: 'Where reports go', hint: 'Feedback and the code it reads' },
  { key: 'widget', title: 'Widget', hint: 'How the form looks and what it asks' },
  { key: 'install', title: 'Install', hint: 'The snippet and a test report' },
];

/** The steps before Create, in order. */
export const SETTINGS_STEPS: readonly SettingsStep[] = ['site', 'reports', 'widget'];

/** Widget-step fields that live under “Privacy and limits” (opened by itself when one of them has a problem). */
const ADVANCED: ReadonlySet<string> = new Set(['redactPaths', 'contextKeys', 'retentionDays']);

const STEP_OF: Record<Exclude<FieldKey, `limits.${string}`>, SettingsStep> = {
  name: 'site',
  productLabel: 'site',
  allowedOrigins: 'site',
  agentId: 'reports',
  repoId: 'reports',
  projectContext: 'reports',
  handoffAgentId: 'reports',
  reportTypes: 'widget',
  theme: 'widget',
  position: 'widget',
  launcher: 'widget',
  launcherLabel: 'widget',
  privacyUrl: 'widget',
  contactFields: 'widget',
  trail: 'widget',
  reporterSignIn: 'widget',
  redactPaths: 'widget',
  contextKeys: 'widget',
  retentionDays: 'widget',
};

/** The step a field is on; limits are on Widget, under “Privacy and limits”. */
export function stepOf(key: FieldKey): SettingsStep {
  if (key.startsWith('limits.')) return 'widget';
  return STEP_OF[key as keyof typeof STEP_OF] ?? 'widget';
}

/** Whether a field sits under “Privacy and limits”. */
export function isAdvanced(key: FieldKey): boolean {
  return key.startsWith('limits.') || ADVANCED.has(key);
}

/** The problems of the given steps only. */
export function errorsIn(errors: FieldErrors, steps: Iterable<SettingsStep>): FieldErrors {
  const wanted = new Set(steps);
  return Object.fromEntries(
    Object.entries(errors).filter(([key]) => wanted.has(stepOf(key as FieldKey))),
  ) as FieldErrors;
}

/** The first step, in order, with a problem; null when there is none. */
export function firstStepWithErrors(errors: FieldErrors): SettingsStep | null {
  const steps = new Set(Object.keys(errors).map((k) => stepOf(k as FieldKey)));
  return SETTINGS_STEPS.find((s) => steps.has(s)) ?? null;
}

/** Whether any problem is under “Privacy and limits”. */
export function hasAdvancedErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).some((k) => isAdvanced(k as FieldKey));
}

export function stepIndex(step: StepKey): number {
  return STEPS.findIndex((s) => s.key === step);
}
