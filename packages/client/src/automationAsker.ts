/**
 * An automation asking, or posting, on the web and the phone: “Approve the fix”, a branch key that asks, any step that
 * waits for a person, and the messages a run posts. Its principal is the automation's own — a system principal,
 * `system: 'automation'` — never the agent or a person, so without this it would read as “ASSESS AND FIX … IS ASKING”
 * or, where that principal isn't known yet, as “SOMEONE IS ASKING”. Pure.
 */
import type { Approval, ApprovalViewContext, Principal } from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from './i18n/catalog';
import { AUTOMATIONS_AREA_WORDS } from './i18n/messages/chatWork/automations';

const words = (locale?: string | null) => clientTree(locale, AUTOMATIONS_AREA_WORDS).asker;

/** An automation asking, in a locale (English when none): its kicker, short name and tag. */
export function automationAskerWords(locale?: string | null) {
  const w = words(locale);
  return { asking: w.asking, shortName: w.shortName, tag: w.tag };
}

/** The approval's kicker while it waits. */
export const AUTOMATION_ASKING = automationAskerWords().asking;

/** How the approval's sentences name it: “The automation won’t go ahead without a person.” */
export const AUTOMATION_SHORT_NAME = automationAskerWords().shortName;

/** The word beside an automation's name where a status would show. */
export const AUTOMATION_TAG = automationAskerWords().tag;

/** An automation's own principal. */
export const isAutomationPrincipal = (p: Principal | null | undefined): boolean =>
  p?.kind === 'system' && p.system === 'automation';

export interface AutomationAsker {
  /** The automation's name, when the approval or its principal says it. */
  name: string | null;
  /** The accessible label of its mark: “Automation “Assess and fix new issues on whombat/web””. */
  label: string;
}

/** The automation a request continues: the server's `continue “<name>”` with `data.automationId`. */
function continued(action: Approval['action']): { name: string | null } | null {
  if (action.type !== 'custom') return null;
  if (typeof action.params.data.automationId !== 'string') return null;
  // The action's name is cut at 80 characters: without its closing quote the name is incomplete.
  return { name: /^continue “(.+)”$/.exec(action.params.name)?.[1] ?? null };
}

/**
 * The automation asking, or null when a person or an agent asks. Its principal says so; where that principal isn't
 * known (not in the bootstrap yet), the action it continues does.
 */
export function automationAsker(
  approval: Pick<Approval, 'action'>,
  requester: Principal | null | undefined,
  locale?: string | null,
): AutomationAsker | null {
  const action = continued(approval.action);
  if (!isAutomationPrincipal(requester) && !(action && !requester)) return null;
  const name = action?.name ?? requester?.name ?? null;
  return { name, label: automationLabel(name, locale) };
}

/** The accessible label of an automation's mark. */
export const automationLabel = (name: string | null | undefined, locale?: string | null): string =>
  name ? interpolate(words(locale).label, { name }) : words(locale).anAutomation;

/** The names core's `approvalView` reads, with the asking automation as “The automation”. */
export function namesWithAsker(
  names: ApprovalViewContext['names'],
  requesterId: string,
  asker: AutomationAsker | null,
  locale?: string | null,
): ApprovalViewContext['names'] {
  if (!asker) return names;
  const w = words(locale);
  return (id) =>
    id === requesterId ? { name: asker.name ?? w.anAutomation, shortName: w.shortName } : names(id);
}

/**
 * The word beside an author's name in a message row: “Automation” for an automation's principal, nothing for the
 * person and the agent.
 */
export function authorStatus(p: Principal, locale?: string | null): string | null {
  return isAutomationPrincipal(p) ? words(locale).tag : null;
}
