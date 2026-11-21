/**
 * Keys by risk (RA-01, RA-02; AP-678, AP-679; Merge and Deploy in three states since MDS-02, MDS-05, AP-609…AP-611): Settings
 * → the assistant → What it may do → KEYS shows six rows, Just watch · Ask me first · Go ahead, sends the tiers, reads what decides a merge into
 * main, and shows Deploy's hint only when the Whombat says it has no deploy workflow. A Whombat before 0.44 keeps the rows
 * it knows; one without `keys.merge_deploy` the locked pair.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KEY_TIER_LABELS as L } from '@whombat/core/keys';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { ASSISTANT_NAME } from '../../app/oneFixtures';
import { mockedServices, renderApp } from '../../test/renderApp';

const B = `/burrows/${burrow.slug}`;
const NO_WORKFLOW = 'No deploy workflow is set up on this Whombat yet.';
const KEYS = '/settings?tab=agent&part=may';

/** The fixture world, recording every write; `deployWorkflow` is what `host.info` answers (absent: left out). */
function server(deployWorkflow?: boolean) {
  const world = createWebFixtureFetch();
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const req = input instanceof Request ? input : new Request(url, init);
    const path = url.pathname.replace('/api/v1', '');
    if (req.method !== 'GET') {
      const text = await req.clone().text();
      calls.push({ method: req.method, path, body: text ? JSON.parse(text) : undefined });
    }
    const res = await world(req);
    if (req.method === 'GET' && path === `${B}/host` && deployWorkflow !== undefined) {
      const body = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, deployWorkflow }), {
        status: res.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return res;
  });
  return { fetch, calls };
}

type Row =
  | 'Deploy'
  | 'Merge into main'
  | 'Push to main'
  | 'Destructive commands on other machines'
  | 'Message people outside your Whombat'
  | 'Money';
const ROWS: Row[] = [
  'Deploy',
  'Merge into main',
  'Push to main',
  'Destructive commands on other machines',
  'Message people outside your Whombat',
  'Money',
];

/** The rows' names in order (a radio group is named by its legend). */
function rowNames(scope: HTMLElement): (string | null | undefined)[] {
  return within(scope)
    .getAllByRole('radiogroup')
    .map((g) => g.querySelector('legend')?.textContent);
}

function tierOf(scope: HTMLElement, row: Row): string | undefined {
  const group = within(scope).getByRole('radiogroup', { name: row });
  return within(group)
    .getAllByRole('radio')
    .find((r) => (r as HTMLInputElement).checked)
    ?.closest('label')?.textContent;
}

describe('What it may do → KEYS: the six rows (MD-02; AP-679)', () => {
  it('shows the six rows, writes a row’s tier over what the agent holds, and reads it back', async () => {
    const { fetch, calls } = server();
    const user = userEvent.setup();
    renderApp(KEYS, mockedServices(fetch));
    const main = await screen.findByRole('region', { name: 'KEYS' });
    await within(main).findByRole('radiogroup', { name: 'Merge into main' });
    expect(rowNames(main)).toEqual(ROWS);

    // Another tier, then back: no change, so nothing to save.
    const merge = screen.getByRole('radiogroup', { name: 'Merge into main' });
    const before = tierOf(main, 'Merge into main');
    const next = before === L.ask ? L.can : L.ask;
    await user.click(within(merge).getByRole('radio', { name: next }));
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toBeTruthy();
    await user.click(within(merge).getByRole('radio', { name: before ?? L.cannot }));
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();

    await user.click(within(merge).getByRole('radio', { name: next }));
    const money = screen.getByRole('radiogroup', { name: 'Money' });
    const moneyNext = tierOf(main, 'Money') === L.ask ? L.cannot : L.ask;
    await user.click(within(money).getByRole('radio', { name: moneyNext }));
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    await user.click(within(bar).getByRole('button', { name: 'Save' }));
    const path = `${B}/agent/keys`;
    await waitFor(() => expect(calls.some((c) => c.path === path)).toBe(true));
    const body = calls.find((c) => c.path === path)?.body as
      | { grants: { keyId: string; tier: string; scope?: unknown }[] }
      | undefined;
    const grants = body?.grants ?? [];
    const tier: Record<string, string> = { [L.cannot]: 'cannot', [L.ask]: 'ask', [L.can]: 'can' };
    // The row writes the umbrella and aligns the narrower grant, so nothing stale overrides it; Money writes both of
    // its keys (RA-DC02).
    expect(grants).toContainEqual({ keyId: 'merge.main', tier: tier[next] });
    expect(grants).toContainEqual({ keyId: 'merge', tier: tier[next] });
    expect(grants.find((g) => g.keyId === 'refunds.issue')?.tier).toBe(tier[moneyNext]);
    expect(grants.find((g) => g.keyId === 'billing.write')?.tier).toBe(tier[moneyNext]);
    expect((await screen.findByRole('status')).textContent).toContain(ASSISTANT_NAME);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull());
    expect(tierOf(screen.getByRole('region', { name: 'KEYS' }), 'Merge into main')).toBe(next);
  });

  it('shows Deploy’s hint when the Whombat has no deploy workflow', async () => {
    const { fetch } = server(false);
    renderApp(KEYS, mockedServices(fetch));
    expect(await screen.findByText(NO_WORKFLOW)).toBeTruthy();
  });
});
