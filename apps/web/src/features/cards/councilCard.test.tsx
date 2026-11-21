/**
 * The council card on the web: each member an elder at the table
 * with its plaque (its provider's mark or letter, how it is doing) and its answer to open, the plan folded once agreed with its tasks on the
 * checklist under the card (Hand over there is the go-ahead), Stop asking first, the final card's table, plan and picture
 * with its numbered notes, and the card's picture not shown again among the message's files. Over the fixture world's
 * councils (`councilFixtures.ts`), which answer Stop and the checklist's buttons as the server does.
 */
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CARD_FRAME_WORDS,
  COUNCIL_WORDS,
  councilSteps,
  DELEGATION_WORDS,
  MOVED_CARD_WORDS,
} from '@whombat/client';
import {
  type Attachment,
  COUNCIL_CARD_ANSWER_MAX,
  type CouncilCard,
  type CouncilCardMember,
} from '@whombat/core';
import { burrow } from '@whombat/fixtures';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  COUNCIL_AGAIN_THREAD,
  COUNCIL_CHECKLIST_THREAD,
  COUNCIL_FINAL_THREAD,
  COUNCIL_MOVED_THREAD,
  COUNCIL_SHOT_ID,
  COUNCIL_SHOT_URL,
} from '../../app/councilFixtures';
import { Providers } from '../../app/providers';
import { jsonAnswer, type RecordedCall, recordingWorld } from '../../test/recordingWorld';
import { mockedServices, renderApp } from '../../test/renderApp';
import { MessageCard } from './MessageCard';

const B = `/burrows/${burrow.slug}`;

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // Pictures arrive as object URLs (the session's downloads); jsdom has none.
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:council-shot'), revokeObjectURL: vi.fn() });
});

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const member = (over: Partial<CouncilCardMember>): CouncilCardMember => ({
  id: 'cnm_test1',
  name: 'Claude Opus 5.5',
  provider: 'Claude',
  mark: 'claude',
  role: 'member',
  state: 'working',
  score: null,
  verdict: null,
  since: minutesAgo(12),
  endedAt: null,
  step: null,
  url: null,
  answer: null,
  ...over,
});

const council = (over: Partial<CouncilCard> = {}): CouncilCard => ({
  kind: 'council',
  // The fixture world's NAS council: Stop finds it there.
  councilId: 'cnl_fixturenas' as CouncilCard['councilId'],
  what: 'research',
  title: 'Back up the NAS offsite',
  stage: 'research',
  round: 1,
  roundsMax: 3,
  target: null,
  live: true,
  members: [
    member({}),
    member({
      id: 'cnm_test2',
      name: 'GPT 6.1 Sol',
      provider: 'Codex',
      mark: 'openai',
      state: 'done',
      score: 8,
      endedAt: minutesAgo(2),
    }),
    member({
      id: 'cnm_test3',
      name: 'Muse Wonder',
      provider: 'Muse Code',
      mark: null,
      state: 'no_answer',
      endedAt: minutesAgo(1),
    }),
  ],
  history: [],
  plan: null,
  shots: [],
  outcome: null,
  startedAt: minutesAgo(13),
  endedAt: null,
  ...over,
});

/** The plan they agreed on: its tasks are on the checklist card under this one (CNL-60). */
const building = () =>
  council({
    councilId: 'cnl_fixtureinbox' as CouncilCard['councilId'],
    what: 'improve',
    title: 'Improve the Inbox',
    stage: 'build',
    target: 9,
    members: [
      member({ state: 'done', verdict: 'agree', endedAt: minutesAgo(3), answer: 'I agree with the plan.' }),
      member({
        id: 'cnm_test2',
        name: 'GPT 6.1 Sol',
        provider: 'Codex',
        mark: 'openai',
        state: 'done',
        verdict: 'agree',
      }),
    ],
    history: [
      {
        stage: 'research',
        round: 1,
        members: [
          {
            name: 'Claude Opus 5.5',
            provider: 'Claude',
            mark: 'claude',
            state: 'done',
            score: 6,
            verdict: null,
          },
          { name: 'GPT 6.1 Sol', provider: 'Codex', mark: 'openai', state: 'done', score: 7, verdict: null },
        ],
      },
    ],
    plan: '1. **Taller rows** so they are easy to tap.\n2. **Plainer words**.',
  });

const SHOT: Attachment = {
  id: COUNCIL_SHOT_ID as Attachment['id'],
  name: 'settings-light.png',
  contentType: 'image/png',
  size: 1200,
  url: COUNCIL_SHOT_URL,
  kind: 'image',
  width: 480,
  height: 600,
};

const final = (): CouncilCard =>
  council({
    councilId: 'cnl_fixturesettings' as CouncilCard['councilId'],
    what: 'improve',
    title: 'Improve the Settings page',
    stage: 'done',
    live: false,
    outcome: 'done',
    target: 9,
    members: [],
    history: [
      {
        stage: 'research',
        round: 1,
        members: [
          {
            name: 'Claude Opus 5.5',
            provider: 'Claude',
            mark: 'claude',
            state: 'done',
            score: 6,
            verdict: null,
          },
          {
            name: 'Muse Wonder',
            provider: 'Muse Code',
            mark: null,
            state: 'done',
            score: 6.5,
            verdict: null,
          },
        ],
      },
      {
        stage: 'check',
        round: 1,
        members: [
          {
            name: 'Claude Opus 5.5',
            provider: 'Claude',
            mark: 'claude',
            state: 'done',
            score: 9,
            verdict: 'agree',
          },
          {
            name: 'Muse Wonder',
            provider: 'Muse Code',
            mark: null,
            state: 'done',
            score: 9.5,
            verdict: 'agree',
          },
        ],
      },
    ],
    plan: '1. **Taller buttons**.',
    shots: [
      {
        view: 'Settings · light',
        attachmentId: SHOT.id,
        width: 480,
        height: 600,
        areas: 2,
        notes: [
          { n: 2, text: 'The buttons are taller.' },
          { n: 1, text: '“System” is now “This Whombat”.' },
        ],
      },
    ],
    endedAt: minutesAgo(1),
  });

function renderCard(
  card: CouncilCard,
  answer?: (call: RecordedCall, response: Response) => Response | Promise<Response>,
  attachments?: readonly Attachment[],
) {
  const { fetch, calls } = recordingWorld({ council: true }, answer);
  const history = createMemoryHistory({ initialEntries: ['/chat'] });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <MessageCard
          burrow={burrow.slug}
          card={card}
          messageId="msg_council"
          conversationId="cnv_chat"
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
  return { calls, history };
}

const findCard = () => screen.findByRole('region', { name: / · Council\. / });
/** Opens the card's Details: its own toggle, or on a finished card with answers “Read the answers”, its one way in. */
const openDetails = (user: ReturnType<typeof userEvent.setup>, card: HTMLElement) =>
  user.click(
    within(card).queryByText(CARD_FRAME_WORDS.details) ??
      within(card).getByRole('button', { name: CARD_FRAME_WORDS.readAnswers }),
  );

describe('a live council', () => {
  it('seats each member as an elder with its plaque: its mark or letter and how it is doing', async () => {
    renderCard(council());
    const card = await findCard();
    expect(card.dataset.variant).toBe('live');
    // Its status, its plain title and where it is in one sentence.
    expect(card.textContent).toContain('Working');
    expect(within(card).getByRole('heading', { name: 'Back up the NAS offsite' })).toBeTruthy();
    // Only answers count: Muse didn't answer.
    expect(card.textContent).toContain('1 of 3 answered');
    // One elder per seat, drawn for how each one is doing, hidden from screen readers: the plaques say it.
    const elders = card.querySelector('[data-council-room] [aria-hidden="true"]') as HTMLElement;
    expect([...elders.children].map((e) => (e as HTMLElement).dataset.pose)).toEqual([
      'thinking',
      'answered',
      'resting',
    ]);
    expect(elders.querySelectorAll('svg')).toHaveLength(3);
    const plaques = within(card)
      .getAllByRole('listitem')
      .filter((li) => li.dataset.member);
    expect(plaques).toHaveLength(3);
    const [claude, codex, muse] = plaques;
    // Claude works: its mark, Working and how long.
    expect(claude?.dataset.working).toBeDefined();
    expect(claude?.querySelector('svg[data-mark="claude"]')).toBeTruthy();
    expect(claude?.textContent).toContain(COUNCIL_WORDS.states.working);
    expect(claude?.textContent).toContain('12 min');
    expect(codex?.dataset.working).toBeUndefined();
    expect(codex?.querySelector('svg[data-mark="openai"]')).toBeTruthy();
    expect(codex?.textContent).toContain('8/10');
    // Muse has no mark of its own: its first letter; it didn't answer, so it rests.
    expect(muse?.querySelector('svg[data-mark]')).toBeNull();
    expect(muse?.textContent).toContain('MMuse Code');
    expect(muse?.dataset.pose).toBe('resting');
    expect(muse?.textContent).toContain(COUNCIL_WORDS.states.no_answer);
    expect(within(card).getByRole('button', { name: COUNCIL_WORDS.stop })).toBeTruthy();
  });

  it('keeps its elders at the table once it finished, its answers read under Details', async () => {
    renderCard(
      council({
        live: false,
        stage: 'done',
        outcome: 'done',
        members: [member({ state: 'done', score: 9, verdict: 'agree', answer: 'Ship it.' })],
      }),
    );
    const card = await findCard();
    const plaque = card.querySelector('[data-council-room] [data-member]') as HTMLElement;
    expect(plaque.dataset.pose).toBe('agrees');
    expect(plaque.textContent).toContain(COUNCIL_WORDS.verdicts.agree);
    expect(card.querySelector('[data-working]')).toBeNull();
    expect(within(plaque).queryByRole('button', { name: COUNCIL_WORDS.readAnswer })).toBeNull();
    expect(within(card).getByRole('button', { name: CARD_FRAME_WORDS.readAnswers })).toBeTruthy();
  });

  it('shows its steps on top, its members open, and Stop only as a quiet word and in its ⋯ menu', async () => {
    const user = userEvent.setup();
    const { history } = renderCard(council());
    const card = await findCard();
    // The steps, named by what it does first, the current one marked.
    const steps = within(card)
      .getAllByRole('listitem')
      .filter((li) => li.closest('[data-council-track]'));
    expect(steps.map((li) => li.textContent)).toEqual(councilSteps('research'));
    expect(steps[0]?.getAttribute('aria-current')).toBe('step');
    // Who is at work shows without opening anything, on a phone too.
    expect(within(card).queryByRole('button', { name: CARD_FRAME_WORDS.showMore })).toBeNull();
    expect(card.querySelectorAll('[data-member]')).toHaveLength(3);
    // Stop is no main button any more: one quiet word at the foot.
    expect(card.querySelector('[data-council-stop]')?.closest('[class*="foot"]')).toBeTruthy();
    // The ⋯ menu: change who sits on it, and Stop… which still asks first.
    await user.click(within(card).getByRole('button', { name: /^More for/ }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([COUNCIL_WORDS.changeCouncil, `${COUNCIL_WORDS.stop}…`]);
    await user.click(items[1] as HTMLElement);
    expect(await screen.findByRole('dialog', { name: COUNCIL_WORDS.stopAsk.title })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: COUNCIL_WORDS.stopAsk.keep }));
    await user.click(within(card).getByRole('button', { name: /^More for/ }));
    await user.click(await screen.findByRole('menuitem', { name: COUNCIL_WORDS.changeCouncil }));
    await waitFor(() => expect(history.location.search).toContain('part=council'));
  });

  it('opens a member’s answer on its row, and links to T3 Code for the rest of a long one', async () => {
    const user = userEvent.setup();
    const long = `${'The B2 plan, folder by folder. '.repeat(200)}`.slice(0, COUNCIL_CARD_ANSWER_MAX);
    renderCard(
      council({
        members: [
          member({}),
          member({
            id: 'cnm_test2',
            name: 'GPT 6.1 Sol',
            provider: 'Codex',
            mark: 'openai',
            state: 'done',
            score: 8,
            url: 'http://thetitan:3773/env-1/council-codex',
            answer: long,
          }),
          member({
            id: 'cnm_test3',
            name: 'Muse Wonder',
            provider: 'Muse Code',
            mark: null,
            state: 'done',
            score: 7,
            answer: 'Use **restic** to B2.',
          }),
        ],
      }),
    );
    const card = await findCard();
    const [claude, codex, muse] = [...card.querySelectorAll<HTMLElement>('[data-member]')];
    // Still at work: nothing to read yet.
    expect(
      within(claude as HTMLElement).queryByRole('button', { name: COUNCIL_WORDS.readAnswer }),
    ).toBeNull();
    const read = within(muse as HTMLElement).getByRole('button', { name: COUNCIL_WORDS.readAnswer });
    expect(read.getAttribute('aria-expanded')).toBe('false');
    expect(card.textContent).not.toContain('restic');
    await user.click(read);
    expect(read.getAttribute('aria-expanded')).toBe('true');
    expect(read.textContent).toBe(COUNCIL_WORDS.hideAnswer);
    // Under the table, named, as message text: its markdown drawn.
    const answer = document.getElementById(read.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(answer.dataset.memberAnswer).toBe('cnm_test3');
    expect(answer.textContent).toContain('Muse Wonder');
    expect(within(answer).getByText('restic').tagName).toBe('STRONG');
    // A short answer is whole on the card: no link to the rest.
    expect(within(answer).queryByRole('link', { name: COUNCIL_WORDS.restInT3 })).toBeNull();
    // One answer at a time: Codex's takes its place, with the way to the rest in T3 Code.
    await user.click(within(codex as HTMLElement).getByRole('button', { name: COUNCIL_WORDS.readAnswer }));
    expect(read.getAttribute('aria-expanded')).toBe('false');
    expect(card.textContent).not.toContain('restic');
    expect(within(card).getByRole('link', { name: COUNCIL_WORDS.restInT3 }).getAttribute('href')).toBe(
      'http://thetitan:3773/env-1/council-codex',
    );
    await user.click(within(codex as HTMLElement).getByRole('button', { name: COUNCIL_WORDS.hideAnswer }));
    expect(within(card).queryByRole('link', { name: COUNCIL_WORDS.restInT3 })).toBeNull();
  });

  it('still shows the builder with its step on a council from before its tasks went to T3 Code', async () => {
    renderCard(
      council({
        stage: 'build',
        members: [member({ role: 'builder', step: 'Changing LoginPage.tsx', id: 'cnm_builder' })],
      }),
    );
    const card = await findCard();
    const builder = card.querySelector('[data-member="cnm_builder"]') as HTMLElement;
    expect(builder.textContent).toContain(COUNCIL_WORDS.builder);
    expect(builder.textContent).toContain('Changing LoginPage.tsx');
  });

  it('asks before Stop: Keep going leaves it, Stop stops it', async () => {
    const user = userEvent.setup();
    const { calls } = renderCard(council());
    const card = await findCard();
    await user.click(within(card).getByRole('button', { name: COUNCIL_WORDS.stop }));
    const ask = await screen.findByRole('dialog', { name: COUNCIL_WORDS.stopAsk.title });
    expect(ask.textContent).toContain(COUNCIL_WORDS.stopAsk.body);
    await user.click(within(ask).getByRole('button', { name: COUNCIL_WORDS.stopAsk.keep }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls).toEqual([]);

    await user.click(within(card).getByRole('button', { name: COUNCIL_WORDS.stop }));
    const again = await screen.findByRole('dialog', { name: COUNCIL_WORDS.stopAsk.title });
    await user.click(within(again).getByRole('button', { name: COUNCIL_WORDS.stop }));
    await waitFor(() =>
      expect(calls).toEqual([
        { method: 'POST', path: `${B}/councils/stop`, body: { councilId: 'cnl_fixturenas' } },
      ]),
    );
  });

  it('says so quietly when the Whombat can’t stop a council yet', async () => {
    const user = userEvent.setup();
    renderCard(council(), (call, res) =>
      call.path.endsWith('/councils/stop')
        ? jsonAnswer({ error: { code: 'unknown_op', message: 'No operation councils.stop' } }, 404)
        : res,
    );
    const card = await findCard();
    await user.click(within(card).getByRole('button', { name: COUNCIL_WORDS.stop }));
    const ask = await screen.findByRole('dialog', { name: COUNCIL_WORDS.stopAsk.title });
    await user.click(within(ask).getByRole('button', { name: COUNCIL_WORDS.stop }));
    expect(await screen.findByText(/isn’t available on this Whombat/)).toBeTruthy();
    expect(
      (within(card).getByRole('button', { name: COUNCIL_WORDS.stop }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('has a quiet way to change who sits on the next council, in Settings', async () => {
    const user = userEvent.setup();
    const { history, calls } = renderCard(council());
    const card = await findCard();
    // Under Details, with the earlier rounds and the plan.
    expect(within(card).queryByRole('link', { name: COUNCIL_WORDS.changeCouncil })).toBeNull();
    await openDetails(user, card);
    const link = within(card).getByRole('link', { name: COUNCIL_WORDS.changeCouncil });
    expect(link.getAttribute('href')).toBe('/settings?tab=agent&part=council');
    await user.click(link);
    await waitFor(() =>
      expect(`${history.location.pathname}${history.location.search}`).toBe(link.getAttribute('href')),
    );
    expect(calls).toEqual([]);
  });
});

describe('a council that agreed on its plan', () => {
  it('folds the plan and asks for nothing itself: its tasks are on the card below', async () => {
    const user = userEvent.setup();
    renderCard(building());
    const card = await findCard();
    expect(card.dataset.variant).toBe('live');
    expect(card.textContent).toContain(COUNCIL_WORDS.stages.build);
    // The earlier rounds and the plan are under Details.
    expect(card.textContent).not.toContain('Look 1 · 6 · 7');
    expect(card.textContent).not.toContain('Taller rows');
    await openDetails(user, card);
    expect(card.textContent).toContain('Look 1 · 6 · 7');
    expect(card.textContent).toContain('Taller rows');
    // No go-ahead of its own: Stop is its one button beside a member's answer.
    const buttons = within(card)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(buttons).toContain(COUNCIL_WORDS.stop);
    expect(buttons.some((b) => /go ahead|hand over/i.test(b ?? ''))).toBe(false);
  });

  it('has its checklist under it in the thread: Hand over there is the go-ahead', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = recordingWorld({ council: true });
    renderApp(`/chat?thread=${COUNCIL_CHECKLIST_THREAD}&focus=1`, mockedServices(fetch));
    const card = await findCard();
    // It waits for the go-ahead, which is the checklist's Hand over, and names that card.
    expect(card.dataset.stage).toBe('approve');
    expect(card.textContent).toContain(COUNCIL_WORDS.stages.approve);
    expect(within(card).queryByRole('button', { name: /hand over/i })).toBeNull();
    const list = await screen.findByRole('region', { name: / · Tasks\. / });
    // The council's card comes first, its checklist after it.
    expect(card.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(within(list).getByRole('button', { name: DELEGATION_WORDS.change }));
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
    await user.click(within(list).getByRole('button', { name: /^Hand over \d/ }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: `${B}/delegations/start`,
        body: { delegationId: 'dlg_fixturecouncilinbox' },
      }),
    );
  });
});

describe('a card that moved down', () => {
  it('leaves a link under the words it was on that takes the reader to it', async () => {
    const user = userEvent.setup();
    const { fetch } = recordingWorld({ council: true });
    renderApp(`/chat?thread=${COUNCIL_MOVED_THREAD}&focus=1`, mockedServices(fetch));
    const link = await screen.findByRole('button', { name: new RegExp(MOVED_CARD_WORDS.link.delegation) });
    const list = await screen.findByRole('region', { name: / · Tasks\. / });
    // The checklist is further down than the words it left.
    expect(link.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(link);
    const row = list.closest('[data-message-row]');
    expect(row?.getAttribute('data-message-id')).toBe(`${COUNCIL_MOVED_THREAD}-5`);
    expect(row?.hasAttribute('data-flash')).toBe(true);
    // Only the words it left have one.
    expect(
      screen.getAllByRole('button', { name: new RegExp(MOVED_CARD_WORDS.link.delegation) }),
    ).toHaveLength(1);
  });
});

describe('a card the person talked about before it moved on', () => {
  it('stays folded where they talked, opens read-only, and only the newest has Hand over', async () => {
    const user = userEvent.setup();
    const { fetch } = recordingWorld({ council: true });
    renderApp(`/chat?thread=${COUNCIL_AGAIN_THREAD}&focus=1`, mockedServices(fetch));
    const folds = await screen.findAllByRole('button', { name: /^Tasks · earlier version/ });
    // The list as first offered, and the one Mara asked the council about.
    expect(folds.map((b) => b.textContent)).toEqual([
      'Tasks · earlier version · 4 tasks',
      'Tasks · earlier version · 5 tasks',
    ]);
    expect(folds[0]?.getAttribute('aria-expanded')).toBe('false');
    await user.click(folds[0] as HTMLElement);
    const opened = document.querySelector('[data-earlier-open]') as HTMLElement;
    expect(opened.hasAttribute('inert')).toBe(true);
    const copy = within(opened).getByRole('region', { name: / · Tasks/ });
    expect(copy.dataset.still).toBeDefined();
    expect(copy.textContent).toContain(MOVED_CARD_WORDS.earlierWord);
    expect(within(copy).queryByRole('button', { name: /^Hand over/ })).toBeNull();
    // One Hand over in the thread: the newest card's, at the end.
    expect(screen.getAllByRole('button', { name: /^Hand over \d/ })).toHaveLength(1);
    // Newest takes the reader to it.
    // Its spoken name starts with the word it shows.
    const newest = screen.getAllByRole('button', {
      name: `${MOVED_CARD_WORDS.newest}: ${MOVED_CARD_WORDS.link.delegation}`,
    });
    await user.click(newest[0] as HTMLElement);
    const live = screen.getAllByRole('region', { name: / · Tasks\. / }).find((r) => !r.dataset.still);
    expect(live?.closest('[data-message-row]')?.hasAttribute('data-flash')).toBe(true);
  });
});

describe('the final card', () => {
  it('has every round’s scores, the plan folded and the picture with its numbered notes', async () => {
    const user = userEvent.setup();
    renderCard(final(), undefined, [SHOT]);
    const card = await findCard();
    expect(card.dataset.variant).toBe('final');
    expect(within(card).queryByRole('link', { name: COUNCIL_WORDS.changeCouncil })).toBeNull();
    expect(card.textContent).toContain(COUNCIL_WORDS.stages.done);
    // The scores, the plan and the pictures are under Details.
    expect(within(card).queryByRole('table')).toBeNull();
    await openDetails(user, card);
    const table = within(card).getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Look 1', 'Check 1']);
    const rows = within(table).getAllByRole('row').slice(1);
    // Each row is its member by name (the mark beside it is decorative here).
    expect(within(rows[0] as HTMLElement).getByRole('rowheader', { name: 'Claude Opus 5.5' })).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByRole('rowheader', { name: 'Muse Wonder' })).toBeTruthy();
    expect(
      rows.map((r) =>
        within(r)
          .getAllByRole('cell')
          .map((c) => c.textContent),
      ),
    ).toEqual([
      ['6/10', '9/10'],
      ['6.5/10', '9.5/10'],
    ]);
    expect(card.textContent).toContain('Taller buttons');
    // What changed: the picture (opens the viewer), the hint and the notes in their numbers' order.
    expect(card.textContent).toContain(COUNCIL_WORDS.pictures);
    const shot = within(card).getByRole('figure');
    expect(shot.textContent).toContain('Settings · light');
    expect(await within(shot).findByRole('img', { name: 'Settings · light' })).toBeTruthy();
    expect(shot.textContent).toContain(COUNCIL_WORDS.picturesHint);
    const notes = within(shot).getAllByRole('listitem');
    expect(notes.map((n) => n.getAttribute('value'))).toEqual(['1', '2']);
    expect(notes[1]?.textContent).toContain('taller');
    expect(within(card).queryByRole('button', { name: COUNCIL_WORDS.stop })).toBeNull();
  });

  it('keeps the last round’s answers readable once it ended', async () => {
    const user = userEvent.setup();
    renderCard({
      ...final(),
      members: [
        member({
          id: 'cnm_a' as never,
          state: 'done',
          score: 9,
          answer: 'Much better: the rows read at a glance.',
        }),
        member({ id: 'cnm_b' as never, name: 'Muse Wonder', state: 'no_answer', answer: null }),
      ],
    });
    const card = await findCard();
    // Read the answers opens them under Details: only who answered.
    expect(card.textContent).not.toContain('at a glance');
    const read = within(card).getByRole('button', { name: CARD_FRAME_WORDS.readAnswers });
    // It is the one way in: no Details beside it, and it shuts them again.
    expect(within(card).queryByText(CARD_FRAME_WORDS.details)).toBeNull();
    await user.click(read);
    expect(read.getAttribute('aria-expanded')).toBe('true');
    expect(read.textContent).toBe(CARD_FRAME_WORDS.hideAnswers);
    expect(card.textContent).toContain(CARD_FRAME_WORDS.answers);
    expect(card.textContent).toContain('at a glance');
    expect(card.querySelectorAll('[data-card-details] [data-member]')).toHaveLength(1);
  });

  it('shows its picture once: the message’s files leave it out', async () => {
    const { fetch } = recordingWorld({ council: true });
    renderApp(`/chat?thread=${COUNCIL_FINAL_THREAD}&focus=1`, mockedServices(fetch));
    const card = await findCard();
    await openDetails(userEvent.setup(), card);
    expect(await within(card).findByRole('img', { name: 'Settings · light' })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole('img', { name: 'Settings · light' })).toHaveLength(1));
    expect(screen.queryByRole('img', { name: 'settings-light.png' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Images' })).toBeNull();
  });
});
