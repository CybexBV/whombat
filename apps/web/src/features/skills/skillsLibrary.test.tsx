/**
 * Settings → Advanced → Skills (Whombat hermes-skills.md HSK-04…HSK-13, hermes-engine.md HE-41, settings-groups.md
 * app AP-5530…AP-5549, was AP-5230…AP-5234; one-person.md AP-5710): its own page, the one list with Hermes's categories and the
 * folds, the open skill's dialog with Edit, Compare, Restore Hermes’s, Update and Remove, and Add skills on Hermes's hub — against
 * the client's skill library world. Facts (ids, routes, which buttons show), not long literal text.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

const assistant = () => fixtureServices({});

async function openTab(url = '/settings?tab=advanced&part=skills') {
  const app = renderApp(url, assistant());
  const list = await screen.findByRole('region', { name: /^Skills · \d+$/ });
  return { app, list };
}

/** A row by the skill's name (one skill per name, CT-1571). */
const row = (list: HTMLElement, name: string) => list.querySelector(`[data-skill="${name}"]`) as HTMLElement;
/** A fold's button. */
const fold = (list: HTMLElement, name: RegExp) =>
  within(list)
    .getAllByRole('button', { name })
    .find((b) => b.hasAttribute('aria-expanded')) as HTMLElement;
const openSkill = async (list: HTMLElement, key: string, name: string) => {
  const user = userEvent.setup();
  await user.click(within(row(list, key)).getByRole('button', { name: new RegExp(`^${name}`) }));
  return { user, panel: await screen.findByRole('dialog', { name }) };
};

describe('Skills is a page of Settings → Advanced (HSK-12; AP-5530)', () => {
  it('sends /skills there, anchor kept, with Advanced selected', async () => {
    const app = renderApp('/skills#skills-hub', assistant());
    expect(await screen.findByRole('region', { name: /^Skills · \d+$/ })).toBeTruthy();
    await waitFor(() => expect(app.location()).toBe('/settings?tab=advanced&part=skills'));
    expect(app.history.location.hash).toBe('#skills-hub');
    expect(screen.getByRole('heading', { level: 1, name: 'Advanced' })).toBeTruthy();
    expect(document.querySelector('[data-advanced-part]')?.getAttribute('data-advanced-part')).toBe('skills');
  });

  it('has no Skills part in Settings → the assistant', async () => {
    renderApp('/settings?tab=agent', assistant());
    const parts = await screen.findByRole('group', { name: /^Parts of / });
    expect(within(parts).getByRole('radio', { name: 'Memory' })).toBeTruthy();
    expect(within(parts).queryByRole('radio', { name: 'Skills' })).toBeNull();
  });
});

describe('the list (HSK-10…HSK-13; AP-5531…AP-5535)', () => {
  it('shows one list: Hermes’s categories, then added and learned skills, folding Off and Removed', async () => {
    const { list } = await openTab();
    expect(within(list).getByText(/uses a skill when a task matches it/)).toBeTruthy();
    expect(within(list).queryAllByRole('heading', { level: 3 })).toHaveLength(0);
    const groups = [...list.querySelectorAll('[data-skills-group]')].map((g) =>
      g.getAttribute('data-skills-group'),
    );
    expect(groups.slice(0, 2)).toEqual(['category:creative', 'category:email']);
    expect(groups.slice(-2)).toEqual(['added', 'learned']);
    expect(within(row(list, 'menerga-heat-pump')).getByText('Learned today')).toBeTruthy();
    expect(within(row(list, 'obsidian')).getByText('Changed · original changed')).toBeTruthy();
    expect(within(row(list, 'notion')).getByText('Needs NOTION_API_KEY')).toBeTruthy();
    expect(within(row(list, 'canvas')).getByText('Added from Hermes')).toBeTruthy();
    expect(within(row(list, 'skill-creator')).getByText('Update available')).toBeTruthy();
    // One row per name; a learned skill has a switch like any other.
    expect(list.querySelectorAll('[data-skill="weekly-review-planning"]')).toHaveLength(1);
    expect(within(row(list, 'menerga-heat-pump')).getByRole('switch')).toBeTruthy();
    expect(fold(list, /^Off · 3/).getAttribute('aria-expanded')).toBe('false');
    expect(fold(list, /^Removed · 1/)).toBeTruthy();
    expect(row(list, 'gif-search')).toBeNull();
  });

  it('searches names and descriptions as you type, the folds open', async () => {
    const user = userEvent.setup();
    const { list } = await openTab();
    await user.type(within(list).getByRole('searchbox', { name: 'Search skills' }), 'modbus');
    expect(row(list, 'menerga-heat-pump')).toBeTruthy();
    expect(row(list, 'notion')).toBeNull();
    await user.clear(within(list).getByRole('searchbox', { name: 'Search skills' }));
    await user.type(within(list).getByRole('searchbox', { name: 'Search skills' }), 'delegate');
    expect(row(list, 'claude-code')).toBeTruthy();
  });

  it('switches a skill off', async () => {
    const user = userEvent.setup();
    const { list } = await openTab();
    await user.click(within(row(list, 'arxiv')).getByRole('switch', { name: /^arxiv for / }));
    await waitFor(() => expect(fold(list, /^Off · 4/)).toBeTruthy());
  });
});

describe('the open skill, in a dialog (CT-1410…CT-1415; AP-5536…AP-5541)', () => {
  it('shows a changed built-in with its category and Compare with Hermes’s, file by file', async () => {
    const { list } = await openTab();
    const { user, panel } = await openSkill(list, 'obsidian', 'obsidian');
    expect(await within(panel).findByText('Note taking · Changed')).toBeTruthy();
    expect(within(panel).getByRole('heading', { name: 'Writing a note' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Restore Hermes’s' })).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Update' })).toBeNull();
    await user.click(
      within(panel).getAllByRole('button', { name: 'Compare with original' })[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Compare with original' });
    expect(within(dialog).getByText(/only in Hermes’s/)).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'obsidian/SKILL.md, view only' })).toBeTruthy();
  });

  it('edits a built-in into a changed one, and Restore brings Hermes’s back', async () => {
    const { list } = await openTab();
    const { user, panel } = await openSkill(list, 'xlsx', 'xlsx');
    expect(within(panel).getByRole('button', { name: /references\/formulas\.md/ })).toBeTruthy();
    await user.click(await within(panel).findByRole('button', { name: 'Edit' }));
    expect(within(panel).getByText(/shows as Changed/)).toBeTruthy();
    const body = within(panel).getByRole('textbox', { name: 'SKILL.md' });
    await user.type(body, '\n- Keep the charts.');
    // Esc while editing keeps the dialog and what was typed.
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'xlsx' })).toBe(panel);
    await user.click(within(panel).getByRole('radio', { name: 'Preview' }));
    expect(within(panel).getByText('Keep the charts.')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(await within(panel).findByText('Productivity · Changed')).toBeTruthy();
    await waitFor(() => expect(within(row(list, 'xlsx')).getByText('Changed')).toBeTruthy());

    await user.click(within(panel).getByRole('button', { name: 'Restore Hermes’s' }));
    const confirm = within(panel).getByRole('group', { name: 'Restore Hermes’s' });
    await user.click(within(confirm).getByRole('button', { name: 'Restore Hermes’s' }));
    await waitFor(() => expect(within(row(list, 'xlsx')).getByText('On')).toBeTruthy());
  });

  it('updates a hub skill with a newer version after asking', async () => {
    const { list } = await openTab();
    const { user, panel } = await openSkill(list, 'skill-creator', 'skill-creator');
    expect(await within(panel).findByText('Added from GitHub')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Restore Hermes’s' })).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Update' }));
    const confirm = within(panel).getByRole('group', { name: 'Update' });
    await user.click(within(confirm).getByRole('button', { name: 'Update' }));
    await waitFor(() =>
      expect(within(row(list, 'skill-creator')).queryByText('Update available')).toBeNull(),
    );
    expect(within(panel).queryByRole('button', { name: 'Update' })).toBeNull();
  });

  it('removes a hub skill after asking: it is uninstalled', async () => {
    const { list } = await openTab();
    const { user, panel } = await openSkill(list, 'canvas', 'canvas');
    expect(await within(panel).findByText(/Needs CANVAS_API_TOKEN/)).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Remove' }));
    const confirm = within(panel).getByRole('group', { name: 'Remove' });
    expect(within(confirm).getByText(/Add skills/)).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(row(list, 'canvas')).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'canvas' })).toBeNull();
  });

  it('says a learned skill is the agent’s, edits it and forgets it on Remove', async () => {
    const { list } = await openTab();
    const { user, panel } = await openSkill(list, 'menerga-heat-pump', 'menerga-heat-pump');
    expect(await within(panel).findByText(/^Learned by /)).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /Share/ })).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Remove' }));
    const confirm = within(panel).getByRole('group', { name: 'Remove' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(row(list, 'menerga-heat-pump')).toBeNull());
  });
});

describe('Add skills: Hermes’s hub (HSK-06…HSK-09; AP-5542…AP-5549)', () => {
  const openHub = async () => {
    const user = userEvent.setup();
    const { list } = await openTab();
    await user.click(within(list).getByRole('button', { name: 'Add skills' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add skills' });
    const results = await within(dialog).findByRole('list', { name: 'Skills found' });
    return { user, list, dialog, results };
  };
  const result = (dialog: HTMLElement, identifier: string) =>
    dialog.querySelector(`[data-hub="${identifier}"]`) as HTMLElement;

  it('browses all three sources with their trust in words, “Installed” where it is, and narrows by source', async () => {
    const { user, dialog } = await openHub();
    expect(within(result(dialog, 'official/productivity/canvas')).getByText('Installed')).toBeTruthy();
    expect(
      within(result(dialog, 'skills-sh/someone/agent-tricks/clipboard-sync')).getByText(
        'skills.sh · Community · 412 installs',
      ),
    ).toBeTruthy();
    expect(dialog.querySelector('input[type="file"]')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'GitHub', pressed: false }));
    await waitFor(() => expect(result(dialog, 'official/productivity/canvas')).toBeNull());
    expect(result(dialog, 'anthropics/skills/skills/webapp-testing')).toBeTruthy();
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search for skills' }), 'playwright');
    await waitFor(() => expect(result(dialog, 'anthropics/skills/skills/pdf')).toBeNull());
    expect(result(dialog, 'anthropics/skills/skills/webapp-testing')).toBeTruthy();
  });

  it('previews an allowed skill with Hermes’s verdict, and adds it', async () => {
    const { user, list, dialog } = await openHub();
    await user.click(
      within(result(dialog, 'official/smart-home/openhue')).getByRole('button', { name: /^openhue/ }),
    );
    expect(await within(dialog).findByText('Nothing risky found')).toBeTruthy();
    expect(within(dialog).getByText('Needs the openhue command')).toBeTruthy();
    expect(within(dialog).getByText('Runs on Linux and macOS')).toBeTruthy();
    expect(within(dialog).getByText('references/scenes.md')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Added openhue.')).toBeTruthy();
    expect(within(result(dialog, 'official/smart-home/openhue')).getByText('Installed')).toBeTruthy();
    await waitFor(() => expect(row(list, 'openhue')).toBeTruthy());
  });

  it('shows a blocked skill’s findings and Hermes’s reason, with no way to add it', async () => {
    const { user, dialog } = await openHub();
    await user.click(
      within(result(dialog, 'skills-sh/someone/agent-tricks/clipboard-sync')).getByRole('button', {
        name: /^clipboard-sync/,
      }),
    );
    expect(await within(dialog).findByText('Exposes passwords or keys')).toBeTruthy();
    expect(within(dialog).getAllByText('scripts/sync.sh, line 7')).toHaveLength(2);
    expect(within(dialog).getByText(/only added when nothing is/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Add' })).toBeNull();
    await user.click(within(dialog).getAllByRole('button', { name: 'Back' })[0] as HTMLElement);
    expect(await within(dialog).findByRole('list', { name: 'Skills found' })).toBeTruthy();
  });

  it('says why a skill whose name is taken can’t be added', async () => {
    const { user, dialog } = await openHub();
    await user.click(
      within(result(dialog, 'anthropics/skills/skills/pdf')).getByRole('button', { name: /^pdf/ }),
    );
    expect(await within(dialog).findByText(/already a skill called pdf/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Add' })).toBeNull();
  });
});
