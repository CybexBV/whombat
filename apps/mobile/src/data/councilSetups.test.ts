/**
 * Settings → the assistant → Council on the phone (council.md; council-phone.md): the one council from the demo world —
 * T3 Code's council to read with where to change it, the person's rounds and score else the usual ones, read only
 * without T3 Code's choices — and the editor's draft: the score's choices, what Save sends and when it can.
 */
import { ApiError, COUNCIL_SETUP_WORDS, PROBLEM_WORDS } from '@whombat/client';
import { api, type CouncilSetupResponse } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { createCouncilSetupFixtures } from '../fixtures/councilSetups';
import { councilActionProblem, olderWhombat } from './council';
import {
  COUNCIL_ROUND_CHOICES,
  COUNCIL_TARGETS,
  councilCanSave,
  councilDraftBody,
  councilDraftCheck,
  councilDraftFor,
  councilPartView,
  councilTargetPicker,
  sameCouncilDraft,
} from './councilSetups';

const now = () => new Date('2026-11-05T12:00:00Z');

async function world(options: Parameters<typeof createCouncilSetupFixtures>[0] = { now }) {
  const res = createCouncilSetupFixtures(options).handle('councils.setup');
  return api.councils.setup.response.parse(await res?.json()) as CouncilSetupResponse;
}

const checked = (menu: { sections: { id: string; checked?: boolean }[][] }) =>
  menu.sections.flat().find((i) => i.checked)?.id;

/** T3 Code's council in the demo world, as Save sends it. */
const T3_MODELS = ['gpt-6.2-sol', 'claude-opus-5-5', 'muse-wonder-full-1.0', 'gemini-4-neon'];

describe('the Council part', () => {
  it('shows T3 Code’s council to read, where to change it, and the person’s rounds and score', async () => {
    const view = councilPartView(await world(), 'Neo');
    expect(view.intro).toContain('Neo');
    const { council } = view;
    expect(council).toMatchObject({
      yours: true,
      text: COUNCIL_SETUP_WORDS.sits,
      hint: COUNCIL_SETUP_WORDS.sitsHint,
      note: null,
    });
    expect(council.summary).toBe(COUNCIL_SETUP_WORDS.summary(4, 3, 9));
    expect(council.seats.map((s) => [s.model, s.effort])).toEqual([
      ['GPT 6.2 Sol', 'Extra high'],
      ['Claude Opus 5.5', 'Extra high'],
      ['Muse Wonder Full 1.0', 'Extra high'],
      ['Gemini 4 Neon', 'Extra high'],
    ]);
    expect(council.seats[3]?.provider).toBe('Antigravity');
    expect(council.seats.every((s) => s.available)).toBe(true);
    expect(council.label).toContain(COUNCIL_SETUP_WORDS.sitsHint);
    expect(view).toMatchObject({ editable: true, canReset: true, t3: null });
  });

  it('shows the usual rounds and score while none is set, with nothing to reset', async () => {
    const view = councilPartView(await world({ now, empty: true }), 'Neo');
    expect(view.council).toMatchObject({
      yours: false,
      text: COUNCIL_SETUP_WORDS.sits,
      summary: COUNCIL_SETUP_WORDS.summary(4, 3, 9),
    });
    expect(view.council.seats.map((s) => s.provider)).toEqual(['Codex', 'Claude', 'Muse', 'Antigravity']);
    expect(view).toMatchObject({ editable: true, canReset: false });
  });

  it('says T3 Code’s council sits when there are no seats to show, with nothing to change', async () => {
    const data = await world({ now, empty: true, t3: 'not_connected' });
    const view = councilPartView({ ...data, automatic: [] }, 'Neo');
    expect(view.council).toMatchObject({
      text: COUNCIL_SETUP_WORDS.sitsUnknown,
      hint: null,
      summary: null,
      seats: [],
    });
    expect(view.editable).toBe(false);
  });

  it('keeps the council to read only, with why, while T3 Code isn’t connected', async () => {
    const view = councilPartView(await world({ now, t3: 'not_connected' }), 'Neo');
    expect(view.t3).toBe(COUNCIL_SETUP_WORDS.t3.not_connected);
    expect(view).toMatchObject({ editable: false, canReset: false });
    expect(view.council.seats).toHaveLength(4);
    // Nothing known to be wrong with the seats: none is muted.
    expect(view.council.seats.every((s) => s.available)).toBe(true);
  });

  it('mutes a seat T3 Code can’t run now and says why', async () => {
    const data = await world();
    const options = data.options?.filter((p) => p.id !== 'muse') ?? null;
    const { council } = councilPartView({ ...data, options }, 'Neo');
    expect(council.seats.map((s) => s.available)).toEqual([true, true, false, true]);
    expect(council.note).toBe(COUNCIL_SETUP_WORDS.notAvailable);
  });
});

describe('changing the council', () => {
  it('opens on T3 Code’s seats with the person’s rounds and score, else the usual ones', async () => {
    const mine = councilDraftFor(await world());
    expect(mine).toMatchObject({ builder: 0, rounds: 3, target: 9 });
    expect(mine.seats.map((s) => s.model)).toEqual(T3_MODELS);
    const usual = councilDraftFor(await world({ now, empty: true }));
    expect(usual).toMatchObject({ builder: 0, rounds: 3, target: 9 });
    expect(usual.seats.map((s) => s.model)).toEqual(T3_MODELS);
  });

  it('chooses the score in halves from 7 to 10, and rounds 1 to 5', async () => {
    const mine = councilDraftFor(await world());
    const target = councilTargetPicker({ ...mine, target: 9.5 });
    expect(target.value).toBe('9.5/10');
    expect(checked(target.menu)).toBe('9.5');
    expect(target.menu.sections[0]).toHaveLength(COUNCIL_TARGETS.length);
    expect(councilTargetPicker({ ...mine, target: 6.5 }).menu.sections[0]?.[0]?.id).toBe('6.5');
    expect(COUNCIL_TARGETS).toEqual([7, 7.5, 8, 8.5, 9, 9.5, 10]);
    expect(COUNCIL_ROUND_CHOICES.map((c) => c.value)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('keeps Save off for a council of one company', async () => {
    const mine = councilDraftFor(await world());
    expect(councilDraftCheck(mine).problem).toBeNull();
    const claudeOnly = {
      ...mine,
      seats: [
        { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'xhigh' },
        { provider: 'claudeAgent', model: 'claude-sonnet-5-5', effort: 'high' },
      ],
    };
    expect(councilDraftCheck(claudeOnly).problem).toContain('two different');
    expect(councilCanSave(claudeOnly, mine, false)).toBe(false);
  });

  it('saves a change of rounds or score, and the usual ones as they are', async () => {
    const mine = councilDraftFor(await world());
    expect(councilCanSave(mine, mine, true)).toBe(false);
    expect(councilCanSave({ ...mine, rounds: 4 }, mine, true)).toBe(true);
    expect(councilCanSave({ ...mine, target: 8 }, mine, true)).toBe(true);
    const usual = councilDraftFor(await world({ now, empty: true }));
    expect(councilCanSave(usual, usual, false)).toBe(true);
  });

  it('knows a change from the saved council, and sends the contract’s body with T3 Code’s seats', async () => {
    const mine = councilDraftFor(await world());
    expect(
      sameCouncilDraft(mine, { ...mine, seats: mine.seats.map((s) => ({ ...s, modelLabel: 'x' })) }),
    ).toBe(true);
    expect(sameCouncilDraft(mine, { ...mine, rounds: 4 })).toBe(false);
    const body = api.councils.saveSetup.body.parse(councilDraftBody({ ...mine, target: 8.5 }));
    expect(Object.keys(body).sort()).toEqual(['builder', 'rounds', 'seats', 'target']);
    expect(Object.keys(body.seats[0] ?? {}).sort()).toEqual(['effort', 'model', 'provider']);
    expect(body.seats.map((s) => s.model)).toEqual(T3_MODELS);
    expect(body).toMatchObject({ builder: 0, target: 8.5 });
  });
});

describe('when a council can’t be saved', () => {
  it('says an older Whombat needs an update, and keeps the server’s own words', () => {
    const older = new ApiError(
      404,
      'unknown',
      'No operation councils.setup',
      { error: { code: 'unknown_op', message: 'No operation councils.setup' } },
      'councils.setup',
    );
    expect(olderWhombat(older)).toBe(true);
    expect(councilActionProblem(older)).toBe(PROBLEM_WORDS.whombatUpdate);
    const refused = new ApiError(
      400,
      'validation_failed',
      'The same model sits on it twice.',
      null,
      'councils.saveSetup',
    );
    expect(olderWhombat(refused)).toBe(false);
    expect(councilActionProblem(refused)).toBe('The same model sits on it twice.');
  });
});
