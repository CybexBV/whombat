/**
 * A job's result as a message (job-result mockup): T3 Code's report laid out from its parts, the points left for the
 * person answered together, the state while T3 Code works on them, the folded technical detail; and in the fixture
 * world's Chat thread, under T3 Code's name, beside ordinary messages.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JOB_RESULT_WORDS } from '@whombat/client';
import type { JobResult, Message } from '@whombat/core';
import { JOB_RESULT_REPORT, jobResultFixture } from '@whombat/fixtures';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODE_FIXTURE_KEY, CODE_RESULT_THREADS } from '../../app/codeFixtures';
import { ToastProvider } from '../../components/Toast';
import { fixtureServices, renderApp, testQueryClient } from '../../test/renderApp';
import { JobResultBody } from './JobResult';

const send = vi.hoisted(() => vi.fn());
vi.mock('@whombat/client/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@whombat/client/react')>()),
  useJobAnswers: () => ({ mutateAsync: send, isPending: false }),
}));

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
beforeEach(() => send.mockReset());

const ENDED = '2026-11-16T22:31:32.000Z';
const resultMessage = (over: Partial<JobResult> = {}, id = `msg_result-${Math.random()}`) => ({
  id,
  text: JOB_RESULT_REPORT,
  jobResult: jobResultFixture(ENDED, over),
  deletedAt: null,
});

function show(message: Pick<Message, 'id' | 'text' | 'jobResult' | 'deletedAt'>) {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <ToastProvider>
        <JobResultBody burrow="b" message={message} timeZone="Europe/Amsterdam" />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const L = JOB_RESULT_WORDS.left;

describe('a job’s result', () => {
  it('lays out the report’s parts', () => {
    show(resultMessage());
    expect(screen.getByText(/The cleanup is done/)).toBeTruthy();
    // Each part is a heading.
    for (const title of ['What changed', 'What I decided', 'What the council decided', 'Left for you'])
      expect(screen.getByRole('heading', { name: new RegExp(title) })).toBeTruthy();
    expect(screen.getByText('Backend')).toBeTruthy();
    expect(screen.getAllByText('Removed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Kept').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: /Is retiring the old desktops finished/ })).toBeTruthy();
    // Three points, each with its choices and words.
    expect(screen.getAllByRole('button', { name: L.reply })).toHaveLength(3);
    expect(screen.getByText(JOB_RESULT_WORDS.facts.testsPassed)).toBeTruthy();
    expect(screen.getByRole('link', { name: JOB_RESULT_WORDS.facts.open })).toBeTruthy();
  });

  it('sends the marked choices together', async () => {
    const user = userEvent.setup();
    const m = resultMessage();
    send.mockResolvedValue({ status: 'ok', data: { message: m }, httpStatus: 200 });
    show(m);
    const bar = screen.getByRole('button', { name: L.send(0) });
    expect((bar as HTMLButtonElement).disabled).toBe(true);
    const first = screen.getByRole('group', { name: /moving boxes/ });
    const remove = within(first).getByRole('button', { name: 'Remove' });
    await user.click(remove);
    expect(remove.getAttribute('aria-pressed')).toBe('true');
    // Pressed again, it is taken back; then marked once more.
    await user.click(remove);
    expect(remove.getAttribute('aria-pressed')).toBe('false');
    await user.click(remove);
    const second = screen.getByRole('group', { name: /release details/ });
    await user.click(within(second).getByRole('button', { name: 'Keep it for later' }));
    const sendTwo = screen.getByRole('button', { name: 'Send 2 answers' });
    expect(screen.getByText(/1 still open/)).toBeTruthy();
    await user.click(sendTwo);
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]?.[0] as {
      messageId: string;
      answers: { point: number; choice: string }[];
    };
    expect(sent.messageId).toBe(m.id);
    expect(sent.answers.map((a) => [a.point, a.choice])).toEqual([
      [1, 'Remove'],
      [2, 'Keep it for later'],
    ]);
    // Sent: the marks are cleared.
    await waitFor(() => expect(screen.getByRole('button', { name: L.send(0) })).toBeTruthy());
  });

  it('counts words as a point’s answer', async () => {
    const user = userEvent.setup();
    show(resultMessage());
    const third = screen.getByRole('group', { name: /old desktops/ });
    await user.click(within(third).getByRole('button', { name: L.reply }));
    await user.type(
      screen.getByRole('textbox', { name: L.replyLabel('Is retiring the old desktops finished?') }),
      'Almost',
    );
    expect(screen.getByRole('button', { name: 'Send 1 answer' })).toBeTruthy();
  });

  it('keeps the marks when a send fails', async () => {
    const user = userEvent.setup();
    send.mockRejectedValueOnce(new Error('offline'));
    show(resultMessage());
    const first = screen.getByRole('group', { name: /moving boxes/ });
    await user.click(within(first).getByRole('button', { name: 'Keep' }));
    await user.click(screen.getByRole('button', { name: 'Send 1 answer' }));
    expect(await screen.findByText(L.failed)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send 1 answer' })).toBeTruthy();
  });

  it('says what was chosen while T3 Code is on it, and takes no more answers', () => {
    show(
      resultMessage({
        sends: [
          {
            at: new Date(Date.now() - 2 * 60_000).toISOString(),
            answers: [
              {
                point: 1,
                title: 'Keep the unused groundwork for moving boxes?',
                choice: 'Remove',
                words: null,
              },
              { point: 2, title: 'An unused screen', choice: 'Keep it for later', words: null },
            ],
            doneAt: null,
            outcome: null,
          },
        ],
      }),
    );
    expect(screen.getByText('Remove').closest('span')?.textContent).toMatch(/^You chose Remove/);
    expect(screen.getByText('Keep it for later')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Send/ })).toBeNull();
    expect(screen.getByText(/2 answers sent to T3 Code/)).toBeTruthy();
    // The open point waits until T3 Code is done.
    const third = screen.getByRole('group', { name: /old desktops/ });
    expect((within(third).getByRole('button', { name: 'Not yet' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the technical detail folded until it is opened', async () => {
    const user = userEvent.setup();
    show(resultMessage());
    const toggle = screen.getByRole('button', { name: JOB_RESULT_WORDS.facts.detail });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/database regressions/)).toBeNull();
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/database regressions/)).toBeTruthy();
  });

  it('draws nothing for an ordinary message', () => {
    const { container } = show({ id: 'msg_plain', text: 'Hello', jobResult: null, deletedAt: null });
    expect(container.querySelector('[data-job-result]')).toBeNull();
  });
});

describe('in a Chat thread', () => {
  beforeEach(() => localStorage.setItem(CODE_FIXTURE_KEY, 'jobs'));

  it('shows the report under T3 Code’s name, and the other messages as they are', async () => {
    renderApp(`/chat?thread=${CODE_RESULT_THREADS.result}`, fixtureServices({ code: true }));
    const report = await waitFor(() => {
      const el = document.querySelector('[data-job-result]');
      if (!el) throw new Error('no report yet');
      return el as HTMLElement;
    });
    const row = report.closest('[data-message-row]') as HTMLElement;
    expect(row.getAttribute('aria-label')).toMatch(/^T3 Code,/);
    expect(within(row).getByRole('img', { name: JOB_RESULT_WORDS.author })).toBeTruthy();
    // Only the report is laid out as one; Dusty's line before it is an ordinary message.
    expect(document.querySelectorAll('[data-job-result]')).toHaveLength(1);
    expect(screen.getAllByText(/Its report will appear here/).length).toBeGreaterThan(0);
    // The ended job draws no receipt or line of its own.
    expect(document.querySelector('[data-job-details]')).toBeNull();
    expect(document.querySelector('[data-handoff]')).toBeNull();
  });
});
