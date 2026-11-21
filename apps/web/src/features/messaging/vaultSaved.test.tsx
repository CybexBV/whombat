/**
 * What the Vault took from a message (Whombat vault-self-serve.md VS-07, VS-11; AP-4007) against the fixture world, two
 * of Chat's messages given `vaultSaved` and their secret blanked as the runtime sends them: a line per item
 * under the text opening its entry (the saved login, the SSH key a password used once put on a server), `••••••` shown
 * as text, in a thread's first message and in its replies.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VAULT_BLANKED } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { FIRMWARE_THREAD, PVE_THREAD } from '../../app/chatChannelFixtures';
import { pinMockDate } from '../../test/clock';
import { jsonAnswer, recordingWorld } from '../../test/recordingWorld';
import { mockedServices, renderApp } from '../../test/renderApp';

pinMockDate();

/** Mara's firmware question in Chat, and her reply in the pve-02 thread (`chatChannelFixtures.ts`). */
const ROOM_MESSAGE = FIRMWARE_THREAD;
const REPLY = 'msg_chat-pve-2';
const at = '2026-09-23T08:02:00.000Z';

const SAVED = {
  [ROOM_MESSAGE]: {
    text: `Plex is mara@example.com, password ${VAULT_BLANKED}`,
    vaultSaved: [{ entryId: 'vlt_plex', name: 'Plex', kind: 'login', how: 'saved', server: null, at }],
  },
  [REPLY]: {
    text: `The root password of web-2 is ${VAULT_BLANKED}`,
    vaultSaved: [
      { entryId: 'vlt_servers', name: 'Servers', kind: 'ssh', how: 'used_once', server: 'web-2', at },
    ],
  },
} as const;

/** Every message with one of those ids, wherever it is in an answer, as the runtime sends it after the save. */
function withSaved(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSaved);
  if (!value || typeof value !== 'object') return value;
  const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withSaved(v)]));
  const patch = SAVED[(out as { id?: string }).id as keyof typeof SAVED];
  return patch && typeof out.text === 'string' ? { ...out, ...patch } : out;
}

function world() {
  return recordingWorld({}, async (call, res) => {
    if (call.method !== 'GET' || !(res.headers.get('content-type') ?? '').includes('json')) return res;
    return jsonAnswer(withSaved(await res.json()), res.status);
  });
}

describe('a message the Vault took a secret from (AP-4007)', () => {
  it('says so under the text, and a saved login opens its entry', async () => {
    const user = userEvent.setup();
    const app = renderApp('/chat', mockedServices(world().fetch));
    // In its thread: Chat's list shows the first line of a thread only (chat-inbox-web.md).
    await user.click(await screen.findByRole('link', { name: /^Is there new firmware/ }));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    // The message itself (the head says its first line too).
    const row = (await within(pane).findAllByText(/^Plex is mara@example\.com/))
      .map((el) => el.closest('article'))
      .find(Boolean) as HTMLElement;
    expect(within(row).getByText(`Plex is mara@example.com, password ${VAULT_BLANKED}`)).toBeTruthy();
    const link = within(row.querySelector('[data-vault-saved]') as HTMLElement).getByRole('link', {
      name: /Plex/,
    });
    expect(link.getAttribute('href')).toBe('/vault?entry=vlt_plex');
    expect(row.querySelectorAll('[data-vault-saved]')).toHaveLength(1);
    await user.click(link);
    await waitFor(() => expect(app.location()).toBe('/vault?entry=vlt_plex'));
  });

  it('says a password used once in the thread pane, opening the SSH key it put there', async () => {
    renderApp(`/chat?thread=${PVE_THREAD}`, mockedServices(world().fetch));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    const reply = (await within(pane).findByText(/^The root password of web-2/)).closest(
      'article',
    ) as HTMLElement;
    const line = reply.querySelector('[data-vault-saved]') as HTMLElement;
    expect(line.textContent).toContain('web-2');
    expect(within(line).getByRole('link').getAttribute('href')).toBe('/vault?entry=vlt_servers');
  });
});
