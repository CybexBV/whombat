/**
 * Tracker reports in automation runs, pure (docs/decisions/report-trackers.md TA-07…TA-09, TA-14, TA-15): what the
 * mirror keeps (never the reporter), `trigger.text`, the scope and item key, the report as an agent reads it, the
 * report as people read it, and the line a person's reply adds to the thread.
 */
import { describe, expect, it } from 'vitest';
import type { CatalogConnectionRow } from '../connections/types';
import { reportText } from './access';
import type { TrackerItemFull } from './driver';
import {
  MIRROR_DESCRIPTION_MAX,
  mirroredReport,
  seenOn,
  type TrackerRunItem,
  trackerHeadline,
  trackerItemKey,
  trackerItemScope,
  trackerReplyText,
  trackerTriggerText,
} from './items';
import { scrubSecrets } from './paths';
import { reportView, updateLine } from './people';

const WORDS = { product: 'Acme Desk', team: 'Acme Desk team' };

/** A report as a made-up tracker's driver reads it. */
const report: TrackerItemFull = {
  id: '6f1c9a52-3b7d-4e1f-9a2b-1c2d3e4f5a6b',
  number: 15,
  kind: 'bug',
  title: 'The rollout never finishes',
  description: 'Rita Reporter here: the rollout stays at 40%.',
  expected: 'It finishes.',
  organization: { id: 'org-1', name: 'HollowMere College' },
  environment: 'production',
  version: '0.1.131',
  page: 'Devices',
  browser: 'Chrome 141',
  status: 'new',
  priority: 'normal',
  assessment: null,
  duplicateOf: null,
  createdAt: '2026-10-10T07:00:00Z',
  updatedAt: '2026-10-10T08:05:00Z',
  messages: [
    { id: 'm1', author: 'reporter', body: 'Any news?', at: '2026-10-10T08:00:00Z' },
    { id: 'm2', author: 'team', body: 'Looking into it.', at: '2026-10-10T08:05:00Z' },
  ],
  hasScreenshot: true,
  hasDiagnostics: true,
  release: null,
  reporter: { name: 'Rita Reporter', email: 'rita@hollowmere.example' },
  screenshot: 'data:image/png;base64,iVBORw0KGgo=',
  evidence: 'Recent actions and requests (oldest first):\n- GET /v1/rollouts · HTTP 504',
};

function item(over: Partial<TrackerRunItem> = {}): TrackerRunItem {
  const { reportedAt: _at, ...m } = mirroredReport(report);
  return {
    ...m,
    connectionId: 'con_dev',
    connection: 'Acme Desk dev',
    handle: 'acme',
    host: 'desk.acme.example',
    product: 'Acme Desk',
    ...over,
  };
}

describe('the mirror (TA-07)', () => {
  it('keeps what a run needs, never the reporter, and cuts the long texts', () => {
    const m = mirroredReport({ ...report, description: 'x'.repeat(20_000) });
    expect(m).toMatchObject({
      reportId: report.id,
      number: 15,
      type: 'bug',
      title: 'The rollout never finishes',
      organization: 'HollowMere College',
      environment: 'production',
      version: '0.1.131',
      page: 'Devices',
      browser: 'Chrome 141',
      status: 'new',
      priority: 'normal',
      hasScreenshot: true,
      hasDiagnostics: true,
      reportedAt: '2026-10-10T07:00:00.000Z',
    });
    expect(m.description).toHaveLength(MIRROR_DESCRIPTION_MAX);
    expect(JSON.stringify(m)).not.toContain('rita@hollowmere.example');
    expect(mirroredReport({ ...report, kind: 'feature', title: null }).title).toBe('Report #15');
  });
});

describe('trigger.* of a report (TA-08)', () => {
  it('reads like a GitHub item’s, in the tracker’s words', () => {
    const it0 = item();
    expect(trackerHeadline(it0)).toBe(
      'New bug report #15 in Acme Desk dev from HollowMere College: “The rollout never finishes”',
    );
    expect(trackerHeadline(item({ type: 'feature', organization: null }))).toBe(
      'New feature request #15 in Acme Desk dev: “The rollout never finishes”',
    );
    expect(trackerTriggerText(it0)).toBe(
      [
        'New bug report #15 in Acme Desk dev from HollowMere College: “The rollout never finishes”',
        '',
        'Rita Reporter here: the rollout stays at 40%.',
        '',
        'Expected: It finishes.',
        '',
        'Seen on: Devices · Chrome 141 · Acme Desk 0.1.131 (production)',
        'It came with diagnostics and a screenshot: tracker_item reads the whole report.',
      ].join('\n'),
    );
    expect(
      seenOn({ page: null, browser: null, version: null, environment: null, product: 'Acme Desk' }),
    ).toBeNull();
    expect(
      trackerTriggerText(
        item({ description: 'y'.repeat(5000), hasDiagnostics: false, hasScreenshot: false }),
      ),
    ).toMatch(/y…\n\nExpected: It finishes\.[\s\S]*\ntracker_item reads the whole report\.$/);
    expect(trackerItemKey('con_dev', 15)).toBe('tracker:con_dev#15');
    expect(trackerItemScope(it0)).toMatchObject({
      kind: 'tracker',
      event: 'item_opened',
      item: 'report',
      connection: 'Acme Desk dev',
      connectionId: 'con_dev',
      reportId: report.id,
      number: 15,
      ref: 'acme-15',
      type: 'bug',
      trusted: false,
      assigned: false,
      linkedPr: false,
      // The connection's host (`{{trigger.host}}`).
      host: 'desk.acme.example',
    });
  });

  it('says what the customer wrote back, cut, with the same fields (TA-31)', () => {
    const it0 = item();
    expect(trackerReplyText(it0, { event: 'wrote', text: 'It stops at 40% on Lab PC 1.' })).toBe(
      [
        'The customer wrote back on Acme Desk dev #15 “The rollout never finishes”: “It stops at 40% on Lab PC 1.”',
        '',
        'tracker_item reads the whole report and its conversation.',
      ].join('\n'),
    );
    expect(trackerReplyText(it0, { event: 'reopened', text: '' }).split('\n')[0]).toBe(
      'The customer says it still happens on Acme Desk dev #15 “The rollout never finishes”.',
    );
    const long = trackerReplyText(it0, { event: 'wrote', text: 'z'.repeat(5000) });
    expect(long.split('\n')[0]?.length).toBeLessThan(1700);
    expect(long).toContain('z…”');
    const scope = trackerItemScope(it0, { event: 'reopened', text: 'Still broken.' });
    expect(scope).toMatchObject({
      kind: 'tracker',
      event: 'reporter_replied',
      item: 'report',
      reportId: report.id,
      number: 15,
      ref: 'acme-15',
      host: 'desk.acme.example',
      description: it0.description,
    });
    expect(String(scope.text)).toMatch(
      /^The customer says it still happens on Acme Desk dev #15 .*: “Still broken\.”/,
    );
  });
});

describe('the report as an agent reads it (TA-09)', () => {
  it('has everything the tracker collected, with “The reporter” and its team, never the reporter’s name or email', () => {
    const text = reportText(report, WORDS);
    expect(text).toContain('Bug report #15: The rollout never finishes');
    expect(text).toContain('Acme Desk version: 0.1.131');
    expect(text).toContain('GET /v1/rollouts');
    expect(text).toContain('- The reporter (2026-10-10T08:00:00Z): Any news?');
    expect(text).toContain('- Acme Desk team (2026-10-10T08:05:00Z): Looking into it.');
    expect(text).toContain('the reporter here: the rollout stays at 40%.');
    expect(text).not.toMatch(/rita/i);
  });

  it('scrubs the tokens it was read with', () => {
    expect(scrubSecrets('a tgr_secret-token b', ['tgr_secret-token'])).toBe('a [token removed] b');
  });
});

describe('people on the run page (TA-14, TA-15)', () => {
  const connection = { id: 'con_dev', label: 'Acme Desk dev' } as CatalogConnectionRow;

  it('read the report live, the reporter included, the screenshot only when small enough', () => {
    const view = reportView(connection, report, null, WORDS);
    expect(view).toMatchObject({
      connection: 'Acme Desk dev',
      words: WORDS,
      number: 15,
      type: 'bug',
      environment: 'production',
      reporter: { name: 'Rita Reporter', email: 'rita@hollowmere.example' },
      screenshot: 'data:image/png;base64,iVBORw0KGgo=',
      messages: [
        { author: 'reporter', body: 'Any news?' },
        { author: 'team', body: 'Looking into it.' },
      ],
    });
    const big = { ...report, screenshot: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}` };
    expect(reportView(connection, big).screenshot).toBeNull();
  });

  it('see what was sent in the thread', () => {
    expect(updateLine('Acme Desk dev', 15, { message: 'We are on it.', product: 'Acme Desk' })).toBe(
      'Reply to the reporter, sent through Acme Desk:\n\nWe are on it.',
    );
    expect(updateLine('Acme Desk dev', 15, { status: 'in_progress' })).toBe(
      'Set Acme Desk dev #15 to In progress.',
    );
    expect(
      updateLine('Acme Desk dev', 15, {
        message: 'Not for now.',
        status: 'not_planned',
        product: 'Acme Desk',
      }),
    ).toBe(
      'Reply to the reporter, sent through Acme Desk:\n\nNot for now.\n\nSet Acme Desk dev #15 to Not planned.',
    );
  });
});
