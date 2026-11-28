/**
 * Automations that act without AI (docs/decisions/direct-automations.md): the `run_action` step's allowlist and words,
 * the Home Assistant and UniFi Protect triggers, the cooldown, the UPS words and the ready-made power cut automation.
 */
import { describe, expect, it } from 'vitest';
import { MCP_TOOLS } from '../contracts/mcp.js';
import { EVENT_TYPES } from '../domain/audit.js';
import {
  AutomationDefinition,
  AutomationTrigger,
  type RunActionStep,
  TRIGGER_KIND_LABELS,
} from '../domain/automation.js';
import { AUTOMATION_AUTHORING_GUIDE } from './authoring.js';
import {
  cooldownOf,
  DIRECT_COOLDOWN_DEFAULT_MINUTES,
  DIRECT_NOT_ALLOWED,
  directActionAsksEachTime,
  directActionDetail,
  directActionProblem,
  directActionRepeatable,
  directActionText,
  directDoneLine,
  directTargetKind,
  HOME_STATE_CHANGED,
  HomeStateChanged,
  hasDirectParts,
  homeChangeSummary,
  homeStateTriggerMatches,
  homeWhenText,
  PROTECT_DETECTED,
  powerCutDefinition,
  protectEventsOf,
  protectSightingSummary,
  protectTriggerMatches,
  protectWhenText,
  UPS_ON_BATTERY_CHECK,
} from './direct.js';
import { automationGlance } from './glance.js';
import { triggerMatches } from './match.js';
import { automationFlow, definitionGrants, planSections } from './plan.js';
import { thingWhenText } from './thing.js';
import { triggerSummary, validateDefinition } from './validate.js';

const HA = 'con_homeassist1';
const PROTECT = 'con_protect0001';

const step = (more: Partial<RunActionStep>): RunActionStep => ({
  id: 'act',
  kind: 'run_action',
  thing: 'server:nas-01',
  thingName: 'nas-01',
  action: 'shut_down',
  otherwise: 'fail',
  retries: 0,
  ...more,
});

const definition = (steps: unknown[], triggers: unknown[] = [{ kind: 'manual' }]) => ({
  version: 1,
  conversationId: 'cnv_chat',
  triggers,
  steps,
});

describe('the run_action step', () => {
  it('acts on a server, one of its machines, Home Assistant or an entity', () => {
    expect(directTargetKind(step({}))).toBe('server');
    expect(directTargetKind(step({ target: '101', action: 'start' }))).toBe('machine');
    expect(directTargetKind(step({ thing: `connection:${HA}`, action: 'restart' }))).toBe('home');
    expect(directTargetKind(step({ thing: `connection:${HA}`, target: 'light.porch' }))).toBe('entity');
    expect(directTargetKind(step({ thing: 'device:printer' }))).toBeNull();
  });

  it('allows only the short list', () => {
    expect(directActionProblem(step({}))).toBeNull();
    expect(directActionProblem(step({ action: 'restart' }))).toBeNull();
    expect(directActionProblem(step({ action: 'start' }))).not.toBeNull();
    expect(directActionProblem(step({ target: '101', action: 'stop' }))).toBeNull();
    expect(directActionProblem(step({ thing: `connection:${HA}`, action: 'restart' }))).toBeNull();
    expect(directActionProblem(step({ thing: `connection:${HA}`, action: 'shut_down' }))).not.toBeNull();
    const entity = (target: string, action: RunActionStep['action'], targetName?: string) =>
      directActionProblem(
        step({ thing: `connection:${HA}`, target, action, ...(targetName ? { targetName } : {}) }),
      );
    expect(entity('light.porch', 'turn_on')).toBeNull();
    expect(entity('switch.heater', 'turn_off')).toBeNull();
    expect(entity('climate.living', 'turn_off')).not.toBeNull();
    expect(entity('not an entity', 'turn_on')).not.toBeNull();
    expect(directActionProblem(step({ thing: 'device:printer' }))).not.toBeNull();
  });

  it('never drafts a scene or a script: what is in them can’t be seen', () => {
    const home = (target: string, action: RunActionStep['action'] = 'turn_on') =>
      step({ thing: `connection:${HA}`, target, action });
    for (const target of ['scene.movie_night', 'script.good_night']) {
      expect(directActionProblem(home(target)), target).not.toBeNull();
      expect(directActionProblem(home(target), 'nl-NL'), target).not.toBe(directActionProblem(home(target)));
      expect(validateDefinition(definition([home(target)])).ok, target).toBe(false);
      expect(directActionAsksEachTime(home(target)), target).toBe(true);
    }
    expect(directActionAsksEachTime(home('light.porch'))).toBe(false);
    expect(directActionAsksEachTime(step({}))).toBe(false);
  });

  it('still runs a scene or a script an automation saved before, asking each time', () => {
    const home = (target: string, action: RunActionStep['action'] = 'turn_on') =>
      step({ thing: `connection:${HA}`, target, action });
    // An automation saved before scenes and scripts were taken out: its step may still run, with a yes each time.
    expect(directActionProblem(home('scene.movie_night'), null, { saved: true })).toBeNull();
    expect(directActionProblem(home('script.good_night'), null, { saved: true })).toBeNull();
    expect(directActionProblem(home('scene.movie_night', 'turn_off'), null, { saved: true })).not.toBeNull();
    // The safety words still refuse it.
    expect(directActionProblem(home('script.unlock_front_door'), null, { saved: true })).toMatch(/ask/);
    expect(directActionProblem(home('script.disarm_alarm'), null, { saved: true })).not.toBeNull();
    // Its page says it asks.
    expect(directActionDetail(null, home('script.good_night'))).not.toBe(
      directActionDetail(null, home('light.porch')),
    );
    expect(directActionDetail('nl-NL', home('script.good_night'))).not.toBe(
      directActionDetail(null, home('script.good_night')),
    );
    expect(directActionDetail(null, home('light.porch'))).toBe(directActionDetail());
  });

  it('never unlocks, opens or disarms, whatever it is called', () => {
    const sensitive = [
      ['lock.front_door', undefined],
      ['alarm_control_panel.house', undefined],
      ['switch.garage_opener', undefined],
      ['switch.relay_3', 'Front door'],
    ] as const;
    for (const [target, targetName] of sensitive) {
      const problem = directActionProblem(
        step({ thing: `connection:${HA}`, target, action: 'turn_on', ...(targetName ? { targetName } : {}) }),
      );
      expect(problem, target).toMatch(/ask/);
    }
    // An action that is never a step is refused in plain words before the schema's “invalid option”.
    const unlock = validateDefinition(definition([{ ...step({}), action: 'unlock' }]));
    expect(unlock.ok).toBe(false);
    expect(unlock.problems.join(' ')).toMatch(/always need you/);
    const del = validateDefinition(definition([{ ...step({}), action: 'delete_vm' }]));
    expect(del.ok).toBe(false);
  });

  it('is a valid step of a definition, and an outside one', () => {
    const ok = validateDefinition(definition([step({})]));
    expect(ok.ok).toBe(true);
    const wrong = validateDefinition(definition([step({ action: 'turn_on' })]));
    expect(wrong.ok).toBe(false);
    expect(hasDirectParts(ok.definition)).toBe(true);
    expect(hasDirectParts(definition([{ id: 'tell', kind: 'post_message', text: 'hi' }]))).toBe(false);
  });

  it('says what it does, and what it did', () => {
    expect(directActionText(step({}))).toBe('Shut down nas-01');
    expect(directActionText(step({ target: '101', targetName: 'web-01', action: 'start' }))).toContain(
      'web-01',
    );
    const porch = step({
      thing: `connection:${HA}`,
      target: 'light.porch',
      targetName: 'Porch light',
      action: 'turn_on',
    });
    expect(directActionText(porch)).toContain('Porch light');
    const done = directDoneLine(step({}), { kind: 'done', result: 'switching_off' }, '21:14');
    expect(done).toContain('nas-01');
    expect(done).toContain('21:14');
    const noop = directDoneLine(step({}), { kind: 'noop', already: 'off' }, '21:14');
    expect(noop).toContain('nas-01');
    expect(noop).not.toBe(done);
    expect(directActionText(step({}), 'nl')).not.toBe(directActionText(step({})));
  });

  it('says why it can’t be a step, and how it went, in Dutch for a Dutch reader', () => {
    const problems = [
      step({ thing: 'device:printer' }),
      step({ action: 'start' }),
      step({ thing: `connection:${HA}`, target: 'not an entity', action: 'turn_on' }),
      step({ thing: `connection:${HA}`, target: 'lock.front_door', action: 'turn_on' }),
      step({ thing: `connection:${HA}`, target: 'scene.movie_night', action: 'turn_off' }),
    ];
    for (const s of problems) {
      const en = directActionProblem(s);
      const nl = directActionProblem(s, 'nl-NL');
      expect(nl).not.toBeNull();
      expect(nl).not.toBe(en);
    }
    expect(directActionProblem(step({ action: 'start' }))).toBe(DIRECT_NOT_ALLOWED);
    const done = directDoneLine(step({}), { kind: 'done', result: 'switching_off' }, '21:14', 'nl-NL');
    expect(done).toContain('nas-01');
    expect(done).toContain('21:14');
    expect(done).toContain(' om ');
    const noop = directDoneLine(step({}), { kind: 'noop', already: 'off' }, '21:14', 'nl-NL');
    expect(noop).toContain('niets gedaan');
  });

  it('runs again after a crash only when twice comes out the same as once', () => {
    const home = (target: string, action: RunActionStep['action']) =>
      step({ thing: `connection:${HA}`, target, action });
    expect(directActionRepeatable(step({}))).toBe(true);
    expect(directActionRepeatable(step({ target: '101', action: 'stop' }))).toBe(true);
    expect(directActionRepeatable(step({ target: '101', action: 'start' }))).toBe(true);
    expect(directActionRepeatable(home('light.porch', 'turn_on'))).toBe(true);
    expect(directActionRepeatable(home('switch.heater', 'turn_off'))).toBe(true);
    expect(directActionRepeatable(step({ action: 'restart' }))).toBe(false);
    expect(directActionRepeatable(step({ target: '101', action: 'restart' }))).toBe(false);
    expect(directActionRepeatable(step({ thing: `connection:${HA}`, action: 'restart' }))).toBe(false);
    expect(directActionRepeatable(home('script.good_night', 'turn_on'))).toBe(false);
    expect(directActionRepeatable(home('scene.movie_night', 'turn_on'))).toBe(false);
  });

  it('shows on the plan card as Whombat’s own, without AI', () => {
    const def = AutomationDefinition.parse(definition([step({})]));
    const names = { agent: 'Dusty', conversationTitle: () => 'Chat' };
    const sections = planSections(def, definitionGrants(def), names);
    const does = sections.find((s) => s.id === 'does');
    expect(does?.label).toBe('WHOMBAT');
    expect(does?.lines[0]?.text).toBe('Shut down nas-01');
    expect(does?.lines[0]?.detail).toMatch(/without AI/);
    const flow = automationFlow(def, definitionGrants(def), names);
    const item = flow.find((i) => i.kind === 'step' && i.icon === 'act');
    expect(item).toBeDefined();
    expect(automationGlance(def, names).does.map((d) => d.id)).toContain('act');
    // It posts nothing in Chat unless a step says something.
    const posts = (d: AutomationDefinition) =>
      planSections(d, definitionGrants(d), names).find((s) => s.id === 'posts')?.lines[0]?.text;
    const told = AutomationDefinition.parse(
      definition([step({}), { id: 'tell', kind: 'post_message', text: '{{steps.act.text}}' }]),
    );
    expect(posts(def)).not.toBe(posts(told));
    expect(posts(told)).toContain('Chat');
    // A cooldown it has is on the card.
    const limits = (d: AutomationDefinition) =>
      planSections(d, definitionGrants(d), names).find((s) => s.id === 'limits')?.lines.length;
    const calm = AutomationDefinition.parse({ ...definition([step({})]), limits: { cooldownMinutes: 30 } });
    expect(limits(calm)).toBe((limits(def) ?? 0) + 1);
  });
});

describe('the home_state trigger', () => {
  const leak = {
    kind: 'home_state',
    connectionId: HA,
    entity: 'binary_sensor.water_leak',
    entityName: 'Water leak',
    to: 'on',
  } as const;
  const facts = (from: string | null, to: string, entity: string = leak.entity) => ({
    kind: 'home_state' as const,
    connectionId: HA,
    entity,
    from,
    to,
  });

  it('names a connection, an entity id and a state', () => {
    expect(AutomationTrigger.parse(leak)).toEqual(leak);
    expect(AutomationTrigger.parse({ ...leak, entity: 'Binary_Sensor.Water_Leak' })).toMatchObject({
      entity: 'binary_sensor.water_leak',
    });
    expect(AutomationTrigger.safeParse({ ...leak, entity: 'water leak' }).success).toBe(false);
    expect(AutomationTrigger.safeParse({ ...leak, forMinutes: 0 }).success).toBe(false);
    expect(AutomationTrigger.safeParse({ ...leak, extra: 1 }).success).toBe(false);
    expect(TRIGGER_KIND_LABELS.home_state).toBeTruthy();
  });

  it('fires on a change to its state, from its state when it names one', () => {
    expect(triggerMatches(leak, facts('off', 'on'))).toBe(true);
    expect(triggerMatches(leak, facts('off', 'ON'))).toBe(true);
    expect(triggerMatches(leak, facts(null, 'on'))).toBe(true);
    expect(triggerMatches(leak, facts('on', 'off'))).toBe(false);
    expect(triggerMatches(leak, facts('on', 'on'))).toBe(false);
    expect(triggerMatches(leak, facts('off', 'on', 'binary_sensor.other'))).toBe(false);
    const fromOff = { ...leak, from: 'off' };
    expect(homeStateTriggerMatches(fromOff, facts('off', 'on'))).toBe(true);
    expect(homeStateTriggerMatches(fromOff, facts('unavailable', 'on'))).toBe(false);
    expect(homeStateTriggerMatches(fromOff, facts(null, 'on'))).toBe(false);
  });

  it('a change from a state to itself is no draft', () => {
    const same = validateDefinition(
      definition([{ id: 'tell', kind: 'post_message', text: 'x' }], [{ ...leak, from: 'on' }]),
    );
    expect(same.ok).toBe(false);
  });

  it('in words', () => {
    expect(homeWhenText(leak)).toBe('When Water leak turns on');
    expect(homeWhenText({ ...leak, forMinutes: 10 })).toContain('10');
    expect(homeWhenText({ ...leak, entityName: undefined })).toContain('binary_sensor.water_leak');
    expect(homeChangeSummary({ entity: leak.entity, name: 'Water leak', to: 'on' })).toBe(
      'Water leak is now on',
    );
    expect(triggerSummary([leak])).toBe('When Water leak turns on');
  });

  it('is signed as its own event', () => {
    expect(EVENT_TYPES[HOME_STATE_CHANGED]).toBe('System');
    expect(
      HomeStateChanged.safeParse({ connectionId: HA, entity: leak.entity, name: null, from: null, to: 'on' })
        .success,
    ).toBe(true);
  });
});

describe('the protect trigger', () => {
  const ring = { kind: 'protect', connectionId: PROTECT, event: 'ring', cameraName: 'Front door' } as const;
  const smoke = { kind: 'protect', connectionId: PROTECT, event: 'smoke' } as const;

  it('fires on what Protect saw, on its camera when it names one', () => {
    const facts = (event: 'ring' | 'smoke' | 'person', camera: string | null) => ({
      kind: 'protect' as const,
      connectionId: PROTECT,
      event,
      camera,
    });
    expect(protectTriggerMatches(ring, facts('ring', 'cam1'))).toBe(true);
    expect(protectTriggerMatches({ ...ring, camera: 'cam1' }, facts('ring', 'cam2'))).toBe(false);
    expect(protectTriggerMatches(smoke, facts('person', 'cam1'))).toBe(false);
  });

  it('knows Protect’s own names for what it saw', () => {
    expect(protectEventsOf('ring', [])).toEqual(['ring']);
    expect(protectEventsOf('smartDetectZone', ['person', 'vehicle', 'person'])).toEqual([
      'person',
      'vehicle',
    ]);
    expect(protectEventsOf('smartAudioDetect', ['alrmSmoke', 'alrmCmonx'])).toEqual(['smoke', 'co']);
    expect(protectEventsOf('smartDetectZone', ['licensePlate'])).toEqual([]);
  });

  it('in words', () => {
    expect(protectWhenText(ring)).toContain('Front door');
    expect(protectWhenText({ event: 'ring' })).not.toBe(protectWhenText(ring));
    expect(protectWhenText(smoke)).toBe('When a camera hears a smoke alarm');
    expect(protectSightingSummary({ event: 'ring', cameraName: null })).toBe('Someone rang the doorbell');
    expect(protectSightingSummary({ event: 'person', cameraName: 'Garden' })).toBe('Garden sees a person');
    expect(EVENT_TYPES[PROTECT_DETECTED]).toBe('System');
  });
});

describe('cooldown', () => {
  it('is 10 minutes for Home Assistant and Protect, none otherwise, unless the definition says', () => {
    const home = AutomationDefinition.parse(
      definition(
        [{ id: 'tell', kind: 'post_message', text: 'x' }],
        [{ kind: 'protect', connectionId: PROTECT, event: 'ring' }],
      ),
    );
    expect(cooldownOf(home)).toBe(DIRECT_COOLDOWN_DEFAULT_MINUTES);
    expect(cooldownOf({ ...home, limits: { ...home.limits, cooldownMinutes: 0 } })).toBe(0);
    const manual = AutomationDefinition.parse(definition([{ id: 'tell', kind: 'post_message', text: 'x' }]));
    expect(cooldownOf(manual)).toBe(0);
    expect(cooldownOf({ ...manual, limits: { ...manual.limits, cooldownMinutes: 30 } })).toBe(30);
  });
});

describe('a power cut', () => {
  const ups = { thing: 'server:nas-01', name: 'nas-01' };
  const servers = [ups, { thing: 'server:web-01', name: 'web-01' }, { thing: 'server:db-01', name: 'db-01' }];

  it('is said as a power cut, not as a check', () => {
    const trigger = {
      kind: 'thing',
      event: 'problem',
      thing: 'server:nas-01',
      name: 'nas-01',
      check: UPS_ON_BATTERY_CHECK,
      forMinutes: 10,
    } as const;
    expect(thingWhenText(trigger)).toContain('10');
    expect(thingWhenText(trigger)).toContain('nas-01');
    expect(thingWhenText({ ...trigger, event: 'back', forMinutes: undefined })).toContain('power');
  });

  it('shuts the others down first and the UPS’s own server last, then says so', () => {
    const def = powerCutDefinition({ conversationId: 'cnv_chat', ups, servers });
    expect(AutomationDefinition.safeParse(def).success).toBe(true);
    expect(validateDefinition(def).ok).toBe(true);
    const acts = def.steps.filter((s): s is RunActionStep => s.kind === 'run_action');
    expect(acts.map((s) => s.thingName)).toEqual(['web-01', 'db-01', 'nas-01']);
    expect(acts.every((s) => s.action === 'shut_down' && s.otherwise === 'skip')).toBe(true);
    const tell = def.steps.at(-1);
    expect(tell?.kind).toBe('post_message');
    for (const s of acts) expect(tell?.kind === 'post_message' && tell.text).toContain(`steps.${s.id}.text`);
    expect(def.triggers[0]).toMatchObject({
      kind: 'thing',
      event: 'problem',
      check: UPS_ON_BATTERY_CHECK,
      forMinutes: 10,
    });
    expect(
      powerCutDefinition({ conversationId: 'cnv_chat', ups, servers, minutes: 5 }).triggers[0],
    ).toMatchObject({
      forMinutes: 5,
    });
  });
});

describe('Dusty’s guide', () => {
  it('teaches the step, the triggers and the ready-made power cut', () => {
    for (const fact of [
      'run_action',
      'home_state',
      'protect',
      'homeConnections',
      'upsServers',
      'powerCut',
      UPS_ON_BATTERY_CHECK,
    ])
      expect(AUTOMATION_AUTHORING_GUIDE).toContain(fact);
    const read = MCP_TOOLS.automation_read.output.shape;
    expect(Object.keys(read)).toEqual(expect.arrayContaining(['homeConnections', 'upsServers']));
  });
});
