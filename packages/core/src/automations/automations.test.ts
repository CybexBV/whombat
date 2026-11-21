import { describe, expect, it, vi } from 'vitest';
import { AutomationDefinition } from '../domain/automation.js';
import { ExprError, evaluateCondition, parseExpr } from './expr.js';
import { actionHash, definitionHash } from './hash.js';
import { triggerMatches } from './match.js';
import {
  describeSchedule,
  firesBetween,
  instantsForLocal,
  isTimeZone,
  nextFireAfter,
  parseCron,
  ScheduleError,
} from './schedule.js';
import { renderJsonTemplate, renderTemplate } from './template.js';
import { buildTemplate, REPO_CHECK_ACTIONABLE } from './templates.js';
import { parseAutomationExport, triggerSummary, validateDefinition } from './validate.js';
import { parseVerdict } from './verdict.js';

const AMS = 'Europe/Amsterdam';
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const at = (s: string) => Date.parse(s);
const ctx = (anchor = 0) => ({
  timeZone: AMS,
  dst: { skipped: 'shift' as const, repeated: 'once' as const },
  anchor,
});

describe('cron parsing', () => {
  it('reads lists, ranges, steps and names', () => {
    const f = parseCron('*/15 9-17 * jan-mar mon-fri');
    expect([...f.minutes]).toEqual([0, 15, 30, 45]);
    expect(f.hours.size).toBe(9);
    expect([...f.months]).toEqual([1, 2, 3]);
    expect([...f.weekdays]).toEqual([1, 2, 3, 4, 5]);
  });
  it('treats 7 as Sunday', () => {
    expect([...parseCron('0 0 * * 7').weekdays]).toEqual([0]);
  });
  it('refuses malformed expressions with a readable message', () => {
    expect(() => parseCron('0 9 * *')).toThrow(ScheduleError);
    expect(() => parseCron('61 9 * * *')).toThrow(/out of range/);
    expect(() => parseCron('0 9 * * x')).toThrow(ScheduleError);
    expect(() => parseCron('0 9 */0 * *')).toThrow(/bad step/);
  });
});

describe('schedules in a time zone', () => {
  it('fires at local time, in UTC as the offset says', () => {
    // 09:00 in Amsterdam in September is 07:00 UTC (CEST, +02:00).
    const next = nextFireAfter({ kind: 'cron', expr: '0 9 * * *' }, at('2026-09-23T08:00:00Z'), ctx());
    expect(iso(next)).toBe('2026-09-24T07:00:00.000Z');
    // In winter the same local time is 08:00 UTC (+01:00).
    const winter = nextFireAfter({ kind: 'cron', expr: '0 9 * * *' }, at('2026-12-01T12:00:00Z'), ctx());
    expect(iso(winter)).toBe('2026-12-02T08:00:00.000Z');
  });

  it('weekday schedules skip the weekend', () => {
    // Friday 25 Sep 2026 after 9:00 → Monday 28 Sep.
    const next = nextFireAfter({ kind: 'cron', expr: '0 9 * * 1-5' }, at('2026-09-25T08:00:00Z'), ctx());
    expect(iso(next)).toBe('2026-09-28T07:00:00.000Z');
  });

  it('spring forward: a skipped local time shifts past the gap, or is skipped', () => {
    // 29 March 2026: 02:00 → 03:00 in Amsterdam. 02:30 does not exist.
    expect(instantsForLocal({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, AMS)).toEqual([]);
    const shifted = nextFireAfter({ kind: 'cron', expr: '30 2 * * *' }, at('2026-03-28T12:00:00Z'), ctx());
    // 02:30 at the pre-gap offset (+01:00) = 01:30 UTC = 03:30 local.
    expect(iso(shifted)).toBe('2026-03-29T01:30:00.000Z');
    const skipped = nextFireAfter({ kind: 'cron', expr: '30 2 * * *' }, at('2026-03-28T12:00:00Z'), {
      ...ctx(),
      dst: { skipped: 'skip', repeated: 'once' },
    });
    // Not on the 29th: the next day at 02:30 CEST = 00:30 UTC.
    expect(iso(skipped)).toBe('2026-03-30T00:30:00.000Z');
  });

  it('fall back: a repeated local time runs once or twice', () => {
    // 25 October 2026: 03:00 CEST → 02:00 CET; 02:30 happens twice.
    const both = instantsForLocal({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, AMS);
    expect(both.map(iso)).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']);
    const from = at('2026-10-24T12:00:00Z');
    const to = at('2026-10-25T12:00:00Z');
    const spec = { kind: 'cron' as const, expr: '30 2 * * *' };
    expect(firesBetween(spec, from, to, ctx(), 10).fires.map(iso)).toEqual(['2026-10-25T00:30:00.000Z']);
    expect(
      firesBetween(spec, from, to, { ...ctx(), dst: { skipped: 'shift', repeated: 'twice' } }, 10).fires.map(
        iso,
      ),
    ).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']);
  });

  it('interval schedules count from their anchor', () => {
    const anchor = at('2026-09-23T10:00:00Z');
    const spec = { kind: 'interval' as const, everyMinutes: 30 };
    expect(iso(nextFireAfter(spec, anchor, ctx(anchor)))).toBe('2026-09-23T10:30:00.000Z');
    expect(iso(nextFireAfter(spec, at('2026-09-23T11:10:00Z'), ctx(anchor)))).toBe(
      '2026-09-23T11:30:00.000Z',
    );
  });

  it('bounded catch-up keeps the newest missed fires', () => {
    const spec = { kind: 'cron' as const, expr: '0 * * * *' };
    const { fires, dropped } = firesBetween(
      spec,
      at('2026-09-23T00:00:00Z'),
      at('2026-09-23T10:00:00Z'),
      ctx(),
      3,
    );
    expect(fires.map(iso)).toEqual([
      '2026-09-23T08:00:00.000Z',
      '2026-09-23T09:00:00.000Z',
      '2026-09-23T10:00:00.000Z',
    ]);
    expect(dropped).toBe(7);
  });

  it('catches up a minute schedule without recalculating whole days for every fire', () => {
    const parts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      const result = firesBetween(
        { kind: 'cron', expr: '* * * * *' },
        at('2026-09-23T00:00:00Z'),
        at('2026-09-23T03:00:00Z'),
        ctx(),
        3,
      );
      expect(result.fires.map(iso)).toEqual([
        '2026-09-23T02:58:00.000Z',
        '2026-09-23T02:59:00.000Z',
        '2026-09-23T03:00:00.000Z',
      ]);
      expect(result.dropped).toBe(177);
      expect(parts.mock.calls.length).toBeLessThan(20_000);
    } finally {
      parts.mockRestore();
    }
  });

  it.each([
    ['once', 45],
    ['twice', 46],
  ] as const)('keeps fall-back %s policy across several cached days', (repeated, dropped) => {
    const result = firesBetween(
      { kind: 'cron', expr: '0 * * * *' },
      at('2026-10-24T22:00:00Z'),
      at('2026-10-26T23:00:00Z'),
      { ...ctx(), dst: { skipped: 'shift', repeated } },
      3,
    );
    expect(result.fires.map(iso)).toEqual([
      '2026-10-26T21:00:00.000Z',
      '2026-10-26T22:00:00.000Z',
      '2026-10-26T23:00:00.000Z',
    ]);
    expect(result.dropped).toBe(dropped);
  });

  it('retains the catch-up safety limit across a long minute backlog', () => {
    const result = firesBetween(
      { kind: 'cron', expr: '* * * * *' },
      at('2026-01-01T00:00:00Z'),
      at('2026-02-01T00:00:00Z'),
      { ...ctx(), timeZone: 'UTC' },
      3,
    );
    expect(result.fires.map(iso)).toEqual([
      '2026-01-07T22:38:00.000Z',
      '2026-01-07T22:39:00.000Z',
      '2026-01-07T22:40:00.000Z',
    ]);
    expect(result.dropped).toBe(9997);
  });

  it('knows a schedule that never runs and a zone that does not exist', () => {
    expect(nextFireAfter({ kind: 'cron', expr: '0 0 30 2 *' }, at('2026-01-01T00:00:00Z'), ctx())).toBeNull();
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone(AMS)).toBe(true);
  });

  it('describes common schedules', () => {
    // In words, without the Whombat's own time zone, never as the expression.
    expect(describeSchedule({ kind: 'cron', expr: '0 9 * * 1-5' }, AMS)).toBe('Every weekday at 09:00');
    expect(describeSchedule({ kind: 'cron', expr: '0 16 * * 5' }, AMS)).toBe('Every Friday at 16:00');
    expect(describeSchedule({ kind: 'cron', expr: '0 9 1 1 *' }, AMS)).toBe('On its own schedule');
    expect(describeSchedule({ kind: 'interval', everyMinutes: 60 }, AMS)).toBe('Every hour');
  });
});

describe('conditions', () => {
  const scope = {
    trigger: { text: 'The invoice PDF is broken', kind: 'message_posted' },
    steps: { check: { text: 'ACTIONABLE: 2 failing checks', state: 'succeeded', count: 2, tags: ['ci'] } },
  };
  it('evaluates comparisons, functions and logic', () => {
    expect(evaluateCondition('contains(steps.check.text, "ACTIONABLE:")', scope)).toBe(true);
    expect(evaluateCondition('startsWith(lower(trigger.text), "the")', scope)).toBe(true);
    expect(evaluateCondition('steps.check.count >= 2 && steps.check.state == "succeeded"', scope)).toBe(true);
    expect(evaluateCondition('!(steps.check.count > 5) || false', scope)).toBe(true);
    expect(evaluateCondition('contains(steps.check.tags, "ci")', scope)).toBe(true);
    expect(evaluateCondition('isEmpty(steps.missing.text)', scope)).toBe(true);
    expect(evaluateCondition('length(steps.check.text) < 3', scope)).toBe(false);
  });
  it('reads only trigger and steps, and never runs code', () => {
    expect(() => parseExpr('constructor.constructor("return 1")()')).toThrow(ExprError);
    expect(() => parseExpr('process.exit(1)')).toThrow(ExprError);
    expect(() => parseExpr('steps.a.text; 1')).toThrow(ExprError);
    expect(evaluateCondition('steps.__proto__.polluted == null', scope)).toBe(true);
    expect(() => parseExpr('eval("1")')).toThrow(/not a function/);
  });
  it('bounds length and nesting', () => {
    expect(() => parseExpr(`${'('.repeat(40)}true${')'.repeat(40)}`)).toThrow(/nested/);
    expect(() => parseExpr(`"${'a'.repeat(600)}"`)).toThrow(/500/);
  });
});

describe('templates', () => {
  it('fills placeholders as text, never re-reading them', () => {
    const scope = { trigger: { text: '{{steps.secret.text}} hi' }, steps: { secret: { text: 'nope' } } };
    expect(renderTemplate('Said: {{trigger.text}}', scope)).toBe('Said: {{steps.secret.text}} hi');
    expect(renderTemplate('{{ missing.path }}!', scope)).toBe('!');
    expect(renderJsonTemplate('{"t":"{{trigger.text}}"}', { trigger: { text: 'a "quoted"\nline' } })).toBe(
      '{"t":"a \\"quoted\\"\\nline"}',
    );
  });
});

const base = {
  version: 1,
  conversationId: 'cnv_bugs',
  triggers: [{ kind: 'manual' }],
  steps: [{ id: 'hello', kind: 'post_message', text: 'Hello' }],
};

describe('definition validation', () => {
  it('accepts a minimal definition and fills defaults', () => {
    const r = validateDefinition(base);
    expect(r.ok).toBe(true);
    expect(r.definition?.limits.maxConcurrentRuns).toBe(1);
  });
  it('rejects unknown fields and unknown step kinds', () => {
    expect(validateDefinition({ ...base, grants: [{ keyId: 'merge.main' }] }).problems.join()).toMatch(
      /unknown field/,
    );
    const r = validateDefinition({ ...base, steps: [{ id: 'x', kind: 'shell', command: 'rm -rf /' }] });
    expect(r.ok).toBe(false);
    expect(
      validateDefinition({
        ...base,
        steps: [{ id: 'hello', kind: 'post_message', text: 'x', sudo: true }],
      }).problems.join(),
    ).toMatch(/unknown field/);
  });
  it('rejects oversize definitions', () => {
    const steps = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`,
      kind: 'post_message',
      text: 'x'.repeat(3900),
    }));
    expect(validateDefinition({ ...base, steps }).problems).toEqual([
      'This automation is too big (64 KB at most).',
    ]);
  });
  it('refuses references to later steps and backward skips (no cycles)', () => {
    const r = validateDefinition({
      ...base,
      steps: [
        { id: 'a', kind: 'post_message', text: '{{steps.b.text}}' },
        { id: 'b', kind: 'condition', if: 'true', else: { skipTo: 'a' } },
        { id: 'a', kind: 'wait', minutes: 1 },
      ],
    });
    expect(r.problems).toEqual(
      expect.arrayContaining([
        'steps[2]: the id “a” is used twice.',
        'steps[0].text: “b” doesn’t come before this step.',
        'steps[1].else: a condition can only skip ahead.',
      ]),
    );
  });
  it('checks conditions and schedules', () => {
    const r = validateDefinition({
      ...base,
      triggers: [
        { kind: 'schedule', schedule: { kind: 'cron', expr: '0 0 30 2 *' }, timeZone: 'Nowhere/Land' },
      ],
      steps: [{ id: 'c', kind: 'condition', if: 'eval(1)' }],
    });
    expect(r.problems.join('\n')).toMatch(/not a time zone/);
    expect(r.problems.join('\n')).toMatch(/not a function/);
  });
  it('allows only one schedule and no manual mix', () => {
    const s = { kind: 'schedule', schedule: { kind: 'interval', everyMinutes: 60 }, timeZone: AMS };
    expect(validateDefinition({ ...base, triggers: [s, s] }).problems.join()).toMatch(/only one schedule/);
    expect(validateDefinition({ ...base, triggers: [s, { kind: 'manual' }] }).problems.join()).toMatch(
      /started by hand/,
    );
  });
});

describe('shipped templates', () => {
  it('both build valid, importable definitions', () => {
    const bug = buildTemplate({
      template: 'suspected_bug',
      conversationId: 'cnv_bugs',
      repo: 'burrowhq/billing',
    });
    expect(validateDefinition(bug.definition).problems).toEqual([]);
    expect(parseAutomationExport(JSON.parse(JSON.stringify(bug))).ok).toBe(true);
    expect(bug.definition.steps.map((s) => s.kind)).toEqual([
      'dispatch_agent',
      'post_message',
      'request_approval',
      'dispatch_agent',
      'dispatch_agent',
      'condition',
      'open_pull_request',
      'post_message',
    ]);
    // Coding work on a feat/* branch (the agent's “Read and write feat/* branches” key), read-only checkouts for
    // investigating (the base) and the review (the branch), and a verdict the condition reads.
    const [investigate, , , implement, review, approved, pr] = bug.definition.steps;
    expect(investigate?.kind === 'dispatch_agent' && investigate.workspace).toEqual({
      repo: 'burrowhq/billing',
      access: 'read',
    });
    expect(implement?.kind === 'dispatch_agent' && implement.workspace).toEqual({
      repo: 'burrowhq/billing',
      branch: 'feat/bug-{{run.number}}',
      access: 'write',
    });
    expect(review?.kind === 'dispatch_agent' && [review.workspace?.access, review.verdict]).toEqual([
      'read',
      true,
    ]);
    // The same agent reviews, in a fresh turn.
    expect(review?.kind === 'dispatch_agent' && review.prompt).toContain('with fresh eyes');
    expect(pr?.kind === 'open_pull_request' && pr.branch).toBe('feat/bug-{{run.number}}');
    if (approved?.kind === 'condition') {
      expect(evaluateCondition(approved.if, { steps: { review: { verdict: 'approve' } } })).toBe(true);
      expect(evaluateCondition(approved.if, { steps: { review: { verdict: 'changes_needed' } } })).toBe(
        false,
      );
    }
    // A report in a thread counts; the description says which keys it needs.
    expect(bug.definition.triggers[0]).toMatchObject({ kind: 'message_posted', includeReplies: true });
    expect(bug.description).toContain('“Read and write feat/* branches”');
    expect(bug.description).toContain('“Open pull requests”');
    const check = buildTemplate({
      template: 'repo_check',
      conversationId: 'cnv_general',
      repo: 'burrowhq/billing',
    });
    expect(validateDefinition(check.definition).problems).toEqual([]);
    const cond = check.definition.steps[1];
    expect(cond?.kind).toBe('condition');
    if (cond?.kind === 'condition') {
      expect(
        evaluateCondition(cond.if, { steps: { check: { text: `${REPO_CHECK_ACTIONABLE} 1 PR waiting` } } }),
      ).toBe(true);
      expect(evaluateCondition(cond.if, { steps: { check: { text: 'NOTHING TO REPORT' } } })).toBe(false);
    }
    expect(triggerSummary(check.definition.triggers)).toBe('Every weekday at 09:00');
  });
});

describe('coding steps', () => {
  const base = {
    version: 1,
    conversationId: 'cnv_bugs',
    triggers: [{ kind: 'manual' }],
    limits: { runTimeoutMinutes: 60, maxConcurrentRuns: 1, maxRunsPerDay: 5 },
  };
  it('need a branch of their own to write, and may template it from earlier steps only', () => {
    const step = (workspace: object) => ({
      ...base,
      steps: [{ id: 'fix', kind: 'dispatch_agent', prompt: 'Fix it', workspace }],
    });
    expect(validateDefinition(step({ repo: 'o/r', access: 'read' })).problems).toEqual([]);
    expect(validateDefinition(step({ repo: 'o/r', access: 'write' })).problems).toEqual([
      'steps[0].workspace: an agent that writes code needs a branch of its own.',
    ]);
    expect(
      validateDefinition(step({ repo: 'o/r', access: 'write', branch: 'feat/{{steps.later.text}}' }))
        .problems,
    ).toEqual(['steps[0].workspace.branch: there is no step “later”.']);
    expect(validateDefinition(step({ repo: 'o/r', access: 'write', branch: 'feat/x', push: true })).ok).toBe(
      false,
    );
  });

  it('read verdicts only from the first words of a reply', () => {
    expect(parseVerdict('Approve: rounds per line, with a test.')).toBe('approve');
    expect(parseVerdict('**Approve.** Looks right.')).toBe('approve');
    expect(parseVerdict('  approve')).toBe('approve');
    expect(parseVerdict('Changes needed: the test doesn’t fail before the fix.')).toBe('changes_needed');
    expect(parseVerdict('> CHANGES NEEDED — see below')).toBe('changes_needed');
    expect(parseVerdict('Approved with changes')).toBeNull();
    expect(parseVerdict('I approve')).toBeNull();
    expect(parseVerdict('Looks right. Ready.')).toBeNull();
    expect(parseVerdict('')).toBeNull();
  });
});

describe('hashes', () => {
  it('bind approvals to the exact action, input and binding', () => {
    const a = actionHash({
      action: { type: 'custom' },
      input: { title: 'Fix' },
      binding: { automationId: 'aut_1', version: 1, stepId: 'approve', commitSha: 'abc' },
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      actionHash({
        action: { type: 'custom' },
        input: { title: 'Fix' },
        binding: { automationId: 'aut_1', version: 1, stepId: 'approve', commitSha: 'abc' },
      }),
    ).toBe(a);
    expect(
      actionHash({
        action: { type: 'custom' },
        input: { title: 'Fix' },
        binding: { automationId: 'aut_1', version: 2, stepId: 'approve', commitSha: 'abc' },
      }),
    ).not.toBe(a);
    expect(
      actionHash({
        action: { type: 'custom' },
        input: { title: 'Fix' },
        binding: { automationId: 'aut_1', version: 1, stepId: 'approve', commitSha: 'abd' },
      }),
    ).not.toBe(a);
    expect(
      actionHash({
        action: { type: 'custom' },
        input: { title: 'Fix it' },
        binding: { automationId: 'aut_1', version: 1, stepId: 'approve', commitSha: 'abc' },
      }),
    ).not.toBe(a);
  });
  it('hash definitions canonically (key order does not matter)', () => {
    const d = AutomationDefinition.parse(base);
    const reordered = AutomationDefinition.parse({
      steps: base.steps,
      triggers: base.triggers,
      conversationId: base.conversationId,
      version: 1,
    });
    expect(definitionHash(d)).toBe(definitionHash(reordered));
  });
});

describe('trigger matching', () => {
  const msg = {
    kind: 'message' as const,
    conversationId: 'cnv_bugs',
    text: 'Checkout is BROKEN',
    authorKind: 'person' as const,
    mentions: [],
    isReply: false,
  };
  it('matches messages by room, words, author kind and replies', () => {
    const t = {
      kind: 'message_posted' as const,
      conversationId: 'cnv_bugs',
      contains: ['broken'],
      includeAgents: false,
      includeReplies: false,
    };
    expect(triggerMatches(t, msg)).toBe(true);
    expect(triggerMatches(t, { ...msg, text: 'all good' })).toBe(false);
    expect(triggerMatches(t, { ...msg, authorKind: 'agent' })).toBe(false);
    expect(triggerMatches(t, { ...msg, isReply: true })).toBe(false);
    expect(triggerMatches(t, { ...msg, conversationId: 'cnv_other' })).toBe(false);
  });
  it('matches reactions and GitHub events', () => {
    expect(
      triggerMatches(
        { kind: 'reaction_added', conversationId: 'cnv_bugs', value: '🐛' },
        { kind: 'reaction', conversationId: 'cnv_bugs', value: '🐛' },
      ),
    ).toBe(true);
    const gh = {
      kind: 'github' as const,
      event: 'checks_completed' as const,
      repo: 'burrowhq/billing',
      branch: 'feat/*',
      checksState: 'failed' as const,
    };
    expect(
      triggerMatches(gh, {
        kind: 'github',
        event: 'checks_completed',
        repo: 'BurrowHQ/billing',
        branch: 'feat/x',
        checksState: 'failed',
      }),
    ).toBe(true);
    expect(
      triggerMatches(gh, {
        kind: 'github',
        event: 'checks_completed',
        repo: 'burrowhq/billing',
        branch: 'main',
        checksState: 'failed',
      }),
    ).toBe(false);
    expect(
      triggerMatches(gh, {
        kind: 'github',
        event: 'checks_completed',
        repo: 'burrowhq/billing',
        branch: 'feat/x',
        checksState: 'passed',
      }),
    ).toBe(false);
  });
});
