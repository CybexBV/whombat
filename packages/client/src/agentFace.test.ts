import { AGENT_CHARACTERS, AGENT_FACES } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { agentFaceStyle, agentNameForFace } from './agentFace';

describe('the face is the character (agent-voices.md AP-5500…AP-5502)', () => {
  it('describes how every character talks', () => {
    for (const face of AGENT_FACES) expect(agentFaceStyle(face).trim()).not.toBe('');
    expect(new Set(AGENT_FACES.map(agentFaceStyle)).size).toBe(AGENT_FACES.length);
    expect(agentFaceStyle('neo')).toContain('The Matrix');
  });

  it('lets a character’s name follow the face, and keeps a name of someone’s own', () => {
    expect(agentNameForFace('Dusty', 'neo')).toBe('Neo');
    for (const c of AGENT_CHARACTERS) expect(agentNameForFace(c.name, 'hazel')).toBe('Hazel');
    expect(agentNameForFace('', 'skipper')).toBe('Skipper');
    expect(agentNameForFace('Rex', 'neo')).toBe('Rex');
    expect(agentNameForFace('Neon', 'banjo')).toBe('Neon');
  });
});
