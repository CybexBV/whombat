/**
 * The device skill card on the phone (mock 3; Whombat one-whombat.md ONE-16…ONE-19; one-whombat-mobile.md
 * AP-1368…AP-1371): what the agent can read, with the values from its read-only test, and every action with Off · Ask me ·
 * Allowed. Nothing changes on the device until you press Switch on. Pure; the card is `ui/deviceSkillCard.tsx`.
 */
import type { AgentWords } from '@whombat/client';
import {
  DEVICE_SKILL_COPY,
  DEVICE_TIER_LABELS,
  type DeviceActionChoice,
  type DeviceSkillCard,
  limitText,
} from '@whombat/core';

export type DeviceTier = DeviceActionChoice['tier'];

/** The tiers in the card's order (mock 3: Off · Ask me · Allowed). */
export const DEVICE_TIERS: readonly DeviceTier[] = ['off', 'ask', 'can'];

/** The card's own words besides the contracts' (`DEVICE_SKILL_COPY`). Mock 3 copy where the mock has one. */
export const DEVICE_CARD_COPY = {
  newSkill: 'New skill · reads only, until you allow more',
  tested: 'Tested on your unit',
  mayChange: 'What I may change',
  /** The tier control's name for TalkBack: “What Neo may do with Room temperature” (assistant-name-mobile.md AP-1534). */
  tiersLabel: (action: string, w: AgentWords) => `What ${w.name} may do with ${action}`,
} as const;

export interface DeviceReadingView {
  key: string;
  label: string;
  value: string;
}

export interface DeviceActionView {
  key: string;
  label: string;
  /** “Only between 16 and 24 °C” from the proposed limits, else the action's description. */
  sub: string;
  sensitive: boolean;
}

export interface DeviceSkillView {
  title: string;
  /** “New skill · reads only, until you allow more”; “Switched on”; “Not switched on”. */
  sub: string;
  /** “Tested on your unit” while proposed. */
  badge: string | null;
  readings: DeviceReadingView[];
  /** “+ 3 more” (mock 3), or null. */
  more: string | null;
  actions: DeviceActionView[];
  /** Waiting for you: the tiers can be changed, Switch on and Not now show. */
  open: boolean;
  /** Decided: `on` (ok) or `declined` (muted). */
  status: DeviceSkillCard['status'];
  label: string;
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function deviceSkillView(card: DeviceSkillCard): DeviceSkillView {
  const open = card.status === 'proposed';
  const sub =
    card.status === 'on'
      ? DEVICE_SKILL_COPY.on
      : card.status === 'declined'
        ? DEVICE_SKILL_COPY.declined
        : DEVICE_CARD_COPY.newSkill;
  const actions = card.actions.map((a) => {
    const limit = a.proposed.limits ? limitText(a.proposed.limits, a.unit) : null;
    return {
      key: a.key,
      label: a.label,
      sub: limit ? capitalize(limit) : a.description,
      sensitive: !!a.sensitive,
    };
  });
  return {
    title: card.name,
    sub,
    badge: open ? DEVICE_CARD_COPY.tested : null,
    readings: card.readings.map((r) => ({
      key: r.key,
      label: r.label,
      value: r.unit ? `${r.value} ${r.unit}` : r.value,
    })),
    more: card.moreReadings > 0 ? `+ ${card.moreReadings} more` : null,
    actions,
    open,
    status: card.status,
    label: `${card.name}. ${sub}.`,
  };
}

/** The tiers the card starts with: your choices once decided, else Whombat's proposal. */
export function initialTiers(card: DeviceSkillCard): Record<string, DeviceTier> {
  const out: Record<string, DeviceTier> = {};
  for (const a of card.actions) out[a.key] = card.decided?.[a.key]?.tier ?? a.proposed.tier;
  return out;
}

/** A tier's words (“Ask me”). */
export function tierLabel(tier: DeviceTier): string {
  return DEVICE_TIER_LABELS[tier];
}

/**
 * The decision's body (`deviceSkills.decide`, AP-1369): each action's chosen tier with the agent's proposed limits — the
 * phone shows the limits and doesn't change them (the web does) — and whether to switch on now.
 */
export function decideBody(
  card: DeviceSkillCard,
  tiers: Readonly<Record<string, DeviceTier>>,
  switchOn: boolean,
): { actions: Record<string, DeviceActionChoice>; switchOn: boolean } {
  const actions: Record<string, DeviceActionChoice> = {};
  for (const a of card.actions) {
    const tier = tiers[a.key] ?? a.proposed.tier;
    actions[a.key] = a.proposed.limits ? { tier, limits: a.proposed.limits } : { tier };
  }
  return { actions, switchOn };
}
