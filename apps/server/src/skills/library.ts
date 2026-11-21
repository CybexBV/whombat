/**
 * Settings → Skills on Hermes's skills (contracts 3.0 CT-1570…CT-1572; hermes-skills.md HSK-01…HSK-13): one list, the
 * skills of the person's Hermes profile — Hermes's built-ins, what was installed from Hermes's hub and what the agent
 * learned (one-person.md OP-08, OP-S63) — read and changed through the runner's Hermes-home service (`hermes.ts`).
 * Hermes's hub is `hub-routes.ts`.
 *
 * A row is the runner's summary in the contract's words: `origin` (`builtin`, `hub`, `learned`), Hermes's category (the
 * first folder of its path), its status as the runner says (on, off, removed), what its front matter says it needs, and
 * for a hub skill whether Hermes's last update check found a newer version (`hubUpdatesOf`). Categories are titled from
 * their folder (`skillCategoryTitle`) and described by Hermes.
 */
import {
  type HermesSkillCategory,
  type HermesSkillSummary,
  SKILL_CATEGORIES_MAX,
  type SkillCan,
  SkillCategory,
  type SkillCategoryInfo,
  type SkillLibraryItem,
  type SkillLibraryResponse,
  SkillName,
  type SkillOrigin,
  skillCategoryTitle,
} from '@whombat/core';
import { notFound } from '../lib/errors';
import { loadAgentRow, type PrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { skillsCall } from './hermes';

/** Who is looking: the person (who may change every skill, contracts CT-1571), or an agent. */
export interface SkillViewer {
  principal: PrincipalRow;
  isPerson: boolean;
}

export function viewerOf(principal: PrincipalRow): SkillViewer {
  return { principal, isPerson: principal.kind === 'person' };
}

/* Hermes's update check (HSK-09) -------------------------------------------------------------------------------- */

/** The last answer of Hermes's update check of the installed hub skills, per server. */
export interface HubUpdates {
  checkedAt: string;
  /** Names with a newer version at their source. */
  available: ReadonlySet<string>;
  /** Names whose source didn't answer. */
  unreachable: ReadonlySet<string>;
}

const updates = new WeakMap<Services, HubUpdates>();

/** What Hermes's last update check found (null: none yet since this server started). */
export const hubUpdatesOf = (services: Services): HubUpdates | null => updates.get(services) ?? null;

export function setHubUpdates(services: Services, value: HubUpdates): void {
  updates.set(services, value);
}

/** A hub skill updated: no longer waiting for one. */
export function hubUpdated(services: Services, name: string): void {
  const last = updates.get(services);
  if (!last?.available.has(name)) return;
  updates.set(services, { ...last, available: new Set([...last.available].filter((n) => n !== name)) });
}

/* Facts ---------------------------------------------------------------------------------------------------------- */

/** Everything a row is made from besides the skill itself. */
export interface LibraryFacts {
  viewer: SkillViewer;
  updates: HubUpdates | null;
}

export function libraryFacts(services: Services, viewer: SkillViewer): LibraryFacts {
  return { viewer, updates: hubUpdatesOf(services) };
}

/* Rows ----------------------------------------------------------------------------------------------------------- */

/** The skill's name as the contract takes it: its own, else its folder's; null when neither is a skill name. */
function nameOf(s: Pick<HermesSkillSummary, 'name' | 'path'>): string | null {
  for (const n of [s.name, s.path.split('/').at(-1) ?? '']) if (SkillName.safeParse(n).success) return n;
  return null;
}

/** Hermes's category of a path: its first folder (Hermes's `_get_category_from_path`), none at the top. */
export function categoryOfPath(path: string): string | null {
  const parts = path.split('/');
  const first = parts.length > 1 ? (parts[0] as string) : null;
  return first && SkillCategory.safeParse(first).success ? first : null;
}

/** One row of Settings → Skills (pure), or null for a folder whose name the contract can't carry. */
export function itemOf(s: HermesSkillSummary, facts: LibraryFacts): SkillLibraryItem | null {
  const name = nameOf(s);
  if (!name) return null;
  const origin: SkillOrigin = s.origin;
  const removed = s.state === 'removed';
  const updateAvailable = !!facts.updates?.available.has(name);
  const hub =
    origin === 'hub' && s.hub
      ? { source: s.hub.source, identifier: s.hub.identifier, trust: s.hub.trust, updateAvailable }
      : null;
  const may = facts.viewer.isPerson;
  const changed = origin === 'builtin' && s.changed !== null;
  const can: SkillCan = {
    edit: may && !removed,
    switch: may && !removed,
    remove: may && !removed,
    restore: may && origin === 'builtin' && (changed || removed),
    update: may && !!hub?.updateAvailable,
  };
  return {
    name,
    description: s.description,
    category: categoryOfPath(s.path),
    origin,
    hub,
    enabled: s.state === 'on',
    changed,
    originalChanged: changed && s.originalChanged,
    status: s.state,
    needs: s.needs,
    version: s.version,
    updatedAt: removed ? null : s.updatedAt,
    can,
  };
}

/** A category as Settings titles and describes it (pure). */
export const categoryInfoOf = (c: HermesSkillCategory): SkillCategoryInfo => ({
  category: c.category,
  title: skillCategoryTitle(c.category),
  description: c.description,
});

/** The skills of the person's Hermes profile, one list (CT-1570), and their categories. */
export function skillSummaries(services: Services) {
  return skillsCall(services, 'skills.list', {});
}

/** Settings → Skills: one list and Hermes's categories. */
export async function libraryView(services: Services, viewer: SkillViewer): Promise<SkillLibraryResponse> {
  const agent = await loadAgentRow(services.db, viewer.principal.burrowId);
  if (!agent) throw notFound('Agent');
  const all = await skillSummaries(services);
  const facts = libraryFacts(services, viewer);
  const items: SkillLibraryItem[] = [];
  for (const s of all.skills) {
    const item = itemOf(s, facts);
    if (item) items.push(item);
  }
  return {
    agentName: agent.name,
    items,
    categories: all.categories.slice(0, SKILL_CATEGORIES_MAX).map(categoryInfoOf),
  };
}

/** The summary of a skill by its name (one per name, CT-1571); `not_found` otherwise. */
export async function findSkill(services: Services, name: string): Promise<HermesSkillSummary> {
  const found = (await skillSummaries(services)).skills.find((s) => nameOf(s) === name);
  if (!found) throw notFound('Skill');
  return found;
}

/** The row of a skill as it is now; null when none is left. */
export async function itemNow(
  services: Services,
  viewer: SkillViewer,
  name: string,
): Promise<SkillLibraryItem | null> {
  const s = await findSkill(services, name).catch(() => null);
  return s ? itemOf(s, libraryFacts(services, viewer)) : null;
}
