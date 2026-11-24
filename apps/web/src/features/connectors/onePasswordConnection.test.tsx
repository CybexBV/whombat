/**
 * A 1Password vault kept in step with the Vault (Whombat onepassword-sync.md; app onepassword-sync.md), against the
 * fixture world's (onePasswordFixtures.ts): the connection's page without the agent's parts but KEPT IN STEP — the
 * vault, the counts, the last check and Sync now, the waiting, failing and read-only lines, what isn't in the Vault and
 * why, the guard's removals with their two answers —, Remove asking what becomes of the entries, the Vault's tag and
 * line, and the Inbox card's answers.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ONEPASSWORD_APP_TEXT } from '@whombat/client';
import { api, buildPath } from '@whombat/core/contracts';
import {
  ONEPASSWORD_WORDS,
  onePasswordSkipText,
  onePasswordWaitingLine,
  VAULT_COPY,
} from '@whombat/core/vault';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import type { OnePasswordFixtureKind } from '../../app/onePasswordFixtures';
import { pinMockDate } from '../../test/clock';
import { fixtureServices, mockedServices, renderApp } from '../../test/renderApp';

pinMockDate();

const PAGE = '/connections?connection=onepassword&id=con_fixture_1password';
const world = (onePassword: OnePasswordFixtureKind) =>
  fixtureServices({ connectors: 'connected', onePassword });

/** The fixture world with the requests it was sent, and its Vault's names as they are now. */
function recorded(onePassword: OnePasswordFixtureKind) {
  const base = createWebFixtureFetch({ connectors: 'connected', onePassword });
  const sent: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    sent.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    return base(new Request(url, init), init);
  }) as unknown as typeof globalThis.fetch;
  const vaultNames = async () => {
    const path = buildPath(api.vault.list.path, { burrow: burrow.slug });
    const res = await base(new Request(new URL(`/api/v1${path}`, 'http://whombat.test')));
    return ((await res.json()) as { entries: { name: string }[] }).entries.map((e) => e.name);
  };
  return { services: mockedServices(fetch), sent, vaultNames };
}

const keptInStep = () =>
  screen.findByRole('region', { name: ONEPASSWORD_APP_TEXT.section }, { timeout: 12_000 });

describe('the 1Password connection’s page', () => {
  it('shows the sync instead of the agent’s parts: the vault, the counts, the last check and what isn’t in', async () => {
    renderApp(PAGE, world('synced'));
    const part = await keptInStep();
    expect(await within(part).findByText('Whombat')).toBeTruthy();
    expect(within(part).getByText('6 logins and API tokens kept in step')).toBeTruthy();
    expect(within(part).getByText('Last checked 3 min ago')).toBeTruthy();
    const out = within(part).getByRole('list', { name: ONEPASSWORD_WORDS.notInVault });
    expect(within(out).getByText('Bank card').closest('li')?.textContent).toContain(
      onePasswordSkipText('other_kind'),
    );
    expect(within(out).getByText('Server key').closest('li')?.textContent).toContain(
      onePasswordSkipText('ssh_key'),
    );
    expect(within(part).queryByRole('button', { name: ONEPASSWORD_WORDS.removeHere })).toBeNull();

    // The agent never uses it: no level, handle, last use, tools or automations' words.
    const card = screen.getByRole('region', { name: 'CONNECTION' });
    expect(within(card).queryByText('LAST USED')).toBeNull();
    expect(within(card).queryByText(/CALLS IT$/)).toBeNull();
    expect(within(card).queryByText(/MAY DO$/)).toBeNull();
    expect(within(card).queryByText('Used by automations')).toBeNull();
    expect(screen.queryByRole('region', { name: 'TOOLS' })).toBeNull();
    // Its vault and the linking question aren't changed later.
    expect(screen.queryByRole('button', { name: /^Change / })).toBeNull();
    expect(screen.getByRole('button', { name: 'Replace token' })).toBeTruthy();
  });

  it('says a pass is on its way after Sync now, and the last check once it ends', async () => {
    const user = userEvent.setup();
    renderApp(PAGE, world('synced'));
    const part = await keptInStep();
    const sync = await within(part).findByRole('button', { name: ONEPASSWORD_WORDS.syncNow });
    await user.click(sync);
    expect(await within(part).findByText(ONEPASSWORD_APP_TEXT.syncing)).toBeTruthy();
    expect(
      (within(part).getByRole('button', { name: ONEPASSWORD_WORDS.syncNow }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // The page reads again while the pass runs, until it has ended.
    await waitFor(() => expect(within(part).queryByText(ONEPASSWORD_APP_TEXT.syncing)).toBeNull(), {
      timeout: 8_000,
    });
  }, 15_000);

  it('says why it waits for 1Password’s limit and when it tries again', async () => {
    renderApp(PAGE, world('waiting'));
    const part = await keptInStep();
    // The page says the clock time in the zone it runs in (11:40 in Amsterdam).
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const waiting = await within(part).findByText(onePasswordWaitingLine('2026-09-23T09:40:00.000Z', zone));
    expect(waiting.getAttribute('data-tone')).toBe('warn');
  });

  it('says why it fails in the Not working colour, with the read-only token’s line', async () => {
    renderApp(PAGE, world('failing'));
    const part = await keptInStep();
    expect((await within(part).findByText(ONEPASSWORD_WORDS.unreachable)).getAttribute('data-tone')).toBe(
      'bad',
    );
    expect(within(part).getByText(ONEPASSWORD_WORDS.readOnly).getAttribute('data-tone')).toBe('warn');
  });

  it('holds the guard’s removals with their names; Keep them here keeps them and the pause ends', async () => {
    const user = userEvent.setup();
    const { services, sent } = recorded('paused');
    renderApp(PAGE, services);
    const part = await keptInStep();
    const gone = await within(part).findByRole('list', { name: '1Password says 4 items are gone' });
    expect(
      within(gone)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Billing portal', 'Status page API', 'Old router', 'Mail admin']);
    await user.click(within(part).getByRole('button', { name: ONEPASSWORD_WORDS.keepHere }));
    expect(await screen.findByText(ONEPASSWORD_APP_TEXT.kept)).toBeTruthy();
    await waitFor(() => expect(within(part).queryByRole('list', { name: /items are gone/ })).toBeNull());
    expect(sent).toContain(
      'POST /api/v1/burrows/burrow-hq/connections/con_fixture_1password/onepassword/removals',
    );
  });

  it('asks whether the entries stay in the Vault when it is removed, keeping them by default', async () => {
    const user = userEvent.setup();
    const { services, sent, vaultNames } = recorded('synced');
    renderApp(PAGE, services);
    await keptInStep();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText(ONEPASSWORD_APP_TEXT.removeAsk('1Password'))).toBeTruthy();
    const keep = screen.getByRole('radio', { name: ONEPASSWORD_WORDS.disconnectKeep }) as HTMLInputElement;
    expect(keep.checked).toBe(true);
    await user.click(screen.getByRole('radio', { name: ONEPASSWORD_WORDS.disconnectRemove }));
    await user.click(screen.getByRole('button', { name: 'Remove 1Password' }));
    expect(await screen.findByText('1Password removed.')).toBeTruthy();
    expect(sent).toContain(
      'DELETE /api/v1/burrows/burrow-hq/connections/con_fixture_1password?vaultEntries=remove',
    );
    // The entries it kept in step went with it; the one only Whombat had stays.
    const names = await vaultNames();
    expect(names).not.toContain('Billing portal');
    expect(names).toContain('Home Assistant');
  });
});

describe('connecting 1Password', () => {
  it('asks the token and what happens to the entries, then the vault the token sees, with the generic form', async () => {
    const user = userEvent.setup();
    const base = createWebFixtureFetch({ connectors: 'connected' });
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
      if (init?.method === 'POST' && url.pathname.endsWith('/connections'))
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return base(new Request(url, init), init);
    }) as unknown as typeof globalThis.fetch;
    renderApp('/connections?connection=onepassword', mockedServices(fetch));
    await user.type(
      await screen.findByLabelText('SERVICE ACCOUNT TOKEN', {}, { timeout: 12_000 }),
      'ops_fixture',
    );
    // The one question, its first answer chosen.
    const put = screen.getByRole('radio', {
      name: 'Also put them in this 1Password vault',
    }) as HTMLInputElement;
    expect(put.checked).toBe(true);
    expect(screen.getByRole('radio', { name: 'Keep them only in Whombat' })).toBeTruthy();
    // The vault isn't asked until the token answers.
    expect(screen.queryByRole('radio', { name: 'Whombat' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await user.click(await screen.findByRole('radio', { name: 'Shared with Whombat' }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({
      catalogId: 'onepassword',
      fields: { vault: 'm4pqr7c8g3y5zje6xanw0dk9b1', entries: 'put' },
    });
  });
});

describe('the Vault', () => {
  it('tags the entries kept in step with 1Password, and says how each stands there', async () => {
    const user = userEvent.setup();
    renderApp('/vault', world('synced'));
    const list = await screen.findByRole('list', { name: VAULT_COPY.entries }, { timeout: 12_000 });
    const row = (name: RegExp) => within(list).getByRole('button', { name });
    expect(row(/^Grafana/).textContent).toContain(ONEPASSWORD_WORDS.tag);
    expect(row(/^Home Assistant/).textContent).not.toContain(ONEPASSWORD_WORDS.tag);
    await user.click(row(/^Grafana/));
    expect(await screen.findByText('Kept in step with 1Password · 2 min ago')).toBeTruthy();
    await user.click(row(/^Mail admin/));
    const problem = await screen.findByText('1Password’s item has no website now');
    expect(problem.getAttribute('data-tone')).toBe('warn');
  });
});

describe('the Inbox', () => {
  it('answers the guard from its card: both answers in sight, Remove them here too removes them', async () => {
    const user = userEvent.setup();
    const { services, sent, vaultNames } = recorded('paused');
    renderApp('/inbox', services);
    const you = await screen.findByRole('region', { name: 'Needs you' }, { timeout: 12_000 });
    const card = await within(you).findByRole('article', { name: '1Password says 4 items are gone' });
    expect(within(card).getByRole('button', { name: ONEPASSWORD_WORDS.keepHere })).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: ONEPASSWORD_WORDS.removeHere }));
    expect(await screen.findByText(ONEPASSWORD_APP_TEXT.removed)).toBeTruthy();
    await waitFor(() =>
      expect(within(you).queryByRole('article', { name: '1Password says 4 items are gone' })).toBeNull(),
    );
    expect(sent).toContain(
      'POST /api/v1/burrows/burrow-hq/connections/con_fixture_1password/onepassword/removals',
    );
    const names = await vaultNames();
    expect(names).not.toContain('Old router');
    expect(names).toContain('Grafana');
  });
});
