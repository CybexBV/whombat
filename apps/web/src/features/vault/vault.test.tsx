/**
 * The Vault against the fixture world (`createFixtureFetch` serves Mara's four entries, recent uses and the home
 * network 192.168.1.0/24; the agent, Neo, may use each but the old secret): YOUR ENTRIES with the kinds in words, an
 * open entry's blocks and their writes, the agent's one row (on or off), Add to Vault (the kind
 * picked from what is typed, the rest under Advanced; save, then check), Remove under Danger, the home network ranges
 * in Settings, and your line in the audit log.
 */
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { pinMockDate } from '../../test/clock';
import { recordingWorld } from '../../test/recordingWorld';
import { mockedServices, renderApp } from '../../test/renderApp';
import { vaultEntryLine, vaultWords } from './copy';
import { addressUrl, createBody, emptyForm, formFor, formProblems, guessTemplate, parsePorts } from './model';

pinMockDate();

const B = burrow.slug;

/** The fixture world, with every Vault call recorded (method, path, body). */
function world() {
  const base = createWebFixtureFetch();
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const path = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (/vault|secrets/.test(path) && method !== 'GET') {
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ method, path, body: body ? JSON.parse(body) : undefined });
    }
    return base(new Request(url, init), init);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

async function openVault(url = `/vault`) {
  const w = world();
  const user = userEvent.setup();
  const app = renderApp(url, mockedServices(w.fetch));
  await screen.findByRole('list', { name: 'YOUR ENTRIES' });
  return { ...w, user, app };
}

describe('The Vault', () => {
  it('says what Neo can use, each entry’s check and last use, and only a failing one loud', async () => {
    const { user } = await openVault();
    expect(screen.getByText(/^Sign-ins and secrets Neo can use/)).toBeTruthy();
    expect(screen.getByText('Sign-in reached · Last used 09:12')).toBeTruthy();
    expect(screen.getByText('Secret · Neo is off')).toBeTruthy();
    // Only the failing entry is marked, with its reason from the last check.
    const failing = document.querySelectorAll('[data-problem]');
    expect(failing.length).toBe(1);
    expect(failing[0]?.textContent).toMatch(/^Not working · The password stopped working/);
    expect(screen.queryByText(/MCP server|API token|Basic auth/)).toBeNull();
    // What it is and where it points, once it is open.
    const grafana = screen.getByText('Grafana').closest('li') as HTMLElement;
    await user.click(within(grafana).getByRole('button', { expanded: false }));
    expect(await within(grafana).findByText('grafana.example.com')).toBeTruthy();
    expect(within(grafana).getByText(/^Sign-in key/)).toBeTruthy();
  });

  it('leaves the home network ranges to What Neo may do, with one line there', async () => {
    await openVault();
    expect(screen.queryByRole('heading', { name: 'HOME NETWORK' })).toBeNull();
    expect(screen.queryByLabelText('Network')).toBeNull();
    const link = screen.getByRole('link', { name: 'See home network ranges' });
    expect(link.getAttribute('href')).toBe('/settings?tab=agent&part=may#local-network');
  });

  it('is a page of its own in the sidebar, and the old Settings tab’s address opens it (AP-671)', async () => {
    const { app } = await openVault(`/settings?tab=vault&entry=vlt_grafana`);
    await waitFor(() => expect(app.location()).toBe(`/vault?entry=vlt_grafana`));
    expect(screen.getByRole('heading', { level: 1, name: 'Vault' })).toBeTruthy();
    const row = screen.getByRole('link', { name: 'Vault' });
    expect(row.getAttribute('href')).toBe('/vault');
    expect(row.getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('tab', { name: 'Vault' })).toBeNull();
  });

  it('opens an entry from the URL and changes its tools', async () => {
    const { user, calls, app } = await openVault(`/vault?entry=vlt_homeassistant`);
    const card = (await within(screen.getByRole('main')).findByText('Home Assistant')).closest(
      'li',
    ) as HTMLElement;
    const entry = within(card);
    expect(entry.getByRole('button', { expanded: true })).toBeTruthy();
    expect(await entry.findByText('Set · replaced 2 days ago')).toBeTruthy();
    expect(entry.getByText('Checked 3 min ago · Reached · 5 tools')).toBeTruthy();
    expect(entry.getByText('New')).toBeTruthy();
    const uses = entry.getByRole('list', { name: 'RECENT USE' });
    expect([...uses.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Neo · in Neo’s tools for this turn · done10:48',
      'Neo · in Neo’s tools for this turn · doneYesterday',
      'Neo · in Neo’s tools for this turn · refusedYesterday',
    ]);

    // Turn the new tool on.
    await user.click(entry.getByRole('switch', { name: 'GetLiveContext' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        path: `/burrows/${B}/vault/vlt_homeassistant/tools/GetLiveContext`,
        body: { enabled: true },
      }),
    );
    await waitFor(() => expect(entry.queryByText('New')).toBeNull());

    // Closing the entry drops it from the URL.
    await user.click(entry.getByRole('button', { expanded: true }));
    await waitFor(() => expect(app.location()).toBe(`/vault`));
  });

  it('replaces a secret write-only and checks the connection again', async () => {
    const { user, calls } = await openVault(`/vault?entry=vlt_printer`);
    const card = (await screen.findByText('Printer admin')).closest('li') as HTMLElement;
    const entry = within(card);
    expect(await entry.findByText('Checked 4 days ago · The server rejected the secret (401).')).toBeTruthy();
    await user.click(entry.getByRole('button', { name: 'Replace' }));
    const input = entry.getByLabelText('Password') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect((entry.getByLabelText('Username') as HTMLInputElement).value).toBe('admin');
    await user.type(input, 'hunter2');
    await user.click(entry.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        path: `/burrows/${B}/vault/vlt_printer/secret`,
        body: { value: 'hunter2' },
      }),
    );
    expect(await entry.findByText(/^Set · replaced/)).toBeTruthy();
    expect(entry.queryByDisplayValue('hunter2')).toBeNull();
    await user.click(entry.getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: `/burrows/${B}/vault/vlt_printer/check`,
        body: undefined,
      }),
    );
    expect(await entry.findByText('Checked just now · The server rejected the secret (401).')).toBeTruthy();
  });

  it('adds a sign-in key from the plain fields, then checks it, and opens the new entry', async () => {
    const { user, calls } = await openVault();
    await user.click(await screen.findByRole('button', { name: 'Add to Vault' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add to Vault' });
    // No kind to choose first: without a username it is a sign-in key, said as it is typed.
    expect(within(dialog).queryByRole('button', { name: /^Sign-in key/ })).toBeNull();
    expect((dialog.querySelector('[data-saved-as]') as HTMLElement).dataset.savedAs).toBe('token');
    // Nothing filled in: the contract's refusals, nothing sent.
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText('Give it a name.')).toBeTruthy();
    expect(within(dialog).getByText('Add the address.')).toBeTruthy();
    expect(within(dialog).getByText('Paste the secret.')).toBeTruthy();
    expect(calls).toEqual([]);

    await user.type(within(dialog).getByLabelText('What it’s for'), 'Status page');
    // No scheme typed: a public address gets https.
    await user.type(within(dialog).getByLabelText('Address'), 'status.example.com/api');
    await user.type(within(dialog).getByLabelText('What should Neo know?'), 'Read only.');
    const secret = within(dialog).getByLabelText('Password or sign-in key') as HTMLInputElement;
    expect(secret.type).toBe('password');
    await user.type(secret, 'tok_123');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls[0]).toEqual({
      method: 'POST',
      path: `/burrows/${B}/vault`,
      body: {
        name: 'Status page',
        description: 'Read only.',
        kind: 'http',
        url: 'https://status.example.com/api',
        auth: { type: 'bearer' },
        secret: 'tok_123',
      },
    });
    expect(calls[1]?.path).toMatch(new RegExp(`^/burrows/${B}/vault/vlt_[A-Za-z0-9_-]+/check$`));
    expect(await screen.findByText('Added “Status page” to your Vault. Reached · answered 200')).toBeTruthy();
    const card = (await screen.findByText('Status page')).closest('li') as HTMLElement;
    expect(within(card).getByRole('button', { expanded: true })).toBeTruthy();
    expect(await within(card).findByText('Checked just now · Reached · answered 200')).toBeTruthy();
  });

  it('offers no Connection under Advanced, and puts a refused address under Address', async () => {
    const { user } = await openVault();
    await user.click(await screen.findByRole('button', { name: 'Add to Vault' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add to Vault' });
    // How it signs in and a header's name wait under Advanced.
    expect(within(dialog).queryByLabelText('How it signs in')).toBeNull();
    expect(within(dialog).queryByLabelText('Header name')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Advanced' }));
    // An MCP server is connected in Connections now (vault-simplify.md VLT-30).
    const kinds = [...(within(dialog).getByLabelText('Kind') as HTMLSelectElement).options].map(
      (o) => o.value,
    );
    expect(kinds).not.toContain('mcp');
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'token');
    await user.type(within(dialog).getByLabelText('What it’s for'), 'Garage');
    await user.type(within(dialog).getByLabelText('Address'), 'http://192.168.7.2:8123/api');
    expect(
      within(dialog).getByText(/This address uses http: the secret crosses your network unencrypted\./),
    ).toBeTruthy();
    await user.selectOptions(within(dialog).getByLabelText('How it signs in'), 'header');
    expect(within(dialog).getByLabelText('Header name')).toBeTruthy();
    await user.selectOptions(within(dialog).getByLabelText('How it signs in'), 'bearer');
    await user.type(within(dialog).getByLabelText('Sign-in key'), 'k-123');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(/Add 192\.168\.7\.0\/24 port 8123 to the home network list/),
    ).toBeTruthy();
  });

  it('removes an entry from its Danger fold, after asking', async () => {
    const { user, calls } = await openVault(`/vault?entry=vlt_grafana`);
    const card = (await screen.findByText('Grafana')).closest('li') as HTMLElement;
    await user.click(await within(card).findByRole('button', { name: 'Danger' }));
    await user.click(await within(card).findByRole('button', { name: 'Remove from Vault' }));
    expect(within(card).getByText(/^Remove “Grafana”\? Neo can’t use it any more/)).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: 'Remove from Vault' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'DELETE',
        path: `/burrows/${B}/vault/vlt_grafana`,
        body: undefined,
      }),
    );
    expect(await screen.findByText('Removed “Grafana” from your Vault.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('grafana.example.com')).toBeNull());
  });

  it('keeps Remove from Vault closed under Danger', async () => {
    const { user } = await openVault(`/vault?entry=vlt_grafana`);
    const card = within((await screen.findByText('Grafana')).closest('li') as HTMLElement);
    await card.findByRole('radiogroup', { name: 'Neo can use this' });
    expect(card.queryByRole('button', { name: 'Remove from Vault' })).toBeNull();
    await user.click(card.getByRole('button', { name: 'Danger' }));
    expect(card.getByRole('button', { name: 'Remove from Vault' })).toBeTruthy();
  });

  it('adds a home network under the local network switch while it is off, refusing what can’t be listed first', async () => {
    const w = world();
    const user = userEvent.setup();
    renderApp('/settings?tab=agent&part=may', mockedServices(w.fetch));
    const calls = w.calls;
    const lan = await screen.findByRole('switch', { name: 'Neo may reach your local network' });
    // While the whole local network is open the list changes nothing, so it isn't shown.
    expect(screen.queryByRole('heading', { name: 'HOME NETWORK' })).toBeNull();
    await user.click(lan);
    await screen.findByText('192.168.1.0/24');
    expect(screen.getByText(/^When “Neo may reach your local network” is off/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add network' }));
    await user.type(screen.getByLabelText('Network'), '8.8.8.0/24');
    await user.type(screen.getByLabelText('Ports'), '443');
    await user.click(screen.getByRole('button', { name: 'Add network' }));
    expect(await screen.findByText(/^That’s a public network\./)).toBeTruthy();
    expect(calls).toEqual([]);
    await user.clear(screen.getByLabelText('Network'));
    await user.type(screen.getByLabelText('Network'), '10.0.4.7/24');
    await user.clear(screen.getByLabelText('Ports'));
    await user.type(screen.getByLabelText('Ports'), '443, 8443');
    await user.type(screen.getByLabelText('Note'), 'NAS');
    await user.click(screen.getByRole('button', { name: 'Add network' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/vault/networks',
        body: { cidr: '10.0.4.7/24', ports: [443, 8443], note: 'NAS' },
      }),
    );
    expect(await screen.findByText('10.0.4.0/24')).toBeTruthy();
    expect(screen.getByText('Added 10.0.4.0/24 to the home network list.')).toBeTruthy();
  });

  it('shows an old `secret` entry as unused, with no secret, connection or keys, and offers none new (AP-4113)', async () => {
    const { user } = await openVault(`/vault?entry=vlt_weather`);
    const card = (await screen.findByText('Weather API key')).closest('li') as HTMLElement;
    expect(await within(card).findByText('Nothing uses this any more. You can remove it.')).toBeTruthy();
    expect(within(card).queryByText(/PACKS/)).toBeNull();
    expect(within(card).queryByText('AGENTS WITH A KEY')).toBeNull();
    expect(within(card).queryByText('CONNECTION')).toBeNull();
    expect(within(card).queryByRole('button', { name: /^Replace/ })).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Danger' }));
    expect(within(card).getByRole('button', { name: 'Remove from Vault' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add to Vault' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add to Vault' });
    await user.click(within(dialog).getByRole('button', { name: 'Advanced' }));
    expect(within(dialog).queryByRole('option', { name: 'Secret' })).toBeNull();
  });
});

describe('the Vault elsewhere', () => {
  it('shows your line for a Vault event in the audit log, and the Vault chip once there is one', async () => {
    const fresh = world();
    renderApp(`/log`, mockedServices(fresh.fetch));
    await screen.findByRole('heading', { name: 'Audit log' });
    await screen.findAllByRole('button', { name: /^Keys/ });
    // A log without a Vault event keeps the mocked chips.
    expect(screen.queryByRole('button', { name: /^Vault/ })).toBeNull();
    cleanup();

    // An entry switched off for the agent, as the server signs it (the fixture world's own Vault).
    const { user, app, fetch } = await openVault(`/vault`);
    await fetch(`http://whombat.test/api/v1/burrows/${B}/vault/vlt_grafana/key`, { method: 'DELETE' });
    app.history.push(`/log`);
    await screen.findByRole('heading', { name: 'Audit log' });
    // Mara owns the entry: her row names it; the signed text stays neutral in the detail.
    expect(await screen.findByText(/^Switched off “Grafana” for \S+$/)).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: /^Vault/ }));
    await waitFor(() => expect(app.location()).toBe(`/log?kind=vault`));
    expect(await screen.findByText(/^Switched off “Grafana” for \S+$/)).toBeTruthy();
  });
});

describe('Vault form model', () => {
  it('builds the body of each template', () => {
    expect(
      createBody('basic', {
        ...emptyForm('basic'),
        name: 'Printer',
        url: 'http://192.168.1.20',
        username: 'admin',
        secret: 'p',
      }),
    ).toEqual({
      name: 'Printer',
      description: '',
      kind: 'http',
      url: 'http://192.168.1.20',
      auth: { type: 'basic', username: 'admin' },
      secret: 'p',
    });
    expect(
      createBody('mcp', {
        ...emptyForm('mcp'),
        name: 'HA',
        url: 'http://ha.local/api/mcp',
        auth: 'none',
        secret: 'x',
      }),
    ).toEqual({
      name: 'HA',
      description: '',
      kind: 'mcp',
      url: 'http://ha.local/api/mcp',
      auth: { type: 'none' },
    });
    expect(createBody('secret', { ...emptyForm('secret'), name: 'Key', secret: 's' })).toEqual({
      name: 'Key',
      description: '',
      kind: 'secret',
      secret: 's',
    });
  });

  it('refuses what the contract refuses, in plain words', () => {
    expect(formProblems('token', { ...emptyForm('token'), auth: 'header', headerName: 'Host' })).toEqual({
      name: 'Give it a name.',
      url: 'Add the address.',
      'auth.name': 'Host can’t carry a secret.',
      secret: 'Paste the secret.',
    });
    expect(
      formProblems('basic', { ...emptyForm('basic'), name: 'P', url: 'http://192.168.1.20', secret: 'x' }),
    ).toEqual({
      'auth.username': 'Add the username.',
    });
  });

  it('picks the kind from what is typed, and gives an address its scheme', () => {
    expect(guessTemplate({ username: 'admin' })).toBe('login');
    expect(guessTemplate({ username: ' ' })).toBe('token');
    expect(addressUrl('portal.example.com/sign-in')).toBe('https://portal.example.com/sign-in');
    expect(addressUrl('192.168.1.20')).toBe('http://192.168.1.20');
    expect(addressUrl('printer.local:8080')).toBe('http://printer.local:8080');
    expect(addressUrl('http://10.0.0.5')).toBe('http://10.0.0.5');
    // A sign-in the kind doesn't offer becomes the kind's first.
    expect(formFor('login', { ...emptyForm('token'), auth: 'header' }).auth).toBe('form');
    expect(formFor('mcp', { ...emptyForm('mcp'), auth: 'none' }).auth).toBe('none');
  });

  it('reads a ports field', () => {
    expect(parsePorts('80, 8123')).toEqual([80, 8123]);
    expect(parsePorts('80 443')).toEqual([80, 443]);
    expect(parsePorts('')).toBeNull();
    expect(parsePorts('70000')).toBeNull();
    expect(parsePorts('http')).toBeNull();
  });
});

describe('the Vault’s words (less-is-more.md AP-1800)', () => {
  it('names the agent, and says whether it can use an entry (AP-4941)', () => {
    const entry = {
      kind: 'http',
      auth: { type: 'bearer' },
      url: 'https://grafana.example.com',
      agentOn: true,
    } as unknown as Parameters<typeof vaultEntryLine>[0];
    expect(vaultEntryLine(entry, vaultWords('Neo'))).toBe('Sign-in key');
    expect(vaultEntryLine({ ...entry, agentOn: false }, vaultWords('Neo'))).toBe('Sign-in key · off for Neo');
    const neo = vaultWords('Neo');
    expect(neo.intro).toMatch(/^What Neo can sign in to when it works for you\./);
    expect(neo.removeConfirm('Plex')).toContain('Neo can’t use it any more');
  });
});

/** The fixture world: the agent, Neo, holds a key to each of Mara's entries (AP-4006). */
function assistantWorld() {
  return recordingWorld({});
}

async function openAssistantEntry(entryId: string, name: string) {
  const w = assistantWorld();
  const user = userEvent.setup();
  const app = renderApp(`/vault?entry=${entryId}`, mockedServices(w.fetch, {}));
  const card = (await screen.findByText(name)).closest('li') as HTMLElement;
  const entry = within(card);
  const access = await entry.findByRole('radiogroup', { name: 'Neo can use this' });
  return { ...w, user, app, card, entry, access: within(access) };
}

describe('a Vault entry’s one row for the agent (VS-03; AP-4000…AP-4004, AP-4940)', () => {
  it('is on or off for the agent: no picker, no give, no take back', async () => {
    const { entry, access } = await openAssistantEntry('vlt_grafana', 'Grafana');
    expect((access.getByLabelText('On') as HTMLInputElement).checked).toBe(true);
    expect(access.queryByLabelText('Ask me first')).toBeNull();
    expect(entry.getByText('Neo uses it when it works for you, never for anyone else.')).toBeTruthy();
    expect(entry.queryByText('AGENTS WITH A KEY')).toBeNull();
    expect(entry.queryByLabelText('Give a key to…')).toBeNull();
    expect(entry.queryByRole('button', { name: /Give/ })).toBeNull();
    expect(entry.queryByRole('button', { name: /Take back/ })).toBeNull();
    expect(entry.queryByRole('group', { name: 'Neo’s key' })).toBeNull();
    expect(screen.getByText('Sign-in key')).toBeTruthy();
  });

  it('switches Off and On with takeKey and giveKey, on All servers (CT-1240, AP-5240)', async () => {
    const { user, calls, entry, access } = await openAssistantEntry('vlt_grafana', 'Grafana');
    const KEY = `/burrows/${B}/vault/vlt_grafana/key`;
    await user.click(access.getByLabelText('Off'));
    await waitFor(() => expect(calls).toContainEqual({ method: 'DELETE', path: KEY, body: undefined }));
    expect(await entry.findByText('Neo can’t use it.')).toBeTruthy();
    expect((access.getByLabelText('Off') as HTMLInputElement).checked).toBe(true);
    expect(await screen.findByText('Sign-in key · off for Neo')).toBeTruthy();
    await user.click(access.getByLabelText('On'));
    await waitFor(() => expect(calls.at(-1)).toEqual({ method: 'PUT', path: KEY, body: { servers: null } }));
    expect(await entry.findByText('Neo uses it when it works for you, never for anyone else.')).toBeTruthy();
  });

  it('has no row for an old `secret` entry', async () => {
    renderApp('/vault?entry=vlt_weather', mockedServices(assistantWorld().fetch, {}));
    const card = (await screen.findByText('Weather API key')).closest('li') as HTMLElement;
    expect(await within(card).findByText('Nothing uses this any more. You can remove it.')).toBeTruthy();
    expect(within(card).queryByRole('radiogroup', { name: 'Neo can use this' })).toBeNull();
  });

  it('names an API’s variable under Advanced while it is on, and warns after Off that it was in its commands', async () => {
    const { user, calls, entry, access } = await openAssistantEntry('vlt_grafana', 'Grafana');
    const KEY = `/burrows/${B}/vault/vlt_grafana/key`;
    expect(entry.queryByRole('button', { name: /^ENVIRONMENT VARIABLE/ })).toBeNull();
    const advanced = entry.getByRole('button', { name: 'Advanced' });
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    await user.click(advanced);
    await user.click(await entry.findByRole('button', { name: 'ENVIRONMENT VARIABLE: GRAFANA' }));
    const input = entry.getByLabelText('ENVIRONMENT VARIABLE');
    await user.clear(input);
    await user.type(input, 'GRAFANA_TOKEN');
    await user.click(entry.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        path: `${KEY}/env-name`,
        body: { envName: 'GRAFANA_TOKEN' },
      }),
    );
    expect(await entry.findByRole('button', { name: 'ENVIRONMENT VARIABLE: GRAFANA_TOKEN' })).toBeTruthy();
    await user.click(access.getByLabelText('Off'));
    expect(
      await entry.findByText(/^Neo had “Grafana” in its commands and may have kept a copy\./),
    ).toBeTruthy();
    expect(entry.queryByRole('button', { name: /^ENVIRONMENT VARIABLE/ })).toBeNull();
  });
});
