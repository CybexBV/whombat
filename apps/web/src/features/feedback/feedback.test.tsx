/**
 * Whombat Feedback in the web app, against the fixture world's `api.feedback.*` (`@whombat/fixtures`): Settings →
 * Feedback (the list; an integration's page with snippets, switches, the test report and the editor with its save
 * bar and conflicts; New integration in steps with validation per step; the lock) and a report card's details (plain text, status, retry, handoff, content removal, not in your Feedback).
 */
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useBootstrap } from '@whombat/client/react';
import { errorResponse } from '@whombat/client/session';
import type { Attachment, MessageCard as MessageCardData } from '@whombat/core';
import { FEEDBACK_DROP_TEXT, type FeedbackIntegrationDetail } from '@whombat/core/contracts';
import { basicSnippet, cspAdvice, customLauncherSnippet } from '@whombat/core/feedback';
import {
  FEEDBACK_EMBED_URL,
  feedbackIntegration,
  feedbackManagedHealth,
  feedbackSnippets,
  reportCardOf,
  reportFailed,
  reportLikelyBug,
} from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { Providers } from '../../app/providers';
import type { AppServices } from '../../app/services';
import { fixtureServices, mockedServices, renderApp } from '../../test/renderApp';
import { MessageCard } from '../cards/MessageCard';

const burrow = 'burrow-hq';

/** The fixture world, with some feedback answers replaced (`override` returns a Response, or null to pass). */
function servicesWith(override: (method: string, path: string, body: unknown) => Response | null) {
  const base = createWebFixtureFetch();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const path = url.pathname.replace('/api/v1', '');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    return override(method, path, body) ?? base(new Request(url, init), init);
  });
  return { services: mockedServices(fetch as unknown as typeof globalThis.fetch), fetch };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A managed Whombat (`managed` set) whose runtime answers the integration's detail through `patch` (the fixtures
 * are a self-hosted Whombat's detail).
 */
function managedWith(patch: (detail: FeedbackIntegrationDetail) => void) {
  const base = createWebFixtureFetch();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const res = await base(new Request(url, init), init);
    const method = init?.method ?? 'GET';
    if (method !== 'GET' || !/\/feedback\/integrations\/[^/]+$/.test(url.pathname) || !res.ok) return res;
    const detail = (await res.json()) as FeedbackIntegrationDetail;
    patch(detail);
    return json(detail);
  });
  const services = {
    ...mockedServices(fetch as unknown as typeof globalThis.fetch),
    managed: {} as NonNullable<AppServices['managed']>,
  };
  return { services, fetch };
}

const SITE_KEY = 'fbk_AbCdEfGhIjKlMnOpQrSt_-';
const managedInput = {
  publicUrl: FEEDBACK_EMBED_URL,
  embedUrl: FEEDBACK_EMBED_URL,
  siteKey: SITE_KEY,
  siteId: feedbackIntegration.siteId,
  theme: feedbackIntegration.theme,
  position: feedbackIntegration.position,
  launcher: feedbackIntegration.launcher,
  launcherLabel: feedbackIntegration.launcherLabel,
};
const managedSnippets = {
  basic: basicSnippet(managedInput),
  custom: customLauncherSnippet(managedInput),
  csp: cspAdvice(managedInput),
};

async function openFeedbackTab(services?: AppServices) {
  // Website feedback's own page in Connections (SS-05).
  const app = renderApp(`/connections?connection=feedback`, services);
  await screen.findByRole('heading', { level: 2, name: 'Website feedback' });
  return app;
}

/** The integration's page, opened from its row on Website feedback's page in Connections. */
async function openIntegration(services?: AppServices) {
  const user = userEvent.setup();
  const app = await openFeedbackTab(services);
  await user.click(await screen.findByRole('link', { name: 'Open Billing portal' }));
  await screen.findByRole('heading', { name: 'Billing portal', level: 1 });
  await screen.findByText('HEALTH');
  const page = document.querySelector<HTMLElement>('[data-screen="feedback-integration"]');
  if (!page) throw new Error('no integration page');
  return { user, page: within(page), root: page, ...app };
}

/** New integration, opened from Settings → Connections → Website feedback. */
async function openNew(services?: AppServices) {
  const user = userEvent.setup();
  const app = await openFeedbackTab(services);
  await user.click(await screen.findByRole('link', { name: 'New integration' }));
  await screen.findByRole('heading', { name: 'New integration', level: 1 });
  return { user, ...app };
}

async function fillSite(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('NAME'), 'Docs');
  await user.type(screen.getByLabelText('PRODUCT'), 'Docs');
  await user.type(screen.getByLabelText('ALLOWED ORIGINS'), 'https://docs.example.com');
}

describe('Settings → Feedback', () => {
  it('preserves the managed site key and privacy when switching an existing custom install to floating', async () => {
    const { services } = managedWith((d) => {
      d.health = feedbackManagedHealth;
      d.integration = { ...d.integration, launcher: 'custom', trail: 'off' };
      d.snippets = {
        ...managedSnippets,
        basic: basicSnippet({ ...managedInput, launcher: 'custom' }),
      };
    });
    const { user, page, root } = await openIntegration(services);
    const method = page.getByRole('combobox', { name: 'INSTALLATION METHOD' });
    expect((method as HTMLSelectElement).value).toBe('custom');
    expect(root.querySelector('pre')?.textContent).toContain('data-launcher="custom"');
    await user.selectOptions(method, 'floating');
    const code = root.querySelector('pre')?.textContent ?? '';
    expect(root.querySelectorAll('pre')).toHaveLength(1);
    expect(code).not.toContain('data-launcher="custom"');
    expect(code).not.toContain('<button');
    expect(code).toContain(`src="${FEEDBACK_EMBED_URL}/embed/v1/widget.js"`);
    expect(code).toContain(`data-key="${SITE_KEY}"`);
    expect(code).toContain('data-trail="off"');
    await user.click(page.getByRole('button', { name: 'Copy snippet' }));
    expect(await navigator.clipboard.readText()).toBe(code);
  });

  it('copies one neutral custom Feedback example instead of a second bug launcher', async () => {
    const { user, page, root } = await openIntegration();
    await user.selectOptions(page.getByRole('combobox', { name: 'INSTALLATION METHOD' }), 'custom');
    const codes = [...root.querySelectorAll('pre')].map((p) => p.textContent ?? '');
    expect(codes).toHaveLength(1);
    expect(codes[0]).toContain('data-launcher="custom"');
    expect(codes[0]).toContain('<button type="button" data-whombat-feedback>Feedback</button>');
    expect(codes[0]).not.toContain('Report a problem');
    expect(codes[0]).not.toContain('data-whombat-feedback="bug"');
    await user.click(page.getByRole('button', { name: 'Copy snippet' }));
    expect(await navigator.clipboard.readText()).toBe(codes[0]);
    await user.selectOptions(page.getByRole('combobox', { name: 'INSTALLATION METHOD' }), 'floating');
    expect([...root.querySelectorAll('pre')].map((p) => p.textContent)).toEqual([
      feedbackSnippets(feedbackIntegration).basic,
    ]);
  });

  it('opens the integration’s page with only the default Feedback installation', async () => {
    const { page, root, location } = await openIntegration();
    expect(location()).toBe(`/settings/feedback/${feedbackIntegration.id}`);
    const snippets = feedbackSnippets(feedbackIntegration);
    const codes = [...root.querySelectorAll('pre')].map((p) => p.textContent);
    expect(codes).toEqual([snippets.basic]);
    expect(page.getByText(snippets.csp)).toBeTruthy();
    expect(page.getByText('https://whombat.burrowhq.example')).toBeTruthy();
    expect(page.getByRole('button', { name: 'Copy snippet' })).toBeTruthy();
    expect(page.getByRole('switch', { name: 'Accept reports' }).getAttribute('aria-checked')).toBe('true');
    // The test report is the real widget on the site: its first origin, and a re-read of the health.
    expect(page.getByText('SEND A TEST REPORT')).toBeTruthy();
    const open = page.getByRole('link', { name: `Open ${feedbackIntegration.allowedOrigins[0]}` });
    expect(open.getAttribute('href')).toBe(feedbackIntegration.allowedOrigins[0]);
    expect(open.getAttribute('target')).toBe('_blank');
    expect(page.getByRole('button', { name: 'Check for reports' })).toBeTruthy();
    // Nothing to save until something changes.
    expect(page.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(true);
  });

  it('on a managed Whombat, says website feedback isn’t available instead of the snippets (AP-102)', async () => {
    const services = { ...fixtureServices(), managed: {} as NonNullable<AppServices['managed']> };
    const { page, root } = await openIntegration(services);
    expect(
      page.getByText(
        'Website feedback isn’t available on a managed Whombat yet. Reports from your website need a public address that only a self-hosted Whombat has today.',
      ),
    ).toBeTruthy();
    expect(root.querySelectorAll('pre')).toHaveLength(0);
    expect(page.queryByRole('button', { name: /^Copy/ })).toBeNull();
    expect(page.queryByText('Public address')).toBeNull();
    expect(page.queryByText('https://whombat.burrowhq.example')).toBeNull();
    expect(page.queryByText('SEND A TEST REPORT')).toBeNull();
  });

  it('on a managed Whombat with the drop, shows the snippets from the embed origin and the delivery (AP-105)', async () => {
    const { services, fetch } = managedWith((d) => {
      d.snippets = managedSnippets;
      d.health = feedbackManagedHealth;
      d.integration = { ...d.integration, intake: 'disabled' };
    });
    const { user, page, root } = await openIntegration(services);
    const codes = [...root.querySelectorAll('pre')].map((p) => p.textContent);
    expect(codes).toEqual([managedSnippets.basic]);
    expect(codes[0]).toContain(`src="${FEEDBACK_EMBED_URL}/embed/v1/widget.js"`);
    expect(codes[0]).toContain(`data-key="${SITE_KEY}"`);
    expect(page.getByText(managedSnippets.csp)).toBeTruthy();
    expect(root.querySelector('[data-feedback-managed]')).toBeNull();
    expect(page.getByText('Delivery')).toBeTruthy();
    expect(page.getByText(FEEDBACK_DROP_TEXT.policy)).toBeTruthy();
    expect(page.getByText('Site published')).toBeTruthy();
    expect(page.getByText('Last collected')).toBeTruthy();
    expect(page.getByText('Widget address')).toBeTruthy();
    expect(page.getByText(FEEDBACK_EMBED_URL)).toBeTruthy();
    expect(
      page.getByText(
        '2 reports waited 7 days in Whombat’s cloud and were deleted before this Whombat collected them.',
      ),
    ).toBeTruthy();
    expect(page.queryByText('Public address')).toBeNull();
    // Intake is off: the test report says to switch it on first.
    expect(
      page.getByText('Accept reports is off, so your website doesn’t show the form. Switch it on first.'),
    ).toBeTruthy();
    // You switch intake on.
    const intake = page.getByRole('switch', { name: 'Accept reports' });
    expect(intake.hasAttribute('disabled')).toBe(false);
    await user.click(intake);
    expect(await screen.findByText('Billing portal accepts reports again.')).toBeTruthy();
    const post = fetch.mock.calls.find(
      ([input, init]) =>
        /\/intake$/.test(String(input instanceof Request ? input.url : input)) && init?.method !== 'GET',
    );
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ enabled: true });
  });

  it('keeps the notice when the runtime says the drop is unsupported, and intake can’t be switched on', async () => {
    const { services } = managedWith((d) => {
      d.integration = { ...d.integration, intake: 'disabled' };
      d.health = {
        ...d.health,
        warnings: [{ code: 'drop_unsupported', message: FEEDBACK_DROP_TEXT.unsupported }],
        delivery: { mode: 'drop', publishedAt: null, lastCollectedAt: null, notFiled7d: 0, expired7d: 0 },
      };
    });
    const { page, root } = await openIntegration(services);
    expect(root.querySelector('[data-feedback-managed]')).not.toBeNull();
    expect(root.querySelectorAll('pre')).toHaveLength(0);
    expect(page.getByText(FEEDBACK_DROP_TEXT.unsupported)).toBeTruthy();
    expect(page.queryByText('Delivery')).toBeNull();
    expect(page.getByRole('switch', { name: 'Accept reports' }).hasAttribute('disabled')).toBe(true);
  });

  it('says a report couldn’t be filed, from the runtime’s warnings (drop_not_filed)', async () => {
    const text = '1 report from the last 7 days couldn’t be filed.';
    const { services } = managedWith((d) => {
      d.snippets = managedSnippets;
      d.health = {
        ...feedbackManagedHealth,
        warnings: [{ code: 'drop_not_filed', message: text }],
      };
    });
    const { page } = await openIntegration(services);
    expect(within(page.getByRole('list', { name: 'Warnings' })).getByText(text)).toBeTruthy();
  });

  it('turns intake off and pauses assessment through the API', async () => {
    const { user, page } = await openIntegration();
    const intake = page.getByRole('switch', { name: 'Accept reports' });
    await user.click(intake);
    await waitFor(() => expect(intake.getAttribute('aria-checked')).toBe('false'));
    expect(await screen.findByText('Billing portal stopped accepting reports.')).toBeTruthy();
    const assess = page.getByRole('switch', { name: 'Assess new reports' });
    await user.click(assess);
    await waitFor(() => expect(assess.getAttribute('aria-checked')).toBe('false'));
    expect(await page.findByText(/Intake is off/)).toBeTruthy();
  });

  it('edits settings on the page and sends the revision it started from', async () => {
    const { services, fetch } = servicesWith(() => null);
    const { user, page } = await openIntegration(services);
    const name = page.getByLabelText('NAME');
    await user.clear(name);
    await user.type(name, 'Billing');
    expect(page.getByText('Unsaved changes')).toBeTruthy();
    await user.click(page.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Billing saved.')).toBeTruthy();
    const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(put).toBeTruthy();
    const body = JSON.parse(String(put?.[1]?.body));
    expect(body.revision).toBe(feedbackIntegration.revision);
    expect(body.settings.name).toBe('Billing');
    expect(body.settings.allowedOrigins).toEqual(feedbackIntegration.allowedOrigins);
    await waitFor(() => expect(page.queryByText('Unsaved changes')).toBeNull());
  });

  it('offers pages visited and reporter sign-in, saves them, and the snippets say data-trail="off" (AP-434, AP-435)', async () => {
    const { services, fetch } = servicesWith(() => null);
    const { user, page, root } = await openIntegration(services);
    const pages = page.getByRole('group', { name: 'pages visited' });
    const checked = (group: HTMLElement, name: string) =>
      (within(group).getByRole('radio', { name }) as HTMLInputElement).checked;
    expect(checked(pages, 'Send the last 10 pages')).toBe(true);
    const signIn = page.getByRole('group', { name: 'reporter sign-in' });
    expect(checked(signIn, 'Let visitors sign in to follow their reports')).toBe(true);
    await user.click(within(pages).getByRole('radio', { name: 'Don’t send' }));
    await user.click(within(signIn).getByRole('radio', { name: 'Off' }));
    await user.click(page.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Billing portal saved.');
    const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT');
    const sent = JSON.parse(String(put?.[1]?.body)).settings;
    expect(sent).toMatchObject({ trail: 'off', reporterSignIn: 'off' });
    await waitFor(() => {
      const codes = [...root.querySelectorAll('pre')].map((p) => p.textContent ?? '');
      expect(codes.every((c) => c.includes('  data-trail="off"\n  defer\n'))).toBe(true);
    });
  });

  it('keeps unsaved edits when a switch changes the integration, and Discard puts them back', async () => {
    const { user, page } = await openIntegration();
    const name = page.getByLabelText('NAME') as HTMLInputElement;
    await user.clear(name);
    await user.type(name, 'Billing');
    await user.click(page.getByRole('switch', { name: 'Accept reports' }));
    expect(await screen.findByText('Billing portal stopped accepting reports.')).toBeTruthy();
    expect(name.value).toBe('Billing');
    await user.click(page.getByRole('button', { name: 'Discard' }));
    expect(name.value).toBe('Billing portal');
    expect(page.queryByText('Unsaved changes')).toBeNull();
  });

  it('loads the other version when someone saved in between (409)', async () => {
    const { services } = servicesWith((method) =>
      method === 'PUT'
        ? json({ error: { code: 'conflict', message: 'The integration changed.' } }, 409)
        : null,
    );
    const { user, page } = await openIntegration(services);
    const name = page.getByLabelText('NAME') as HTMLInputElement;
    await user.clear(name);
    await user.type(name, 'Billing');
    await user.click(page.getByRole('button', { name: 'Save changes' }));
    expect((await page.findByRole('alert')).textContent).toBe(
      'Someone changed this integration while you were editing. Their version is loaded now: check it and save again.',
    );
    expect(name.value).toBe('Billing portal');
  });

  it('checks each step before the next, live after the first try, with the origins checked line by line', async () => {
    const { user, location } = await openNew();
    expect(location()).toBe(`/settings/feedback/new`);
    expect(screen.getByRole('navigation', { name: 'Setup steps' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('alert').textContent).toBe('Check the highlighted fields.');
    expect(screen.getByText('Give the integration a name (at most 80 characters).')).toBeTruthy();
    expect(screen.getByText('Add at least one origin, at most 20.')).toBeTruthy();
    expect(location()).toBe(`/settings/feedback/new`);

    await user.type(screen.getByLabelText('NAME'), 'Docs');
    expect(screen.queryByText('Give the integration a name (at most 80 characters).')).toBeNull();
    await user.type(screen.getByLabelText('PRODUCT'), 'Docs');
    const origins = screen.getByLabelText('ALLOWED ORIGINS');
    await user.type(origins, 'HTTPS://Docs.Example.com/{Enter}http://docs.example.com');
    expect(screen.getByText('✓ HTTPS://Docs.Example.com/ → https://docs.example.com')).toBeTruthy();
    expect(screen.getByText('✗ http://docs.example.com: not an exact origin')).toBeTruthy();
    expect(screen.getByText(/^“http:\/\/docs\.example\.com”: Use an exact origin/)).toBeTruthy();
    await user.clear(origins);
    await user.type(origins, 'https://docs.example.com');

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Where reports go', level: 2 })).toBeTruthy();
    expect(location()).toBe(`/settings/feedback/new?step=reports`);
    // Back keeps what was typed.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect((screen.getByLabelText('NAME') as HTMLInputElement).value).toBe('Docs');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // The agent assesses and builds the fix: shown, not picked (one-agent.md AP-4935).
    expect(await screen.findByRole('group', { name: 'ASSESSED BY' })).toBeTruthy();
    expect(screen.queryByLabelText('ASSESSMENT AGENT')).toBeNull();
  });

  it('a refused Next focuses the first field to fix, unless the person already clicked into another', async () => {
    // The frames run when the test says, as a slow machine would run them late.
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    const flush = () => {
      for (const cb of frames.splice(0)) cb(0);
    };
    try {
      const { user } = await openNew();
      const name = screen.getByLabelText('NAME');
      const product = screen.getByLabelText('PRODUCT');
      await user.click(screen.getByRole('button', { name: 'Next' }));
      flush();
      expect(document.activeElement).toBe(name);
      // Next again, then into Product before the frame: the typing stays where the person put it.
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await user.click(product);
      flush();
      expect(document.activeElement).toBe(product);
    } finally {
      raf.mockRestore();
    }
  });

  it('opens a later step at the first one that isn’t filled in yet', async () => {
    const { location } = renderApp(`/settings/feedback/new?step=widget`);
    expect(await screen.findByRole('heading', { name: 'Name & site', level: 2 })).toBeTruthy();
    await waitFor(() => expect(location()).toBe(`/settings/feedback/new`));
  });

  it('creates at the end of Widget, then shows Install with the snippets; Done goes back to the list', async () => {
    const { user, location } = await openNew();
    await fillSite(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    // Privacy and limits stay folded until opened.
    const more = await screen.findByRole('button', { name: /Privacy and limits/ });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('REPORTS PER HOUR')).toBeNull();
    await user.click(more);
    expect(screen.getByLabelText('REPORTS PER HOUR')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create integration' }));
    expect(await screen.findByText('Docs created.')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Install', level: 2 })).toBeTruthy();
    expect(location()).toMatch(/^\/settings\/feedback\/fbi_[^?]+\?step=install$/);
    const page = document.querySelector<HTMLElement>('[data-screen="feedback-integration"]');
    expect(page?.querySelectorAll('pre').length).toBe(1);
    expect(screen.getByRole('link', { name: 'Open https://docs.example.com' })).toBeTruthy();
    await user.click(screen.getByRole('link', { name: 'Done' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Website feedback' })).toBeTruthy();
    await waitFor(() => expect(location()).toBe(`/connections?connection=feedback`));
    expect(await screen.findByText('Docs')).toBeTruthy();
  });

  it('goes back to the step the server refused, with its field errors', async () => {
    const { services } = servicesWith((method, path) =>
      method === 'POST' && path.endsWith('/feedback/integrations')
        ? json(
            {
              error: {
                code: 'validation_failed',
                message: 'Neo can’t assess these reports.',
                fields: { agentId: ['Neo can’t assess these reports.'] },
              },
            },
            400,
          )
        : null,
    );
    const { user, location } = await openNew(services);
    await fillSite(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Create integration' }));
    expect(
      await screen.findByText('Neo can’t assess these reports.', { selector: '[data-feedback-agent] span' }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Where reports go', level: 2 })).toBeTruthy();
    expect(location()).toBe(`/settings/feedback/new?step=reports`);
    expect(screen.getByRole('alert').textContent).toBe('Neo can’t assess these reports.');
  });

  it('shows the runtime’s reason when a managed Whombat refuses a new integration, not a bare status', async () => {
    // The secure session's answer to the runtime's refusal: the app code `managed.feedback_intake` in `error.code`.
    const refusal = errorResponse('req_1', {
      code: 'not_allowed',
      message: FEEDBACK_DROP_TEXT.unsupported,
      details: { code: 'managed.feedback_intake', managed: true, reason: 'feedbackIntake' },
    });
    const { services } = servicesWith((method, path) =>
      method === 'POST' && path.endsWith('/feedback/integrations')
        ? json(refusal.body, refusal.status)
        : null,
    );
    const { user } = await openNew(services);
    await fillSite(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Create integration' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(FEEDBACK_DROP_TEXT.unsupported));
  });

  it('says so where the Whombat doesn’t let it be managed, on the list and the pages', async () => {
    const locked = () =>
      servicesWith((method, path) => {
        if (method !== 'GET') return null;
        if (path.endsWith('/feedback/integrations'))
          return json({ integrations: [], can: { manage: false } });
        if (path.includes('/feedback/integrations/'))
          return json({ error: { code: 'forbidden', message: 'Not here.' } }, 403);
        return null;
      }).services;
    await openFeedbackTab(locked());
    expect(await screen.findByText('Feedback integrations can’t be set up on this Whombat.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New integration' })).toBeNull();
    cleanup();

    renderApp(`/settings/feedback/new`, locked());
    expect(await screen.findByText('Feedback integrations can’t be set up on this Whombat.')).toBeTruthy();
    expect(screen.queryByLabelText('NAME')).toBeNull();
    cleanup();

    renderApp(`/settings/feedback/${feedbackIntegration.id}`, locked());
    expect(await screen.findByText('Feedback integrations can’t be set up on this Whombat.')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('says so when the integration no longer exists', async () => {
    renderApp(`/settings/feedback/fbi_gone`);
    expect(await screen.findByText('This integration no longer exists.')).toBeTruthy();
  });
});

/* Report card details ------------------------------------------------------------------------------ */

interface CardHarnessProps {
  card: MessageCardData;
  variant?: 'message' | 'thread';
  attachments?: readonly Attachment[];
}

function CardHarness({ card, variant, attachments }: CardHarnessProps) {
  const boot = useBootstrap({ params: { burrow } });
  if (!boot.data) return null;
  return (
    <MessageCard
      burrow={burrow}
      card={card}
      messageId="msg_fb-root"
      conversationId="cnv_incidents"
      variant={variant}
      attachments={attachments}
    />
  );
}

function renderCard(
  card: MessageCardData,
  services: AppServices = fixtureServices(),
  props: Omit<CardHarnessProps, 'card'> = {},
) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <CardHarness card={card} {...props} /> }),
    history: createMemoryHistory({ initialEntries: ['/c/incidents'] }),
    notFoundMode: 'root',
  });
  render(
    <Providers services={services}>
      <RouterProvider router={router} />
    </Providers>,
  );
}

async function openDetails() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Details' }));
  const region = await screen.findByRole('region', { name: /^Details of FB-/ });
  return { user, region };
}

describe('a report in its conversation (docs/decisions/report-rows.md RR-01…RR-07)', () => {
  const screenshot: Attachment = {
    id: 'att_fb-vat-pdf',
    name: 'invoice-pdf.png',
    contentType: 'image/png',
    size: 184_220,
    url: '/api/v1/burrows/burrow-hq/attachments/att_fb-vat-pdf',
    kind: 'image',
    width: 1280,
    height: 800,
  };

  it('is one row; Details opens the whole report with its screenshots, Hide details folds it back', async () => {
    renderCard(reportCardOf(reportLikelyBug), fixtureServices(), { attachments: [screenshot] });
    const row = await screen.findByRole('region', {
      name: 'Bug report FB-7K3Q-9M2X: Burrow Billing · Triaged · Likely bug',
    });
    expect(row.dataset.variant).toBe('line');
    expect(within(row).queryByText('BUG REPORT · FB-7K3Q-9M2X')).toBeNull();
    expect(within(row).queryByRole('img', { name: /invoice-pdf/ })).toBeNull();
    const { user, region } = await openDetails();
    expect(within(row).getByText('BUG REPORT · FB-7K3Q-9M2X')).toBeTruthy();
    expect(within(region).getByRole('button', { name: /invoice-pdf\.png/ })).toBeTruthy();
    await within(region).findByText('WHAT THEY SENT');
    await user.click(within(row).getByRole('button', { name: 'Hide details' }));
    expect(within(row).queryByText('BUG REPORT · FB-7K3Q-9M2X')).toBeNull();
    expect(within(row).getByRole('button', { name: 'Details' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('is the whole card at the root of its thread', async () => {
    renderCard(reportCardOf(reportLikelyBug), fixtureServices(), { variant: 'thread' });
    expect(await screen.findByText('BUG REPORT · FB-7K3Q-9M2X')).toBeTruthy();
    expect(document.querySelector('[data-variant="line"]')).toBeNull();
  });
});

describe('report details', () => {
  it('renders visitor text as plain text, never HTML or Markdown', async () => {
    const hostile = {
      ...reportLikelyBug,
      submitted: { ...reportLikelyBug.submitted, description: '<img src=x onerror=alert(1)> **hi** @Banjo' },
    };
    const { services } = servicesWith((method, path) =>
      method === 'GET' && path.endsWith(`/feedback/reports/${reportLikelyBug.id}`)
        ? json({
            report: hostile,
            can: { setStatus: true, retry: false, handoff: false, redact: false, decide: false },
          })
        : null,
    );
    renderCard(reportCardOf(hostile), services);
    const { region } = await openDetails();
    const text = await within(region).findByText('<img src=x onerror=alert(1)> **hi** @Banjo');
    expect(text.tagName).toBe('P');
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('shows the pages before reporting and marks a signed-in reporter’s email as verified (CT-161, CT-162)', async () => {
    renderCard(reportCardOf(reportLikelyBug));
    const { region } = await openDetails();
    const verified = await within(region).findByRole('img', {
      name: 'Email verified: the visitor signed in with this address',
    });
    expect(verified.textContent).toBe('Email verified');
    expect(verified.closest('p')?.textContent).toContain('Sanne Visser · sanne@visser-advies.example');
    const trail = within(region).getByText('Pages before reporting').parentElement as HTMLElement;
    const steps = [...trail.querySelectorAll('li')].map((li) => li.textContent);
    expect(steps).toEqual([
      '/Overview · Burrow Billing8 min before',
      '/invoicesInvoices · Burrow Billing6 min before',
      '/invoices/:idInvoice · Burrow Billing3 min before',
    ]);
    // Old reports keep their steps to reproduce.
    expect(within(region).getByText('Steps')).toBeTruthy();
  });

  it('an unverified reporter and a report without a trail show neither', async () => {
    renderCard(reportCardOf(reportFailed));
    const { region } = await openDetails();
    await within(region).findByText('WHAT THEY SENT');
    expect(within(region).queryByText('Email verified')).toBeNull();
    expect(within(region).queryByText('Pages before reporting')).toBeNull();
  });

  it('retries a failed assessment, and says so honestly when the server can’t yet', async () => {
    const { services } = servicesWith((method, path) =>
      method === 'POST' && path.endsWith('/retry')
        ? json({ error: { code: 'not_implemented', message: 'Not implemented yet.' } }, 501)
        : null,
    );
    renderCard(reportCardOf(reportFailed), services);
    const { user, region } = await openDetails();
    expect(
      await within(region).findByText(/Assessment failed — The assessment ran out of time/),
    ).toBeTruthy();
    expect(within(region).getByText(/Timed out after 30 minutes/)).toBeTruthy();
    await user.click(within(region).getByRole('button', { name: 'Retry assessment' }));
    expect(
      await within(region).findByText('Retrying assessments isn’t available on this Whombat yet.'),
    ).toBeTruthy();
  });

  it('retry queues the assessment again where the server has it', async () => {
    renderCard(reportCardOf(reportFailed));
    const { user, region } = await openDetails();
    await user.click(await within(region).findByRole('button', { name: 'Retry assessment' }));
    expect(await screen.findByText('Assessment queued again.')).toBeTruthy();
    expect(await within(region).findByText('Assessment queued')).toBeTruthy();
  });

  it('asks for development with a note; an approval request is shown as waiting', async () => {
    const { services, fetch } = servicesWith((method, path) =>
      method === 'POST' && path.endsWith('/handoff')
        ? json({ approvalRequired: true, approvalId: 'apr_x', approvalNumber: 14, eventId: 'evt_abc' }, 202)
        : null,
    );
    renderCard(reportCardOf(reportLikelyBug), services);
    const { user, region } = await openDetails();
    await user.click(await within(region).findByRole('button', { name: 'Ask for development' }));
    await user.type(within(region).getByLabelText(/^Note for .+ \(optional\)$/), 'Check older invoices');
    await user.click(within(region).getByRole('button', { name: 'Hand to development' }));
    expect(await within(region).findByText('Waiting for a person to approve (approval #14).')).toBeTruthy();
    const post = fetch.mock.calls.find(([input]) => String(input).endsWith('/handoff'));
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ note: 'Check older invoices' });
  });

  it('removes content after a confirmation that says what goes and what stays', async () => {
    renderCard(reportCardOf(reportLikelyBug));
    const { user, region } = await openDetails();
    await user.click(await within(region).findByRole('button', { name: 'Remove content' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove the content of FB-7K3Q-9M2X?' });
    expect(within(dialog).getByText(/deleted for good/).textContent).toMatch(/signed history stay/);
    await user.click(within(dialog).getByRole('button', { name: 'Remove content' }));
    expect(await screen.findByText('Content of FB-7K3Q-9M2X removed.')).toBeTruthy();
    expect(await within(region).findByText(/^Content removed/)).toBeTruthy();
    expect(within(region).queryByText('WHAT THEY SENT')).toBeNull();
  });

  it('tells people outside the channel they can’t see it', async () => {
    const { services } = servicesWith((_method, path) =>
      path.includes('/feedback/reports/')
        ? json({ error: { code: 'not_found', message: 'Not found' } }, 404)
        : null,
    );
    renderCard(reportCardOf(reportLikelyBug), services);
    const { region } = await openDetails();
    expect(await within(region).findByText('You can’t see this report.')).toBeTruthy();
  });
});
