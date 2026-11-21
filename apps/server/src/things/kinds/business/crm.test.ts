/**
 * HubSpot's and Pipedrive's page from documented answers (service-dashboards.md SD-63): what Whombat asks, the stages
 * with their deals, won this month, new contacts or deals, overdue tasks with their deals and Done, and who sees what.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ThingPageButton, ThingPageKpi, ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { rec } from '../../words';
import { slotProblems } from '../slots';
import type { ButtonSpec } from './common';
import {
  CRM_OVERDUE,
  type CrmInput,
  type CrmSnapshot,
  crmFigures,
  crmSeen,
  crmSkipped,
  crmView,
  HUBSPOT_KIND,
  hubspotSearches,
  hubspotSnapshot,
  PIPEDRIVE_KIND,
  pipedriveDue,
  pipedriveSince,
  pipedriveSnapshot,
} from './crm';

const fixture = (service: string, name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', service, name), 'utf8'));
const hs = (name: string) => fixture('hubspot', name);
const pd = (name: string) => fixture('pipedrive', name);

const TZ = 'Europe/Amsterdam';
// Tuesday 21 October 2026, 17:00 in Amsterdam.
const now = new Date('2026-10-21T15:00:00Z');

const hubspot = (): CrmSnapshot =>
  hubspotSnapshot(
    {
      account: hs('account.json'),
      pipelines: hs('pipelines.json'),
      open: {
        results: (rec(hs('deals-open.json')).results as Record<string, unknown>[]) ?? [],
        capped: false,
      },
      won: {
        results: (rec(hs('deals-won.json')).results as Record<string, unknown>[]) ?? [],
        total: Number(rec(hs('deals-won.json')).total),
      },
      contacts: hs('contacts.json'),
      tasks: hs('tasks.json'),
      associations: hs('associations.json'),
      deals: hs('deals-batch.json'),
    },
    now,
  );

const data = (name: string) => ({ data: (rec(pd(name)).data as Record<string, unknown>[]) ?? [] });
const pipedrive = (): CrmSnapshot =>
  pipedriveSnapshot(
    {
      me: pd('me.json'),
      stages: pd('stages.json'),
      pipelines: pd('pipelines.json'),
      open: { ...data('deals-open.json'), capped: false },
      recent: data('deals-recent.json'),
      activities: data('activities.json'),
    },
    now,
    TZ,
  );

const allowAll = (spec: ButtonSpec): ThingPageButton => ({ ...spec, allowed: true });
const input = (snapshot: CrmSnapshot, over: Partial<CrmInput> = {}): CrmInput => ({
  snapshot,
  now,
  timeZone: TZ,
  button: allowAll,
  ...over,
});

describe('HubSpot (SD-63)', () => {
  it('asks for open deals, this month’s won ones, a week’s contacts and overdue tasks', () => {
    const q = hubspotSearches(now, TZ);
    expect(q.open.filterGroups[0]?.filters).toEqual([
      { propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' },
    ]);
    // The month starts at midnight on 1 October in Amsterdam.
    expect(q.won.filterGroups[0]?.filters[1]?.value).toBe(String(Date.parse('2026-09-30T22:00:00Z')));
    expect(q.tasks.filterGroups[0]?.filters.map((f) => [f.propertyName, f.operator])).toEqual([
      ['hs_task_status', 'NEQ'],
      ['hs_timestamp', 'LT'],
    ]);
    // The newest 200 contacts of 14 days, for the week per day and the week before.
    expect(q.contacts).toMatchObject({
      limit: 200,
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
    });
    expect(q.contacts.filterGroups[0]?.filters[0]?.value).toBe(String(now.getTime() - 14 * 86_400_000));
    expect(q.won.properties).toContain('closedate');
  });

  it('puts open deals into their stages, in the account’s currency', () => {
    const s = hubspot();
    expect(s.currency).toBe('EUR');
    expect(s.stages.map((x) => [x.id, x.count, x.amount])).toEqual([
      ['appointmentscheduled', 2, 2760],
      ['qualifiedtobuy', 0, 0],
      ['contractsent', 1, 12000],
    ]);
    expect(s.open).toEqual({ count: 3, amount: 14760, capped: false });
    expect(s.won).toEqual({ count: 2, amount: 6500 });
    expect(s.newCount).toBe(5);
    expect(s.made).toMatchObject({ whole: true });
    expect(s.made?.at).toHaveLength(9);
    expect(s.week.won).toBe(1);
    expect(s.biggest.map((d) => [d.name, d.amount, d.stage])).toEqual([
      ['Foobar Holding – website', 12000, 'Contract sent'],
      ['Acme – support', 2760, 'Appointment scheduled'],
    ]);
  });

  it('finds each overdue task’s deal, open or not, oldest first', () => {
    const s = hubspot();
    expect(s.overdue?.total).toBe(3);
    expect(s.overdue?.tasks.map((t) => [t.id, t.deal?.name ?? null])).toEqual([
      ['7003', null],
      ['7001', 'Foobar Holding – website'],
      ['7002', 'Initech – rebuild'],
    ]);
    expect(s.overdue?.tasks[0]?.subject).toBe('A task');
    expect(s.links.deal).toBe('https://app-eu1.hubspot.com/contacts/4455667/record/0-3/{id}');
  });

  it('keeps four figures for the card and shows its two', () => {
    const figures = crmFigures(input(hubspot()));
    expect(figures.map((k) => [k.key, k.value])).toEqual([
      ['open', '€ 14,760'],
      ['won', '€ 6,500'],
      ['new', '5'],
      ['overdue', '3'],
    ]);
    expect(figures.find((k) => k.key === 'overdue')?.tone).toBe('warn');
    const today = crmFigures(
      input({
        ...hubspot(),
        overdue: {
          total: 1,
          tasks: [{ id: 't', subject: 'Call', due: new Date(now.getTime() - 3600_000), deal: null }],
          capped: false,
        },
      }),
    );
    expect(today.find((k) => k.key === 'overdue')?.sub).toBe('Due earlier today');
    for (const k of figures) expect(ThingPageKpi.safeParse(k).success).toBe(true);
    expect(crmSeen(input(hubspot())).glance.facts?.map((f) => f.label)).toEqual([
      'Open deals',
      'Overdue tasks',
    ]);
  });

  it('follows the slots: Overdue, Deals, the week’s new contacts, then the pipeline and the biggest deals', () => {
    const view = crmView(input(hubspot()));
    expect(slotProblems(view)).toEqual([]);
    expect(view.kpis).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['overdue', 'deals', 'week', 'pipeline', 'biggest']);
    for (const p of view.panels) expect(ThingPagePanel.safeParse(p).success).toBe(true);
  });

  it('lists what is overdue in Live, oldest first, with its deal and Done', () => {
    const live = crmView(input(hubspot())).panels.find((p) => p.id === 'overdue');
    if (live?.kind !== 'list') throw new Error('no live list');
    expect(live.meta).toBe('3 overdue · 2 over a week');
    expect(live.items.map((i) => [i.id, i.tone, i.actions?.[0]?.target])).toEqual([
      ['7003', 'warn', '7003'],
      ['7001', 'warn', '7001'],
      ['7002', undefined, '7002'],
    ]);
    expect(live.items[1]?.detail).toContain('About Foobar Holding – website · due ');
    expect(live.items[1]?.url).toBe('https://app-eu1.hubspot.com/contacts/4455667/record/0-3/9001');
  });

  it('counts deals in Inventory with what changed this week', () => {
    const deals = crmView(input(hubspot())).panels.find((p) => p.id === 'deals');
    if (deals?.kind !== 'list') throw new Error('no inventory');
    expect(deals.items.map((i) => [i.title, i.figure?.value, i.figure?.note])).toEqual([
      ['Open deals', '€ 14,760', '+1 this week'],
      ['Won this month', '€ 6,500', '+1 this week'],
      ['New contacts', '5', undefined],
    ]);
  });

  it('draws new contacts per day this week with the change on the week before', () => {
    const week = crmView(input(hubspot())).panels.find((p) => p.id === 'week');
    if (week?.kind !== 'chart') throw new Error('no trend');
    expect(week.series[0]?.values).toEqual([0, 1, 0, 1, 0, 2, 1]);
    expect(week.figure).toEqual({ value: '5', rest: 'new contacts this week' });
    expect(week.stats?.[0]?.[0]?.text).toBe('+25 %');
  });

  it('leaves the days before HubSpot’s newest 200 without a bar, and says “at least”', () => {
    const s = hubspot();
    const at = Array.from({ length: 200 }, (_, i) => new Date(now.getTime() - i * 40 * 60_000));
    const busy = { ...s, made: { at, whole: false }, newCount: 200 };
    const week = crmView(input(busy)).panels.find((p) => p.id === 'week');
    if (week?.kind !== 'chart') throw new Error('no trend');
    // The newest 200 reach back five and a half days: the two days before have no bar.
    expect(week.series[0]?.values.slice(0, 3)).toEqual([null, null, 36]);
    expect(week.stats).toBeUndefined();
    const deals = crmView(input(busy)).panels.find((p) => p.id === 'deals');
    expect(deals?.kind === 'list' && deals.items.at(-1)?.figure?.value).toBe('200+');
  });

  it('gives each task over a week overdue its own heads-up, which never colours the dot', () => {
    const view = crmView(input(hubspot()));
    expect(view.notices.map((n) => [n.id, n.tone, n.nature, n.check, n.subject?.id])).toEqual([
      ['overdue-7003', 'warn', 'fyi', CRM_OVERDUE, 'task:7003'],
      ['overdue-7001', 'warn', 'fyi', CRM_OVERDUE, 'task:7001'],
    ]);
    for (const n of view.notices) {
      expect(n.ignore?.lifts).toBe('fixed');
      expect(n.link?.kind).toBe('url');
      expect(n.episode).toBeUndefined();
      expect(ThingPageNotice.safeParse(n).success).toBe(true);
    }
    expect(view.status).toEqual({ status: 'ok', badge: '3 overdue' });
  });

  it('names a task’s deal on its line', () => {
    expect(crmView(input(hubspot())).notices[1]?.detail).toContain('Foobar');
  });

  it('puts the third task on and after into one line that lifts when the rest changes', () => {
    const old = new Date(now.getTime() - 20 * 86_400_000);
    const tasks = Array.from({ length: 11 }, (_, i) => ({
      id: `t${i}`,
      subject: `Task ${i}`,
      due: new Date(old.getTime() + i * 60_000),
      deal: null,
    }));
    const view = crmView(input({ ...hubspot(), overdue: { total: 11, tasks, capped: false } }));
    expect(view.notices).toHaveLength(3);
    const more = view.notices[2];
    expect(more).toMatchObject({ check: CRM_OVERDUE, subject: { id: '+more' }, ignore: { lifts: 'newer' } });
    expect(more?.title).toMatch(/^9 more tasks/);
    const fewer = crmView(
      input({ ...hubspot(), overdue: { total: 10, tasks: tasks.slice(0, 10), capped: false } }),
    );
    expect(fewer.notices[2]?.episode).not.toBe(more?.episode);
  });

  it('watches overdue tasks, and skips them when more are overdue than were read', () => {
    expect(HUBSPOT_KIND.checks?.map((c) => c.check)).toEqual([CRM_OVERDUE]);
    expect(PIPEDRIVE_KIND.checks?.[0]?.name).toMatch(/^Activities/);
    expect(crmSkipped(hubspot())).toEqual([]);
    expect(crmSkipped({ ...hubspot(), overdue: null })).toEqual([CRM_OVERDUE]);
    const capped = hubspotSnapshot(
      {
        account: null,
        pipelines: hs('pipelines.json'),
        open: { results: [], capped: false },
        won: null,
        contacts: null,
        tasks: { ...rec(hs('tasks.json')), total: 40 },
        associations: null,
        deals: null,
      },
      now,
    );
    expect(crmSkipped(capped)).toEqual([CRM_OVERDUE]);
  });

  it('draws the pipeline as bars against the biggest stage', () => {
    const pipeline = crmView(input(hubspot())).panels.find((p) => p.id === 'pipeline');
    if (pipeline?.kind !== 'bars') throw new Error('no bars');
    expect(pipeline.place).toBe('main');
    expect(pipeline.items.map((b) => [b.label, b.value, b.pct])).toEqual([
      ['Appointment scheduled', '2 · € 2,760', 0.23],
      ['Qualified to buy', '0 · € 0', 0],
      ['Contract sent', '1 · € 12,000', 1],
    ]);
    // One pipeline: no pipeline names on the stages.
    expect(pipeline.items.every((b) => b.note === undefined)).toBe(true);
  });
});

describe('Pipedrive (SD-63)', () => {
  it('reads changed deals from the month’s start or 14 days, the earlier', () => {
    expect(pipedriveSince(now, TZ).toISOString()).toBe('2026-09-30T22:00:00.000Z');
    expect(pipedriveSince(new Date('2026-10-03T12:00:00Z'), TZ).toISOString()).toBe(
      '2026-09-19T12:00:00.000Z',
    );
  });

  it('puts open deals into stages of both pipelines, adding up the main currency', () => {
    const s = pipedrive();
    expect(s.currency).toBe('EUR');
    expect(s.pipelines).toBe(2);
    expect(s.stages.map((x) => [x.label, x.pipeline, x.count, x.amount])).toEqual([
      ['Lead in', 'Sales', 1, 0],
      ['Proposal made', 'Sales', 1, 12000],
      ['Signed up', 'Partners', 1, 800],
    ]);
    expect(s.open).toEqual({ count: 3, amount: 12800, capped: false });
  });

  it('counts this month’s won deals and the deals added in 7 days', () => {
    const s = pipedrive();
    expect(s.won).toEqual({ count: 1, amount: 5000 });
    expect(s.newCount).toBe(3);
    expect(s.week).toEqual({ opened: 2, won: 0 });
    expect(s.made).toMatchObject({ whole: true });
    expect(s.made?.at).toHaveLength(3);
  });

  it('picks the activities due before now', () => {
    const s = pipedrive();
    expect(s.overdue?.tasks.map((t) => [t.id, t.subject, t.deal?.name ?? null])).toEqual([
      ['601', 'Send the proposal', 'Foobar Holding – website'],
      ['602', 'Call back', null],
    ]);
    expect(pipedriveDue({ due_date: '2026-10-21', due_time: '09:30' }, TZ)?.toISOString()).toBe(
      '2026-10-21T09:30:00.000Z',
    );
    expect(pipedriveDue({ due_date: '2026-10-21' }, TZ)?.toISOString()).toBe('2026-10-21T21:59:59.999Z');
    expect(pipedriveDue({ due_date: 'soon' }, TZ)).toBeNull();
  });

  it('names its figures and stages as Pipedrive does', () => {
    const view = crmView(input(pipedrive()));
    expect(slotProblems(view)).toEqual([]);
    expect(crmFigures(input(pipedrive())).map((k) => [k.label, k.value])).toEqual([
      ['Open deals', '€ 12,800'],
      ['Won this month', '€ 5,000'],
      ['New deals', '3'],
      ['Overdue activities', '2'],
    ]);
    const week = view.panels.find((p) => p.id === 'week');
    expect(week?.kind === 'chart' && week.figure).toEqual({ value: '3', rest: 'new deals this week' });
    const biggest = view.panels.find((p) => p.id === 'biggest');
    if (biggest?.kind !== 'list') throw new Error('no biggest');
    // The dollar deal isn't added up with the euros.
    expect(biggest.items.map((i) => [i.title, i.right, i.detail])).toEqual([
      ['Foobar Holding – website', '€ 12,000', 'Proposal made · Sales'],
      ['Jansen – partner', '€ 800', 'Signed up · Partners'],
    ]);
    const pipeline = view.panels.find((p) => p.id === 'pipeline');
    if (pipeline?.kind !== 'bars') throw new Error('no bars');
    expect(pipeline.items.map((b) => b.note)).toEqual(['Sales', 'Sales', 'Partners']);
    expect(view.notices.map((n) => n.subject?.id)).toEqual(['task:601']);
    expect(view.open?.url).toBe('https://example.pipedrive.com/');
  });
});

describe('Overdue and Done (SD-63, SD-04)', () => {
  it('gives each overdue task a Done button aimed at it', () => {
    const live = crmView(input(pipedrive())).panels.find((p) => p.id === 'overdue');
    if (live?.kind !== 'list') throw new Error('no live list');
    expect(live.items.map((i) => [i.actions?.[0]?.action, i.actions?.[0]?.target])).toEqual([
      ['done', '601'],
      ['done', '602'],
    ]);
    expect(live.items[0]?.url).toBe('https://example.pipedrive.com/deal/301');
    expect(ThingPagePanel.safeParse(live).success).toBe(true);
  });

  it('draws no buttons on the card', () => {
    const card = crmView(input(hubspot(), { button: undefined }));
    expect(JSON.stringify(card)).not.toContain('"action"');
  });
});
