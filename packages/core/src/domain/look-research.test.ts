import { describe, expect, it } from 'vitest';
import { LookReportInput, MCP_TOOLS, mcpToolPersonalOnly } from '../contracts/mcp.js';
import { DispatchContext, LookDispatchContext } from '../contracts/runner.js';
import { ID_PREFIXES, newId } from '../ids.js';
import { DispatchTrigger, SummaryTrigger, summaryTrigger } from './dispatch.js';
import { LookResearch } from './look-research.js';

describe('the assistant looks first (3.5; Whombat look-research.md)', () => {
  it('wakes with look and look_fix, which clients read as notify and mention', () => {
    expect(DispatchTrigger.options).toEqual(expect.arrayContaining(['look', 'look_fix']));
    expect(SummaryTrigger.options).not.toContain('look');
    expect(SummaryTrigger.options).not.toContain('look_fix');
    expect(summaryTrigger('look')).toBe('notify');
    expect(summaryTrigger('look_fix')).toBe('mention');
  });

  it('carries the look in the turn, with the step a press lets it take', () => {
    const look: LookDispatchContext = {
      key: 'connection:con_ha0000000001',
      kind: 'connection',
      name: 'Home Assistant',
      state: 'bad',
      reason: 'Zigbee isn’t loading.',
      check: 'ha.integrations',
      since: '2026-10-27T13:00:00Z',
      connection: 'home-assistant',
      access: 'manage',
      found: { title: 'Zigbee stopped', summary: 'It stopped after the update.' },
      step: { label: 'Restart Zigbee', step: 'Reload the ZHA integration and check its devices answer.' },
    };
    expect(DispatchContext.shape.look.parse(look)).toEqual(look);
    expect(DispatchContext.shape.look.parse(null)).toBeNull();
    expect(LookDispatchContext.safeParse({ ...look, state: 'fine' }).success).toBe(false);
    expect(
      LookDispatchContext.safeParse({ ...look, step: { label: 'x'.repeat(33), step: 'y' } }).success,
    ).toBe(false);
  });

  it('serves look_report with a strict input, never a step on a fixed look', () => {
    expect(MCP_TOOLS.look_report.requiredKey).toBeNull();
    expect(mcpToolPersonalOnly('look_report')).toBe(true);
    const found = { title: 'Zigbee stopped', summary: 'It stopped.', fixed: false };
    expect(LookReportInput.safeParse(found).success).toBe(true);
    expect(
      LookReportInput.safeParse({ ...found, fix: { label: 'Restart Zigbee', step: 'Reload ZHA.' } }).success,
    ).toBe(true);
    expect(
      LookReportInput.safeParse({
        ...found,
        fixed: true,
        fix: { label: 'Restart Zigbee', step: 'Reload ZHA.' },
      }).success,
    ).toBe(false);
    expect(LookReportInput.safeParse({ ...found, extra: 1 }).success).toBe(false);
    expect(LookReportInput.safeParse({ ...found, title: 'x'.repeat(81) }).success).toBe(false);
    expect(LookReportInput.safeParse({ ...found, summary: 'x'.repeat(241) }).success).toBe(false);
    expect(LookReportInput.safeParse({ ...found, fix: { label: 'x'.repeat(33), step: 'y' } }).success).toBe(
      false,
    );
  });

  it('has an id kind of its own', () => {
    expect(ID_PREFIXES.lookResearch).toBe('lkr');
    expect(newId('lookResearch')).toMatch(/^lkr_/);
    expect(
      LookResearch.safeParse({ key: 'server:pve-02', state: 'looking', at: '2026-10-27T13:00:00Z' }).success,
    ).toBe(true);
  });
});
