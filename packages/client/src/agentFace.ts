/**
 * The agent's face (Whombat one-agent.md OA-08; contracts CT-11xx `AgentFace`; app one-agent.md AP-4901): one of the
 * five drawings (`AGENT_CHARACTERS`, keyed by the name each was drawn for), picked in setup (“Meet your agent”) and in
 * Settings → Agent. The face is the character: it decides how the agent looks and how it talks (app agent-voices.md
 * AP-5500). Shared by the web and the phone.
 */
import { AGENT_CHARACTERS, type AgentFace, agentCharacter, DEFAULT_AGENT_FACE } from '@whombat/core';

/** The drawing the agent wears: its face, else Dusty's. */
export function agentFaceOf(agent: { face?: AgentFace | null | undefined } | null | undefined): AgentFace {
  return agent?.face ?? DEFAULT_AGENT_FACE;
}

/** The chip behind a face where a surface wants one: the face's colour at 14%, never a clip of the image (FA-06). */
export function agentFaceBackground(face: AgentFace): string {
  return `color-mix(in srgb, ${agentCharacter(face).accent} 14%, transparent)`;
}

/** A face in the picker: “Neo’s face”, after the character whose drawing it is. */
export function agentFaceLabel(face: AgentFace): string {
  return `${agentCharacter(face).name}’s face`;
}

/**
 * How each character talks, in a line for the people picking one (AP-5501): shown under the faces as “**Neo** · …”.
 * The runtime's voices (Whombat `packages/agent-runtime/src/persona/voices.ts`) are the way of talking itself and
 * describe the same five: change them together.
 */
export const AGENT_FACE_STYLES: Readonly<Record<AgentFace, string>> = {
  dusty: 'Plain and friendly. Everyday words, no jargon.',
  banjo: 'Technical. Talks like an engineer, with the exact terms and numbers.',
  neo: 'Calm and a little mysterious, with the odd line from The Matrix.',
  skipper: 'An upbeat captain. Decisive, with a touch of sailing talk.',
  hazel: 'Accurate and direct. Short, friendly and straight to the point.',
};

/** What a face's character is like: “Calm and a little mysterious, with the odd line from The Matrix.” */
export function agentFaceStyle(face: AgentFace): string {
  return AGENT_FACE_STYLES[face];
}

/**
 * The name after picking `face` in setup (AP-5502): while the name is still one of the five characters' (or empty),
 * it follows the face (pick Neo → Neo); a name of someone's own stays.
 */
export function agentNameForFace(name: string, face: AgentFace): string {
  const typed = name.trim();
  if (typed && !AGENT_CHARACTERS.some((c) => c.name === typed)) return name;
  return agentCharacter(face).name;
}
