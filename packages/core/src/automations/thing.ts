import type { ThingTrigger } from '../domain/automation.js';
import { catalogEntry } from '../domain/connections-catalog.js';
import { THING_BACK, THING_DOWN, type ThingIncidentEvent } from '../domain/incidents.js';

export interface ThingTriggerFacts {
  kind: 'thing';
  event: ThingTrigger['event'];
  incident: ThingIncidentEvent;
}

export function thingTriggerFacts(type: string, incident: ThingIncidentEvent): ThingTriggerFacts {
  return {
    kind: 'thing',
    event: type === THING_BACK ? 'back' : type === THING_DOWN ? 'down' : 'problem',
    incident,
  };
}

export function thingTriggerMatches(trigger: ThingTrigger, { event, incident }: ThingTriggerFacts): boolean {
  if (trigger.event !== event || incident.cause || (trigger.check && trigger.check !== incident.check))
    return false;
  if (trigger.thing) return trigger.thing === incident.thing;
  return (
    trigger.kinds?.some(
      (kind) =>
        kind === incident.kind ||
        (incident.kind === 'connection' && kind === `connection:${incident.catalogId}`),
    ) ?? false
  );
}

/** The first matching trigger due on this incident. A later transition may move a waiting run earlier. */
export function thingTriggerDueAt(
  triggers: readonly ThingTrigger[],
  facts: ThingTriggerFacts,
): number | null {
  const delays = triggers.filter((t) => thingTriggerMatches(t, facts)).map((t) => t.forMinutes ?? 0);
  if (!delays.length) return null;
  return Date.parse(facts.incident.startedAt) + Math.min(...delays) * 60_000;
}

/**
 * The checks a delayed start still needs at its deadline, from the triggers due first: each one's own check, else the
 * check that opened or worsened the incident. A start goes on while any of them still counts on the thing. Empty when
 * one of those triggers names none and the incident has none either: there is nothing more to ask.
 */
export function thingTriggerChecks(triggers: readonly ThingTrigger[], facts: ThingTriggerFacts): string[] {
  const matching = triggers.filter((t) => thingTriggerMatches(t, facts));
  if (!matching.length) return [];
  const first = Math.min(...matching.map((t) => t.forMinutes ?? 0));
  const checks = matching
    .filter((t) => (t.forMinutes ?? 0) === first)
    .map((t) => t.check ?? facts.incident.check ?? null);
  return checks.some((c) => c === null) ? [] : [...new Set(checks as string[])];
}

function kindName(kind: string): string {
  if (kind === 'server') return 'a server';
  if (kind === 'device') return 'a device';
  const catalogId = kind.split(':')[1];
  const entry = catalogId ? catalogEntry(catalogId) : null;
  return entry ? `a ${entry.name} connection` : 'a connection';
}

export function thingWhenText(trigger: ThingTrigger): string {
  const kinds = trigger.kinds?.map(kindName) ?? [];
  const target = trigger.name ?? (kinds.length ? kinds.join(' or ') : 'a watched thing');
  const check = trigger.check && trigger.checkName ? `“${trigger.checkName}”` : null;
  const change =
    trigger.event === 'back' ? 'comes back' : trigger.event === 'down' ? 'goes down' : 'has a problem';
  if (!trigger.forMinutes)
    return `When ${target} ${trigger.event === 'problem' && check ? `reports ${check}` : change}`;
  const duration = `${trigger.forMinutes} ${trigger.forMinutes === 1 ? 'minute' : 'minutes'}`;
  if (trigger.event === 'down') return `When ${target} has been down for ${duration}`;
  return `When ${target} has been ${check ? `reporting ${check}` : 'having a problem'} for ${duration}`;
}

export function thingTriggerSummary({ event, incident }: ThingTriggerFacts): string {
  if (event === 'back') return `${incident.name} is back`;
  if (event === 'down') return `${incident.name} is down`;
  return `${incident.name} · ${incident.words}`;
}
