/**
 * The agent's skills on the phone (Settings → Skills; Whombat all-skills.md SK-18, hermes-engine.md HE-41,
 * hermes-skills.md HSK-12; app all-skills.md AP-2360…, hermes-engine-app.md AP-5273…AP-5276, hermes-skills.md
 * AP-5570…AP-5575; one-person-android.md AP-5765): where they show, the phone's own words around the shared model
 * (`@whombat/client/skill-library`'s `skillLibraryView` and `skillPanel` draw the same groups, lines and actions as the
 * web), a row's TalkBack words, and what each action asks first — Restore Hermes's, Remove (a built-in until restored,
 * a hub skill for good, one the agent learned). One list; a skill is its name. No editor, Compare, Update or Add skills
 * here: those are the web's (AP-5574). Pure.
 */

import {
  removeAsk,
  SKILL_LIBRARY_TEXT,
  type SkillPanelModel,
  type SkillRow,
} from '@whombat/client/skill-library';

/**
 * Whether the phone shows the agent's skills (AP-2360, AP-4967, AP-5273): wherever the agent is known (every Whombat keeps
 * Hermes's skills, HE-52). Elsewhere the Skills screen says they are on the web.
 */
export function skillLibraryHere(here: { agent: boolean }): boolean {
  return here.agent;
}

/** The phone's words around the shared ones (`SKILL_LIBRARY_TEXT`). */
export const SKILLS_PHONE_TEXT = {
  /** Settings' row, the skill screen's back button. */
  title: 'Skills',
  loading: 'Loading skills',
  failed: 'Skills didn’t load.',
  loadingSkill: 'Loading the skill',
  skillFailed: 'This skill didn’t load.',
  gone: 'This skill isn’t there any more.',
  /** Opened where the phone has no library (no agent yet, a link). */
  onWeb: 'Skills are on the web, in Settings → Skills.',
  /** The open skill's switch row. */
  switchHint: (name: string, agent: string, on: boolean) =>
    `Switches ${name} ${on ? 'off' : 'on'} for ${agent}`,
  files: 'FILES',
  opens: 'Opens the skill',
  foldHint: (open: boolean) => (open ? 'Hides these skills' : 'Shows these skills'),
  cancel: 'Cancel',
  failedChange: 'That didn’t change. Try again in a moment.',
} as const;

/**
 * A row's TalkBack words: name, what it does, where it came from when it isn't one of Hermes's own, its status
 * (“canvas. Fetch Canvas LMS courses…. Added from Hermes. Needs CANVAS_API_TOKEN and CANVAS_BASE_URL”).
 */
export function skillRowLabel(row: Pick<SkillRow, 'item' | 'status' | 'origin'>): string {
  return [row.item.name, row.item.description, row.origin, row.status]
    .filter(Boolean)
    .map((s) => (s as string).replace(/\.$/, ''))
    .join('. ');
}

/**
 * A question before an action: its title (the question itself: Android's dialog shows a title on two lines at most),
 * what follows it, its button and whether the button is destructive.
 */
export interface SkillConfirm {
  title: string;
  body: string | null;
  action: string;
  destructive: boolean;
}

/** “Remove x? Neo forgets it.” → the question as the title, the rest under it. */
export function splitQuestion(text: string): { title: string; body: string | null } {
  const at = text.indexOf('? ');
  if (at < 0) return { title: text, body: null };
  return { title: text.slice(0, at + 1), body: text.slice(at + 2).trim() || null };
}

/** Restore Hermes's question: a changed built-in loses its changes, a removed one comes back. */
export function restoreConfirm(
  panel: Pick<SkillPanelModel, 'name'>,
  removed: boolean,
  agent: string,
): SkillConfirm {
  const T = SKILL_LIBRARY_TEXT;
  return {
    ...splitQuestion(removed ? T.restoreRemovedAsk(panel.name, agent) : T.restoreAsk(panel.name)),
    action: T.restore,
    destructive: !removed,
  };
}

/** Remove's question, by what removing does (`removeKind`). */
export function removeConfirm(
  panel: Pick<SkillPanelModel, 'name' | 'removeKind'>,
  agent: string,
): SkillConfirm | null {
  if (!panel.removeKind) return null;
  return {
    ...splitQuestion(removeAsk(panel.removeKind, panel.name, agent)),
    action: SKILL_LIBRARY_TEXT.remove,
    destructive: true,
  };
}
