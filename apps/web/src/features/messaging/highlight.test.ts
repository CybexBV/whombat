import { describe, expect, it } from 'vitest';
import { canHighlight, HIGHLIGHT_MAX, highlight, type Token } from './highlight';

function flat(token: Token): [string | null, string][] {
  return token.children.flatMap((c) =>
    typeof c === 'string' ? [[token.kind, c] as [string | null, string]] : flat(c),
  );
}

describe('highlight (AP-322)', () => {
  it('knows the common languages and the names people write', () => {
    for (const lang of [
      'ts',
      'TypeScript',
      'js',
      'json',
      'bash',
      'sh',
      'python',
      'py',
      'html',
      'svg',
      'css',
      'sql',
      'yaml',
      'go',
      'rust',
      'diff',
    ])
      expect(canHighlight(lang), lang).toBe(true);
    expect(canHighlight('cobol')).toBe(false);
    expect(canHighlight(null)).toBe(false);
  });

  it('splits code into coloured tokens without losing a character', () => {
    const code = 'const total = 42; // VAT\nexport function round(n: number) { return "€" + n; }';
    const tree = highlight('ts', code);
    expect(tree).not.toBeNull();
    const tokens = flat(tree as Token);
    expect(tokens.map(([, t]) => t).join('')).toBe(code);
    expect(tokens).toContainEqual(['keyword', 'const']);
    expect(tokens).toContainEqual(['number', '42']);
    expect(tokens).toContainEqual(['comment', '// VAT']);
    expect(tokens).toContainEqual(['string', '"€"']);
    expect(tokens).toContainEqual(['title', 'round']);
  });

  it('colours diff lines with the diff tokens', () => {
    const tokens = flat(highlight('diff', '-old\n+new\n') as Token);
    expect(tokens).toContainEqual(['removed', '-old']);
    expect(tokens).toContainEqual(['added', '+new']);
  });

  it('leaves unknown languages and very long code plain', () => {
    expect(highlight('cobol', 'MOVE 1 TO X.')).toBeNull();
    expect(highlight('ts', 'x'.repeat(HIGHLIGHT_MAX + 1))).toBeNull();
  });
});
