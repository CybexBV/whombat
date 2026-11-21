/** Tracker reports through automations: tools, operations, samples and the key (0.69, CT-325). */
import { describe, expect, it } from 'vitest';
import { AUTOMATION_KEYS, AutomationGrant } from '../domain/automation.js';
import { AUTOMATION_ONLY_KEYS, KEY_CATALOG } from '../keys/catalog.js';
import { decide } from '../keys/engine.js';
import { ALL_KEY_OPTIONS, ALWAYS_ON_KEYS } from '../keys/grants.js';
import { AutomationSample, automationEndpoints } from './automations.js';
import { api } from './index.js';
import {
  FEEDBACK_ONLY_TOOL_NAMES,
  MCP_TOOLS,
  mcpRequiredKey,
  TRACKER_RUN_TOOL_NAMES,
  WHOMBAT_TOOL_NAMES,
} from './mcp.js';
import { DispatchContext, TrackerDispatchContext } from './runner.js';
import { TrackerUpdateBody } from './tracker.js';

const REPORT = '0190f3c2-7b1e-7c3a-9f00-123456789abc';
const REQUEST = '6c1d1f0e-9a3b-4c2d-8e7f-0a1b2c3d4e5f';

describe('the tools of a tracker run (TA-09, TA-10)', () => {
  it('reads the run’s report and the reporting organization, read-only and without a key', () => {
    expect(TRACKER_RUN_TOOL_NAMES).toEqual(['tracker_item', 'tracker_read']);
    for (const name of TRACKER_RUN_TOOL_NAMES) {
      expect(MCP_TOOLS[name], name).toMatchObject({ name, readOnly: true, requiredKey: null });
      expect(mcpRequiredKey(name, {}), name).toBeNull();
      expect(FEEDBACK_ONLY_TOOL_NAMES, name).not.toContain(name);
      expect(WHOMBAT_TOOL_NAMES, name).toContain(name);
    }
    expect(MCP_TOOLS.tracker_item.input.parse({})).toEqual({});
    expect(MCP_TOOLS.tracker_item.input.parse({ diagnostics: 'devices-2026-10-10' })).toEqual({
      diagnostics: 'devices-2026-10-10',
    });
    expect(MCP_TOOLS.tracker_item.input.safeParse({ diagnostics: '../x' }).success).toBe(false);
    expect(MCP_TOOLS.tracker_item.description).toContain('Never the reporter’s name or email');
    expect(
      MCP_TOOLS.tracker_item.output.parse({ status: 'ok', text: 'Bug report #15', cut: false }),
    ).toMatchObject({ status: 'ok', cut: false });
    expect(MCP_TOOLS.tracker_read.input.safeParse({ path: '/v1/devices?limit=5' }).success).toBe(true);
    expect(MCP_TOOLS.tracker_read.input.safeParse({ path: 'https://evil.example/v1/x' }).success).toBe(false);
    expect(
      MCP_TOOLS.tracker_read.output.parse({
        status: 'ok',
        httpStatus: 200,
        body: { devices: [] },
        cut: false,
      }),
    ).toMatchObject({ status: 'ok', httpStatus: 200 });
  });
});

describe('a tracker run’s turns (TA-09, TA-10)', () => {
  it('say which report, and whether the organization is open to the step', () => {
    const granted = TrackerDispatchContext.parse({
      connection: 'Acme Desk dev',
      number: 15,
      access: {
        state: 'granted',
        scopes: ['reports:assess'],
        expiresAt: '2026-10-10T09:00:00.000Z',
        reason: null,
      },
    });
    expect(granted.access?.state).toBe('granted');
    expect(
      TrackerDispatchContext.parse({ connection: 'Acme Desk dev', number: 15, access: null }).access,
    ).toBeNull();
    expect(DispatchContext.shape.tracker.parse(undefined)).toBeUndefined();
  });
});

describe('people act on the report (TA-14, TA-15)', () => {
  it('reads and answers it per run', () => {
    expect(api.tracker.item).toMatchObject({
      id: 'tracker.item',
      method: 'GET',
      path: '/burrows/:burrow/trackers/runs/:runId/item',
    });
    expect(api.tracker.update).toMatchObject({ id: 'tracker.update', method: 'POST' });
    expect(api.tracker.item.params.parse({ burrow: 'acme', runId: 'arn_7' })).toEqual({
      burrow: 'acme',
      runId: 'arn_7',
    });
  });

  it('takes a reply and/or a status with the client’s request id; Not planned needs a reply', () => {
    expect(TrackerUpdateBody.parse({ requestId: REQUEST, status: 'in_progress' })).toEqual({
      requestId: REQUEST,
      status: 'in_progress',
    });
    expect(TrackerUpdateBody.safeParse({ requestId: REQUEST, message: 'We’re on it.' }).success).toBe(true);
    const problems = (body: unknown) => {
      const r = TrackerUpdateBody.safeParse(body);
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    expect(problems({ requestId: REQUEST })).toEqual(['Write a reply or choose a status.']);
    expect(problems({ requestId: REQUEST, status: 'not_planned' })).toEqual([
      'Tell the reporter why when it isn’t planned: write a reply.',
    ]);
    expect(problems({ requestId: REQUEST, status: 'available', message: 'Out now' })).toHaveLength(1);
    expect(problems({ requestId: 'again', message: 'Hi' })).toEqual(['Expected a request id (a UUID)']);
  });
});

describe('trying it on a report (TA-19)', () => {
  it('lists reports beside issues and pull requests, and runs a test on one', () => {
    const report = {
      kind: 'report',
      connectionId: 'con_trackerdev',
      reportId: REPORT,
      number: 15,
      title: 'The rollout never finishes',
      type: 'bug',
      organization: 'HollowMere College',
      openedAt: '2026-10-10T08:00:00.000Z',
    };
    expect(AutomationSample.parse(report)).toEqual(report);
    const issue = {
      kind: 'issue',
      repo: 'acme/web',
      number: 7,
      title: 'Totals round twice',
      author: 'mara',
      url: 'https://github.com/acme/web/issues/7',
      draft: false,
      openedAt: '2026-10-10T08:00:00.000Z',
    };
    expect(AutomationSample.parse(issue)).toEqual(issue);
    const body = automationEndpoints.runNow.body;
    expect(body.parse({ test: true, sample: { reportId: REPORT } }).sample).toEqual({ reportId: REPORT });
    expect(body.parse({ test: true, sample: { number: 7 } }).sample).toEqual({ number: 7 });
    expect(body.safeParse({ test: true, sample: { reportId: 'a report' } }).success).toBe(false);
  });
});

describe('the key “Update reports” (TA-12)', () => {
  it('is an automation key only automations hold, scoped to connections', () => {
    expect(AUTOMATION_KEYS).toContain('report.update');
    expect(KEY_CATALOG['report.update']).toMatchObject({
      label: 'Update reports',
      description:
        'Write an assessment and a priority on a customer’s report in its tracker. The reporter doesn’t see them.',
      agentMaxTier: 'can',
      automationsOnly: true,
    });
    expect(AUTOMATION_ONLY_KEYS).toEqual(['report.update', 'report.reply']);
    expect(ALWAYS_ON_KEYS).not.toContain('report.update');
    expect(ALL_KEY_OPTIONS.map((o) => o.keyId)).not.toContain('report.update');
    expect(
      AutomationGrant.parse({ keyId: 'report.update', tier: 'can', connections: ['con_trackerdev'] })
        .connections,
    ).toEqual(['con_trackerdev']);
    // The grant's connections are a scope the engine checks, as repos are for `pr.comment`.
    const automation = { id: 'prn_auto', kind: 'agent' as const };
    const grants = [
      {
        agentId: 'prn_auto',
        keyId: 'report.update' as const,
        tier: 'can' as const,
        scope: { connections: ['con_trackerdev'] },
      },
    ];
    expect(decide(automation, grants, 'report.update', { connection: 'con_trackerdev' }).outcome).toBe(
      'allow',
    );
    expect(decide(automation, grants, 'report.update', { connection: 'con_trackerprod' }).outcome).toBe(
      'deny',
    );
    expect(decide(automation, grants, 'report.update').outcome).toBe('deny');
    expect(decide(automation, [], 'report.update').outcome).toBe('deny');
  });
});
