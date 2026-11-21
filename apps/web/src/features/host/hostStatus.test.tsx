/**
 * Settings → This Whombat → “How it’s doing” (box-status.md AP-1137…AP-1146; Whombat BS-01, BS-08, BS-10): the first
 * section with the range, the tiles, the charts (and their tables) and the disk; nothing on a
 * self-hosted server; the sentence when the manager doesn't answer. The agent's part of the disk and memory is its
 * containers (CT-1535, AP-5694).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HostMetricsLoader } from '@whombat/client';
import type { HostMetricsInput } from '@whombat/protocol/session';
import { beforeEach, describe, expect, it } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { hostMetricsFixture } from '../../app/hostFixtures';
import { mockedServices, renderApp } from '../../test/renderApp';

const text = (el: Element | null) => (el?.textContent ?? '').replaceAll('\u00a0', ' ');

/** The fixture world (with the box's spend when `box`) and how `host.metrics` answers. */
function world(options: { box?: boolean; metrics?: HostMetricsLoader | null } = {}) {
  const base = createWebFixtureFetch({ host: options.box ?? false });
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    return base(new Request(url, input instanceof Request ? input : init));
  };
  return { ...mockedServices(fetch as typeof globalThis.fetch), hostMetrics: options.metrics ?? null };
}

/** The fixture box's manager, remembering what it was asked. */
function box() {
  const asked: HostMetricsInput[] = [];
  const load: HostMetricsLoader = async (input) => {
    asked.push(input);
    return hostMetricsFixture(input, Date.now());
  };
  return { asked, load };
}

async function section() {
  const heading = await screen.findByRole('heading', { level: 2, name: 'How it’s doing' });
  return heading.closest('section') as HTMLElement;
}

describe('How it’s doing (BS-01, BS-10)', () => {
  // Show charts stays open for the visit (AP-1227): each test starts closed.
  beforeEach(() => sessionStorage.clear());

  it('shows the range, the live line, the tiles, the charts and the disk, and no tokens', async () => {
    const user = userEvent.setup();
    const manager = box();
    renderApp('/settings?tab=appliance', world({ box: true, metrics: manager.load }));
    const s = await section();
    // On This Whombat's Overview, before AT A GLANCE (this-whombat-sections.md AP-1223).
    const labels = [...document.querySelectorAll('#settings-panel h2')].map((h) => h.textContent);
    expect(labels[0]).toBe('How it’s doing');
    expect(labels).toContain('AT A GLANCE');
    const range = within(s).getByRole('group', { name: 'Time range' });
    expect(
      within(range)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual(['Last hour', '24 hours', '7 days', '30 days']);
    expect(within(range).getByRole('radio', { name: '24 hours' })).toHaveProperty('checked', true);
    expect(within(s).getByText('Live · checked every 10 seconds')).toBeTruthy();
    // The tiles first; the charts behind Show charts (AP-1227), kept open for the visit.
    await within(s).findByText('Memory');
    expect(within(s).queryByRole('heading', { level: 3, name: 'Processor' })).toBeNull();
    await user.click(within(s).getByRole('button', { name: 'Show charts' }));
    expect(within(s).getByRole('button', { name: 'Hide charts' }).getAttribute('aria-expanded')).toBe('true');
    expect(sessionStorage.getItem('whombat.thisWhombat.charts')).toBe('1');
    await within(s).findByRole('heading', { level: 3, name: 'Processor' });
    expect(text(s)).toContain('Memory1.8 of 16 GB');
    expect(text(s)).toContain('Disk40 of 87 GB');
    expect(text(s)).toContain('46 GB free');
    expect(text(s)).toContain('Today2.2 GB in41 MB out');
    expect(text(s)).toMatch(/Peak \d+ % at \d\d:\d\d/);
    expect(within(s).getByText('How busy the Whombat was, in percent of all 4 cores')).toBeTruthy();
    for (const name of ['Network speed', 'Data per day', 'Disk'])
      expect(within(s).getByRole('heading', { level: 3, name })).toBeTruthy();
    // What the AI used is Spend's, in Settings → Advanced: not here too.
    expect(within(s).queryByRole('heading', { level: 3, name: 'Tokens' })).toBeNull();
    // The disk's parts, largest first, then Free; the system disk under them.
    expect(text(s.querySelector('dl'))).toBe(
      'The agent’s containers22.9 GBWhombat’s own data9.6 GBWork folders7.5 GBFree46 GB',
    );
    expect(within(s).getByText((_, el) => text(el) === 'System 6.1 GB of 20 GB')).toBeTruthy();
    // The whole range first; another range is fetched whole.
    expect(manager.asked[0]).toEqual({ range: 'day' });
    await user.click(within(range).getByRole('radio', { name: 'Last hour' }));
    await waitFor(() => expect(manager.asked.at(-1)).toEqual({ range: 'hour' }));
  });

  it('shows a chart as a table and back', async () => {
    const user = userEvent.setup();
    renderApp('/settings?tab=appliance', world({ box: true, metrics: box().load }));
    const s = await section();
    await user.click(await within(s).findByRole('button', { name: 'Show charts' }));
    await within(s).findByRole('heading', { level: 3, name: 'Processor' });
    const toggle = within(s).getAllByRole('button', { name: 'Show as a table' })[0] as HTMLElement;
    await user.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.textContent).toBe('Show as a chart');
    const table = within(s).getByRole('table', { name: 'Processor' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Time', 'Processor']);
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(200);
    await user.click(toggle);
    expect(within(s).queryByRole('table')).toBeNull();
  });

  it('says it’s measuring since when, while less than the range has been measured', async () => {
    const load: HostMetricsLoader = async (input) => {
      const out = hostMetricsFixture(input, Date.now());
      if (out.metrics) out.metrics.measuringSince = new Date(Date.now() - 3_600_000).toISOString();
      return out;
    };
    renderApp('/settings?tab=appliance', world({ box: true, metrics: load }));
    const s = await section();
    expect(
      await within(s).findByText(/^Measuring since \d\d:\d\d\. The charts fill in as time goes on\.$/),
    ).toBeTruthy();
  });

  it('leaves the section out on a Whombat without a manager to ask', async () => {
    renderApp('/settings?tab=appliance', world());
    // The Overview is there, without How it’s doing.
    await screen.findByRole('heading', { level: 2, name: 'AT A GLANCE' });
    expect(screen.queryByRole('heading', { level: 2, name: 'How it’s doing' })).toBeNull();
  });

  it('says the measurements can’t be read when the manager doesn’t answer', async () => {
    const load: HostMetricsLoader = async () => ({ metrics: null, reason: 'unavailable' });
    renderApp('/settings?tab=appliance', world({ metrics: load }));
    const s = await section();
    expect(await within(s).findByText('The Whombat can’t read its measurements right now.')).toBeTruthy();
    expect(within(s).queryByRole('heading', { name: 'Disk' })).toBeNull();
  });
});
