/**
 * Arriving and leaving automations on a Find My connection (docs/implementation/macos/findmy-connection.md): the
 * trigger, what its signed event tells triggers, whether it fires, and its words on rows, tiles and plan cards.
 */
import { describe, expect, it } from 'vitest';
import { MCP_TOOLS } from '../contracts/mcp.js';
import { EVENT_TYPES } from '../domain/audit.js';
import {
  AutomationDefinition,
  AutomationSource,
  AutomationTrigger,
  AutomationTriggerInfo,
  TRIGGER_KIND_LABELS,
} from '../domain/automation.js';
import { FIND_MY_PLACE_CHANGED } from '../domain/hosts-findmy.js';
import { AUTOMATION_AUTHORING_GUIDE } from './authoring.js';
import {
  type FindMyTriggerFacts,
  findMyTriggerFacts,
  findMyTriggerMatches,
  findMyWhenText,
} from './findmy.js';
import { automationGlance } from './glance.js';
import { triggerMatches } from './match.js';
import { definitionGrants, planSections } from './plan.js';
import { definitionProblems, triggerSummary } from './validate.js';

const CON = 'con_findmy01';
const MARA = '0123456789ab';
const home = {
  kind: 'findmy',
  connectionId: CON,
  person: MARA,
  name: 'Mara Visser',
  change: 'arrives',
  place: 'Home',
} as const;
const leavesHome = { ...home, change: 'leaves' } as const;

const facts = (from: string | null, to: string | null, more: Partial<FindMyTriggerFacts> = {}) => ({
  kind: 'findmy' as const,
  connectionId: CON,
  person: MARA,
  from,
  to,
  ...more,
});

describe('the findmy trigger', () => {
  it('names a connection, a person by id, a change and Find My’s place words', () => {
    expect(AutomationTrigger.parse(home)).toEqual(home);
    const { name: _, ...withoutName } = home;
    expect(AutomationTrigger.safeParse(withoutName).success).toBe(true);
    expect(AutomationTrigger.safeParse({ ...home, person: 'Mara Visser' }).success).toBe(false);
    expect(AutomationTrigger.safeParse({ ...home, change: 'stays' }).success).toBe(false);
    expect(AutomationTrigger.safeParse({ ...home, place: '' }).success).toBe(false);
    expect(AutomationTrigger.safeParse({ ...home, place: 'x'.repeat(201) }).success).toBe(false);
    expect(AutomationTrigger.safeParse({ ...home, connectionId: 'studio' }).success).toBe(false);
    // Strict, as every trigger: nothing a definition carries is silently ignored.
    expect(AutomationTrigger.safeParse({ ...home, street: 'Damrak 1' }).success).toBe(false);
  });

  it('is a source, a run’s trigger kind and a kind with a label', () => {
    expect(AutomationSource.parse('findmy')).toBe('findmy');
    expect(
      AutomationTriggerInfo.safeParse({
        kind: 'findmy',
        summary: 'Mara Visser is now at Home',
        actorId: null,
        eventId: null,
        messageId: null,
        scheduledFor: null,
      }).success,
    ).toBe(true);
    expect(TRIGGER_KIND_LABELS.findmy).toBeTruthy();
    expect(EVENT_TYPES[FIND_MY_PLACE_CHANGED]).toBe('System');
  });

  it('makes a definition that tells the person', () => {
    const def = AutomationDefinition.parse({
      version: 1,
      conversationId: 'cnv_chat',
      triggers: [home],
      steps: [{ id: 'tell', kind: 'post_message', text: '{{trigger.text}}' }],
    });
    expect(definitionProblems(def)).toEqual([]);
  });
});

describe('when a change of place fires it', () => {
  it('arrives: the place now and not before, without case or spaces', () => {
    expect(triggerMatches(home, facts('Lelystad', 'Home'))).toBe(true);
    expect(triggerMatches(home, facts('Lelystad', ' home '))).toBe(true);
    expect(triggerMatches({ ...home, place: 'Den Haag' }, facts('Home', 'DEN  HAAG'))).toBe(true);
    // Back from no place at all is arriving too.
    expect(triggerMatches(home, facts(null, 'Home'))).toBe(true);
    expect(triggerMatches(home, facts('Home', 'Lelystad'))).toBe(false);
    expect(triggerMatches(home, facts('home', 'Home'))).toBe(false);
  });

  it('leaves: the place before and another place now', () => {
    expect(triggerMatches(leavesHome, facts('Home', 'Lelystad'))).toBe(true);
    expect(triggerMatches(leavesHome, facts('HOME', 'Work'))).toBe(true);
    expect(triggerMatches(leavesHome, facts('Lelystad', 'Home'))).toBe(false);
    expect(triggerMatches(leavesHome, facts(null, 'Lelystad'))).toBe(false);
  });

  it('never for someone Find My has no place for now', () => {
    expect(triggerMatches(leavesHome, facts('Home', null))).toBe(false);
    expect(triggerMatches(home, facts('Lelystad', null))).toBe(false);
  });

  it('only for its own connection and person, and no other kind of event', () => {
    expect(triggerMatches(home, facts('Lelystad', 'Home', { connectionId: 'con_findmy02' }))).toBe(false);
    expect(triggerMatches(home, facts('Lelystad', 'Home', { person: 'ba9876543210' }))).toBe(false);
    expect(triggerMatches(home, { kind: 'reaction', conversationId: 'cnv_chat', value: '🏠' })).toBe(false);
    expect(findMyTriggerMatches(home, facts('Work', 'Home'))).toBe(true);
  });

  it('reads the signed event’s payload', () => {
    const event = { connectionId: CON, person: MARA, name: 'Mara Visser', from: 'Lelystad', to: 'Home' };
    expect(findMyTriggerFacts(event)).toEqual(facts('Lelystad', 'Home'));
    expect(triggerMatches(home, findMyTriggerFacts(event))).toBe(true);
  });
});

describe('its words', () => {
  const names = {
    agent: 'Dusty',
    conversationTitle: (id: string) => (id === 'cnv_chat' ? 'Chat' : undefined),
    connectionLabel: (id: string) => (id === CON ? 'Find My · Studio' : undefined),
  };
  const def = AutomationDefinition.parse({
    version: 1,
    conversationId: 'cnv_chat',
    triggers: [home],
    steps: [{ id: 'tell', kind: 'post_message', text: '{{trigger.text}}' }],
  });

  it('say who arrives or leaves where', () => {
    expect(findMyWhenText(home)).toBe('When Mara Visser arrives at Home');
    expect(findMyWhenText(leavesHome)).toBe('When Mara Visser leaves Home');
    expect(findMyWhenText({ change: 'arrives', place: 'Home' })).toBe('When someone arrives at Home');
  });

  it('on a row, a tile and a plan card', () => {
    expect(triggerSummary(def.triggers, names.conversationTitle, names.connectionLabel)).toBe(
      'When Mara Visser arrives at Home',
    );
    expect(automationGlance(def, names)).toMatchObject({
      source: 'findmy',
      trigger: 'When Mara Visser arrives at Home',
    });
    const when = planSections(def, definitionGrants(def), names).find((s) => s.id === 'when')?.lines[0];
    expect(when).toEqual({ text: 'When Mara Visser arrives at Home', detail: 'On Find My · Studio' });
  });

  it('are in the agent’s guide and automation_read', () => {
    expect(AUTOMATION_AUTHORING_GUIDE).toContain('kind:"findmy"');
    expect(AUTOMATION_AUTHORING_GUIDE).toContain('findMyPeople');
    expect(
      MCP_TOOLS.automation_read.output.safeParse({
        findMyPeople: [{ connectionId: CON, person: MARA, name: 'Mara Visser', place: 'Home' }],
      }).success,
    ).toBe(true);
  });
});
