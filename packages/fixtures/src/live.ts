/**
 * The live storyline: Dusty's run on PR #482 from 11:22 (tick 0, `run`) to 11:36 (finished, `runFinished`).
 * `BASE_LOG_LINES` is the log as it stood at tick 0 (`BASE_LOG` in the mock, `run.logCount`); `LIVE_LOG_LINES`
 * is what the run appends every ~2.6s while it plays (`LIVE` in the mock) — together they are
 * `runFinished.logCount` (16) lines, verbatim. `RUN_STEPS_TIMELINE` is `RSTEPS`: the run card's named steps
 * with the clock time each became active.
 */
import type { RunLogLine } from '@whombat/core/domain';
import { at } from './time.js';

/** Replay speed of the LIVE log in the mock ("every 2.6s"). */
export const LIVE_STEP_INTERVAL_MS = 2600;

/** The log as it stood when Dusty's run started at 11:22 (`BASE_LOG`, tick 0). */
export const BASE_LOG_LINES: RunLogLine[] = [
  { seq: 0, at: at('10:03'), text: '$ git checkout -b feat/invoice-pdf' },
  { seq: 1, at: at('10:04'), text: 'Read plan · Invoice PDF export' },
  { seq: 2, at: at('10:09'), text: 'Scaffolded GET /invoices/:id/pdf' },
  { seq: 3, at: at('10:31'), text: 'Rendered invoice template with Typeset' },
  { seq: 4, at: at('10:44'), text: '$ pnpm test billing/pdf' },
  { seq: 5, at: at('10:46'), text: '✗ 3 failing in invoice_format_test' },
  { seq: 6, at: at('10:48'), text: 'Opened PR #482' },
  { seq: 7, at: at('11:22'), text: 'Reading Mara’s review on PR #482' },
];

/** Lines the run appends while it plays live, one every `LIVE_STEP_INTERVAL_MS` (`LIVE` in the mock). */
export const LIVE_LOG_LINES: RunLogLine[] = [
  { seq: 8, at: at('11:24'), text: 'Editing billing/pdf/format.ts' },
  { seq: 9, at: at('11:26'), text: 'Moved roundVat() ahead of formatAmount()' },
  { seq: 10, at: at('11:29'), text: 'Renamed formatEuro → formatAmount (4 call sites)' },
  { seq: 11, at: at('11:31'), text: '$ pnpm test billing/pdf' },
  { seq: 12, at: at('11:33'), text: '✓ rounds half-up on €0,005 (nl-NL)' },
  { seq: 13, at: at('11:34'), text: '✓ matches HTML invoice snapshot' },
  { seq: 14, at: at('11:35'), text: '✓ 41 of 41 tests passed' },
  { seq: 15, at: at('11:36'), text: 'Pushed 7be20f · asked Mara to re-review' },
];

/** Every log line, oldest first — matches `runFinished.logCount` (16). */
export const RUN_LOG_LINES: RunLogLine[] = [...BASE_LOG_LINES, ...LIVE_LOG_LINES];

export interface RunStepTimelineEntry {
  title: string;
  detail: string;
  at: string;
}

/** The run card's named steps in order, with the clock time each became active (`RSTEPS`). */
export const RUN_STEPS_TIMELINE: RunStepTimelineEntry[] = [
  {
    title: 'Read Mara’s review',
    detail: 'Two changes requested on billing/pdf/format.ts',
    at: at('11:22'),
  },
  {
    title: 'Round VAT before formatting',
    detail: 'Move roundVat() ahead of formatAmount()',
    at: at('11:24'),
  },
  { title: 'Rename formatEuro to formatAmount', detail: 'It takes a locale now', at: at('11:29') },
  { title: 'Run the billing test suite', detail: '41 tests, including a new €0,005 case', at: at('11:31') },
  {
    title: 'Push and ask Mara to re-review',
    detail: 'Posts back to the branch room',
    at: at('11:36'),
  },
];
