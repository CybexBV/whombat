/**
 * The assistant's draft report on its card (Whombat team-reports.md): in Chat and in the approval's dialog it answers
 * Yes, do it · No, never a later time, and Edit beside the answers opens the form with the draft. Another everyday ask
 * in Chat still offers Yes, tonight.
 */
import { QueryClient } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { APPROVAL_CARD_WORDS, approvalView } from '@whombat/core/approvals';
import type { Approval, MessageCard as MessageCardData } from '@whombat/core/domain';
import { burrow, mara, PRINCIPALS, SEED_NOW, SEED_TIME_ZONE } from '@whombat/fixtures';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAT_ID } from '../../app/oneFixtures';
import { Providers } from '../../app/providers';
import { createAppServices } from '../../app/services';
import { Modal } from '../../components/Modal';
import { AskSheet } from '../approvals/AskSheet';
import { CardLookContext } from './cardLook';
import { approvalAsk, approvalTeamReport } from './cardStates';
import { MessageCard } from './MessageCard';
import { nameLookup, principalLookup } from './parts';

const DRAFT = 'draft_fixture_backups';
const names = nameLookup(principalLookup(PRINCIPALS));

/** `page` at `/chat`, with the form's address beside it so Edit has somewhere to go. */
function renderAt(page: () => ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const chat = createRoute({ getParentRoute: () => root, path: 'chat', component: page });
  const form = createRoute({
    getParentRoute: () => root,
    path: 'reports/new',
    component: () => <p>The report form</p>,
  });
  const history = createMemoryHistory({ initialEntries: ['/chat'] });
  const router = createRouter({ routeTree: root.addChildren([chat, form]), history });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  render(
    <Providers services={createAppServices({ fixtures: {}, queryClient })}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return () => `${history.location.pathname}${history.location.search}`;
}

/** The card as Chat shows it (`CardLookContext` `chat`, where Yes, tonight is offered). */
function inChat(approval: Approval) {
  return renderAt(() => (
    <CardLookContext.Provider value="chat">
      <MessageCard
        burrow={burrow.slug}
        card={{ kind: 'approval', approval } as MessageCardData}
        messageId="msg_team-report"
        conversationId={DEFAULT_CHAT_ID}
      />
    </CardLookContext.Provider>
  ));
}

const answersOf = async () => {
  const group = await screen.findByRole('group', { name: APPROVAL_CARD_WORDS.answersLabel });
  return {
    group,
    answers: within(group)
      .getAllByRole('button')
      .map((b) => b.textContent),
  };
};

describe('the assistant’s draft report on its card', () => {
  it('answers now or not at all in Chat, and Edit opens the form with the draft', async () => {
    const user = userEvent.setup();
    const location = inChat(approvalTeamReport);
    const { group, answers } = await answersOf();
    expect(answers).toEqual(['Yes, do it', 'No']);
    const edit = within(group).getByRole('link', { name: 'Edit' });
    expect(edit.getAttribute('href')).toBe(`/reports/new?draft=${DRAFT}`);
    await user.click(edit);
    expect(await screen.findByText('The report form')).toBeTruthy();
    expect(location()).toBe(`/reports/new?draft=${DRAFT}`);
  });

  it('leaves another everyday ask in Chat as it was: Yes, tonight, and no Edit', async () => {
    inChat(approvalAsk);
    await waitFor(async () => expect((await answersOf()).answers).toContain('Yes, tonight'));
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
  });

  it('offers no Edit once answered', async () => {
    inChat({
      ...approvalTeamReport,
      state: 'declined',
      decidedById: mara.id,
      decidedAt: SEED_NOW.toISOString(),
    });
    expect(await screen.findByText(/said no/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
  });

  it('answers the same in the approval’s dialog', async () => {
    const user = userEvent.setup();
    const viewer = { id: mara.id, kind: 'person' as const };
    const view = approvalView(approvalTeamReport, { names, viewer, now: SEED_NOW, timeZone: SEED_TIME_ZONE });
    const location = renderAt(() => (
      <Modal open onOpenChange={() => {}} width="lg" padded={false}>
        <AskSheet
          burrow={burrow.slug}
          approval={approvalTeamReport}
          view={view}
          names={names}
          timeZone={SEED_TIME_ZONE}
          busy={false}
          refreshFailed={false}
          onRetry={() => {}}
          onAnswer={() => {}}
          onLasting={() => {}}
        />
      </Modal>
    ));
    const { group, answers } = await answersOf();
    expect(answers).toEqual(['Yes, do it', 'No']);
    // Nothing says when Yes, tonight would run.
    expect(screen.queryByText('Yes, tonight')).toBeNull();
    await user.click(within(group).getByRole('link', { name: 'Edit' }));
    await waitFor(() => expect(location()).toBe(`/reports/new?draft=${DRAFT}`));
  });
});
