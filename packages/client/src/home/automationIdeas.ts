/**
 * What the Automations page suggests making (Whombat care-plan.md; the review's flows.md 5.1): a few things that would
 * happen on their own with what this Whombat has connected — its servers, mail, Home Assistant, photos — instead of the
 * same fixed examples for everyone. A tap puts the words in the field; the assistant then proposes the automation. Each
 * idea is something an automation can do today: on a schedule, or when someone Find My shows gets home. Pure; web and
 * phone share it.
 */
import type { ThingSummary } from '@whombat/core';
import { findMyFirstName } from '../hosts/findmy';

/** At most this many ideas under the field. */
export const AUTOMATION_IDEAS_MAX = 3;

/** What the ideas know beside the things: who a Find My connection's last read has at Home, by name. */
export interface AutomationIdeasInput {
  findMyHome?: readonly string[];
}

/** “Tell me when Mara gets home”: a Find My idea for one person, by first name; someone when nobody is known yet. */
export function findMyHomeIdea(name: string | null): string {
  return `Tell me when ${name ? findMyFirstName(name) : 'someone'} gets home`;
}

type Thing = Pick<ThingSummary, 'kind' | 'catalogId' | 'name' | 'partOf'>;

/** Ideas when nothing is connected, or to fill up: ordinary, everyday ones. */
const EVERYDAY = [
  'Each morning, tell me the weather and what’s on today',
  'Every Friday, remind me what’s still open this week',
  'Every Sunday evening, plan my week with me',
] as const;

/**
 * One idea per kind of thing, in the order a person would want them; Find My one per person it has seen at Home, or one
 * for someone when its last read isn't known.
 */
function ideasOf(things: readonly Thing[], input: AutomationIdeasInput): string[] {
  const of = (ids: readonly string[]) =>
    things.find((t) => t.kind === 'connection' && t.catalogId && ids.includes(t.catalogId));
  const server = things.find((t) => t.kind === 'server' && !t.partOf);
  const mail = of(['google', 'gmail', 'microsoft', 'imap']);
  const homeAssistant = of(['homeassistant']);
  const photos = of(['immich']);
  const media = of(['plex', 'sonarr', 'radarr']);
  const network = of(['unifi_network', 'pihole', 'adguard', 'opnsense']);
  const storage = of(['synology', 'qnap', 'truenas', 'unraid']);
  const code = of(['github', 'gitlab', 'forgejo']);
  const findMy = of(['findmy']);
  const home = input.findMyHome ?? [];
  return [
    ...(mail ? ['Each morning, sum up my new mail'] : []),
    ...(findMy ? (home.length ? home.map(findMyHomeIdea) : [findMyHomeIdea(null)]) : []),
    ...(server ? [`Every Monday, tell me how ${server.name} is doing`] : []),
    ...(homeAssistant ? ['Each night at 23:00, tell me if a light is still on'] : []),
    ...(storage ? [`Every Sunday, check ${storage.name} has enough room`] : []),
    ...(photos ? ['Every Sunday, tell me how many photos were added'] : []),
    ...(media ? ['Each Friday, what’s new to watch'] : []),
    ...(network ? ['Each morning, tell me about new devices on my network'] : []),
    ...(code ? ['Every Monday, sum up last week’s issues'] : []),
  ];
}

/** The ideas under the Automations field: from what is connected first, then everyday ones. */
export function automationIdeas(
  things: readonly Thing[],
  max = AUTOMATION_IDEAS_MAX,
  input: AutomationIdeasInput = {},
): string[] {
  const out: string[] = [];
  for (const idea of [...ideasOf(things, input), ...EVERYDAY]) {
    if (out.length >= max) break;
    if (!out.includes(idea)) out.push(idea);
  }
  return out;
}
