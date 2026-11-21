/**
 * The browser's activity rows (browser.md BT-03; since contracts 0.125 Hermes's browser tools, CT-1235; AP-225, AP-5251)
 * as core words them (`describeActivity`) and the feed shows them: in the run's and conversation's activity, and
 * compact as a Work item's latest row. They are never folded with routine reads, and filling a login names no site.
 */
import { render, screen, within } from '@testing-library/react';
import {
  type Activity,
  type ActivityCopyInput,
  browserActivityObject,
  describeActivity,
} from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { ActivityFeed } from './ActivityFeed';

const at = (m: number) => new Date(Date.UTC(2026, 8, 23, 9, m)).toISOString();

/** A row as the server stores it: its words from core, from what the runner reported. */
function row(n: number, report: Partial<ActivityCopyInput> & { tool: string }, input?: unknown): Activity {
  const copy: ActivityCopyInput = {
    kind: 'web',
    status: 'done',
    object: input === undefined ? null : browserActivityObject(report.tool, input),
    exitCode: null,
    failure: null,
    keyNeeded: null,
    ...report,
  };
  const words = describeActivity(copy);
  return {
    id: `act_${n}`,
    burrowId: 'bur_burrow-hq',
    dispatchId: 'dsp_1',
    runId: null,
    agentId: 'prn_dusty',
    conversationId: 'cnv_billing-v2',
    threadRootId: null,
    key: `1:${n}`,
    attempt: 1,
    seq: n,
    kind: copy.kind,
    tool: copy.tool,
    status: copy.status,
    title: words.title,
    object: copy.object,
    detail: words.detail,
    important: words.important,
    approvalId: null,
    link: null,
    evidence: null,
    startedAt: at(n),
    updatedAt: at(n),
    finishedAt: copy.status === 'running' ? null : at(n),
  };
}

const ROWS = [
  row(1, { tool: 'browser_navigate' }, { url: 'https://example.com/pricing?ref=mail#plans' }),
  row(2, { tool: 'browser_snapshot', object: 'https://example.com' }),
  row(3, { tool: 'browser_click' }, { ref: '@e12' }),
  row(4, { tool: 'browser_vault' }, { entry: 'vlt_shop' }),
  row(
    5,
    { tool: 'browser_navigate', status: 'failed', failure: 'error' },
    { url: 'https://down.example.org/' },
  ),
];

describe('browser activity rows', () => {
  it('read as core words them, one row each', () => {
    render(<ActivityFeed activities={ROWS} timeZone="Europe/Amsterdam" />);
    const items = within(screen.getByRole('list', { name: 'Activity' })).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(items.map((li) => li.textContent)).toEqual([
      'Opened example.comhttps://example.com/pricing11:01',
      'Used the browser on example.comhttps://example.com11:02',
      'Used the browser11:03',
      'Used a private Vault entry11:04',
      'Couldn’t open down.example.orghttps://down.example.org/11:05',
    ]);
    expect(items.map((li) => li.querySelector('[role="img"]')?.getAttribute('aria-label'))).toEqual([
      'Done',
      'Done',
      'Done',
      'Done',
      'Failed',
    ]);
    // Nothing typed, no query or fragment, and a sign-in names no site.
    expect(screen.queryByText(/ref=mail|#plans|@e12|vlt_shop|shop/)).toBeNull();
  });

  it('show as a Work item’s latest row', () => {
    render(<ActivityFeed activities={[ROWS[0] as Activity]} timeZone="Europe/Amsterdam" compact />);
    expect(screen.getByText('Opened example.com')).toBeTruthy();
    expect(screen.getByText('https://example.com/pricing')).toBeTruthy();
    expect(screen.queryByText('11:01')).toBeNull();
  });
});
