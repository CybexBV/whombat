/**
 * Website logins in the Vault (docs/decisions/vault.md VT-D28…VT-D30; AP-217; since contracts 0.125 AP-5242) against the
 * fixture world: a username makes the add form a website login, a Password for an HTTP API is chosen under Advanced,
 * and an entry signs in as its user in the agent's browser — no selectors and no Test sign-in any more.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { pinMockDate } from '../../test/clock';
import { mockedServices, renderApp } from '../../test/renderApp';
import { createBody, emptyForm, formProblems } from './model';

pinMockDate();

const B = burrow.slug;

/** The fixture world with every Vault write recorded. */
function world() {
  const base = createWebFixtureFetch();
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const path = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (/vault/.test(path) && method !== 'GET') {
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ method, path, body: body ? JSON.parse(body) : undefined });
    }
    return base(new Request(url, init), init);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

async function addLogin(w = world()) {
  const user = userEvent.setup();
  const app = renderApp(`/vault`, mockedServices(w.fetch));
  await user.click(await screen.findByRole('button', { name: 'Add to Vault' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add to Vault' });
  return { ...w, user, app, dialog: within(dialog), saved: () => dialog.querySelector('[data-saved-as]') };
}

describe('Add to Vault → Login', () => {
  it('is a website login once a username is typed, and a Password for an API is chosen under Advanced', async () => {
    const { user, dialog, saved } = await addLogin();
    expect(dialog.queryByLabelText('Kind')).toBeNull();
    expect(dialog.getByLabelText('Password or sign-in key')).toBeTruthy();
    await user.type(dialog.getByLabelText('Username'), 'admin');
    expect((saved() as HTMLElement).dataset.savedAs).toBe('login');
    expect((saved() as HTMLElement).textContent).toMatch(/^Website login · A website Neo signs in to/);
    expect(dialog.getByLabelText('Password')).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: 'Advanced' }));
    await user.selectOptions(dialog.getByLabelText('Kind'), 'basic');
    expect((saved() as HTMLElement).textContent).toMatch(/^Password · /);
    expect(dialog.getByLabelText('Address')).toBeTruthy();
    expect((dialog.getByLabelText('Username') as HTMLInputElement).value).toBe('admin');
    expect(dialog.getByLabelText('Password')).toBeTruthy();
    expect(dialog.queryByLabelText('How it signs in')).toBeNull();
  });

  it('adds a website login, without signing in, and opens it', async () => {
    const { user, dialog, calls } = await addLogin();
    expect(dialog.queryByLabelText('How it signs in')).toBeNull();
    // Nothing filled in: the contract's refusals, nothing sent.
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect(dialog.getByText('Give it a name.')).toBeTruthy();
    expect(calls).toEqual([]);

    await user.type(dialog.getByLabelText('What it’s for'), 'Supplier portal');
    await user.type(dialog.getByLabelText('Address'), 'https://portal.example.com/sign-in');
    await user.type(dialog.getByLabelText('Username'), 'orders@burrowhq.example');
    const password = dialog.getByLabelText('Password') as HTMLInputElement;
    expect(password.type).toBe('password');
    await user.type(password, 'correct horse');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/burrows/${B}/vault`,
        body: {
          name: 'Supplier portal',
          description: '',
          kind: 'login',
          url: 'https://portal.example.com/sign-in',
          auth: { type: 'form', username: 'orders@burrowhq.example' },
          secret: 'correct horse',
        },
      },
    ]);
    const card = within((await screen.findByText('Supplier portal')).closest('li') as HTMLElement);
    expect(await card.findByText('Signs in as orders@burrowhq.example in the browser')).toBeTruthy();
    expect(card.getByText('Website login')).toBeTruthy();
    expect(card.getByRole('heading', { name: 'PASSWORD' })).toBeTruthy();
    expect(card.queryByRole('button', { name: 'Test sign-in' })).toBeNull();
    expect(card.queryByRole('button', { name: 'Check again' })).toBeNull();
    expect(card.getByRole('radiogroup', { name: 'Neo can use this' })).toBeTruthy();
  });

  it('says a server key pasted as a password goes in its own field, and sends nothing', async () => {
    const { user, dialog, calls } = await addLogin();
    await user.type(dialog.getByLabelText('What it’s for'), 'Box');
    await user.type(dialog.getByLabelText('Address'), 'https://box.example.com');
    await user.click(dialog.getByLabelText('Password or sign-in key'));
    await user.paste('-----BEGIN OPENSSH PRIVATE KEY-----abc');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect(dialog.getByText(/Paste a server key instead/, { selector: 'p' })).toBeTruthy();
    expect(calls).toEqual([]);
  });
});

describe('a login’s entry', () => {
  it('replaces the password with the username', async () => {
    const { user, dialog, calls } = await addLogin();
    await user.type(dialog.getByLabelText('What it’s for'), 'Supplier portal');
    await user.type(dialog.getByLabelText('Address'), 'https://portal.example.com/sign-in');
    await user.type(dialog.getByLabelText('Username'), 'orders@burrowhq.example');
    await user.type(dialog.getByLabelText('Password'), 'correct horse');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    const li = (await screen.findByText('Supplier portal')).closest('li') as HTMLElement;
    const card = within(li);
    const id = li.dataset.entry;

    await user.click(await card.findByRole('button', { name: 'Replace' }));
    expect((card.getByLabelText('Username') as HTMLInputElement).value).toBe('orders@burrowhq.example');
    await user.clear(card.getByLabelText('Username'));
    await user.type(card.getByLabelText('Username'), 'shop@burrowhq.example');
    await user.type(card.getByLabelText('Password'), 'battery staple');
    await user.click(card.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        path: `/burrows/${B}/vault/${id}/secret`,
        body: { value: 'battery staple', username: 'shop@burrowhq.example' },
      }),
    );
  });
});

describe('the login form model', () => {
  it('builds a login’s body', () => {
    expect(
      createBody('login', {
        ...emptyForm('login'),
        name: ' Shop ',
        url: 'https://shop.example.com/admin/login',
        username: 'mara@burrowhq.example',
        secret: 'pw',
      }),
    ).toEqual({
      name: 'Shop',
      description: '',
      kind: 'login',
      url: 'https://shop.example.com/admin/login',
      auth: { type: 'form', username: 'mara@burrowhq.example' },
      secret: 'pw',
    });
  });

  it('refuses a login without a username', () => {
    expect(
      formProblems('login', {
        ...emptyForm('login'),
        name: 'Shop',
        url: 'https://shop.example.com',
        secret: 'pw',
      }),
    ).toEqual({ 'auth.username': 'Add the username.' });
  });
});
