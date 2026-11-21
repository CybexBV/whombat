/**
 * Security review part 1, session slots (M-4 appliance part; docs/decisions/managed-runtime.md MR-28): the review's
 * "F-session-exhaustion" PoC inverted. Unenrolled keys share a small cap and close when they don't enroll in time;
 * enrolled endpoints keep their own capacity. The idle timeout is shortened for the test.
 */
import { describe, expect, it } from 'vitest';
import { IDS } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { MAX_UNENROLLED_SESSIONS } from './session/registry';
import { TestSessionClient, testIdentity } from './testing';

const IDLE_MS = 400;
const m = useManagedRuntime({ seed: true, sessions: { unenrolledIdleMs: IDLE_MS } });

/** A raw session client (no harness eviction), after its hello. */
async function raw(identity = testIdentity()) {
  const c = new TestSessionClient(m.runtime, identity);
  const first = await c.hello();
  return { c, first };
}

describe('session slots', () => {
  it('M-4: unenrolled keys can hold only a few slots; enrolled endpoints still connect', async () => {
    const held = [];
    for (let i = 0; i < MAX_UNENROLLED_SESSIONS; i++) {
      const { c, first } = await raw();
      expect(first.t).toBe('welcome');
      held.push(c);
    }
    const extra = await raw();
    expect(extra.first).toMatchObject({ t: 'error', code: 'too_many' });
    expect(await extra.c.closed).toBe('overload');
    expect(m.runtime.sessions.unenrolledSize).toBe(MAX_UNENROLLED_SESSIONS);
    expect(m.runtime.sessions.full).toBe(false);
    // A person's enrolled device is unaffected.
    const mara = await m.enroll(IDS.mara);
    const { first } = await raw(mara);
    expect(first).toMatchObject({ t: 'welcome', channel: 'app' });
    for (const c of held) c.close();
    await Promise.all(held.map((c) => c.closed));
  });

  it('M-4: an unenrolled session closes when it makes no enrollment request in time; a request keeps it open', async () => {
    const { c: idle } = await raw();
    const { c: busy } = await raw();
    const started = Date.now();
    // `busy` keeps asking (a pairing status poll would do the same); `idle` only pings.
    const poll = setInterval(() => {
      void busy.request('enroll.pair.status', { pairingId: 'pair_nothing_0001' });
      idle.send({ t: 'ping', n: 1 });
    }, IDLE_MS / 4);
    try {
      expect(await idle.closed).toBe('idle');
      expect(Date.now() - started).toBeGreaterThanOrEqual(IDLE_MS - 50);
      expect(idle.received.find((x) => x.t === 'error')).toMatchObject({ code: 'unavailable' });
      await new Promise((r) => setTimeout(r, IDLE_MS));
      expect(busy.connection.principal).not.toBeNull();
      expect(m.runtime.sessions.unenrolledSize).toBe(1);
    } finally {
      clearInterval(poll);
    }
    busy.close();
    await busy.closed;
  });

  it('M-4: a session that enrolls moves to the enrolled class and no longer times out', async () => {
    const { c } = await raw();
    const { claim: claimed } = await m.claim(c, {
      deviceId: 'dev-slots',
      name: 'Olive',
      email: 'olive-slots@example.com',
    });
    expect(claimed).toMatchObject({ t: 'result' });
    // Quiet after enrolling: promoted when its idle time is up, not closed.
    await new Promise((r) => setTimeout(r, IDLE_MS * 2));
    expect(m.runtime.sessions.unenrolledSize).toBe(0);
    expect(await Promise.race([c.closed, Promise.resolve('open')])).toBe('open');
    expect(await c.request('endpoints.list', {})).toMatchObject({ t: 'result' });
    c.close();
  });
});
