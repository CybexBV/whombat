/**
 * Google connect on a managed appliance (docs/decisions/assistant-guides.md AG-14, managed-runtime.md MR-62…): the
 * redirect goes to the hosted UI's `/connect/google`, the app finishes with `connections.finishGoogle` over the
 * session — bound to the session's account — and `guides.act` runs over the session too. The fake Google completes
 * the whole flow without a real Google.
 */
import { managedGoogleRedirectUri } from '@whombat/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { messages } from '../db/schema/index';
import { IDS } from '../seed/test-world';
import { TEST_APP_URL } from '../test/harness';
import { useManagedRuntime } from '../test/managed';
import { startGuide } from './commands';

const m = useManagedRuntime({ seed: true, env: { WHOMBAT_GOOGLE: 'fake' } });

type Answer = {
  t: string;
  output?: Record<string, unknown>;
  code?: string;
  details?: Record<string, unknown>;
};

let mara: Awaited<ReturnType<typeof m.enroll>>;

beforeAll(async () => {
  mara = await m.enroll(IDS.mara);
});

describe('Google connect on a managed appliance (AG-14)', () => {
  it('redirects to the hosted UI and finishes over the session, ', async () => {
    const c = await m.client(mara);
    const status = (await c.request('connectors.status', { params: {} })) as Answer;
    expect(status.output?.google).toMatchObject({
      setup: { redirectUri: managedGoogleRedirectUri(TEST_APP_URL), authorizedDomain: 'whombat.test' },
    });

    const start = (await c.request('connections.startGoogle', {
      params: {},
      body: { services: ['mail'], returnTo: '/burrow-hq/settings?tab=connections' },
    })) as Answer;
    expect(start.t).toBe('result');
    const url = new URL(String(start.output?.authorizeUrl));
    expect(`${url.origin}${url.pathname}`).toBe(`${TEST_APP_URL}/connect/google`);
    const body = { code: url.searchParams.get('code'), state: url.searchParams.get('state') };

    const own = (await c.request('connections.finishGoogle', { params: {}, body })) as Answer;
    expect(own).toMatchObject({
      t: 'result',
      output: { returnPath: '/burrow-hq/settings?tab=connections&connected=google' },
    });
  });

  it('answers guide cards over the session', async () => {
    // The welcome in Mara's Chat with the agent (her seeded one has messages already, so it isn't posted by itself).
    const started = await m.t.services.pipeline.commit(
      startGuide,
      { topic: 'welcome' },
      { burrowId: m.t.burrowId, actorId: IDS.dusty, onBehalfOf: { principalId: IDS.mara } },
    );
    expect(started.status).toBe('ok');
    const [welcome] = await m.t.services.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, IDS.dmDusty), sql`${messages.card}->>'kind' = 'guide'`))
      .orderBy(desc(messages.ord))
      .limit(1);
    expect(welcome?.card).toMatchObject({ kind: 'guide', guide: 'welcome', state: 'open' });
    const c = await m.client(mara);
    const answered = (await c.request('guides.act', {
      params: { burrow: 'burrow-hq', messageId: welcome?.id },
      body: { actionId: 'later' },
    })) as Answer;
    expect(answered).toMatchObject({ t: 'result', output: { ok: true } });
    const again = (await c.request('guides.act', {
      params: { burrow: 'burrow-hq', messageId: welcome?.id },
      body: { actionId: 'later' },
    })) as Answer;
    expect(again).toMatchObject({ t: 'error', code: 'conflict', details: { code: 'guide_closed' } });
  });
});
