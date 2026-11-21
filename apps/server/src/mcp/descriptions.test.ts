/**
 * Rules where the tool is (docs/decisions/hermes-engine.md HE-34, HE-S37): what Whombat adds to a tool's description is
 * served after the contract's words, names a real tool, and stays a sentence or two.
 */
import { NO_REPLY } from '@whombat/agent-runtime';
import { MCP_TOOLS, type McpToolName } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { ADDED_DESCRIPTIONS } from './descriptions';
import { toolEntry } from './served';

describe('what Whombat adds to its tools’ descriptions', () => {
  it('follows the contract’s words, for real tools, a sentence or two each', () => {
    for (const [name, added] of Object.entries(ADDED_DESCRIPTIONS)) {
      const def = MCP_TOOLS[name as McpToolName];
      expect(def, name).toBeDefined();
      const served = toolEntry(name as McpToolName).description ?? '';
      expect(served.startsWith(def.description), name).toBe(true);
      expect(served.endsWith(added as string), name).toBe(true);
      // The tracker's paths are a list; every other addition is short.
      if (name !== 'tracker_read') expect((added as string).length, name).toBeLessThanOrEqual(320);
    }
  });

  it('start_run says how a run’s starting turn ends, in the runner’s own word', () => {
    expect(toolEntry('start_run').description).toContain(NO_REPLY);
    expect(toolEntry('finish_run').description).toContain('asks: true');
  });

  it('leaves the other tools as the contract says them', () => {
    expect(toolEntry('post_message').description).toBe(MCP_TOOLS.post_message.description);
  });
});
