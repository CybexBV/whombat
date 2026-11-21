/**
 * A static host's `_headers` file (the Cloudflare Pages format the whombat-app builds write): blocks of a path pattern
 * on its own line followed by indented `Name: value` lines. A pattern is an exact path or ends in `*` (a prefix); a
 * `! Name` line detaches a header an earlier matching block set. The embed server (IN-54) applies **every** block
 * that matches a path, in file order (Whombat FD-46): later values of the same header are joined with `, `.
 */
export interface HeaderBlock {
  pattern: string;
  set: [name: string, value: string][];
  detach: string[];
}

export function parseHeadersFile(text: string): HeaderBlock[] {
  const blocks: HeaderBlock[] = [];
  let current: HeaderBlock | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), set: [], detach: [] };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    const detach = /^\s+!\s*([^:\s]+)\s*$/.exec(line);
    if (detach?.[1]) {
      current.detach.push(detach[1].toLowerCase());
      continue;
    }
    const m = /^\s+([^:]+):\s*(.*)$/.exec(line);
    if (m?.[1] && m[2] !== undefined && m[2].trim() !== '')
      current.set.push([m[1].trim().toLowerCase(), m[2].trim()]);
  }
  return blocks;
}

export function patternMatches(pattern: string, path: string): boolean {
  return pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
}

/** The headers of `path`: every matching block in order (lower-case names). */
export function headersFor(blocks: readonly HeaderBlock[], path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of blocks) {
    if (!patternMatches(b.pattern, path)) continue;
    for (const name of b.detach) delete out[name];
    for (const [name, value] of b.set) out[name] = out[name] === undefined ? value : `${out[name]}, ${value}`;
  }
  return out;
}
