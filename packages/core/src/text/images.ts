/**
 * Images in messages (CT-90): which image sources a client may show, and turning an SVG document an agent wrote
 * into something an `<img>` can show. Clients show images through an image element only (`<img>`, an RN image or
 * SVG view), never as DOM: an SVG as an image runs no scripts and loads nothing. Pure (no Buffer, btoa or DOM), so
 * web and mobile share it.
 */

/** The image types a message may carry as a `data:` URI (AVIF since 0.23, CT-152). */
const DATA_IMAGE =
  /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)(?:;charset=[\w.-]+)?(?:;base64)?,[^\s"<>`]*$/i;
const HTTP_IMAGE = /^https?:\/\/[^\s"<>`]+$/i;

/**
 * Whether `src` is an image source a message may show: `https://…`, `http://…`, or a `data:` URI of a PNG, JPEG, GIF,
 * WebP, AVIF or SVG image. Anything else (`javascript:`, other `data:` types, relative paths) is not.
 */
export function isSafeImageSrc(src: string): boolean {
  return HTTP_IMAGE.test(src) || DATA_IMAGE.test(src);
}

/** The largest SVG document shown as an image, in characters. */
export const SVG_IMAGE_MAX = 256 * 1024;

/**
 * An optional XML prolog, then comments and a DOCTYPE without an internal subset (no entity definitions),
 * then the root `<svg` tag.
 */
const SVG_HEAD = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE\s+svg[^>[]*>)\s*)*(?=<svg[\s>/])/;
const SVG_TAG = /^<svg\b[^>]*>/;

/**
 * Whether `text` looks like one standalone SVG document: after an optional prolog, comments and DOCTYPE it starts
 * with `<svg` and ends with `</svg>`, and it is at most {@link SVG_IMAGE_MAX} characters. Not a validation: a
 * malformed document just shows as a broken image.
 */
export function isSvgDocument(text: string): boolean {
  const doc = text.trim();
  return doc.length <= SVG_IMAGE_MAX && doc.endsWith('</svg>') && SVG_HEAD.test(doc);
}

/**
 * A standalone SVG document ready to show as an image, or null when `text` is not one ({@link isSvgDocument}).
 * Adds the SVG (and xlink) namespace to the root tag when the author left it out: inline SVG in HTML does not need
 * it, an SVG image does. For an SVG view (react-native-svg) that takes the markup itself.
 */
export function svgImageDocument(text: string): string | null {
  if (!isSvgDocument(text)) return null;
  const doc = text.trim(); // trim() drops a BOM too
  const head = (SVG_HEAD.exec(doc) as RegExpExecArray)[0];
  const tag = SVG_TAG.exec(doc.slice(head.length));
  if (!tag) return null;
  let root = tag[0];
  const attrs: string[] = [];
  if (!/\sxmlns\s*=/.test(root)) attrs.push(' xmlns="http://www.w3.org/2000/svg"');
  if (/\bxlink:/.test(doc) && !/\sxmlns:xlink\s*=/.test(root))
    attrs.push(' xmlns:xlink="http://www.w3.org/1999/xlink"');
  if (attrs.length === 0) return doc;
  root = `<svg${attrs.join('')}${root.slice(4)}`;
  return head + root + doc.slice(head.length + tag[0].length);
}

/**
 * A `data:image/svg+xml` URI (UTF-8, percent-encoded) for an SVG document an agent wrote, to show with `<img src>`;
 * null when `text` is not a standalone SVG document ({@link svgImageDocument}).
 */
export function svgImageSrc(text: string): string | null {
  const doc = svgImageDocument(text);
  if (doc === null) return null;
  try {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(doc)}`;
  } catch {
    return null; // a lone surrogate
  }
}
