/**
 * A picture beside a tool's answer (browser.md BT-03; macos-servers.md): a tool attaches it to its answer object without
 * putting it in the JSON, and `/mcp` sends it as MCP image content after the text (providers that take no images in
 * tool results read the text part).
 */

const IMAGE = Symbol('whombat.tool.image');

/** A picture a tool's answer carries: base64 and its type. */
export interface ToolImage {
  data: string;
  mimeType: 'image/png' | 'image/jpeg';
}

/**
 * Attaches a picture (a PNG unless said otherwise) to a tool's answer; `/mcp` sends it as MCP image content next to the
 * text.
 */
export function withImage<T extends object>(
  out: T,
  base64: string,
  mimeType: ToolImage['mimeType'] = 'image/png',
): T {
  Object.defineProperty(out, IMAGE, { value: { data: base64, mimeType }, enumerable: false });
  return out;
}

/** The picture a tool's answer carries, if any. */
export function imageOf(out: object): ToolImage | null {
  const value = (out as { [IMAGE]?: unknown })[IMAGE];
  return value && typeof value === 'object' && typeof (value as ToolImage).data === 'string'
    ? (value as ToolImage)
    : null;
}
