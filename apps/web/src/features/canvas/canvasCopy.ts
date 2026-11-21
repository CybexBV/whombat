/**
 * The article heading drops a trailing " · <suffix>" that `canvas.title` carries for the header
 * breadcrumb ("Invoice PDF export · plan" → "Invoice PDF export"), matching the reference markup.
 */
export function canvasHeading(title: string): string {
  const i = title.lastIndexOf(' · ');
  return i === -1 ? title : title.slice(0, i);
}
