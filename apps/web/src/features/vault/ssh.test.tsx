/**
 * SSH keys in the Vault (docs/decisions/vault.md VT-S02…VT-S13; AP-598…AP-604) against the fixture world with the
 * shared fixtures' “Deploy key” (`vaultSshDeployKey`: web-1 trusted and signed in, staging waiting for trust; the agent,
 * Neo, on All servers): Add to Vault's server key, KEY with the `authorized_keys` line and a new key under Technical
 * details, SERVERS with Check, Edit, Remove and the trust question, the agent's one row, RECENT USE and your
 * audit line.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { queryKeys } from '@whombat/client/query';
import type { VaultGetResponse } from '@whombat/core/contracts';
import { vaultAuditDetailText, vaultAuditText } from '@whombat/core/vault';
import {
  burrow,
  FIXTURE_SSH_FINGERPRINT,
  FIXTURE_SSH_HOST_KEY,
  FIXTURE_SSH_PUBLIC_KEY,
  vaultSshDeployKey,
} from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { pinMockDate } from '../../test/clock';
import { recordingWorld } from '../../test/recordingWorld';
import { mockedServices, renderApp } from '../../test/renderApp';
import {
  createBody,
  emptyForm,
  formProblems,
  replaceKeyProblems,
  serverChanges,
  serverFormOf,
  serverProblems,
  sshKeyFields,
} from './model';

pinMockDate();

const B = burrow.slug;
const ENTRY = `/burrows/${B}/vault/vlt_deploykey`;

/** TEST ONLY: the throwaway ed25519 pair behind `FIXTURE_SSH_PUBLIC_KEY` (contracts' own test key; nothing trusts it). */
const TEST_PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCwZq1awEVKk2HwcTa8vgxxCflRpEQLH1vItHbhu28L+QAAAIibQrhum0K4
bgAAAAtzc2gtZWQyNTUxOQAAACCwZq1awEVKk2HwcTa8vgxxCflRpEQLH1vItHbhu28L+Q
AAAECq5lZhxOthCAsMc3+7yD+sGL5dQ6MnR2zxpf5kgTmIdrBmrVrARUqTYfBxNry+DHEJ
+VGkRAsfW8i0duG7bwv5AAAABHRlc3QB
-----END OPENSSH PRIVATE KEY-----
`;

/** The fixture world with the SSH key, every Vault write recorded (method, path, body). */
function world() {
  const base = createWebFixtureFetch({ vaultSsh: true });
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

async function openEntry() {
  const w = world();
  const user = userEvent.setup();
  const app = renderApp(`/vault?entry=vlt_deploykey`, mockedServices(w.fetch));
  const card = (await screen.findByText('Deploy key')).closest('li') as HTMLElement;
  const entry = within(card);
  await entry.findByRole('heading', { name: 'KEY' });
  return { ...w, user, app, card, entry };
}

/** Opens the KEY block's Technical details. */
async function openKeyDetails(user: ReturnType<typeof userEvent.setup>, card: HTMLElement) {
  const block = card.querySelector('[data-block="ssh-key"]') as HTMLElement;
  await user.click(within(block).getByRole('button', { name: 'Technical details' }));
  return within(block);
}

describe('The Vault, an SSH key', () => {
  it('lists the key as a server key, with its servers on a quieter line and no algorithm', async () => {
    const w = world();
    const user = userEvent.setup();
    renderApp(`/vault`, mockedServices(w.fetch));
    const row = (await screen.findByText('Deploy key')).closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { expanded: false }));
    expect(await screen.findByText('Server key')).toBeTruthy();
    expect(screen.getByText('2 servers')).toBeTruthy();
    expect(screen.queryByText(/ED25519/)).toBeNull();
  });

  it('keeps the authorized_keys line and the fingerprint under Technical details, with the servers, the agent’s row and RECENT USE', async () => {
    const { user, card, entry } = await openEntry();
    // The default path has no cryptography: one sentence about the key, and how a server gets it by asking.
    expect(entry.getByText(/^Whombat made this key/)).toBeTruthy();
    expect(entry.getByText(/^To add a server, ask Neo in your chat/)).toBeTruthy();
    expect(entry.queryByText(/authorized_keys/)).toBeNull();
    expect(entry.queryByText(FIXTURE_SSH_FINGERPRINT)).toBeNull();
    expect(entry.queryByRole('button', { name: 'Generate a new key' })).toBeNull();
    const key = await openKeyDetails(user, card);
    expect(key.getByText(/~\/\.ssh\/authorized_keys/)).toBeTruthy();
    expect(key.getByText(`restrict ${FIXTURE_SSH_PUBLIC_KEY} whombat-zrrdkikb`)).toBeTruthy();
    expect(key.getByText(FIXTURE_SSH_FINGERPRINT)).toBeTruthy();
    expect(key.getByText('ED25519 · made by Whombat · added 5 days ago')).toBeTruthy();
    expect(key.getByRole('button', { name: 'Copy' })).toBeTruthy();
    // No secret to replace and no connection to check: the key has its own buttons.
    expect(entry.queryByRole('heading', { name: 'SECRET' })).toBeNull();
    expect(entry.queryByRole('heading', { name: 'CONNECTION' })).toBeNull();

    const servers = entry.getByRole('list', { name: 'SERVERS' });
    const rows = within(servers).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('[aria-live]')?.textContent)).toEqual([
      'Checked 1 hour ago · Signed in as deploy',
      'Checked 1 hour ago · Not trusted yet',
    ]);
    expect(within(rows[0] as HTMLElement).getByText('deploy@web1.example.com:22')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByLabelText('Reached')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByLabelText('Not checked yet')).toBeTruthy();
    // Only staging waits for trust: one question in words, the fingerprint folded until asked for.
    expect(within(rows[0] as HTMLElement).queryByRole('button', { name: 'Yes, trust it' })).toBeNull();
    const trust = within(
      within(rows[1] as HTMLElement).getByRole('region', {
        name: 'Is staging the server at staging.example.com?',
      }),
    );
    expect(trust.getByRole('button', { name: 'Yes, trust it' })).toBeTruthy();
    expect(trust.queryByText(FIXTURE_SSH_HOST_KEY.fingerprint, { exact: false })).toBeNull();
    await user.click(trust.getByRole('button', { name: 'Technical details' }));
    expect(trust.getByText(`${FIXTURE_SSH_HOST_KEY.fingerprint} (ED25519).`)).toBeTruthy();
    expect(trust.getByText('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')).toBeTruthy();

    expect(entry.getByRole('radiogroup', { name: 'Neo can use this' })).toBeTruthy();
    expect(entry.queryByRole('list', { name: 'AGENTS WITH A KEY' })).toBeNull();

    const uses = entry.getByRole('list', { name: 'RECENT USE' });
    expect([...uses.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Neo · in Neo’s commands for this turn · done10:05',
    ]);
  });

  it('trusts a server’s host key with the fingerprint shown, and signs in', async () => {
    const { user, entry, calls } = await openEntry();
    await user.click(entry.getByRole('button', { name: 'Yes, trust it' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: `${ENTRY}/servers/vss_staging/trust`,
        body: { fingerprint: FIXTURE_SSH_HOST_KEY.fingerprint },
      }),
    );
    expect(await screen.findByText('Trusted staging. Signed in as deploy')).toBeTruthy();
    await waitFor(() => expect(entry.queryByRole('button', { name: 'Yes, trust it' })).toBeNull());
  });

  it('asks about a changed host key on the failing edge, with the key trusted until now under Technical details', async () => {
    const { user, app, entry } = await openEntry();
    const key = queryKeys.vault.get({ params: { burrow: B, entryId: 'vlt_deploykey' } });
    act(() => {
      app.services.queryClient.setQueryData<VaultGetResponse>(key, (d) =>
        d
          ? {
              ...d,
              entry: {
                ...d.entry,
                servers: d.entry.servers.map((s) =>
                  s.name === 'web-1'
                    ? {
                        ...s,
                        seenHostKey: {
                          algorithm: 'ecdsa-sha2-nistp256',
                          fingerprint: 'SHA256:Qm3Yx0bq9tWcVnK2f7JrLd1hP8sZu6aE4iTgNoC5vXw',
                          seenAt: '2026-09-23T09:50:00.000Z',
                        },
                        check: {
                          status: 'failing' as const,
                          outcome: 'host_key_changed' as const,
                          summary: 'This server’s host key changed. Check it before agents use it again.',
                          checkedAt: '2026-09-23T09:50:00.000Z',
                        },
                      }
                    : s,
                ),
              },
            }
          : d,
      );
    });
    const row = (await entry.findByText('web-1')).closest('li') as HTMLElement;
    // Stored with the words of before, it reads in today's.
    expect(
      within(row).getByText(/^Checked .+ · It doesn’t look like the same server any more\./),
    ).toBeTruthy();
    expect(within(row).getByLabelText('Failing')).toBeTruthy();
    // A changed key speaks of the change, not of a first trust (AP-4005).
    const card = within(row).getByRole('region', { name: /^web-1 at web1\.example\.com doesn’t look like/ });
    expect(card.dataset.tone).toBe('bad');
    expect(within(card).getByRole('button', { name: 'Yes, trust it' })).toBeTruthy();
    expect(within(card).queryByText(/SHA256/)).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Technical details' }));
    expect(
      within(card).getByText('SHA256:Qm3Yx0bq9tWcVnK2f7JrLd1hP8sZu6aE4iTgNoC5vXw (ECDSA).', { exact: false }),
    ).toBeTruthy();
    expect(within(card).getByText('ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub')).toBeTruthy();
    expect(
      within(card).getByText(`Trusted until now: ${FIXTURE_SSH_HOST_KEY.fingerprint} (ED25519)`),
    ).toBeTruthy();
  });

  it('adds a server, checks it at once, and refuses a bad name before sending', async () => {
    const { user, entry, calls } = await openEntry();
    await user.click(entry.getByRole('button', { name: 'Add server' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add server' }));
    expect(dialog.getByText('The agent uses this name, like web-1.')).toBeTruthy();
    expect((dialog.getByLabelText('Port') as HTMLInputElement).value).toBe('22');
    expect(
      dialog.getByText('Servers on the internet: port 22. On your network: 192.168.1.0/24 · ports 80, 8123.'),
    ).toBeTruthy();
    await user.type(dialog.getByLabelText('Name'), 'Web 2');
    await user.type(dialog.getByLabelText('Host'), 'not a host');
    await user.click(dialog.getByRole('button', { name: 'Add server' }));
    expect(
      dialog.getByText(
        'Use 1–40 letters, digits, dots, dashes and underscores, starting with a letter or digit.',
      ),
    ).toBeTruthy();
    expect(
      dialog.getByText(
        'That isn’t a host name or IP address. Write it like web1.example.com or 192.168.1.10.',
      ),
    ).toBeTruthy();
    expect(
      dialog.getByText(
        'Use 1–32 letters, digits, dots, dashes and underscores, starting with a letter or underscore.',
      ),
    ).toBeTruthy();
    expect(calls).toEqual([]);

    await user.clear(dialog.getByLabelText('Name'));
    await user.type(dialog.getByLabelText('Name'), 'web-2');
    await user.clear(dialog.getByLabelText('Host'));
    await user.type(dialog.getByLabelText('Host'), 'web2.example.com');
    await user.type(dialog.getByLabelText('Username'), 'deploy');
    await user.click(dialog.getByRole('button', { name: 'Add server' }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: 'POST',
          path: `${ENTRY}/servers`,
          // The form always has Production (off by default).
          body: { name: 'web-2', host: 'web2.example.com', port: 22, username: 'deploy', production: false },
        },
        expect.objectContaining({ method: 'POST', path: expect.stringMatching(/\/servers\/vss_.+\/check$/) }),
      ]),
    );
    expect(await screen.findByText('Added web-2. Not trusted yet')).toBeTruthy();
    const row = (await entry.findByText('web-2')).closest('li') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Yes, trust it' })).toBeTruthy();
  });

  it('says a taken name under Name', async () => {
    const { user, entry } = await openEntry();
    await user.click(entry.getByRole('button', { name: 'Add server' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add server' }));
    await user.type(dialog.getByLabelText('Name'), 'web-1');
    await user.type(dialog.getByLabelText('Host'), 'web9.example.com');
    await user.type(dialog.getByLabelText('Username'), 'deploy');
    await user.click(dialog.getByRole('button', { name: 'Add server' }));
    expect(await dialog.findByText('This key already has a server with that name.')).toBeTruthy();
  });

  it('edits a server with only what changed; a new port warns, and a refused one says why under Host', async () => {
    const { user, entry, calls } = await openEntry();
    await user.click(entry.getByRole('button', { name: 'Edit web-1' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Edit server' }));
    expect(dialog.queryByText('Changing the host or port forgets its trusted host key.')).toBeNull();
    await user.clear(dialog.getByLabelText('Port'));
    await user.type(dialog.getByLabelText('Port'), '2222');
    expect(dialog.getByText('Changing the host or port forgets its trusted host key.')).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PATCH',
        path: `${ENTRY}/servers/vss_web1`,
        body: { port: 2222 },
      }),
    );
    // A public server on a port the Whombat doesn't open (VT-S06): the destination rule's sentence, under Host.
    const host = dialog.getByLabelText('Host');
    await waitFor(() => expect(host.getAttribute('aria-invalid')).toBe('true'));
    expect(dialog.getByText(/port 22 only/)).toBeTruthy();

    await user.clear(dialog.getByLabelText('Port'));
    await user.type(dialog.getByLabelText('Port'), '22');
    await user.clear(dialog.getByLabelText('Username'));
    await user.type(dialog.getByLabelText('Username'), 'backup');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PATCH',
        path: `${ENTRY}/servers/vss_web1`,
        body: { username: 'backup' },
      }),
    );
    expect(await entry.findByText('backup@web1.example.com:22')).toBeTruthy();
  });

  it('checks and removes a server after asking', async () => {
    const { user, entry, calls } = await openEntry();
    await user.click(entry.getByRole('button', { name: 'Check web-1' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: `${ENTRY}/servers/vss_web1/check`,
        body: undefined,
      }),
    );
    expect(await entry.findByText('Checked just now · Signed in as deploy')).toBeTruthy();

    await user.click(entry.getByRole('button', { name: 'Remove staging' }));
    expect(
      entry.getByText('Remove this server? The agent can’t reach it with this key any more.'),
    ).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    const row = entry
      .getByText('Remove this server? The agent can’t reach it with this key any more.')
      .closest('li');
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'DELETE',
        path: `${ENTRY}/servers/vss_staging`,
        body: undefined,
      }),
    );
    expect(await screen.findByText('Removed staging.')).toBeTruthy();
    await waitFor(() => expect(entry.queryByText('staging.example.com', { exact: false })).toBeNull());
  });

  it('generates a new key after saying the old one stops working everywhere', async () => {
    const { user, card, calls } = await openEntry();
    const key = await openKeyDetails(user, card);
    await user.click(key.getByRole('button', { name: 'Generate a new key' }));
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Generate a new key for “Deploy key”?' }),
    );
    expect(
      dialog.getByText(
        'The old key stops working on every server at once. The servers and their host keys stay.',
      ),
    ).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: 'Generate a new key' }));
    await waitFor(() =>
      expect(calls).toContainEqual({ method: 'POST', path: `${ENTRY}/ssh-key/generate`, body: undefined }),
    );
    expect(await screen.findByText(/^New key made\./)).toBeTruthy();
  });

  it('replaces the key with your own, refusing a public key before sending', async () => {
    const { user, card, entry, calls } = await openEntry();
    const key = await openKeyDetails(user, card);
    await user.click(key.getByRole('button', { name: 'Replace with my own key' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Replace the key of “Deploy key”?' }));
    await user.click(dialog.getByLabelText('Private key'));
    await user.paste(FIXTURE_SSH_PUBLIC_KEY);
    await user.click(dialog.getByRole('button', { name: 'Replace the key' }));
    expect(
      dialog.getByText('That’s the public key. Paste the private key: the file without .pub.'),
    ).toBeTruthy();
    expect(calls).toEqual([]);
    await user.clear(dialog.getByLabelText('Private key'));
    await user.click(dialog.getByLabelText('Private key'));
    await user.paste(TEST_PRIVATE_KEY);
    expect((dialog.getByLabelText('Passphrase (if it has one)') as HTMLInputElement).type).toBe('password');
    await user.click(dialog.getByRole('button', { name: 'Replace the key' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        path: `${ENTRY}/ssh-key`,
        body: { privateKey: TEST_PRIVATE_KEY },
      }),
    );
    expect(await screen.findByText(/^Key replaced\./)).toBeTruthy();
    expect(await entry.findByText('ED25519 · your own key · replaced just now')).toBeTruthy();
    expect(entry.getByText(/^Your own key/)).toBeTruthy();
  });
});

describe('the agent’s row on an SSH key (VS-03; AP-4002)', () => {
  it('has no servers chooser: a key from before on some servers says so, and a change covers All servers', async () => {
    const w = recordingWorld({ vaultSsh: true });
    const user = userEvent.setup();
    const app = renderApp(`/vault?entry=vlt_deploykey`, mockedServices(w.fetch, {}));
    const card = (await screen.findByText('Deploy key')).closest('li') as HTMLElement;
    const entry = within(card);
    const access = within(await entry.findByRole('radiogroup', { name: 'Neo can use this' }));
    expect(entry.queryByRole('button', { name: /^Servers/ })).toBeNull();
    expect(entry.queryByText(/^Servers · /)).toBeNull();
    const key = queryKeys.vault.get({ params: { burrow: B, entryId: 'vlt_deploykey' } });
    act(() => {
      app.services.queryClient.setQueryData<VaultGetResponse>(key, (d) =>
        d
          ? {
              ...d,
              entry: {
                ...d.entry,
                key: d.entry.key ? { ...d.entry.key, servers: ['vss_staging'] } : null,
              },
            }
          : d,
      );
    });
    expect(await entry.findByText('Servers · staging')).toBeTruthy();
    await user.click(access.getByLabelText('Off'));
    await waitFor(() =>
      expect(w.calls).toContainEqual(expect.objectContaining({ method: 'DELETE', path: `${ENTRY}/key` })),
    );
    await user.click(access.getByLabelText('On'));
    await waitFor(() =>
      expect(w.calls).toContainEqual({ method: 'PUT', path: `${ENTRY}/key`, body: { servers: null } }),
    );
    await waitFor(() => expect(entry.queryByText('Servers · staging')).toBeNull());
  });
});

describe('Add to Vault → a server key', () => {
  it('makes a new key when Advanced chooses a server key, without a check, and opens it on its servers', async () => {
    const w = world();
    const user = userEvent.setup();
    const app = renderApp(`/vault`, mockedServices(w.fetch));
    await user.click(await screen.findByRole('button', { name: 'Add to Vault' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add to Vault' }));
    // The kind is chosen under Advanced only.
    expect(dialog.queryByLabelText('Kind')).toBeNull();
    await user.click(dialog.getByRole('button', { name: 'Advanced' }));
    await user.selectOptions(dialog.getByLabelText('Kind'), 'ssh');
    expect(dialog.queryByLabelText('Address')).toBeNull();
    expect(dialog.getByText(/^Whombat makes the key\./)).toBeTruthy();
    expect(dialog.queryByLabelText('Private key')).toBeNull();
    await user.type(dialog.getByLabelText('What it’s for'), 'Backups');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(w.calls).toEqual([
        {
          method: 'POST',
          path: `/burrows/${B}/vault`,
          body: { name: 'Backups', description: '', kind: 'ssh', sshKey: { mode: 'generate' } },
        },
      ]),
    );
    expect(await screen.findByText('Added “Backups” to your Vault.')).toBeTruthy();
    await waitFor(() => expect(app.location()).toMatch(/entry=vlt_/));
    expect(await screen.findByText('No servers yet. Add the servers this key signs in to.')).toBeTruthy();
  });

  it('imports your key, and refuses what isn’t a private key before sending', async () => {
    const w = world();
    const user = userEvent.setup();
    renderApp(`/vault`, mockedServices(w.fetch));
    await user.click(await screen.findByRole('button', { name: 'Add to Vault' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add to Vault' }));
    await user.click(dialog.getByRole('button', { name: 'Paste a server key instead' }));
    expect(screen.getByRole('dialog').querySelector('[data-saved-as="ssh"]')).toBeTruthy();
    await user.type(dialog.getByLabelText('What it’s for'), 'Mine');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect(dialog.getByText('Paste the private key.')).toBeTruthy();
    await user.click(dialog.getByLabelText('Private key'));
    await user.paste('hello');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect(
      dialog.getByText(
        'That isn’t a private key. Paste the whole file, from -----BEGIN to the -----END line, like ~/.ssh/id_ed25519.',
      ),
    ).toBeTruthy();
    expect(w.calls).toEqual([]);
    await user.clear(dialog.getByLabelText('Private key'));
    await user.click(dialog.getByLabelText('Private key'));
    await user.paste(TEST_PRIVATE_KEY);
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(w.calls).toContainEqual({
        method: 'POST',
        path: `/burrows/${B}/vault`,
        body: {
          name: 'Mine',
          description: '',
          kind: 'ssh',
          sshKey: { mode: 'import', privateKey: TEST_PRIVATE_KEY },
        },
      }),
    );
    expect(await screen.findByText('Added “Mine” to your Vault.')).toBeTruthy();
  });
});

describe('an SSH key in the audit log', () => {
  it('shows your line for an SSH command in the audit log', async () => {
    const w = world();
    const user = userEvent.setup();
    const app = renderApp(`/vault?entry=vlt_deploykey`, mockedServices(w.fetch));
    const card = (await screen.findByText('Deploy key')).closest('li') as HTMLElement;
    await user.click(await within(card).findByRole('button', { name: 'Remove staging' }));
    const row = within(card)
      .getByText('Remove this server? The agent can’t reach it with this key any more.')
      .closest('li');
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Remove' }));
    await screen.findByText('Removed staging.');
    app.history.push(`/log?kind=vault`);
    await screen.findByRole('heading', { name: 'Audit log' });
    expect(await screen.findByText('Changed “Deploy key”')).toBeTruthy();
    // An agent's command reads as recorded (VT-S11): the server, the command, how it ended.
    expect(
      vaultAuditDetailText({
        text: vaultAuditText('used'),
        vault: {
          entryId: 'vlt_deploykey',
          entryName: 'Deploy key',
          what: 'ssh web-1 · systemctl status nginx',
          outcome: 'done',
        },
      }),
    ).toBe('Used “Deploy key” · ssh web-1 · systemctl status nginx · done');
  });
});

describe('SSH key model', () => {
  it('builds the create body for each way to get the key', () => {
    const form = { ...emptyForm('ssh'), name: ' Deploy key ' };
    expect(createBody('ssh', form)).toEqual({
      name: 'Deploy key',
      description: '',
      kind: 'ssh',
      sshKey: { mode: 'generate' },
    });
    expect(
      createBody('ssh', { ...form, sshMode: 'import', privateKey: TEST_PRIVATE_KEY, passphrase: 'pw' }),
    ).toEqual({
      name: 'Deploy key',
      description: '',
      kind: 'ssh',
      sshKey: { mode: 'import', privateKey: TEST_PRIVATE_KEY, passphrase: 'pw' },
    });
    expect(sshKeyFields(formProblems('ssh', { ...form, sshMode: 'import' }))).toEqual({
      privateKey: 'Paste the private key.',
    });
    expect(replaceKeyProblems(TEST_PRIVATE_KEY, '')).toEqual({});
  });

  it('reads a server form and its changes', () => {
    const web1 = vaultSshDeployKey.servers[0];
    if (!web1) throw new Error('fixture');
    const form = (f: { name: string; host: string; port: string; username: string }) => ({
      ...f,
      production: false,
    });
    expect(
      serverProblems(form({ name: 'web-2', host: '[2001:db8::7]', port: '', username: 'deploy' })),
    ).toEqual({});
    // A name, not a host: capitals are fine (CT-319, AP-949).
    expect(
      serverProblems(form({ name: 'PVE-01', host: '192.168.1.10', port: '22', username: 'root' })),
    ).toEqual({});
    expect(
      serverProblems(form({ name: 'web-2', host: 'web2.example.com', port: '70000', username: 'deploy' })),
    ).toEqual({ port: 'Use a port between 1 and 65535.' });
    expect(serverChanges(web1, serverFormOf(web1))).toBeNull();
    expect(serverChanges(web1, { ...serverFormOf(web1), username: 'backup' })).toEqual({
      username: 'backup',
    });
  });
});
