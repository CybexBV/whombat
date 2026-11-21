import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assessmentVerdict, decidedLine } from '@whombat/client';
import type { AssessmentCard as AssessmentCardData } from '@whombat/core/domain';
import { assessmentCardOf, reportFeature, reportLikelyBug } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { AssessmentCard } from './AssessmentCard';

const bug = assessmentCardOf(reportLikelyBug) as AssessmentCardData;
const feature = assessmentCardOf(reportFeature) as AssessmentCardData;

describe('The assessment card (Whombat FB-32)', () => {
  it('shows the verdict and the question; a pick sends the option’s index', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    render(<AssessmentCard card={bug} canDecide onDecide={onDecide} />);
    const card = screen.getByRole('region', { name: 'ASSESSMENT · FB-7K3Q-9M2X: Bug' });
    const options = within(card).getByRole('group', { name: 'Shall I fix it?' });
    const handOff = within(options).getByRole('button', { name: /Fix it/ });
    expect(handOff.getAttribute('title')).toBe('Asks you to approve handing the report to development.');
    await user.click(within(options).getByRole('button', { name: /Leave it for now/ }));
    expect(onDecide).toHaveBeenCalledWith(1);
  });

  it('keeps the full assessment folded until opened', async () => {
    const user = userEvent.setup();
    render(<AssessmentCard card={bug} canDecide={false} />);
    expect(screen.queryByText(/billing\/pdf\/format\.ts:88/)).toBeNull();
    const toggle = screen.getByRole('button', { name: /Full assessment/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('Likely bug · medium confidence · severity medium');
    await user.click(toggle);
    const details = screen.getByRole('region', { name: 'Full assessment of FB-7K3Q-9M2X' });
    expect(within(details).getByText('Summary')).toBeTruthy();
    expect(within(details).getByText(/Observed · billing\/pdf\/format\.ts:88/)).toBeTruthy();
    expect(within(details).getByText(/Hypothesis · Invoice 2026-000142 has 7 lines/)).toBeTruthy();
  });

  it('options are disabled for viewers who can’t decide, and gone once decided', () => {
    const { rerender } = render(<AssessmentCard card={bug} canDecide={false} />);
    for (const b of screen.getAllByRole('button', { name: /Fix it|Leave it for now/ }))
      expect((b as HTMLButtonElement).disabled).toBe(true);
    const decided = {
      option: 1,
      label: 'Leave it for now',
      action: 'keep_open' as const,
      decidedById: 'prn_mara',
      decidedAt: '2026-09-30T14:10:00.000Z',
    };
    rerender(
      <AssessmentCard
        card={{ ...bug, decided }}
        canDecide
        decidedText={decidedLine(decided, 'Mara', '16:10')}
      />,
    );
    expect(screen.queryByRole('button', { name: /Fix it/ })).toBeNull();
    expect(screen.getByText('Mara chose “Leave it for now” · kept open · 16:10')).toBeTruthy();
  });

  it('a feature request shows its outcome instead of a bug verdict', () => {
    expect(assessmentVerdict(feature)).toEqual({ text: 'Feature request', tone: 'mut' });
    expect(assessmentVerdict({ ...bug, bugVerdict: 'not_a_bug' })).toEqual({ text: 'Not a bug', tone: 'ok' });
    render(<AssessmentCard card={feature} canDecide />);
    expect(screen.getByRole('region', { name: 'ASSESSMENT · FB-H8XM-5VKT: Feature request' })).toBeTruthy();
    // The recommended option is the primary button; its description says so.
    const notNow = screen.getByRole('button', { name: 'Not now' });
    const described = document.getElementById(notNow.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe('Recommended. Keeps the report open.');
  });
});
