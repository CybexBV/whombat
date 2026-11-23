/**
 * Pages Whombat draws from its own records (the server's `things/kinds/own/`): a report tracker, from the reports and
 * fixes it mirrors, and a generic AI gateway (LiteLLM), from the turns Whombat sent through it and the gateway's model
 * list. Laid out as the server builds them: Live, Inventory, Trend and People in slots.
 */
import type { ThingPage, ThingPageItem } from '@whombat/core/domain';
import type { FixtureServiceCtx, FixtureServicePage } from './types.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const REPORTS = 'connection:con_reports';
const LITELLM = 'connection:con_litellm';

const count = (
  id: string,
  title: string,
  value: string,
  more: Partial<ThingPageItem> = {},
): ThingPageItem => ({
  id,
  title,
  right: value,
  ...more,
  figure: { value, ...(more.figure ?? {}) },
});

/** The last seven days, today last, as a Trend's timestamps and words. */
function week(ctx: FixtureServiceCtx) {
  const at = Array.from({ length: 7 }, (_, i) => new Date(ctx.now() - (6 - i) * DAY));
  return {
    timestamps: at.map((d) => d.toISOString()),
    labels: at.map((d, i) => (i === 6 ? 'Today' : (WEEKDAYS[d.getDay()] ?? ''))),
  };
}

const reports: FixtureServicePage = {
  thing: REPORTS,
  catalogId: 'tracker',
  name: 'Acme Desk reports',
  fields: { url: 'https://desk.example.com', driver: 'acme-desk' },
  make: (ctx) => ({
    page: (): ThingPage => ({
      id: REPORTS,
      kind: 'connection',
      connectionId: 'con_reports' as ThingPage['connectionId'],
      catalogId: 'tracker',
      name: 'Acme Desk reports',
      icon: 'tracker',
      status: 'ok',
      badge: 'Fine',
      verdict: '6 reports open, 4 new ones this week.',
      facts: [],
      address: 'desk.example.com',
      runsOn: null,
      settings: true,
      actions: [],
      readAt: ctx.ago(20_000),
      tabs: [
        {
          key: 'overview',
          label: 'Summary',
          panels: [
            {
              kind: 'list',
              id: 'fixes',
              place: 'chart',
              span: 2,
              title: 'Fixes on their way',
              meta: '3 fixes',
              items: [
                {
                  id: 'fix-31',
                  title: '#31 Sign-in loops after a password change',
                  detail: 'Pull request open',
                  icon: 'clock',
                  right: '1 h ago',
                  url: 'https://example.com/acme/desk/pull/412',
                },
                {
                  id: 'fix-28',
                  title: '#28 Invoice PDF shows the wrong VAT line',
                  detail: 'Merged, not out yet',
                  icon: 'update',
                  right: '5 h ago',
                  url: 'https://example.com/acme/desk/pull/409',
                },
                {
                  id: 'fix-25',
                  title: '#25 Export stops at 1,000 rows',
                  detail: 'On development',
                  icon: 'update',
                  right: '1 day ago',
                  url: 'https://example.com/acme/desk/pull/401',
                },
              ],
            },
            {
              kind: 'list',
              id: 'reports',
              place: 'chart',
              span: 1,
              look: 'counts',
              title: 'Reports',
              items: [
                count('open', 'Open reports', '6', {
                  icon: 'warn',
                  figure: { value: '6', note: '+4 this week' },
                }),
                count('bugs', 'Bugs', '4', { icon: 'log', detail: 'Open' }),
                count('features', 'Feature requests', '2', { icon: 'info', detail: 'Open' }),
                count('fixed', 'Fixed', '5', { icon: 'update', detail: 'Out to customers, last 30 days' }),
              ],
            },
            {
              kind: 'chart',
              id: 'week',
              place: 'chart',
              span: 1,
              title: 'Reports',
              meta: 'Per day',
              style: 'bars',
              ...week(ctx),
              series: [{ key: 'values', label: 'Reports', values: [1, 0, 2, 0, 1, 2, 1], color: 'blue' }],
              figure: { value: '4', rest: 'this week' },
              stats: [[{ text: '−20 %', strong: true }, { text: ' on last week' }]],
              axis: { min: 0 },
            },
            {
              kind: 'bars',
              id: 'people',
              place: 'chart',
              span: 1,
              title: 'Who reports most',
              meta: 'Last 30 days',
              items: [
                { id: 'person-0', label: 'Arnica Labs', person: true, value: '7 reports', pct: 1 },
                { id: 'person-1', label: 'HollowMere College', person: true, value: '4 reports', pct: 4 / 7 },
                { id: 'person-2', label: 'Example Bakery', person: true, value: '1 report', pct: 1 / 7 },
              ],
            },
            {
              kind: 'bars',
              id: 'machine',
              place: 'chart',
              span: 1,
              title: 'Acme Desk reports itself',
              items: [
                { id: 'version', label: 'Reads', value: 'Production · Acme Desk 0.1.174' },
                { id: 'checked', label: 'Checked', value: '2 min ago' },
              ],
            },
          ],
        },
      ],
    }),
    row: () => ({
      line: '6 reports open · 4 new this week',
      facts: [
        { label: 'Open', value: '6' },
        { label: 'This week', value: '4' },
      ],
    }),
  }),
};

const litellm: FixtureServicePage = {
  thing: LITELLM,
  catalogId: 'ai_gateway',
  name: 'LiteLLM',
  fields: { url: 'https://llm.example.com' },
  make: (ctx) => ({
    page: (): ThingPage => ({
      id: LITELLM,
      kind: 'connection',
      connectionId: 'con_litellm' as ThingPage['connectionId'],
      catalogId: 'ai_gateway',
      name: 'LiteLLM',
      icon: 'ai_gateway',
      status: 'ok',
      badge: 'Fine',
      verdict: '86 turns went through it this week.',
      facts: [],
      address: 'llm.example.com',
      runsOn: null,
      settings: true,
      actions: [],
      readAt: ctx.ago(HOUR / 60),
      tabs: [
        {
          key: 'overview',
          label: 'Summary',
          panels: [
            {
              kind: 'list',
              id: 'through',
              place: 'chart',
              span: 1,
              look: 'counts',
              title: 'Through the gateway',
              items: [
                count('claude', 'Claude Code', 'On', {
                  icon: 'network',
                  detail: 'Goes through it',
                  figure: { value: 'On', note: 'Switched on', tone: 'ok' },
                }),
                count('codex', 'ChatGPT', 'Off', { icon: 'network', detail: 'Goes through it' }),
                count('turns', 'Turns today', '14', {
                  icon: 'clock',
                  detail: '1 going now',
                  figure: { value: '14', note: '1 failed', tone: 'warn' },
                }),
                count('models', 'Models', '6', {
                  icon: 'database',
                  detail: 'claude-sonnet-4-5, claude-opus-4-1, gpt-5',
                }),
              ],
            },
            {
              kind: 'chart',
              id: 'week',
              place: 'chart',
              span: 2,
              title: 'Turns',
              meta: 'Per day',
              style: 'bars',
              ...week(ctx),
              series: [{ key: 'values', label: 'Turns', values: [9, 12, 15, 11, 6, 19, 14], color: 'blue' }],
              figure: { value: '86', rest: 'this week' },
              stats: [[{ text: '+12 %', strong: true }, { text: ' on last week' }]],
              axis: { min: 0 },
            },
          ],
        },
      ],
    }),
    row: () => ({
      line: '14 turns today',
      facts: [{ label: 'Turns today', value: '14' }],
    }),
  }),
};

export const OWN_PAGES: FixtureServicePage[] = [reports, litellm];
