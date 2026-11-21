/** Contracts 0.123.0, rebuilt: the multi-agent leftovers other streams found (CT-1137, CT-1140…CT-1144; Whombat one-agent.md). */
import { describe, expect, it } from 'vitest';
import * as automations from '../automations/index.js';
import { MCP_TOOLS } from '../contracts/mcp.js';
import { STEP_KIND_LABELS } from './automation.js';
import { DESK_BOX_PARTS, DESK_WORDS, deskMayDecide } from './desk.js';
import { WorkAction, WorkItem } from './work.js';

/** Every string in a nested words object. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

describe('no handoffs on Work items (CT-1137, OA-06, OA-14)', () => {
  it('has no handoff and no step-owner actions', () => {
    expect(Object.keys(WorkItem.shape)).not.toContain('handoff');
    expect(WorkAction.options).not.toContain('reassign_step');
    expect(WorkAction.options).not.toContain('ask_for_report');
  });
});

describe('the desk names the one agent (CT-1140, OA-23)', () => {
  it('calls the storage part the agent’s, by name', () => {
    expect(DESK_BOX_PARTS).toEqual(['whombat', 'agent']);
    expect(DESK_WORDS.box.parts.agent).toContain('{assistant}');
  });

  it('says a key goes to the agent by name', () => {
    const decision = deskMayDecide({
      action: { type: 'grant_key', params: { keyId: 'tests.run' } },
      keyId: 'tests.run',
    });
    expect(decision).toEqual({ ok: false, reason: 'keys' });
    expect(DESK_WORDS.phoneReasons.keys).toContain('{assistant}');
  });

  it('never says agents', () => {
    for (const s of strings(DESK_WORDS)) expect(s, s).not.toMatch(/\bagents\b/i);
  });
});

describe('plain words for the one agent (CT-1142)', () => {
  it('asks the agent in an automation step', () => {
    expect(STEP_KIND_LABELS.dispatch_agent).not.toMatch(/\ban agent\b/);
  });

  it('tells the agent whose mail and calendar it works with: the person’s, not an owner’s', () => {
    for (const tool of Object.values(MCP_TOOLS))
      expect(tool.description, tool.name).not.toMatch(/your owner|owner’s DM/);
  });

  it('has no template check left (CT-1141)', () => {
    expect(Object.keys(automations)).not.toContain('templateParamsProblem');
  });
});
