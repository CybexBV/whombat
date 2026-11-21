/**
 * The Hermes homes through the runner (hermes-engine.md HE-38, HE-S110), over real HTTP: the server's steps reach the
 * runner's worker on the runner routes (runner token, checked against the server's runtime tokens) and come back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestServer } from '../test/harness';
import { startTestRunner, type TestRunner } from '../test/runner';
import { type HermesHomeCallError, hermesHome } from './service';

const t = useTestServer({ seed: true, listen: true });
let runner: TestRunner;

beforeAll(async () => {
  runner = await startTestRunner(t.baseUrl);
});

afterAll(async () => {
  await runner?.stop();
});

describe('the Hermes-home service over the runner API', () => {
  it('writes and reads a person’s memory file, and says why a step was refused', async () => {
    const home = hermesHome(t.services);
    const written = await home.call('memory.write', { file: 'user', entries: ['Mara'] });
    expect(written.entries).toEqual(['Mara']);
    expect((await home.call('memory.read', {})).user.entries).toEqual(['Mara']);
    const err = await home
      .call('memory.write', { file: 'user', entries: ['x'.repeat(1_400)] })
      .catch((e: unknown) => e);
    expect((err as HermesHomeCallError).code).toBe('too_long');
    expect(home.runnerSeen).toBe(true);
  });
});
