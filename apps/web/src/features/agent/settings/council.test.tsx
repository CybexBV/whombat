/**
 * Settings → the assistant → Council against the fixture world's council (`councilSetupFixtures.ts`): T3 Code's own
 * council (GPT 6.2 Sol, Claude Opus 5.5, Muse Wonder Full 1.0 and Gemini 4 Neon) with Mara's rounds and score. Who sits
 * reads only, with where to change it; Change opens the rounds and the score in place, Save sends T3 Code's seats as
 * they are, a refusal shows the server's words; Use the usual rounds and score asks first; none set shows the usual
 * ones; without T3 Code's list the council stays readable; the live card's link opens this part. Facts (ids, requests,
 * the client's words).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { COUNCIL_SETUP_WORDS as W } from '@whombat/client';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import type { WebFixtureOptions } from '../../../app/fixtureFetch';
import { jsonAnswer, type RecordedCall, recordingWorld } from '../../../test/recordingWorld';
import { mockedServices, renderApp } from '../../../test/renderApp';
import { COUNCIL_SETTINGS_HREF } from '../../cards/CouncilCard';

const B = `/burrows/${burrow.slug}`;
const SETUP = `${B}/councils/setup`;
const COUNCIL = '/settings?tab=agent&part=council';

/** T3 Code's council in the fixture world, as Save sends it. */
const T3_SEATS = [
  { provider: 'codex', model: 'gpt-6.2-sol', effort: 'xhigh' },
  { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'xhigh' },
  { provider: 'muse', model: 'muse-wonder-full-1.0', effort: 'xhigh' },
  { provider: 'antigravity', model: 'gemini-4-neon', effort: 'xhigh' },
];

function open(
  options: WebFixtureOptions = {},
  answer?: (call: RecordedCall, response: Response) => Response | Promise<Response>,
  at = COUNCIL,
) {
  const { fetch, calls } = recordingWorld(options, answer);
  const app = renderApp(at, mockedServices(fetch));
  return { calls, app };
}

/** The council as it reads: the person's rounds and score (`yours`) or the usual ones (`usual`). */
const council = async (which: 'yours' | 'usual' = 'yours') => {
  await screen.findByRole('region', { name: W.title });
  await waitFor(() => expect(document.querySelector(`[data-council="${which}"]`)).toBeTruthy());
  return document.querySelector(`[data-council="${which}"]`) as HTMLElement;
};

const seatLines = (el: HTMLElement) => [...el.querySelectorAll('li')].map((li) => li.textContent);

async function change(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: W.edit }));
  return screen.findByRole('form', { name: W.title });
}

const saves = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'POST' && c.path === SETUP);

describe('Settings → the assistant → Council', () => {
  it('shows T3 Code’s council to read, where to change it, how it runs, Change and the reset', async () => {
    open();
    const yours = await council();
    expect(yours.textContent).toContain(W.sits);
    expect(yours.textContent).toContain(W.sitsHint);
    expect(yours.textContent).toContain(W.summary(4, 3, 9));
    expect(seatLines(yours)).toEqual([
      expect.stringContaining('GPT 6.2 Sol · Extra high'),
      expect.stringContaining('Claude Opus 5.5 · Extra high'),
      expect.stringContaining('Muse Wonder Full 1.0 · Extra high'),
      expect.stringContaining('Gemini 4 Neon · Extra high'),
    ]);
    expect(seatLines(yours)[3]).toContain('Antigravity');
    // Nothing to choose in the row: who sits is T3 Code's.
    expect(within(yours).queryByRole('combobox')).toBeNull();
    expect(document.querySelectorAll('[data-council]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: W.edit })).toBeTruthy();
    expect(screen.getByRole('button', { name: W.reset })).toBeTruthy();
  });

  it('changes only the rounds and the score, and saves T3 Code’s seats as they are', async () => {
    const user = userEvent.setup();
    const { calls } = open();
    const form = await change(user);
    expect(screen.queryByRole('button', { name: W.reset })).toBeNull();
    // No seat to choose, add or remove: one select, the score.
    expect(within(form).getAllByRole('combobox')).toHaveLength(1);
    expect(form.querySelector('li')).toBeNull();
    expect(
      within(form)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([W.cancel, W.save]);

    await user.click(within(form).getByRole('radio', { name: '2' }));
    await user.selectOptions(within(form).getByRole('combobox', { name: W.target }), '8.5');
    await user.click(within(form).getByRole('button', { name: W.save }));
    await waitFor(() =>
      expect(saves(calls).at(-1)?.body).toEqual({ seats: T3_SEATS, builder: 0, rounds: 2, target: 8.5 }),
    );
    expect(await screen.findByText(W.saved)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('form', { name: W.title })).toBeNull());
    expect((await council()).textContent).toContain(W.summary(4, 2, 8.5));
  });

  it('shows the server’s words when it refuses', async () => {
    const user = userEvent.setup();
    open({}, (call, res) =>
      call.method === 'POST' && call.path === SETUP
        ? jsonAnswer({ error: { code: 'validation_failed', message: 'Muse can’t sit on it now.' } }, 400)
        : res,
    );
    const form = await change(user);
    await user.click(within(form).getByRole('radio', { name: '2' }));
    await user.click(within(form).getByRole('button', { name: W.save }));
    await waitFor(() =>
      expect(form.querySelector('[data-council-problem]')?.textContent).toBe('Muse can’t sit on it now.'),
    );
    expect(screen.getByRole('form', { name: W.title })).toBeTruthy();
  });

  it('asks before going back to the usual rounds and score, then shows them', async () => {
    const user = userEvent.setup();
    const { calls } = open({}, async (call, res) => {
      if (call.method !== 'GET' || call.path !== SETUP) return res;
      const data = await res.json();
      return jsonAnswer(data.setup ? { ...data, setup: { ...data.setup, rounds: 5, target: 7 } } : data);
    });
    expect((await council()).textContent).toContain(W.summary(4, 5, 7));
    await user.click(screen.getByRole('button', { name: W.reset }));
    const ask = await screen.findByRole('dialog', { name: W.resetAsk });
    expect(ask.textContent).toContain(W.resetBody);
    await user.click(within(ask).getByRole('button', { name: W.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls).toEqual([]);

    await user.click(screen.getByRole('button', { name: W.reset }));
    const again = await screen.findByRole('dialog', { name: W.resetAsk });
    await user.click(within(again).getByRole('button', { name: W.reset }));
    await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: `${SETUP}/reset`, body: {} }]));
    expect(await screen.findByText(W.wasReset)).toBeTruthy();
    const usual = await council('usual');
    expect(usual.textContent).toContain(W.summary(4, 3, 9));
    expect(seatLines(usual)).toHaveLength(4);
    expect(screen.queryByRole('button', { name: W.reset })).toBeNull();
  });

  it('asks before leaving the council with unsaved changes', async () => {
    const user = userEvent.setup();
    const { app } = open();
    const form = await change(user);
    await user.click(within(form).getByRole('radio', { name: '5' }));
    await user.click(screen.getByRole('radio', { name: 'Memory' }));
    expect(await screen.findByRole('dialog', { name: 'Leave without saving?' })).toBeTruthy();
    expect(app.location()).toBe(COUNCIL);
  });

  it('shows the usual rounds and score when none is set, and saves T3 Code’s seats with the person’s', async () => {
    const user = userEvent.setup();
    const { calls } = open({ councilSetups: { seeded: false } });
    const usual = await council('usual');
    expect(usual.textContent).toContain(W.sits);
    expect(usual.textContent).toContain(W.summary(4, 3, 9));
    expect(seatLines(usual)).toHaveLength(4);
    expect(screen.queryByRole('button', { name: W.reset })).toBeNull();
    const form = await change(user);
    await user.click(within(form).getByRole('radio', { name: '4' }));
    await user.click(within(form).getByRole('button', { name: W.save }));
    await waitFor(() =>
      expect(saves(calls).at(-1)?.body).toEqual({ seats: T3_SEATS, builder: 0, rounds: 4, target: 9 }),
    );
    expect((await council('yours')).textContent).toContain(W.summary(4, 4, 9));
    expect(screen.getByRole('button', { name: W.reset })).toBeTruthy();
  });

  it('keeps the council readable without T3 Code’s list, and says why', async () => {
    open({ councilSetups: { t3: 'not_connected' } });
    await screen.findByText(W.t3.not_connected);
    expect(seatLines(await council())).toHaveLength(4);
    expect(screen.queryByRole('button', { name: W.edit })).toBeNull();
    expect(screen.queryByRole('button', { name: W.reset })).toBeNull();
  });

  it('says T3 Code’s council sits when it can’t say who, with nothing to change', async () => {
    open({ councilSetups: { seeded: false, t3: 'not_connected' } });
    const usual = await council('usual');
    expect(usual.textContent).toContain(W.sitsUnknown);
    expect(usual.querySelector('li')).toBeNull();
    expect(screen.queryByRole('button', { name: W.edit })).toBeNull();
  });

  it('mutes a seat T3 Code can’t run now', async () => {
    open({}, async (call, res) => {
      if (call.method !== 'GET' || call.path !== SETUP) return res;
      const data = await res.json();
      return jsonAnswer({ ...data, options: data.options.filter((p: { id: string }) => p.id !== 'muse') });
    });
    const yours = await council();
    const muse = yours.querySelectorAll('li')[2] as HTMLElement;
    expect(muse.dataset.seatAvailable).toBe('false');
    expect(muse.textContent).toContain(W.notAvailable);
    expect((yours.querySelectorAll('li')[0] as HTMLElement).dataset.seatAvailable).toBe('true');
  });

  it('is where the live council card’s link goes', async () => {
    const user = userEvent.setup();
    open({}, undefined, COUNCIL_SETTINGS_HREF);
    await council();
    expect(await change(user)).toBeTruthy();
  });
});
