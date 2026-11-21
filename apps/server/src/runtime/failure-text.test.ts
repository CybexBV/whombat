import { TURN_FAILURE_REASON_MAX } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { claudeExtraUsageText } from './failure-text';

describe('Claude’s third-party extra-usage refusal', () => {
  it.each([null, 'Fusebox', 'A gateway with a very long name '.repeat(4)])(
    'explains billing and the action within the card’s limit (%s)',
    (gateway) => {
      const { reason, text } = claudeExtraUsageText(gateway);
      expect(reason.length).toBeLessThanOrEqual(TURN_FAILURE_REASON_MAX);
      expect(reason).toContain('paid extra usage');
      expect(text).toContain('third-party apps');
      expect(text).toContain('separate from plan limits');
      expect(text).toContain('claude.ai/settings/usage');
      expect(text).toContain('Try again');
      if (gateway) expect(text).toContain(gateway);
      expect(text).not.toMatch(/malformed|\/new|\/model|hermes doctor|resets|few minutes/);
    },
  );
});
