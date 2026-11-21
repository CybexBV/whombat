import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Activity } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/renderApp';
import { ActivityFeed } from './ActivityFeed';

const at = (m: number) => new Date(Date.UTC(2026, 8, 23, 9, m)).toISOString();

function row(n: number, over: Partial<Activity>): Activity {
  return {
    id: `act_${n}`,
    burrowId: 'bur_burrow-hq',
    dispatchId: 'dsp_1',
    runId: null,
    agentId: 'prn_banjo',
    conversationId: 'cnv_billing-v2',
    threadRootId: null,
    key: `1:${n}`,
    attempt: 1,
    seq: n,
    kind: 'read',
    tool: 'Read',
    status: 'done',
    title: `Read file${n}.ts`,
    object: `src/file${n}.ts`,
    detail: null,
    important: false,
    approvalId: null,
    link: null,
    evidence: null,
    startedAt: at(n),
    updatedAt: at(n),
    finishedAt: at(n),
    ...over,
  };
}

const feed = (activities: Activity[]) =>
  render(<ActivityFeed activities={activities} timeZone="Europe/Amsterdam" />);

describe('activity feed (WS-13…WS-17)', () => {
  it('folds routine reads into a group that opens, and keeps failures loud', async () => {
    const user = userEvent.setup();
    feed([
      row(1, {}),
      row(2, {}),
      row(3, { kind: 'search', tool: 'Grep', title: 'Searched for vat', object: 'vat' }),
      row(4, {
        kind: 'command',
        tool: 'Bash',
        status: 'failed',
        title: 'Command failed',
        detail: 'exit 1',
        important: true,
        object: 'pnpm test',
        evidence: { input: 'pnpm test', output: '3 failed', truncated: true },
      }),
    ]);
    const list = screen.getByRole('list', { name: 'Activity' });
    expect(within(list).getAllByRole('listitem', { hidden: false }).length).toBeGreaterThanOrEqual(2);
    const group = screen.getByText('Read 2 files and ran 1 search');
    const details = group.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await user.click(group);
    expect(details.open).toBe(true);
    expect(within(details).getByText('Read file1.ts')).toBeTruthy();

    expect(screen.getByRole('img', { name: 'Failed' })).toBeTruthy();
    expect(screen.getByText('exit 1')).toBeTruthy();
    const failed = screen.getByText('Command failed').closest('details') as HTMLDetailsElement;
    await user.click(screen.getByText('Command failed'));
    expect(failed.open).toBe(true);
    expect(within(failed).getByText('3 failed')).toBeTruthy();
    expect(within(failed).getByText('$ pnpm test', { exact: false })).toBeTruthy();
    expect(within(failed).getByText('Shortened: this is the end of the output.')).toBeTruthy();
  });

  it('shows interrupted rows muted, never as done', () => {
    feed([
      row(1, {
        kind: 'edit',
        tool: 'Edit',
        status: 'interrupted',
        title: 'Edited invoice.ts · interrupted',
        detail: 'the turn stopped',
        important: true,
      }),
    ]);
    expect(screen.getByRole('img', { name: 'Interrupted' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Done' })).toBeNull();
    expect(screen.getByText('the turn stopped')).toBeTruthy();
  });

  it('folds the oldest entries of a long turn behind “Show n earlier”', async () => {
    const user = userEvent.setup();
    feed(
      Array.from({ length: 20 }, (_, i) =>
        row(i + 1, {
          kind: 'whombat',
          tool: 'whombat.run_log',
          title: `Wrote log ${i + 1}`,
          important: true,
        }),
      ),
    );
    expect(screen.queryByText('Wrote log 1')).toBeNull();
    expect(screen.getByText('Wrote log 20')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show 10 earlier' }));
    expect(screen.getByText('Wrote log 1')).toBeTruthy();
  });

  it('says so when no steps came yet', () => {
    feed([]);
    expect(screen.getByText('No steps reported yet.')).toBeTruthy();
  });

  it('is on the run page under ACTIVITY', async () => {
    renderApp('/runs/1907');
    const section = await screen.findByRole('region', { name: 'Activity' });
    expect(within(section).getByRole('heading', { name: 'ACTIVITY' })).toBeTruthy();
    expect(await within(section).findByText('Read 3 files and ran 1 search')).toBeTruthy();
    expect(within(section).getByText('Running pnpm test billing/pdf')).toBeTruthy();
  });
});
