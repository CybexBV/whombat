/**
 * The skills the agent may be asked to use (contracts 2.0 CT-1410; Whombat skills-library.md SL-09, hermes-engine.md
 * HE-41; app AP-4108, AP-5206, hermes-skills.md AP-5525): what the composer offers after `/`. The message goes as typed
 * (`/name …`): Hermes reads a skill command itself, so no hint goes with it.
 */
import { skillNeedsText } from '@whombat/core/skills';
import type { SkillLibrary, SkillLibraryItem } from '../skillLibrary/contract';

/** A skill the agent may be asked to use (`/name`): a row of its library that is on. */
export interface EnabledSkill {
  name: string;
  description: string;
  /** What its front matter says it needs, in words (“Needs NOTION_API_KEY”); empty when nothing. */
  needs: string[];
}

const usable = (i: SkillLibraryItem) => i.status === 'on';

/**
 * The skills the agent may be asked to use: the ones that are on, each name once (one skills list, CT-1570). A skill
 * switched off or removed isn't offered.
 */
export function enabledSkillsOf(library: Pick<SkillLibrary, 'items'>): EnabledSkill[] {
  const seen = new Set<string>();
  const out: EnabledSkill[] = [];
  for (const item of library.items) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    if (!usable(item)) continue;
    out.push({ name: item.name, description: item.description, needs: skillNeedsText(item.needs) });
  }
  return out;
}
