/**
 * Settings → Repositories (AP-540…AP-549): a new repository on this Whombat — the dialog says who the first commit is by,
 * refuses names that can't be a folder or are taken, and the repository joins the list.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch, FIXTURE_BASE_URL } from '../../app/fixtureFetch';
import { mockedServices, renderApp } from '../../test/renderApp';
import { localRepoNameProblem } from './NewRepoModal';

function world() {
  const fixtures = createWebFixtureFetch({ essentialsSettings: true });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    fixtures(
      new URL(String(input instanceof Request ? input.url : input), FIXTURE_BASE_URL).toString(),
      init,
    ),
  );
  return { fetch, services: mockedServices(fetch as typeof globalThis.fetch) };
}

describe('localRepoNameProblem', () => {
  it('says what is wrong with a name in plain words', () => {
    expect(localRepoNameProblem('', [])).toBeNull();
    expect(localRepoNameProblem('Whombat_Website', [])).toBeNull();
    expect(localRepoNameProblem('my site', [])).toBe('No spaces: use _ or - instead.');
    expect(localRepoNameProblem('.hidden', [])).toBe('Start with a letter or a digit.');
    expect(localRepoNameProblem('site.git', [])).toBe('Leave out the .git at the end.');
    expect(localRepoNameProblem('a/b', [])).toBe('Use only letters, digits, _ . and -.');
    expect(localRepoNameProblem('site', ['Site'])).toBe('This Whombat already has a repository called site.');
  });
});

describe('New repository', () => {
  it('creates a repository on this Whombat, by you, in the list', async () => {
    const user = userEvent.setup();
    const w = world();
    renderApp('/connections?connection=github', w.services);
    await screen.findByText('No repositories yet');
    await user.click(screen.getByRole('button', { name: 'New repository' }));

    const dialog = await screen.findByRole('dialog', { name: 'New repository' });
    expect(within(dialog).getByText('First commit by Mara Okafor')).toBeTruthy();
    const create = within(dialog).getByRole('button', { name: 'Create repository' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    const name = within(dialog).getByLabelText('Name');
    await user.type(name, 'my site');
    expect(within(dialog).getByRole('alert').textContent).toBe('No spaces: use _ or - instead.');
    expect(create.disabled).toBe(true);

    await user.clear(name);
    await user.type(name, 'Whombat_Website');
    expect(within(dialog).getByText('local/Whombat_Website')).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/Description/), 'The public website.');
    await user.click(create);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText(/^Created Whombat_Website\. \S+ can work in it now\.$/)).toBeTruthy();
    const list = (await screen.findByText('REPOSITORIES')).closest('section') as HTMLElement;
    expect(within(list).getByText('Whombat_Website')).toBeTruthy();
    expect(within(list).getByText('On this Whombat')).toBeTruthy();
    expect(within(list).getByText(/The public website\. · created/)).toBeTruthy();
    const [, init] =
      w.fetch.mock.calls.find(([url, i]) => i?.method === 'POST' && String(url).includes('/repos/local')) ??
      [];
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'Whombat_Website',
      description: 'The public website.',
    });
  });

  it('refuses a name the burrow already has before asking the Whombat', async () => {
    const user = userEvent.setup();
    const w = world();
    renderApp('/connections?connection=github', w.services);
    await user.click(await screen.findByRole('button', { name: 'New repository' }));
    let dialog = await screen.findByRole('dialog', { name: 'New repository' });
    await user.type(within(dialog).getByLabelText('Name'), 'site');
    await user.click(within(dialog).getByRole('button', { name: 'Create repository' }));
    await screen.findByText(/^Created site\. \S+ can work in it now\.$/);

    await user.click(screen.getByRole('button', { name: 'New repository' }));
    dialog = await screen.findByRole('dialog', { name: 'New repository' });
    await user.type(within(dialog).getByLabelText('Name'), 'SITE');
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'This Whombat already has a repository called SITE.',
    );
    expect(
      (within(dialog).getByRole('button', { name: 'Create repository' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
