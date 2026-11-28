/**
 * Automations that act without AI (docs/decisions/direct-automations.md): the `run_action` step's allowlist and words,
 * the Home Assistant and UniFi Protect triggers (what their signed events tell triggers, whether they fire, their words)
 * and the ready-made “shut down my servers when the power goes out” automation. Pure; the server, the web and the phone
 * share it.
 */
import { z } from 'zod';
import {
  type AutomationDefinition,
  type AutomationStep,
  type DirectAction,
  HomeEntityId,
  HomeState,
  type HomeStateTrigger,
  ProtectEvent,
  type ProtectTrigger,
  type RunActionStep,
  type ThingTrigger,
} from '../domain/automation.js';
import { HA_SENSITIVE_DOMAINS, HA_SENSITIVE_WORDS } from '../domain/connections-catalog/homeassistant.js';
import { type CoreTranslator, coreTranslator } from '../i18n/catalog.js';
import { ConnectionId } from '../ids.js';

/** The server check that counts while a UPS keeps the server going on its battery (the hosts service's rule). */
export const UPS_ON_BATTERY_CHECK = 'host.ups.on_battery';

/** How long an automation started by Home Assistant or UniFi Protect waits after a run before the next can start. */
export const DIRECT_COOLDOWN_DEFAULT_MINUTES = 10;

/** Home Assistant domains a step may switch on and off. */
const SWITCHED = new Set(['light', 'switch', 'fan', 'input_boolean']);
/** Home Assistant domains a step may only start (turn on). */
const STARTED = new Set(['scene', 'script']);

const SENSITIVE_DOMAIN = new RegExp(`^(${HA_SENSITIVE_DOMAINS})$`);
const SENSITIVE_WORDS = new RegExp(HA_SENSITIVE_WORDS, 'i');

/** What a `run_action` step acts on: a server itself, one of its machines, Home Assistant itself, or an entity. */
export type DirectTargetKind = 'server' | 'machine' | 'home' | 'entity';

/** The domain of a Home Assistant entity id (`light` of `light.porch`). */
export function entityDomain(entity: string): string {
  return entity.slice(0, Math.max(0, entity.indexOf('.')));
}

/** What a step acts on, from its thing and target; null for a device or anything else. */
export function directTargetKind(step: Pick<RunActionStep, 'thing' | 'target'>): DirectTargetKind | null {
  if (step.thing.startsWith('server:')) return step.target ? 'machine' : 'server';
  if (step.thing.startsWith('connection:')) return step.target ? 'entity' : 'home';
  return null;
}

/** The actions each kind of target allows. */
const ALLOWED: Record<DirectTargetKind, readonly DirectAction[]> = {
  server: ['restart', 'shut_down'],
  machine: ['start', 'stop', 'shut_down', 'restart'],
  home: ['restart'],
  entity: ['turn_on', 'turn_off'],
};

/** The words for what never runs as a direct step, said back to the assistant (and so to the person). */
export const DIRECT_NOT_ALLOWED =
  'Whombat only restarts, shuts down, starts or stops servers and their machines, restarts Home Assistant, switches lights, switches and fans on or off and runs scenes and scripts on its own. Deleting, unlocking, disarming, opening, restoring and updating always need you, so they can’t be a step.';

/**
 * Why a `run_action` step can't be a step (plain words), or null. Checks the shape only: the server checks that the
 * connection is Home Assistant and that the thing is still there.
 */
export function directActionProblem(step: RunActionStep): string | null {
  const kind = directTargetKind(step);
  if (!kind) return 'Only a server, one of its machines or Home Assistant can be acted on directly.';
  if (!ALLOWED[kind].includes(step.action)) return DIRECT_NOT_ALLOWED;
  if (kind !== 'entity') return null;
  const entity = (step.target ?? '').toLowerCase();
  if (!/^[a-z0-9_]{1,64}\.[a-z0-9_]{1,128}$/.test(entity))
    return 'target: a Home Assistant entity id such as light.porch.';
  const domain = entityDomain(entity);
  if (
    SENSITIVE_DOMAIN.test(domain) ||
    SENSITIVE_WORDS.test(entity) ||
    SENSITIVE_WORDS.test(step.targetName ?? '')
  )
    return 'Locks, alarms, gates and doors always ask you, so they can’t be a step that runs on its own.';
  if (STARTED.has(domain))
    return step.action === 'turn_on' ? null : 'A scene or a script can only be started.';
  if (!SWITCHED.has(domain)) return DIRECT_NOT_ALLOWED;
  return null;
}

/**
 * The actions an older or a sloppy draft might name that are never a direct step, so the assistant hears why rather
 * than “invalid option” (`directDraftProblems`).
 */
const NEVER_DIRECT =
  /^(delete|remove|destroy|unlock|open|disarm|arm|restore|rollback|update|upgrade|install|firewall|wipe|format|reset)/;

/** Plain-word problems of a raw definition's `run_action` steps whose action is never allowed, before its schema. */
export function directDraftProblems(definition: unknown): string[] {
  const steps = (definition as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((s, i) => {
    const step = s as { kind?: unknown; action?: unknown } | null;
    if (step?.kind !== 'run_action' || typeof step.action !== 'string') return [];
    return NEVER_DIRECT.test(step.action.toLowerCase()) ? [`steps[${i}].action: ${DIRECT_NOT_ALLOWED}`] : [];
  });
}

/**
 * Whether a step left `running` by a process that stopped may simply run again: setting a state twice does no harm
 * (on, off, start, stop, shut down — a second ask finds it already so), a restart twice would restart twice.
 */
export function directActionRepeatable(action: DirectAction): boolean {
  return action !== 'restart';
}

type Words = { thing: string; target: string };

function wordsOf(step: RunActionStep): Words {
  return { thing: step.thingName, target: step.targetName ?? step.target ?? step.thingName };
}

/** The message key of what a step does, imperative (`do`) or done (`did`). */
function actionKey(step: RunActionStep, tense: 'do' | 'did') {
  const kind = directTargetKind(step);
  const domain = step.target ? entityDomain(step.target) : '';
  const which =
    kind === 'server'
      ? step.action === 'restart'
        ? 'restartServer'
        : 'shutDownServer'
      : kind === 'machine'
        ? (({ start: 'startMachine', stop: 'stopMachine', shut_down: 'shutDownMachine' } as const)[
            step.action as 'start' | 'stop' | 'shut_down'
          ] ?? 'restartMachine')
        : kind === 'home'
          ? 'restartHome'
          : STARTED.has(domain)
            ? 'run'
            : step.action === 'turn_off'
              ? 'turnOff'
              : 'turnOn';
  return `direct.${tense}.${which}` as const;
}

/** “Shut down nas-01”, “Turn on Porch light”, “Start web-01 on nas-01”: what the step does, for the plan card. */
export function directActionText(step: RunActionStep, locale?: string | null): string {
  return coreTranslator(locale).t(actionKey(step, 'do'), wordsOf(step));
}

/** “Runs on this Whombat right away, without AI”: under each direct step on the plan card and the page. */
export function directActionDetail(locale?: string | null): string {
  return coreTranslator(locale).t('direct.detail');
}

/** How a direct action came out: it ran (and what the thing does now), or the thing was already so. */
export type DirectOutcome =
  | { kind: 'done'; result: 'switching_off' | 'restarting' | 'starting' | null }
  | { kind: 'noop'; already: 'off' | 'on' | 'running' | 'stopped' };

/**
 * The run page's and the thread's line (“Shut down nas-01 at 21:14 — it’s switching off.”, “nas-01 was already off at
 * 21:14, so nothing was done.”). `time` is the clock time in the burrow's zone.
 */
export function directDoneLine(
  step: RunActionStep,
  outcome: DirectOutcome,
  time: string,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const words = wordsOf(step);
  if (outcome.kind === 'noop') return tr.t(`direct.noop.${outcome.already}`, { name: words.target, time });
  const what = tr.t(actionKey(step, 'did'), words);
  return outcome.result
    ? tr.t('direct.doneWith', { what, time, result: tr.t(`direct.result.${outcome.result}`) })
    : tr.t('direct.done', { what, time });
}

/** The words a step says in a few words when it can't say more (an older run, no output). */
export function directStepTitle(step: AutomationStep, locale?: string | null): string | null {
  return step.kind === 'run_action' ? directActionText(step, locale) : null;
}

/* Home Assistant ----------------------------------------------------------------------------------------------------- */

/** The signed event of an entity a live automation names changing state. */
export const HOME_STATE_CHANGED = 'home.state_changed';

/**
 * The payload of a signed `home.state_changed`: an entity a live automation names went from one state to another
 * (`from`: null when Whombat didn't know it before, or it was too long to be a trigger's word). `name` is Home
 * Assistant's friendly name, for the run's words.
 */
export const HomeStateChanged = z.object({
  connectionId: ConnectionId,
  entity: HomeEntityId,
  name: z.string().max(120).nullable(),
  from: HomeState.nullable(),
  to: HomeState,
});
export type HomeStateChanged = z.infer<typeof HomeStateChanged>;

/** What a signed `home.state_changed` tells triggers. */
export interface HomeStateFacts {
  kind: 'home_state';
  connectionId: string;
  entity: string;
  from: string | null;
  to: string;
}

const sameState = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** “Water leak is now on”: a run's trigger in its history; `{{trigger.text}}` ends it with a full stop. */
export function homeChangeSummary(change: Pick<HomeStateChanged, 'entity' | 'name' | 'to'>): string {
  return `${change.name ?? change.entity} is now ${change.to}`;
}

/** Whether a change of state fires the trigger: its connection and entity, to its state, from its state if it names one. */
export function homeStateTriggerMatches(trigger: HomeStateTrigger, facts: HomeStateFacts): boolean {
  if (facts.connectionId !== trigger.connectionId || facts.entity !== trigger.entity) return false;
  if (!sameState(facts.to, trigger.to)) return false;
  if (facts.from !== null && sameState(facts.from, facts.to)) return false;
  return !trigger.from || (facts.from !== null && sameState(facts.from, trigger.from));
}

/** The entity in a trigger's words: its name, else its id. */
function entityWords(trigger: Pick<HomeStateTrigger, 'entity' | 'entityName'>): string {
  return trigger.entityName ?? trigger.entity;
}

/** “When Water leak turns on”, “When Front door has been open for 10 minutes”. */
export function homeWhenText(
  trigger: Pick<HomeStateTrigger, 'entity' | 'entityName' | 'to' | 'from' | 'forMinutes'>,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  const entity = entityWords(trigger);
  if (trigger.forMinutes)
    return tr.t('homeWhen.toFor', {
      entity,
      state: trigger.to,
      duration: tr.tp('thingWhen.minutes', trigger.forMinutes),
    });
  if (trigger.from) return tr.t('homeWhen.fromTo', { entity, from: trigger.from, state: trigger.to });
  return tr.t('homeWhen.to', { entity, state: trigger.to });
}

/** Under the plan card's line: which Home Assistant (“In Home Assistant”); null when unknown. */
export function homeTriggerDetail(connection?: string, locale?: string | null): string | null {
  return connection ? coreTranslator(locale).t('homeWhen.detail', { connection }) : null;
}

/* UniFi Protect ------------------------------------------------------------------------------------------------------ */

/** The signed event of something Protect saw on a connection a live automation listens to. */
export const PROTECT_DETECTED = 'protect.detected';

/**
 * The payload of a signed `protect.detected`: what Protect saw (`event`), on which camera (its id and name), on a
 * connection a live automation listens to. `detection` is Protect's own event id, so one sighting signs once.
 */
export const ProtectDetected = z.object({
  connectionId: ConnectionId,
  event: ProtectEvent,
  camera: z.string().min(1).max(200).nullable(),
  cameraName: z.string().max(120).nullable(),
  detection: z.string().min(1).max(200),
});
export type ProtectDetected = z.infer<typeof ProtectDetected>;

/** What a signed `protect.detected` tells triggers. */
export interface ProtectFacts {
  kind: 'protect';
  connectionId: string;
  event: ProtectEvent;
  camera: string | null;
}

export function protectTriggerMatches(trigger: ProtectTrigger, facts: ProtectFacts): boolean {
  return (
    facts.connectionId === trigger.connectionId &&
    facts.event === trigger.event &&
    (!trigger.camera || trigger.camera === facts.camera)
  );
}

const PROTECT_SAW: Record<ProtectEvent, string> = {
  ring: '',
  person: 'sees a person',
  vehicle: 'sees a vehicle',
  animal: 'sees an animal',
  package: 'sees a package',
  smoke: 'hears a smoke alarm',
  co: 'hears a CO alarm',
  glass: 'hears glass breaking',
  siren: 'hears a siren',
};

/** “Someone rang Front door”, “Garden sees a person”: a run's trigger in its history and `{{trigger.text}}`. */
export function protectSightingSummary(d: Pick<ProtectDetected, 'event' | 'cameraName'>): string {
  if (d.event === 'ring')
    return d.cameraName ? `Someone rang the doorbell at ${d.cameraName}` : 'Someone rang the doorbell';
  return `${d.cameraName ?? 'A camera'} ${PROTECT_SAW[d.event]}`;
}

/** Protect's own names of what it saw, as triggers name them: smart detections and the alarms it hears. */
const PROTECT_KINDS: Record<string, ProtectEvent> = {
  person: 'person',
  vehicle: 'vehicle',
  animal: 'animal',
  package: 'package',
  alrmSmoke: 'smoke',
  smoke_cmonx: 'smoke',
  alrmCmonx: 'co',
  alrmGlassBreak: 'glass',
  alrmSiren: 'siren',
};

/** The trigger events a Protect detection is (a ring, or each smart type it saw that a trigger knows). */
export function protectEventsOf(kind: string, detected: readonly string[]): ProtectEvent[] {
  if (kind === 'ring') return ['ring'];
  return [...new Set(detected.flatMap((d) => (PROTECT_KINDS[d] ? [PROTECT_KINDS[d] as ProtectEvent] : [])))];
}

/** “When someone rings Front door”, “When Garden sees a person”, “When a camera hears a smoke alarm”. */
export function protectWhenText(
  trigger: Pick<ProtectTrigger, 'event' | 'cameraName' | 'camera'>,
  locale?: string | null,
): string {
  const tr = coreTranslator(locale);
  if (trigger.event === 'ring')
    return trigger.cameraName
      ? tr.t('protectWhen.ringAt', { camera: trigger.cameraName })
      : tr.t('protectWhen.ring');
  return tr.t(`protectWhen.${trigger.event}`, { camera: trigger.cameraName ?? tr.t('protectWhen.camera') });
}

/** Under the plan card's line: which Protect (“On UniFi Protect”); null when unknown. */
export function protectTriggerDetail(connection?: string, locale?: string | null): string | null {
  return connection ? coreTranslator(locale).t('protectWhen.detail', { connection }) : null;
}

/* Cooldown and kinds -------------------------------------------------------------------------------------------------- */

/** Whether a definition starts on Home Assistant or UniFi Protect. */
export function startedByHome(definition: Pick<AutomationDefinition, 'triggers'>): boolean {
  return definition.triggers.some((t) => t.kind === 'home_state' || t.kind === 'protect');
}

/** Minutes after a run before the next may start: the definition's own, else 10 for Home and Protect, else none. */
export function cooldownOf(definition: Pick<AutomationDefinition, 'triggers' | 'limits'>): number {
  const own = definition.limits.cooldownMinutes;
  if (own !== undefined) return own;
  return startedByHome(definition) ? DIRECT_COOLDOWN_DEFAULT_MINUTES : 0;
}

/** Whether a definition has anything an app or a release from before direct automations can't read. */
export function hasDirectParts(definition: unknown): boolean {
  if (!definition || typeof definition !== 'object') return false;
  const d = definition as { triggers?: unknown; steps?: unknown; limits?: unknown };
  const kinds = (list: unknown) =>
    Array.isArray(list)
      ? list.map((x) => (x && typeof x === 'object' ? (x as { kind?: unknown }).kind : null))
      : [];
  const limits = d.limits && typeof d.limits === 'object' ? (d.limits as Record<string, unknown>) : {};
  return (
    kinds(d.triggers).some((k) => k === 'home_state' || k === 'protect') ||
    kinds(d.steps).includes('run_action') ||
    limits.cooldownMinutes !== undefined
  );
}

/* UPS ------------------------------------------------------------------------------------------------------------------ */

/** Whether a thing trigger is about a UPS keeping a server going on its battery. */
export function upsTrigger(trigger: Pick<ThingTrigger, 'check'>): boolean {
  return trigger.check === UPS_ON_BATTERY_CHECK;
}

/** “When nas-01’s UPS has been on battery for 10 minutes”, “When the power is back at nas-01”; null: not a UPS trigger. */
export function upsWhenText(trigger: ThingTrigger, target: string, tr: CoreTranslator): string | null {
  if (!upsTrigger(trigger)) return null;
  if (trigger.event === 'back') return tr.t('thingWhen.ups.back', { target });
  if (trigger.event === 'down') return null;
  return trigger.forMinutes
    ? tr.t('thingWhen.ups.onBatteryFor', { target, duration: tr.tp('thingWhen.minutes', trigger.forMinutes) })
    : tr.t('thingWhen.ups.onBattery', { target });
}

/** A server as the ready-made power cut automation names it. */
export interface PowerCutServer {
  /** Its page id (`server:nas-01`). */
  thing: string;
  name: string;
}

/**
 * The ready-made “When the power goes out, shut down my servers safely” (docs/decisions/direct-automations.md): when the
 * UPS on `ups` has kept it going on battery for `minutes` (10 unless given), shut down each of `servers` in turn — the
 * UPS's own server last, as it keeps the others' power — then say so in Chat. Runs on this Whombat, without AI.
 */
export function powerCutDefinition(input: {
  conversationId: string;
  ups: PowerCutServer;
  servers: readonly PowerCutServer[];
  minutes?: number;
}): AutomationDefinition {
  const others = input.servers.filter((s) => s.thing !== input.ups.thing);
  const last = input.servers.some((s) => s.thing === input.ups.thing) ? [input.ups] : [];
  const order = [...others, ...last].slice(0, 10);
  const steps: AutomationStep[] = order.map((s, i) => ({
    id: `shut_down_${i + 1}`,
    kind: 'run_action',
    thing: s.thing,
    thingName: s.name,
    action: 'shut_down',
    // One server that can't be reached mustn't keep the others on.
    otherwise: 'skip',
    retries: 0,
  }));
  const lines = order.map((_, i) => `{{steps.shut_down_${i + 1}.text}}`).join('\n');
  steps.push({
    id: 'tell',
    name: 'Tell you',
    kind: 'post_message',
    text: `The power is out at ${input.ups.name}, so I shut the servers down.\n${lines}`,
    conversation: 'run',
    thread: 'run',
    attachFrom: [],
    retries: 0,
  });
  return {
    version: 1,
    conversationId: input.conversationId,
    triggers: [
      {
        kind: 'thing',
        event: 'problem',
        thing: input.ups.thing,
        name: input.ups.name,
        check: UPS_ON_BATTERY_CHECK,
        checkName: 'Running on battery',
        forMinutes: input.minutes ?? 10,
      },
    ],
    steps,
    limits: { runTimeoutMinutes: 60, maxConcurrentRuns: 1, maxRunsPerDay: 5 },
  };
}
