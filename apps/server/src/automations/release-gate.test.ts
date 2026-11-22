import type { UpdateFacts } from '@whombat/control-contracts/local';
import { describe, expect, it } from 'vitest';
import {
  ACTION_AUTOMATIONS_LATER,
  laterWords,
  MAIL_AUTOMATIONS_LATER,
  NewerAutomationsGate,
  newerDefinition,
  newerRun,
  rollbackTarget,
} from './release-gate';

const OLD = 'whombat-20261121.4';
const ME = 'whombat-20261122.1';
const NEXT = 'whombat-20261123.2';

const facts = (over: Partial<UpdateFacts>): UpdateFacts => ({
  state: 'Healthy',
  current: ME,
  candidate: null,
  lastCheckedAt: null,
  deferredReason: null,
  failure: null,
  ...over,
});

/** `runtime_releases` holding `known`, counting the reads. */
function releases(known: string[]) {
  const reads = { n: 0 };
  const lookup = async (id: string) => {
    reads.n++;
    return known.includes(id);
  };
  return { lookup, reads };
}

describe('rollbackTarget', () => {
  it('is the current release while this one is being tried', () => {
    expect(rollbackTarget(facts({ state: 'Verifying', current: OLD, candidate: ME }), ME)).toEqual({
      kind: 'release',
      id: OLD,
    });
  });

  it('is the release the last update came from once this one is current', () => {
    const lastUpdate = { release: ME, from: OLD, at: '2026-11-22T06:00:00Z' };
    expect(rollbackTarget(facts({ lastUpdate }), ME)).toEqual({ kind: 'release', id: OLD });
    // A newer release being staged meanwhile doesn't change where this one goes back to.
    expect(rollbackTarget(facts({ lastUpdate, candidate: NEXT }), ME)).toEqual({ kind: 'release', id: OLD });
  });

  it('is nothing on a box that never updated', () => {
    expect(rollbackTarget(facts({}), ME)).toEqual({ kind: 'none' });
    expect(
      rollbackTarget(facts({ lastUpdate: { release: ME, from: null, at: '2026-11-22T06:00:00Z' } }), ME),
    ).toEqual({ kind: 'none' });
  });

  it('is unknown without facts, without the release’s own id, or after it came back another way', () => {
    expect(rollbackTarget(null, ME)).toEqual({ kind: 'unknown' });
    expect(rollbackTarget(facts({}), null)).toEqual({ kind: 'unknown' });
    // Back after a failed update of the next release, or a fallback at boot: the last update isn't its own.
    const lastUpdate = { release: NEXT, from: ME, at: '2026-11-22T06:00:00Z' };
    expect(rollbackTarget(facts({ lastUpdate }), ME)).toEqual({ kind: 'unknown' });
    expect(rollbackTarget(facts({ current: OLD }), ME)).toEqual({ kind: 'unknown' });
  });
});

describe('NewerAutomationsGate', () => {
  const production = { NODE_ENV: 'production' as const, WHOMBAT_RELEASE_ID: ME };

  it('is on in development and tests, whatever the facts', async () => {
    const { lookup } = releases([]);
    expect(await new NewerAutomationsGate({ NODE_ENV: 'development' }, lookup).ready()).toBe(true);
    expect(await new NewerAutomationsGate({ NODE_ENV: 'test' }, lookup).ready()).toBe(true);
  });

  it('is off on a box updated from a release that doesn’t know them, on once it would go back to one that does', async () => {
    const { lookup, reads } = releases([ME]);
    const gate = new NewerAutomationsGate(production, lookup);
    // No facts yet from the manager.
    expect(await gate.ready()).toBe(false);
    let update = facts({ lastUpdate: { release: ME, from: OLD, at: '2026-11-22T06:00:00Z' } });
    gate.follow(() => update);
    expect(await gate.ready()).toBe(false);
    // The next release, being tried and then current, goes back to this one, which recorded itself.
    const next = new NewerAutomationsGate({ ...production, WHOMBAT_RELEASE_ID: NEXT }, lookup);
    next.follow(() => update);
    update = facts({ state: 'Verifying', current: ME, candidate: NEXT });
    expect(await next.ready()).toBe(true);
    update = facts({ current: NEXT, lastUpdate: { release: NEXT, from: ME, at: '2026-11-23T06:00:00Z' } });
    expect(await next.ready()).toBe(true);
    // A recorded release is read once.
    const before = reads.n;
    expect(await next.ready()).toBe(true);
    expect(reads.n).toBe(before);
    // Back on this release after the next one failed: they wait again.
    update = facts({ current: ME, lastUpdate: { release: NEXT, from: ME, at: '2026-11-23T06:00:00Z' } });
    expect(await gate.ready()).toBe(false);
  });

  it('is on on a box with nothing to go back to', async () => {
    const { lookup } = releases([]);
    const gate = new NewerAutomationsGate(production, lookup);
    gate.follow(() => facts({}));
    expect(await gate.ready()).toBe(true);
  });

  it('refuses a newer definition with the person’s line while off, and lets the rest through', async () => {
    const { lookup } = releases([]);
    const gate = new NewerAutomationsGate(production, lookup);
    const mail = { triggers: [{ kind: 'mail', connectionId: 'con_1' }], steps: [] };
    await expect(gate.refuse(mail)).rejects.toThrow(MAIL_AUTOMATIONS_LATER);
    await expect(gate.refuse({ triggers: [{ kind: 'manual' }], steps: [] })).resolves.toBeUndefined();
    await expect(gate.refuse(null)).resolves.toBeUndefined();
  });
});

describe('newer definitions', () => {
  it('are the ones started by mail and the ones that change connected services', () => {
    const steps = [{ id: 'ask', kind: 'dispatch_agent', prompt: 'x' }];
    expect(newerDefinition({ triggers: [{ kind: 'mail' }], steps })).toBe(true);
    expect(newerDefinition({ recipe: { when: { kind: 'mail' } }, triggers: [], steps })).toBe(true);
    expect(newerDefinition({ triggers: [{ kind: 'manual' }], steps: [{ kind: 'connection_actions' }] })).toBe(
      true,
    );
    expect(
      newerDefinition({
        triggers: [{ kind: 'manual' }],
        steps: [{ kind: 'dispatch_agent', proposeActions: true }],
      }),
    ).toBe(true);
    expect(newerDefinition({ triggers: [{ kind: 'manual' }], steps })).toBe(false);
    // A draft that isn't valid yet counts by what it says.
    expect(newerDefinition({ triggers: 'mail' })).toBe(false);
    expect(newerDefinition('mail')).toBe(false);
    expect(newerRun({ trigger: { kind: 'mail' }, definition: { triggers: [], steps } })).toBe(true);
    expect(newerRun({ trigger: { kind: 'manual' }, definition: { triggers: [], steps } })).toBe(false);
  });

  it('are refused with the words that fit them', () => {
    expect(laterWords({ triggers: [{ kind: 'mail' }] })).toBe(MAIL_AUTOMATIONS_LATER);
    expect(laterWords({ triggers: [{ kind: 'manual' }], steps: [{ kind: 'connection_actions' }] })).toBe(
      ACTION_AUTOMATIONS_LATER,
    );
  });
});
