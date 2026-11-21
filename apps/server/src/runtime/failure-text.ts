/** Plain words for Claude's third-party billing refusal; the provider's technical text stays in the details. */
import { TURN_FAILURE_REASON_MAX } from '@whombat/core';

export function claudeExtraUsageText(gateway: string | null): { reason: string; text: string } {
  const via = gateway ? ` through ${gateway}` : '';
  const reason = `Claude requires paid extra usage${via}. Check the Claude account’s usage settings, then press Try again.`;
  return {
    reason:
      reason.length <= TURN_FAILURE_REASON_MAX
        ? reason
        : 'Claude requires paid extra usage for third-party requests. Check the Claude account’s usage settings, then press Try again.',
    text: `Claude refused my request${via}: it says third-party apps now use paid extra usage, separate from plan limits. Check the Claude account at claude.ai/settings/usage, then press Try again.`,
  };
}
