import { describe, expect, it } from 'vitest';
import { AutomationTrigger, type ThingTrigger } from '../domain/automation.js';
import { THING_BACK, THING_DOWN, THING_PROBLEM, type ThingIncidentEvent } from '../domain/incidents.js';
import { thingWatchMatches } from '../domain/thing-watch.js';
import { thingTriggerChecks, thingTriggerDueAt, thingTriggerFacts, thingTriggerMatches } from './thing.js';

const incident: ThingIncidentEvent = {
  incidentId: 'inc_1',
  thing: 'connection:con_ups',
  kind: 'connection',
  catalogId: 'nut',
  name: 'UPS',
  check: 'ups.on_battery',
  nature: 'problem',
  words: 'On battery',
  startedAt: '2026-11-24T12:00:00.000Z',
};
const trigger: ThingTrigger = { kind: 'thing', kinds: ['connection:nut'], event: 'problem', forMinutes: 10 };

describe('monitoring triggers', () => {
  it('requires exactly one target selector and permits a delay only while the incident is open', () => {
    expect(AutomationTrigger.safeParse(trigger).success).toBe(true);
    expect(AutomationTrigger.safeParse({ ...trigger, thing: incident.thing }).success).toBe(false);
    expect(AutomationTrigger.safeParse({ ...trigger, kinds: [] }).success).toBe(false);
    expect(AutomationTrigger.safeParse({ ...trigger, event: 'back' }).success).toBe(false);
  });

  it('matches the event, thing or catalog, and optionally the check', () => {
    const facts = thingTriggerFacts(THING_PROBLEM, incident);
    expect(thingTriggerMatches(trigger, facts)).toBe(true);
    expect(thingTriggerMatches({ ...trigger, kinds: ['server', 'connection:plex'] }, facts)).toBe(false);
    expect(
      thingTriggerMatches(
        { kind: 'thing', thing: incident.thing, event: 'problem', check: incident.check },
        facts,
      ),
    ).toBe(true);
    expect(thingTriggerMatches({ ...trigger, check: 'ups.offline' }, facts)).toBe(false);
    expect(thingTriggerMatches(trigger, thingTriggerFacts(THING_DOWN, incident))).toBe(false);
  });

  it('uses the shortest matching delay from the incident’s start and ignores a dependent thing', () => {
    const facts = thingTriggerFacts(THING_PROBLEM, incident);
    expect(thingTriggerDueAt([trigger], facts)).toBe(Date.parse('2026-11-24T12:10:00.000Z'));
    expect(thingTriggerDueAt([trigger, { ...trigger, forMinutes: 3 }], facts)).toBe(
      Date.parse('2026-11-24T12:03:00.000Z'),
    );
    const dependent = { ...incident, cause: { thing: 'server:nas', name: 'NAS' } };
    expect(thingTriggerDueAt([trigger], thingTriggerFacts(THING_PROBLEM, dependent))).toBeNull();
  });

  it('waits on the trigger’s own check, else the one that started the incident', () => {
    const facts = thingTriggerFacts(THING_PROBLEM, incident);
    expect(thingTriggerChecks([trigger], facts)).toEqual(['ups.on_battery']);
    const named = { ...trigger, forMinutes: 5, check: 'ups.on_battery' };
    expect(thingTriggerChecks([named, { ...trigger, kinds: ['server'], forMinutes: 1 }], facts)).toEqual([
      'ups.on_battery',
    ]);
    const { check: _check, ...unnamed } = incident;
    expect(thingTriggerChecks([trigger], thingTriggerFacts(THING_PROBLEM, unnamed))).toEqual([]);
    expect(thingTriggerChecks([{ ...trigger, kinds: ['server'] }], facts)).toEqual([]);
  });
});

describe('one-time monitoring watches', () => {
  it('matches the same thing and event only when it has no cause', () => {
    const back = { thing: incident.thing, event: 'back' } as const;
    const down = { ...back, event: 'down' } as const;
    expect(thingWatchMatches(back, THING_BACK, incident)).toBe(true);
    expect(thingWatchMatches(back, THING_DOWN, incident)).toBe(false);
    expect(thingWatchMatches(down, THING_PROBLEM, incident)).toBe(false);
    expect(thingWatchMatches(down, THING_DOWN, incident)).toBe(true);
    expect(thingWatchMatches({ ...down, thing: 'connection:con_other' }, THING_DOWN, incident)).toBe(false);
    expect(
      thingWatchMatches(down, THING_DOWN, { ...incident, cause: { thing: 'server:nas', name: 'NAS' } }),
    ).toBe(false);
  });
});
