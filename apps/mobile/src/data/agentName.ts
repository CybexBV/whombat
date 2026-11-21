/**
 * Settings → Agent → Name and character on the phone (Whombat one-agent.md OA-08, OA-09; app one-agent.md AP-4924,
 * AP-4966): the agent's name with Save — checked as the server does, the reserved “Whombat” and the form, no “taken”
 * (there is no other agent) and no “Suggest a name” (the name pools went) — and its five faces (`AGENT_FACES`), a pick
 * saves. Who it is (`theAgentOf`) and the words that mean it (`agentWords`: “Ask Neo…”, “your agent” while none is
 * known) are `@whombat/client`'s, the web's too. Pure.
 */
import { type AgentWords, agentFaceLabel, agentFaceStyle } from '@whombat/client';
import {
  AGENT_FACES,
  AGENT_NAME_FORM_TEXT,
  AGENT_NAME_PATTERN,
  AGENT_NAME_RESERVED_TEXT,
  type AgentFace,
  agentCharacter,
  isReservedAgentName,
} from '@whombat/core';

/**
 * Name and character's words (the web's Profile part, AP-4924): the face is the character, how the agent looks and
 * talks (agent-voices.md AP-5500), from the agent's next reply on (AP-5504).
 */
export const NAME_AND_FACE_TEXT = {
  name: 'NAME',
  save: 'Save',
  face: 'Character',
  faceLine: (w: AgentWords) => `How ${w.name} looks and talks.`,
} as const;

/** The line under the faces (AP-5501): the picked character's name, shown bold, and how it talks. */
export function characterLine(face: AgentFace): { name: string; style: string } {
  return { name: agentCharacter(face).name, style: agentFaceStyle(face) };
}

/** One of the five faces in the picker: its key, “Neo’s face”, whether the agent wears it. */
export interface FaceChoice {
  key: AgentFace;
  label: string;
  selected: boolean;
}

/** The five faces in `AGENT_FACES` order, the one it wears now (or is being given) selected. */
export function faceChoices(wears: AgentFace, picked?: AgentFace | null): FaceChoice[] {
  const shown = picked ?? wears;
  return AGENT_FACES.map((key) => ({ key, label: agentFaceLabel(key), selected: key === shown }));
}

/** The name from the field: trimmed. */
export function cleanAgentName(draft: string): string {
  return draft.trim();
}

/** Whether Save does anything: a name that isn't the one it has. */
export function canSaveName(draft: string, current: string): boolean {
  const name = cleanAgentName(draft);
  return name.length > 0 && name !== current;
}

/**
 * What is wrong with a new name before it is sent, in the server's own words: not “Whombat”
 * (`AGENT_NAME_RESERVED_TEXT`), one capitalised word (`AGENT_NAME_FORM_TEXT`). The server checks again on save.
 */
export function agentNameProblem(draft: string): string | null {
  const name = cleanAgentName(draft);
  if (isReservedAgentName(name)) return AGENT_NAME_RESERVED_TEXT;
  if (!AGENT_NAME_PATTERN.test(name)) return AGENT_NAME_FORM_TEXT;
  return null;
}

/** The field's message for a refusal of `agent.update`: the server's words for `name` (or `face`), else its message. */
export function updateRefusalText(
  error: { fields?: Record<string, readonly string[]>; message?: string } | null | undefined,
  field: 'name' | 'face',
): string | null {
  if (!error) return null;
  const fields = error.fields ?? {};
  const first = (fields[field] ?? fields[`body.${field}`])?.[0];
  return first ?? (error.message?.trim() || null);
}
