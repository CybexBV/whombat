/**
 * The agent's face colours (Whombat one-agent.md OA-08; the colours from five-agents.md FA-05). A Whombat has one agent
 * and it wears one of five faces; each face's `accent` and `accentDeep` are verbatim from the design handoff's
 * `agents.json` (contracts `AGENT_CHARACTERS`), the same in both themes: the art sits on any surface. `--face-<face>` is
 * the accent (a dot, the selected face's border, small markers, and a green, purple or gold accent elsewhere),
 * `--face-<face>-deep` the deep accent (text or icons on a light accent tint).
 */

/** The five faces (contracts `AGENT_FACES`), in the picker's order. */
export const FACES = ['dusty', 'banjo', 'neo', 'skipper', 'hazel'] as const;
export type Face = (typeof FACES)[number];

export interface FacePalette {
  /** The face's name, e.g. “Banjo”. */
  name: string;
  /** `accent`: a dot, the selected face's border and radio, small markers. */
  accent: string;
  /** `accentDeep`: text or icons on a light accent tint. */
  deep: string;
}

/** The five faces' colours, verbatim from `agents.json`. */
export const facePalettes: Record<Face, FacePalette> = {
  dusty: { name: 'Dusty', accent: '#8f7fc9', deep: '#6a5aa3' },
  banjo: { name: 'Banjo', accent: '#5aa37a', deep: '#3e7b58' },
  neo: { name: 'Neo', accent: '#b99346', deep: '#8d6d2d' },
  skipper: { name: 'Skipper', accent: '#c65d6e', deep: '#a33346' },
  hazel: { name: 'Hazel', accent: '#a6ad43', deep: '#74792a' },
};
