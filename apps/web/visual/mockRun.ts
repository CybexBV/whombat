/**
 * Run #1907 as the desktop mock derives it at a given `tick` (`renderVals()` in the
 * `<script data-dc-script>` block of `Whombat Desktop.dc.html`: `RSTEPS`, `BASE_LOG`, `LIVE`, `FILES`,
 * `run.add/del`, `activeIdx`). Tick 0 is 11:22; every 2.6 s one LIVE line lands; tick 8 is RUN · DONE.
 *
 * The fixture run legitimately differs (it carries the first two steps and two files, and the server
 * lays out the storyline's steps as the run plays), so the visual specs patch the cached `runs.get`
 * data to this before comparing.
 */
import type { Run, RunLogLine } from '@whombat/core';

const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  // 2026-09-23, Europe/Amsterdam (UTC+2).
  return new Date(Date.UTC(2026, 8, 23, (h ?? 0) - 2, m ?? 0)).toISOString();
};

const RSTEPS = [
  ['Read Hazel’s review', 'Two changes requested on billing/pdf/format.ts', '11:22'],
  ['Round VAT before formatting', 'Move roundVat() ahead of formatAmount()', '11:24'],
  ['Rename formatEuro to formatAmount', 'It takes a locale now', '11:29'],
  ['Run the billing test suite', '41 tests, including a new €0,005 case', '11:31'],
  ['Push and ask Hazel to re-review', 'Posts back to #billing-v2 and the branch room', '11:36'],
] as const;

const BASE_LOG = [
  ['10:03', '$ git checkout -b feat/invoice-pdf'],
  ['10:04', 'Read plan · Invoice PDF export'],
  ['10:09', 'Scaffolded GET /invoices/:id/pdf'],
  ['10:31', 'Rendered invoice template with Typeset'],
  ['10:44', '$ pnpm test billing/pdf'],
  ['10:46', '✗ 3 failing in invoice_format_test'],
  ['10:48', 'Opened PR #482'],
  ['11:22', 'Reading Hazel’s review on PR #482'],
] as const;

const LIVE = [
  ['11:24', 'Editing billing/pdf/format.ts'],
  ['11:26', 'Moved roundVat() ahead of formatAmount()'],
  ['11:29', 'Renamed formatEuro → formatAmount (4 call sites)'],
  ['11:31', '$ pnpm test billing/pdf'],
  ['11:33', '✓ rounds half-up on €0,005 (nl-NL)'],
  ['11:34', '✓ matches HTML invoice snapshot'],
  ['11:35', '✓ 41 of 41 tests passed'],
  ['11:36', 'Pushed 7be20f · asked Hazel to re-review'],
] as const;

const FILES = [
  { path: 'billing/pdf/render.ts', add: 128, del: 0 },
  { path: 'billing/pdf/format.ts', add: 34, del: 9 },
  { path: 'billing/api/invoices.ts', add: 22, del: 1 },
  { path: 'billing/pdf/cache.ts', add: 18, del: 0 },
  { path: 'billing/pdf/format.test.ts', add: 41, del: 2 },
  { path: 'billing/flags.ts', add: 3, del: 0 },
];

export const MOCK_LIVE_TICKS = LIVE.length;

/** The mock's `activeIdx`. */
function activeIndex(tick: number): number {
  if (tick < 1) return 0;
  if (tick < 3) return 1;
  if (tick < 4) return 2;
  if (tick < 7) return 3;
  if (tick < 8) return 4;
  return 5;
}

/** Fields of `Run` that the run page shows, as the mock has them at `tick`. */
export function mockRunAt(tick: number): { run: Partial<Run>; log: RunLogLine[] } {
  const done = tick >= LIVE.length;
  const active = activeIndex(tick);
  const lines = [...BASE_LOG, ...LIVE.slice(0, tick)];
  return {
    run: {
      status: done ? 'done' : 'live',
      steps: RSTEPS.map(([title, detail, time], i) => {
        const state = i < active ? 'done' : i === active ? 'active' : 'queued';
        return { title, detail, at: state === 'queued' ? null : at(time), state };
      }),
      tests: { passed: tick >= 7 ? 41 : 38, total: 41 },
      files: FILES,
      diff: { add: 214 + Math.min(tick, 6) * 6, del: 12 + Math.min(tick, 4) * 2, files: FILES.length },
      logCount: lines.length,
    },
    log: lines.map(([time, text], seq) => ({ seq, at: at(time), text })),
  };
}

/** A script for `page.evaluate` that patches the cached run page to the mock at `tick`. */
export function patchRunScript(tick: number, burrow = 'burrow-hq', number = 1907): string {
  const data = mockRunAt(tick);
  return `(() => {
    const app = window.__WHOMBAT__;
    if (!app) throw new Error('window.__WHOMBAT__ is only set in dev builds');
    const qc = app.services.queryClient;
    const key = ['whombat', 'runs.get', { burrow: ${JSON.stringify(burrow)}, number: ${number} }, {}];
    const d = qc.getQueryData(key);
    if (!d) throw new Error('run not loaded');
    const patch = ${JSON.stringify(data)};
    qc.setQueryData(key, { ...d, run: { ...d.run, ...patch.run }, log: patch.log });
  })()`;
}
