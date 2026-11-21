import type { Meta, StoryObj } from '@storybook/react-vite';
import { createMemoryHistory } from '@tanstack/react-router';
import { useState } from 'react';
import { App } from '../app/App';
import type { WebFixtureOptions } from '../app/fixtureFetch';
import { createAppServices } from '../app/services';

/**
 * The whole app on the fixture world (`@whombat/fixtures`, no server): sidebar, routing, panes and
 * modals. The toolbar's theme switch sets light / dark; the stories below pin one each.
 *
 * `fixtures` forwards straight to `createAppServices`' `WebFixtureOptions` (`latencyMs`/`failing`), so
 * the "quiet states" stories below drive the real screens' loading and error branches the same way the
 * tests do (TODO 16.4) — nothing here is a hand-drawn mock of the state.
 */
function ShellDemo({ url, fixtures }: { url: string; fixtures?: WebFixtureOptions }) {
  const [services] = useState(() => createAppServices({ fixtures: fixtures ?? true }));
  const [history] = useState(() => createMemoryHistory({ initialEntries: [url] }));
  return <App services={services} history={history} />;
}

const meta = {
  title: 'App/Shell',
  component: ShellDemo,
  parameters: { layout: 'fullscreen' },
  args: { url: '/chat' },
} satisfies Meta<typeof ShellDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {
  globals: { theme: 'light' },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
};

export const ThreadPane: Story = {
  name: 'Thread pane open',
  args: { url: '/chat?thread=msg_dm-dusty-dusty-0941' },
};

/** The agent's settings (one-agent.md AP-4923: the page that replaced the roster and its profiles). */
export const AgentSettings: Story = {
  name: 'Settings → Agent',
  args: { url: '/settings/agent' },
};

export const ApprovalModal: Story = {
  name: 'Approval modal',
  args: { url: '/pr/482?approval=12' },
};

export const AuditLog: Story = {
  name: 'Audit log (default, e-9f18 expanded)',
  args: { url: '/log' },
};

export const AuditLogFilteredByAgent: Story = {
  name: 'Audit log, the agent’s events',
  args: { url: '/log?actor=agents' },
};

export const AuditLogBlocked: Story = {
  name: 'Audit log, Blocked kind',
  args: { url: '/log?kind=blocked' },
};

export const Search: Story = {
  name: 'Search, with the mock query',
  args: { url: '/search?q=rounding+order+VAT+invoices' },
};

export const SearchThreads: Story = {
  name: 'Search, Threads filter',
  args: { url: '/search?q=rounding+order+VAT+invoices&type=threads' },
};

export const SignIn: Story = {
  name: 'Sign in',
  render: () => <SignInDemo />,
};

function SignInDemo() {
  const [services] = useState(() => createAppServices({ fixtures: { signedIn: false } }));
  const [history] = useState(() => createMemoryHistory({ initialEntries: ['/login'] }));
  return <App services={services} history={history} />;
}

/* Quiet states (TODO 16.4) --------------------------------------------------------------------
 * Loading and error branches of the real screens, driven through the same `latencyMs`/`failing`
 * switches the tests use — see `docs/decisions/states.md`.
 */

export const RunLoading: Story = {
  name: 'Quiet states / Run, loading',
  args: { url: '/runs/1907', fixtures: { latencyMs: 4000 } },
};

export const RunNotFound: Story = {
  name: 'Quiet states / Run, not found',
  args: { url: '/runs/9999' },
};

export const RunError: Story = {
  name: 'Quiet states / Run, load error',
  args: { url: '/runs/1907', fixtures: { failing: ['runs.get'] } },
};

export const BranchRoomLoading: Story = {
  name: 'Quiet states / Branch room, loading',
  args: { url: '/pr/482', fixtures: { latencyMs: 4000 } },
};

export const BranchRoomError: Story = {
  name: 'Quiet states / Branch room, load error',
  args: { url: '/pr/482', fixtures: { failing: ['prs.get'] } },
};

export const ChatLoading: Story = {
  name: 'Quiet states / Chat, loading',
  args: { url: '/chat', fixtures: { latencyMs: 4000 } },
};

export const ChatError: Story = {
  name: 'Quiet states / Chat, load error',
  args: { url: '/chat', fixtures: { failing: ['conversations.get'] } },
};

export const ApprovalModalLoading: Story = {
  name: 'Quiet states / Approval modal, loading',
  args: { url: '/pr/482?approval=12', fixtures: { latencyMs: 4000 } },
};

export const ApprovalModalNotFound: Story = {
  name: 'Quiet states / Approval modal, not found',
  args: { url: '/pr/482?approval=99' },
};

export const CanvasesError: Story = {
  name: 'Quiet states / Canvases index, load error',
  args: { url: '/canvases', fixtures: { failing: ['canvases.list'] } },
};

export const CanvasError: Story = {
  name: 'Quiet states / Canvas, load error',
  args: {
    url: '/canvases/invoice-pdf-export-plan',
    fixtures: { failing: ['canvases.get'] },
  },
};

export const SearchError: Story = {
  name: 'Quiet states / Search, error',
  args: { url: '/search?q=rounding', fixtures: { failing: ['search.query'] } },
};

export const OnboardingSlugCheckError: Story = {
  name: 'Quiet states / Onboarding, slug check error',
  args: { url: '/onboarding', fixtures: { failing: ['burrows.slugCheck'] } },
};

export const BurrowLoadError: Story = {
  name: 'Quiet states / Burrow bootstrap fails on first load',
  args: { url: '/chat', fixtures: { failing: ['conversations.bootstrap'] } },
};
