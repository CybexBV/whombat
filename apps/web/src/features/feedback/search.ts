/** The feedback pages' search params: the router reads them without loading the pages' chunk (WE-01). */
import type { SettingsStep } from './steps';

/** `?step=` of the new-integration page: the settings step shown (Name & site without one). */
export interface FeedbackNewSearch {
  step?: Exclude<SettingsStep, 'site'>;
}
export function validateFeedbackNewSearch(raw: Record<string, unknown>): FeedbackNewSearch {
  return raw.step === 'reports' || raw.step === 'widget' ? { step: raw.step } : {};
}

/** `?step=install` on an integration's page: the stepper's last step, right after Create. */
export interface FeedbackIntegrationSearch {
  step?: 'install';
}
export function validateFeedbackIntegrationSearch(raw: Record<string, unknown>): FeedbackIntegrationSearch {
  return raw.step === 'install' ? { step: 'install' } : {};
}
