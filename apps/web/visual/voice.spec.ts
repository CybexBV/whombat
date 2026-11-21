/**
 * Voice typing, which has no mock, as screenshot baselines (`__screenshots__/voice.spec.ts/`), light and dark,
 * 1440×900 (docs/decisions/dictation.md DT-01, DT-06; reviewed against SCREEN and Chat's composer when taken):
 * - This Whombat → Overview → VOICE TYPING with Fast ready and no graphics chip, with Most accurate chosen and its
 *   download failed (no room, Try again, the slow warning), and on a box with a graphics chip and both models;
 * - Chat's composer with its mic, and the recording bar (Cancel, the waveform, “Recording 0:00”, Done) on a silent
 *   microphone, so the waveform is flat and the clock stands still.
 * The world is picked before the page loads (`whombat:fixture-voice`, `voiceFixtures.ts`); each shot is the section or
 * the composer alone.
 */
import type { Page } from '@playwright/test';
import { expect, neutraliseWorld, openApp, settle, THEMES, test } from './support/harness';

type World = 'ready' | 'gpu' | 'failed';

async function open(page: Page, theme: 'light' | 'dark', world: World, path: string) {
  await page.addInitScript((w) => {
    localStorage.setItem('whombat:fixture-voice', w);
    // A microphone that hears nothing: the waveform stays flat, so the shot doesn't move.
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => new AudioContext().createMediaStreamDestination().stream,
      },
    });
  }, world);
  await openApp(page, { path, theme });
}

async function voiceSection(page: Page, theme: 'light' | 'dark', world: World) {
  await open(page, theme, world, '/settings?tab=appliance&section=overview');
  await page.locator('h1').first().waitFor();
  await neutraliseWorld(page);
  const section = page.locator('section[data-voice]');
  await section.waitFor();
  return section;
}

async function chatComposer(page: Page, theme: 'light' | 'dark') {
  await open(page, theme, 'ready', '/chat?new=1');
  await page.getByRole('textbox', { name: 'Ask Neo anything' }).waitFor();
  await neutraliseWorld(page);
  // The composer's dock, found by what stays in it while it records (the field is hidden then).
  return page.getByRole('region', { name: 'Chat' }).locator('[data-composer="page"]');
}

for (const theme of THEMES) {
  test(`VOICE TYPING, Fast ready (${theme})`, async ({ page }) => {
    const section = await voiceSection(page, theme, 'ready');
    await section.getByText('Uses Fast now').waitFor();
    await settle(page);
    await expect(section).toHaveScreenshot(`voice-ready-${theme}.png`);
  });

  test(`VOICE TYPING, Most accurate failed (${theme})`, async ({ page }) => {
    const section = await voiceSection(page, theme, 'failed');
    await section.getByRole('button', { name: 'Try again' }).waitFor();
    await settle(page);
    await expect(section).toHaveScreenshot(`voice-failed-${theme}.png`);
  });

  test(`VOICE TYPING, graphics chip (${theme})`, async ({ page }) => {
    const section = await voiceSection(page, theme, 'gpu');
    await section.getByText(/AMD Radeon 8050S/).waitFor();
    await settle(page);
    await expect(section).toHaveScreenshot(`voice-gpu-${theme}.png`);
  });

  test(`Chat's composer with the mic (${theme})`, async ({ page }) => {
    const dock = await chatComposer(page, theme);
    await dock.getByRole('button', { name: 'Dictate' }).waitFor();
    await settle(page);
    await expect(dock).toHaveScreenshot(`voice-composer-${theme}.png`);
  });

  test(`Chat's composer recording (${theme})`, async ({ page }) => {
    const dock = await chatComposer(page, theme);
    await dock.getByRole('button', { name: 'Dictate' }).click();
    await dock.locator('[data-voice-bar="recording"]').waitFor();
    await settle(page);
    await expect(dock).toHaveScreenshot(`voice-recording-${theme}.png`);
  });
}
