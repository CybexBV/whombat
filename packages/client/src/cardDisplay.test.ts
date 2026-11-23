import {
  type FindMyWatchView,
  type MessageCard,
  type ReportCard,
  type ScheduleCard,
  TASK_CARD_WORDS,
  type TaskCard,
  taskCardLine,
  taskLostText,
} from '@whombat/core';
import {
  approval,
  plan,
  reportCardOf,
  reportFailed,
  reportFeature,
  reportLikelyBug,
  reportQueued,
  reportRemoved,
  run,
} from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import {
  approvalLine,
  cardDisplay,
  deploySettledLine,
  FIND_MY_WATCH_TONES,
  findMyWatchLine,
  foldIntoRuns,
  planLine,
  reportHeaderOnly,
  reportLine,
  reportTone,
  runChips,
  runDisplay,
  runLiveText,
  scheduleLine,
  TASK_TONES,
  taskCardView,
  taskLine,
  taskTextOnly,
  textFoldsIntoCard,
} from './cardDisplay';
import { resourceKey } from './session/resources';

const changed = { ...run, diff: { add: 12, del: 8, files: 3 }, prNumber: 3, attention: null };
const quiet = { ...run, diff: { add: 0, del: 0, files: 0 }, prNumber: null };

const schedule = (status: 'active' | 'paused' | 'ended', runId: string | null = 'run_fix1'): ScheduleCard =>
  ({
    kind: 'schedule',
    scheduleId: 'sch_follow1',
    runId,
    schedule: {
      status,
      endedReason: status === 'ended' ? 'done' : null,
      when: { kind: 'at', at: '2026-10-04T13:23:00.000Z' },
      prompt: 'Follow up on PR #1.',
    },
  }) as unknown as ScheduleCard;

describe('runDisplay (AP-730)', () => {
  it('keeps a run that changed nothing as the run line', () => {
    for (const status of ['live', 'paused', 'done', 'failed', 'taken_over'] as const)
      expect(runDisplay({ ...quiet, status })).toBe('line');
  });

  it('is the live card while it works, the card while it needs a person, a line once done', () => {
    expect(runDisplay({ ...changed, status: 'live' })).toBe('live');
    expect(
      runDisplay({ ...changed, status: 'live', attention: 'Banjo stopped without finishing this run.' }),
    ).toBe('full');
    expect(runDisplay({ ...changed, status: 'live', attention: '  ' })).toBe('live');
    expect(runDisplay({ ...changed, status: 'paused' })).toBe('full');
    expect(runDisplay({ ...changed, status: 'failed' })).toBe('full');
    expect(runDisplay({ ...changed, status: 'done' })).toBe('line');
    expect(runDisplay({ ...changed, status: 'taken_over' })).toBe('line');
  });
});

describe('cardDisplay (AP-730, AP-731)', () => {
  it('settles an approval once decided and its action no longer runs', () => {
    const pending = { kind: 'approval', approval: { ...approval, state: 'pending' } } as MessageCard;
    expect(cardDisplay(pending)).toBe('full');
    const approved = { ...approval, state: 'approved' as const };
    expect(cardDisplay({ kind: 'approval', approval: approved } as MessageCard)).toBe('line');
    const executing = { ...approved, execution: { ...approved.execution, state: 'running' as const } };
    expect(cardDisplay({ kind: 'approval', approval: executing } as MessageCard)).toBe('full');
  });

  it('settles a plan when every step is done or cancelled', () => {
    expect(cardDisplay({ kind: 'plan', plan } as MessageCard)).toBe('full');
    const finished = {
      ...plan,
      steps: plan.steps.map((s, i) => ({ ...s, state: i ? 'done' : 'cancelled' })),
    };
    expect(cardDisplay({ kind: 'plan', plan: finished } as MessageCard)).toBe('line');
  });

  it('keeps a schedule a line', () => {
    expect(cardDisplay(schedule('active'))).toBe('line');
  });

  it('keeps content cards and failed turns until retried', () => {
    expect(cardDisplay({ kind: 'pill', text: 'x' } as unknown as MessageCard)).toBe('full');
    const failed = { kind: 'turn_failed', retriedAt: null } as unknown as MessageCard;
    expect(cardDisplay(failed)).toBe('full');
    expect(cardDisplay({ ...failed, retriedAt: '2026-10-04T13:02:00.000Z' } as MessageCard)).toBe('line');
  });
});

describe('settled lines (AP-731)', () => {
  it('says who decided an approval', () => {
    expect(approvalLine({ state: 'approved', title: 'Hand FB-3B50 to Banjo' }, 'John')).toEqual({
      lead: 'Approved by John',
      detail: 'Hand FB-3B50 to Banjo',
      tone: 'ok',
    });
    expect(approvalLine({ state: 'declined', title: 'Deploy' }, null).lead).toBe('Declined');
  });

  it('counts a plan’s steps without the cancelled ones', () => {
    const steps = [{ state: 'done' }, { state: 'done' }, { state: 'cancelled' }] as typeof plan.steps;
    expect(planLine({ title: 'Ship it', steps }).lead).toBe('Plan · 2 of 2 done');
    expect(planLine({ title: 'Ship it', steps: [steps[2]] as typeof plan.steps }).lead).toBe(
      'Plan · Cancelled',
    );
  });

  it('names a schedule', () => {
    expect(
      scheduleLine(schedule('active'), 'Banjo', 'Europe/Amsterdam', Date.parse('2026-10-04T12:00:00Z')),
    ).toEqual({
      lead: 'Once, Sun 4 Oct at 15:23',
      detail: 'Follow up on PR #1.',
      tone: 'live',
    });
    expect(scheduleLine(schedule('ended'), 'Banjo', 'Europe/Amsterdam').lead).toBe('Done');
  });

  it('shows a run’s pull request and diff with the minus sign, and how long a live run has run', () => {
    expect(runChips(changed)).toEqual({ prNumber: 3, diff: '+12 −8', files: '3 files' });
    expect(runChips(quiet)).toEqual({ prNumber: null, diff: null, files: null });
    const started = Date.parse('2026-10-04T13:45:16.000Z');
    expect(
      runLiveText(
        {
          number: 5,
          title: 'Verify and deploy',
          activity: 'Running pnpm test',
          startedAt: '2026-10-04T13:45:16.000Z',
        },
        started + 192_000,
      ),
    ).toEqual({ title: 'Run #5 · Verify and deploy', now: 'Now: Running pnpm test', elapsed: '3m 12s' });
  });
});

describe('foldIntoRuns (AP-732)', () => {
  const runMsg = { id: 'msg_run', card: { kind: 'run', run: { ...changed, id: 'run_fix1' } } as MessageCard };

  it('puts a schedule inside its run, below it in the list', () => {
    const later = { id: 'msg_sched', card: schedule('active') };
    const text = { id: 'msg_text', card: null };
    const folds = foldIntoRuns([runMsg, text, later]);
    expect(folds.inside.get('msg_run')?.map((m) => m.id)).toEqual(['msg_sched']);
    expect([...folds.hidden]).toEqual(['msg_sched']);
  });

  it('leaves alone a card without its run, and one from another run', () => {
    const folds = foldIntoRuns([
      { id: 'msg_before', card: schedule('active') },
      runMsg,
      { id: 'msg_other', card: schedule('active', 'run_other') },
      { id: 'msg_none', card: schedule('active', null) },
    ]);
    expect(folds.hidden.size).toBe(0);
  });
});

describe('reportLine (docs/decisions/report-rows.md RR-01…RR-04)', () => {
  const likely = reportCardOf(reportLikelyBug) as ReportCard;

  it('is a line in every state', () => {
    for (const r of [reportLikelyBug, reportQueued, reportFailed, reportRemoved, reportFeature])
      expect(cardDisplay(reportCardOf(r) as MessageCard)).toBe('line');
  });

  it('says the outcome and the assessment’s summary once assessed, with the reference and the facts', () => {
    const line = reportLine({ ...likely, attachments: 2 });
    expect(line.lead).toBe('Likely bug');
    expect(line.detail).toBe(likely.assessment.summary);
    expect(line.tone).toBe('warn');
    expect(line.reference).toBe('FB-7K3Q-9M2X');
    expect(line.meta).toEqual(['Burrow Billing', 'Triaged', '2 screenshots']);
    expect(line.quiet).toBe(false);
    expect(line.label).toBe('Bug report FB-7K3Q-9M2X: Burrow Billing · Triaged · Likely bug');
  });

  it('says the type and the visitor’s words before an assessment, Assessing while it runs', () => {
    const queued = reportLine(reportCardOf(reportQueued) as ReportCard);
    expect(queued.lead).toBe('Bug report');
    expect(queued.detail).toBe((reportCardOf(reportQueued) as ReportCard).summary);
    expect(queued.tone).toBe('mut');
    expect(queued.meta).toEqual(['Burrow Billing']);
    const running = reportLine({ ...likely, assessment: { state: 'running', outcome: null, summary: null } });
    expect(running.lead).toBe('Assessing');
    expect(running.detail).toBe(likely.summary);
    expect(running.tone).toBe('live');
  });

  it('a failed assessment in the bad tone; a feature request muted; removed content quiet', () => {
    const failed = reportLine(reportCardOf(reportFailed) as ReportCard);
    expect([failed.lead, failed.tone]).toEqual(['Assessment failed', 'bad']);
    const feature = reportLine(reportCardOf(reportFeature) as ReportCard);
    expect([feature.lead, feature.tone]).toEqual(['Feature request', 'mut']);
    const removed = reportLine(reportCardOf(reportRemoved) as ReportCard);
    expect(removed.detail).toBe('Content removed');
    expect(removed.quiet).toBe(true);
    expect(removed.meta).not.toContain('0 screenshots');
  });

  it('tones by status first: resolved ok, closed muted', () => {
    expect(reportTone({ ...likely, status: 'resolved' })).toBe('ok');
    expect(reportTone({ ...likely, status: 'closed' })).toBe('mut');
    expect(reportTone({ ...likely, assessment: { ...likely.assessment, outcome: 'confirmed_bug' } })).toBe(
      'warn',
    );
    expect(reportTone({ ...likely, assessment: { state: 'blocked', outcome: null, summary: null } })).toBe(
      'warn',
    );
  });

  it('folds only the server’s header into the row, whatever the integration is called now', () => {
    const card = { type: 'bug', reference: 'FB-3B50-6X0Q' } as const;
    expect(reportHeaderOnly('Bug report FB-3B50-6X0Q · Website Feedback', card)).toBe(true);
    expect(reportHeaderOnly('Bug report FB-3B50-6X0Q', card)).toBe(true);
    expect(reportHeaderOnly('Bug report FB-3B50-6X0Q · Renamed site', card)).toBe(true);
    expect(reportHeaderOnly('Feature request FB-3B50-6X0Q · Website Feedback', card)).toBe(false);
    expect(reportHeaderOnly('Bug report FB-3B50-6X0Q · Website Feedback\nPlease look', card)).toBe(false);
    expect(reportHeaderOnly('New bug report from Burrow Billing.', card)).toBe(false);
    expect(reportHeaderOnly(`Bug report FB-3B50-6X0Q · ${'x'.repeat(61)}`, card)).toBe(false);
    expect(textFoldsIntoCard('Bug report FB-7K3Q-9M2X · Burrow Billing', likely)).toBe(true);
    expect(textFoldsIntoCard('Bug report FB-7K3Q-9M2X · Burrow Billing', null)).toBe(false);
    expect(textFoldsIntoCard('Plan', { kind: 'pill', text: 'x' } as unknown as MessageCard)).toBe(false);
  });
});

describe('the deploy card (contracts 0.55, CT-297; MX-09)', () => {
  const deploy = {
    kind: 'deploy',
    deploymentId: 'dpl_1',
    environment: 'production',
    service: 'api',
    status: 'succeeded',
    sha: '3F9C2A1B7E',
    url: 'https://api.example.com',
    runId: 'run_1',
  } as const satisfies MessageCard;

  it('is always one line: what was deployed where, the short sha, ok or bad', () => {
    expect(cardDisplay(deploy)).toBe('line');
    expect(deploySettledLine(deploy)).toEqual({
      lead: 'Deployed api to production',
      detail: '3f9c2a',
      tone: 'ok',
    });
    expect(deploySettledLine({ ...deploy, status: 'failed', sha: null })).toEqual({
      lead: 'Deploy of api to production failed',
      detail: null,
      tone: 'bad',
    });
  });

  it('shows inside the run that deployed', () => {
    const runMessage = { id: 'msg_run', card: { kind: 'run', run: { ...run, id: 'run_1' } } as MessageCard };
    const deployMessage = { id: 'msg_deploy', card: deploy };
    const folds = foldIntoRuns([runMessage, deployMessage]);
    expect(folds.hidden.has('msg_deploy')).toBe(true);
    expect(folds.inside.get('msg_run')?.map((m) => m.id)).toEqual(['msg_deploy']);
    expect(foldIntoRuns([{ id: 'msg_deploy', card: { ...deploy, runId: null } }]).hidden.size).toBe(0);
  });
});

describe('a server task’s card (contracts 0.116, CT-880; AP-4300…AP-4302)', () => {
  const started = '2026-10-21T10:00:00.000Z';
  const ended = '2026-10-21T10:04:12.000Z';
  const task = (over: Partial<TaskCard> = {}): TaskCard => ({
    kind: 'task',
    followedTaskId: 'ftk_ha0updates01' as TaskCard['followedTaskId'],
    serverId: 'home-assistant',
    server: 'Home Assistant',
    title: 'Installing 23 updates on Home Assistant',
    state: 'running',
    startedAt: started,
    endedAt: null,
    result: null,
    ...over,
  });
  const at = (iso: string) => Date.parse(iso);
  const done = task({
    state: 'ok',
    endedAt: ended,
    result: 'Home Assistant is up to date: 23 updates installed. It needs a restart to finish.',
  });

  it('is the live card while it runs and a line once it ended, whichever way', () => {
    expect(cardDisplay(task())).toBe('live');
    for (const state of ['ok', 'warning', 'error', 'lost'] as const)
      expect(cardDisplay(task({ state, endedAt: ended }))).toBe('line');
  });

  it('says how it went first and how long it took after, as core’s line does', () => {
    const line = taskLine(done, at('2026-10-21T11:00:00.000Z'));
    expect(line.tone).toBe('ok');
    expect(line.lead).toContain('23 updates installed');
    expect(line.lead).not.toContain('restart');
    expect(line.detail).toBe('4 min');
    expect(`${line.lead} · ${line.detail}`).toBe(taskCardLine(done, at('2026-10-21T11:00:00.000Z')));
  });

  it('gives each end its own tone', () => {
    const tones = (['running', 'ok', 'warning', 'error', 'lost'] as const).map((s) => TASK_TONES[s]);
    expect(tones).toEqual(['live', 'ok', 'warn', 'bad', 'mut']);
    const failed = task({
      state: 'error',
      endedAt: ended,
      result: 'Backing up web on pve-02 didn’t work: the storage is full.',
    });
    expect(taskLine(failed, 0)).toMatchObject({ tone: 'bad', detail: '4 min' });
    expect(taskLine(failed, 0).lead).toContain('storage is full');
  });

  it('names the state when there are no words, and says it lost track without a time', () => {
    const bare = taskLine(task({ state: 'warning', endedAt: ended }), 0);
    expect(bare.lead).toContain('Installing 23 updates on Home Assistant');
    expect(bare.lead).toContain(TASK_CARD_WORDS.states.warning);
    expect(bare.detail).toBe('4 min');
    const lost = taskLine(task({ state: 'lost', endedAt: ended, result: taskLostText('Home Assistant') }), 0);
    expect(lost).toEqual({
      lead: 'Installing 23 updates on Home Assistant',
      detail: TASK_CARD_WORDS.lostLine,
      tone: 'mut',
    });
  });

  it('runs its clock from the start while running, and stops it at the end', () => {
    const running = taskCardView(task(), at('2026-10-21T10:00:12.000Z'));
    expect(running.elapsed).toBe('12 s');
    expect(running.state).toBe(TASK_CARD_WORDS.states.running);
    expect(running.label).toContain('Home Assistant');
    expect(running.label).toContain('Installing 23 updates');
    expect(taskCardView(done, at('2026-10-22T10:00:00.000Z')).elapsed).toBe('4 min');
    expect(taskCardView(task({ state: 'lost', endedAt: ended }), 0).elapsed).toBeNull();
  });

  it('folds the runtime’s words for the card into it, and keeps anyone’s own', () => {
    expect(textFoldsIntoCard(taskCardLine(task(), at(started)), task())).toBe(true);
    expect(textFoldsIntoCard('Installing 23 updates on Home Assistant', task())).toBe(true);
    expect(textFoldsIntoCard('[task: Installing 23 updates on Home Assistant, ok]', done)).toBe(true);
    expect(textFoldsIntoCard('Home Assistant is up to date: 23 updates installed · 4 min', done)).toBe(true);
    expect(taskTextOnly('', done)).toBe(true);
    expect(textFoldsIntoCard('I’ve started the updates, I’ll tell you when they’re done.', task())).toBe(
      false,
    );
  });
});

describe('an image’s preview over a session (contracts 0.55, CT-298)', () => {
  it('is cached apart from the file', () => {
    const ref = { kind: 'attachment', burrow: 'hq', attachmentId: 'att_1' } as const;
    expect(resourceKey(ref)).toBe('att:hq:att_1');
    expect(resourceKey({ ...ref, variant: 'original' })).toBe('att:hq:att_1');
    expect(resourceKey({ ...ref, variant: 'preview' })).toBe('att:hq:att_1:preview');
  });
});

describe('a one-time Find My watch (findmy-watch.md)', () => {
  const AMS = 'Europe/Amsterdam';
  const now = Date.parse('2026-11-23T12:00:00Z');
  const watch: FindMyWatchView = {
    id: 'fmw_noor',
    name: 'Noor Visser',
    change: 'leaves',
    place: 'Keizersgracht',
    status: 'watching',
    startedAt: '2026-11-23T11:00:00Z',
    endsAt: '2026-11-24T11:00:00Z',
    endedAt: null,
    to: null,
  };
  const card = (w: FindMyWatchView | null): MessageCard => ({
    kind: 'findmy_watch',
    watchId: 'fmw_noor',
    watch: w,
  });

  it('is the card while it watches and a line once it ended or can’t be read', () => {
    expect(cardDisplay(card(watch))).toBe('full');
    expect(cardDisplay(card({ ...watch, status: 'cancelled', endedAt: '2026-11-23T11:30:00Z' }))).toBe(
      'line',
    );
    expect(cardDisplay(card(null))).toBe('line');
  });

  it('splits what happened from when, in the tone of how it ended', () => {
    const happened = findMyWatchLine(
      { ...watch, status: 'happened', endedAt: '2026-11-23T13:05:00Z', to: 'Amstelveen' },
      AMS,
      now,
    );
    expect(happened.lead).toContain('Noor Visser');
    expect(happened.lead).not.toContain(' · ');
    expect(happened.detail).toBe('14:05');
    expect(happened.tone).toBe('ok');
    const cancelled = findMyWatchLine(
      { ...watch, status: 'cancelled', endedAt: '2026-11-23T11:30:00Z' },
      AMS,
      now,
    );
    expect(cancelled.lead).toContain('Noor Visser');
    expect(cancelled.detail).toBeNull();
    expect(cancelled.tone).toBe(FIND_MY_WATCH_TONES.cancelled);
    expect(findMyWatchLine({ ...watch, status: 'stopped' }, AMS, now).tone).toBe('warn');
  });
});
