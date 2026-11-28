import type { UpdateFacts } from '@whombat/control-contracts/local';
import { describe, expect, it } from 'vitest';
import {
  ACTION_AUTOMATIONS_LATER,
  BEFORE_FIRST_RELEASE,
  DIRECT_AUTOMATIONS_LATER,
  DIRECT_SCHEMA,
  FIND_MY_AUTOMATIONS_LATER,
  FIND_MY_SCHEMA,
  laterWords,
  MAIL_AUTOMATIONS_LATER,
  NewerAutomationsGate,
  newerDefinition,
  newerRun,
  rollbackTarget,
  schemaKnowsDirect,
  schemaKnowsFindMy,
  schemaKnowsThings,
  THING_AUTOMATIONS_LATER,
  THING_SCHEMA,
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

  it('is nothing for a runtime no update helper started: it names no release, and no manager rolls it back', () => {
    expect(rollbackTarget(null, null)).toEqual({ kind: 'none' });
    expect(
      rollbackTarget(facts({ lastUpdate: { release: ME, from: OLD, at: '2026-11-22T06:00:00Z' } }), null),
    ).toEqual({ kind: 'none' });
  });

  it('is unknown without facts, before the box’s release was recorded, or after it came back another way', () => {
    expect(rollbackTarget(null, ME)).toEqual({ kind: 'unknown' });
    // Started before the update helper recorded the box's release: it is restarted with its own id once it did.
    expect(rollbackTarget(facts({}), BEFORE_FIRST_RELEASE)).toEqual({ kind: 'unknown' });
    expect(rollbackTarget(null, BEFORE_FIRST_RELEASE)).toEqual({ kind: 'unknown' });
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
    // A production runtime no update helper started never hears the manager's update facts, and is on all the same.
    expect(await new NewerAutomationsGate({ NODE_ENV: 'production' }, lookup).ready()).toBe(true);
    expect(
      await new NewerAutomationsGate({ NODE_ENV: 'production', WHOMBAT_RELEASE_ID: ' ' }, lookup).ready(),
    ).toBe(true);
  });

  it('waits on a runtime started before the box’s release was recorded', async () => {
    const { lookup } = releases([]);
    const gate = new NewerAutomationsGate(
      { NODE_ENV: 'production', WHOMBAT_RELEASE_ID: BEFORE_FIRST_RELEASE },
      lookup,
    );
    expect(await gate.ready()).toBe(false);
    gate.follow(() => facts({}));
    expect(await gate.ready()).toBe(false);
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

describe('Find My automations', () => {
  const production = { NODE_ENV: 'production' as const, WHOMBAT_RELEASE_ID: NEXT };
  const findmy = { triggers: [{ kind: 'findmy', connectionId: 'con_findmy01' }], steps: [] };
  const schemas = (bySchema: Record<string, string | null>) => async (id: string) => bySchema[id] ?? null;

  it('are newer definitions and runs, refused with their own words', () => {
    expect(newerDefinition(findmy)).toBe(true);
    expect(newerDefinition({ recipe: { when: { kind: 'findmy' } }, triggers: [], steps: [] })).toBe(true);
    expect(newerRun({ trigger: { kind: 'findmy' }, definition: { triggers: [], steps: [] } })).toBe(true);
    expect(laterWords(findmy)).toBe(FIND_MY_AUTOMATIONS_LATER);
  });

  it('wait until the release a box would go back to recorded a schema that runs them', async () => {
    const { lookup } = releases([ME]);
    const update = facts({
      current: NEXT,
      lastUpdate: { release: NEXT, from: ME, at: '2026-11-23T06:00:00Z' },
    });
    // The release before them recorded itself, with an older schema: mail automations go on, Find My's wait.
    const before = new NewerAutomationsGate(production, lookup, schemas({ [ME]: '0015_runtime_releases' }));
    before.follow(() => update);
    expect(await before.ready()).toBe(true);
    expect(await before.findMyReady()).toBe(false);
    await expect(before.refuse(findmy)).rejects.toThrow(FIND_MY_AUTOMATIONS_LATER);
    expect(await before.holdsRun({ trigger: { kind: 'findmy' }, definition: findmy })).toBe(true);
    expect(
      await before.holdsRun({ trigger: { kind: 'mail' }, definition: { triggers: [], steps: [] } }),
    ).toBe(false);
    // One with it, or a later one.
    for (const schema of [FIND_MY_SCHEMA, '0017_later']) {
      const after = new NewerAutomationsGate(production, lookup, schemas({ [ME]: schema }));
      after.follow(() => update);
      expect(await after.findMyReady()).toBe(true);
      await expect(after.refuse(findmy)).resolves.toBeUndefined();
    }
    expect(schemaKnowsFindMy(null)).toBe(false);
    // Development boxes and tests have them.
    expect(await new NewerAutomationsGate({ NODE_ENV: 'test' }, lookup).findMyReady()).toBe(true);
  });
});

describe('automations started by something going down or coming back', () => {
  const production = { NODE_ENV: 'production' as const, WHOMBAT_RELEASE_ID: NEXT };
  const thing = {
    triggers: [{ kind: 'thing', event: 'problem', thing: 'server:nas', forMinutes: 10 }],
    steps: [{ id: 'off', kind: 'connection_actions' }],
  };
  const run = { trigger: { kind: 'thing' }, definition: thing };
  const schemas = (bySchema: Record<string, string | null>) => async (id: string) => bySchema[id] ?? null;
  const update = facts({
    current: NEXT,
    lastUpdate: { release: NEXT, from: ME, at: '2026-11-24T06:00:00Z' },
  });

  it('are newer definitions and runs, refused with their own words', () => {
    expect(newerDefinition({ triggers: thing.triggers, steps: [] })).toBe(true);
    expect(newerDefinition({ recipe: { when: { kind: 'thing' } }, triggers: [], steps: [] })).toBe(true);
    expect(newerRun({ trigger: { kind: 'thing' }, definition: { triggers: [], steps: [] } })).toBe(true);
    expect(laterWords({ triggers: thing.triggers, steps: [] })).toBe(THING_AUTOMATIONS_LATER);
  });

  it('wait, and hold a run they started, until the release a box would go back to knows them', async () => {
    const { lookup } = releases([ME]);
    // Updated from a release before them: it can't read the definition, so none is made and no run goes on.
    const before = new NewerAutomationsGate(production, lookup, schemas({ [ME]: '0026_quiet_windows' }));
    before.follow(() => update);
    expect(await before.ready()).toBe(true);
    expect(await before.findMyReady()).toBe(true);
    expect(await before.thingsReady()).toBe(false);
    await expect(before.refuse({ triggers: thing.triggers, steps: [] })).rejects.toThrow(
      THING_AUTOMATIONS_LATER,
    );
    expect(await before.holdsRun(run)).toBe(true);
    for (const schema of [THING_SCHEMA, '0028_later']) {
      const after = new NewerAutomationsGate(production, lookup, schemas({ [ME]: schema }));
      after.follow(() => update);
      expect(await after.thingsReady()).toBe(true);
      expect(await after.holdsRun(run)).toBe(false);
      await expect(after.refuse({ triggers: thing.triggers, steps: [] })).resolves.toBeUndefined();
    }
    expect(schemaKnowsThings(null)).toBe(false);
    expect(await new NewerAutomationsGate({ NODE_ENV: 'test' }, lookup).thingsReady()).toBe(true);
  });
});

describe('automations that act without AI or start on Home Assistant or Protect', () => {
  const production = { NODE_ENV: 'production' as const, WHOMBAT_RELEASE_ID: NEXT };
  const powerCut = {
    triggers: [{ kind: 'thing', event: 'problem', thing: 'server:nas', check: 'host.ups.on_battery' }],
    steps: [{ id: 'off', kind: 'run_action', thing: 'server:nas', action: 'shut_down' }],
  };
  const doorbell = {
    triggers: [{ kind: 'protect', connectionId: 'con_protect0001', event: 'ring' }],
    steps: [{ id: 'tell', kind: 'post_message', text: 'Someone rang.' }],
  };
  const schemas = (bySchema: Record<string, string | null>) => async (id: string) => bySchema[id] ?? null;
  const update = facts({
    current: NEXT,
    lastUpdate: { release: NEXT, from: ME, at: '2026-11-28T06:00:00Z' },
  });

  it('are newer definitions and runs, refused with their own words', () => {
    expect(newerDefinition(powerCut)).toBe(true);
    expect(newerDefinition(doorbell)).toBe(true);
    expect(newerRun({ trigger: { kind: 'home_state' }, definition: { triggers: [], steps: [] } })).toBe(true);
    expect(laterWords(powerCut)).toBe(DIRECT_AUTOMATIONS_LATER);
    expect(laterWords(doorbell)).toBe(DIRECT_AUTOMATIONS_LATER);
  });

  it('wait, and hold a run they started, until the release a box would go back to knows them', async () => {
    const { lookup } = releases([ME]);
    const before = new NewerAutomationsGate(production, lookup, schemas({ [ME]: THING_SCHEMA }));
    before.follow(() => update);
    expect(await before.thingsReady()).toBe(true);
    expect(await before.directReady()).toBe(false);
    await expect(before.refuse(doorbell)).rejects.toThrow(DIRECT_AUTOMATIONS_LATER);
    expect(await before.holdsRun({ trigger: { kind: 'thing' }, definition: powerCut })).toBe(true);
    expect(
      await before.holdsRun({ trigger: { kind: 'protect' }, definition: { triggers: [], steps: [] } }),
    ).toBe(true);
    for (const schema of [DIRECT_SCHEMA, '0045_later']) {
      const after = new NewerAutomationsGate(production, lookup, schemas({ [ME]: schema }));
      after.follow(() => update);
      expect(await after.directReady()).toBe(true);
      expect(await after.holdsRun({ trigger: { kind: 'thing' }, definition: powerCut })).toBe(false);
      await expect(after.refuse(doorbell)).resolves.toBeUndefined();
    }
    expect(schemaKnowsDirect(null)).toBe(false);
    expect(await new NewerAutomationsGate({ NODE_ENV: 'test' }, lookup).directReady()).toBe(true);
  });
});
