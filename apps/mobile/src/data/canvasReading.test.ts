import { describe, expect, it } from 'vitest';
import { canvasReadingMarkdown } from './canvas';

describe('canvasReadingMarkdown (MQ-05)', () => {
  it('drops plan fences, keeps the listing, and shows highlighted words without their markup', () => {
    const md = [
      '## Steps',
      ':::plan{id=pln_invoice-pdf}',
      '- [x] Pick a PDF library',
      '- [ ] Deploy to staging',
      ':::',
      '',
      '- ==Invoice numbers come from the service.=={author=prn_dusty} The PDF path never reuses one.',
      '- ==Round VAT per line.==',
    ].join('\n');
    expect(canvasReadingMarkdown(md)).toBe(
      [
        '## Steps',
        '- [x] Pick a PDF library',
        '- [ ] Deploy to staging',
        '',
        '- Invoice numbers come from the service. The PDF path never reuses one.',
        '- Round VAT per line.',
      ].join('\n'),
    );
  });

  it('leaves fenced code alone', () => {
    const md = ['```', 'a == b ==c=={author=x}', ':::', '```', 'x'].join('\n');
    expect(canvasReadingMarkdown(md)).toBe(md);
  });
});
