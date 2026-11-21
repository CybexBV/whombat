import type { ThingPage, ThingPageItem } from '@whombat/core/domain';
import { fixtureImage } from '../pictures.js';
import type { FixtureServicePage } from './types.js';

const GAMES = [
  'Astro’s Playroom',
  'Sackboy: A Big Adventure',
  'Ratchet & Clank: Rift Apart',
  'Returnal',
  'Gran Turismo 7',
  'Tetris Effect: Connected',
  'Humanity',
];

const counts: ThingPageItem[] = [
  { id: 'games', title: 'Games', right: '7', figure: { value: '7', note: 'In ShadowMountPlus' } },
  { id: 'payloads', title: 'Homebrew payloads', right: '4', figure: { value: '4' } },
  { id: 'updates', title: 'Homebrew updates', right: '2', figure: { value: '2' } },
  { id: 'startup', title: 'Homebrew startup', right: 'On', figure: { value: 'On' } },
];

export const PS5_PAGES: FixtureServicePage[] = [
  {
    thing: 'connection:con_ps5',
    catalogId: 'ps5',
    name: 'PlayStation 5',
    fields: { url: 'http://192.168.1.20:8084', shadowmountPort: '10101' },
    make: (ctx) => ({
      row: () => ({
        line: 'Homebrew is ready',
        facts: [
          { label: 'Games', value: '7' },
          { label: 'Payloads', value: '4' },
        ],
      }),
      checks: [
        { check: 'ps5.available', name: 'Whether homebrew is ready', nature: 'fyi', perItem: false },
        { check: 'ps5.updates', name: 'Homebrew updates', nature: 'fyi', perItem: false },
        { check: 'ps5.startup', name: 'Homebrew that didn’t start', nature: 'problem', perItem: false },
      ],
      page: (): ThingPage => ({
        id: 'connection:con_ps5',
        kind: 'connection',
        connectionId: 'con_ps5' as ThingPage['connectionId'],
        catalogId: 'ps5',
        name: 'PlayStation 5',
        icon: 'ps5',
        status: 'ok',
        badge: 'Homebrew is ready',
        facts: [
          [{ text: 'Payload Manager ' }, { text: '0.6.3', strong: true }],
          [{ text: 'Firmware ' }, { text: '10.01', strong: true }],
        ],
        verdict: 'Homebrew is ready. 2 updates are available.',
        address: '192.168.1.20:8084',
        open: { label: 'Open Payload Manager', url: 'http://192.168.1.20:8084' },
        runsOn: null,
        settings: true,
        actions: [],
        readAt: ctx.ago(4_000),
        tabs: [
          {
            key: 'overview',
            label: 'Summary',
            panels: [
              {
                kind: 'list',
                id: 'updates',
                title: 'To update',
                meta: '2 updates',
                place: 'chart',
                span: 2,
                buttons: [
                  {
                    action: 'update-all',
                    value: '4f0c2a9d1e6b7c38',
                    label: 'Update all',
                    icon: 'up',
                    allowed: true,
                    confirm: {
                      title: 'Update 2 homebrew items?',
                      body: 'kstuff-lite v1.11, ftpsrv v0.22.0. Whombat downloads each one and checks it; each takes effect the next time it starts.',
                      button: 'Update all',
                    },
                  },
                ],
                items: [
                  {
                    id: 'update-0',
                    icon: 'update',
                    title: 'kstuff-lite v1.10 → v1.11',
                    detail: 'In startup · Uploaded by hand · Firmware 3.00–10.01',
                    actions: [
                      {
                        action: 'update',
                        target: 'local/kstuff-lite',
                        value: 'v1.11',
                        label: 'Update',
                        icon: 'up',
                        allowed: true,
                        confirm: {
                          title: 'Update kstuff-lite to v1.11?',
                          body: 'Whombat downloads kstuff-lite v1.11 and checks it. It takes effect the next time it starts, and the old copy stays so you can go back.',
                          button: 'Update',
                        },
                      },
                    ],
                  },
                  {
                    id: 'update-1',
                    icon: 'update',
                    title: 'ftpsrv v0.21.1 → v0.22.0',
                    detail: 'Uploaded by hand · Check its notes for firmware support',
                    actions: [
                      {
                        action: 'update',
                        target: 'local/ftpsrv',
                        value: 'v0.22.0',
                        label: 'Update',
                        icon: 'up',
                        allowed: true,
                        confirm: {
                          title: 'Update ftpsrv to v0.22.0?',
                          body: 'Whombat downloads ftpsrv v0.22.0 and checks it. It takes effect the next time it starts, and the old copy stays so you can go back.',
                          button: 'Update',
                        },
                      },
                    ],
                  },
                ],
              },
              {
                kind: 'list',
                id: 'inventory',
                title: 'On your PS5',
                place: 'chart',
                look: 'counts',
                span: 1,
                items: counts,
              },
              {
                kind: 'gallery',
                id: 'library',
                title: 'Your games',
                meta: '7 titles',
                place: 'chart',
                span: 3,
                look: 'shelf',
                shape: 'square',
                items: GAMES.map((name, i) => ({
                  id: `game-${i}`,
                  title: name,
                  sub: '01.000.000 · PS5',
                  image: fixtureImage('square', `ps5-${name}`, name),
                  ...(i === 2 ? { badge: { text: 'Mounted', tone: 'ok' as const } } : {}),
                })),
              },
              {
                kind: 'list',
                id: 'running',
                title: 'Running homebrew',
                place: 'main',
                items: [
                  { id: 'manager', title: 'pldmgr.elf', right: '10.7 MB' },
                  { id: 'loader', title: 'elfldr.elf', right: '22.2 MB' },
                  { id: 'kstuff', title: 'kstuff.elf', right: '6.8 MB' },
                  { id: 'shadow', title: 'shadowmountplus.elf', right: '24.9 MB' },
                ],
              },
              {
                kind: 'text',
                id: 'remote-reboot',
                title: 'Remote reboot',
                place: 'main',
                body: 'Ask Whombat to enable remote reboot. It adds a small helper while Payload Manager is running. You’ll need to open WebKit Autoloader again after restarting.',
              },
              {
                kind: 'bars',
                id: 'storage',
                title: 'Storage',
                place: 'main',
                items: [
                  {
                    id: 'internal',
                    label: 'Internal storage',
                    value: '402 GB free',
                    pct: 0.37,
                    sub: '236 GB of 638 GB used',
                  },
                  {
                    id: 'usb',
                    label: '/mnt/usb0',
                    value: '1.2 TB free',
                    pct: 0.4,
                    sub: '800 GB of 2 TB used',
                  },
                ],
              },
              {
                kind: 'list',
                id: 'startup',
                title: 'Homebrew startup',
                meta: 'On · Wait 5 s before starting · Last start finished',
                place: 'main',
                items: [
                  { id: 'kstuff', title: 'kstuff-lite', detail: 'local/kstuff-lite', right: 'Started' },
                  { id: 'wait', title: 'Wait 3 s' },
                  {
                    id: 'shadow',
                    title: 'ShadowMountPlus',
                    detail: 'local/shadowmountplus',
                    right: 'Started',
                  },
                ],
              },
              {
                kind: 'table',
                id: 'payloads',
                title: 'Homebrew payloads',
                place: 'main',
                columns: [
                  { key: 'name', label: 'Payload' },
                  { key: 'version', label: 'Version' },
                  { key: 'slot', label: 'Slot' },
                ],
                rows: [
                  {
                    id: 'installer',
                    cells: {
                      name: {
                        text: 'WebKit-Autoloader-Installer',
                        note: 'Installer · run by Whombat on 8 Nov',
                      },
                      version: { text: 'v0.7.1' },
                      slot: { text: 'repo/webkit-autoloader-installer@e8cce5d1', mono: true },
                    },
                  },
                  {
                    id: 'shadow',
                    cells: {
                      name: { text: 'ShadowMountPlus' },
                      version: { text: '1.7beta11', note: 'From its file name' },
                      slot: { text: 'local/shadowmountplus', mono: true },
                    },
                  },
                  {
                    id: 'kstuff',
                    cells: {
                      name: { text: 'kstuff-lite' },
                      version: { text: 'v1.10', note: 'v1.11 available' },
                      slot: { text: 'local/kstuff-lite', mono: true },
                    },
                  },
                  {
                    id: 'ftp',
                    cells: {
                      name: { text: 'ftpsrv' },
                      version: { text: 'v0.21.1', note: 'v0.22.0 available' },
                      slot: { text: 'local/ftpsrv', mono: true },
                    },
                  },
                ],
              },
              {
                kind: 'bars',
                id: 'machine',
                title: 'PlayStation 5 itself',
                place: 'chart',
                span: 1,
                items: [
                  { id: 'console', label: 'PS5-103', value: 'Firmware 10.01', pct: null },
                  { id: 'manager', label: 'Payload Manager', value: '0.6.3', pct: null },
                  { id: 'shadow', label: 'ShadowMountPlus', value: '1.7beta11', pct: null },
                  {
                    id: 'webkit',
                    label: 'WebKit Autoloader',
                    value: 'v0.7.1',
                    pct: null,
                    sub: 'Updated by Whombat on 8 Nov · started again since',
                  },
                ],
              },
            ],
          },
        ],
      }),
    }),
  },
];
