/**
 * What the agent remembers (Whombat hermes-engine.md HE-39; contracts 0.125 CT-1200…CT-1205; AP-5220…AP-5225): the
 * person's own memory and the agent's notes, which the person writes, in one place: Settings → the assistant → Memory
 * (settings-groups.md) — both files with their usage, an entry edited, removed and added, a write the
 * agent got to first, Forget everything under Danger. Against the fixture world (Mara's memory and the notes).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MEMORY_ENTRY_SEPARATOR } from '@whombat/core/domain';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { jsonAnswer, recordingWorld } from '../../test/recordingWorld';
import { mockedServices, renderApp } from '../../test/renderApp';

const B = `/burrows/${burrow.slug}`;
/** Settings → the assistant → Memory: what it remembers about you, then its notes. */
const MEMORY = '/settings?tab=agent&part=memory';

/** The text of the last write's body. */
const lastText = (calls: readonly { body: unknown }[]) =>
  String((calls.at(-1)?.body as { text?: string })?.text);

/** The section, once both files have answered. */
async function memorySection() {
  const section = within(await screen.findByRole('region', { name: 'WHAT NEO REMEMBERS' }));
  await section.findByRole('list', { name: 'About you' });
  return section;
}

describe('Settings → Neo → Memory → What Neo remembers (HE-39; AP-5220…AP-5224)', () => {
  it('shows both files in the contracts’ order, each with its usage and entries', async () => {
    renderApp(MEMORY, mockedServices(recordingWorld().fetch));
    const section = await memorySection();
    const files = [...document.querySelectorAll('[data-memory-file]')].map((f) =>
      f.getAttribute('data-memory-file'),
    );
    expect(files).toEqual(['memory', 'user']);
    expect(section.getByText('What Neo remembers about working with you')).toBeTruthy();
    expect(section.getByText('About you')).toBeTruthy();
    expect(section.getAllByRole('meter')).toHaveLength(2);
    const working = section.getByRole('list', { name: 'What Neo remembers about working with you' });
    expect(within(working).getAllByRole('listitem')).toHaveLength(3);
    // No file names anywhere (concise-replies.md).
    expect(screen.queryByText(/MEMORY\.md|USER\.md/)).toBeNull();
  });

  it('edits, removes and adds an entry, writing the whole file with the version it started from', async () => {
    const { fetch, calls } = recordingWorld();
    const user = userEvent.setup();
    renderApp(MEMORY, mockedServices(fetch));
    const section = await memorySection();
    const about = section.getByRole('list', { name: 'About you' });

    await user.click(within(about).getByRole('button', { name: /^Edit: Prefers short answers/ }));
    const box = section.getByRole('textbox', { name: 'Edit' });
    await user.clear(box);
    await user.type(box, 'Prefers short answers, next step first.');
    await user.click(
      within(document.getElementById('about-you') as HTMLElement).getByRole('button', { name: 'Save' }),
    );
    await waitFor(() => expect(calls.at(-1)?.path).toBe(`${B}/memory/user`));
    const edit = calls.at(-1)?.body as { text: string; ifVersion: string };
    expect(edit.text.split(MEMORY_ENTRY_SEPARATOR)).toContain('Prefers short answers, next step first.');
    expect(edit.ifVersion).toMatch(/^[0-9a-f]{16}$/);

    await user.click(await section.findByRole('button', { name: /^Remove: Prefers short answers/ }));
    await waitFor(() => expect(lastText(calls)).not.toContain('Prefers'));

    await user.type(
      section.getByRole('textbox', { name: 'Something Neo should know about you' }),
      'Takes Fridays off.',
    );
    const [, addUser] = section.getAllByRole('button', { name: 'Add' });
    await user.click(addUser as HTMLElement);
    await waitFor(() => expect(lastText(calls)).toContain('Takes Fridays off.'));
    expect(await section.findByText('Takes Fridays off.')).toBeTruthy();
  });

  it('says so when the agent changed the file meanwhile', async () => {
    const { fetch } = recordingWorld({}, (call, res) =>
      call.method === 'PUT' && call.path.endsWith('/memory/memory')
        ? jsonAnswer({ error: { code: 'conflict', message: 'It changed.' } }, 409)
        : res,
    );
    const user = userEvent.setup();
    renderApp(MEMORY, mockedServices(fetch));
    const section = await memorySection();
    await user.type(
      section.getByRole('textbox', { name: 'Something Neo should remember about working with you' }),
      'The NAS is pve-02.',
    );
    await user.click(section.getAllByRole('button', { name: 'Add' })[0] as HTMLElement);
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /^Neo changed this while you were editing/,
    );
  });

  it('forgets everything after asking', async () => {
    const { fetch, calls } = recordingWorld();
    const user = userEvent.setup();
    renderApp(MEMORY, mockedServices(fetch));
    const section = await memorySection();
    // Forgetting can't be taken back: it waits under Danger.
    expect(section.queryByRole('button', { name: 'Forget everything' })).toBeNull();
    await user.click(section.getByRole('button', { name: 'Danger' }));
    await user.click(section.getByRole('button', { name: 'Forget everything' }));
    const dialog = await screen.findByRole('dialog', { name: 'Forget everything Neo remembers about you?' });
    await user.click(within(dialog).getByRole('button', { name: 'Forget everything' }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: `${B}/memory` }));
    expect(await screen.findByText('Neo no longer remembers anything about you.')).toBeTruthy();
  });
});

describe('Settings → Neo → Memory → Notes (HE-39, CT-1205; AP-5225)', () => {
  it('lets the person change the notes and save them with the save bar', async () => {
    const { fetch, calls } = recordingWorld();
    const user = userEvent.setup();
    renderApp(MEMORY, mockedServices(fetch));
    const box = (await screen.findByRole('textbox', { name: 'NOTES' })) as HTMLTextAreaElement;
    expect(box.value).toMatch(/^Backups run at 02:00/);
    await user.type(box, '\nThe printer is on the second floor.');
    await user.click(
      within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save' }),
    );
    await waitFor(() => expect(calls.at(-1)?.path).toBe(`${B}/agent/notes`));
    expect(lastText(calls)).toContain('second floor');
  });

  it('opens the old Notes address on Memory', async () => {
    const app = renderApp('/settings?tab=agent&part=notes', mockedServices(recordingWorld().fetch));
    expect(await screen.findByRole('textbox', { name: 'NOTES' })).toBeTruthy();
    await waitFor(() => expect(app.location()).toBe(MEMORY));
  });
});
