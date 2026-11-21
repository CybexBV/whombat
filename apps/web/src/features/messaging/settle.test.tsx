/**
 * Cards that settle into a line in the conversation (docs/decisions/card-settle.md AP-730…AP-735): what a run did
 * inside it, the compact live card and the stuck run's card, Cancel on a schedule's line, what the agent does beside
 * “is thinking”, and work in a thread's reply row — over the settled cards' fixture world (`settleFixtures.ts`).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Message, MessageCard } from '@whombat/core';
import { dusty, run as fixtureRun, mara } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_NAME } from '../../app/oneFixtures';
import { fixtureServices, renderApp } from '../../test/renderApp';
import { MessageList } from './MessageList';
import { foldMessages } from './model';

const settled = () => fixtureServices({ settle: true });

function message(id: string, card: MessageCard | null, extra: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: 'cnv_pr482',
    authorId: dusty.id,
    createdAt: '2026-09-23T09:20:00.000Z',
    editedAt: null,
    text: id,
    mentions: [],
    card,
    suggestions: [],
    more: null,
    attachments: [],
    reactions: [],
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
    ...extra,
  };
}

const done = { ...fixtureRun, status: 'done' as const, finishedAt: '2026-09-23T09:30:00.000Z' };
const scheduled = (runId: string): MessageCard =>
  ({
    kind: 'schedule',
    scheduleId: 'sch_x',
    runId,
    schedule: {
      status: 'active',
      endedReason: null,
      when: { kind: 'at', at: '2026-09-24T07:00:00.000Z' },
      prompt: 'Check the invoice again.',
    },
  }) as unknown as MessageCard;

describe('what a run did, inside the run (AP-732)', () => {
  it('leaves the schedule’s message out of the list and hands it to its run, keeping its id there for jumps', () => {
    const messages = [
      message('msg_run', { kind: 'run', run: done }),
      message('msg_sched', scheduled(done.id)),
      message('msg_after', null),
    ];
    render(
      <MessageList
        messages={messages}
        lookup={(id) => (id === dusty.id ? dusty : id === mara.id ? mara : undefined)}
        timeZone="Europe/Amsterdam"
        now={new Date('2026-09-23T10:00:00.000Z')}
        renderCard={(m, inside) => (
          <div data-testid={`card-${m.id}`}>
            {inside?.map((n) => (
              <span key={n.id} id={n.id}>
                inside {n.id}
              </span>
            ))}
          </div>
        )}
      />,
    );
    // Two rows, not three: the schedule shows in the run's card slot, with the message's id for links and the pins pane.
    expect(document.querySelectorAll('[data-message-row]')).toHaveLength(2);
    expect(screen.getByTestId('card-msg_run').textContent).toBe('inside msg_sched');
    expect(document.getElementById('msg_sched')?.closest('[data-message-row]')?.id).toBe('msg_run');
  });

  it('keeps a message somebody replied to as a row, and a schedule whose run isn’t in the list', () => {
    const run = message('msg_run', { kind: 'run', run: done });
    const replied = message('msg_sched', scheduled(done.id), { replyCount: 2 });
    expect(foldMessages([run, replied]).visible.map((m) => m.id)).toEqual(['msg_run', 'msg_sched']);
    const alone = message('msg_sched', scheduled(done.id));
    expect(foldMessages([alone]).visible.map((m) => m.id)).toEqual(['msg_sched']);
    expect(foldMessages([run, alone]).hidden).toEqual(new Set(['msg_sched']));
  });
});

describe('the report’s thread, settled (AP-730…AP-734)', () => {
  it('shows settled lines, what runs did inside them, the live card, the stuck run’s card and what the agent does', async () => {
    const user = userEvent.setup();
    renderApp('/pr/482?thread=msg_settle-report&focus=1', settled());
    const thread = (await screen.findAllByRole('region', { name: /^Run #31/ }))[0] as HTMLElement;
    expect(thread.dataset.variant).toBe('line');
    expect(thread.textContent).toContain('Run #31 · Done in 6m 12s');
    expect(within(thread).getByRole('link', { name: 'PR #3' })).toBeTruthy();
    expect(thread.textContent).toContain('+12 −8');

    // The schedule is a line inside its run, not a reply of its own.
    expect(document.querySelector('[data-message-id="msg_settle-schedule"]')).toBeNull();
    expect(screen.queryByRole('list', { name: 'What run #31 did' })).toBeNull();
    const did32 = screen.getByRole('list', { name: 'What run #32 did' });
    expect(within(did32).getAllByRole('listitem')).toHaveLength(1);

    expect(screen.getByRole('region', { name: 'Assessment: FB-7K3Q-9M2X' }).textContent).toContain(
      `chose “Hand to ${ASSISTANT_NAME}”`,
    );
    expect(screen.getByRole('region', { name: /^Approval: / }).textContent).toBe(
      'Approved by Mara · Deploy fix/vat-rounding to staging',
    );
    expect(screen.getByRole('region', { name: /^Run #33/ }).dataset.variant).toBe('live');
    // The stuck run is the whole card: its status line says it works, and why it needs a person.
    const stuck = document.querySelector<HTMLElement>(
      'section[data-card="run"]:not([data-variant])',
    ) as HTMLElement;
    expect(stuck.getAttribute('aria-label')).toMatch(/^Working · Run\./);
    expect(within(stuck).getByTestId('run-attention')).toBeTruthy();

    // What the agent does, beside the dots (the clock from 10 s on).
    expect(
      await screen.findByText(new RegExp(`^${ASSISTANT_NAME} · Editing Layout\\.astro · 1m \\d+s$`)),
    ).toBeTruthy();
    expect(screen.getByText(`${ASSISTANT_NAME} · Editing Layout.astro`).className).toMatch(/srOnly/);

    // Cancel on the schedule's line, as the card has it.
    const scheduled = new RegExp(`^${ASSISTANT_NAME} scheduled: `);
    const schedule = within(did32).getByRole('region', { name: scheduled });
    await user.click(within(schedule).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText(`Cancelled. ${ASSISTANT_NAME} won’t run it again.`)).toBeTruthy();
    await waitFor(() =>
      expect(within(did32).getByRole('region', { name: scheduled }).textContent).toMatch(/^Cancelled/),
    );
  });
});

describe('work in a thread’s reply row (AP-735)', () => {
  it('says who needs you, who works and how far, and who thinks', async () => {
    renderApp('/pr/482', settled());
    const report = await screen.findByRole('link', { name: /7 replies/ });
    await waitFor(() => expect(report.textContent).toContain(`${ASSISTANT_NAME} needs you`));
    expect(report.querySelector('[data-thread-work]')?.getAttribute('data-tone')).toBe('warn');
    const ask = screen.getByRole('link', { name: /1 reply/ });
    expect(ask.textContent).toContain(`${ASSISTANT_NAME} is working · 62%`);
    expect(within(ask).getByRole('img', { name: new RegExp(`^${ASSISTANT_NAME}`) })).toBeTruthy();
    // No replies yet, the agent thinking there: the row shows for that alone.
    const thinking = screen.getByRole('link', { name: new RegExp(`${ASSISTANT_NAME} is thinking`) });
    expect(thinking.textContent).toBe(`${ASSISTANT_NAME} is thinking`);
  });
});

describe('reports as rows (docs/decisions/report-rows.md RR-01…RR-07)', () => {
  it('shows each report as one row without its header, and the whole card at the root of its thread', async () => {
    renderApp('/pr/482', settled());
    const bug = await screen.findByRole('region', {
      name: 'Bug report FB-7K3Q-9M2X: Burrow Billing · Triaged · Likely bug',
    });
    expect(bug.dataset.variant).toBe('line');
    expect(within(bug).getByText('Likely bug')).toBeTruthy();
    const feature = screen.getByRole('region', {
      name: 'Feature request FB-H8XM-5VKT: Burrow Billing · New · Feature request',
    });
    expect(feature.dataset.variant).toBe('line');
    // The header the server posts each report with folds into its row.
    expect(screen.queryByText('Bug report FB-7K3Q-9M2X · Burrow Billing')).toBeNull();
    expect(screen.queryByText('Feature request FB-H8XM-5VKT · Burrow Billing')).toBeNull();
    expect(screen.queryByText('BUG REPORT · FB-7K3Q-9M2X')).toBeNull();
  });

  it('shows the whole card at the root of the report’s thread', async () => {
    renderApp('/pr/482?thread=msg_settle-report&focus=1', settled());
    const card = await screen.findByText('BUG REPORT · FB-7K3Q-9M2X');
    const root = card.closest('[data-message-id="msg_settle-report"]') as HTMLElement;
    expect(root).toBeTruthy();
    expect(within(root).queryByText('Bug report FB-7K3Q-9M2X · Burrow Billing')).toBeNull();
    expect(within(root).getByRole('button', { name: 'Details' })).toBeTruthy();
  });
});
