/** Inline code (`formatEuro`) in review comments. */
export interface CodeSegment {
  text: string;
  code: boolean;
}

export function segmentInlineCode(text: string): CodeSegment[] {
  const out: CodeSegment[] = [];
  const re = /`([^`\n]+)`/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i), code: false });
    out.push({ text: m[1] as string, code: true });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), code: false });
  return out;
}

/** Inline numbered citations in an agent answer: "…rounded [1]. Tom fixed it [2]…". */
export type CitationSegment = { kind: 'text'; text: string } | { kind: 'citation'; n: number };

export function segmentCitations(text: string): CitationSegment[] {
  const out: CitationSegment[] = [];
  const re = /\[(\d{1,3})\]/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ kind: 'text', text: text.slice(last, i) });
    out.push({ kind: 'citation', n: Number(m[1]) });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** Citation numbers used in an answer, in order of first use. */
export function citationNumbers(text: string): number[] {
  const seen: number[] = [];
  for (const s of segmentCitations(text)) if (s.kind === 'citation' && !seen.includes(s.n)) seen.push(s.n);
  return seen;
}
