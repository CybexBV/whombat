// "Download from URL" to a Proxmox storage: the file name the form fills in
// from the URL and the checks PVE (and the agent) apply to URL and name
// (docs/MANAGE.md 2.3, content.download). Pure, unit tested.

import type { DownloadInput, StorageVolume } from '../../api/manage';
import { t } from '../../lib/i18n';

export const CHECKSUM_ALGORITHMS: NonNullable<DownloadInput['checksum_algorithm']>[] = ['sha256', 'sha512', 'sha384', 'sha224', 'sha1', 'md5'];

/** Extensions per content type: .iso / .img; .tar.gz|xz|zst; disk images and appliances for import. */
const EXT: Record<StorageVolume['content'], RegExp> = {
  iso: /\.(iso|img)$/i,
  vztmpl: /\.tar\.(gz|xz|zst)$/i,
  import: /\.(ova|ovf|qcow2|vmdk|raw|img)$/i,
};

export const EXT_HINT: Record<StorageVolume['content'], string> = {
  iso: '.iso, .img',
  vztmpl: '.tar.gz, .tar.xz, .tar.zst',
  import: '.ova, .qcow2, .vmdk, .raw, .img',
};

/**
 * The last path segment of a URL as a file name PVE accepts ("" when there is
 * none): percent-decoded, other characters replaced by "_".
 */
export function filenameFromUrl(url: string): string {
  let path: string;
  try {
    path = new URL(url.trim()).pathname;
  } catch {
    return '';
  }
  const last = path.split('/').filter(Boolean).pop() ?? '';
  let name: string;
  try {
    name = decodeURIComponent(last);
  } catch {
    name = last;
  }
  return name
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 200);
}

export function urlError(url: string): string | undefined {
  const u = url.trim();
  if (!u) return t('Enter the address of the file.');
  let p: URL;
  try {
    p = new URL(u);
  } catch {
    return t('This is not a valid address.');
  }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return t('Use an http:// or https:// address.');
  if (p.username || p.password) return t('Leave the user name and password out of the address.');
  return undefined;
}

export function filenameError(name: string, content: StorageVolume['content']): string | undefined {
  const n = name.trim();
  if (!n) return t('Enter a file name.');
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(n)) return t('Use letters, digits, “.”, “_” and “-” only.');
  if (!EXT[content].test(n)) return t('The name must end in {ext}.', { ext: EXT_HINT[content] });
  return undefined;
}

const SUM_LEN: Record<string, number> = { md5: 32, sha1: 40, sha224: 56, sha256: 64, sha384: 96, sha512: 128 };

export function checksumError(sum: string, algorithm: string): string | undefined {
  const s = sum.trim();
  if (!s || !algorithm) return undefined;
  if (!/^[0-9a-fA-F]+$/.test(s)) return t('Use the hexadecimal checksum.');
  return s.length === SUM_LEN[algorithm] ? undefined : t('A {algorithm} checksum has {n} characters.', { algorithm, n: SUM_LEN[algorithm] ?? 0 });
}
