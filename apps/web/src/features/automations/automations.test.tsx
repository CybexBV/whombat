/**
 * The run pages and Delete over the fixture world's automations (`automationFixtures.ts`): what each run shows and
 * what Delete sends. The overview, the automation's page and the plan card: `automationChat.test.tsx`.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_NAME } from '../../app/oneFixtures';
import { AGENT_SIGNATURE } from '../../app/trackerFixtures';
import { jsonAnswer, recordingWorld } from '../../test/recordingWorld';
import { mockedServices, renderApp } from '../../test/renderApp';

const B = `/burrows/${burrow.slug}`;

describe('fixing the bugs it finds (AP-986…AP-993)', () => {
  it('a run shows the assessment, the request waiting for a person and the pull request', async () => {
    const first = renderApp(
      '/automation-runs/44',
      mockedServices(recordingWorld({ automations: true }).fetch),
    );
    expect(
      await screen.findByRole('list', {
        name: 'Assessment: Bug · high importance · fairly sure · small fix · suggests a change',
      }),
    ).toBeTruthy();
    expect(
      screen.getByText('The cart total floors cents instead of rounding them, so €19.995 shows as €19.99.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review request #31' })).toBeTruthy();
    first.unmount();
    renderApp('/automation-runs/43', mockedServices(recordingWorld({ automations: true }).fetch));
    expect(
      await screen.findByText(`No: everything checks out, so ${ASSISTANT_NAME} fixes it on its own.`),
    ).toBeTruthy();
    expect(screen.getByText('Opened pull request #215.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'The pull request on GitHub' }).getAttribute('href')).toBe(
      'https://github.com/whombat/web/pull/215',
    );
  });
});

describe('merging the fix once its checks pass (AP-1042…AP-1047)', () => {
  it('a run shows the merge waiting for checks, and the one it merged', async () => {
    const first = renderApp(
      '/automation-runs/47',
      mockedServices(recordingWorld({ automations: true }).fetch),
    );
    const steps = await screen.findByRole('list', { name: 'Steps' });
    const merge = (await within(steps).findByText('Merge the fix')).closest('li') as HTMLElement;
    expect(within(merge).getByText('Waiting for checks on PR #216')).toBeTruthy();
    expect(within(merge).getByText(/^WAITING/)).toBeTruthy();
    expect(within(merge).getByRole('link', { name: 'PR #216' })).toBeTruthy();
    first.unmount();

    renderApp('/automation-runs/43', mockedServices(recordingWorld({ automations: true }).fetch));
    const done = (await screen.findByText('Merge the fix')).closest('li') as HTMLElement;
    expect(within(done).getByText('Merged PR #215 into main.')).toBeTruthy();
    expect(within(done).getByText(/^DONE/)).toBeTruthy();
  });
});

describe('plain words (AP-1002…AP-1006)', () => {
  it('a run says what each check decided, folds what it never reached and the technical details', async () => {
    const user = userEvent.setup();
    renderApp('/automation-runs/42', mockedServices(recordingWorld({ automations: true }).fetch));
    expect(
      await screen.findByRole('list', { name: 'Assessment: Not a bug · low importance · fairly sure' }),
    ).toBeTruthy();
    // The check's story instead of its rule and a Yes/No line; the rule one click away.
    expect(
      screen.getByText(`No: ${ASSISTANT_NAME} says it’s not a bug and recommends no change.`),
    ).toBeTruthy();
    expect(screen.queryByText('No: it stopped here.')).toBeNull();
    const rule = screen.getByRole('button', { name: 'Show the rule' });
    const expression = screen.getByText(
      /^trigger\.item == "issue" && \(\(steps\.ask\.assessment\.kind == "bug"/,
    );
    expect(rule.getAttribute('aria-expanded')).toBe('false');
    expect(rule.getAttribute('aria-controls')).toBe(expression.id);
    expect(expression.hidden).toBe(true);
    await user.click(rule);
    expect(rule.getAttribute('aria-expanded')).toBe('true');
    expect(expression.hidden).toBe(false);
    // The nine steps after it never started (the merge too, AP-1047): one line, until it is opened.
    const steps = screen.getByRole('list', { name: 'Steps' });
    expect(within(steps).queryByText('Approve it')).toBeNull();
    await user.click(screen.getByRole('button', { name: '9 more steps skipped' }));
    expect(within(steps).getByText('Approve it')).toBeTruthy();
    expect(within(steps).getByText('Say so on the issue')).toBeTruthy();
    // The technical details, folded under the plain answer.
    const details = document.querySelector('[data-step-details]') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText('Technical details')).toBeTruthy();
    expect(details.textContent).toContain('pnpm test cart checkout');
  });

  it('a run of a waiting fix says why a person decides', async () => {
    renderApp('/automation-runs/44', mockedServices(recordingWorld({ automations: true }).fetch));
    expect(
      await screen.findByText(
        `Yes, a person decides: ${ASSISTANT_NAME} isn’t sure enough and someone is assigned to it.`,
      ),
    ).toBeTruthy();
    expect(screen.getByText(`Yes: ${ASSISTANT_NAME} says it’s a bug of high importance.`)).toBeTruthy();
    // Still running: nothing folds.
    expect(screen.queryByRole('button', { name: /more steps skipped$/ })).toBeNull();
  });
});

describe('an automation asking for a yes (AP-997, AP-998)', () => {
  it('the request says an automation asks, with its mark, in the modal', async () => {
    renderApp('/automation-runs/44?approval=31', mockedServices(recordingWorld({ automations: true }).fetch));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('AN AUTOMATION IS ASKING')).toBeTruthy();
    expect(
      within(dialog).getByRole('img', { name: 'Automation “Assess and fix new issues on whombat/web”' }),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/SOMEONE IS ASKING/)).toBeNull();
  });
});

describe('a deleted automation (AP-976, AP-977)', () => {
  it('a deleted automation’s run says so and links nowhere', async () => {
    renderApp('/automation-runs/12', mockedServices(recordingWorld({ automations: true }).fetch));
    expect(await screen.findByText('This automation was deleted.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'WEEKLY RELEASE NOTES' })).toBeNull();
    expect(screen.getByText('WEEKLY RELEASE NOTES')).toBeTruthy();
  });
});

describe('tracker reports', () => {
  it('a run shows its report, what it wrote back, and sends the reporter a reply', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = recordingWorld({ automations: true });
    renderApp('/automation-runs/46', mockedServices(fetch));
    expect(await screen.findByRole('heading', { name: '#15 · The rollout never finishes' })).toBeTruthy();
    expect(screen.getByText('Acme Desk dev · HollowMere College · Production')).toBeTruthy();
    expect(
      screen.getByRole('list', { name: 'Bug report, Investigating, High priority, Likely bug' }),
    ).toBeTruthy();
    expect(screen.getByText('Anna de Vries · a.devries@hollowmere.example')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'The reporter’s screenshot, opens it larger' })).toBeTruthy();
    expect(screen.getByText('Wrote to Acme Desk dev #15: Likely bug · high priority.')).toBeTruthy();
    // The tracker named in its driver's words.
    expect(screen.getByText(/^Acme Desk emails the reporter/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Reply to the reporter…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reply to the reporter' });
    await user.click(within(dialog).getByRole('button', { name: 'Send reply' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Write a reply.');
    await user.type(within(dialog).getByRole('textbox', { name: 'REPLY' }), 'Thanks, Anna. We found it.');
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'ALSO SET THE STATUS' }),
      'in_progress',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Send reply' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const sent = calls.find((c) => c.path === `${B}/trackers/runs/arn_46/item`);
    expect(sent?.body).toMatchObject({ message: 'Thanks, Anna. We found it.', status: 'in_progress' });
    expect((sent?.body as { requestId?: string } | undefined)?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText('Sent to the reporter, and set to In progress.')).toBeTruthy();
    expect(screen.getByText('Thanks, Anna. We found it.')).toBeTruthy();
  });
});

describe('what the agent suggests (AP-1050…AP-1056)', () => {
  it('run #48: the agent suggests a change, a person decides, and the card waits', async () => {
    const user = userEvent.setup();
    renderApp('/automation-runs/48', mockedServices(recordingWorld({ automations: true }).fetch));
    const line = await screen.findByRole('list', {
      name: 'Assessment: Feature request · medium importance · sure · suggests a change',
    });
    expect(within(line).getByText('Suggests a change')).toBeTruthy();
    expect(screen.getByText(`Yes: ${ASSISTANT_NAME} suggests a change.`)).toBeTruthy();
    expect(
      screen.getByText(
        `Yes, a person decides: ${ASSISTANT_NAME} suggests a change, and only bugs of high importance or more are fixed without asking.`,
      ),
    ).toBeTruthy();
    const approve = screen.getByText('Approve it').closest('li') as HTMLElement;
    expect(
      within(approve).getByText('Suggested change for #214: Let us filter invoices by status'),
    ).toBeTruthy();
    expect(within(approve).getByRole('button', { name: 'Review request #32' })).toBeTruthy();
    // The server cut the long rule at 300 characters: Show the rule shows it whole, from the definition.
    const ask = (screen.getByText('Does a person need to say yes?').closest('li') as HTMLElement) ?? null;
    await user.click(within(ask).getByRole('button', { name: 'Show the rule' }));
    const rule = within(ask).getByText(/^!\(steps\.ask\.assessment\.kind == "bug"/);
    expect(rule.textContent).toMatch(/run\.today\.fix < 5\)$/);
    expect(rule.textContent?.length).toBeGreaterThan(300);
  });

  it('run #49: a customer’s bug below the threshold that the agent suggests fixing', async () => {
    renderApp('/automation-runs/49', mockedServices(recordingWorld({ automations: true }).fetch));
    expect(await screen.findByRole('heading', { name: '#17 · Diagnostics are hard to read' })).toBeTruthy();
    expect(screen.getByText('Wrote to Acme Desk dev #17: Likely bug · normal priority.')).toBeTruthy();
    expect(
      screen.getByText(`Yes: ${ASSISTANT_NAME} suggests fixing this bug of medium importance.`),
    ).toBeTruthy();
    expect(screen.getByText('Fix Acme Desk dev #17: Diagnostics are hard to read')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review request #33' })).toBeTruthy();
  });
});

describe('replying to a tracker’s customers', () => {
  it('run #49 says what it sent the customer, signed, and the status it set', async () => {
    renderApp('/automation-runs/49', mockedServices(recordingWorld({ automations: true }).fetch));
    expect(
      await screen.findByText('Replied to the customer and set Acme Desk dev #17 to “Investigating”.'),
    ).toBeTruthy();
    const sent = document.querySelector('[data-step-reply]');
    expect(sent?.textContent?.startsWith('Thanks for letting us know. ')).toBe(true);
    expect(sent?.textContent?.endsWith(`\n\n${AGENT_SIGNATURE}`)).toBe(true);
    // The report's conversation has it as the tracker shows it: from the team, in its words.
    expect(await screen.findByRole('heading', { name: '#17 · Diagnostics are hard to read' })).toBeTruthy();
    expect(await screen.findAllByText(new RegExp(AGENT_SIGNATURE))).toHaveLength(2);
    expect(screen.getByText('Acme team')).toBeTruthy();
  });

  it('run #46’s report says where its fix is, the pull request a link', async () => {
    renderApp('/automation-runs/46', mockedServices(recordingWorld({ automations: true }).fetch));
    expect(await screen.findByRole('heading', { name: '#15 · The rollout never finishes' })).toBeTruthy();
    expect(screen.getByText('FIX')).toBeTruthy();
    const fix = document.querySelector('[data-tracker-fix]') as HTMLElement;
    expect(fix.textContent).toBe(
      'PR #52 merged · live on dev.desk.acme.example (Acme Desk 0.1.176) · waiting for production',
    );
    expect(within(fix).getByRole('link', { name: 'PR #52' }).getAttribute('href')).toBe(
      'https://github.com/whombat/web/pull/52',
    );
  });
});

describe('a run of an older version', () => {
  it('shows a step of a kind this version doesn’t know as an earlier step', async () => {
    const { fetch } = recordingWorld({ automations: true }, async (call, res) => {
      if (call.path !== `${B}/automation-runs/45`) return res;
      const detail = (await res.json()) as { run: { steps: Record<string, unknown>[] } };
      const [first] = detail.run.steps;
      detail.run.steps.push({ ...first, stepId: 'older', index: 9, kind: 'a_step_from_before', name: '' });
      return jsonAnswer(detail);
    });
    renderApp('/automation-runs/45', mockedServices(fetch));
    const steps = await screen.findByRole('list', { name: 'Steps' });
    expect(await within(steps).findByText('An earlier step')).toBeTruthy();
  });
});
