import {
  type Automation,
  AutomationDefinition,
  type AutomationRunStatus,
  type AutomationRunSummary,
  definitionGrants,
  recipeDefinition,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  automationListRow,
  automationListRows,
  automationOverview,
  automationPage,
  automationRunLabel,
  automationRunRows,
  runBars,
  runBarsLabel,
} from './automationView';

const now = new Date('2026-10-30T20:00:00.000Z');
const zone = 'Europe/Amsterdam';
const names = {
  agent: 'Dusty',
  conversationTitle: (id: string) => (id === 'cnv_chat' ? 'Chat' : undefined),
  connectionLabel: (id: string) => (id === 'con_tracker' ? 'Acme Desk dev' : undefined),
};

const tracker = AutomationDefinition.parse(
  recipeDefinition({
    when: { kind: 'tracker', connectionId: 'con_tracker', itemKinds: ['bug', 'feature'] },
    job: 'assess',
    instructions: 'Look at it',
    repo: 'LumioHQ/development',
    fix: { mode: 'auto', minImportance: 'high', maxPerDay: 5, merge: 'checks' },
    writeBack: true,
    replyToCustomer: true,
    conversationId: 'cnv_chat',
  }),
);

const runs = (
  statuses: AutomationRunStatus[],
  waitingOn: (AutomationRunSummary['waitingOn'] | undefined)[] = [],
) =>
  statuses.map((status, i) => ({
    id: `arn_${i}`,
    number: statuses.length - i,
    status,
    startedAt: new Date(now.getTime() - (i + 1) * 3_600_000).toISOString(),
    finishedAt: ['succeeded', 'failed', 'skipped'].includes(status)
      ? new Date(now.getTime() - (i + 1) * 3_600_000 + 240_000).toISOString()
      : null,
    waitingOn: waitingOn[i] ?? null,
  }));

const automation = (over: Partial<Automation> = {}): Automation => ({
  id: 'aut_tracker',
  burrowId: 'bur_burrow-hq',
  name: 'Assess and fix Acme Desk reports',
  description: 'Dusty looks at every new report and fixes clear bugs itself.',
  status: 'published',
  currentVersion: 1,
  draft: null,
  draftJson: null,
  draftProblems: [],
  draftHash: null,
  definition: tracker,
  principalId: 'prn_auto',
  createdById: 'prn_mara',
  createdAt: '2026-10-20T08:00:00.000Z',
  updatedAt: '2026-10-20T08:00:00.000Z',
  publishedById: 'prn_mara',
  triggerSummary: 'New report · Acme Desk dev',
  summary: 'When a new report arrives in Acme Desk dev, Dusty assesses it.',
  deletedAt: null,
  grants: definitionGrants(tracker),
  webhook: { enabled: false, hasSecret: false, path: '/webhooks/automations/aut_tracker' },
  nextRunAt: null,
  lastRun: null,
  recentRuns: [],
  glance: null,
  waitingPlanId: null,
  talk: null,
  ...over,
});

describe('a row on the Automations list (automation-page.md AP-6330)', () => {
  it('has the whole name, then one line: whether it runs, its last run and its next', () => {
    const recent = runs(['succeeded', 'succeeded', 'failed']);
    const row = automationListRow(automation({ recentRuns: recent, lastRun: recent[0] }), now, zone, names);
    expect(row.name).toBe('Assess and fix Acme Desk reports');
    expect(row.when).toContain('Acme Desk dev');
    expect(row.state.tone).toBe('on');
    // The last run's finish time, with its date.
    expect(row.line.map((p) => p.text)).toEqual([
      'On',
      'Last run worked · 30 Oct, 20:04',
      'Next run on a new report or customer reply',
    ]);
    expect(row.tile).toMatchObject({ source: 'tracker', label: 'Acme Desk dev' });
    expect(row.accessibilityLabel).toContain('Acme Desk dev');
    expect(row.accessibilityLabel).toContain('Last run worked');
  });

  it('says a failed last run without calling the automation broken', () => {
    const recent = runs(['failed']);
    const row = automationListRow(automation({ recentRuns: recent, lastRun: recent[0] }), now, zone, names);
    expect(row.state).toMatchObject({ tone: 'on', label: 'On' });
    expect(row.line[1]?.text).toContain('Last run failed');
    expect(runBars(recent).bars.map((b) => b.tone)).toEqual(['warn']);
  });

  it('says a run waits for you, or a plan does, beside whether it runs', () => {
    const waiting = runs(['waiting'], ['approval']);
    const row = automationListRow(automation({ recentRuns: waiting }), now, zone, names);
    expect(row.state).toMatchObject({ tone: 'waiting', label: 'On', waitingRun: 1 });
    expect(row.line[1]?.text).toMatch(/^Last run waiting for you · started /);
    const plan = automationListRow(automation({ waitingPlanId: 'apl_1' }), now, zone, names);
    expect(plan.state.tone).toBe('waiting');
    expect(plan.line.map((p) => p.key)).toEqual(['state', 'last', 'next', 'plan']);
  });

  it('says off and not on yet plainly, and when it runs next', () => {
    const off = automationListRow(automation({ status: 'disabled' }), now, zone, names);
    expect(off.state).toMatchObject({ tone: 'off', label: 'Off' });
    expect(off.line.map((p) => p.text)).toEqual(['Off', 'No runs yet', 'No next run']);
    const draft = automationListRow(
      automation({ status: 'draft', currentVersion: null, definition: null, draft: tracker }),
      now,
      zone,
      names,
    );
    expect(draft.state).toMatchObject({ tone: 'draft', label: 'Not on yet' });
    expect(draft.line.map((p) => p.text)).toEqual(['Not on yet', 'No runs yet', 'No next run yet']);
    expect(draft.when).toContain('Acme Desk dev');
    const next = automationListRow(automation({ nextRunAt: '2026-10-31T07:00:00.000Z' }), now, zone, names);
    expect(next.state.next).toBe('Next run 31 Oct, 08:00');
  });

  it('falls back to the server’s trigger words without a definition, and leaves deleted ones out', () => {
    expect(automationListRow(automation({ definition: null }), now, zone, names).when).toBe(
      'New report · Acme Desk dev',
    );
    const rows = automationListRows(
      [automation(), automation({ id: 'aut_gone', deletedAt: '2026-10-30T19:00:00.000Z' })],
      now,
      zone,
      names,
    );
    expect(rows.map((r) => r.id)).toEqual(['aut_tracker']);
  });
});

describe('a tracker automation’s tile', () => {
  const made = (words?: { product: string; team: string }) =>
    AutomationDefinition.parse(
      recipeDefinition({
        when: {
          kind: 'tracker',
          connectionId: 'con_tracker',
          itemKinds: ['bug'],
          ...(words ? { words } : {}),
        },
        job: 'assess',
        instructions: 'Look at it',
        conversationId: 'cnv_chat',
      }),
    );

  it('is called what its tracker is, as its recipe keeps it, whatever the tracker', () => {
    const acme = made({ product: 'Acme Desk', team: 'Acme team' });
    expect(automationListRow(automation({ definition: acme }), now, zone, names).tile.label).toBe(
      'Acme Desk',
    );
    const beacon = made({ product: 'Beacon Helpdesk', team: 'Beacon support' });
    const row = automationListRow(automation({ definition: beacon }), now, zone, names);
    expect(row.tile.label).toBe('Beacon Helpdesk');
    expect(row.accessibilityLabel).toContain('Beacon Helpdesk');
  });

  it('says its connection without the tracker’s words, else a plain word', () => {
    expect(automationListRow(automation({ definition: made() }), now, zone, names).tile.label).toBe(
      'Acme Desk dev',
    );
    const unknown = { ...names, connectionLabel: () => undefined };
    expect(automationListRow(automation({ definition: made() }), now, zone, unknown).tile.label).toBe(
      'Report tracker',
    );
  });
});

describe('a mail-triggered automation', () => {
  const mailNames = {
    ...names,
    connectionLabel: (id: string) => (id === 'con_mail' ? 'you@example.com' : names.connectionLabel(id)),
  };
  const mailDef = AutomationDefinition.parse(
    recipeDefinition({
      when: {
        kind: 'mail',
        connectionId: 'con_mail',
        from: 'example.com',
        attachmentTypes: ['pdf'],
      },
      job: 'custom',
      instructions: 'Put the PDF in Paperless-ngx and make a draft in Moneybird.',
      conversationId: 'cnv_chat',
    }),
  );

  it('shows the mail tile, plain-English trigger sentence and mailbox details on list and page views', () => {
    const item = automation({
      id: 'aut_mail',
      name: 'Handle mail from example.com',
      definition: mailDef,
      grants: definitionGrants(mailDef),
      triggerSummary: 'When mail from example.com with a PDF arrives in your inbox',
      summary: 'When mail from example.com with a PDF arrives in your inbox, Dusty runs it in Chat.',
    });
    const row = automationListRow(item, now, zone, mailNames);
    expect(row.tile).toMatchObject({ source: 'mail', label: 'Mail' });
    expect(row.when).toBe('When mail from example.com with a PDF arrives in your inbox');
    expect(row.state.next).toBe('Next run on a matching email');

    const page = automationPage(item, {
      now,
      timeZone: zone,
      names: mailNames,
      viewer: { id: 'prn_mara', kind: 'person' },
      deletes: true,
    });
    expect(page.flow?.[0]).toMatchObject({
      kind: 'when',
      text: 'When mail from example.com with a PDF arrives in your inbox',
    });
    if (page.flow?.[0]?.kind === 'when') {
      expect(page.flow[0].details).toContain('In you@example.com');
      expect(page.flow[0].details).toContain('One thread per email in Chat');
    }
  });
});

describe('a Find My automation', () => {
  const findMyNames = {
    ...names,
    connectionLabel: (id: string) => (id === 'con_findmy' ? 'Find My' : names.connectionLabel(id)),
  };
  const mailDef = AutomationDefinition.parse(
    recipeDefinition({
      when: { kind: 'mail', connectionId: 'con_mail' },
      job: 'custom',
      instructions: 'Tell me.',
      conversationId: 'cnv_chat',
    }),
  );
  const findMyDef = AutomationDefinition.parse({
    ...mailDef,
    triggers: [
      {
        kind: 'findmy',
        connectionId: 'con_findmy',
        person: 'db6613615969',
        name: 'Noor Visser',
        change: 'arrives',
        place: 'Home',
      },
    ],
  });

  it('says whom it waits for and where, on its row and its tile', () => {
    const item = automation({
      id: 'aut_findmy',
      name: 'Tell me when Noor gets home',
      definition: findMyDef,
      grants: definitionGrants(findMyDef),
      triggerSummary: 'When Noor Visser arrives at Home',
    });
    const row = automationListRow(item, now, zone, findMyNames);
    expect(row.tile).toMatchObject({ source: 'findmy', label: 'Find My' });
    expect(row.when).toContain('Noor Visser');
    expect(row.state.next).toBe('Next run when Noor Visser arrives at Home');
  });
});

describe('an automation’s page (automation-page.md AP-6331…AP-6335)', () => {
  const you = { id: 'prn_mara', kind: 'person' as const };

  it('says what happens step by step, what it asks first and its limits', () => {
    const page = automationPage(automation(), { now, timeZone: zone, names, viewer: you, deletes: true });
    expect(page.flow?.[0]).toMatchObject({ kind: 'when' });
    expect(page.flow?.some((i) => i.kind === 'step' && i.icon === 'merge')).toBe(true);
    expect(page.asks[0]?.detail).toContain('high importance');
    expect(page.limits.map((l) => l.text).join(' ')).toContain('5 fixes');
    expect(page.prompts.length).toBeGreaterThan(0);
    expect(page.description).toContain('fixes clear bugs');
  });

  it('switches one that was turned on once, tries it, and lets you delete it', () => {
    const page = automationPage(automation(), { now, timeZone: zone, names, viewer: you, deletes: true });
    expect(page.switch).toEqual({ on: true });
    expect(page.run).toMatchObject({ kind: 'try', tryIt: 'sample' });
    expect(page.canDelete).toBe(true);
    const agent = automationPage(automation(), {
      now,
      timeZone: zone,
      names,
      viewer: { id: 'prn_dusty', kind: 'agent' },
      deletes: true,
    });
    expect(agent.canDelete).toBe(false);
    const notOn = automationPage(
      automation({ currentVersion: null, status: 'draft', definition: null, draft: tracker }),
      {
        now,
        timeZone: zone,
        names,
      },
    );
    expect(notOn.switch).toBeNull();
    expect(notOn.flow).not.toBeNull();
  });

  it('says the summary when there is no definition to read', () => {
    const page = automationPage(automation({ definition: null, description: '  ' }), {
      now,
      timeZone: zone,
      names,
    });
    expect(page.flow).toBeNull();
    expect(page.summary).toContain('Acme Desk dev');
    expect(page.description).toBeNull();
  });

  it('lists its runs newest first, each with what started it', () => {
    const rows = automationRunRows(
      [
        {
          number: 3,
          status: 'succeeded',
          startedAt: '2026-10-30T17:19:00.000Z',
          trigger: { summary: 'Export to PDF cuts off the last page' } as never,
        },
        { number: 2, status: 'failed', startedAt: null, trigger: { summary: '' } as never },
      ],
      now,
      zone,
    );
    expect(rows[0]).toMatchObject({ number: 3, tone: 'ok', result: 'worked', when: '30 Oct, 18:19' });
    expect(rows[0]?.title).toContain('Export to PDF');
    expect(rows[1]).toMatchObject({ title: '#2', tone: 'warn', result: 'failed', when: 'Failed' });
  });
});

describe('a run’s state on its page', () => {
  it('says how a finished run went, never “Finished” alone', () => {
    const at = '2026-10-30T17:19:00.000Z';
    expect(automationRunLabel({ status: 'succeeded', finishedAt: at })).toBe('Finished · worked');
    expect(automationRunLabel({ status: 'failed', finishedAt: at })).toBe('Finished · failed');
    expect(automationRunLabel({ status: 'skipped', finishedAt: at })).toBe('Finished · skipped');
    expect(automationRunLabel({ status: 'waiting', finishedAt: null })).toBe('Waiting');
  });
});

describe('the run bars in words', () => {
  it('counts the last runs by status, and says one run plainly', () => {
    const runs = ['succeeded', 'succeeded', 'failed', 'succeeded', 'succeeded'] as const;
    expect(runBarsLabel(runs.map((status) => ({ status })))).toBe('Last 5 runs: 4 worked, 1 failed');
    expect(runBarsLabel([{ status: 'succeeded' }])).toBe('Last run: worked');
    expect(runBarsLabel([])).toBeNull();
  });
});

describe('the overview’s reads: the automations and the agent’s schedules', () => {
  const read = (o: { pending?: boolean; failed?: boolean; count?: number | null } = {}) => ({
    pending: o.pending ?? false,
    failed: o.failed ?? false,
    count: o.count === undefined ? 0 : o.count,
  });

  it('shows nothing yet only when both reads worked and found nothing', () => {
    expect(automationOverview(read(), read()).body).toBe('empty');
    // The schedules didn't load: what was read stays, with a notice, never “No automations yet”.
    const failed = automationOverview(read(), read({ failed: true, count: null }));
    expect(failed).toEqual({ body: 'list', schedules: 'failed' });
    // The schedules are still on their first read: rows without a count, not an empty list.
    expect(automationOverview(read(), read({ pending: true, count: null })).body).toBe('loading');
  });

  it('a schedules read that failed is retryable beside the automations, and a refresh keeps the rows read', () => {
    expect(automationOverview(read({ count: 3 }), read({ failed: true, count: null }))).toEqual({
      body: 'list',
      schedules: 'failed',
    });
    expect(automationOverview(read({ count: 3 }), read({ failed: true, count: 2 }))).toEqual({
      body: 'list',
      schedules: 'failed',
    });
    // Read again, and it worked.
    expect(automationOverview(read({ count: 3 }), read({ count: 2 }))).toEqual({
      body: 'list',
      schedules: 'rows',
    });
    expect(automationOverview(read({ count: 3 }), read())).toEqual({ body: 'list', schedules: 'hidden' });
    expect(automationOverview(read({ count: 3 }), read({ pending: true, count: null })).schedules).toBe(
      'hidden',
    );
  });

  it('the automations’ own read decides loading and a list that didn’t load', () => {
    expect(automationOverview(read({ pending: true, count: null }), read()).body).toBe('loading');
    expect(automationOverview(read({ failed: true, count: null }), read({ count: 2 }))).toEqual({
      body: 'unread',
      schedules: 'rows',
    });
  });
});
