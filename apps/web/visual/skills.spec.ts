/**
 * Settings → Skills on Hermes's skills (Whombat hermes-skills.md HSK-06…HSK-13; app hermes-skills.md AP-5530…AP-5549),
 * as screenshot baselines (`__screenshots__/skills.spec.ts/`), light and dark, 1440×900: the list (the mockup
 * `docs/design-handoff/all-skills/settings-skills.html`'s layout, reviewed against it when taken: the card, the title
 * and help line, the search with Add skills, the group labels and the rows with their status and switch), a changed
 * built-in's dialog, and Add skills on Hermes's hub — browsing, a preview Hermes's policy allows and one it blocks (no
 * mock: the skill dialog's and the list's components). Against the client's skill world (`skill-library/fixtures`).
 * `WHOMBAT_SKILLS_SHOTS=<dir>` also writes each shot there, the list in full height too, for review.
 */
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, neutraliseWorld, openApp, settle, THEMES, test } from './support/harness';

const REVIEW = process.env.WHOMBAT_SKILLS_SHOTS;

async function shot(page: Page, name: string) {
  await settle(page);
  if (REVIEW) await page.screenshot({ path: resolve(REVIEW, `${name}.png`) });
  await expect(page).toHaveScreenshot(`${name}.png`);
}

async function openSkills(page: Page, theme: 'light' | 'dark') {
  await openApp(page, { path: '/settings?tab=skills', theme });
  await page.getByRole('region', { name: /^Skills · \d+$/ }).waitFor();
  await neutraliseWorld(page);
}

async function openHub(page: Page, theme: 'light' | 'dark') {
  await openSkills(page, theme);
  await page.getByRole('button', { name: 'Add skills' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add skills' });
  await dialog.getByRole('list', { name: 'Skills found' }).waitFor();
  return dialog;
}

for (const theme of THEMES) {
  test.describe(`Settings → Skills (${theme})`, () => {
    test(`the list (${theme})`, async ({ page }) => {
      await openSkills(page, theme);
      await shot(page, `list-${theme}`);
      if (REVIEW) {
        await page.setViewportSize({ width: 1440, height: 2600 });
        await settle(page);
        await page.screenshot({ path: resolve(REVIEW, `list-full-${theme}.png`) });
      }
    });

    test(`a changed built-in's dialog (${theme})`, async ({ page }) => {
      await openSkills(page, theme);
      await page
        .locator('[data-skill="obsidian"]')
        .getByRole('button', { name: /^obsidian/ })
        .click();
      const dialog = page.getByRole('dialog', { name: 'obsidian' });
      await dialog.getByRole('button', { name: 'Restore Hermes’s' }).waitFor();
      await shot(page, `skill-${theme}`);
    });

    test(`a hub skill with an update (${theme})`, async ({ page }) => {
      await openSkills(page, theme);
      await page
        .locator('[data-skill="skill-creator"]')
        .getByRole('button', { name: /^skill-creator/ })
        .click();
      await page
        .getByRole('dialog', { name: 'skill-creator' })
        .getByRole('button', { name: 'Update' })
        .waitFor();
      await shot(page, `skill-update-${theme}`);
    });

    test(`Add skills: browsing Hermes's hub (${theme})`, async ({ page }) => {
      await openHub(page, theme);
      await shot(page, `hub-browse-${theme}`);
    });

    test(`Add skills: a preview Hermes allows (${theme})`, async ({ page }) => {
      const dialog = await openHub(page, theme);
      await dialog
        .locator('[data-hub="anthropics/skills/skills/webapp-testing"]')
        .getByRole('button')
        .click();
      // The preview is titled with the skill's name.
      await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).waitFor();
      await shot(page, `hub-allowed-${theme}`);
    });

    test(`Add skills: a preview Hermes blocks (${theme})`, async ({ page }) => {
      const dialog = await openHub(page, theme);
      await dialog
        .locator('[data-hub="skills-sh/someone/agent-tricks/clipboard-sync"]')
        .getByRole('button')
        .click();
      await page.getByRole('dialog').getByText('Exposes passwords or keys').waitFor();
      await shot(page, `hub-blocked-${theme}`);
    });
  });
}
