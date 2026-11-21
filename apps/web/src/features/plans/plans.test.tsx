import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CARD_FRAME_WORDS } from '@whombat/client';
import type { Plan, PlanStep } from '@whombat/core';
import { plan as fixturePlan, PRINCIPALS } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/renderApp';
import { PlanCard } from '../cards/PlanCard';
import { principalLookup } from '../cards/parts';
import { cardStepDetail, countedSteps, paneStepActions, planTitleFrom, stepActionLabel } from './planModel';

const step = (over: Partial<PlanStep>): PlanStep => ({ ...(fixturePlan.steps[1] as PlanStep), ...over });

/** The mock's plan with a blocked and a cancelled step. */
function laterPlan(): Plan {
  const [a, b, c, d] = fixturePlan.steps as [PlanStep, PlanStep, PlanStep, PlanStep];
  return {
    ...fixturePlan,
    steps: [
      a,
      {
        ...b,
        state: 'blocked',
        stateLabel: 'Run failed',
        note: 'Run #1907 failed. Retry or reassign.',
      },
      { ...c, state: 'cancelled', stateLabel: 'Cancelled' },
      d,
    ],
  };
}

describe('plan card (WS-02, WS-09)', () => {
  const principals = principalLookup(PRINCIPALS);

  it('keeps the mock’s rows for its states: no line under the gate step without a note', () => {
    render(<PlanCard plan={fixturePlan} principals={principals} planHref="/p" linkHref={() => '/x'} />);
    const card = screen.getByRole('region', { name: /Invoice PDF export/ });
    // The status line, a plain title and the step it waits at, by name.
    expect(within(card).getByRole('heading', { name: 'Invoice PDF export' })).toBeTruthy();
    expect(card.querySelector('[data-plan-focus]')?.textContent).toContain('Deploy to staging');
    // No line under the gate step: its approval is under Details only.
    expect(card.querySelector('[data-state="gate"]')?.textContent).not.toContain('Approval #12');
    fireEvent.click(within(card).getByText(CARD_FRAME_WORDS.details));
    expect(within(card).getByText('4 steps')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Open plan canvas' })).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Open plan' }).getAttribute('href')).toBe('/p');
  });

  it('draws blocked and cancelled steps, says why a blocked step is stuck and links its run', () => {
    render(
      <PlanCard
        plan={laterPlan()}
        principals={principals}
        linkHref={(l) => (l.type === 'run' ? `/runs/${l.number}` : '#')}
      />,
    );
    // A cancelled step is kept but not counted.
    fireEvent.click(screen.getByText(CARD_FRAME_WORDS.details));
    expect(screen.getByText('3 steps')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Blocked' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Cancelled' })).toBeTruthy();
    expect(screen.getByText('Run #1907 failed. Retry or reassign.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Run #1907' }).getAttribute('href')).toBe('/runs/1907');
    expect(screen.getAllByText('Review against the brief').at(-1)?.className).toMatch(/cancelled/);
    // No “Open plan” without a pane to open.
    expect(screen.queryByRole('link', { name: 'Open plan' })).toBeNull();
  });
});

describe('go ahead on a step waiting for the person', () => {
  const principals = principalLookup(PRINCIPALS);
  const waiting = (): Plan => {
    const [a, b] = fixturePlan.steps as [PlanStep, PlanStep];
    return {
      ...fixturePlan,
      steps: [
        a,
        {
          ...b,
          state: 'gate',
          stateLabel: 'Needs a person',
          note: 'Waiting for your go',
          approvalId: null,
          runId: null,
          automationRunId: null,
        },
      ],
    };
  };

  it('offers Go ahead on the card and asks for that step', async () => {
    const asked: string[] = [];
    const p = waiting();
    render(<PlanCard plan={p} principals={principals} onGoAhead={(s) => asked.push(s.id)} />);
    await userEvent.click(screen.getByRole('button', { name: /^Go ahead: / }));
    expect(asked).toEqual([p.steps[1]?.id]);
  });

  it('shows no button without a way to act, nor on a step an approval decides', () => {
    render(<PlanCard plan={waiting()} principals={principals} />);
    expect(screen.queryByRole('button', { name: /^Go ahead/ })).toBeNull();
    const step2 = waiting().steps[1] as PlanStep;
    expect(stepActionLabel('retry', step2)).toBe('Go ahead');
    expect(stepActionLabel('retry', { ...step2, approvalId: 'apr_1' })).toBe('Retry');
    expect(stepActionLabel('retry', { ...step2, state: 'blocked' })).toBe('Retry');
  });
});

describe('plan model', () => {
  it('only notes gate steps that have a note; blocked steps always say something', () => {
    expect(cardStepDetail(step({ state: 'gate', note: null }))).toBeNull();
    expect(cardStepDetail(step({ state: 'gate', note: 'Check the result.', approvalId: null }))?.note).toBe(
      'Check the result.',
    );
    // Waiting on an approval: the mock's row, as drawn.
    expect(cardStepDetail(step({ state: 'gate', note: 'Waiting.', approvalId: 'apr_1' }))).toBeNull();
    expect(cardStepDetail(step({ state: 'blocked', note: null }))?.links.map((l) => l.label)).toEqual([
      'Run #1907',
    ]);
    expect(countedSteps(laterPlan())).toBe(3);
  });

  it('offers Remove only for a step that never started', () => {
    expect(
      paneStepActions(
        step({
          state: 'queued',
          runId: null,
          refs: { runNumber: null, approvalNumber: null, automationRunNumber: null },
        }),
      ).removable,
    ).toBe(true);
    expect(paneStepActions(step({})).removable).toBe(false);
  });

  it('takes a plan title from the message’s first line', () => {
    expect(planTitleFrom('\n**Ship the PDF export** this week\nthen the rest')).toBe(
      'Ship the PDF export this week',
    );
    const long = planTitleFrom('word '.repeat(60));
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('plan pane', () => {
  it('opens from the card, focuses a step from the link, and runs its actions', async () => {
    const user = userEvent.setup();
    const app = renderApp('/chat?plan=pln_invoice-pdf&step=stp_pdf-3');
    const pane = await screen.findByRole('complementary', { name: 'Plan' });
    await within(pane).findByRole('heading', { name: 'Invoice PDF export' });
    expect(within(pane).getByText('1 of 4 done')).toBeTruthy();
    const focused = within(pane).getByRole('listitem', { name: 'Step 3: Review against the brief' });
    expect(document.activeElement).toBe(focused);

    // A step the person isn't needed for shows no buttons of its own: Mark done is in its menu.
    expect(within(focused).queryByRole('button', { name: 'Mark done: step 3' })).toBeNull();
    await user.click(within(focused).getByRole('button', { name: 'More for step 3' }));
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Mark done' }));
    await waitFor(() => expect(within(pane).getByText('2 of 4 done')).toBeTruthy());

    // Removing a started step isn't offered; its menu has Cancel instead.
    const building = within(pane).getByRole('listitem', { name: 'Step 2: Build the export endpoint' });
    await user.click(within(building).getByRole('button', { name: 'More for step 2' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Remove step' })).toBeNull();
    await user.click(within(menu).getByRole('menuitem', { name: 'Cancel step' }));
    await waitFor(() => expect(within(pane).getByText('2 of 3 done')).toBeTruthy());

    // Add a step and start it: the agent's (one-agent.md OA-14), nobody to pick, so it's asked.
    await user.type(within(pane).getByRole('textbox', { name: 'New step' }), 'Write the release note');
    expect(within(pane).queryByRole('combobox')).toBeNull();
    await user.click(within(pane).getByRole('button', { name: 'Add step' }));
    const added = await within(pane).findByRole('listitem', { name: 'Step 5: Write the release note' });
    expect(within(added).queryByRole('button', { name: 'Start: step 5' })).toBeNull();
    await user.click(within(added).getByRole('button', { name: 'More for step 5' }));
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Start' }));
    await waitFor(() => expect(within(added).getByText('Asked')).toBeTruthy());

    await user.click(within(pane).getByRole('button', { name: 'Close plan' }));
    await waitFor(() => expect(app.location()).toBe('/chat'));
  });

  it('reorders steps from the step menu', async () => {
    const user = userEvent.setup();
    renderApp('/chat?plan=pln_invoice-pdf');
    const pane = await screen.findByRole('complementary', { name: 'Plan' });
    const first = await within(pane).findByRole('listitem', { name: 'Step 1: Pick a PDF library' });
    await user.click(within(first).getByRole('button', { name: 'More for step 1' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Move up' })).toBeNull();
    await user.click(within(menu).getByRole('menuitem', { name: 'Move down' }));
    await within(pane).findByRole('listitem', { name: 'Step 2: Pick a PDF library' });
  });

  it('says so when the plan is gone', async () => {
    renderApp('/chat?plan=pln_nope');
    const pane = await screen.findByRole('complementary', { name: 'Plan' });
    expect(
      await within(pane).findByText('This plan isn’t here any more, or it’s in a room you’re not in.'),
    ).toBeTruthy();
  });
});
