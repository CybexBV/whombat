import { type TrackerFixView, UNKNOWN_TRACKER_WORDS } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  fixFollowUp,
  fixLine,
  fixPullRequest,
  trackerItemText,
  trackerReplyOutcome,
  trackerWriteOutcome,
} from './trackerItem';

const ACME = { product: 'Acme Desk', team: 'Acme team' };
const BEACON = { product: 'Beacon Helpdesk', team: 'Beacon support' };

describe('the write-back step', () => {
  it('says what it wrote on the report, or why it wrote nothing', () => {
    expect(
      trackerWriteOutcome({
        wrote: true,
        connection: 'Acme Desk dev',
        number: 15,
        assessment: 'likely_bug',
        priority: 'high',
      }),
    ).toBe('Wrote to Acme Desk dev #15: Likely bug · high priority.');
    expect(
      trackerWriteOutcome({
        wrote: true,
        connection: 'Acme Desk',
        number: 3,
        assessment: 'needs_information',
        priority: null,
      }),
    ).toBe('Wrote to Acme Desk #3: Needs information.');
    // Without the connection's name: the tracker's, or the plain words.
    expect(trackerWriteOutcome({ wrote: true, number: 3 }, ACME)).toBe('Wrote to Acme Desk #3.');
    expect(trackerWriteOutcome({ wrote: true, number: 3 })).toBe('Wrote to the tracker #3.');
    expect(trackerWriteOutcome({ wrote: true, connection: 'Acme Desk dev' })).toBe('Wrote to Acme Desk dev.');
    expect(
      trackerWriteOutcome({ wrote: false, reason: 'Nothing to write: Banjo says it’s not a bug.' }),
    ).toBe('Nothing to write: Banjo says it’s not a bug.');
    expect(trackerWriteOutcome({ reason: 'It may not write: its key says No.' })).toBe(
      'It may not write: its key says No.',
    );
    expect(trackerWriteOutcome({})).toBeNull();
  });
});

describe('replying to the customer', () => {
  const sent = {
    sent: true,
    connection: 'Acme Desk dev',
    number: 16,
    message: 'Thanks.\n\nBanjo - AI Developer',
  };

  it('says it replied and the status it set, in the tracker’s words, or why it sent nothing', () => {
    expect(trackerReplyOutcome({ ...sent, status: 'needs_information' })).toBe(
      'Replied to the customer and set Acme Desk dev #16 to “Needs information”.',
    );
    expect(trackerReplyOutcome({ ...sent, status: 'investigating' })).toBe(
      'Replied to the customer and set Acme Desk dev #16 to “Investigating”.',
    );
    expect(trackerReplyOutcome({ ...sent, status: null })).toBe(
      'Replied to the customer on Acme Desk dev #16.',
    );
    expect(trackerReplyOutcome({ sent: true }, BEACON)).toBe('Replied to the customer on Beacon Helpdesk.');
    expect(trackerReplyOutcome({ sent: true })).toBe('Replied to the customer on the tracker.');
    expect(
      trackerReplyOutcome({
        sent: false,
        reason: 'Nothing to send: Banjo had nothing to tell the customer.',
      }),
    ).toBe('Nothing to send: Banjo had nothing to tell the customer.');
    expect(trackerReplyOutcome({ reason: 'Banjo may not reply: its key says No.' })).toBe(
      'Banjo may not reply: its key says No.',
    );
    expect(trackerReplyOutcome({ sent: false, reason: ' ' })).toBeNull();
    expect(trackerReplyOutcome({})).toBeNull();
  });

  it('says the status a feature request’s answer set, in the tracker’s words', () => {
    const decided = { ...sent, number: 21 };
    expect(trackerReplyOutcome({ ...decided, status: 'planned' })).toContain('“Planned”');
    expect(trackerReplyOutcome({ ...decided, status: 'in_progress' })).toContain('“In progress”');
    expect(trackerReplyOutcome({ ...decided, status: 'not_planned' })).toContain('“Not planned”');
    expect(trackerReplyOutcome({ ...decided, status: 'not_planned' })).toContain('Acme Desk dev #21');
  });
});

describe('where the report’s fix is', () => {
  const fix: TrackerFixView = {
    state: 'open',
    repo: 'whombat/web',
    prNumber: 52,
    prUrl: 'https://github.com/whombat/web/pull/52',
    mergedAt: null,
    development: null,
    production: null,
    note: null,
  };
  const dev = { host: 'dev.desk.acme.example', version: '0.1.176', at: '2026-10-12T09:00:00.000Z' };
  const prod = { host: 'desk.acme.example', version: '0.1.180', at: '2026-10-20T09:00:00.000Z' };
  const merged = { ...fix, mergedAt: '2026-10-11T09:00:00.000Z' };

  it('says it in one line, the pull request first', () => {
    expect(fixPullRequest(fix)).toBe('PR #52');
    expect(fixLine(fix)).toBe('PR #52 open');
    expect(fixLine({ ...merged, state: 'merged' })).toBe('PR #52 merged · not live yet');
    expect(fixLine({ ...merged, state: 'development', development: dev }, ACME)).toBe(
      'PR #52 merged · live on dev.desk.acme.example (Acme Desk 0.1.176) · waiting for production',
    );
    expect(fixLine({ ...merged, state: 'development' })).toBe('PR #52 merged · waiting for production');
    expect(fixLine({ ...merged, state: 'live', development: dev }, ACME)).toBe(
      'PR #52 merged · live on dev.desk.acme.example (Acme Desk 0.1.176)',
    );
    // A tracker whose name isn't known: the version alone.
    expect(fixLine({ ...merged, state: 'live', development: dev })).toBe(
      'PR #52 merged · live on dev.desk.acme.example (version 0.1.176)',
    );
    // Live where the customer is: production once it runs the fix.
    expect(fixLine({ ...merged, state: 'live', development: dev, production: prod }, BEACON)).toBe(
      'PR #52 merged · live on desk.acme.example (Beacon Helpdesk 0.1.180)',
    );
    expect(fixLine({ ...merged, state: 'live', development: { ...dev, version: '' } }, ACME)).toBe(
      'PR #52 merged · live on dev.desk.acme.example',
    );
    expect(fixLine({ ...merged, state: 'live' })).toBe('PR #52 merged · live');
    expect(fixLine({ ...fix, state: 'closed' })).toBe('PR #52 closed without merging');
    expect(fixLine({ ...merged, state: 'stopped' })).toBe('PR #52 merged · no longer followed');
    expect(fixLine({ ...fix, state: 'stopped' })).toBe('PR #52 · no longer followed');
    expect(fixLine({ ...merged, state: 'stopped', development: dev }, ACME)).toBe(
      'PR #52 merged · live on dev.desk.acme.example (Acme Desk 0.1.176) · no longer followed',
    );
  });

  it('adds what the customer said about it', () => {
    expect(fixLine({ ...merged, state: 'confirmed', development: dev }, ACME)).toContain(
      '(Acme Desk 0.1.176)',
    );
    expect(fixLine({ ...merged, state: 'reopened', development: dev }, ACME)).toContain(
      '(Acme Desk 0.1.176)',
    );
    expect(fixFollowUp({ state: 'confirmed' })).toBe('The customer says it works.');
    expect(fixFollowUp({ state: 'reopened' })).toBe('The customer says it still happens.');
    expect(fixFollowUp({ state: 'live' })).toBeNull();
  });
});

/** Every line, the server's words filled in. */
const lines = (text: ReturnType<typeof trackerItemText>) =>
  Object.values(text)
    .map((v) => (typeof v === 'function' ? v('It didn’t answer.') : v))
    .join(' ');

describe('the report’s lines that name the tracker', () => {
  it('say the words they are given', () => {
    const acme = trackerItemText(ACME);
    expect(acme.loading).toContain('from Acme Desk');
    expect(acme.failedWith('It didn’t answer.')).toBe(
      'Couldn’t read the report from Acme Desk: It didn’t answer.',
    );
    expect(acme.teamAuthor).toBe('Acme team');
    expect(acme.emails).toMatch(/^Acme Desk emails/);
    expect(acme.replyNote).toContain('“Acme team”');
    const beacon = trackerItemText(BEACON);
    expect(beacon.loading).toContain('from Beacon Helpdesk');
    expect(beacon.teamAuthor).toBe('Beacon support');
    expect(beacon.statusNote).toMatch(/^Beacon Helpdesk emails/);
    expect(lines(beacon)).not.toContain('Acme');
  });

  it('read plainly for a tracker whose driver isn’t known, never “the the”', () => {
    const plain = trackerItemText(UNKNOWN_TRACKER_WORDS);
    expect(plain.loading).toContain('from the tracker');
    expect(plain.emails).toMatch(/^The tracker emails/);
    expect(plain.statusNote).toMatch(/^The tracker emails/);
    expect(plain.teamAuthor).toBe('The team');
    expect(plain.replyNote).toContain('as from the team.');
    expect(lines(trackerItemText())).not.toMatch(/the the/i);
  });
});
