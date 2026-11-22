/**
 * Automations the release before them can't run (docs/decisions/automation-recipes.md): one started by incoming mail,
 * and one with a step that proposes or makes changes in the person's connected services. That release would run them
 * as the person, read past the outsiders' mark and send them unchanged to older phones, which then refuse the whole
 * Automations list. A box makes, turns on and runs them only when the release it would go back to after a failed update
 * knows them too: that is what this gate tells.
 *
 * The release it would go back to comes from the manager's update facts: while this release is being tried, the one
 * the box runs as its current release; once it is the current one, the release its last update came from. A release
 * knows them when it is in `runtime_releases`, where every release since this one records itself at its first start.
 * So the first release with them, on a box updated from an older one, keeps them off, and the next turns them on.
 * Development boxes and tests have them on; a box with nothing to go back to (it never updated) too.
 */
import type { UpdateFacts } from '@whombat/control-contracts/local';
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

/** Whether a definition (or a saved draft, valid or not) has anything the release before these automations lacks. */
export function newerDefinition(definition: Json): boolean {
  if (!definition || typeof definition !== 'object') return false;
  return (
    startedByMail(definition) ||
    listOf(definition, 'steps').some(
      (s) =>
        kindOf(s) === 'connection_actions' ||
        (kindOf(s) === 'dispatch_agent' && (s as { proposeActions?: unknown }).proposeActions !== undefined),
    )
  );
}

/** Whether a run is one of them: started by mail, or of such a definition. */
export function newerRun(run: { trigger: { kind: string }; definition: Json }): boolean {
  return run.trigger.kind === 'mail' || newerDefinition(run.definition);
}

/** The line said instead of making, turning on or running such an automation. */
export function laterWords(definition: Json): string {
  return startedByMail(definition) ? MAIL_AUTOMATIONS_LATER : ACTION_AUTOMATIONS_LATER;
}

/**
 * The release the box would go back to if this one failed, from the manager's update facts: `none` when it has nothing
 * to go back to (it never updated), `unknown` when the facts don't say (none yet, or this release came back another
 * way than an update, such as a fallback at boot).
 */
export type RollbackTarget = { kind: 'none' } | { kind: 'unknown' } | { kind: 'release'; id: string };

export function rollbackTarget(update: UpdateFacts | null | undefined, me: string | null): RollbackTarget {
  if (!update || !me) return { kind: 'unknown' };
  // Being tried: a failure goes back to the release the box runs as its current one.
  if (update.candidate === me && update.current !== me) return { kind: 'release', id: update.current };
  if (update.current !== me) return { kind: 'unknown' };
  if (!update.lastUpdate) return { kind: 'none' };
  if (update.lastUpdate.release !== me) return { kind: 'unknown' };
  return update.lastUpdate.from ? { kind: 'release', id: update.lastUpdate.from } : { kind: 'none' };
}

/** Records the running release in `runtime_releases` (once, at its first start), on a managed box that names it. */
export async function recordRuntimeRelease(
  db: Database,
  config: Pick<Config, 'WHOMBAT_RELEASE_ID'>,
  now: Date,
): Promise<void> {
  const releaseId = config.WHOMBAT_RELEASE_ID?.trim();
  if (!releaseId) return;
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

/**
 * Whether this box may make, turn on and run automations the release before them can't run. Off in production until
 * the managed runtime follows the manager's update facts (`follow`) and they name a release that knows them.
 */
export class NewerAutomationsGate {
  #facts: (() => UpdateFacts | null) | null = null;
  /** Releases found in `runtime_releases`: a recorded one stays recorded. */
  readonly #known = new Set<string>();

  constructor(
    private readonly config: Pick<Config, 'NODE_ENV' | 'WHOMBAT_RELEASE_ID'>,
    /** Whether a release is in `runtime_releases` (`knownRelease`). */
    private readonly known: (releaseId: string) => Promise<boolean>,
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

  /** Refuses `definition` with the line the person is told, while such automations wait for the next update. */
  async refuse(definition: Json): Promise<void> {
    if (newerDefinition(definition) && !(await this.ready())) throw conflict(laterWords(definition));
  }
}
