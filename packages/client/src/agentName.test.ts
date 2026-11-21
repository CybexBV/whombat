import { AGENT_FACES } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { agentFaceLabel } from './agentFace';
import { agentWords, theAgentOf } from './agentName';

describe('the agent (one-agent.md AP-4900)', () => {
  it('is the one agent that isn’t a system actor', () => {
    const principals = [
      { id: 'prn_john', kind: 'person' },
      { id: 'prn_github', kind: 'system', system: 'github' },
      { id: 'prn_dusty', kind: 'agent', system: null },
    ];
    expect(theAgentOf(principals)?.id).toBe('prn_dusty');
    expect(theAgentOf(undefined)).toBeUndefined();
  });

  it('is called by its name, and “your agent” until it is known, never “Whombat”', () => {
    const w = agentWords('Dusty');
    expect([w.ask, w.reply, w.askShort]).toEqual(['Ask Dusty', 'Reply to Dusty…', 'Ask Dusty…']);
    expect(w.renamed('Rex')).toContain('Rex');
    const unknown = agentWords(undefined);
    expect([unknown.name, unknown.Name]).toEqual(['your agent', 'Your agent']);
    expect(JSON.stringify({ ...unknown, renamed: null })).not.toContain('Whombat');
  });

  it('labels each face after its character', () => {
    expect(AGENT_FACES.map(agentFaceLabel)).toHaveLength(5);
    expect(agentFaceLabel('neo')).toBe('Neo’s face');
  });
});
