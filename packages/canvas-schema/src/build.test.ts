import { describe, expect, it } from 'vitest';
import { buildCanvasYDoc } from './build.js';

const MD = '# Plan\n\n## Rules\n\n- Round VAT per line.\n- Cache PDFs for 24 hours\n';
const _PLACEHOLDER = { relativePosition: 'AAAA', quote: 'Round VAT per line.' };

describe('buildCanvasYDoc', () => {
  it('skips comments whose quote is not in the document', () => {
    const { anchors } = buildCanvasYDoc(MD, {
      title: 'Plan',
      comments: [{ id: 'cmt_x', anchor: { relativePosition: 'AAAA', quote: 'Not here' } }],
    });
    expect(anchors.size).toBe(0);
  });
});
