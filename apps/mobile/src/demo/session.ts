/**
 * The demo world's box (hermes-engine-app.md AP-5370): a secure session on an in-memory box (`createFakeSession`) whose
 * operations and downloads the phone's REST fixture world answers, signed in as Mara, and whose voice typing the demo's
 * speech service answers (`fixtures/voice.ts`). The demo app and the tests of the fixture world use it alike.
 */
import { createClient, type WhombatClient } from '@whombat/client';
import { createFakeSession, type RestFetch, restHandler, restResources } from '@whombat/client/fake';
import { withFakeVoice } from '@whombat/client/voice/fake';
import { FIXTURE_ORIGIN } from '../data/config';
import { demoVoiceService } from '../fixtures/voice';

/** Mara, whose Whombat it is: the account the demo box welcomes. */
export const DEMO_ACCOUNT = { id: 'acc_mara', name: 'Mara Okafor' };

/** The typed client over the demo box serving `fetch` (a fixture world, addressed on `FIXTURE_ORIGIN`). */
export function demoClient(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  options: { validateResponses?: boolean } = {},
): WhombatClient {
  const rest = fetch as RestFetch;
  const handle = restHandler(rest, { origin: FIXTURE_ORIGIN });
  const { session } = createFakeSession({
    // Voice typing's ops and recordings go to the demo's speech service (`fixtures/voice.ts`).
    ...withFakeVoice({ handle }, demoVoiceService()),
    resources: restResources(rest, FIXTURE_ORIGIN),
    account: DEMO_ACCOUNT,
    platform: 'android',
  });
  return createClient({ session, ...options });
}
