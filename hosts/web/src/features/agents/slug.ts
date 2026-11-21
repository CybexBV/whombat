// Server names (ids): the hub's Slug rule (internal/hub/api_admin.go) —
// lower-case letters, digits and single dashes, at most 63 characters.

import { t } from '../../lib/i18n';

export function slugify(s: string): string {
  let out = '';
  let dash = false;
  for (const ch of s.toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      out += ch;
      dash = false;
    } else if (!dash && out.length > 0) {
      out += '-';
      dash = true;
    }
  }
  out = out.replace(/^-+|-+$/g, '');
  if (out.length > 63) out = out.slice(0, 63).replace(/-+$/, '');
  return out;
}

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Error text for a server name, or null when it is valid (case is folded by the caller). */
export function serverNameError(name: string): string | null {
  const n = name.trim().toLowerCase();
  if (!n) return t('Give the server a name.');
  if (n.length > 63) return t('Use at most 63 characters.');
  if (!NAME_RE.test(n) || n.includes('--')) return t('Use letters, digits and single dashes (for example thetitan or web-01).');
  return null;
}

/** Error text for a group label, or null when it is valid. */
export function groupError(group: string): string | null {
  const g = group.trim();
  if (!g) return t('Give the group a name.');
  if (g.length > 64) return t('Use at most 64 characters.');
  if (g.toLowerCase() === 'all') return t('“All” is reserved; choose another name.');
  return null;
}
