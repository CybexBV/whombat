/**
 * What to look at before sharing (docs/decisions/share-links.md): addresses of machines and networks, email addresses,
 * and things that look like a key or a password in the words a link would show. Whombat points them out on the Share
 * sheet; it never changes the words itself. Pure.
 */
import type { ShareWarning } from '@whombat/core';

const ADDRESS = [
  // IPv4, with or without a port or a prefix length.
  /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?::\d{1,5}|\/\d{1,2})?\b/,
  // IPv6 with at least three groups (`fe80::1`, `2001:db8:…`), not times like 10:30.
  /\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b(?=[^\w:]|$)/i,
  // Names on a home network or a tailnet.
  /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:lan|local|home|internal|localdomain|home\.arpa|ts\.net)\b/i,
];
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/;
const SECRET = [
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,})\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|passphrase|wachtwoord|token|secret|api[ _-]?key)\s*[:=]\s*["']?[^\s"']{6,}/i,
];

const TIME = /^\d{1,2}:\d{2}(?::\d{2})?$/;

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m && !TIME.test(m[0])) return m[0];
  }
  return null;
}

/** A secret shown on the sheet: its first four characters and an ellipsis, never the whole thing. */
function cut(secret: string): string {
  return `${secret.slice(0, 4)}…`;
}

/** The warnings for the words of the messages a link would show, in the order address, email, secret. */
export function shareWarnings(texts: readonly string[]): ShareWarning[] {
  const found = new Map<ShareWarning['kind'], { messages: number; example: string }>();
  const note = (kind: ShareWarning['kind'], example: string | null) => {
    if (!example) return;
    const had = found.get(kind);
    if (had) had.messages++;
    else found.set(kind, { messages: 1, example: example.slice(0, 80) });
  };
  for (const text of texts) {
    // Code blocks are words too: a pasted config is where an address or a key most often hides.
    note('address', firstMatch(text, ADDRESS));
    note('email', firstMatch(text, [EMAIL]));
    const secret = firstMatch(text, SECRET);
    note('secret', secret ? cut(secret) : null);
  }
  return (['address', 'email', 'secret'] as const).flatMap((kind) => {
    const f = found.get(kind);
    return f ? [{ kind, ...f }] : [];
  });
}
