import { describe, expect, it } from 'vitest';
import { dropSvgCopies } from './svg-copies';

const CHART =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="400" viewBox="0 0 1000 400"><rect width="100%" height="100%" fill="white"/><polyline points="0,10 5,20" fill="none" stroke="#2563eb"/></svg>';
const OTHER = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';

describe('dropSvgCopies (MS-D01)', () => {
  it('drops the svg block that repeats an attached file', () => {
    const text = `Here’s the 24-hour CPU graph. Average **1.76%**.\n\n\`\`\`svg\n${CHART}\n\`\`\``;
    expect(dropSvgCopies(text, [CHART])).toBe('Here’s the 24-hour CPU graph. Average **1.76%**.');
  });

  it('matches whatever the whitespace, a trailing newline or a missing namespace', () => {
    const pretty = CHART.replace('><', '>\n  <').replace(' xmlns="http://www.w3.org/2000/svg"', '');
    expect(dropSvgCopies(`Chart:\n\`\`\`xml\n${pretty}\n\`\`\``, [`${CHART}\n`])).toBe('Chart:');
    expect(dropSvgCopies(`Chart:\n~~~~\n${CHART}\n~~~~`, [CHART])).toBe('Chart:');
  });

  it('keeps the text around the block, with one blank line between', () => {
    const text = `Before.\n\n\`\`\`svg\n${CHART}\n\`\`\`\n\nAfter.`;
    expect(dropSvgCopies(text, [CHART])).toBe('Before.\n\nAfter.');
  });

  it('keeps a different drawing and other code', () => {
    const text = `A diagram:\n\`\`\`svg\n${OTHER}\n\`\`\`\nThe source:\n\`\`\`ts\nconst svg = '${CHART}';\n\`\`\``;
    expect(dropSvgCopies(text, [CHART])).toBe(text);
  });

  it('drops only the copy when the message holds both', () => {
    const text = `\`\`\`svg\n${OTHER}\n\`\`\`\n\`\`\`svg\n${CHART}\n\`\`\``;
    expect(dropSvgCopies(text, [CHART])).toBe(`\`\`\`svg\n${OTHER}\n\`\`\``);
  });

  it('leaves the text alone without an svg file or a block', () => {
    const text = `\`\`\`svg\n${CHART}\n\`\`\``;
    expect(dropSvgCopies(text, [])).toBe(text);
    expect(dropSvgCopies(text, ['not a drawing'])).toBe(text);
    expect(dropSvgCopies('Just words.', [CHART])).toBe('Just words.');
  });

  it('empties a message that was only the copy (the file is the message)', () => {
    expect(dropSvgCopies(`\`\`\`svg\n${CHART}\n\`\`\``, [CHART])).toBe('');
  });
});
