/**
 * SVG attachments shown as pictures (docs/decisions/app-managed.md AP-100). The server keeps sniffing SVG as text
 * (a download, BP-A03); the clients show it as an image only through channels where nothing in it runs: an
 * `<img>` with a `data:` URL on the web, react-native-svg's `SvgXml` on mobile. Never inline in the page's DOM,
 * never a `blob:` URL (that would be same-origin if someone opened it in a tab). No DOM and no React Native here.
 */

/** Larger SVGs stay a download: the picture isn't worth streaming and parsing that much. */
export const SVG_PREVIEW_MAX_BYTES = 1024 * 1024;

export function isSvgAttachment(a: { contentType: string; name: string }): boolean {
  const type = a.contentType.split(';')[0]?.trim().toLowerCase();
  return type === 'image/svg+xml' || /\.svg$/i.test(a.name.trim());
}

/** An SVG attachment small enough to show as a picture. */
export function showsSvgPreview(a: { contentType: string; name: string; size: number }): boolean {
  return isSvgAttachment(a) && a.size <= SVG_PREVIEW_MAX_BYTES;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 without `btoa` (works on every runtime, and on bytes rather than Latin-1 strings). */
export function base64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      B64.charAt((n >> 18) & 63) +
      B64.charAt((n >> 12) & 63) +
      B64.charAt((n >> 6) & 63) +
      B64.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += `${B64.charAt((n >> 18) & 63)}${B64.charAt((n >> 12) & 63)}==`;
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += `${B64.charAt((n >> 18) & 63)}${B64.charAt((n >> 12) & 63)}${B64.charAt((n >> 6) & 63)}=`;
  }
  return out;
}

/** `data:image/svg+xml;base64,…` for an `<img src>`. */
export function svgDataUri(bytes: Uint8Array): string {
  return `data:image/svg+xml;base64,${base64(bytes)}`;
}

/**
 * The picture's own size from the root `<svg>`: `width`/`height` in px (or unitless), else the `viewBox`.
 * `null` when it says neither (the caller picks a box).
 */
export function svgIntrinsicSize(xml: string): { width: number; height: number } | null {
  const root = /<svg\b[^>]*>/i.exec(xml)?.[0];
  if (!root) return null;
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root)?.[1];
  const px = (v: string | undefined) => {
    const m = v ? /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i.exec(v) : null;
    const n = m ? Number(m[1]) : Number.NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const width = px(attr('width'));
  const height = px(attr('height'));
  if (width && height) return { width, height };
  const box = attr('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (box?.length === 4) {
    const [, , w = 0, h = 0] = box;
    if (w > 0 && h > 0) {
      if (width) return { width, height: (width * h) / w };
      if (height) return { width: (height * w) / h, height };
      return { width: w, height: h };
    }
  }
  return null;
}

/**
 * The SVG for a native renderer (react-native-svg's `SvgXml`), which would fetch what an `<image>` points at:
 * drops `<script>`, `<foreignObject>` and every `<image>` whose `href` isn't a `data:` URL, so showing a picture
 * never calls anyone.
 */
export function svgForNative(xml: string): string {
  return xml
    .replace(/<script\b[\s\S]*?(<\/script\s*>|$)/gi, '')
    .replace(/<foreignObject\b[\s\S]*?(<\/foreignObject\s*>|$)/gi, '')
    .replace(/<image\b([^>]*?)(\/>|>[\s\S]*?<\/image\s*>)/gi, (whole, attrs: string) =>
      /\bhref\s*=\s*["']\s*data:/i.test(attrs) ? whole : '',
    );
}

const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/** Bytes from base64 (padding and whitespace ignored); null when it isn't base64. */
export function fromBase64(text: string): Uint8Array | null {
  const clean = text.replace(/[\s=]+/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    const n = B64_INDEX.get(c);
    if (n === undefined) return null;
    value = (value << 6) | n;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 255);
    }
  }
  return Uint8Array.from(out);
}

/** UTF-8 bytes as text, without `TextDecoder` (not on every React Native runtime); null when they aren't UTF-8. */
function utf8(bytes: Uint8Array): string | null {
  let encoded = '';
  for (const b of bytes) encoded += `%${b.toString(16).padStart(2, '0')}`;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

/**
 * The SVG document inside a `data:image/svg+xml` URL (base64 or percent-encoded), for a native renderer that takes
 * markup (`SvgXml`); null for any other URL.
 */
export function svgFromDataUri(src: string): string | null {
  const m = /^data:image\/svg\+xml((?:;[^,;]*)*?)(;base64)?,(.*)$/is.exec(src.trim());
  if (!m) return null;
  const payload = m[3] ?? '';
  if (m[2]) {
    const bytes = fromBase64(payload);
    return bytes ? utf8(bytes) : null;
  }
  try {
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}
