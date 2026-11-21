/** The agent's name and face on the phone (one-agent.md AP-4966). */
import { agentFaceStyle, agentWords } from '@whombat/client';
import { AGENT_NAME_FORM_TEXT, AGENT_NAME_RESERVED_TEXT } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  agentNameProblem,
  canSaveName,
  characterLine,
  faceChoices,
  NAME_AND_FACE_TEXT,
  updateRefusalText,
} from './agentName';
import { agentParts } from './agentPage';
import { CHATS_COPY } from './chats';

describe('what the agent is called (AP-4966)', () => {
  it('says its name in the phone’s boxes, else “your agent”, never “Whombat”', () => {
    const named = agentWords('Neo');
    expect([named.askShort, named.reply, CHATS_COPY.newChatField(named)]).toEqual([
      'Ask Neo…',
      'Reply to Neo…',
      'Ask Neo',
    ]);
    expect(agentWords(null).name).toBe('your agent');
    expect(NAME_AND_FACE_TEXT.faceLine(named)).toContain('Neo');
  });
});

describe('the character (agent-voices.md AP-5500, AP-5501)', () => {
  it('calls the face a character, and says how the picked one talks', () => {
    expect(NAME_AND_FACE_TEXT.face).toBe('Character');
    expect(agentParts('Rex').find((p) => p.key === 'profile')?.label).toBe('Name and face');
    expect(NAME_AND_FACE_TEXT.faceLine(agentWords('Rex'))).toMatch(/^How Rex looks and talks\./);
    expect(characterLine('skipper')).toEqual({ name: 'Skipper', style: agentFaceStyle('skipper') });
    expect(characterLine('neo').style).toContain('The Matrix');
  });
});

describe('Name and character (AP-4966)', () => {
  it('offers the five faces in the contracts’ order, the one it wears selected', () => {
    expect(faceChoices('neo').map((f) => [f.key, f.label, f.selected])).toEqual([
      ['dusty', 'Dusty’s face', false],
      ['banjo', 'Banjo’s face', false],
      ['neo', 'Neo’s face', true],
      ['skipper', 'Skipper’s face', false],
      ['hazel', 'Hazel’s face', false],
    ]);
    // A face just picked shows at once.
    expect(faceChoices('neo', 'skipper').find((f) => f.selected)?.key).toBe('skipper');
  });

  it('saves only a different name, and checks it as the server does: the box’s name and the form, nothing taken', () => {
    expect(canSaveName('Neo', 'Neo')).toBe(false);
    expect(canSaveName('  ', 'Neo')).toBe(false);
    expect(canSaveName(' Rex ', 'Neo')).toBe(true);
    expect(agentNameProblem('Rex')).toBeNull();
    expect(agentNameProblem('whombat')).toBe(AGENT_NAME_RESERVED_TEXT);
    expect(agentNameProblem('rex')).toBe(AGENT_NAME_FORM_TEXT);
    expect(agentNameProblem('Rex Junior')).toBe(AGENT_NAME_FORM_TEXT);
    // A person's first name is no problem: there is no other agent to clash with.
    expect(agentNameProblem('Joris')).toBeNull();
  });

  it('shows the server’s words for a refused field under it', () => {
    const message = 'Use one word.';
    expect(updateRefusalText({ fields: { name: [message] }, message: 'Invalid' }, 'name')).toBe(message);
    expect(updateRefusalText({ fields: { 'body.face': [message] } }, 'face')).toBe(message);
    expect(updateRefusalText({ fields: {}, message: 'Not now.' }, 'face')).toBe('Not now.');
    expect(updateRefusalText(null, 'name')).toBeNull();
  });
});
