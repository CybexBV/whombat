import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PROMPT_WORDS } from '@whombat/client';
import type { Prompt, PromptProject } from '@whombat/core';
import { mara, PRINCIPALS } from '@whombat/fixtures';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Composer, type ComposerPrompts } from '../messaging/Composer';
import type { SkillCommand } from '../messaging/model';
import type { PromptProjectsState } from './usePrompts';

const prompt = (id: string, title: string, extra: Partial<Prompt> = {}): Prompt => ({
  id,
  title,
  text: `${title}: the words.\nSecond line.`,
  onRepository: true,
  ownIt: false,
  merge: false,
  ai: null,
  starter: false,
  edited: false,
  runs: [],
  updatedAt: null,
  ...extra,
});

const PROMPTS = [
  prompt('starter-audit', 'Find what’s broken', {
    runs: [
      { projectId: 'p-tracker', title: 'Acme Desk', at: new Date(Date.now() - 2 * 86_400_000).toISOString() },
    ],
  }),
  prompt('prm_weeklyxxxxxx', 'Weekly summary', { onRepository: false }),
];
const PROJECTS: PromptProject[] = [
  { id: 'p-fusebox', title: 'Fusebox', folder: '~/Code/fusebox' },
  { id: 'p-tracker', title: 'Acme Desk', folder: null },
];
const SKILLS: SkillCommand[] = [
  { name: 'pdf', description: 'Read a PDF', agentId: 'prn_a', agentName: 'Neo', insert: '/pdf ' },
];

function Harness({
  projects = { projects: PROJECTS, t3: 'ready', loading: false },
  use = vi.fn(async () => true),
  onPicker = vi.fn(),
  skills = SKILLS,
}: {
  projects?: PromptProjectsState;
  use?: ComposerPrompts['use'];
  onPicker?: (open: boolean) => void;
  skills?: SkillCommand[];
}) {
  const [value, setValue] = useState('');
  return (
    <Composer
      variant="chat"
      placeholder="Ask Neo anything"
      value={value}
      onValueChange={setValue}
      onSubmit={() => {}}
      mentionables={PRINCIPALS}
      viewerId={mara.id}
      skills={skills}
      prompts={{ list: PROMPTS, projects, onPicker, use }}
    />
  );
}

const box = () => screen.getByRole('textbox', { name: 'Ask Neo anything' }) as HTMLTextAreaElement;

describe('prompts after `/` in Chat’s composer', () => {
  it('lists the prompts above the skills and moves through both with the keys', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(box(), '/');
    const list = screen.getByRole('listbox');
    const groups = within(list).getAllByRole('group');
    expect(groups[0]).toBe(within(list).getByRole('group', { name: PROMPT_WORDS.group }));
    expect(groups[1]).toBe(within(list).getByRole('group', { name: 'SKILLS' }));
    const options = within(list).getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    // The first line of the words, not the rest.
    expect(options[0]?.textContent).toContain('the words.');
    expect(options[0]?.textContent).not.toContain('Second line');
    await user.keyboard('{ArrowUp}');
    expect(options[2]?.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Enter}');
    expect(box().value).toBe('/pdf ');
  });

  it('puts the words of a prompt that isn’t for a repository in the draft, sending nothing', async () => {
    const user = userEvent.setup();
    const use = vi.fn(async () => true);
    render(<Harness use={use} />);
    await user.type(box(), '/week');
    await user.keyboard('{Enter}');
    expect(box().value).toBe(PROMPTS[1]?.text);
    expect(box().selectionStart).toBe(PROMPTS[1]?.text.length);
    expect(use).not.toHaveBeenCalled();
  });

  it('asks which repository for one that is, the ones it ran on first, and uses it on the chosen one', async () => {
    const user = userEvent.setup();
    const use = vi.fn(async () => true);
    const onPicker = vi.fn();
    render(<Harness use={use} onPicker={onPicker} />);
    await user.type(box(), '/find');
    await user.keyboard('{Enter}');
    const search = await screen.findByRole('combobox', { name: PROMPT_WORDS.pickSearch });
    await waitFor(() => expect(search).toBe(document.activeElement));
    expect(onPicker).toHaveBeenLastCalledWith(true);
    const rows = within(screen.getByRole('listbox', { name: PROMPT_WORDS.pickTitle })).getAllByRole('option');
    expect(rows.map((r) => r.getAttribute('data-project'))).toEqual(['p-tracker', 'p-fusebox']);
    expect(rows[0]?.textContent).toContain('2 days ago');
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(use).toHaveBeenCalledTimes(1));
    expect(use).toHaveBeenCalledWith(PROMPTS[0], expect.objectContaining({ id: 'p-fusebox' }));
    await waitFor(() => expect(box().value).toBe(''));
    expect(screen.queryByRole('combobox', { name: PROMPT_WORDS.pickSearch })).toBeNull();
  });

  it('keeps the picker and the draft when using fails, and Escape goes back to the list', async () => {
    const user = userEvent.setup();
    const use = vi.fn(async () => false);
    render(<Harness use={use} />);
    await user.type(box(), '/find');
    await user.keyboard('{Enter}');
    await screen.findByRole('combobox', { name: PROMPT_WORDS.pickSearch });
    await user.keyboard('fuse{Enter}');
    await waitFor(() => expect(use).toHaveBeenCalledTimes(1));
    expect(box().value).toBe('/find');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('combobox', { name: PROMPT_WORDS.pickSearch })).toBeNull();
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(box()).toBe(document.activeElement);
  });

  it('says why without T3 Code and offers to put the words in the message', async () => {
    const user = userEvent.setup();
    render(<Harness projects={{ projects: null, t3: 'not_connected', loading: false }} />);
    await user.type(box(), '/find');
    await user.keyboard('{Enter}');
    expect(await screen.findByText(PROMPT_WORDS.t3.not_connected)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: PROMPT_WORDS.pickInstead }));
    expect(box().value).toBe(PROMPTS[0]?.text);
  });
});
