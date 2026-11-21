/**
 * Search results and Dusty's answer for the VAT-rounding query. `RESULTS` in `Whombat Desktop.dc.html`; the answer
 * text mirrors Dusty's cited reply in Mara's Chat (same three receipts, `cited: 1/2/3` in `RESULTS`).
 */
import type { SearchAnswer, SearchResult } from '@whombat/core/domain';
import { dusty, mara } from './principals.js';

/** The question in the mock's search box (`query` in its initial state), which Dusty answers. */
export const SEARCH_QUERY = 'have we seen this invoice rounding error before?';

export const sr_thread_incidents: SearchResult = {
  id: 'sr_thread-incidents',
  type: 'THREAD',
  where: 'fix/credit-note-vat · 3 Mar 2026',
  authorId: mara.id,
  snippet:
    'Credit note 4471 is a cent off. We format the amount and then round the VAT on the formatted string.',
  citedAs: 1,
  link: { type: 'pr', number: 311 },
  createdAt: '2026-03-03T10:00:00+01:00',
  status: null,
};

export const sr_patch_311: SearchResult = {
  id: 'sr_patch-311',
  type: 'PATCH',
  where: 'PR #311 · merged 4 Mar',
  authorId: mara.id,
  snippet: 'Round before format for credit notes. Regular invoices still use the old path.',
  citedAs: 2,
  link: { type: 'pr', number: 311 },
  createdAt: '2026-03-04T09:30:00+01:00',
  status: null,
};

export const sr_run_1882: SearchResult = {
  id: 'sr_run-1882',
  type: 'RUN',
  where: 'Run #1882 · ledger reconciliation',
  authorId: dusty.id,
  snippet: '3 invoices differ from the ledger by €0,01. All three have lines with €0,005 VAT.',
  citedAs: 3,
  link: { type: 'run', number: 1882 },
  createdAt: '2026-03-05T06:00:00+01:00',
  status: null,
};

export const sr_canvas_rules_v3: SearchResult = {
  id: 'sr_canvas-rules-v3',
  type: 'CANVAS',
  where: 'Invoicing rules v3',
  authorId: mara.id,
  snippet: 'Always round per line, half-up, before formatting. Never round the total.',
  citedAs: null,
  link: { type: 'canvas', slug: 'invoicing-rules-v3' },
  createdAt: '2025-11-12T14:00:00+01:00',
  status: null,
};

/** Mara's review in the PR #482 branch room (`messages.ts#msg_pr482_mara_1120`). */
export const sr_message_review: SearchResult = {
  id: 'sr_message-pr482-mara',
  type: 'MESSAGE',
  where: 'feat/invoice-pdf · today 11:20',
  authorId: mara.id,
  snippet:
    'Amounts are formatted before VAT is rounded. Round first, then format, or Dutch invoices come out a cent off.',
  citedAs: null,
  link: {
    type: 'message',
    in: { type: 'pr', number: 482, repo: 'whombat/billing' },
    messageId: 'msg_pr482-mara-1120',
  },
  createdAt: '2026-09-23T09:20:00.000Z',
  status: null,
};

export const SEARCH_RESULTS: SearchResult[] = [
  sr_thread_incidents,
  sr_patch_311,
  sr_run_1882,
  sr_canvas_rules_v3,
  sr_message_review,
];

export const searchAnswer: SearchAnswer = {
  id: 'ans_vat-rounding',
  burrowId: 'bur_burrow-hq',
  query: SEARCH_QUERY,
  agentId: dusty.id,
  status: 'ready',
  text: 'Yes, twice. Both times amounts were formatted before VAT was rounded [1]. You fixed it for credit notes in March [2], but regular invoices still format first. My reconciliation run caught three more invoices a cent off the ledger [3]. You flagged the same order in PR #482 today.',
  citations: [
    { n: 1, resultId: sr_thread_incidents.id },
    { n: 2, resultId: sr_patch_311.id },
    { n: 3, resultId: sr_run_1882.id },
  ],
  durationMs: 1800,
  // The mock always shows this second button under the answer regardless of the query (`Whombat
  // Desktop.dc.html`'s `toBranch`); it isn't derived from a citation, so it's modeled as its own
  // `open` action pointing at the fixtures' one open PR (docs/decisions/audit-search.md).
  actions: [
    { kind: 'post', label: 'Post to the branch room', conversationId: 'cnv_pr482' },
    { kind: 'open', label: 'Open PR #482', link: { type: 'pr', number: 482 } },
  ],
  createdAt: '2026-09-23T08:41:00.000Z',
};
