/**
 * A job handed to T3 Code, in its Chat thread, against the fixture world's jobs in every state
 * (`VITE_FIXTURE_CODE=jobs`): the plan, its pull request, the changes and the checks with the fix attempt, a question's
 * answers, a permission left to T3 Code (said once, on its line), the steer box and the receipt; no stage track.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JOB_WORDS } from '@whombat/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODE_COUNCIL_THREAD, CODE_FIXTURE_KEY, CODE_JOB_THREADS } from '../../app/codeFixtures';
import { fixtureServices, renderApp } from '../../test/renderApp';

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
// Each test starts with an empty storage (test setup): the switch for a job in every state.
beforeEach(() => localStorage.setItem(CODE_FIXTURE_KEY, 'jobs'));

const open = (root: string) =>
  renderApp(`/chat?thread=${encodeURIComponent(root)}`, fixtureServices({ code: true }));

describe('the job view', () => {
  it('shows its plan, its pull request, its changes and the check T3 Code is fixing, with no stage track', async () => {
    open(CODE_JOB_THREADS.fixing);
    expect(await screen.findByText('12 files · +340 −58')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Pull request #49, open' }).getAttribute('href')).toMatch(
      /\/pull\/49$/,
    );
    expect(document.querySelector('[data-job-track]')).toBeNull();
    expect(screen.getByText(JOB_WORDS.checks.fixing(2))).toBeTruthy();
    expect(screen.getByRole('link', { name: /See the changes/ }).getAttribute('href')).toMatch(
      /\/pull\/49\/files$/,
    );
    // The job still works: its plan is open.
    expect(screen.getByRole('button', { name: /Plan/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('answers T3 Code’s question with an option', async () => {
    const user = userEvent.setup();
    open(CODE_JOB_THREADS.question);
    const option = await screen.findByRole('button', { name: /Yes, keep it/ });
    await user.click(option);
    await waitFor(() => expect(document.querySelector('[data-job-question]')).toBeNull());
    expect(await screen.findByText(JOB_WORDS.question.answered('Yes, keep it'))).toBeTruthy();
  });

  it('leaves a permission to T3 Code, said once on its line with one way there', async () => {
    open(CODE_JOB_THREADS.needs_ok);
    const line = await waitFor(() => {
      const el = document.querySelector('[data-handoff="needs_ok"]');
      if (!el) throw new Error('no permission yet');
      return el as HTMLElement;
    });
    expect(within(line).getByText(/git push origin fix\/backup-list/)).toBeTruthy();
    // One Open in T3 Code for it, and no button that approves.
    expect(screen.getAllByRole('link', { name: /Open in T3 Code/ })).toHaveLength(1);
    expect(document.querySelector('[data-job-details]')?.querySelector('[data-handoff-open]')).toBeNull();
  });

  it('sends T3 Code a message with Enter, and closes with Escape', async () => {
    const user = userEvent.setup();
    open(CODE_JOB_THREADS.editing);
    await user.click(await screen.findByRole('button', { name: JOB_WORDS.message.open }));
    const box = screen.getByRole('textbox', { name: JOB_WORDS.message.open });
    await user.type(box, 'Keep the old name in the tooltip{Enter}');
    expect(await screen.findByText(JOB_WORDS.message.sentNow)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: JOB_WORDS.message.open }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: JOB_WORDS.message.open })).toBeNull();
  });

  it('shows no job on a thread with nothing handed to T3 Code', async () => {
    open(CODE_COUNCIL_THREAD);
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    await within(pane).findAllByText(/Can the council look at the Settings page/);
    expect(document.querySelector('[data-job-details]')).toBeNull();
    expect(document.querySelector('[data-job-head]')).toBeNull();
  });

  it('ends with a receipt', async () => {
    open(CODE_JOB_THREADS.merged);
    const receipt = await waitFor(() => {
      const el = document.querySelector('[data-job-receipt]');
      if (!el) throw new Error('no receipt yet');
      return el as HTMLElement;
    });
    expect(within(receipt).getByText(JOB_WORDS.receipt.title.merged)).toBeTruthy();
    expect(within(receipt).getByText(JOB_WORDS.receipt.testsPassed)).toBeTruthy();
    expect(within(receipt).getByRole('link', { name: 'Pull request #47 merged' })).toBeTruthy();
    // The receipt says the pull request: no line of its own any more.
    expect(document.querySelector('[data-job-pull-request]')).toBeNull();
    // Ended: no steer box, and the plan folds.
    expect(screen.queryByRole('button', { name: JOB_WORDS.message.open })).toBeNull();
    expect(screen.getByRole('button', { name: /Plan/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('opens T3 Code’s whole answer under the receipt', async () => {
    const user = userEvent.setup();
    open(CODE_JOB_THREADS.merged);
    const read = await screen.findByRole('button', { name: JOB_WORDS.answer.read });
    // Folded until asked for.
    expect(read.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('What changed')).toBeNull();
    await user.click(read);
    const receipt = document.querySelector('[data-job-receipt]') as HTMLElement;
    // Its markdown is drawn: a bold heading, a list.
    expect(within(receipt).getByText('What changed').tagName).toBe('STRONG');
    expect(within(receipt).getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
    await user.click(screen.getByRole('button', { name: JOB_WORDS.answer.hide }));
    expect(screen.queryByText('What changed')).toBeNull();
  });

  it('offers no answer while the job works', async () => {
    open(CODE_JOB_THREADS.editing);
    await screen.findByRole('button', { name: JOB_WORDS.message.open });
    expect(screen.queryByRole('button', { name: JOB_WORDS.answer.read })).toBeNull();
  });
});
