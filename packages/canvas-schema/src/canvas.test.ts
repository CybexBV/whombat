import type { PlanStep } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  anchorForQuote,
  applyEdits,
  applyEditsToYDoc,
  CanvasEditError,
  canvasUpdateFromJSON,
  createCanvasYDoc,
  docFromJSON,
  docFromUpdate,
  docToMarkdown,
  docToPlainText,
  findPlanBlocks,
  isRelativePosition,
  markComment,
  markdownToDoc,
  mergePlanEdits,
  type PlanLike,
  planStepsFromDoc,
  readCanvas,
  resolveAnchor,
  syncPlanIntoDoc,
  unmarkComment,
  writeCanvas,
} from './index.js';

const PLAN: PlanLike = {
  id: 'pln_invoice-pdf',
  steps: [
    { id: 'stp_pdf-1', title: 'Pick a PDF library', state: 'done', stateLabel: 'Done' },
    {
      id: 'stp_pdf-2',
      title: 'Build the export endpoint',
      state: 'active',
      stateLabel: 'In progress',
    },
    {
      id: 'stp_pdf-3',
      title: 'Review against the brief',
      state: 'active',
      stateLabel: 'Reviewing',
    },
    {
      id: 'stp_pdf-4',
      title: 'Deploy to staging',
      state: 'gate',
      stateLabel: 'Needs you',
    },
  ],
};

const MD = `# Invoice PDF export

## Goal

Customers can download any invoice as a PDF from the billing portal and from the invoice email.

## Steps

:::plan{id=pln_invoice-pdf}
- [x] Pick a PDF library
:::

## Rules to keep

- ==Invoice numbers come from the invoice-number service.=={author=prn_dusty} The PDF path never generates or reuses one.
- ==Round VAT per line, half-up, before formatting.=={author=prn_joris}
- PDFs are generated on request and cached for 24 hours, keyed by invoice number and locale

## Out of scope

Credit notes and bulk export. Both are planned for next quarter.
`;

const parse = (md = MD) => markdownToDoc(md, { plan: (id) => (id === PLAN.id ? PLAN : null) });

function textOf(ydoc: Y.Doc) {
  return docToPlainText(readCanvas(ydoc).doc);
}

describe('canvas Markdown', () => {
  it('parses the plan canvas into the schema: title, headings, plan block from the Plan, highlights', () => {
    const doc = docFromJSON(parse());
    expect(doc.firstChild?.type.name).toBe('title');
    expect(doc.firstChild?.textContent).toBe('Invoice PDF export');
    const [block] = findPlanBlocks(doc, PLAN.id);
    expect(block?.node.childCount).toBe(4);
    expect(block?.node.child(1).attrs).toMatchObject({
      stepId: 'stp_pdf-2',
      state: 'active',
    });
    const marks: { text: string; author: unknown }[] = [];
    doc.descendants((n) => {
      const m = n.marks.find((x) => x.type.name === 'authorHighlight');
      if (n.isText && m) marks.push({ text: n.text ?? '', author: m.attrs.authorId });
    });
    expect(marks).toEqual([
      { text: 'Invoice numbers come from the invoice-number service.', author: 'prn_dusty' },
      { text: 'Round VAT per line, half-up, before formatting.', author: 'prn_joris' },
    ]);
  });

  it('writes the same dialect back, with states listed in the plan block', () => {
    const doc = docFromJSON(parse());
    const md = docToMarkdown(doc);
    expect(md).toContain('- [x] Pick a PDF library · Done');
    expect(md).toContain('- [ ] Deploy to staging · Needs you');
    expect(md).toContain('==Round VAT per line, half-up, before formatting.=={author=prn_joris}');
    // Round trip: parsing the export gives the same document.
    expect(docFromJSON(parse(md)).eq(doc)).toBe(true);
  });

  it('escapes Markdown characters in text and keeps inline marks', () => {
    const doc = docFromJSON(markdownToDoc('# T\n\nUse `a*b` and **bold _both_** and 2 \\* 3.'));
    const md = docToMarkdown(doc);
    expect(docFromJSON(markdownToDoc(md)).eq(doc)).toBe(true);
    expect(docToPlainText(doc)).toBe('T\nUse a*b and bold both and 2 * 3.');
  });

  it('always yields a valid document', () => {
    expect(() => docFromJSON(markdownToDoc(''))).not.toThrow();
    expect(() => docFromJSON(markdownToDoc('just text', { fallbackTitle: 'Notes' }))).not.toThrow();
    expect(docFromJSON(markdownToDoc('just text', { fallbackTitle: 'Notes' })).firstChild?.textContent).toBe(
      'Notes',
    );
    const unknown = docFromJSON(markdownToDoc('# T\n\n:::plan{id=pln_gone}\n- [x] Old step\n:::'));
    expect(planStepsFromDoc(unknown, 'pln_gone')).toEqual([
      { stepId: null, title: 'Old step', state: 'done' },
    ]);
  });
});

describe('Y.Doc', () => {
  it('stores the document the way the editor binding does and reads it back', () => {
    const json = parse();
    const doc = docFromUpdate(canvasUpdateFromJSON(json));
    expect(doc.eq(docFromJSON(json))).toBe(true);
  });

  it('two replicas converge on concurrent edits', () => {
    const a = createCanvasYDoc(parse());
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const ra = readCanvas(a);
    writeCanvas(a, applyEdits(ra.doc, [{ op: 'append', markdown: 'From A.' }]).doc, ra.meta);
    const rb = readCanvas(b);
    writeCanvas(
      b,
      applyEdits(rb.doc, [{ op: 'replace', find: 'Both are planned', markdown: 'Both come' }]).doc,
      rb.meta,
    );
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(textOf(a)).toBe(textOf(b));
    expect(textOf(a)).toContain('From A.');
    expect(textOf(a)).toContain('Both come for next quarter.');
  });
});

describe('agent edits', () => {
  const base = () => docFromJSON(parse());

  it('adds a list item into a list, replaces words in place and deletes an item', () => {
    const r = applyEdits(base(), [
      {
        op: 'insert_after',
        after: 'keyed by invoice number and locale',
        markdown: '- Never email a PDF twice.',
      },
      { op: 'replace', find: 'bulk export', markdown: 'bulk **exports**' },
      { op: 'delete', find: 'Round VAT per line, half-up, before formatting.' },
    ]);
    const md = docToMarkdown(r.doc);
    expect(md).toContain('keyed by invoice number and locale\n- Never email a PDF twice.');
    expect(md).toContain('Credit notes and bulk **exports**. Both');
    expect(md).not.toContain('Round VAT');
    expect(md).toContain('==Invoice numbers come from the invoice-number service.=={author=prn_dusty}');
  });

  it('highlights agents write carry their author', () => {
    const r = applyEdits(base(), [{ op: 'append', markdown: '==Always cite the rule.=={author=prn_mara}' }], {
      highlightAuthor: 'prn_dusty',
      forceHighlightAuthor: true,
    });
    expect(docToMarkdown(r.doc)).toContain('==Always cite the rule.=={author=prn_dusty}');
  });

  it('refuses edits that cannot apply', () => {
    expect(() => applyEdits(base(), [{ op: 'replace', find: 'nowhere to be found', markdown: 'x' }])).toThrow(
      CanvasEditError,
    );
    expect(() => applyEdits(base(), [{ op: 'delete', find: 'Invoice PDF export' }])).toThrow(/title/);
  });
});

describe('plan block', () => {
  it('follows the Plan: state changes update the block, keeping unchanged steps as they are', () => {
    const doc = docFromJSON(parse());
    expect(syncPlanIntoDoc(doc, PLAN)).toBeNull();
    const next = {
      ...PLAN,
      steps: PLAN.steps.map((s) => (s.id === 'stp_pdf-2' ? { ...s, state: 'done', stateLabel: 'Done' } : s)),
    };
    const synced = syncPlanIntoDoc(doc, next);
    expect(synced).not.toBeNull();
    const steps = planStepsFromDoc(synced as never, PLAN.id);
    expect(steps?.[1]).toMatchObject({ stepId: 'stp_pdf-2', state: 'done' });
    const [block] = findPlanBlocks(synced as never, PLAN.id);
    const [oldBlock] = findPlanBlocks(doc, PLAN.id);
    expect(block?.node.child(0)).toBe(oldBlock?.node.child(0));
  });

  it('turns block edits into Plan changes without undoing what the Plan did meanwhile', () => {
    const current = PLAN.steps.map((s) => ({ ...s, runId: null, approvalId: null })) as PlanStep[];
    const before = planStepsFromDoc(docFromJSON(parse()), PLAN.id) ?? [];
    const after = [
      { ...(before[0] as (typeof before)[0]) },
      { ...(before[1] as (typeof before)[0]), title: 'Build the PDF export endpoint' },
      { stepId: null, title: 'Check the Dutch copy', state: 'queued' },
      { ...(before[3] as (typeof before)[0]) },
    ];
    // Meanwhile the pipeline finished step 2.
    current[1] = { ...(current[1] as PlanStep), state: 'done', stateLabel: 'Done' };
    const merged = mergePlanEdits(current, before, after, {
      newStepId: () => 'stp_new',
    });
    expect(merged?.map((s) => [s.id, s.title, s.state])).toEqual([
      ['stp_pdf-1', 'Pick a PDF library', 'done'],
      ['stp_pdf-2', 'Build the PDF export endpoint', 'done'],
      ['stp_new', 'Check the Dutch copy', 'queued'],
      // Step 3 was deleted from the block, but it had started: it is kept (work-supervision WS-07).
      ['stp_pdf-3', 'Review against the brief', 'active'],
      ['stp_pdf-4', 'Deploy to staging', 'gate'],
    ]);
    expect(mergePlanEdits(current, before, before, { newStepId: () => 'x' })).toBeNull();
    // A step that never started is removed.
    const queued = current.map((s) => (s.id === 'stp_pdf-3' ? { ...s, state: 'queued' as const } : s));
    const removed = mergePlanEdits(
      queued,
      before,
      [before[0], before[1], before[3]].filter((s) => !!s),
      { newStepId: () => 'x' },
    );
    expect(removed?.map((s) => s.id)).toEqual(['stp_pdf-1', 'stp_pdf-2', 'stp_pdf-4']);
  });

  it('gives a typed step the id the Plan assigned at its place', () => {
    const json = parse();
    const block = json.content?.find((n) => n.type === 'planBlock');
    block?.content?.push({
      type: 'planStep',
      attrs: { stepId: null, state: 'queued', stateLabel: 'Queued' },
      content: [{ type: 'text', text: 'Check the Dutch copy' }],
    });
    const withTyped = docFromJSON(json);
    const plan = {
      ...PLAN,
      steps: [
        ...PLAN.steps,
        {
          id: 'stp_new',
          title: 'Check the Dutch copy',
          state: 'queued',
          stateLabel: 'Queued',
        },
      ],
    };
    const synced = syncPlanIntoDoc(withTyped, plan);
    expect(planStepsFromDoc(synced as never, PLAN.id)?.[4]).toMatchObject({ stepId: 'stp_new' });
  });
});

describe('comment anchors', () => {
  it('survive edits before and after the quoted words, and fail when the words are deleted', () => {
    const ydoc = createCanvasYDoc(parse());
    const anchor = anchorForQuote(ydoc, 'half-up, before formatting.');
    if (!anchor) throw new Error('no anchor');
    let { doc, meta } = readCanvas(ydoc);
    meta = writeCanvas(
      ydoc,
      applyEdits(doc, [
        { op: 'insert_after', after: '## Goal', markdown: 'A new paragraph up top.' },
        { op: 'replace', find: 'Round VAT', markdown: 'Always round VAT' },
      ]).doc,
      meta,
    );
    expect(resolveAnchor(ydoc, anchor)).toMatchObject({
      intact: true,
      current: 'half-up, before formatting.',
    });

    // A second replica that syncs the edits resolves the same anchor.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc));
    expect(resolveAnchor(other, anchor)?.intact).toBe(true);

    ({ doc } = readCanvas(ydoc));
    writeCanvas(
      ydoc,
      applyEdits(doc, [{ op: 'replace', find: 'half-up, before formatting.', markdown: 'up.' }]).doc,
      meta,
    );
    expect(resolveAnchor(ydoc, anchor)?.intact).toBe(false);
  });

  it('marks and unmarks the quoted words in the document', () => {
    const ydoc = createCanvasYDoc(parse());
    const anchor = anchorForQuote(ydoc, 'Build the export endpoint');
    if (!anchor) throw new Error('no anchor');
    const { doc, meta } = readCanvas(ydoc);
    const marked = markComment(ydoc, meta, doc, 'cmt_1', anchor);
    expect(marked).not.toBeNull();
    let found = '';
    marked?.descendants((n) => {
      if (n.marks.some((m) => m.type.name === 'commentAnchor' && m.attrs.commentId === 'cmt_1'))
        found += n.text;
    });
    expect(found).toBe('Build the export endpoint');
    expect(markComment(ydoc, meta, marked as never, 'cmt_1', anchor)).toBeNull();
    const unmarked = unmarkComment(marked as never, 'cmt_1');
    expect(unmarked?.eq(doc)).toBe(true);
  });

  it('survive several edits next to them when they are written one at a time', () => {
    const md = '# T\n\nGoal: PDF invoices. Always round half-up, before formatting.\n\nMore.';
    const ydoc = createCanvasYDoc(markdownToDoc(md));
    const anchor = anchorForQuote(ydoc, 'half-up, before formatting');
    if (!anchor) throw new Error('no anchor');
    // A new paragraph right before the anchored one and a change inside it, in one call.
    const result = applyEditsToYDoc(ydoc, [
      { op: 'insert_after', after: 'T', markdown: 'A new first paragraph.' },
      { op: 'replace', find: 'Goal: PDF', markdown: 'Goal: printable PDF' },
    ]);
    expect(docToPlainText(result.doc)).toBe(
      'T\nA new first paragraph.\nGoal: printable PDF invoices. Always round half-up, before formatting.\nMore.',
    );
    expect(resolveAnchor(ydoc, anchor)).toMatchObject({ intact: true });
    expect(readCanvas(ydoc).doc.eq(result.doc)).toBe(true);
  });

  it('accepts only well-formed Yjs relative positions', () => {
    const ydoc = createCanvasYDoc(parse());
    expect(isRelativePosition(anchorForQuote(ydoc, 'Goal')?.relativePosition ?? '')).toBe(true);
    for (const bad of ['', 'AAE=', 'not-a-position', '!!!', 'AA=='])
      expect(isRelativePosition(bad)).toBe(false);
  });
});
