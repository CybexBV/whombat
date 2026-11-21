/**
 * Automations made by talking to the agent (docs/app/decisions/automation-chat.md), over the fixture world's
 * automations and plans (`automationFixtures.ts`): the overview and what each row sends, and the read-only page. The
 * plan card: `cards/automationPlanCard.test.tsx`.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { burrow } from '@whombat/fixtures';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PLAN_THREADS } from '../../app/automationFixtures';
import { ASSISTANT_NAME } from '../../app/oneFixtures';
import { jsonAnswer, recordingWorld } from '../../test/recordingWorld';
import { mockedServices, renderApp } from '../../test/renderApp';

const B = `/burrows/${burrow.slug}`;
const WEB_PRS = 'New pull requests on whombat/web';
const BILLING = 'Assess new issues and pull requests on whombat/billing';

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

const world = (resourceful = false) => recordingWorld({ automations: true, resourceful });
/** A row of the list: its link starts with the automation's name. */
/** A row's link: its name says the source, then the automation's whole name. */
const rowOf = (name: string) =>
  screen.findByRole('link', { name: new RegExp(`\\. ${name.replace(/[/.]/g, '\\$&')}\\. `) });

describe('the overview', () => {
  it('says what it is and that you tell the agent; an example fills the field and sending starts a Chat thread', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = world();
    const app = renderApp('/automations', mockedServices(fetch));
    expect(await screen.findByRole('heading', { level: 1, name: 'Automations' })).toBeTruthy();
    expect(screen.getByText(new RegExp(`tell ${ASSISTANT_NAME}\\.$`))).toBeTruthy();
    // No form, templates, import or editor: New automation is gone.
    expect(screen.queryByRole('button', { name: 'New automation' })).toBeNull();
    const field = screen.getByRole('textbox', {
      name: `Tell ${ASSISTANT_NAME} what should happen on its own…`,
    });
    // The ideas come from what is connected: a server of the world's, by its name (care-plan.md).
    const idea = await screen.findByRole('button', { name: /^Every Monday, tell me how .+ is doing$/ });
    const words = idea.textContent ?? '';
    await user.click(idea);
    expect((field as HTMLTextAreaElement).value).toBe(words);
    await user.type(field, '{Enter}');
    await waitFor(() => expect(calls.some((c) => c.path === `${B}/chats`)).toBe(true));
    expect(calls.find((c) => c.path === `${B}/chats`)?.body).toEqual({ text: words });
    await waitFor(() => expect(app.location()).toMatch(/^\/chat\?thread=msg_/));
  });

  it('a row is the name and one line of how it is doing, and opens its page', async () => {
    const user = userEvent.setup();
    const app = renderApp('/automations', mockedServices(world().fetch));
    expect(await screen.findByRole('heading', { name: /^Automations \d+$/ })).toBeTruthy();
    const fresh = await rowOf(WEB_PRS);
    expect(fresh.getAttribute('data-automation-state')).toBe('waiting');
    expect(within(fresh).getByText('Not on yet')).toBeTruthy();
    expect(within(fresh).getByText('Its plan waits for your yes in Chat')).toBeTruthy();
    const billing = await rowOf(BILLING);
    expect(billing.getAttribute('data-automation-state')).toBe('waiting');
    const off = await rowOf('Check whombat/infra');
    expect(within(off).getByText('Off')).toBeTruthy();
    expect(within(off).getByText(/^Last run /)).toBeTruthy();
    expect(within(await rowOf('Answer messages')).getByText('Not on yet')).toBeTruthy();
    // No switch, chips or buttons on the list: everything is on the automation's page.
    expect(screen.queryByRole('switch', { name: BILLING })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Talk about it: / })).toBeNull();
    await user.click(billing);
    await waitFor(() => expect(app.location()).toBe('/automations/aut_assess-billing'));
  });

  it('lists the agent’s schedules as only telling you; the switch pauses one, Remove asks first', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = world(true);
    renderApp('/automations', mockedServices(fetch));
    await rowOf(BILLING);
    const rows = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[data-schedule-row]')];
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    const active = rows.find((r) => r.dataset.scheduleStatus === 'active') as HTMLElement;
    expect(
      (screen.getByRole('heading', { name: 'Only tells you' }).closest('section') as HTMLElement).contains(
        active,
      ),
    ).toBe(true);
    await user.click(within(active).getByRole('switch'));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/pause'))).toBe(true));
    expect(await screen.findByText('Paused. It won’t run until you resume it.')).toBeTruthy();
    const other = [...document.querySelectorAll<HTMLElement>('[data-schedule-row]')].find((r) =>
      within(r).queryByRole('button', { name: /^Remove:/ }),
    ) as HTMLElement;
    await user.click(within(other).getByRole('button', { name: /^Remove:/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });
});

describe('the agent’s schedules that didn’t load', () => {
  const SCHEDULES = `${B}/agent/schedules`;
  const LOAD_FAILED = /^Couldn’t load the schedules\./;
  /** The world, with the schedules' read failing while `failing.on` and, with `none`, no automations. */
  const failingWorld = (failing: { on: boolean }, none = false) =>
    recordingWorld({ automations: true, resourceful: true }, (call, res) => {
      if (call.method !== 'GET') return res;
      if (failing.on && call.path === SCHEDULES)
        return jsonAnswer({ error: { code: 'internal', message: 'The schedules are down.' } }, 500);
      if (none && call.path === `${B}/automations`) return jsonAnswer({ automations: [] });
      return res;
    });
  const scheduleRows = () => [...document.querySelectorAll<HTMLElement>('[data-schedule-row]')];
  const onlyTellsYou = () =>
    screen.getByRole('heading', { name: 'Only tells you' }).closest('section') as HTMLElement;

  it('says so under Only tells you beside the automations, and Retry reads them again', async () => {
    const user = userEvent.setup();
    const failing = { on: true };
    renderApp('/automations', mockedServices(failingWorld(failing).fetch));
    await rowOf(BILLING);
    const note = await screen.findByText(LOAD_FAILED);
    expect(onlyTellsYou().contains(note)).toBe(true);
    expect(scheduleRows()).toHaveLength(0);
    failing.on = false;
    await user.click(within(onlyTellsYou()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(scheduleRows().length).toBeGreaterThan(0));
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();
  });

  it('a refresh that failed keeps the schedules already read', async () => {
    const failing = { on: false };
    const app = renderApp('/automations', mockedServices(failingWorld(failing).fetch));
    await waitFor(() => expect(scheduleRows().length).toBeGreaterThan(0));
    const read = scheduleRows().length;
    failing.on = true;
    await app.services.queryClient.refetchQueries({ queryKey: ['whombat', 'schedules.list'] });
    expect(await screen.findByText(LOAD_FAILED)).toBeTruthy();
    expect(scheduleRows()).toHaveLength(read);
  });

  it('with no automations, a failed read is no empty list; one that worked with nothing is', async () => {
    const user = userEvent.setup();
    const failing = { on: true };
    renderApp('/automations', mockedServices(failingWorld(failing, true).fetch));
    expect(await screen.findByText(LOAD_FAILED)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'No automations yet' })).toBeNull();
    failing.on = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(scheduleRows().length).toBeGreaterThan(0));
    expect(screen.queryByRole('heading', { name: 'No automations yet' })).toBeNull();
  });

  it('shows nothing yet when both reads worked and found nothing', async () => {
    const world = recordingWorld({ automations: true }, (call, res) =>
      call.method === 'GET' && call.path === `${B}/automations` ? jsonAnswer({ automations: [] }) : res,
    );
    renderApp('/automations', mockedServices(world.fetch));
    expect(await screen.findByRole('heading', { name: 'No automations yet' })).toBeTruthy();
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();
  });
});

describe('an automation’s page', () => {
  it('is read-only: what happens step by step, what it asks first, its limits and runs; no editor', async () => {
    const user = userEvent.setup();
    const app = renderApp('/automations/aut_assess-billing', mockedServices(world().fetch));
    expect(await screen.findByRole('heading', { level: 1, name: BILLING })).toBeTruthy();
    const happens = screen.getByRole('heading', { name: 'WHAT HAPPENS' }).closest('section') as HTMLElement;
    const steps = within(happens).getAllByRole('listitem');
    expect(steps[0]?.getAttribute('data-flow-step')).toBe('when');
    expect(within(steps[0] as HTMLElement).getByText('A new issue on whombat/billing')).toBeTruthy();
    expect(within(happens).getByText('Comments on GitHub')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'ASKS YOU FIRST' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'LIMITS' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'RECENT RUNS' })).toBeTruthy();
    expect(screen.getByText(`What ${ASSISTANT_NAME} is asked`)).toBeTruthy();
    for (const gone of ['Steps', 'JSON', 'Keys and webhook'])
      expect(screen.queryByRole('tab', { name: gone })).toBeNull();
    expect(screen.queryByRole('button', { name: /Publish|Save draft|Export/ })).toBeNull();
    // A change waits for the person's yes: Open goes to its thread.
    const state = document.querySelector('[data-automation-state]') as HTMLElement;
    expect(state.dataset.automationState).toBe('waiting');
    await user.click(within(state).getByRole('button', { name: /Open$/ }));
    await waitFor(() => expect(app.location()).toBe(`/chat?thread=${PLAN_THREADS.billing}`));
  });

  it('a run waiting for a yes opens from the page', async () => {
    const user = userEvent.setup();
    const app = renderApp('/automations/aut_tracker-dev', mockedServices(world().fetch));
    const open = await screen.findByRole('link', { name: /^Run #\d+ is waiting for a yes\. Open$/ });
    await user.click(open);
    await waitFor(() => expect(app.location()).toMatch(/^\/automation-runs\/\d+$/));
  });

  it('Try it runs a test on the newest issue, and the toast opens the run', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = world();
    const app = renderApp('/automations/aut_assess-billing', mockedServices(fetch));
    await user.click(await screen.findByRole('button', { name: 'Try it' }));
    await waitFor(() => expect(calls.at(-1)?.path).toBe(`${B}/automations/aut_assess-billing/runs`));
    expect(calls.at(-1)?.body).toEqual({ test: true, sample: { number: 488 } });
    expect(await screen.findByText('Test run started.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(app.location()).toMatch(/^\/automation-runs\/\d+$/));
  });

  it('Talk about it without a thread opens Chat with the automation’s name in the box', async () => {
    const user = userEvent.setup();
    const app = renderApp('/automations/aut_suspected-bug', mockedServices(world().fetch));
    await user.click(await screen.findByRole('button', { name: 'Talk about it' }));
    await waitFor(() => expect(app.location()).toBe('/chat?new=1'));
    expect(await screen.findByDisplayValue('About “Suspected bug”:')).toBeTruthy();
  });

  it('switches on and off without the agent', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = world();
    renderApp('/automations/aut_check-infra', mockedServices(fetch));
    const toggle = await screen.findByRole('switch', { name: 'Check whombat/infra' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(calls).toEqual([
      { method: 'POST', path: `${B}/automations/aut_check-infra/enabled`, body: { enabled: true } },
    ]);
    expect(await screen.findByText('Switched on.')).toBeTruthy();
  });

  it('switches off and deletes without the agent, then the list has it no more', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = world();
    const app = renderApp('/automations/aut_suspected-bug', mockedServices(fetch));
    const toggle = await screen.findByRole('switch', { name: 'Suspected bug' });
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    await user.click(screen.getByRole('button', { name: 'Delete automation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete “Suspected bug”?' });
    expect(
      within(dialog).getByText(
        'It stops now, and runs in progress stop too. Its past runs stay in the audit log.',
      ),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(app.location()).toBe('/automations'));
    expect(calls.map((c) => `${c.method} ${c.path.slice(B.length)}`)).toEqual([
      'POST /automations/aut_suspected-bug/enabled',
      'DELETE /automations/aut_suspected-bug',
    ]);
    await rowOf(BILLING);
    expect(screen.queryByRole('link', { name: /\. Suspected bug\. / })).toBeNull();
  });
});
