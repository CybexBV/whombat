/** Type-level checks of the generated callers (enforced by `tsc`, the runtime part is trivial). */
import type { Bootstrap, RunDetail, SendMessageResponse } from '@whombat/core';
import { describe, expectTypeOf, it } from 'vitest';
import { queryKeys } from '../query/keys';
import { fakeClient } from '../test/session';
import type { CommitResult } from './types';

describe('client types', () => {
  const client = fakeClient(async () => new Response('{}'));

  it('reads resolve to their data, mutations to a CommitResult', () => {
    expectTypeOf(client.runs.get).returns.resolves.toEqualTypeOf<RunDetail>();
    expectTypeOf(client.conversations.bootstrap).returns.resolves.toEqualTypeOf<Bootstrap>();
    expectTypeOf(client.messages.send).returns.resolves.toEqualTypeOf<CommitResult<SendMessageResponse>>();
  });

  it('requires exactly the inputs the endpoint needs', () => {
    const calls = () => {
      void client.health.get();
      void client.runs.get({ params: { burrow: 'burrow-hq', number: 1907 } });
      void client.runs.list({ params: { burrow: 'burrow-hq' } });
      // @ts-expect-error params are required
      void client.runs.get();
      // @ts-expect-error the body is required
      void client.messages.send({ params: { burrow: 'burrow-hq', conversationId: 'cnv_x' } });
      // @ts-expect-error unknown body field
      void client.approvals.decide({ params: { burrow: 'b', number: 1 }, body: { decision: 'maybe' } });
    };
    expectTypeOf(calls).toBeFunction();
  });

  it('query keys carry the response type', () => {
    const key = queryKeys.runs.get({ params: { burrow: 'burrow-hq', number: 1907 } });
    expectTypeOf(key).toHaveProperty(1);
    // @ts-expect-error mutations have no query key
    void queryKeys.messages.send;
  });
});
