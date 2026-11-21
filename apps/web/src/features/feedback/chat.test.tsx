/**
 * Website feedback in Feedback (docs/decisions/feedback-chat.md AP-1827…; chat-channel.md AP-2410; one-agent.md
 * AP-4935, AP-4936): Where reports go has no channel: reports come to the person's Feedback room, which the
 * integration's page links to, and the agent assesses — nobody to pick. Against the fixture world
 * (`feedbackChatFixtures.ts`).
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { feedbackIntegration } from '@whombat/fixtures';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_CHAT_ID } from '../../app/feedbackChatFixtures';
import { fixtureServices, renderApp } from '../../test/renderApp';
import { feedbackWords } from './copy';
import { emptyForm, settingsInput } from './settingsForm';

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

// Every integration's reports come to the Feedback room (chat-channel.md AP-2410).
const assistantShell = () => fixtureServices({ feedbackSources: true });

/** New integration at Where reports go. */
async function whereReportsGo(services = assistantShell()) {
  const user = userEvent.setup();
  const app = renderApp('/settings/feedback/new', services);
  await user.type(await screen.findByLabelText('NAME', { exact: true }), 'Docs site');
  await user.type(screen.getByLabelText('PRODUCT', { exact: true }), 'Burrow Docs');
  await user.type(screen.getByLabelText('ALLOWED ORIGINS'), 'https://docs.burrowhq.example');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  return { user, ...app };
}

describe('Where reports go (AP-1831, AP-4936)', () => {
  it('names Feedback, never a channel, and the agent assesses (AP-4935)', async () => {
    await whereReportsGo();
    const where = await screen.findByRole('group', { name: 'REPORTS GO TO' });
    expect(within(where).getByText('Feedback')).toBeTruthy();
    expect(within(where).getByText('Each report becomes a thread there.')).toBeTruthy();
    expect(screen.queryByLabelText('CHANNEL')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Add Neo to #/ })).toBeNull();
    // The agent assesses and builds the fix: shown, not picked.
    const assessed = await screen.findByRole('group', { name: 'ASSESSED BY' });
    expect(within(assessed).getByText('Neo')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'BUILT BY' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: /ASSESS|DEVELOP|BUILT/ })).toBeNull();
  });

  it('creates the integration without a channel: its reports come to Feedback, which Install links to', async () => {
    const { user } = await whereReportsGo();
    await screen.findByRole('group', { name: 'REPORTS GO TO' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Create integration' }));
    const open = await screen.findByRole('link', { name: 'Open Feedback' });
    expect(open.getAttribute('href')).toBe('/feedback');
    expect(screen.getByText(/It becomes a thread in Feedback, and Health counts it\./)).toBeTruthy();
  });
});

describe('an integration that posts in Feedback (AP-1829, AP-1832, AP-2410)', () => {
  it('links its page and its row to Feedback', async () => {
    renderApp(`/settings/feedback/${feedbackIntegration.id}`, assistantShell());
    const link = await screen.findByRole('link', { name: 'Feedback' });
    expect(link.getAttribute('href')).toBe('/feedback');
    expect(screen.getAllByRole('link', { name: 'Open Feedback' })[0]?.getAttribute('href')).toBe('/feedback');
  });

  it('says in the list where its reports go', async () => {
    renderApp('/connections?connection=feedback', assistantShell());
    expect(await screen.findByText('Burrow Billing · reports go to Feedback')).toBeTruthy();
    expect(screen.getByText(/each one comes to Feedback, where Neo looks into it\./)).toBeTruthy();
  });
});

describe('the feedback chat (AP-1833)', () => {
  it('opens a report’s thread beside the chat, with the assistant’s look and its choice', async () => {
    renderApp(`/chats/${FEEDBACK_CHAT_ID}?thread=msg_fbc-pdf-safari`, assistantShell());
    const pane = await screen.findByRole('complementary', { name: /Thread/ });
    expect(await within(pane).findByText('Neo is having a look.')).toBeTruthy();
    expect(await within(pane).findByText('Want me to look into a fix?')).toBeTruthy();
    expect(within(pane).getByRole('button', { name: 'Yes, fix it' })).toBeTruthy();
  });
});

describe('the form’s words and input (AP-1828, AP-1830, AP-4936)', () => {
  it('sends no channel', () => {
    const form = { ...emptyForm(), name: 'Docs', productLabel: 'Docs', origins: 'https://d.example' };
    expect('channelId' in settingsInput(form)).toBe(false);
  });

  it('says where reports go: your Feedback', () => {
    const chat = feedbackWords('Neo').chat;
    expect(chat.yours).toBe('Feedback');
    expect(chat.hint).not.toMatch(/only you|owner/);
  });
});
