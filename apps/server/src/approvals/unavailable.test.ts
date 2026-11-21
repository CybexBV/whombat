/** What Whombat can't carry out is refused in words the agent can act on, and a yes never reads as done (EA-02, EA-03). */
import type { Approval, ApprovalActionType } from '@whombat/core';
import { approval as seeded } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { executedText } from './engine';
import { nothingHappened, notPerformable, unavailableAction } from './unavailable';

const registry = (...types: ApprovalActionType[]) => ({
  hasExecutor: (t: ApprovalActionType) => types.includes(t),
});
const REFUND = {
  type: 'refund',
  params: { accountId: '3310', amountCents: 2400, currency: 'EUR' },
} as const;
const DEPLOY = {
  type: 'deploy',
  params: { environment: 'staging', service: 'billing-api', ref: 'feat/x', sha: null },
} as const;

describe('unavailableAction', () => {
  it('refuses what has no executor, with what to do instead', () => {
    expect(unavailableAction(REFUND, registry())).toBe(
      'Whombat can’t issue refunds here: no payment system is connected. Ask a person to do it, and say what exactly.',
    );
    expect(unavailableAction(DEPLOY, registry())).toMatch(
      /^perform_action can’t deploy here: Whombat has no deploy workflow for this repository\. That is only one way: deploy the way the project is deployed/,
    );
    // It points the agent at its own commands, never at tools it isn't served.
    expect(unavailableAction(DEPLOY, registry())).not.toMatch(/ssh_upload|ssh_exec/);
    expect(
      unavailableAction({ type: 'message_external', params: { to: 'a@b.test', body: 'hi' } }, registry()),
    ).toMatch(/^Whombat can’t send messages outside this Whombat here/);
    // A configured deploy workflow (or anything with an executor) is fine.
    expect(unavailableAction(DEPLOY, registry('deploy'))).toBeNull();
  });

  it('perform_action runs no push and no custom action', () => {
    expect(
      notPerformable({ type: 'push_shared_branch', params: { repo: 'o/r', branch: 'release', sha: 'abcd' } }),
    ).toMatch(/^Pushes aren’t actions/);
    expect(notPerformable({ type: 'custom', params: { name: 'Run CI', keyId: 'ci.run', data: {} } })).toBe(
      'Whombat has nothing to run for “Run CI”. If you hold its key, do it yourself; if it needs a person’s yes, ask with request_approval.',
    );
  });

  it('an approved request nobody can carry out says nothing happened', () => {
    expect(nothingHappened(REFUND)).toBe(
      'no payment system is connected to Whombat, so no refund was issued.',
    );
    expect(nothingHappened(DEPLOY)).toBe(
      'no deploy workflow is set up on this Whombat, so nothing was deployed.',
    );
  });
});

describe('executedText', () => {
  const approval = (action: Approval['action'], title = 'x'): Approval => ({ ...seeded, action, title });

  it('a custom yes is a person’s agreement, never “done”; a push yes is an allowance, never “Pushed”', () => {
    expect(
      executedText(
        approval({ type: 'custom', params: { name: 'rotate', keyId: 'ci.run', data: {} } }, 'Rotate the key'),
        {
          approver: 'Mara',
        },
      ),
    ).toBe('Mara approved: Rotate the key');
    expect(
      executedText(
        approval({
          type: 'push_shared_branch',
          params: { repo: 'o/r', branch: 'release/2.1', sha: 'c0ffee12' },
        }),
        { requester: 'Dusty' },
      ),
    ).toBe('Allowed Dusty to push release/2.1');
  });
});
