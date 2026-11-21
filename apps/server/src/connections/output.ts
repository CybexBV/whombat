/**
 * A tool's answer as a JSON document, for code that reads values out of it (a change's old state, a widget's numbers):
 * the structured content when the tool gave one, else the body of a `request` answer (after its status and header
 * lines), else the whole text as JSON. Null when none of it is JSON.
 */
import type { CallOutput } from './request';

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function outputDocument(out: Pick<CallOutput, 'content' | 'structured'>): unknown {
  if (out.structured !== undefined) return out.structured;
  const whole = tryJson(out.content);
  if (whole !== undefined) return whole;
  // `request`: “HTTP 200”, header lines, a blank line, then the body.
  if (/^HTTP \d{3}/.test(out.content)) {
    const at = out.content.indexOf('\n\n');
    if (at >= 0) {
      const body = tryJson(out.content.slice(at + 2));
      if (body !== undefined) return body;
    }
  }
  return null;
}
