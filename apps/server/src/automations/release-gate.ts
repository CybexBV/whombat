/**
 * Automations the release before them can't run (docs/decisions/automation-recipes.md): one started by incoming mail,
 * by Find My or by something going down or coming back, one that acts without AI or starts on Home Assistant or UniFi
 * Protect, and one with a step that proposes or makes changes in the person's connected services. That release would
 * run them as the person, read past the outsiders' mark and send them unchanged to older phones, which then refuse the
 * whole Automations list. A box makes, turns on and runs them only when the release it would go back to after a
 * failed update knows them too: that is what this gate tells.
 *
 * The release it would go back to comes from the manager's update facts: while this release is being tried, the one
 * the box runs as its current release; once it is the current one, the release its last update came from. A release
 * knows them when it is in `runtime_releases`, where every release since this one records itself at its first start.
 * So the first release with them, on a box updated from an older one, keeps them off, and the next turns them on.
 * Development boxes and tests have them on; a box with nothing to go back to (it never updated, or no update helper
 * started its runtime) too.
 */
import type { UpdateFacts } from '@whombat/control-contracts/local';
import { hasDirectParts } from '@whombat/core';
import { eq } from 'drizzle-orm';
import type { Config } from '../config';
import type { Database } from '../db/client';
import { runtimeReleases } from '../db/schema/index';
import { conflict } from '../lib/errors';
import { buildInfo } from '../version';

/** What the person and the assistant are told instead, about an automation started by mail. */
export const MAIL_AUTOMATIONS_LATER = 'Mail automations come with the next update.';
/** The same about one that changes things in their connected services. */
export const ACTION_AUTOMATIONS_LATER =
  'Automations that change things in your connected services come with the next update.';
/** The same about one that starts when someone arrives or leaves on Find My. */
export const FIND_MY_AUTOMATIONS_LATER = 'Find My automations come with the next update.';
/** The same about one that starts when something goes down, has a problem or comes back. */
export const THING_AUTOMATIONS_LATER =
  'Automations that start when something goes down or comes back come with the next update.';
/** The same about one that acts by itself without AI, or starts on Home Assistant or UniFi Protect. */
export const DIRECT_AUTOMATIONS_LATER =
  'Automations that act by themselves or start on Home Assistant or UniFi Protect come with the next update.';

/**
 * The first schema of a release that runs findmy automations (`runtime_releases.schema`): a release the box would go
 * back to knows them when it recorded this migration or a later one.
 */
export const FIND_MY_SCHEMA = '0017_findmy_places';

/**
 * The first schema of a release that runs automations started by something going down or coming back (`thing`
 * triggers); the release before it can't read their definitions, yet would go on with a run one of them started.
 */
export const THING_SCHEMA = '0027_incident_automation_watches';

/**
 * The first schema of a release that runs automations that act without AI (`run_action` steps, `home_state` and
 * `protect` triggers, a cooldown): the release before it can't read their definitions, yet would advance a run one of
 * them started.
 */
export const DIRECT_SCHEMA = '0044_direct_automations';

type Json = unknown;

const kindOf = (value: Json): unknown =>
  value && typeof value === 'object' ? (value as { kind?: unknown }).kind : undefined;
const listOf = (value: Json, key: string): unknown[] => {
  const list = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return Array.isArray(list) ? list : [];
};

/** A definition (or a saved draft, valid or not) started by mail. */
function startedByMail(definition: Json): boolean {
  const recipe =
    definition && typeof definition === 'object' ? (definition as { recipe?: Json }).recipe : null;
  const when = recipe && typeof recipe === 'object' ? (recipe as { when?: Json }).when : null;
  return listOf(definition, 'triggers').some((t) => kindOf(t) === 'mail') || kindOf(when) === 'mail';
}

/** A definition (or a saved draft, valid or not) started when someone arrives or leaves on Find My. */
export function startedByFindMy(definition: Json): boolean {
  const recipe =
    definition && typeof definition === 'object' ? (definition as { recipe?: Json }).recipe : null;
  const when = recipe && typeof recipe === 'object' ? (recipe as { when?: Json }).when : null;
  return listOf(definition, 'triggers').some((t) => kindOf(t) === 'findmy') || kindOf(when) === 'findmy';
}

/** A definition (or a saved draft, valid or not) started when something goes down, has a problem or comes back. */
export function startedByThing(definition: Json): boolean {
  const recipe =
    definition && typeof definition === 'object' ? (definition as { recipe?: Json }).recipe : null;
  const when = recipe && typeof recipe === 'object' ? (recipe as { when?: Json }).when : null;
  return listOf(definition, 'triggers').some((t) => kindOf(t) === 'thing') || kindOf(when) === 'thing';
}

/** Whether a definition (or a saved draft, valid or not) has anything the release before these automations lacks. */
export function newerDefinition(definition: Json): boolean {
  if (!definition || typeof definition !== 'object') return false;
  return (
    startedByMail(definition) ||
    startedByFindMy(definition) ||
    startedByThing(definition) ||
    hasDirectParts(definition) ||
    listOf(definition, 'steps').some(
      (s) =>
        kindOf(s) === 'connection_actions' ||
        (kindOf(s) === 'dispatch_agent' && (s as { proposeActions?: unknown }).proposeActions !== undefined),
    )
  );
}

/** A run's trigger kind from Home Assistant or UniFi Protect. */
const startedByHomeKind = (kind: string): boolean => kind === 'home_state' || kind === 'protect';

/** Whether a run is one of them: started by mail, or of such a definition. */
export function newerRun(run: { trigger: { kind: string }; definition: Json }): boolean {
  return (
    run.trigger.kind === 'mail' ||
    run.trigger.kind === 'findmy' ||
    run.trigger.kind === 'thing' ||
    startedByHomeKind(run.trigger.kind) ||
    newerDefinition(run.definition)
  );
}

/** The line said instead of making, turning on or running such an automation. */
export function laterWords(definition: Json): string {
  if (startedByMail(definition)) return MAIL_AUTOMATIONS_LATER;
  if (startedByFindMy(definition)) return FIND_MY_AUTOMATIONS_LATER;
  if (hasDirectParts(definition)) return DIRECT_AUTOMATIONS_LATER;
  return startedByThing(definition) ? THING_AUTOMATIONS_LATER : ACTION_AUTOMATIONS_LATER;
}

/**
 * The release the box would go back to if this one failed, from the manager's update facts: `none` when it has nothing
 * to go back to (it never updated, or no update helper started this runtime), `unknown` when the facts don't say (none
 * yet, this runtime started before its release was recorded, or this release came back another way than an update,
 * such as a fallback at boot).
 */
export type RollbackTarget = { kind: 'none' } | { kind: 'unknown' } | { kind: 'release'; id: string };

/** `WHOMBAT_RELEASE_ID` of a runtime that started before the update helper recorded the box's release: not a release. */
export const BEFORE_FIRST_RELEASE = 'factory';

export function rollbackTarget(update: UpdateFacts | null | undefined, me: string | null): RollbackTarget {
  // Every runtime the appliance starts names its release (`runtime.nix`). One that names none wasn't started by the
  // update helper, so no manager rolls it back after a failed update: nothing to go back to.
  if (!me) return { kind: 'none' };
  if (!update) return { kind: 'unknown' };
  // Being tried: a failure goes back to the release the box runs as its current one.
  if (update.candidate === me && update.current !== me) return { kind: 'release', id: update.current };
  if (update.current !== me) return { kind: 'unknown' };
  if (!update.lastUpdate) return { kind: 'none' };
  if (update.lastUpdate.release !== me) return { kind: 'unknown' };
  return update.lastUpdate.from ? { kind: 'release', id: update.lastUpdate.from } : { kind: 'none' };
}

/**
 * Records the running release in `runtime_releases` (once, at its first start), on a managed box that names it. A
 * runtime that started before the box's release was recorded names none yet: it is restarted once it is
 * (`provisioning.nix`), and records itself then.
 */
export async function recordRuntimeRelease(
  db: Database,
  config: Pick<Config, 'WHOMBAT_RELEASE_ID'>,
  now: Date,
): Promise<void> {
  const releaseId = config.WHOMBAT_RELEASE_ID?.trim();
  if (!releaseId || releaseId === BEFORE_FIRST_RELEASE) return;
  const build = buildInfo();
  await db
    .insert(runtimeReleases)
    .values({ releaseId, version: build.version, schema: build.schema, firstStartedAt: now })
    .onConflictDoNothing();
}

/** Whether `releaseId` recorded itself in `runtime_releases`. */
export async function knownRelease(db: Database, releaseId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: runtimeReleases.releaseId })
    .from(runtimeReleases)
    .where(eq(runtimeReleases.releaseId, releaseId));
  return !!row;
}

/** The newest migration `releaseId` had when it recorded itself, or null (not recorded, or it didn't say). */
export async function releaseSchema(db: Database, releaseId: string): Promise<string | null> {
  const [row] = await db
    .select({ schema: runtimeReleases.schema })
    .from(runtimeReleases)
    .where(eq(runtimeReleases.releaseId, releaseId));
  return row?.schema ?? null;
}

/** Whether a recorded schema (`0017_findmy_places`) is `FIND_MY_SCHEMA` or later: migrations are numbered in order. */
export const schemaKnowsFindMy = (schema: string | null): boolean =>
  schema !== null && schema >= FIND_MY_SCHEMA;

/** Whether a recorded schema is `THING_SCHEMA` or later. */
export const schemaKnowsThings = (schema: string | null): boolean =>
  schema !== null && schema >= THING_SCHEMA;

/** Whether a recorded schema is `DIRECT_SCHEMA` or later. */
export const schemaKnowsDirect = (schema: string | null): boolean =>
  schema !== null && schema >= DIRECT_SCHEMA;

/**
 * Whether this box may make, turn on and run automations the release before them can't run. Off in production until
 * the managed runtime follows the manager's update facts (`follow`) and they name a release that knows them.
 */
export class NewerAutomationsGate {
  #facts: (() => UpdateFacts | null) | null = null;
  /** Releases found in `runtime_releases`: a recorded one stays recorded. */
  readonly #known = new Set<string>();
  /** Releases found there with a schema that runs findmy automations. */
  readonly #knowsFindMy = new Set<string>();
  /** Releases found there with a schema that runs thing automations. */
  readonly #knowsThings = new Set<string>();
  /** Releases found there with a schema that runs automations that act without AI. */
  readonly #knowsDirect = new Set<string>();

  constructor(
    private readonly config: Pick<Config, 'NODE_ENV' | 'WHOMBAT_RELEASE_ID'>,
    /** Whether a release is in `runtime_releases` (`knownRelease`). */
    private readonly known: (releaseId: string) => Promise<boolean>,
    /** The schema a release recorded there (`releaseSchema`); absent: none is known to run findmy automations. */
    private readonly schemaOf: (releaseId: string) => Promise<string | null> = async () => null,
  ) {}

  /** The managed runtime's update facts, as the manager last pushed them. */
  follow(facts: () => UpdateFacts | null): void {
    this.#facts = facts;
  }

  async ready(): Promise<boolean> {
    if (this.config.NODE_ENV !== 'production') return true;
    const target = rollbackTarget(this.#facts?.() ?? null, this.config.WHOMBAT_RELEASE_ID?.trim() || null);
    if (target.kind !== 'release') return target.kind === 'none';
    if (this.#known.has(target.id)) return true;
    if (!(await this.known(target.id))) return false;
    this.#known.add(target.id);
    return true;
  }

  /**
   * Whether findmy automations may be made, turned on and run, and their connections keep places: as `ready`, with a
   * release to go back to that recorded a schema from `FIND_MY_SCHEMA` on (the release before them would refuse the
   * whole definition of one, and send it unchanged to phones that can't read it).
   */
  async findMyReady(): Promise<boolean> {
    return this.#schemaReady(schemaKnowsFindMy, this.#knowsFindMy);
  }

  /**
   * Whether automations started by something going down or coming back may be made, turned on and run: as
   * `findMyReady`, with `THING_SCHEMA` (the release before them can't read such a definition, yet would advance a run
   * one of them started, shutdown steps and all).
   */
  async thingsReady(): Promise<boolean> {
    return this.#schemaReady(schemaKnowsThings, this.#knowsThings);
  }

  /**
   * Whether automations that act without AI (or start on Home Assistant or UniFi Protect) may be made, turned on and
   * run: as `thingsReady`, with `DIRECT_SCHEMA`.
   */
  async directReady(): Promise<boolean> {
    return this.#schemaReady(schemaKnowsDirect, this.#knowsDirect);
  }

  async #schemaReady(knows: (schema: string | null) => boolean, found: Set<string>): Promise<boolean> {
    if (this.config.NODE_ENV !== 'production') return true;
    const target = rollbackTarget(this.#facts?.() ?? null, this.config.WHOMBAT_RELEASE_ID?.trim() || null);
    if (target.kind !== 'release') return target.kind === 'none';
    if (found.has(target.id)) return true;
    if (!knows(await this.schemaOf(target.id))) return false;
    found.add(target.id);
    return true;
  }

  /** Whether `definition` waits for the next update now: such an automation isn't made, turned on or run. */
  async holds(definition: Json): Promise<boolean> {
    if (!newerDefinition(definition)) return false;
    return (
      !(await this.ready()) ||
      (startedByFindMy(definition) && !(await this.findMyReady())) ||
      (startedByThing(definition) && !(await this.thingsReady())) ||
      (hasDirectParts(definition) && !(await this.directReady()))
    );
  }

  /** Whether a run waits for the next update now, kept as it is until it may go on. */
  async holdsRun(run: { trigger: { kind: string }; definition: Json }): Promise<boolean> {
    if (!newerRun(run)) return false;
    if (!(await this.ready())) return true;
    if ((run.trigger.kind === 'findmy' || startedByFindMy(run.definition)) && !(await this.findMyReady()))
      return true;
    if ((run.trigger.kind === 'thing' || startedByThing(run.definition)) && !(await this.thingsReady()))
      return true;
    return (
      (startedByHomeKind(run.trigger.kind) || hasDirectParts(run.definition)) && !(await this.directReady())
    );
  }

  /** Refuses `definition` with the line the person is told, while such automations wait for the next update. */
  async refuse(definition: Json): Promise<void> {
    if (await this.holds(definition)) throw conflict(laterWords(definition));
  }
}
