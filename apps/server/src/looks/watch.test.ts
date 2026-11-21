import { describe, expect, it } from 'vitest';
import { lineKey, linesCovered, lookLines } from './lines';
import {
  findingPushText,
  goAheadText,
  handleText,
  lookPlanViewOf,
  lookResearchOf,
  researchOpening,
} from './research';
import {
  FIXED_HOLD_MS,
  LOOK_TRIES,
  LOOKING_MAX_MS,
  newProblem,
  type PassInput,
  planPass,
  REMEMBER_MS,
  RESEARCH_PER_DAY,
  RESEARCH_PER_THING,
  RETRY_AFTER_MS,
  seenOf,
  type WatchedLook,
  type WatchedRow,
  watchedLook,
} from './watch';

const now = new Date('2026-10-27T13:00:00Z');
const look = (key: string, more: Partial<WatchedLook> = {}): WatchedLook => ({
  key,
  kind: 'connection',
  name: key.split(':')[1] ?? key,
  rank: 2,
  reason: null,
  question: null,
  check: 'ha.integrations',
  subject: '',
  since: null,
  lines: [],
  nature: 'problem',
  ...more,
});
const row = (key: string, more: Partial<WatchedRow> = {}): WatchedRow => ({
  id: `lkr_${key.replace(/\W/g, '')}`,
  key,
  kind: 'connection',
  rank: 2,
  check: 'ha.integrations',
  subject: '',
  lines: [],
  state: 'found',
  startedAt: new Date(now.getTime() - 60_000),
  stateAt: new Date(now.getTime() - 60_000),
  turnEnded: true,
  tries: 1,
  ...more,
});
const pass = (more: Partial<PassInput>): PassInput => ({
  looks: [],
  live: [],
  ended: new Map(),
  before: new Set(),
  startedToday: new Map(),
  serversRead: true,
  ready: true,
  now,
  ...more,
});

describe('the watcher (look-research.md LR-01…LR-03)', () => {
  it('looks into a failed research once more a while later, in place of starting another', () => {
    const ha = look('connection:ha');
    const upnp = look('connection:upnp');
    const before = new Set([seenOf(ha), seenOf(upnp)]);
    const failed = row('connection:ha', {
      state: 'failed',
      stateAt: new Date(now.getTime() - RETRY_AFTER_MS),
    });
    const plan = planPass(pass({ looks: [ha, upnp], live: [failed], before }));
    expect([plan.retry, plan.start]).toEqual([failed.id, null]);
    // Too soon, tried enough, or not ready: no retry, and the next look may start.
    const soon = { ...failed, stateAt: new Date(now.getTime() - RETRY_AFTER_MS + 1_000) };
    expect(planPass(pass({ looks: [ha, upnp], live: [soon], before })).retry).toBeNull();
    expect(planPass(pass({ looks: [ha, upnp], live: [soon], before })).start?.key).toBe('connection:upnp');
    const tried = { ...failed, tries: LOOK_TRIES };
    expect(planPass(pass({ looks: [ha, upnp], live: [tried], before })).retry).toBeNull();
    expect(planPass(pass({ looks: [ha], live: [failed], before, ready: false })).retry).toBeNull();
  });

  it('starts on a look seen on two passes in a row, never on the first sight', () => {
    const ha = look('connection:ha');
    expect(planPass(pass({ looks: [ha], before: null })).start).toBeNull();
    expect(planPass(pass({ looks: [ha], before: new Set() })).start).toBeNull();
    const second = planPass(pass({ looks: [ha], before: new Set([seenOf(ha)]) }));
    expect(second.start?.key).toBe('connection:ha');
    expect(second.seen.has(seenOf(ha))).toBe(true);
  });

  it('takes them one at a time in the desk’s order, at most twelve a day, only when a turn could run', () => {
    const a = look('server:pve-02', { kind: 'server', rank: 0 });
    const b = look('connection:ha');
    const before = new Set([seenOf(a), seenOf(b)]);
    expect(planPass(pass({ looks: [a, b], before })).start?.key).toBe('server:pve-02');
    // One looking already: the rest wait.
    const busy = row('server:pve-02', { kind: 'server', rank: 0, state: 'looking', turnEnded: false });
    expect(planPass(pass({ looks: [a, b], before, live: [busy] })).start).toBeNull();
    // Found already: the next one starts.
    const found = { ...busy, state: 'found' };
    expect(planPass(pass({ looks: [a, b], before, live: [found] })).start?.key).toBe('connection:ha');
    const today = new Map([['connection:other', RESEARCH_PER_DAY]]);
    expect(planPass(pass({ looks: [a, b], before, startedToday: today })).start).toBeNull();
    expect(planPass(pass({ looks: [a, b], before, ready: false })).start).toBeNull();
  });

  it('looks into a problem once while it stays, again when it comes back, gets worse or its line changes', () => {
    const ha = look('connection:ha');
    const before = new Set([seenOf(ha)]);
    const kept = row('connection:ha');
    // Still there: kept, not started again.
    expect(planPass(pass({ looks: [ha], before, live: [kept] }))).toMatchObject({ gone: [], start: null });
    // Went: its row ends.
    expect(planPass(pass({ looks: [], live: [kept] })).gone).toEqual([kept.id]);
    // Worse: a new problem.
    expect(newProblem(kept, { ...ha, rank: 1 })).toBe(true);
    // Better: the same one.
    expect(newProblem(row('connection:ha', { rank: 1 }), ha)).toBe(false);
    // Another line or item: a new problem; a read that doesn't know the line says nothing.
    expect(newProblem(kept, { ...ha, check: 'conn.signin' })).toBe(true);
    expect(newProblem(kept, { ...ha, subject: 'zha' })).toBe(true);
    expect(newProblem(kept, { ...ha, check: null })).toBe(false);
    const worse = { ...ha, rank: 1 as const };
    const plan = planPass(pass({ looks: [worse], before: new Set([seenOf(worse)]), live: [kept] }));
    expect(plan.gone).toEqual([kept.id]);
    expect(plan.start?.key).toBe('connection:ha');
  });

  it('gives a look that came back as it was its last finding, at once and without a turn', () => {
    const beast = look('server:the-titan', { kind: 'server', check: 'host.hint.system.failed_units' });
    const last = row('server:the-titan', {
      kind: 'server',
      check: 'host.hint.system.failed_units',
      stateAt: new Date(now.getTime() - 60 * 60_000),
    });
    const ended = new Map([[beast.key, last]]);
    // First sight, even busy, past the day's budget or not ready: it costs no turn.
    const busy = row('connection:ha', { state: 'looking', turnEnded: false });
    const today = new Map([['connection:other', RESEARCH_PER_DAY]]);
    expect(
      planPass(
        pass({ looks: [beast], ended, before: null, live: [busy], startedToday: today, ready: false }),
      ),
    ).toMatchObject({ revive: [last.id], start: null });
    // Worse, another line, an old finding, or a finding that isn't one: looked into again.
    const before = (l: WatchedLook) => new Set([seenOf(l)]);
    const worse = { ...beast, rank: 0 as const };
    expect(planPass(pass({ looks: [worse], ended, before: before(worse) }))).toMatchObject({
      revive: [],
      start: { key: beast.key },
    });
    const disk = { ...beast, check: 'host.disk.full_soon' };
    expect(planPass(pass({ looks: [disk], ended, before: before(disk) })).revive).toEqual([]);
    const old = new Map([[beast.key, { ...last, stateAt: new Date(now.getTime() - REMEMBER_MS) }]]);
    expect(planPass(pass({ looks: [beast], ended: old, before: before(beast) })).start?.key).toBe(beast.key);
    for (const state of ['fixed', 'failed']) {
      const other = new Map([[beast.key, { ...last, state }]]);
      expect(planPass(pass({ looks: [beast], ended: other, before: before(beast) })).revive).toEqual([]);
    }
  });

  it('looks into one thing at most twice a day', () => {
    const beast = look('server:the-titan', { kind: 'server' });
    const ha = look('connection:ha');
    const before = new Set([seenOf(beast), seenOf(ha)]);
    const twice = new Map([[beast.key, RESEARCH_PER_THING]]);
    expect(planPass(pass({ looks: [beast, ha], before, startedToday: twice })).start?.key).toBe(ha.key);
    const once = new Map([[beast.key, RESEARCH_PER_THING - 1]]);
    expect(planPass(pass({ looks: [beast, ha], before, startedToday: once })).start?.key).toBe(beast.key);
  });

  it('takes back a fix that didn’t hold: still there long after, it is looked into again', () => {
    const ha = look('connection:ha');
    const fixed = row('connection:ha', { state: 'fixed', stateAt: new Date(now.getTime() - 60_000) });
    expect(planPass(pass({ looks: [ha], live: [fixed] })).gone).toEqual([]);
    const held = { ...fixed, stateAt: new Date(now.getTime() - FIXED_HOLD_MS) };
    const plan = planPass(pass({ looks: [ha], before: new Set([seenOf(ha)]), live: [held] }));
    expect(plan.gone).toEqual([held.id]);
    expect(plan.start?.key).toBe('connection:ha');
  });

  it('keeps a server’s research while the servers can’t be read', () => {
    const server = row('server:pve-02', { kind: 'server' });
    expect(planPass(pass({ live: [server], serversRead: false })).gone).toEqual([]);
    expect(planPass(pass({ live: [server], serversRead: true })).gone).toEqual([server.id]);
  });

  it('settles a turn that ended without a report, or a research no turn took', () => {
    const ha = look('connection:ha');
    const ended = row('connection:ha', { state: 'looking', turnEnded: true });
    expect(planPass(pass({ looks: [ha], live: [ended] })).unreported).toEqual([ended.id]);
    const fixing = row('connection:ha', { state: 'fixing', turnEnded: true });
    expect(planPass(pass({ looks: [ha], live: [fixing] })).unreported).toEqual([fixing.id]);
    const running = row('connection:ha', { state: 'looking', turnEnded: false });
    expect(planPass(pass({ looks: [ha], live: [running] })).unreported).toEqual([]);
    const stale = { ...running, startedAt: new Date(now.getTime() - LOOKING_MAX_MS) };
    expect(planPass(pass({ looks: [ha], live: [stale] })).unreported).toEqual([stale.id]);
    // A stale one no longer holds the next look back.
    const nas = look('connection:nas');
    expect(
      planPass(pass({ looks: [ha, nas], before: new Set([seenOf(nas)]), live: [stale] })).start?.key,
    ).toBe('connection:nas');
  });

  it('never weighs a heads-up, and keeps the line of a problem or only-you look', () => {
    const base = {
      key: 'connection:con_ha',
      kind: 'connection' as const,
      name: 'Home Assistant',
      state: 'bad' as const,
    };
    expect(watchedLook({ ...base, nature: 'fyi' }, null)).toBeNull();
    expect(
      watchedLook({ ...base, nature: 'you', notice: { check: 'conn.signin' }, question: 'Why?' }, null),
    ).toMatchObject({ rank: 1, check: 'conn.signin', subject: '', question: 'Why?', nature: 'you' });
    expect(watchedLook({ ...base, state: 'down' }, null)).toMatchObject({ rank: 0, check: null });
  });

  it('opens the thread with what Whombat saw, and the press says go ahead in the person’s words', () => {
    expect(researchOpening({ kind: 'connection', name: 'Home Assistant', rank: 2 })).toBe(
      'Home Assistant needs a look. I’m looking into it.',
    );
    expect(researchOpening({ kind: 'server', name: 'pve-02', rank: 0 })).toContain('pve-02 isn’t answering.');
    expect(goAheadText('Restart Zigbee')).toBe('Go ahead: restart Zigbee.');
    expect(goAheadText('UPS self-test.')).toBe('Go ahead: UPS self-test.');
  });
});

describe('one research covers every line of a thing (handle-it.md)', () => {
  const backups = {
    check: 'guest.no_backup_job',
    subject: '',
    title: '6 machines have no backup plan',
    nature: 'you' as const,
  };
  const updates = { check: 'system.updates', subject: '', title: '1 update waiting', nature: 'you' as const };
  const nginx = {
    check: 'system.failed_units',
    subject: 'nginx',
    title: 'nginx stopped',
    nature: 'problem' as const,
  };

  it('keeps a thing’s lines once each, never a heads-up', () => {
    const lines = lookLines([
      { check: 'guest.no_backup_job', title: '6 machines have no backup plan', nature: 'you' },
      { check: 'guest.no_backup_job', title: 'again', nature: 'you' },
      { check: 'docker.image_updates', title: '2 app updates', nature: 'fyi' },
      { check: 'system.failed_units', subject: { id: 'nginx' }, title: 'nginx  stopped', nature: 'problem' },
    ]);
    expect(lines.map(lineKey)).toEqual(['guest.no_backup_job|', 'system.failed_units|nginx']);
    expect(lines[1]?.title).toBe('nginx stopped');
    expect(
      lookLines(
        Array.from({ length: 20 }, (_, i) => ({ check: `c${i}`, title: 'x', nature: 'you' as const })),
      ),
    ).toHaveLength(12);
  });

  it('is a new problem only for a line it didn’t look into, never for one that went', () => {
    const r = { rank: 2, check: backups.check, subject: '', lines: [backups, updates] };
    expect(newProblem(r, { rank: 2, check: updates.check, subject: '', lines: [updates] })).toBe(false);
    expect(newProblem(r, { rank: 2, check: backups.check, subject: '', lines: [backups, nginx] })).toBe(true);
    // Worse is still new; a row from before compares its own line.
    expect(newProblem(r, { rank: 1, check: backups.check, subject: '', lines: [backups] })).toBe(true);
    expect(
      newProblem({ ...r, lines: [] }, { rank: 2, check: updates.check, subject: '', lines: [updates] }),
    ).toBe(true);
    expect(linesCovered([], [nginx])).toBe(true);
  });

  it('sees a look again only with the same lines', () => {
    const a = look('server:pve-01', { lines: [backups, updates] });
    expect(seenOf(a)).toBe(seenOf(look('server:pve-01', { lines: [updates, backups] })));
    expect(seenOf(a)).not.toBe(seenOf(look('server:pve-01', { lines: [backups] })));
    const w = watchedLook(
      { key: 'server:pve-01', kind: 'server', name: 'pve-01', state: 'look', nature: 'you' },
      null,
      [backups],
    );
    expect(w?.lines).toEqual([backups]);
  });
});

describe('a plan and its card (handle-it.md)', () => {
  const base = {
    id: 'lkr_plan00000001',
    burrowId: 'bur_x',
    agentId: 'prn_dusty',
    personId: 'prn_mara',
    lookKey: 'server:pve-01',
    kind: 'server' as const,
    name: 'pve-01',
    checkId: 'guest.no_backup_job',
    subject: '',
    rank: 2,
    reason: null,
    question: null,
    since: null,
    state: 'found' as const,
    title: 'pve-01 isn’t backed up',
    summary: 'Six machines have no backup and an update waits.',
    fixLabel: null,
    fixStep: null,
    conversationId: 'cnv_x',
    threadRootId: 'msg_x',
    dispatchId: null,
    startedAt: now,
    stateAt: now,
    reportedAt: now,
    goneAt: null,
    lines: [],
    plan: [
      { text: 'Add the 6 machines to a nightly backup at 02:00, keeping a week', step: 'backup_job_set …' },
      { text: 'Install the 1 update tonight at 03:00', step: 'schedule server_update' },
    ],
    askedById: null,
    planMessageId: 'msg_card',
    pushedAt: null,
    care: null,
  };

  it('shows the plan while it waits, is taken and once done; never with a step button', () => {
    const r = lookResearchOf(base);
    expect(r.plan).toHaveLength(2);
    expect(r.fix).toBeUndefined();
    expect(lookResearchOf({ ...base, plan: null, fixLabel: 'Restart nginx', fixStep: 'x' }).fix).toBe(
      'Restart nginx',
    );
    expect(lookResearchOf({ ...base, state: 'looking' }).plan).toBeUndefined();
  });

  it('says where the card is: waiting, doing, done, or gone', () => {
    expect(lookPlanViewOf(base)?.state).toBe('waiting');
    expect(lookPlanViewOf({ ...base, state: 'fixing' })?.state).toBe('doing');
    expect(lookPlanViewOf({ ...base, state: 'fixed' })?.state).toBe('done');
    expect(lookPlanViewOf({ ...base, state: 'fixed', goneAt: now })?.state).toBe('done');
    expect(lookPlanViewOf({ ...base, goneAt: now })).toMatchObject({ state: 'gone', research: null });
    expect(lookPlanViewOf({ ...base, plan: null })).toBeNull();
    expect(lookPlanViewOf(base)?.name).toBe('pve-01');
  });

  it('pushes the finding in plain words', () => {
    expect(findingPushText(base)).toContain('2 steps');
    expect(findingPushText({ ...base, plan: null, fixLabel: 'Remove the 3 oldest' })).toBe(
      'pve-01 isn’t backed up. I can remove the 3 oldest.',
    );
    expect(findingPushText({ ...base, plan: null })).toBeNull();
    expect(handleText('pve-01')).toContain('pve-01');
  });
});

describe('a new server’s care plan beside its looks (care-plan.md)', () => {
  const care = (more: Partial<WatchedRow> = {}) =>
    row('care:server:pve-01', {
      kind: 'server',
      check: null,
      care: true,
      state: 'found',
      turnEnded: true,
      ...more,
    });
  const servers = new Set(['server:pve-01']);
  const backups = look('server:pve-01', {
    kind: 'server',
    check: 'host.hint.guest.no_backup_job',
    nature: 'you',
    lines: [
      {
        check: 'host.hint.guest.no_backup_job',
        subject: '',
        title: '6 machines have no backup plan',
        nature: 'you',
      },
    ],
  });

  it('stays while it waits, though no look is there, and ends once its server went or it is done', () => {
    expect(planPass(pass({ live: [care()], servers })).gone).toEqual([]);
    expect(planPass(pass({ live: [care()], servers: new Set() })).gone).toEqual([care().id]);
    const done = care({ state: 'fixed', stateAt: new Date(now.getTime() - FIXED_HOLD_MS) });
    expect(planPass(pass({ live: [done], servers })).gone).toEqual([done.id]);
    const just = care({ state: 'fixed', stateAt: now });
    expect(planPass(pass({ live: [just], servers })).gone).toEqual([]);
  });

  it('leaves the server’s missing backups to its plan while it waits, but looks into a real problem', () => {
    const before = new Set([seenOf(backups)]);
    expect(planPass(pass({ looks: [backups], live: [care()], before, servers })).start).toBeNull();
    const disk = look('server:pve-01', {
      kind: 'server',
      check: 'host.disk.space_high',
      lines: [
        ...backups.lines,
        {
          check: 'host.disk.space_high',
          subject: 'fs:/',
          title: 'The system disk is filling up',
          nature: 'problem',
        },
      ],
    });
    const worse = planPass(pass({ looks: [disk], live: [care()], before: new Set([seenOf(disk)]), servers }));
    expect(worse.start?.key).toBe('server:pve-01');
    // Once its plan is done, the lines are a look's again.
    const done = care({ state: 'fixed', stateAt: now });
    expect(planPass(pass({ looks: [backups], live: [done], before, servers })).start?.key).toBe(
      'server:pve-01',
    );
  });

  it('is settled like a look when its turn ended without a report', () => {
    const looking = care({ state: 'looking' });
    expect(planPass(pass({ live: [looking], servers })).unreported).toEqual([looking.id]);
  });
});
