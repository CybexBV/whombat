/**
 * jsdom has no layout: ProseMirror measures ranges when it scrolls the selection into view. Empty rects are
 * enough for the editor to run in component tests.
 */
const empty = (): DOMRect =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
const emptyList = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;

for (const proto of [Range.prototype, Element.prototype] as {
  getClientRects?: unknown;
  getBoundingClientRect?: unknown;
}[]) {
  if (typeof proto.getClientRects !== 'function') proto.getClientRects = emptyList;
  if (typeof proto.getBoundingClientRect !== 'function') proto.getBoundingClientRect = empty;
}
if (typeof document.elementFromPoint !== 'function') document.elementFromPoint = () => null;
