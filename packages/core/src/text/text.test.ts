import { describe, expect, it } from 'vitest';
import { at, NOW, PRINCIPALS, TZ } from '../__fixtures__/world.js';
import { formatEventRef, parseEventRef } from '../ids.js';
import {
  agentWorkingText,
  auditSubtitle,
  burrowAddress,
  citationNumbers,
  composerPlaceholder,
  dayKey,
  daysAgo,
  dmEmptyTitle,
  exportToast,
  filesNote,
  formatAgo,
  formatAnswerMeta,
  formatCanvasProvenance,
  formatChecksPill,
  formatClock,
  formatCommitsFooter,
  formatDate,
  formatDayDivider,
  formatDue,
  formatDuration,
  formatLogDay,
  formatPlanLabel,
  formatPresence,
  formatRecent,
  formatRepoMeta,
  formatResearchLabel,
  formatResearchMeta,
  formatReviewLabel,
  formatRunKicker,
  formatRunLabel,
  formatSeconds,
  formatShortWeekday,
  formatThreadLast,
  formatUpdated,
  githubConnectedAs,
  githubConnectedToast,
  handleFrom,
  logLineTone,
  mentionNames,
  mentionQueryAt,
  mergeToast,
  needsYouToast,
  onboardingBackLabel,
  onboardingNextLabel,
  onboardingStepLabel,
  originHost,
  receiptMarker,
  resolveMentions,
  runKeysScope,
  runKeysTitle,
  runNowText,
  searchShortcutLabel,
  segmentCitations,
  segmentMentions,
  threadContext,
  typingLabel,
  welcomeToast,
  zonedParts,
} from './index.js';

/** The mock's `segs` and `burrowSlug`, verbatim, as the reference implementation. */
const mockSegs = (t: string) =>
  String(t)
    .split(/(@[A-Z][a-z]+)/)
    .filter(Boolean)
    .map((p) => ({ t: p, mention: p[0] === '@' }));
const _mockSlug = (burrow: string) =>
  (burrow || 'burrow')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'burrow';

const MOCK_TEXTS = [
  'Nice. @Muffin can you tag those tickets so we can close them when PDFs ship?',
  'Morning. Finance wants PDF invoices by the 14th. @Toffee can you break this down?',
  'Typeset works for me. @Banjo go for it.',
  'Customer 8812 got an invoice that is €0,01 off. @Dusty have we seen this before?',
  'That was the March bug. @Waffle can you keep an eye on rounding order?',
  '@Banjo',
  '@Banjo and @Dusty, and @Banjo again',
  'email me at mara@burrowhq.example or @lowercase or @ALLCAPS or @Two Words',
  '',
];

describe('mentions', () => {
  it('segments exactly like the mock', () => {
    for (const text of MOCK_TEXTS) {
      expect(segmentMentions(text).map((s) => ({ t: s.text, mention: s.mention }))).toEqual(mockSegs(text));
    }
    expect(segmentMentions('Typeset works for me. @Banjo go for it.')).toEqual([
      { text: 'Typeset works for me. ', mention: false },
      { text: '@Banjo', mention: true },
      { text: ' go for it.', mention: false },
    ]);
  });

  it('extracts and resolves names', () => {
    expect(mentionNames('@Banjo and @Dusty, and @Banjo again')).toEqual(['Banjo', 'Dusty']);
    const targets = PRINCIPALS.flatMap((p) =>
      p.kind === 'system'
        ? []
        : [
            {
              id: p.id,
              kind: p.kind,
              name: p.name,
              shortName: p.kind === 'person' ? p.shortName : undefined,
            },
          ],
    );
    expect(resolveMentions('@Dusty and @Mara, and @Dusty again', targets)).toEqual(['prn_dusty', 'prn_mara']);
    // Names that aren't the agent's or a person's mention nobody.
    expect(resolveMentions('@Banjo', targets)).toEqual([]);
    expect(resolveMentions('@Mara and @Ivo, see @Nobody', targets)).toEqual(['prn_mara']);
  });

  it('finds the @query at the caret for autocomplete', () => {
    expect(mentionQueryAt('hey @Ba', 7)).toEqual({ query: 'Ba', start: 4 });
    expect(mentionQueryAt('@', 1)).toEqual({ query: '', start: 0 });
    expect(mentionQueryAt('mara@x', 6)).toBeNull();
    expect(mentionQueryAt('hey @Banjo go', 13)).toBeNull();
  });
});

describe('slugs', () => {
  it('addresses a burrow by path on the public origin', () => {
    expect(burrowAddress('burrow-hq')).toBe('app.whombat.com/burrow-hq');
    expect(burrowAddress('acme', 'https://app.whombat.com/')).toBe('app.whombat.com/acme');
    expect(burrowAddress('acme', 'http://localhost:5180')).toBe('localhost:5180/acme');
    expect(originHost('https://app.whombat.com:443')).toBe('app.whombat.com');
    expect(originHost('http://127.0.0.1:80/x?y')).toBe('127.0.0.1');
    expect(originHost('app.whombat.com')).toBe('app.whombat.com');
  });

  it('derives channel names and handles', () => {
    expect(handleFrom('Mara Okafor')).toBe('mara-okafor');
    expect(handleFrom('Banjo')).toBe('banjo');
  });
});

describe('time and dates (Europe/Amsterdam, seed now = Wed 23 Sep 2026 11:22)', () => {
  it('reads wall-clock parts in the zone', () => {
    expect(zonedParts(NOW, TZ)).toEqual({
      year: 2026,
      month: 9,
      day: 23,
      hour: 11,
      minute: 22,
      second: 0,
      weekday: 3,
    });
    expect(zonedParts('2026-09-22T22:30:00Z', TZ).day).toBe(23);
    expect(dayKey('2026-09-22T22:30:00Z', TZ)).toBe('2026-09-23');
    expect(dayKey('2026-09-22T22:30:00Z', 'UTC')).toBe('2026-09-22');
    expect(zonedParts('2026-09-22T22:00:00Z', TZ).hour).toBe(0);
  });

  it('formats clock times', () => {
    expect(formatClock(NOW, TZ)).toBe('11:22');
    expect(formatClock(at('09:05'), TZ)).toBe('09:05');
    expect(formatClock('2026-12-01T08:00:00Z', TZ)).toBe('09:00');
  });

  it('formats day dividers', () => {
    expect(formatDayDivider(at('09:12'), NOW, TZ)).toBe('Today · Wednesday 23 September');
    expect(formatDayDivider(at('14:02', -1), NOW, TZ)).toBe('Yesterday · Tuesday 22 September');
    expect(formatDayDivider(at('14:02', -2), NOW, TZ)).toBe('Monday 21 September');
    expect(formatDayDivider('2025-11-12T10:00:00Z', NOW, TZ)).toBe('Wednesday 12 November 2025');
  });

  it('formats audit log days', () => {
    expect(formatLogDay(at('11:36'), NOW, TZ)).toBe('TODAY · 23 SEP');
    expect(formatLogDay(at('17:12', -1), NOW, TZ)).toBe('YESTERDAY · 22 SEP');
    expect(formatLogDay(at('17:12', -2), NOW, TZ)).toBe('MON · 21 SEP');
    expect(formatLogDay('2025-03-03T10:00:00Z', NOW, TZ)).toBe('MON · 3 MAR 2025');
  });

  it('formats recent times like the agent RECENT list', () => {
    expect(formatRecent('2026-09-23T09:21:30.000Z', NOW, TZ)).toBe('just now');
    expect(formatRecent(at('09:13'), NOW, TZ)).toBe('09:13');
    expect(formatRecent(at('16:00', -1), NOW, TZ)).toBe('Yesterday');
    expect(formatRecent(at('10:00', -2), NOW, TZ)).toBe('Mon');
    expect(formatRecent(at('10:00', -6), NOW, TZ)).toBe('Thu');
    expect(formatRecent(at('10:00', -7), NOW, TZ)).toBe('16 Sep');
    expect(formatRecent(at('10:00', -8), NOW, TZ)).toBe('15 Sep');
    expect(formatRecent('2025-12-01T10:00:00Z', NOW, TZ)).toBe('1 Dec 2025');
    expect(formatThreadLast(at('10:06'), NOW, TZ)).toBe('last 10:06');
    expect(formatThreadLast(at('11:21'), NOW, TZ)).toBe('last 11:21');
    expect(formatShortWeekday(NOW, TZ)).toBe('Wed');
    expect(daysAgo(at('10:00', -1), NOW, TZ)).toBe(1);
  });

  it('formats dates, due dates and durations', () => {
    expect(formatDate('2026-03-03T10:00:00Z', TZ, { year: 'always' })).toBe('3 Mar 2026');
    expect(formatDate('2026-03-04T10:00:00Z', TZ, { now: NOW })).toBe('4 Mar');
    expect(formatDate('2025-11-12T10:00:00Z', TZ, { now: NOW })).toBe('12 Nov 2025');
    expect(formatDate('2025-11-12T10:00:00Z', TZ, { year: 'never' })).toBe('12 Nov');
    expect(formatDue('2026-10-14')).toBe('Due 14 Oct');
    expect(() => formatDue('14 Oct')).toThrow();
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(41_000)).toBe('41s');
    expect(formatDuration(134_000)).toBe('2m 14s');
    expect(formatDuration(848_000)).toBe('14m 08s');
    expect(formatDuration(3_840_000)).toBe('1h 04m');
    expect(formatSeconds(1_800)).toBe('1.8s');
  });

  it('formats relative times', () => {
    expect(formatAgo('2026-09-23T09:10:00Z', NOW, TZ)).toBe('12 min ago');
    expect(formatAgo('2026-09-23T09:21:30Z', NOW, TZ)).toBe('just now');
    expect(formatAgo('2026-09-23T07:22:00Z', NOW, TZ)).toBe('2 hours ago');
    expect(formatAgo('2026-09-20T09:22:00Z', NOW, TZ)).toBe('3 days ago');
    expect(formatUpdated('2026-09-23T07:22:00Z', NOW, TZ)).toBe('2 hours ago');
    expect(formatUpdated('2026-09-23T04:00:00Z', NOW, TZ)).toBe('today');
    expect(formatUpdated(at('10:00', -1), NOW, TZ)).toBe('yesterday');
    expect(formatUpdated(at('10:00', -2), NOW, TZ)).toBe('Monday');
    expect(formatUpdated(at('10:00', -9), NOW, TZ)).toBe('last week');
    expect(formatUpdated('2026-09-23T09:10:00Z', NOW, TZ)).toBe('12 minutes ago');
  });

  it('rejects invalid dates', () => {
    expect(() => formatClock('not a date', TZ)).toThrow(RangeError);
  });
});

describe('shared screen copy', () => {
  it('labels cards', () => {
    expect(formatPlanLabel(4)).toBe('PLAN · 4 STEPS');
    expect(formatResearchLabel('PDF libraries')).toBe('RESEARCH · PDF LIBRARIES');
    expect(formatResearchMeta(14, 3)).toBe('14 sources · 3 tested');
    expect(formatReviewLabel(2)).toBe('REVIEW · 2 CHANGES REQUESTED');
    expect(formatReviewLabel(1)).toBe('REVIEW · 1 CHANGE REQUESTED');
    expect(formatRunLabel('live')).toBe('RUN · LIVE');
    expect(formatRunLabel('done')).toBe('RUN · DONE');
    expect(formatCommitsFooter({ add: 214, del: 12, files: 6 }, 'Banjo')).toBe(
      '+214 −12 · 6 files · signed by Banjo',
    );
    expect(formatChecksPill(38, 41, 'invoice_format_test')).toBe(
      '38 of 41 passed · 3 failing in invoice_format_test',
    );
    expect(formatChecksPill(41, 41)).toBe('41 of 41 passed');
  });

  it('writes the run page copy', () => {
    expect(formatRunKicker('live', 'Banjo', at('11:22'), TZ)).toBe('RUN · LIVE · BANJO · STARTED 11:22');
    expect(runNowText({ status: 'live', activity: 'Editing billing/pdf/format.ts', summary: null })).toBe(
      'Now: Editing billing/pdf/format.ts',
    );
    expect(
      runNowText({ status: 'done', activity: 'x', summary: 'Pushed 7be20f and asked Waffle to re-review.' }),
    ).toBe('Pushed 7be20f and asked Waffle to re-review.');
    expect(runKeysTitle('Banjo')).toBe('Banjo’s keys for this run');
    expect(runKeysScope('feat/invoice-pdf')).toBe('scoped to feat/invoice-pdf');
    expect(logLineTone('✓ 41 of 41 tests passed')).toBe('ok');
    expect(logLineTone('✗ 3 failing in invoice_format_test')).toBe('bad');
    expect(logLineTone('$ pnpm test billing/pdf')).toBe('command');
    expect(logLineTone('Opened PR #482')).toBe('plain');
  });

  it('writes conversation copy', () => {
    expect(typingLabel('Dusty')).toBe('Dusty is thinking');
    expect(dmEmptyTitle('Dusty')).toBe('This is the start of your chat with Dusty');
    expect(composerPlaceholder({ kind: 'branch', prNumber: 482 })).toBe('Comment on PR #482');
    expect(composerPlaceholder({ kind: 'dm', agentName: 'Dusty' })).toBe('Message Dusty');
    expect(threadContext('Chat', 'PDF libraries')).toBe('Chat · PDF libraries');
    expect(threadContext('Chat', null)).toBe('Chat');
    expect(filesNote('Dusty')).toContain('signed event from Dusty’s key');
  });

  it('writes log, search and toast copy', () => {
    const subtitle = auditSubtitle('Burrow HQ', 'Dusty');
    expect(subtitle).toContain('Every action in Burrow HQ');
    expect(subtitle).toContain('People and Dusty');
    expect(exportToast(16)).toBe('Exported 16 signed events as CSV.');
    expect(exportToast(1)).toBe('Exported 1 signed event as CSV.');
    expect(welcomeToast('Burrow HQ', 'Dusty')).toBe('Welcome to Burrow HQ. Dusty is already here.');
    expect(mergeToast(482)).toBe('Merged PR #482. Nice digging, everyone.');
    expect(formatAnswerMeta(3, 1800)).toBe('answered from 3 receipts · 1.8s');
    expect(receiptMarker(1)).toBe('receipt 1');
    expect(searchShortcutLabel(true)).toBe('⌘K');
    expect(searchShortcutLabel(false)).toBe('Ctrl K');
    expect(needsYouToast('Chat', 'Deploy feat/invoice-pdf to staging.')).toBe(
      'Chat: Deploy feat/invoice-pdf to staging.',
    );
    expect(githubConnectedToast('Dusty')).toBe('GitHub connected. Switch on the repos Dusty should see.');
    expect(githubConnectedAs('acme')).toBe('Connected as @acme');
  });

  it('writes onboarding and canvas copy', () => {
    expect(onboardingStepLabel(1, 3)).toBe('STEP 2 OF 3');
    expect(onboardingBackLabel(0)).toBe('Skip for now');
    expect(onboardingBackLabel(2)).toBe('Back');
    expect(onboardingNextLabel(0, 3, 'Burrow HQ')).toBe('Continue');
    expect(onboardingNextLabel(3, 3, 'Burrow HQ')).toBe('Open Burrow HQ');
    expect(onboardingNextLabel(3, 3, '')).toBe('Open the burrow');
    expect(formatRepoMeta('TypeScript', '2026-09-23T07:22:00Z', NOW, TZ)).toBe(
      'TypeScript · updated 2 hours ago',
    );
    expect(formatRepoMeta('HCL', at('10:00', -2), NOW, TZ)).toBe('HCL · updated Monday');
    expect(formatPresence(2)).toBe('2 here');
    expect(
      formatCanvasProvenance(
        { createdBy: 'Toffee', requestedBy: 'Priya', editors: ['Mara', 'Dusty'] },
        '2026-09-23T09:10:00Z',
        NOW,
        TZ,
      ),
    ).toBe('Drafted by Toffee from Priya’s request · edited by Mara, Dusty · 12 min ago');
  });
});

describe('segments', () => {
  it('splits inline citations in answers', () => {
    const text =
      'Yes, twice. Both times amounts were formatted before VAT was rounded [1]. Tom fixed it [2].';
    expect(segmentCitations(text)).toEqual([
      { kind: 'text', text: 'Yes, twice. Both times amounts were formatted before VAT was rounded ' },
      { kind: 'citation', n: 1 },
      { kind: 'text', text: '. Tom fixed it ' },
      { kind: 'citation', n: 2 },
      { kind: 'text', text: '.' },
    ]);
    expect(citationNumbers(`${text} Again [1] and [3].`)).toEqual([1, 2, 3]);
  });
});

describe('ids', () => {
  it('formats and parses event refs', () => {
    expect(formatEventRef('evt_9f31')).toBe('e-9f31');
    expect(parseEventRef('e-9f31')).toBe('evt_9f31');
    expect(parseEventRef('9f31')).toBeNull();
  });
});

describe('the agent’s working line (CT-158)', () => {
  it('shows the live work while working, nothing otherwise', () => {
    const agent = { status: 'idle' as const, doing: '' };
    expect(agentWorkingText(agent)).toBeNull();
    expect(agentWorkingText({ status: 'working', doing: 'Drafting the logo page.' })).toBe(
      'Working: Drafting the logo page.',
    );
    expect(agentWorkingText({ status: 'idle', doing: 'Old work.' })).toBeNull();
    expect(agentWorkingText(agent, 'Exporting SVGs')).toBe('Working: Exporting SVGs');
  });
});
