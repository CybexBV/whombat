/**
 * The kinds drawn from Whombat's own records: a report tracker's page from its mirrored reports and fixes, and a
 * generic AI gateway's from the turns Whombat sent through it and the gateway's model list.
 */
import { describe, expect, it } from 'vitest';
import { KIND_MODULES } from '../index';
import { slotProblems } from '../slots';
import { AI_GATEWAY_KIND, type GatewaySnapshot, gatewaySeen, gatewayView, modelIds } from './gateway';
import { TRACKER_KIND, type TrackerSnapshot, trackerSeen, trackerView } from './tracker';

const NOW = new Date('2026-11-23T15:00:00Z');
const TZ = 'Europe/Amsterdam';
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const listItems = (view: ReturnType<typeof trackerView>, id: string) => {
  const p = view.panels.find((x) => x.id === id);
  return p?.kind === 'list' ? p.items : [];
};

describe('a report tracker’s page', () => {
  const snapshot: TrackerSnapshot = {
    listened: true,
    reports: [
      {
        number: 31,
        kind: 'bug',
        title: 'Login loops',
        organization: 'Arnica',
        status: 'new',
        reportedAt: ago(DAY),
      },
      {
        number: 30,
        kind: 'feature',
        title: 'Dark mode',
        organization: 'Hollow',
        status: 'triaged',
        reportedAt: ago(2 * DAY),
      },
      {
        number: 29,
        kind: 'bug',
        title: 'Slow list',
        organization: 'Arnica',
        status: 'closed',
        reportedAt: ago(3 * DAY),
      },
      {
        number: 20,
        kind: 'bug',
        title: 'Old one',
        organization: 'Arnica',
        status: 'new',
        reportedAt: ago(40 * DAY),
      },
    ],
    fixes: [
      {
        number: 31,
        title: 'Login loops',
        state: 'open',
        prUrl: 'https://example.com/pr/7',
        since: ago(3_600_000),
      },
      { number: 29, title: null, state: 'development', prUrl: null, since: ago(DAY) },
    ],
    fixedMonth: 2,
    poller: {
      checkedAt: ago(120_000),
      version: 'Acme Desk 0.1.174',
      environment: 'production',
      problem: null,
    },
  };

  it('is registered and lays its slots out right', () => {
    expect(KIND_MODULES.tracker).toBe(TRACKER_KIND);
    expect(slotProblems(trackerView(snapshot, NOW, TZ))).toEqual([]);
  });

  it('shows the fixes on their way, the open reports, the week and who reports most', () => {
    const view = trackerView(snapshot, NOW, TZ);
    expect(view.panels.map((p) => p.id)).toEqual(['fixes', 'reports', 'week', 'people']);
    expect(listItems(view, 'fixes').map((i) => [i.title, i.detail, i.url])).toEqual([
      ['#31 Login loops', 'Pull request open', 'https://example.com/pr/7'],
      ['Report #29', 'On development', undefined],
    ]);
    expect(listItems(view, 'reports').map((i) => [i.id, i.figure?.value])).toEqual([
      ['open', '3'],
      ['bugs', '2'],
      ['features', '1'],
      ['fixed', '2'],
    ]);
    const week = view.panels.find((p) => p.id === 'week');
    expect(week?.kind === 'chart' && week.figure?.value).toBe('3');
    const who = view.panels.find((p) => p.id === 'people');
    expect(who?.kind === 'bars' && who.items.map((i) => i.label)).toEqual(['Arnica', 'Hollow']);
    expect(view.slots?.machine.map((m) => m.value)).toEqual(['Production · Acme Desk 0.1.174', '2 min ago']);
    expect(trackerSeen(snapshot, NOW).glance.facts).toEqual([
      { label: 'Open', value: '3' },
      { label: 'This week', value: '3' },
    ]);
  });

  it('says it isn’t read while no automation listens, instead of noughts', () => {
    const quiet = { ...snapshot, listened: false, reports: [], fixes: [], fixedMonth: 0 };
    const view = trackerView(quiet, NOW, TZ);
    expect(view.panels).toEqual([]);
    expect(view.verdict).toContain('automation');
    expect(trackerSeen(quiet, NOW).glance.facts).toEqual([]);
  });
});

describe('an AI gateway’s page', () => {
  const snapshot: GatewaySnapshot = {
    switches: { claude: true, codex: false },
    turns: [
      { provider: 'claude', failed: false, at: ago(3_600_000) },
      { provider: 'claude', failed: true, at: ago(2 * 3_600_000) },
      { provider: 'codex', failed: false, at: ago(3 * DAY) },
      { provider: 'claude', failed: false, at: ago(9 * DAY) },
    ],
    running: 1,
    models: ['claude-sonnet', 'gpt-5', 'claude-opus', 'local'],
  };

  it('is registered and lays its slots out right', () => {
    expect(KIND_MODULES.ai_gateway).toBe(AI_GATEWAY_KIND);
    expect(slotProblems(gatewayView(snapshot, NOW, TZ))).toEqual([]);
  });

  it('says what goes through it, today’s turns, its models and the week', () => {
    const view = gatewayView(snapshot, NOW, TZ);
    const through = view.panels.find((p) => p.id === 'through');
    expect(
      through?.kind === 'list' && through.items.map((i) => [i.id, i.figure?.value, i.figure?.note]),
    ).toEqual([
      ['claude', 'On', 'Switched on'],
      ['codex', 'Off', undefined],
      ['turns', '2', '1 failed'],
      ['models', '4', undefined],
    ]);
    const week = view.panels.find((p) => p.id === 'week');
    expect(week?.kind === 'chart' && week.figure?.value).toBe('3');
    expect(gatewaySeen(snapshot, NOW).glance.facts).toEqual([{ label: 'Turns today', value: '2' }]);
  });

  it('leaves the models out when the gateway’s list couldn’t be read, and reads an OpenAI-style list', () => {
    const view = gatewayView({ ...snapshot, models: null }, NOW, TZ);
    const through = view.panels.find((p) => p.id === 'through');
    expect(through?.kind === 'list' && through.items.map((i) => i.id)).not.toContain('models');
    expect(modelIds({ data: [{ id: 'a' }, { id: '' }, {}, { id: 'b' }] })).toEqual(['a', 'b']);
    expect(modelIds({ error: 'no' })).toBeNull();
  });
});
