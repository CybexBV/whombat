/**
 * An integration's two visitor-facing switches (docs/decisions/feedback-reporters.md FR-03, contracts CT-161, CT-162):
 * the navigation trail and reporter sign-in. Both default to `on`; settings stored before contracts 0.25 don't have
 * them and read as `on`, exactly as parsing them with the contract's defaults would.
 */
import type { FeedbackIntegrationSettings } from '@whombat/core';

type Switches = Partial<Pick<FeedbackIntegrationSettings, 'trail' | 'reporterSignIn'>>;

/** The widget may send the visitor's last page views, and the server keeps them. */
export function trailOn(settings: Switches): boolean {
  return settings.trail !== 'off';
}

/** Visitors may sign in with their email address to follow their reports. */
export function reporterSignInOn(settings: Switches): boolean {
  return settings.reporterSignIn !== 'off';
}
