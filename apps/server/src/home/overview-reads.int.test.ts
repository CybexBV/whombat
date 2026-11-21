/**
 * Request-local Home reads need Postgres: exercise the real connection/approval visibility predicates,
 * snooze expiry and chat joins, and count executed SQL rather than mocked helper calls (test-speed.md TS-04).
 * The existing throwaway harness seeds only people; no HTTP listener or outside service is needed.
 */
import {
  chatThreadHref,
  HomeOverview,
  IDLE_EXECUTION,
  NEEDS_YOU_FIRST_KINDS,
  PlanStep,
  thingHref,
  thingId,
  type WidgetSource,
} from '@whombat/core';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sendMessage } from '../commands/messages';
import * as schema from '../db/schema/index';
import {
  approvals,
  burrows,
  catalogConnections,
  deviceSkills,
  needsYouSnoozes,
  plans,
  principals,
  widgetPoints,
  widgets,
} from '../db/schema/index';
import { buildFullGlance, type DeskPlace, deskFleet, QuestionNumbers } from '../desk/glance';
import { HostsService, setHostsFor } from '../hosts/service';
import { FakeHostsService } from '../hosts/testing/fake';
import { loadAgentRow } from '../read/principals';
import { loadSeedWorld } from '../seed/load';
import { IDS, TEST_NOW, testWorld } from '../seed/test-world';
import type { Services } from '../services';
import { insertConnection } from '../test/connections';
import { useTestServer } from '../test/harness';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import * as partOf from '../things/part-of';
import { type HomeViewer, homeOverview, needsYou, things, watchList, workingTask } from './overview';
import { registerNeedsYouSource, registerThingsSource, registerWatchSource, unregister } from './registry';
import { homeWidgetsNow, listWidgets } from './widgets';

const t = useTestServer({});
const now = new Date(TEST_NOW);
const until = new Date(now.getTime() + 86_400_000);
const connections: Record<string, string> = {};
/** Each person's Chat with the burrow's one agent (Dusty). */
const assistants: Record<string, PersonalSetup> = {};
const questions: Record<string, string> = {};
const shared = ['Shared', 'Offline', 'Snoozed', 'Acknowledged', 'Expired', 'Ignored'];

async function viewer(id: string): Promise<HomeViewer> {
  const principal = await t.services.db.query.principals.findFirst({ where: eq(principals.id, id) });
  const burrow = await t.services.db.query.burrows.findFirst({ where: eq(burrows.id, t.burrowId) });
  if (!principal || !burrow) throw new Error('Missing viewer');
  return { principal, burrow };
}

beforeAll(async () => {
  t.services.clock = () => now;
  const world = testWorld();
  await loadSeedWorld(t.services, { now: TEST_NOW, burrow: world.burrow, people: world.people });
  for (const person of [IDS.mara]) {
    const assistant = await addPersonalAgent(t.services, t.burrowId, person, { services: null });
    assistants[person] = assistant;
    const posted = await t.commit(assistant.agentId, sendMessage, {
      conversationId: assistant.dmId,
      text: 'Shall I check?',
      asks: true,
    });
    if (posted.status !== 'ok') throw new Error(posted.status);
    questions[person] = posted.result.id;
  }
  for (const [i, label] of [...shared, 'Mara personal'].entries()) {
    const id = await insertConnection(t.services, {
      catalogId: 'homeassistant',
      label,
      handle: `home-${i}`,
      fields: { url: 'http://home.test' },
      burrowId: t.burrowId,
      connectedById: label === 'Mara personal' ? IDS.mara : null,
      status: label === 'Offline' ? 'active' : 'needs_reauth',
    });
    connections[label] = id;
    await t.services.db
      .update(catalogConnections)
      .set({
        updatedAt: new Date(now.getTime() - (i + 1) * 60_000),
        ...(label === 'Offline'
          ? { glance: { status: 'offline', line: 'No answer', facts: [] }, glanceAt: now }
          : {}),
      })
      .where(eq(catalogConnections.id, id));
  }
  // Another burrow, an unknown catalog entry and the builtin Servers connection must never enter these sections.
  const [sample] = await t.services.db
    .select()
    .from(catalogConnections)
    .where(eq(catalogConnections.id, connections.Shared as string));
  if (!sample) throw new Error('Missing connection');
  await t.services.db
    .insert(burrows)
    .values({ id: 'bur_elsewhere', name: 'Elsewhere', slug: 'elsewhere', createdAt: now });
  await t.services.db.insert(catalogConnections).values([
    { ...sample, id: 'con_elsewhere', burrowId: 'bur_elsewhere' },
    { ...sample, id: 'con_unknown', catalogId: 'unknown', handle: 'unknown' },
    { ...sample, id: 'con_builtin', catalogId: 'whombat_servers', handle: 'servers' },
  ]);
  await t.services.db.insert(needsYouSnoozes).values([
    ...(['Snoozed', 'Acknowledged', 'Ignored', 'Expired'] as const).map((label) => ({
      burrowId: t.burrowId,
      personId: IDS.mara,
      refKind: 'connection',
      refId: connections[label] as string,
      state:
        label === 'Acknowledged'
          ? ('acknowledged' as const)
          : label === 'Ignored'
            ? ('ignored' as const)
            : ('snoozed' as const),
      until: label === 'Snoozed' ? until : label === 'Expired' ? now : null,
      createdAt: now,
    })),
  ]);
  const mine = assistants[IDS.mara] as PersonalSetup;
  await t.services.db.insert(plans).values({
    id: 'pln_home_reads',
    burrowId: t.burrowId,
    title: 'Check the home',
    conversationId: mine.dmId,
    createdById: mine.agentId,
    createdAt: now,
    updatedAt: now,
    steps: [
      {
        id: 'stp_found',
        title: 'Find it',
        ownerId: mine.agentId,
        state: 'done',
        stateLabel: 'Done',
        note: '',
      },
      {
        id: 'stp_check',
        title: 'Check it',
        ownerId: mine.agentId,
        state: 'active',
        stateLabel: 'In progress',
        note: '',
      },
      {
        id: 'stp_skip',
        title: 'Skip it',
        ownerId: mine.agentId,
        state: 'cancelled',
        stateLabel: 'Cancelled',
        note: '',
      },
    ].map((step) => PlanStep.parse({ ...step, runId: null, approvalId: null })),
  });
  await t.services.db.insert(approvals).values(
    [false].map((privateApproval, i) => ({
      id: `apr_home_reads_${i}`,
      burrowId: t.burrowId,
      number: i + 1,
      requesterId: mine.agentId,
      action: {
        type: 'custom' as const,
        params: { name: 'Check', keyId: 'connections.read' as const, data: {} },
      },
      title: 'Check the service',
      question: 'May I check?',
      conditions: [
        {
          id: 'person',
          kind: 'person_approves' as const,
          label: 'Mara',
          met: false,
          approverIds: [IDS.mara],
          private: privateApproval,
        },
      ],
      execution: IDLE_EXECUTION,
      conversationId: IDS.general,
      createdAt: new Date(now.getTime() - (i + 1) * 1000),
    })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  unregister('needsYou', 'home-read-failure');
  unregister('things', 'home-read-failure');
  unregister('watch', 'home-read-failure');
});

/** The agent's row (`loadAgentRow`): its chats with the viewer and its name in Whombat's words. */
const AGENT_ROW =
  /from "principals" where \("principals"\."burrow_id" = \$1 and "principals"\."kind" = \$2\)/;

function loggedServices(fail?: (query: string) => boolean) {
  const queries: string[] = [];
  const fault = new Error('Home read unavailable');
  const db = drizzle(t.services.sql, {
    schema,
    logger: {
      logQuery(query) {
        queries.push(query);
        if (fail?.(query)) throw fault;
      },
    },
  });
  const services: Services = { ...t.services, db };
  const counts = () => ({
    connections: queries.filter((q) => q.includes('from "catalog_connections"')).length,
    marks: queries.filter((q) => q.includes('from "needs_you_snoozes"')).length,
    agent: queries.filter((q) => AGENT_ROW.test(q)).length,
  });
  return { services, queries, counts };
}

function connectionNeed(label: string, name: string) {
  const id = connections[label] as string;
  const i = [...shared, 'Mara personal'].indexOf(label);
  return {
    id: `connection:${id}`,
    ref: { kind: 'connection', id },
    kind: 'connection',
    severity: 'bad',
    // Only a person can sign in again (quiet-notices.md QN-01).
    nature: 'you',
    title: `${label} needs you to sign in again`,
    body: `${name} can’t use it until then.`,
    at: new Date(now.getTime() - (i + 1) * 60_000).toISOString(),
    subject: { kind: 'connection', id, name: label },
    actions: [
      {
        id: 'reconnect',
        label: 'Sign in again',
        style: 'primary',
        kind: 'open',
        href: thingHref('connection', id),
      },
    ],
    group: 'you',
  };
}

function approvalNeed(number: number) {
  return {
    id: `approval:${number}`,
    ref: { kind: 'approval', id: String(number) },
    kind: 'approval',
    severity: 'warn',
    title: 'May I check?',
    body: '',
    at: new Date(now.getTime() - number * 1000).toISOString(),
    approvalNumber: number,
    actions: [
      { id: 'approve', label: 'Yes, now', style: 'primary', kind: 'approve' },
      {
        id: 'later',
        label: 'Yes, tonight',
        style: 'secondary',
        kind: 'approve_later',
        at: '2026-09-24T01:00:00.000Z',
      },
      { id: 'decline', label: 'No', style: 'secondary', kind: 'decline' },
    ],
    group: 'you',
  };
}

/** Home as `person` sees it (no `working` since contracts 1.0.0: the desk's glance reads it, `workingTask`). */
function expectedHome(person: string) {
  const { working: _working, ...home } = expectedParts(person);
  return home;
}

/** What the Home reads give `person`, the working task among them. */
function expectedParts(person: string) {
  const mara = person === IDS.mara;
  const name = 'Dusty';
  const personal = 'Mara personal';
  const assistant = assistants[person] as PersonalSetup;
  const question = questions[person] as string;
  return {
    // The one count (needs-you-list.md NYL-04): Needs you's five and the connection that isn't answering.
    summary: { needsYou: mara ? 6 : 4, working: mara ? 1 : 0, problems: mara ? 4 : 7, worst: 'bad' },
    needsYou: [
      ...(mara ? ['Shared', 'Expired', personal] : [personal]).map((label) => connectionNeed(label, name)),
      ...[1, ...(mara ? [] : [2])].map(approvalNeed),
      {
        id: `question:${question}`,
        ref: { kind: 'question', id: question },
        kind: 'question',
        severity: 'info',
        title: 'Shall I check?',
        body: `In your chat with ${name}`,
        at: TEST_NOW,
        actions: [
          {
            id: 'answer',
            label: 'Answer',
            style: 'primary',
            kind: 'open',
            href: chatThreadHref('chat', question),
          },
        ],
        group: 'you',
      },
    ],
    working: mara
      ? {
          conversationId: assistant.dmId,
          title: 'Check the home',
          startedAt: TEST_NOW,
          progress: { done: 1, total: 2 },
          steps: [
            { title: 'Find it', state: 'done' },
            { title: 'Check it', state: 'active' },
          ],
        }
      : null,
    chats: [{ conversationId: assistant.dmId, title: name, state: 'waiting', at: TEST_NOW, default: true }],
    things: [...shared, personal]
      .sort((a, b) => a.localeCompare(b))
      .map((label) => ({
        id: thingId('connection', connections[label] as string),
        kind: 'connection',
        catalogId: 'homeassistant',
        name: label,
        icon: 'homeassistant',
        href: thingHref('connection', connections[label] as string),
        status: label === 'Offline' ? 'offline' : 'bad',
        line: label === 'Offline' ? 'No answer' : 'Needs you to sign in again',
        ...(label === 'Offline' ? {} : { reason: 'Needs you to sign in again' }),
        facts: [],
      })),
    automationsToday: [],
    widgets: [],
    doneRecently: [],
    doneToday: [],
    generatedAt: TEST_NOW,
  };
}

function expectedWatch(person: string) {
  const mara = person === IDS.mara;
  const name = 'Dusty';
  const labels = mara ? ['Shared', 'Expired', 'Mara personal'] : shared.filter((s) => s !== 'Offline');
  return [
    {
      id: `connection:${connections.Offline}`,
      ref: { kind: 'connection', id: connections.Offline },
      source: 'connection',
      severity: 'bad',
      nature: 'problem',
      title: 'Offline isn’t answering',
      body: 'No answer',
      at: TEST_NOW,
      state: 'open',
      href: thingHref('connection', connections.Offline as string),
    },
    ...labels.map((label) => {
      const item = connectionNeed(label, name);
      return {
        id: item.id,
        ref: item.ref,
        source: 'connection',
        severity: item.severity,
        nature: 'you',
        title: item.title,
        body: item.body,
        at: item.at,
        state: 'open',
        href: thingHref('connection', item.ref.id),
      };
    }),
  ];
}

describe('Home request reads', () => {
  it('preserves complete Home output and standalone sections', async () => {
    for (const person of [IDS.mara]) {
      const who = await viewer(person);
      const expected = expectedHome(person);
      const { needsYouList: list, ...home } = await homeOverview(t.services, who);
      expect(home).toEqual(expected);
      expect(HomeOverview.safeParse({ ...home, needsYouList: list }).success).toBe(true);
      // The one list (NYL-01): Needs you's and Watch's together, each once, in its group.
      const groups = Object.fromEntries((list ?? []).map((i) => [i.id, i.group]));
      expect(groups).toEqual({
        ...Object.fromEntries(expected.needsYou.map((i) => [i.id, 'you'])),
        [`connection:${connections.Offline}`]: 'you',
        [`connection:${connections.Snoozed}`]: 'quiet',
        [`connection:${connections.Acknowledged}`]: 'quiet',
        [`connection:${connections.Ignored}`]: 'quiet',
      });
      expect(await needsYou(t.services, who)).toEqual(expected.needsYou);
      expect(await things(t.services, who)).toEqual(expected.things);
      expect(await workingTask(t.services, who)).toEqual(expectedParts(person).working);
      expect(await watchList(t.services, who)).toEqual(expectedWatch(person));
    }
    const all = await watchList(t.services, await viewer(IDS.mara), { state: 'all' });
    expect(all.filter((i) => i.state !== 'open').map((i) => [i.ref.id, i.state, i.snoozedUntil])).toEqual([
      [connections.Snoozed, 'snoozed', until.toISOString()],
      [connections.Acknowledged, 'acknowledged', undefined],
      [connections.Ignored, 'acknowledged', undefined],
    ]);
  });

  it('executes each common read once per overview while standalone calls stay independent', async () => {
    const logged = loggedServices();
    const who = await viewer(IDS.mara);
    const { needsYouList: _list, ...home } = await homeOverview(logged.services, who);
    expect(home).toEqual(expectedHome(IDS.mara));
    expect(logged.counts()).toEqual({ connections: 1, marks: 1, agent: 1 });
    logged.queries.length = 0;
    await needsYou(logged.services, who);
    await things(logged.services, who);
    await watchList(logged.services, who);
    expect(logged.counts()).toEqual({ connections: 3, marks: 2, agent: 2 });
    logged.queries.length = 0;
    await things(logged.services, who);
    expect(logged.counts()).toEqual({ connections: 1, marks: 0, agent: 0 });
  });

  it('does not reuse names, marks, connections or permissions in the next request', async () => {
    const who = await viewer(IDS.mara);
    const assistant = assistants[IDS.mara] as PersonalSetup;
    const before = await homeOverview(t.services, who);
    try {
      await t.services.db
        .update(principals)
        .set({ name: 'Bramble' })
        .where(eq(principals.id, assistant.agentId));
      await t.services.db
        .update(catalogConnections)
        .set({ label: 'Changed service' })
        .where(eq(catalogConnections.id, connections.Shared as string));
      await t.services.db.insert(needsYouSnoozes).values({
        burrowId: t.burrowId,
        personId: IDS.mara,
        refKind: 'question',
        refId: questions[IDS.mara] as string,
        state: 'ignored',
        until: null,
        createdAt: now,
      });
      const after = await homeOverview(t.services, who);
      expect(after.needsYou.some((i) => i.kind === 'question')).toBe(false);
      expect(after.chats).toEqual([
        {
          conversationId: assistant.dmId,
          title: 'Bramble',
          state: 'working',
          at: TEST_NOW,
          default: true,
          progress: { done: 1, total: 2 },
          step: 'Check it',
        },
      ]);
      expect(after.needsYou.find((i) => i.ref.id === connections.Shared)).toMatchObject({
        title: 'Changed service needs you to sign in again',
        body: 'Bramble can’t use it until then.',
      });
    } finally {
      await t.services.db
        .update(principals)
        .set({ name: 'Dusty' })
        .where(eq(principals.id, assistant.agentId));
      await t.services.db
        .update(catalogConnections)
        .set({ label: 'Shared' })
        .where(eq(catalogConnections.id, connections.Shared as string));
      await t.services.db
        .delete(needsYouSnoozes)
        .where(eq(needsYouSnoozes.refId, questions[IDS.mara] as string));
    }
    expect(await homeOverview(t.services, who)).toEqual(before);
  });

  it('keeps optional-source and parent-server failures isolated, and required database failures fatal', async () => {
    const fail = async () => {
      throw new Error('Optional source unavailable');
    };
    registerNeedsYouSource('home-read-failure', fail);
    registerThingsSource('home-read-failure', fail);
    registerWatchSource('home-read-failure', fail);
    vi.spyOn(partOf, 'partOfMap').mockRejectedValue(new Error('No server map'));
    const who = await viewer(IDS.mara);
    const { needsYouList: _list, ...home } = await homeOverview(t.services, who);
    expect(home).toEqual(expectedHome(IDS.mara));
    for (const match of [
      (q: string) => q.includes('from "catalog_connections"'),
      (q: string) => q.includes('from "needs_you_snoozes"'),
      (q: string) => AGENT_ROW.test(q),
    ]) {
      const logged = loggedServices(match);
      await expect(homeOverview(logged.services, who)).rejects.toThrow();
    }
  });
});

/** The desk screen's place for Mara: her burrow, her row, the burrow's agent and her zone. */
async function deskPlace(): Promise<DeskPlace> {
  const who = await viewer(IDS.mara);
  const agent = await loadAgentRow(t.services.db, t.burrowId);
  if (!agent || !who.principal.accountId) throw new Error('Missing place');
  return {
    burrow: who.burrow,
    person: who.principal,
    agent,
    accountId: who.principal.accountId,
    timeZone: who.burrow.timeZone,
  };
}

describe('Home widgets with their value now', () => {
  const hours = (n: number) => new Date(now.getTime() - n * 3600_000);
  const source: WidgetSource = { kind: 'server_metric', serverId: 'pve', series: ['cpu_pct'] };

  /** Widgets of every kind the glance meets, removed again after each test (Home's full output has none). */
  async function pin() {
    const rows = [
      {
        id: 'wdg_now_heat',
        title: 'Heat pump',
        subtitle: 'Flow',
        series: [{ key: 'flow', label: 'Flow', unit: '°C', color: 1 as const }],
      },
      {
        id: 'wdg_now_power',
        title: 'Power',
        series: [
          { key: 'solar', label: 'Solar', color: 1 as const },
          { key: 'grid', label: 'Grid', unit: 'kW', color: 2 as const },
        ],
      },
      {
        id: 'wdg_now_empty',
        title: 'Nothing yet',
        series: [{ key: 'v', label: 'Value', color: 1 as const }],
      },
      {
        id: 'wdg_now_old',
        title: 'Only yesterday',
        series: [{ key: 'v', label: 'Value', color: 1 as const }],
      },
      {
        id: 'wdg_now_broken',
        title: 'Broken',
        lastError: 'Couldn’t read it just now.',
        series: [{ key: 'v', label: 'Value', color: 1 as const }],
      },
      {
        id: 'wdg_now_page',
        title: 'On a page',
        thingId: `connection:${connections.Shared}`,
        series: [{ key: 'v', label: 'Value', color: 1 as const }],
      },
    ];
    await t.services.db.insert(widgets).values(
      rows.map((r, position) => ({
        burrowId: t.burrowId,
        ownerId: IDS.mara,
        source,
        position,
        refreshedAt: now,
        createdAt: hours(30),
        ...r,
      })),
    );
    await t.services.db.insert(widgetPoints).values([
      { widgetId: 'wdg_now_heat', t: hours(2), values: { flow: 30 } },
      { widgetId: 'wdg_now_heat', t: hours(1), values: { flow: 38.46 } },
      // The newest point counts, even with a series it has no value for.
      { widgetId: 'wdg_now_power', t: hours(3), values: { solar: 5, grid: 6 } },
      { widgetId: 'wdg_now_power', t: hours(0.5), values: { solar: null, grid: 1234.4 } },
      { widgetId: 'wdg_now_old', t: hours(25), values: { v: 7 } },
      { widgetId: 'wdg_now_broken', t: hours(1), values: { v: 3 } },
      { widgetId: 'wdg_now_page', t: hours(1), values: { v: 9 } },
    ]);
  }

  afterEach(async () => {
    await t.services.db.delete(widgets).where(eq(widgets.ownerId, IDS.mara));
  });

  it('reads what Home draws without the points, in one statement', async () => {
    await pin();
    const mara = (await viewer(IDS.mara)).principal;
    const full = await listWidgets(t.services.db, mara, now);
    const logged = loggedServices();
    const latest = await homeWidgetsNow(logged.services.db, mara, now);
    expect(latest).toEqual(full.map(({ points: _points, ...w }) => w));
    expect(latest.map((w) => [w.id, w.latest.map((l) => l.value)])).toEqual([
      ['wdg_now_heat', [38.46]],
      ['wdg_now_power', [null, 1234.4]],
      ['wdg_now_empty', [null]],
      ['wdg_now_old', [null]],
      ['wdg_now_broken', [3]],
    ]);
    expect(logged.queries).toHaveLength(1);
    expect(logged.queries[0]).toMatch(/from "widgets" left join lateral \(select .* from "widget_points"/);
    expect(logged.queries[0]).toMatch(/limit \$\d+\) "newest_point"/);
    // Home's list reads every widget's points in one more statement, oldest first, the day's only.
    logged.queries.length = 0;
    const again = await listWidgets(logged.services.db, mara, now);
    expect(again).toEqual(full);
    expect(logged.queries).toHaveLength(2);
    expect(full.map((w) => [w.id, w.points.map((p) => [p.t, p.values])])).toEqual([
      [
        'wdg_now_heat',
        [
          [hours(2).toISOString(), { flow: 30 }],
          [hours(1).toISOString(), { flow: 38.46 }],
        ],
      ],
      [
        'wdg_now_power',
        [
          [hours(3).toISOString(), { solar: 5, grid: 6 }],
          [hours(0.5).toISOString(), { solar: null, grid: 1234.4 }],
        ],
      ],
      ['wdg_now_empty', []],
      ['wdg_now_old', []],
      ['wdg_now_broken', [[hours(1).toISOString(), { v: 3 }]]],
    ]);
  });

  it('draws at most a day’s 2,880 points of a widget, the oldest, as it always did', async () => {
    await pin();
    // 2,900 points in the last day: the first 2,880 are drawn, and the value now is the last of those.
    await t.services.sql`insert into widget_points (widget_id, t, values)
      select 'wdg_now_empty', ${hours(23).toISOString()}::timestamptz + make_interval(secs => g * 20), jsonb_build_object('v', g)
      from generate_series(0, 2899) g`;
    const mara = (await viewer(IDS.mara)).principal;
    const [, , busy] = await listWidgets(t.services.db, mara, now);
    expect(busy?.points).toHaveLength(2880);
    expect(busy?.points.at(-1)?.values).toEqual({ v: 2879 });
    expect(busy?.latest).toEqual([{ key: 'v', value: 2879 }]);
  });

  it('gives the glance the same tiles and figures, reading no widget points one by one', async () => {
    await pin();
    const logged = loggedServices();
    const glance = await buildFullGlance(logged.services, await deskPlace(), new QuestionNumbers(), now);
    expect(glance.tiles).toEqual([
      { icon: 'heat', value: '38.5 °C', label: 'Heat pump · Flow' },
      { icon: 'power', value: '1234 kW', label: 'Power' },
    ]);
    expect(glance.figures).toEqual([
      { key: 'widget:wdg_now_heat', name: 'Heat pump', value: '38.5 °C', active: false },
      { key: 'widget:wdg_now_power', name: 'Power', value: '1234 kW', active: false },
    ]);
    expect(logged.queries.filter((q) => q.includes('from "widget_points"'))).toHaveLength(1);
  });
});

describe('one read of what Home’s parts share', () => {
  const hub = new FakeHostsService();
  beforeAll(() => hub.start());
  afterAll(() => hub.stop());

  /** Logged services that see the fake's servers (marble, shale …), the hosts service reading through the same log. */
  function withServers() {
    const logged = loggedServices();
    setHostsFor(
      logged.services,
      new HostsService({
        config: { WHOMBAT_HOSTS_SOCKET: hub.socket, WHOMBAT_HOSTS_TOKEN_FILE: hub.tokenFile },
        db: logged.services.db,
        log: () => t.services.log,
        clock: () => now,
      }),
    );
    return logged;
  }

  const count = (queries: string[]) => {
    const n = (match: (q: string) => boolean) => queries.filter(match).length;
    return {
      quiets: n((q) => q.includes('from "notice_quiets"')),
      offs: n((q) => q.includes('from "watch_offs"')),
      ons: n((q) => q.includes('from "watch_ons"')),
      asks: n((q) => q.includes('from "server_asks"')),
      agent: n((q) => AGENT_ROW.test(q)),
      person: n(
        (q) =>
          /^select "kind" from "principals"/.test(q) ||
          /from "principals" where "principals"."id" = \$1$/.test(q),
      ),
      chats: n((q) =>
        /from "conversations" where \("conversations"."burrow_id" = \$1 and "conversations"."kind" = \$2/.test(
          q,
        ),
      ),
      connections: n((q) => q.includes('from "catalog_connections"')),
      researches: n((q) => q.includes('from "look_researches"')),
      skills: n((q) => q.includes('from "device_skills"')),
    };
  };
  const once = {
    quiets: 1,
    offs: 1,
    ons: 1,
    asks: 1,
    agent: 1,
    person: 0,
    chats: 1,
    connections: 1,
    researches: 1,
    skills: 1,
  };

  it('reads each shared part once per overview and per glance, and nothing more for the next', async () => {
    // A device waiting for the person's choice: Needs you, Your things and Watch all read the device skills.
    await t.services.db.insert(deviceSkills).values({
      id: 'dsk_home_reads',
      burrowId: t.burrowId,
      personId: IDS.mara,
      name: 'Heat pump',
      profile: { name: 'Heat pump' } as never,
      profileHash: 'home-reads',
      host: '192.168.1.40',
      port: 502,
      tested: [],
      testedAt: now,
      status: 'proposed',
      createdAt: now,
      updatedAt: now,
    });
    try {
      const who = await viewer(IDS.mara);
      const overview = withServers();
      const home = await homeOverview(overview.services, who);
      expect(home.things.filter((x) => x.kind === 'server').length).toBeGreaterThan(0);
      expect(home.needsYou.some((i) => i.kind === 'device_skill')).toBe(true);
      expect(count(overview.queries)).toEqual(once);

      const glance = withServers();
      const full = await buildFullGlance(glance.services, await deskPlace(), new QuestionNumbers(), now);
      expect(full.servers.length).toBeGreaterThan(0);
      // The place has the agent's row: the glance reads it no more.
      expect(count(glance.queries)).toEqual({ ...once, agent: 0 });
      expect(new Set(full.servers.map((s) => `server:${s.id}`))).toEqual(
        new Set(home.things.filter((x) => x.kind === 'server').map((x) => x.id)),
      );

      // Every read is its own: a second overview reads them all again.
      overview.queries.length = 0;
      expect(await homeOverview(overview.services, who)).toEqual(home);
      expect(count(overview.queries)).toEqual(once);
    } finally {
      await t.services.db.delete(deviceSkills).where(eq(deviceSkills.id, 'dsk_home_reads'));
    }
  });

  it('gives the same answers alone as within one shared read', async () => {
    const who = await viewer(IDS.mara);
    const together = await homeOverview(withServers().services, who);
    const alone = withServers().services;
    expect((await needsYou(alone, who)).filter((i) => NEEDS_YOU_FIRST_KINDS.includes(i.kind))).toEqual(
      together.needsYou,
    );
    expect(await things(alone, who)).toEqual(together.things);
    const glance = await buildFullGlance(
      withServers().services,
      await deskPlace(),
      new QuestionNumbers(),
      now,
    );
    expect(glance.servers).toEqual((await deskFleet(alone, t.burrowId))?.cards);
  });
});
