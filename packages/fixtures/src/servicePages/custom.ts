/**
 * A Custom connection with a logo and a page of its own (Whombat docs/decisions/connection-looks.md): Uptime Kuma set up
 * by hand as an API, its logo from an icon set and its page from the assistant's recipe, laid out as the server builds
 * a recipe's page — Live, Inventory and Trend in slots, a list below, a fact in the head and a warning in Worth a look.
 */
import type { ThingLogo, ThingPage, ThingPageItem } from '@whombat/core/domain';
import type { FixtureServicePage } from './types.js';

const DAY = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const KUMA = 'connection:con_kuma';

/** Uptime Kuma's mark (Simple Icons, CC0) in its green, as the server keeps a logo. */
export const KUMA_LOGO: ThingLogo = {
  viewBox: '0 0 24 24',
  shapes: [
    {
      fill: '#5cdd8b',
      d: 'M11.759.955c-4.071 0-7.93 2.265-10.06 5.774l-.16.263-.116.284c-1.81 4.44-2.188 9.118.621 12.459 2.67 3.174 6.221 3.328 9.477 3.308 3.256-.02 6.323-.482 8.995-2.032C22.75 19.714 24 16.917 24 14.53c0-2.388-.724-4.698-1.882-7.343l-.112-.257-.148-.238C19.683 3.2 15.83.955 11.758.955Zm0 3.868c2.919 0 5.19 1.305 6.816 3.914 2.076 4.747 2.076 7.724 0 8.929-3.116 1.808-11.234 2.359-13.57-.42-1.558-1.853-1.558-4.69 0-8.51 1.584-2.608 3.835-3.913 6.754-3.913z',
    },
  ],
};

const count = (
  id: string,
  title: string,
  value: string,
  note?: string,
  tone?: 'bad' | 'ok',
): ThingPageItem => ({
  id,
  title,
  right: value,
  figure: { value, ...(note ? { note } : {}), ...(tone ? { tone } : {}) },
  ...(tone === 'bad' ? { tone } : {}),
});

const kuma: FixtureServicePage = {
  thing: KUMA,
  catalogId: 'custom_api',
  name: 'Uptime Kuma',
  fields: { url: 'https://status.example.net/api' },
  make: (ctx) => ({
    page: (): ThingPage => {
      const at = Array.from({ length: 7 }, (_, i) => new Date(ctx.now() - (6 - i) * DAY));
      return {
        id: KUMA,
        kind: 'connection',
        connectionId: 'con_kuma' as ThingPage['connectionId'],
        catalogId: 'custom_api',
        name: 'Uptime Kuma',
        icon: 'custom_api',
        logo: KUMA_LOGO,
        status: 'bad',
        badge: 'Backups site is down',
        facts: [[{ text: 'Version ' }, { text: '2.0.2', strong: true }]],
        address: 'status.example.net',
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
                kind: 'notices',
                id: 'worth',
                place: 'top',
                title: 'Worth a look',
                items: [
                  {
                    id: 'page-down',
                    tone: 'bad',
                    icon: 'warn',
                    title: 'Backups site is down',
                    detail: 'Down for 12 min.',
                    link: {
                      kind: 'ask',
                      label: 'Look into it',
                      question: 'Backups site is down. What can I do?',
                    },
                    nature: 'problem',
                    check: 'page.broken',
                    subject: { id: 'page:down', name: 'Backups site is down' },
                    ...(ctx.lookOnly
                      ? {}
                      : { ignore: { lifts: 'fixed' as const, words: 'Until it’s back to normal.' } }),
                  },
                ],
              },
              {
                kind: 'list',
                id: 'live',
                place: 'chart',
                span: 2,
                title: 'Down or slow now',
                items: [
                  {
                    id: 'live-0',
                    title: 'Backups site',
                    detail: 'https://backup.example.net',
                    right: 'Down',
                    tone: 'bad',
                  },
                  {
                    id: 'live-1',
                    title: 'Shop',
                    detail: 'https://shop.example.net',
                    right: '1,840 ms',
                    tone: 'warn',
                  },
                ],
                empty: 'Everything answers.',
              },
              {
                kind: 'list',
                id: 'counts',
                place: 'chart',
                span: 1,
                look: 'counts',
                title: 'Monitors',
                items: [
                  count('up', 'Up', '23', '+2 on last week', 'ok'),
                  count('down', 'Down', '1', undefined, 'bad'),
                  count('paused', 'Paused', '2', 'No change'),
                ],
              },
              {
                kind: 'chart',
                id: 'trend',
                place: 'chart',
                span: 1,
                title: 'Uptime',
                meta: 'All monitors',
                style: 'bars',
                timestamps: at.map((d) => d.toISOString()),
                labels: at.map((d, i) => (i === 6 ? 'Today' : (WEEKDAYS[d.getDay()] ?? ''))),
                series: [
                  {
                    key: 'values',
                    label: 'Uptime',
                    values: [99.9, 100, 99.7, 100, 99.95, 100, 98.2],
                    color: 'blue',
                    unit: '%',
                  },
                ],
                figure: { value: '98.2 %', rest: 'today' },
                axis: { min: 0 },
              },
              {
                kind: 'list',
                id: 'list',
                place: 'main',
                title: 'Recent events',
                items: [
                  { id: 'list-0', title: 'Backups site went down', right: '12 min ago' },
                  { id: 'list-1', title: 'Shop slowed down', right: '40 min ago' },
                  { id: 'list-2', title: 'Mail came back', right: '3 h ago' },
                ],
              },
            ],
          },
        ],
      };
    },
    row: () => ({
      line: '23 up · 1 down',
      facts: [
        { label: 'Up', value: '23' },
        { label: 'Down', value: '1' },
      ],
      reason: 'Backups site is down',
    }),
    checks: [
      {
        check: 'page.broken',
        name: 'What the service reports as down or broken',
        nature: 'problem',
        perItem: true,
      },
    ],
  }),
};

export const CUSTOM_PAGES: FixtureServicePage[] = [kuma];
