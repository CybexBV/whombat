/**
 * Canvases. The plan canvas and its side comments are verbatim (`comments` in `Whombat Desktop.dc.html`);
 * each anchor's Yjs `relativePosition` is the one the seed computes on the canvas's Yjs document (built
 * from `CANVAS_MARKDOWN` below with a fixed client id, so it is stable; see
 * `docs/decisions/collab-server.md`), and the quote is the anchored text. The sidebar shows "Canvases · 4" (`S.counts` in the mock); the other
 * three are added here so that count is real (`store.ts#sidebar()`), not hardcoded — see FX-15 in
 * `docs/decisions/fixtures.md`, superseded by SW-03 in `docs/decisions/seed-wiring.md`. Their content
 * ties into Dusty's RECENT rows (`docs/decisions/seed-wiring.md` SW-04): Dusty wrote the onboarding
 * canvas and updated the service map one; "Invoicing rules v3" is cited by search (`search.ts`) and the
 * plan canvas's own comments and Dusty's answer in Mara's Chat. The plan canvas belongs to Mara's Chat, where she asked
 * for the plan; the others belong to no conversation.
 */
import type { Canvas, CanvasComment } from '@whombat/core/domain';
import { BURROW_ID } from './burrow.js';
import { cnv_dm_dusty } from './conversations.js';
import { dusty, mara } from './principals.js';
import { at } from './time.js';

export const canvas: Canvas = {
  id: 'cvs_invoice-pdf-plan',
  burrowId: BURROW_ID,
  slug: 'invoice-pdf-export-plan',
  title: 'Invoice PDF export · plan',
  conversationId: cnv_dm_dusty.id,
  planId: 'pln_invoice-pdf',
  provenance: {
    createdById: dusty.id,
    requestedById: mara.id,
    editorIds: [mara.id, dusty.id],
  },
  createdAt: at('09:13'),
  // "… · 12 min ago" in the mock at 11:22: Dusty is still writing the third rule (it was `at('14:07')`, a time
  // after the seeded "now").
  updatedAt: at('11:10'),
};

export const cmt_pdf_plan_1: CanvasComment = {
  id: 'cmt_pdf-plan-1',
  canvasId: canvas.id,
  anchor: {
    relativePosition: 'AAGbAgA=',
    quote: 'Build the export endpoint',
  },
  parentId: null,
  authorId: dusty.id,
  text: 'Step 2 should read the number from the invoice-number service. See PR #311 and Invoicing rules v3.',
  // A day before cmt_pdf_plan_3 (Mara, 11:21 today): the mock lists this thread first, so
  // `groupCommentThreads`'s chronological sort needs it to actually be earlier, not just same-day-earlier-clock.
  createdAt: at('14:05', -1),
  resolved: false,
};

export const cmt_pdf_plan_2: CanvasComment = {
  id: 'cmt_pdf-plan-2',
  canvasId: canvas.id,
  anchor: null,
  parentId: cmt_pdf_plan_1.id,
  authorId: mara.id,
  text: 'Agreed. Made it a rule.',
  createdAt: at('14:07', -1),
  resolved: false,
};

export const cmt_pdf_plan_3: CanvasComment = {
  id: 'cmt_pdf-plan-3',
  canvasId: canvas.id,
  anchor: {
    relativePosition: 'AAHpAwA=',
    quote: 'Round VAT per line, half-up, before formatting.',
  },
  parentId: null,
  authorId: mara.id,
  text: 'This is the one that bit us in March. I’m holding the review on it.',
  createdAt: at('11:21'),
  resolved: false,
};

export const CANVAS_COMMENTS: CanvasComment[] = [cmt_pdf_plan_1, cmt_pdf_plan_2, cmt_pdf_plan_3];

/** Cited by `search.ts#sr_canvas_rules_v3` (`link.slug`) and Dusty's receipt in Mara's Chat (`messages.ts`). */
export const canvasInvoicingRulesV3: Canvas = {
  id: 'cvs_invoicing-rules-v3',
  burrowId: BURROW_ID,
  slug: 'invoicing-rules-v3',
  title: 'Invoicing rules v3',
  conversationId: null,
  planId: null,
  provenance: {
    createdById: mara.id,
    requestedById: mara.id,
    editorIds: [dusty.id],
  },
  createdAt: '2025-11-12T14:00:00.000+01:00',
  updatedAt: at('14:07'),
};

/** Dusty updated it two days ago ("Updated the service map"): `docs/decisions/seed-wiring.md` SW-04. */
export const canvasServiceMap: Canvas = {
  id: 'cvs_service-map',
  burrowId: BURROW_ID,
  slug: 'service-map',
  title: 'Service map',
  conversationId: null,
  planId: null,
  provenance: {
    createdById: dusty.id,
    requestedById: mara.id,
    editorIds: [],
  },
  createdAt: at('10:00', -9),
  updatedAt: at('14:00', -2),
};

/** Dusty wrote it yesterday ("Split onboarding revamp into 9 tasks"): `seed-wiring.md` SW-04. */
export const canvasOnboardingRevamp: Canvas = {
  id: 'cvs_onboarding-revamp-plan',
  burrowId: BURROW_ID,
  slug: 'onboarding-revamp-plan',
  title: 'Onboarding revamp · plan',
  conversationId: null,
  planId: null,
  provenance: {
    createdById: dusty.id,
    requestedById: mara.id,
    editorIds: [],
  },
  createdAt: at('17:45', -1),
  updatedAt: at('17:45', -1),
};

/** All four canvases (`S.counts.canvases === 4` in the mock). */
export const CANVASES: Canvas[] = [canvas, canvasInvoicingRulesV3, canvasServiceMap, canvasOnboardingRevamp];

/** Canvas bodies in the canvas Markdown dialect (`@whombat/canvas-schema`): the seed turns them into Yjs
 * documents. The plan canvas is the mock's article verbatim (Goal, Steps as a plan block bound to
 * `pln_invoice-pdf`, Rules to keep with Dusty's and Mara's highlights, the rule Dusty is still writing,
 * Out of scope); its side comments anchor to "Build the export endpoint" and "Round VAT per line, half-up,
 * before formatting.". The other three are short, matching their titles and the audit events that reference
 * them (`docs/decisions/seed-wiring.md` SW-03). The web app builds the same documents in fixture mode. */
export const CANVAS_MARKDOWN: Record<string, string> = {
  'cvs_invoice-pdf-plan':
    '# Invoice PDF export\n\n' +
    '## Goal\n\n' +
    'Customers can download any invoice as a PDF from the billing portal and from the invoice email. ' +
    'The PDF matches the current HTML invoice, in Dutch and English, and is ready before finance closes the ' +
    'month on 14 October.\n\n' +
    '## Steps\n\n' +
    ':::plan{id=pln_invoice-pdf}\n' +
    '- [x] Pick a PDF library\n' +
    '- [ ] Build the export endpoint\n' +
    '- [ ] Review against the brief\n' +
    '- [ ] Deploy to staging\n' +
    ':::\n\n' +
    '## Rules to keep\n\n' +
    '- ==Invoice numbers come from the invoice-number service.=={author=prn_dusty} The PDF path never ' +
    'generates or reuses one.\n' +
    '- ==Round VAT per line, half-up, before formatting.=={author=prn_mara}\n' +
    '- PDFs are generated on request and cached for 24 hours, keyed by invoice number and locale\n\n' +
    '## Out of scope\n\n' +
    'Credit notes and bulk export. Both are planned for next quarter.\n',
  'cvs_invoicing-rules-v3':
    '# Invoicing rules v3\n\n' +
    '1. Always round per line, half-up, before formatting. Never round the total.\n' +
    '2. Numbers are yearly sequences with a prefix, like 2026-000142. Never reused or skipped.\n',
  'cvs_service-map': '# Service map\n\nBilling, web and infra, and how they talk to each other.\n',
  'cvs_onboarding-revamp-plan':
    '# Onboarding revamp · plan\n\nSplit into 9 tasks across the first-run flow.\n',
};
