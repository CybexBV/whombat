/**
 * Settings → Agent (Whombat one-agent.md OA-09; app one-agent.md AP-4923): the one agent's page, in parts (`&part=`) —
 * its name and face, its model and AI sign-in, its keys, notes, what it runs on the Whombat (one-person.md AP-5690),
 * schedules and spend (its skills are Settings → Skills again, hermes-skills.md AP-5530). Pure: the parts, which ones
 * show, and the old addresses' tabs.
 */
import { NOTES_COPY, SCHEDULE_COPY } from '@whombat/core/domain';
import { SERVICES_TEXT } from './settings/services';

export type AgentPart = 'profile' | 'model' | 'keys' | 'notes' | 'services' | 'schedules' | 'spend';

/** The parts in their order: who it is, what it runs on and may do, what it knows, what it runs, what it cost. */
export const AGENT_PARTS: readonly { key: AgentPart; label: string }[] = [
  { key: 'profile', label: 'Name and character' },
  { key: 'model', label: 'Model and AI' },
  { key: 'keys', label: 'Keys' },
  // What it wrote down about how things work here (RA-21), core's `NOTES_COPY.tab`.
  { key: 'notes', label: NOTES_COPY.tab },
  // What it keeps running on the Whombat as containers (OP-19; AP-5690): it replaced the computer.
  { key: 'services', label: SERVICES_TEXT.tab },
  // Turns it scheduled for itself (RA-30), core's `SCHEDULE_COPY.tab`.
  { key: 'schedules', label: SCHEDULE_COPY.tab },
  { key: 'spend', label: 'Spend' },
];

const PART_KEYS = new Set<string>(AGENT_PARTS.map((p) => p.key));

/** `&part=` of `?tab=agent`: a part other than Name and character; anything else is dropped. */
export function validateAgentPart(raw: unknown): Exclude<AgentPart, 'profile'> | undefined {
  return typeof raw === 'string' && PART_KEYS.has(raw) && raw !== 'profile'
    ? (raw as Exclude<AgentPart, 'profile'>)
    : undefined;
}

/** `&key=`: a key row Keys scrolls to and highlights (a skill's “Turn on …” link, AP-250). */
export function validateAgentKey(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(raw) ? raw : undefined;
}

/**
 * The part an old agent settings address opened (`/agents/<agent>/settings?tab=`, AP-380): Access is Keys now, the
 * tabs that went (Profile, Danger zone) open Name and character.
 */
export function agentPartOfTab(tab: unknown): Exclude<AgentPart, 'profile'> | undefined {
  return tab === 'access' ? 'keys' : validateAgentPart(tab);
}

export interface PartAvailability {
  /** The viewer may see the agent's spend (`spend.agent` answered). */
  spend: boolean;
  /** The host answered (`host.info`): it says whether the agent's services can run there (CT-1534, AP-5690). */
  services: boolean;
}

/** The parts that show, in order. */
export function agentParts(a: PartAvailability): AgentPart[] {
  return AGENT_PARTS.map((p) => p.key).filter((key) => {
    if (key === 'spend') return a.spend;
    if (key === 'services') return a.services;
    return true;
  });
}

/** The part to show: the asked-for one when this Whombat has it, Name and character otherwise. */
export function resolvePart(asked: AgentPart | undefined, parts: readonly AgentPart[]): AgentPart {
  return asked && parts.includes(asked) ? asked : 'profile';
}
