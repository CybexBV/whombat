/**
 * A service's page as a builder sends it (contracts 0.121, CT-1000…CT-1014; service-dashboards.md AP-4560…AP-4569):
 * a gallery of posters with their words, badge, progress and buttons, controls with a switch, a stepper and buttons,
 * panel head buttons, a button in a table cell, a list line with a picture and buttons, and a notice's button; each
 * button disabled with its reason when not allowed, asking first when it has a question, sending `things.action` with
 * its action, target and value, and the toast saying the server's words.
 */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useThingButtons } from '@whombat/client/react';
import type { ThingPageButton, ThingPagePanel } from '@whombat/core';
import { burrow } from '@whombat/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../../../app/providers';
import { useToast } from '../../../components/Toast';
import { mockedServices } from '../../../test/renderApp';
import { ThingButtonQuestion } from './Buttons';
import { Dashboard } from './Dashboard';
import type { DashboardContext } from './Panels';

const T0 = Date.parse('2026-10-21T10:00:00Z');
const THING = 'connection:con_seerr';
const REF = (slug: string) => `fx-poster-${slug}.fixture-signature`;

const approve = (target: string): ThingPageButton => ({
  action: 'approve',
  target,
  label: 'Approve',
  icon: 'check',
  tone: 'primary',
  allowed: true,
});
const decline = (target: string): ThingPageButton => ({
  action: 'decline',
  target,
  label: 'Decline',
  icon: 'close',
  allowed: true,
  confirm: { title: 'Decline Dune?', body: 'Anna is told it was declined.', button: 'Decline' },
});

const PANELS = [
  {
    kind: 'gallery',
    id: 'waiting',
    place: 'main',
    title: 'Waiting for approval',
    meta: '2',
    shape: 'poster',
    buttons: [
      { action: 'approve_all', label: 'Approve all', allowed: false, reason: 'Look only: not yours.' },
    ],
    items: [
      {
        id: 'req_1',
        title: 'Dune: Part Two',
        sub: '2024 · Asked by Anna',
        image: { ref: REF('dune'), alt: 'Poster of Dune: Part Two', shape: 'poster' },
        badge: { text: '4K', tone: 'ok' },
        progress: 0.63,
        note: '63 % · 12 min left',
        href: '/things/connection:con_sabnzbd',
        actions: [approve('req_1'), decline('req_1')],
      },
      { id: 'req_2', title: 'Arrival', sub: '2016', url: 'https://seerr.example/movie/329865' },
    ],
  },
  {
    kind: 'controls',
    id: 'controls',
    place: 'main',
    title: 'Controls',
    hint: 'Pin favourites on Home Assistant’s Home dashboard to choose what shows here.',
    groups: [
      {
        id: 'living',
        title: 'Living room',
        items: [
          {
            id: 'light.ceiling',
            label: 'Ceiling',
            icon: 'light',
            state: 'On · 80 %',
            on: true,
            toggle: { action: 'toggle', target: 'light.ceiling', label: 'Ceiling', allowed: true },
          },
          {
            id: 'climate.living',
            label: 'Thermostat',
            icon: 'thermostat',
            state: '20.4 °C · Heating',
            stepper: {
              value: 21,
              min: 7,
              max: 30,
              step: 0.5,
              unit: '°C',
              button: { action: 'set_temperature', target: 'climate.living', label: 'Set', allowed: true },
            },
          },
          {
            id: 'lock.front',
            label: 'Front door',
            icon: 'lock',
            state: 'Locked',
            buttons: [
              {
                action: 'unlock',
                target: 'lock.front',
                label: 'Unlock',
                icon: 'unlock',
                allowed: false,
                reason: 'Look only: Whombat changes nothing here.',
              },
            ],
          },
        ],
      },
    ],
  },
  {
    kind: 'table',
    id: 'libraries',
    place: 'main',
    title: 'Libraries',
    buttons: [{ action: 'check_updates', label: 'Check for updates', icon: 'search', allowed: true }],
    columns: [
      { key: 'name', label: 'Library' },
      { key: 'scan', label: '' },
    ],
    rows: [
      {
        id: 'lib_1',
        cells: {
          name: { text: 'Films', url: 'https://plex.example/web/library/1' },
          scan: { text: 'Scan', action: { action: 'scan', target: '1', label: 'Scan', allowed: true } },
        },
      },
    ],
  },
  {
    kind: 'list',
    id: 'issues',
    place: 'side',
    title: 'Issues',
    items: [
      {
        id: 'iss_1',
        title: 'Audio out of sync',
        detail: 'Dune · Anna',
        image: { ref: REF('dune-issue'), alt: '', shape: 'poster' },
        actions: [{ action: 'resolve', target: 'iss_1', label: 'Mark resolved', allowed: true }],
      },
    ],
  },
  {
    kind: 'notices',
    id: 'look',
    place: 'side',
    title: 'Worth a look',
    items: [
      {
        id: 'failed',
        tone: 'warn',
        icon: 'warn',
        title: '1 request failed',
        action: { action: 'retry', target: 'req_9', label: 'Retry', icon: 'retry', allowed: true },
      },
    ],
  },
] as unknown as ThingPagePanel[];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function Page({ panels }: { panels: ThingPagePanel[] }) {
  const toast = useToast();
  const buttons = useThingButtons(burrow.slug, THING, (m) => toast.show(m));
  const ctx: DashboardContext = {
    burrow: burrow.slug,
    thing: { id: THING, name: 'Seerr', settings: true, canManage: true },
    timeZone: 'Europe/Amsterdam',
    now: T0,
    range: '24h',
    onAsk: vi.fn(),
    onTab: vi.fn(),
    buttons,
    readAt: 0,
  };
  return (
    <>
      <Dashboard panels={panels} ctx={ctx} />
      <ThingButtonQuestion buttons={buttons} />
    </>
  );
}

function renderPage(
  answer: (body: Record<string, unknown>) => Response = () => json({ message: 'Done.' }, 202),
) {
  const sent: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://x');
    const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
    if (url.pathname.endsWith('/actions') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      return answer(body);
    }
    // Pictures: jsdom can't make object URLs, so every picture stays its box with its letter.
    if (url.pathname.includes('/images/')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    return json({});
  }) as unknown as typeof globalThis.fetch;
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <Page panels={PANELS} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <Providers services={mockedServices(fetch)}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { sent };
}

const card = async (name: string) =>
  (await screen.findByRole('heading', { name, level: 2 })).closest('section') as HTMLElement;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('a service’s page', () => {
  it('draws a gallery: links, words, badge, progress and buttons; an item without a picture shows its letter', async () => {
    renderPage();
    const gallery = await card('Waiting for approval');
    const dune = within(gallery).getByRole('link', { name: /^Dune: Part Two · 2024 · Asked by Anna · 4K/ });
    expect(dune.getAttribute('href')).toBe('/things/connection:con_sabnzbd');
    expect(dune.getAttribute('target')).toBeNull();
    const arrival = within(gallery).getByRole('link', { name: 'Arrival · 2016' });
    expect(arrival.getAttribute('target')).toBe('_blank');
    expect(arrival.textContent).toContain('A');
    const bar = within(gallery).getByRole('progressbar', { name: 'Dune: Part Two' });
    expect(bar.getAttribute('aria-valuenow')).toBe('63');
    expect(bar.getAttribute('aria-valuetext')).toBe('63 % · 12 min left');
    const actions = within(gallery).getByRole('group', { name: 'Dune: Part Two' });
    expect(
      within(actions)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Approve', 'Decline']);
    // The head's button the viewer may not press: in place, greyed, its reason as its description.
    const all = within(gallery).getByRole('button', { name: 'Approve all' });
    expect(all.getAttribute('aria-disabled')).toBe('true');
    expect(all.getAttribute('title')).toContain('Look only');
    expect(all.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('runs a button at once and says the server’s words; one with a question asks first', async () => {
    const { sent } = renderPage((b) =>
      json({ message: b.action === 'approve' ? 'Approved Dune.' : 'Declined Dune.' }, 202),
    );
    const user = userEvent.setup();
    const gallery = await card('Waiting for approval');
    await user.click(within(gallery).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved Dune.')).toBeTruthy();
    expect(sent).toEqual([{ action: 'approve', target: 'req_1' }]);

    await user.click(within(gallery).getByRole('button', { name: 'Decline' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Decline Dune?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(sent).toHaveLength(1);
    await user.click(within(gallery).getByRole('button', { name: 'Decline' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Decline' }));
    expect(await screen.findByText('Declined Dune.')).toBeTruthy();
    expect(sent[1]).toEqual({ action: 'decline', target: 'req_1' });
  });

  it('does nothing for a disabled button', async () => {
    const { sent } = renderPage();
    const user = userEvent.setup();
    const controls = await card('Controls');
    await user.click(within(controls).getByRole('button', { name: 'Unlock' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('switches a light at once, sends the state it isn’t in, and puts it back when refused', async () => {
    let refuse = false;
    const { sent } = renderPage(() =>
      refuse
        ? json({ error: { code: 'forbidden', message: 'Look only: Whombat changes nothing here.' } }, 403)
        : json({ message: 'Turned off Ceiling.' }, 202),
    );
    const user = userEvent.setup();
    const controls = await card('Controls');
    expect(within(controls).getByText(/Pin favourites/)).toBeTruthy();
    expect(within(controls).getByRole('region', { name: 'Living room' })).toBeTruthy();
    const ceiling = within(controls).getByRole('switch', { name: 'Ceiling' });
    expect(ceiling.getAttribute('aria-checked')).toBe('true');
    await user.click(ceiling);
    expect(ceiling.getAttribute('aria-checked')).toBe('false');
    expect(await screen.findByText('Turned off Ceiling.')).toBeTruthy();
    expect(sent).toEqual([{ action: 'toggle', target: 'light.ceiling', value: false }]);
    // Kept as set until the page is read again after the answer (this test's page never is).
    expect(ceiling.getAttribute('aria-checked')).toBe('false');
    refuse = true;
    await user.click(ceiling);
    expect(await screen.findByText('Look only: Whombat changes nothing here.')).toBeTruthy();
    await waitFor(() => expect(ceiling.getAttribute('aria-checked')).toBe('true'));
  });

  it('steps a thermostat and sends its figure once the presses stop', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { sent } = renderPage(() => json({ message: 'Set Thermostat to 22.0 °C.' }, 202));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const controls = await card('Controls');
    const stepper = within(controls).getByRole('group', { name: 'Thermostat' });
    await user.click(within(stepper).getByRole('button', { name: 'Raise Thermostat' }));
    await user.click(within(stepper).getByRole('button', { name: 'Raise Thermostat' }));
    expect(within(stepper).getByRole('status').textContent).toBe('22.0\u00a0°C');
    expect(sent).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await waitFor(() =>
      expect(sent).toEqual([{ action: 'set_temperature', target: 'climate.living', value: 22 }]),
    );
  });

  it('draws head buttons, a cell’s button and link, a line’s picture and buttons, and a notice’s button', async () => {
    const { sent } = renderPage();
    const user = userEvent.setup();
    const libraries = await card('Libraries');
    expect(within(libraries).getByRole('button', { name: 'Check for updates' })).toBeTruthy();
    expect(within(libraries).getByRole('link', { name: 'Films' }).getAttribute('target')).toBe('_blank');
    await user.click(within(libraries).getByRole('button', { name: 'Scan' }));
    await waitFor(() => expect(sent).toEqual([{ action: 'scan', target: '1' }]));
    const issues = await card('Issues');
    expect(within(issues).getByRole('group', { name: 'Audio out of sync' })).toBeTruthy();
    expect(issues.querySelector('[data-shape="poster"]')).toBeTruthy();
    const look = await card('Worth a look');
    await user.click(within(look).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(sent.at(-1)).toEqual({ action: 'retry', target: 'req_9' }));
  });
});
