/**
 * Settings → the assistant → Name and face (Whombat one-agent.md OA-08, OA-09; app one-agent.md AP-4923, AP-4924): the
 * name with Save, the refusals under the field, the five faces, the name everywhere after a rename, and your own
 * Suggestions from the agent. The fixture world's agent is Neo with Neo's face.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { agentFaceStyle, agentWords } from '@whombat/client';
import type { Preferences } from '@whombat/core';
import { AGENT_NAME_FORM_TEXT, AGENT_NAME_RESERVED_TEXT } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { createWebFixtureFetch } from '../../../app/fixtureFetch';
import { fixtureServices, mockedServices, renderApp } from '../../../test/renderApp';
import { agentNameProblem } from './ProfileTab';

const card = async () =>
  (await screen.findByLabelText('NAME')).closest('[data-agent-profile]') as HTMLElement;

describe('Settings → the assistant → Name and face (AP-4924)', () => {
  it('shows the agent’s name and face, with the five faces to pick from', async () => {
    renderApp('/settings?tab=agent', fixtureServices({}));
    const c = await card();
    expect((within(c).getByLabelText('NAME') as HTMLInputElement).value).toBe('Neo');
    // The part is the assistant's Name and face (agent-voices.md AP-5500; settings-groups.md).
    expect(c.closest('[data-agent-part]')?.getAttribute('aria-label')).toBe('Name and face');
    const faces = within(c).getByRole('radiogroup', { name: 'Character' });
    expect(within(faces).getAllByRole('radio')).toHaveLength(5);
    expect((within(faces).getByRole('radio', { name: 'Neo’s face' }) as HTMLInputElement).checked).toBe(true);
    // How the picked character talks, read with the group (agent-voices.md AP-5501).
    expect(styleLine(faces)?.textContent).toBe(`Neo · ${agentFaceStyle('neo')}`);
    expect(styleLine(faces)?.getAttribute('aria-live')).toBe('polite');
    // No name pool: nothing suggests a name.
    expect(within(c).queryByRole('button', { name: 'Suggest a name' })).toBeNull();
  });

  it('renames on Save, and the name is everywhere at once', async () => {
    const user = userEvent.setup();
    renderApp('/settings?tab=agent', fixtureServices({}));
    const c = await card();
    const field = within(c).getByLabelText('NAME') as HTMLInputElement;
    const save = within(c).getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(true);
    await user.clear(field);
    await user.type(field, 'Rex');
    await user.click(save);
    expect(await screen.findByText(/is now called Rex\.$/)).toBeTruthy();
    // The page's own words say it at once.
    expect(await screen.findByText(/^How Rex looks and talks\./)).toBeTruthy();
  });

  it('says why a name can’t be saved, under the field', async () => {
    const user = userEvent.setup();
    renderApp('/settings?tab=agent', fixtureServices({}));
    const c = await card();
    const field = within(c).getByLabelText('NAME');
    await user.clear(field);
    await user.type(field, 'Whombat');
    await user.click(within(c).getByRole('button', { name: 'Save' }));
    expect((await within(c).findByRole('alert')).textContent).toBe(AGENT_NAME_RESERVED_TEXT);
    expect(field.getAttribute('aria-invalid')).toBe('true');
  });

  it('saves another character and keeps the name: a pick sends only the face (AP-5503)', async () => {
    const user = userEvent.setup();
    const { services, updates } = world({});
    renderApp('/settings?tab=agent', services);
    const c = await card();
    const faces = within(c).getByRole('radiogroup', { name: 'Character' });
    await user.click(within(c).getByRole('radio', { name: 'Hazel’s face' }));
    // The line follows the pick at once.
    expect(styleLine(faces)?.textContent).toBe(`Hazel · ${agentFaceStyle('hazel')}`);
    expect(await screen.findByText(agentWords('Neo').newFace, undefined, { timeout: 3000 })).toBeTruthy();
    await waitFor(() =>
      expect((within(c).getByRole('radio', { name: 'Hazel’s face' }) as HTMLInputElement).checked).toBe(true),
    );
    expect(updates).toEqual([{ face: 'hazel' }]);
    expect((within(c).getByLabelText('NAME') as HTMLInputElement).value).toBe('Neo');
  });

  it('checks a name’s form before asking the server, and no other agent holds one', () => {
    expect(agentNameProblem('whombat')).toBe(AGENT_NAME_RESERVED_TEXT);
    expect(agentNameProblem('rex')).toBe(AGENT_NAME_FORM_TEXT);
    expect(agentNameProblem('Two words')).toBe(AGENT_NAME_FORM_TEXT);
    expect(agentNameProblem('Dusty')).toBeNull();
  });
});

/** The fixture world with its preferences; records every preferences PATCH and every `agent.update` body. */
function world(preferences: Partial<Preferences>) {
  const base = createWebFixtureFetch({ preferences });
  const patches: unknown[] = [];
  const updates: unknown[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const req = new Request(url, input instanceof Request ? input : init);
    if (req.method === 'PATCH' && url.pathname.endsWith('/me/preferences'))
      patches.push(await req.clone().json());
    if (req.method === 'PATCH' && url.pathname.endsWith('/agent')) updates.push(await req.clone().json());
    return base(req);
  };
  return { services: mockedServices(fetch as typeof globalThis.fetch), patches, updates };
}

/** The line under the faces that says how the picked character talks: the group's last description. */
function styleLine(group: HTMLElement): HTMLElement | null {
  const ids = (group.getAttribute('aria-describedby') ?? '').split(' ');
  return document.getElementById(ids[ids.length - 1] ?? '');
}

describe('Suggestions from the agent (assistant-guides.md AG-12)', () => {
  it('resets “Don’t ask again” when there is something to reset', async () => {
    const user = userEvent.setup();
    const { services, patches } = world({ assistant: { suggestions: true, dontAsk: ['email', 'briefing'] } });
    renderApp('/settings?tab=agent', services);
    const row = (await screen.findByRole('switch', { name: 'Suggestions from Neo' })).closest('div');
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Reset ‘Don’t ask again’' }));
    await waitFor(() => expect(patches).toEqual([{ assistant: { suggestions: true, dontAsk: [] } }]));
    expect(await screen.findByText('Reset. Neo may suggest those again.')).toBeTruthy();
  });
});
