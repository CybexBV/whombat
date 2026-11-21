import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CARD_FRAME_WORDS, reportLine } from '@whombat/client';
import { APPROVAL_CARD_WORDS, type Decider } from '@whombat/core/approvals';
import type { Approval } from '@whombat/core/domain';
import { dusty, run as fixtureRun, mara, PRINCIPALS, SEED_NOW, SEED_TIME_ZONE } from '@whombat/fixtures';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from './ApprovalCard';
import {
  approvalDeclined,
  approvalDeployed,
  approvalDeploying,
  approvalFailed,
  approvalPending,
  approvalWaitingReview,
  digest,
  planAllMarkers,
  planNow,
  reportAssessed,
  reportFailedCard,
  reportFeatureCard,
  reportQueuedCard,
  reportRemovedCard,
  runFailed,
  runLineDone,
  runLineFailed,
  runLineLive,
  runPaused,
} from './cardStates';
import { DigestCard } from './DigestCard';
import { PlanCard } from './PlanCard';
import { nameLookup, principalLookup } from './parts';
import { ReportCard } from './ReportCard';
import { ReportLine } from './ReportLine';
import { RunCard } from './RunCard';
import { RunLine } from './RunLine';

const principals = principalLookup(PRINCIPALS);
const names = nameLookup(principals);
const maraViewer: Decider = { id: mara.id, kind: 'person' };

describe('PlanCard', () => {
  it('marks every step state, with a label for screen readers', () => {
    render(<PlanCard plan={planAllMarkers} principals={principals} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.dataset.state)).toEqual(['done', 'active', 'queued', 'gate']);
    expect(screen.getAllByRole('img').map((m) => m.getAttribute('aria-label'))).toEqual(
      expect.arrayContaining(['Done', 'In progress', 'Queued', 'Needs a person']),
    );
  });

  it('hides "Open plan canvas" without a canvas', () => {
    render(<PlanCard plan={{ ...planNow, canvasSlug: null }} principals={principals} />);
    expect(screen.queryByRole('link', { name: 'Open plan canvas' })).toBeNull();
  });
});

describe('DigestCard', () => {
  it('folds a collapsed section to one line until it is opened', () => {
    render(<DigestCard card={digest} />);
    const noise = screen.getByRole('region', { name: 'Noise' });
    expect(within(noise).queryAllByRole('listitem')).toHaveLength(0);
    const show = within(noise).getByRole('button', { name: /Show 2/ });
    expect(show.textContent).toBe('Roddelpraat newsletter · New UniFi Design CenterShow 2');
    expect(show.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(show);
    expect(within(noise).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('RunLine (AP-668)', () => {
  it('shows a live run that changed nothing as one line with its step, a bar and Watch run', () => {
    render(<RunLine run={runLineLive} />);
    const line = screen.getByRole('region', { name: `Run #6: ${runLineLive.title}` });
    expect(line.dataset.variant).toBe('line');
    expect(line.textContent).toContain('Checking · Inspect repository update');
    expect(screen.getByRole('progressbar', { name: 'Run progress' }).getAttribute('aria-valuenow')).toBe(
      '25',
    );
    expect(screen.getByRole('link', { name: 'Watch run' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Branch room' })).toBeNull();
    expect(screen.queryByText(/files/)).toBeNull();
  });

  it('shows a finished run as its result and how long it took, without the bar', () => {
    render(<RunLine run={runLineDone} />);
    expect(screen.getByText('Run #6 · Done in 1m 12s')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

describe('RunLine: Open run and Try again (AP-699)', () => {
  it('opens a run that has stopped with Open run, and watches a live one', () => {
    const { rerender } = render(<RunLine run={runLineDone} />);
    const open = screen.getByRole('link', { name: 'Open run' });
    expect(open.getAttribute('href')).toBe('/runs/6');
    expect(screen.queryByRole('link', { name: 'Watch run' })).toBeNull();
    for (const status of ['failed', 'taken_over', 'paused'] as const) {
      rerender(<RunLine run={{ ...runLineDone, status }} />);
      expect(screen.getByRole('link', { name: 'Open run' })).toBeTruthy();
    }
    rerender(<RunLine run={runLineLive} />);
    expect(screen.getByRole('link', { name: 'Watch run' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open run' })).toBeNull();
  });

  it('offers Try again on a failed line, a real button that calls the retry', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<RunLine run={runLineFailed} onRetry={onRetry} />);
    const line = screen.getByRole('region', { name: `Run #6: ${runLineFailed.title}` });
    expect(line.textContent).toContain(
      'Run #6 · Failed in 1m 12s · Couldn’t fetch the repository from GitHub.',
    );
    // A narrow column cuts the lead before the controls; the whole text stays the title (AP-668).
    expect(line.querySelector('[title]')?.getAttribute('title')).toBe(
      'Run #6 · Failed in 1m 12s · Couldn’t fetch the repository from GitHub.',
    );
    const retry = within(line).getByRole('button', { name: 'Try again' });
    expect(retry.tagName).toBe('BUTTON');
    expect(retry.getAttribute('type')).toBe('button');
    // Before the link, which keeps its place at the end of the line.
    expect(retry.nextElementSibling).toBe(within(line).getByRole('link', { name: 'Open run' }));
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);

    // In flight: disabled and busy until the server answers.
    rerender(<RunLine run={runLineFailed} onRetry={onRetry} retrying />);
    const busy = screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(busy);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows no Try again without a retry to call, nor on a run that did not fail', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<RunLine run={runLineFailed} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    for (const run of [runLineLive, runLineDone, { ...runLineDone, status: 'paused' as const }]) {
      rerender(<RunLine run={run} onRetry={onRetry} />);
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    }
  });
});

describe('RunCard', () => {
  it('says when a run is paused, and hides Branch room without a PR', () => {
    render(<RunCard run={{ ...runPaused, prNumber: null }} />);
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.getByText(/^Paused: Editing billing\/pdf\/format\.ts/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Branch room' })).toBeNull();
  });

  it('says why a live run needs attention, and nothing without it (CT-197, AP-597)', () => {
    const text = 'Neo stopped without finishing this run.';
    const { rerender } = render(<RunCard run={{ ...fixtureRun, attention: text }} />);
    expect(screen.getByTestId('run-attention').textContent).toBe(`Needs attention · ${text}`);
    rerender(<RunCard run={{ ...fixtureRun, attention: null }} />);
    expect(screen.queryByTestId('run-attention')).toBeNull();
    rerender(<RunCard run={fixtureRun} />);
    expect(screen.queryByTestId('run-attention')).toBeNull();
    // Without a retry to call a failed run shows no Try again here either (AP-699).
    rerender(<RunCard run={{ ...fixtureRun, status: 'failed', attention: text }} />);
    expect(screen.queryByTestId('run-attention')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('offers Try again on a failed run, and keeps the mock’s Watch run (AP-699)', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<RunCard run={runFailed} onRetry={onRetry} />);
    const card = screen.getByRole('region', { name: new RegExp(runFailed.title) });
    expect(within(card).getByText(CARD_FRAME_WORDS.marks.failed)).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Watch run' })).toBeTruthy();
    const retry = within(card).getByRole('button', { name: 'Try again' });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<RunCard run={runFailed} onRetry={onRetry} retrying />);
    expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(true);
    for (const status of ['live', 'paused', 'done', 'taken_over'] as const) {
      rerender(<RunCard run={{ ...runFailed, status }} onRetry={onRetry} />);
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    }
  });
});

function renderApproval(approval: Approval, viewer: Decider = maraViewer) {
  const handlers = { onApprove: vi.fn(), onDetails: vi.fn(), onUndo: vi.fn() };
  render(
    <ApprovalCard
      approval={approval}
      names={names}
      viewer={viewer}
      now={SEED_NOW}
      timeZone={SEED_TIME_ZONE}
      {...handlers}
    />,
  );
  return {
    card: screen.getByRole('region', { name: 'Approval: Deploy feat/invoice-pdf to staging' }),
    ...handlers,
  };
}

describe('ApprovalCard', () => {
  it('waiting for review, deploying, deployed, failed and declined labels', () => {
    const labels: [Approval, string, string][] = [
      [approvalWaitingReview, 'APPROVED · WAITING FOR REVIEW', 'toneWarn'],
      [approvalDeploying, 'APPROVED · DEPLOYING', 'toneOk'],
      [approvalDeployed, 'DEPLOYED', 'toneOk'],
      [approvalFailed, 'DEPLOY FAILED', 'toneBad'],
      [approvalDeclined, 'DECLINED', 'toneBad'],
    ];
    for (const [approval, label, tone] of labels) {
      const { card, unmount } = {
        ...renderApproval(approval),
        unmount: () => document.body.replaceChildren(),
      };
      expect(within(card).getByText(label).className).toMatch(tone);
      unmount();
    }
  });

  it('declined: tells who was told, and can be undone', () => {
    const { card } = renderApproval(approvalDeclined);
    expect(within(card).getByText('declined')).toBeTruthy();
    expect(
      within(card).getByText(new RegExp(`^Declined\\. ${dusty.name} won’t deploy this commit\\.`)),
    ).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('shows Details but no Approve to an agent, which never decides', () => {
    const { card } = renderApproval(approvalPending, { id: dusty.id, kind: 'agent' });
    expect(within(card).queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Details' })).toBeTruthy();
  });
});

describe('ApprovalCard, a connected service’s call (connections-catalog.md CX-21, AP-763)', () => {
  const call = (connection: Approval['connection']): Approval =>
    ({
      ...approvalPending,
      keyId: 'connections.write',
      action: {
        type: 'connection_call',
        params: {
          connectionId: 'con_ha',
          handle: 'homeassistant',
          tool: 'HassTurnOn',
          toolHash: 'a'.repeat(64),
        },
      },
      connection,
      conditions: approvalPending.conditions.filter((c) => c.kind === 'person_approves'),
    }) as Approval;

  it('shows the connection, the tool and the arguments to its deciders', () => {
    const { container } = render(
      <ApprovalCard
        approval={call({
          label: 'Home Assistant · home.lan',
          catalogId: 'homeassistant',
          argumentsPreview: '{"name":"Kitchen lights"}',
        })}
        names={names}
        viewer={maraViewer}
        now={SEED_NOW}
        timeZone={SEED_TIME_ZONE}
      />,
    );
    expect(screen.getByText('CALL · Home Assistant · home.lan · HassTurnOn')).toBeTruthy();
    expect(container.textContent).toContain('"name": "Kitchen lights"');
  });

  it('shows no arguments to someone who may not see them', () => {
    const { container } = render(
      <ApprovalCard
        approval={call(null)}
        names={names}
        viewer={maraViewer}
        now={SEED_NOW}
        timeZone={SEED_TIME_ZONE}
      />,
    );
    expect(container.textContent).not.toContain('Kitchen');
    expect(screen.queryByText(/^CALL/)).toBeNull();
  });
});

describe('ApprovalCard, an everyday ask (the one order; its answered state)', () => {
  const ask = (over: Partial<Approval> = {}): Approval =>
    ({
      ...approvalPending,
      keyId: 'connections.write',
      action: {
        type: 'connection_call',
        params: {
          connectionId: 'con_ha',
          handle: 'homeassistant',
          tool: 'HassTurnOn',
          toolHash: 'a'.repeat(64),
        },
      },
      conditions: approvalPending.conditions.filter((c) => c.kind === 'person_approves'),
      ...over,
    }) as Approval;
  const show = (
    approval: Approval,
    later = true,
    unknown: { checkLabel: string; onCheck: () => void } | null = null,
  ) =>
    render(
      <ApprovalCard
        approval={approval}
        names={names}
        viewer={maraViewer}
        now={SEED_NOW}
        timeZone={SEED_TIME_ZONE}
        unknown={unknown}
        approveLater={
          later ? { label: 'Tonight at 03:00', at: '2026-09-24T01:00:00.000Z', onSelect: vi.fn() } : undefined
        }
      />,
    );
  const answerButtons = () =>
    within(screen.getByRole('group', { name: APPROVAL_CARD_WORDS.answersLabel })).getAllByRole('button');
  const answers = () => answerButtons().map((b) => b.textContent);

  it('answers Yes, now · Yes, tonight · No with a later time, Yes, do it · No without, all alike', () => {
    show(ask());
    expect(answers()).toEqual(['Yes, now', 'Yes, tonight', 'No']);
    // Equal weight: none is filled, so none looks recommended.
    expect(new Set(answerButtons().map((b) => b.className)).size).toBe(1);
    document.body.replaceChildren();
    show(ask(), false);
    expect(answers()).toEqual(['Yes, do it', 'No']);
  });

  it('says the permission it uses and the exact moment Yes, tonight means, before the answers', () => {
    show(ask());
    const card = screen.getByRole('region', { name: /^Approval: / });
    const text = card.textContent ?? '';
    expect(text).toContain('Change things in connected services');
    expect(text).toContain('Thursday, 24 September 2026 at 03:00');
    expect(text.indexOf('Thursday, 24 September')).toBeLessThan(text.indexOf('Yes, now'));
    // No box for the person's own yes.
    expect(within(card).queryByText('A person says yes')).toBeNull();
  });

  it('says the answer may have gone through, with a check and no answers to send again', async () => {
    const onCheck = vi.fn();
    show(ask(), true, { checkLabel: 'Ask Neo to check', onCheck });
    expect(screen.getByText(APPROVAL_CARD_WORDS.unknown)).toBeTruthy();
    expect(screen.queryByRole('group', { name: APPROVAL_CARD_WORDS.answersLabel })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Yes, now' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Ask Neo to check' }));
    expect(onCheck).toHaveBeenCalledOnce();
  });

  it('keeps its title once answered and says where it is, without the answers', () => {
    const executeAt = new Date(SEED_NOW.getTime() + 3 * 3_600_000).toISOString();
    show(ask({ state: 'approved', decidedById: mara.id, decidedAt: SEED_NOW.toISOString(), executeAt }));
    const card = screen.getByRole('region', { name: /^Approval: / });
    expect(card.getAttribute('data-answer')).toBe('scheduled');
    expect(within(card).getByText(/^Scheduled for /)).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Yes, now' })).toBeNull();
    document.body.replaceChildren();
    show(ask({ state: 'declined', decidedById: mara.id, decidedAt: SEED_NOW.toISOString() }));
    expect(screen.getByText(/^You said no/)).toBeTruthy();
  });
});

describe('ReportCard', () => {
  const props = { now: SEED_NOW, timeZone: SEED_TIME_ZONE };

  it('renders the visitor’s words as plain text: no HTML, no Markdown, no mentions', () => {
    const summary = '<b>bold</b> and **bold** for @Banjo, see https://evil.example';
    const { container } = render(<ReportCard card={{ ...reportQueuedCard, summary }} {...props} />);
    expect(screen.getByText(summary).textContent).toBe(summary);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText(summary).tagName).toBe('P');
  });

  it('agent-written assessment text is plain text too', () => {
    const card = {
      ...reportAssessed,
      assessment: { ...reportAssessed.assessment, summary: '**Fixed** in <i>format.ts</i> by @Banjo' },
    };
    const { container } = render(<ReportCard card={card} {...props} />);
    expect(screen.getByText('**Fixed** in <i>format.ts</i> by @Banjo')).toBeTruthy();
    expect(container.querySelector('i')).toBeNull();
  });

  it('queued, failed, removed and feature states', () => {
    const { rerender } = render(<ReportCard card={reportQueuedCard} {...props} />);
    expect(screen.getByText('Burrow Billing · New · Assessment queued')).toBeTruthy();
    rerender(<ReportCard card={reportFailedCard} {...props} />);
    const failed = screen.getByText('Burrow Billing · New · Assessment failed');
    expect(failed.className).toMatch(/bad/);
    rerender(<ReportCard card={reportRemovedCard} {...props} />);
    expect(screen.getByText('Content removed')).toBeTruthy();
    expect(screen.queryByText(/screenshot/)).toBeNull();
    rerender(<ReportCard card={reportFeatureCard} {...props} />);
    expect(screen.getByText('FEATURE REQUEST · FB-H8XM-5VKT')).toBeTruthy();
    expect(screen.getByText('Burrow Billing · New · Feature request')).toBeTruthy();
  });
});

describe('ReportLine (docs/decisions/report-rows.md RR-02)', () => {
  it('says the outcome and one sentence over the reference and the facts, as a named region', () => {
    render(<ReportLine line={reportLine(reportAssessed)} onToggle={() => {}} />);
    const row = screen.getByRole('region', {
      name: 'Bug report FB-7K3Q-9M2X: Burrow Billing · Triaged · Likely bug',
    });
    expect(row.dataset.card).toBe('report');
    expect(within(row).getByText('Likely bug').className).toMatch(/lead/);
    expect(within(row).getByText(reportAssessed.assessment.summary as string)).toBeTruthy();
    expect(within(row).getByText('FB-7K3Q-9M2X').parentElement?.textContent).toBe(
      'FB-7K3Q-9M2X · Burrow Billing · Triaged · 2 screenshots',
    );
  });

  it('Details opens the report in place and Hide details folds it back', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <ReportLine line={reportLine(reportQueuedCard)} expanded={open} onToggle={() => setOpen((v) => !v)}>
          <p>The whole report</p>
        </ReportLine>
      );
    }
    render(<Harness />);
    const details = screen.getByRole('button', { name: 'Details' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    expect(details.hasAttribute('aria-controls')).toBe(false);
    expect(screen.queryByText('The whole report')).toBeNull();
    fireEvent.click(details);
    const hide = screen.getByRole('button', { name: 'Hide details' });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    const region = document.getElementById(hide.getAttribute('aria-controls') ?? '');
    expect(region?.textContent).toBe('The whole report');
    fireEvent.click(hide);
    expect(screen.queryByText('The whole report')).toBeNull();
  });

  it('keeps the visitor’s words plain text, and says Content removed once they are gone', () => {
    const summary = '<b>bold</b> and **bold** for @Banjo, see https://evil.example';
    const { container, rerender } = render(
      <ReportLine line={reportLine({ ...reportQueuedCard, summary })} />,
    );
    expect(screen.getByText(summary).textContent).toBe(summary);
    expect(container.querySelector('b, strong, a')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<ReportLine line={reportLine(reportRemovedCard)} />);
    expect(screen.getByText('Content removed').className).toMatch(/quiet/);
  });
});
