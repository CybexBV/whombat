/**
 * The delegation card on the web (Whombat delegate.md): the checklist with its ticks (shown at once, taken back when the
 * tick doesn't go through), Hand over N only with something ticked, the rows of the tasks that work, wait or need a look
 * with where they are, what they do now, their pull request, pictures and ⋯ menu, the finished ones folded into one line,
 * Stop and Stop this task asking first, and the ended card. Over the fixture world's delegations
 * (`delegationFixtures.ts`), which answer the buttons as the server does.
 */
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CARD_FRAME_WORDS, DELEGATION_AI_WORDS, DELEGATION_WORDS } from '@whombat/client';
import type { Attachment, DelegationCard, DelegationCardTask } from '@whombat/core';
import { burrow } from '@whombat/fixtures';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DELEGATION_OFFER_THREAD,
  DELEGATION_SHOT_ID,
  DELEGATION_WORKING_THREAD,
} from '../../app/delegationFixtures';
import { ASSISTANT_NAME, WHOMBAT_ID } from '../../app/oneFixtures';
import { Providers } from '../../app/providers';
import { jsonAnswer, type RecordedCall, recordingWorld } from '../../test/recordingWorld';
import { mockedServices, renderApp } from '../../test/renderApp';
import { MessageCard } from './MessageCard';

const B = `/burrows/${burrow.slug}`;

beforeAll(() => {
  // Pictures arrive as object URLs (the session's downloads); jsdom has none.
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:task-shot'), revokeObjectURL: vi.fn() });
});
// The fixture world's checklist (the Files space) and its tasks: Stop, Hand over and the ticks find them there.
const OFFER_ID = 'dlg_fixturefiles' as DelegationCard['delegationId'];
const WORKING_ID = 'dlg_fixturesettings' as DelegationCard['delegationId'];

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

// Task ids as the fixture world has them: `dlt_files1` is the checklist's first, `dlt_settings1` the one at work.
const task = (n: number, over: Partial<DelegationCardTask> = {}, name = 'files'): DelegationCardTask => ({
  id: `dlt_${name}${n}` as DelegationCardTask['id'],
  n,
  title: `Task ${n}`,
  why: null,
  picked: true,
  after: null,
  state: 'offered',
  pending: null,
  step: null,
  program: null,
  since: null,
  endedAt: null,
  url: null,
  branch: null,
  pr: null,
  note: null,
  ...over,
});

const delegation = (over: Partial<DelegationCard> = {}): DelegationCard => ({
  kind: 'delegation',
  delegationId: OFFER_ID,
  title: 'Smooth out the Files space',
  project: 'Whombat',
  stage: 'offer',
  live: true,
  atOnce: 3,
  pullRequests: true,
  tasks: [
    task(1, { title: 'Drag files in', why: 'Upload is one by one now.' }),
    task(2, { title: 'Show how full it is' }),
    task(3, { title: 'Previews for PDFs', picked: false }),
    task(4, { title: 'Undo a delete', after: 1 }),
  ],
  outcome: null,
  note: null,
  startedAt: minutesAgo(2),
  handedAt: null,
  endedAt: null,
  ...over,
});

const SHOT_FILE: Attachment = {
  id: DELEGATION_SHOT_ID as Attachment['id'],
  name: 'settings-buttons.png',
  contentType: 'image/png',
  size: 1200,
  url: `/api/v1/burrows/${burrow.slug}/attachments/${DELEGATION_SHOT_ID}`,
  kind: 'image',
  width: 480,
  height: 600,
};

const working = () =>
  delegation({
    delegationId: WORKING_ID,
    title: 'Polish the Settings page',
    stage: 'working',
    handedAt: minutesAgo(30),
    tasks: [
      task(
        1,
        {
          title: 'Taller buttons',
          state: 'working',
          program: 'Codex',
          step: 'Running the tests',
          since: minutesAgo(12),
          url: 'http://thetitan:3773/env-1/buttons',
          pr: 'https://github.com/acmehq/whombat/pull/819',
          shots: [
            {
              view: 'Settings · light',
              attachmentId: SHOT_FILE.id,
              width: 480,
              height: 600,
              areas: 2,
              notes: [
                { n: 2, text: 'The buttons are taller.' },
                { n: 1, text: 'The sections line up.' },
              ],
            },
          ],
        },
        'settings',
      ),
      task(
        2,
        { title: 'Plainer names', state: 'working', pending: 'question', since: minutesAgo(12) },
        'settings',
      ),
      task(
        3,
        {
          title: 'Save as you go',
          state: 'done',
          program: 'Claude',
          since: minutesAgo(30),
          endedAt: minutesAgo(9),
          url: 'http://thetitan:3773/env-1/save',
          pr: 'https://github.com/acmehq/whombat/pull/820',
          note: 'Each change says Saved now.',
        },
        'settings',
      ),
      task(4, { title: 'Search box', state: 'offered', picked: false }, 'settings'),
      task(5, { title: 'Shortcuts', state: 'queued', after: 1 }, 'settings'),
      task(
        6,
        {
          title: 'Dark colours',
          state: 'working',
          checks: 'running',
          since: minutesAgo(6),
          pr: 'https://github.com/acmehq/whombat/pull/823',
        },
        'settings',
      ),
      task(
        7,
        {
          title: 'Open sections',
          state: 'done',
          checks: 'failing',
          since: minutesAgo(20),
          endedAt: minutesAgo(2),
          pr: 'https://github.com/acmehq/whombat/pull/824',
        },
        'settings',
      ),
    ],
  });

function renderCard(
  card: DelegationCard,
  answer?: (call: RecordedCall, response: Response) => Response | Promise<Response>,
  attachments?: readonly Attachment[],
) {
  const { fetch, calls } = recordingWorld({ delegation: 'all' }, answer);
  const history = createMemoryHistory({ initialEntries: ['/chat'] });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <MessageCard
          burrow={burrow.slug}
          card={card}
          messageId="msg_delegation"
          conversationId="cnv_chat"
          authorId={WHOMBAT_ID}
          attachments={attachments}
        />
      ),
    }),
    history,
  });
  render(
    <Providers services={mockedServices(fetch)}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { calls };
}

const findCard = () => screen.findByRole('region', { name: / · Tasks\. / });
const rowsOf = (card: HTMLElement) =>
  [...card.querySelectorAll<HTMLElement>('[data-task]')].filter((r) => !r.closest('[data-card-details]'));
/** The tasks' records under Details: what each does now, its AI, pull request, pictures and ⋯ menu. */
const recordsOf = (card: HTMLElement) => [
  ...card.querySelectorAll<HTMLElement>('[data-card-details] [data-task]'),
];
const openDetails = (user: ReturnType<typeof userEvent.setup>, card: HTMLElement) =>
  user.click(within(card).getByText(CARD_FRAME_WORDS.details));

describe('choosing the AI on the checklist', () => {
  const OPUS = {
    provider: 'claudeAgent',
    model: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    effort: 'xhigh',
    fast: null,
  };

  it('chooses a task’s model, effort and Fast from its chip, and shows it at once', async () => {
    const user = userEvent.setup();
    const { calls } = renderCard(delegation({ ai: null }));
    const card = await findCard();
    // Each task's AI is under Details.
    expect(
      within(card).queryByRole('button', { name: DELEGATION_AI_WORDS.openTask('Drag files in', null) }),
    ).toBeNull();
    await openDetails(user, card);
    await user.click(
      within(card).getByRole('button', { name: DELEGATION_AI_WORDS.openTask('Drag files in', null) }),
    );
    const menu = await screen.findByRole('dialog', { name: /AI for task 1/ });
    await user.click(await within(menu).findByRole('radio', { name: /GPT 6\.1 Sol/ }));
    await user.click(within(menu).getByRole('radio', { name: 'High' }));
    // Sol runs fast unless told: the switch shows it on.
    expect(
      within(menu).getByRole('switch', { name: DELEGATION_AI_WORDS.fast }).getAttribute('aria-checked'),
    ).toBe('true');
    await user.click(within(menu).getByRole('button', { name: DELEGATION_AI_WORDS.done }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: 'POST',
          path: `${B}/delegations/ai`,
          body: {
            delegationId: OFFER_ID,
            taskId: 'dlt_files1',
            ai: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', fast: true },
          },
        },
      ]),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      within(card).getByRole('button', {
        name: DELEGATION_AI_WORDS.openTask('Drag files in', 'GPT 6.1 Sol · High · Fast'),
      }),
    ).toBeTruthy();
  });

  it('chooses every task’s from Hand over’s arrow; a task with its own keeps it', async () => {
    const user = userEvent.setup();
    const tasks = delegation().tasks.map((t) => (t.n === 2 ? { ...t, ai: OPUS } : { ...t, ai: null }));
    const { calls } = renderCard(delegation({ ai: null, tasks }));
    const card = await findCard();
    await user.click(within(card).getByRole('button', { name: DELEGATION_AI_WORDS.openAll(null) }));
    const menu = await screen.findByRole('dialog', { name: DELEGATION_AI_WORDS.allTitle });
    expect(menu.textContent).toContain(DELEGATION_AI_WORDS.allCount(2, 3));
    await user.click(await within(menu).findByRole('radio', { name: /^GPT 6\.1\s*Codex$/ }));
    // No fast tier on this one.
    expect(within(menu).queryByRole('switch')).toBeNull();
    await user.click(within(menu).getByRole('button', { name: DELEGATION_AI_WORDS.done }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: 'POST',
          path: `${B}/delegations/ai`,
          body: {
            delegationId: OFFER_ID,
            ai: { provider: 'codex', model: 'gpt-6.1', effort: null, fast: null },
          },
        },
      ]),
    );
    expect(card.textContent).toContain(DELEGATION_AI_WORDS.others('GPT 6.1'));
    await openDetails(user, card);
    expect(
      within(card).getByRole('button', {
        name: DELEGATION_AI_WORDS.openTask('Show how full it is', 'Claude Opus 5.5 · Extra high'),
      }),
    ).toBeTruthy();
  });

  it('leaves a choice as it was on Escape', async () => {
    const user = userEvent.setup();
    const { calls } = renderCard(delegation({ ai: null }));
    const card = await findCard();
    await user.click(within(card).getByRole('button', { name: DELEGATION_AI_WORDS.openAll(null) }));
    await user.click(
      await within(await screen.findByRole('dialog')).findByRole('radio', { name: /Claude Opus 5\.5/ }),
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('has no AI buttons on an older Whombat’s card', async () => {
    renderCard(delegation());
    const card = await findCard();
    expect(within(card).queryByRole('button', { name: /^AI for/ })).toBeNull();
    expect(within(card).getByRole('button', { name: DELEGATION_WORDS.handOver(3) })).toBeTruthy();
  });
});

describe('the checklist', () => {
  it('lists each task with its checkbox, number, reason and what it starts after', async () => {
    renderCard(delegation());
    const card = await findCard();
    expect(card.dataset.stage).toBe('offer');
    expect(card.textContent).toContain('Smooth out the Files space');
    expect(card.textContent).toContain('3 of 4');
    const boxes = within(card).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, true, false, true]);
    expect(within(card).getByRole('checkbox', { name: DELEGATION_WORDS.tick('Drag files in') })).toBeTruthy();
    const [one, , , four] = rowsOf(card);
    expect(one?.textContent).toContain('Upload is one by one now.');
    expect(four?.textContent).toContain(DELEGATION_WORDS.after(1));
    expect(within(card).getByRole('button', { name: DELEGATION_WORDS.handOver(3) })).toBeTruthy();
    expect(within(card).getByRole('button', { name: DELEGATION_WORDS.change })).toBeTruthy();
    expect(within(card).getByRole('button', { name: DELEGATION_WORDS.notNow })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: DELEGATION_WORDS.stop })).toBeNull();
  });

  it('ticks at once and tells the server', async () => {
    const user = userEvent.setup();
    const { calls } = renderCard(delegation());
    const card = await findCard();
    const pdf = within(card).getByRole('checkbox', { name: DELEGATION_WORDS.tick('Previews for PDFs') });
    await user.click(pdf);
    expect((pdf as HTMLInputElement).checked).toBe(true);
    expect(within(card).getByRole('button', { name: DELEGATION_WORDS.handOver(4) })).toBeTruthy();
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: 'POST',
          path: `${B}/delegations/pick`,
          body: { delegationId: OFFER_ID, taskId: 'dlt_files3', picked: true },
        },
      ]),
    );
  });

  it('takes a tick back when it doesn’t go through', async () => {
    const user = userEvent.setup();
    renderCard(delegation(), (call, res) => {
      // Refused without words of its own: the card's.
      if (call.path.endsWith('/delegations/pick'))
        return jsonAnswer({ error: { code: 'conflict', message: '' } }, 409);
      return res;
    });
    const card = await findCard();
    const one = within(card).getByRole('checkbox', { name: DELEGATION_WORDS.tick('Drag files in') });
    await user.click(one);
    expect(await screen.findByText(DELEGATION_WORDS.failed.pick)).toBeTruthy();
    expect((one as HTMLInputElement).checked).toBe(true);
  });

  it('can’t hand over nothing', async () => {
    renderCard(delegation({ tasks: [task(1, { picked: false }), task(2, { picked: false })] }));
    const card = await findCard();
    const hand = within(card).getByRole('button', {
      name: DELEGATION_WORDS.handOver(0),
    }) as HTMLButtonElement;
    expect(hand.disabled).toBe(true);
  });

  it('Hand over starts the ticked ones, once', async () => {
    const user = userEvent.setup();
    const { calls } = renderCard(delegation());
    const card = await findCard();
    await user.click(within(card).getByRole('button', { name: DELEGATION_WORDS.handOver(3) }));
    await waitFor(() =>
      expect(calls).toEqual([
        { method: 'POST', path: `${B}/delegations/start`, body: { delegationId: OFFER_ID } },
      ]),
    );
    // It went through: the buttons wait for the card to move on.
    await waitFor(() =>
      expect(
        (within(card).getByRole('button', { name: DELEGATION_WORDS.notNow }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
  });

  it('Not now stops it without asking', async () => {
    const user = userEvent.setup();
    const { calls } = renderCard(delegation());
    const card = await findCard();
    await user.click(within(card).getByRole('button', { name: DELEGATION_WORDS.notNow }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() =>
      expect(calls).toEqual([
        { method: 'POST', path: `${B}/delegations/stop`, body: { delegationId: OFFER_ID } },
      ]),
    );
  });

  it('Change something puts the cursor in the thread’s reply box', async () => {
    const user = userEvent.setup();
    const { fetch } = recordingWorld({ delegation: 'offer' });
    renderApp(`/chat?thread=${DELEGATION_OFFER_THREAD}&focus=1`, mockedServices(fetch));
    const card = await findCard();
    await user.click(within(card).getByRole('button', { name: DELEGATION_WORDS.change }));
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
  });
});

describe('the tasks at work', () => {
  it('draws a row per task that works, waits or needs a look, and folds the finished ones into one line', async () => {
    const user = userEvent.setup();
    renderCard(working());
    const card = await findCard();
    expect(card.dataset.stage).toBe('working');
    expect(within(card).queryAllByRole('checkbox')).toHaveLength(0);
    // How far it is, in words.
    expect(card.textContent).toContain('1 finished');
    expect(card.textContent).toContain('still in progress');
    // Not handed over: off the card. Finished: folded away.
    expect(rowsOf(card).map((r) => r.dataset.task)).toEqual([
      'dlt_settings1',
      'dlt_settings2',
      'dlt_settings5',
      'dlt_settings6',
      'dlt_settings7',
    ]);
    const fold = within(card).getByRole('button', { name: /^1 done/ });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(fold.getAttribute('aria-label')).toContain(DELEGATION_WORDS.showFolded);
    await user.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(fold.getAttribute('aria-label')).toContain(DELEGATION_WORDS.hideFolded);
    const three = card.querySelector<HTMLElement>('[data-task="dlt_settings3"]') as HTMLElement;
    expect(three.dataset.done).toBeDefined();
    await user.click(fold);
    expect(card.querySelector('[data-task="dlt_settings3"]')).toBeNull();
    // Its record, with the agent's line and its pull request, is under Details (Open tasks opens it).
    await user.click(within(card).getByRole('button', { name: CARD_FRAME_WORDS.openTasks }));
    const record = card.querySelector<HTMLElement>(
      '[data-card-details] [data-task="dlt_settings3"]',
    ) as HTMLElement;
    expect(record.textContent).toContain('Each change says Saved now.');
    expect(
      within(record).getByRole('link', { name: DELEGATION_WORDS.pullRequest }).getAttribute('href'),
    ).toBe('https://github.com/acmehq/whombat/pull/820');
    expect(within(card).queryByRole('button', { name: /^Hand over/ })).toBeNull();
  });

  it('says where each one is: at work, asking the assistant, after another, waiting for checks, checks failing', async () => {
    const user = userEvent.setup();
    renderCard(working());
    const card = await findCard();
    // What it does now, the AI on it and how long it worked are in its record under Details.
    expect(rowsOf(card)[0]?.textContent).not.toContain('Running the tests');
    await openDetails(user, card);
    const [one, two, five, six, seven] = recordsOf(card) as HTMLElement[];
    expect(one?.dataset.working).toBeDefined();
    expect(one?.textContent).toContain(DELEGATION_WORDS.states.working);
    expect(one?.textContent).toContain('Running the tests');
    expect(one?.textContent).toContain('Codex');
    expect(one?.textContent).toContain('12 min');
    expect(within(one as HTMLElement).getByRole('img', { name: /Taller buttons: working/ })).toBeTruthy();
    expect(one?.querySelector('[class*="ring"]')).toBeTruthy();
    // A question the assistant answers itself is quiet: the card's author by name (once names are in), nothing to do.
    await waitFor(() =>
      expect(two?.textContent).toContain(DELEGATION_WORDS.pending.question(ASSISTANT_NAME)),
    );
    expect(two?.dataset.attention).toBeUndefined();
    expect(five?.textContent).toContain(DELEGATION_WORDS.after(1));
    // Waiting for its checks: no ring, it holds no place.
    expect(six?.dataset.working).toBeUndefined();
    expect(six?.querySelector('[class*="ring"]')).toBeNull();
    expect(six?.textContent).toContain(DELEGATION_WORDS.checks.running);
    expect(seven?.dataset.attention).toBeDefined();
    expect(seven?.textContent).toContain(DELEGATION_WORDS.checks.failing);
  });

  it('keeps Pull request on the task’s record and the thread and Stop this task in its ⋯ menu', async () => {
    const user = userEvent.setup();
    renderCard(working());
    const card = await findCard();
    await openDetails(user, card);
    const [one, , five, six] = recordsOf(card) as HTMLElement[];
    const row = within(one as HTMLElement);
    expect(row.getByRole('link', { name: DELEGATION_WORDS.pullRequest }).getAttribute('href')).toBe(
      'https://github.com/acmehq/whombat/pull/819',
    );
    expect(row.queryByRole('link', { name: DELEGATION_WORDS.openThread })).toBeNull();
    expect(row.queryByRole('button', { name: DELEGATION_WORDS.stopTask })).toBeNull();
    const more = row.getByRole('button', { name: DELEGATION_WORDS.more('Taller buttons') });
    await user.click(more);
    const items = within(await screen.findByRole('menu'))
      .getAllByRole('menuitem')
      .map((i) => i.textContent);
    expect(items).toEqual([DELEGATION_WORDS.openThread, DELEGATION_WORDS.stopTask]);
    await user.keyboard('{Escape}');
    // Waiting its turn, with no thread yet: only Stop this task.
    await user.click(within(five as HTMLElement).getByRole('button', { name: /^More for/ }));
    expect(
      within(await screen.findByRole('menu'))
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual([DELEGATION_WORDS.stopTask]);
    await user.keyboard('{Escape}');
    expect(within(six as HTMLElement).getByRole('button', { name: /^More for/ })).toBeTruthy();
  });

  it('has no ⋯ where it would be empty', async () => {
    const user = userEvent.setup();
    renderCard(
      delegation({
        delegationId: WORKING_ID,
        stage: 'working',
        handedAt: minutesAgo(30),
        tasks: [
          task(1, { state: 'failed', since: minutesAgo(30), endedAt: minutesAgo(3) }),
          task(2, { state: 'working', since: minutesAgo(3), url: 'http://thetitan:3773/env-1/two' }),
        ],
      }),
    );
    const card = await findCard();
    await openDetails(user, card);
    const [one, two] = recordsOf(card) as HTMLElement[];
    expect(within(one as HTMLElement).queryByRole('button', { name: /^More for/ })).toBeNull();
    expect(within(two as HTMLElement).getByRole('button', { name: /^More for/ })).toBeTruthy();
  });

  it('opens a task’s pictures under its row, with the hint and the notes in their numbers’ order', async () => {
    const user = userEvent.setup();
    renderCard(working(), undefined, [SHOT_FILE]);
    const card = await findCard();
    await openDetails(user, card);
    const [one] = recordsOf(card) as HTMLElement[];
    const toggle = within(one as HTMLElement).getByRole('button', { name: DELEGATION_WORDS.pictures(1) });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(card).queryByRole('figure')).toBeNull();
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const shot = within(one as HTMLElement).getByRole('figure');
    expect(shot.textContent).toContain('Settings · light');
    expect(await within(shot).findByRole('img', { name: 'Settings · light' })).toBeTruthy();
    expect(shot.textContent).toContain(DELEGATION_WORDS.picturesHint);
    expect(
      within(shot)
        .getAllByRole('listitem')
        .map((n) => n.getAttribute('value')),
    ).toEqual(['1', '2']);
  });

  it('shows the pictures once: the message’s files leave them out', async () => {
    const user = userEvent.setup();
    const { fetch } = recordingWorld({ delegation: 'working' });
    renderApp(`/chat?thread=${DELEGATION_WORKING_THREAD}&focus=1`, mockedServices(fetch));
    const card = await findCard();
    await openDetails(user, card);
    await user.click(await within(card).findByRole('button', { name: DELEGATION_WORDS.pictures(1) }));
    expect(await within(card).findByRole('img', { name: 'Settings · light' })).toBeTruthy();
    expect(screen.getAllByRole('img', { name: 'Settings · light' })).toHaveLength(1);
    expect(screen.queryByRole('img', { name: 'settings-buttons.png' })).toBeNull();
  });

  it('asks before Stop: Keep going leaves it, Stop stops it all', async () => {
    const user = userEvent.setup();
    const { calls } = renderCard(working());
    const card = await findCard();
    await user.click(within(card).getByRole('button', { name: DELEGATION_WORDS.stop }));
    const ask = await screen.findByRole('dialog', { name: DELEGATION_WORDS.stopAsk.title });
    await user.click(within(ask).getByRole('button', { name: DELEGATION_WORDS.stopAsk.keep }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls).toEqual([]);

    await user.click(within(card).getByRole('button', { name: DELEGATION_WORDS.stop }));
    const again = await screen.findByRole('dialog', { name: DELEGATION_WORDS.stopAsk.title });
    await user.click(within(again).getByRole('button', { name: DELEGATION_WORDS.stop }));
    await waitFor(() =>
      expect(calls).toEqual([
        { method: 'POST', path: `${B}/delegations/stop`, body: { delegationId: WORKING_ID } },
      ]),
    );
  });

  it('asks before stopping one task from its menu', async () => {
    const user = userEvent.setup();
    const { calls } = renderCard(working());
    const card = await findCard();
    await openDetails(user, card);
    const [one] = recordsOf(card);
    await user.click(within(one as HTMLElement).getByRole('button', { name: /^More for/ }));
    await user.click(await screen.findByRole('menuitem', { name: DELEGATION_WORDS.stopTask }));
    const ask = await screen.findByRole('dialog', { name: DELEGATION_WORDS.stopTaskAsk.title });
    expect(calls).toEqual([]);
    await user.click(within(ask).getByRole('button', { name: DELEGATION_WORDS.stop }));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          method: 'POST',
          path: `${B}/delegations/stop-task`,
          body: { delegationId: WORKING_ID, taskId: 'dlt_settings1' },
        },
      ]),
    );
  });
});

describe('the ended card', () => {
  it('says how it ended, keeps what needs a look in view and has nothing to stop', async () => {
    renderCard(
      delegation({
        delegationId: WORKING_ID,
        stage: 'done',
        live: false,
        outcome: 'incomplete',
        handedAt: minutesAgo(60),
        endedAt: minutesAgo(5),
        tasks: [
          task(1, {
            state: 'done',
            since: minutesAgo(60),
            endedAt: minutesAgo(20),
            pr: 'https://x.test/pr/1',
          }),
          task(2, { state: 'failed', since: minutesAgo(60), endedAt: minutesAgo(10) }),
        ],
      }),
    );
    const card = await findCard();
    expect(card.dataset.variant).toBe('final');
    expect(card.textContent).toContain(DELEGATION_WORDS.doneSome(1));
    const [two] = rowsOf(card);
    expect(two?.dataset.attention).toBeDefined();
    expect(two?.textContent).toContain(DELEGATION_WORDS.states.failed);
    // The folded line of the one that finished and Open tasks, nothing to stop.
    expect(within(card).getByRole('button', { name: /^1 / }).getAttribute('aria-expanded')).toBe('false');
    expect(within(card).getByRole('button', { name: CARD_FRAME_WORDS.openTasks })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: DELEGATION_WORDS.stop })).toBeNull();
  });
});
