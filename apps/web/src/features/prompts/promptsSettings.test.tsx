import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PROMPT_WORDS, SETTINGS_GROUP_TEXT } from '@whombat/client';
import { describe, expect, it } from 'vitest';
import { recordingWorld } from '../../test/recordingWorld';
import { mockedServices, renderApp } from '../../test/renderApp';

const PART = '/settings?part=prompts';

async function rows() {
  const part = await screen.findByTestId('prompts');
  await within(part).findAllByRole('button', { name: /Find what’s broken/ });
  return part;
}

describe('Settings → You → Prompts', () => {
  it('lists the prompts with where they last ran and keeps a new one', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = recordingWorld();
    renderApp(PART, mockedServices(fetch));
    const part = await rows();
    const audit = part.querySelector('[data-prompt-row="starter-audit"]') as HTMLElement;
    expect(audit.textContent).toContain(PROMPT_WORDS.onRepository);
    expect(audit.textContent).toContain('Fusebox');
    // Nothing missing or changed: nothing to bring back.
    expect(within(part).queryByRole('button', { name: PROMPT_WORDS.restore })).toBeNull();

    await user.click(within(part).getByRole('button', { name: PROMPT_WORDS.add }));
    const dialog = await screen.findByRole('dialog', { name: PROMPT_WORDS.add });
    await user.click(within(dialog).getByRole('button', { name: PROMPT_WORDS.save }));
    // An empty title is refused before anything is sent.
    expect(within(dialog).getByRole('alert')).toBeTruthy();
    await user.type(within(dialog).getByLabelText(PROMPT_WORDS.fieldTitle), 'Release notes');
    await user.type(within(dialog).getByLabelText(PROMPT_WORDS.fieldText), 'Write the release notes.');
    // A new prompt starts as for a repository; without it the ownership switch goes.
    expect(within(dialog).getByRole('switch', { name: PROMPT_WORDS.ownIt })).toBeTruthy();
    await user.click(within(dialog).getByRole('switch', { name: PROMPT_WORDS.onRepository }));
    expect(within(dialog).queryByLabelText(PROMPT_WORDS.ownIt)).toBeNull();
    expect(within(dialog).queryByLabelText(PROMPT_WORDS.merge)).toBeNull();
    await user.click(within(dialog).getByRole('switch', { name: PROMPT_WORDS.onRepository }));
    await user.click(within(dialog).getByRole('switch', { name: PROMPT_WORDS.merge }));
    await user.click(within(dialog).getByRole('button', { name: PROMPT_WORDS.save }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const made = calls.find((c) => c.method === 'POST' && c.path.endsWith('/prompts'));
    expect(made?.body).toMatchObject({
      title: 'Release notes',
      onRepository: true,
      ownIt: false,
      merge: true,
      ai: null,
    });
    expect(await within(part).findByRole('button', { name: /Release notes/ })).toBeTruthy();
  });

  it('removes a prompt after asking, then offers Whombat’s back', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = recordingWorld();
    renderApp(PART, mockedServices(fetch));
    const part = await rows();
    await user.click(part.querySelector('[data-prompt-row="starter-bugs"]') as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: PROMPT_WORDS.edit });
    await user.click(within(dialog).getByRole('button', { name: PROMPT_WORDS.remove }));
    expect(within(dialog).getByText(PROMPT_WORDS.removeAsk('Hunt for bugs'))).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: PROMPT_WORDS.remove }));
    await waitFor(() => expect(part.querySelector('[data-prompt-row="starter-bugs"]')).toBeNull());
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/prompts/starter-bugs'))).toBe(true);

    await user.click(await within(part).findByRole('button', { name: PROMPT_WORDS.restore }));
    await waitFor(() => expect(part.querySelector('[data-prompt-row="starter-bugs"]')).toBeTruthy());
    expect(within(part).queryByRole('button', { name: PROMPT_WORDS.restore })).toBeNull();
  });

  it('shows no Prompts on a Whombat that doesn’t have them, and none after `/` in Chat', async () => {
    const user = userEvent.setup();
    const { fetch } = recordingWorld({ prompts: { available: false } });
    renderApp('/settings?part=profile', mockedServices(fetch));
    await screen.findByRole('radio', { name: SETTINGS_GROUP_TEXT.you.profile });
    await waitFor(() =>
      expect(screen.queryByRole('radio', { name: SETTINGS_GROUP_TEXT.you.prompts })).toBeNull(),
    );
    expect(screen.queryByRole('alert')).toBeNull();

    renderApp('/chat?new=1', mockedServices(fetch));
    const box = await screen.findByRole('textbox', { name: /anything/ });
    await user.type(box, '/');
    await screen.findByRole('listbox', { name: 'Skills' });
    expect(screen.queryByText(PROMPT_WORDS.group)).toBeNull();
  });
});

describe('Save as prompt', () => {
  it('keeps the person’s own message as a prompt from its menu', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = recordingWorld();
    renderApp('/chat', mockedServices(fetch));
    // In the thread of a question of hers (Chat's list has no menus, chat-inbox-web.md).
    await user.click(await screen.findByRole('link', { name: /^Is there new firmware/ }));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    const more = await within(pane).findAllByRole('button', { name: 'More actions for your message' });
    await user.click(more[0] as HTMLElement);
    const menu = await screen.findByRole('menu', { name: 'Message actions' });
    await user.click(within(menu).getByRole('menuitem', { name: PROMPT_WORDS.saveFromMessage }));
    const dialog = await screen.findByRole('dialog', { name: PROMPT_WORDS.add });
    const title = within(dialog).getByLabelText(PROMPT_WORDS.fieldTitle) as HTMLInputElement;
    const text = within(dialog).getByLabelText(PROMPT_WORDS.fieldText) as HTMLTextAreaElement;
    expect(title.value.length).toBeGreaterThan(0);
    expect(text.value.startsWith(title.value.replace(/…$/, ''))).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: PROMPT_WORDS.save }));
    expect(await screen.findByText(PROMPT_WORDS.saved)).toBeTruthy();
    const made = calls.find((c) => c.method === 'POST' && c.path.endsWith('/prompts'));
    expect(made?.body).toMatchObject({ text: text.value, onRepository: false });
  });
});

describe('using a prompt in Chat', () => {
  it('posts it on the chosen repository and opens its thread', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = recordingWorld();
    const { location } = renderApp('/chat?new=1', mockedServices(fetch));
    const box = await screen.findByRole('textbox', { name: /anything/ });
    await user.type(box, '/find');
    await screen.findByRole('group', { name: PROMPT_WORDS.group });
    await user.keyboard('{Enter}');
    await screen.findAllByRole('option', { name: /Fusebox/ });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(location()).toContain('thread='));
    const used = calls.find((c) => c.path.endsWith('/prompts/starter-audit/use'));
    expect(used?.body).toMatchObject({ project: { id: 'prj_fusebox', title: 'Fusebox' } });
    expect((used?.body as { conversationId?: string } | undefined)?.conversationId).toMatch(/^cnv_/);
  });
});
