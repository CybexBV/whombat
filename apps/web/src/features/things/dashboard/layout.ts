/**
 * How a Summary's chart rows sit on the web (Whombat dashboards.md DS-01, DS-04; dashboards-web.md AP-2050…). Which
 * panel goes where is `placePanels` (`@whombat/client`, shared with the phone); this is the web's grid. Pure.
 */

/**
 * A chart row's columns: three cards share the width evenly; two and one share it as the main and side columns below
 * do (1.85fr · 1fr, the mock's Network beside Disk I/O), so their edges line up; a row that isn't full fills the width
 * by its cards' spans.
 */
export function chartRowColumns(spans: readonly number[]): string {
  const total = spans.reduce((a, b) => a + b, 0);
  if (spans.length === 2 && total === 3)
    return spans[0] === 2 ? 'minmax(0, 1.85fr) minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(0, 1.85fr)';
  return spans.map((s) => `minmax(0, ${s}fr)`).join(' ');
}

/**
 * A wide card beside a narrow one keeps its pair on a middling page (servers-connections-places.md: beside a
 * place's list), the wide one a little narrower than on a full page; null for any other row.
 */
export function chartPairColumns(spans: readonly number[]): string | null {
  if (spans.length !== 2 || spans.reduce((a, b) => a + b, 0) !== 3) return null;
  return spans[0] === 2 ? 'minmax(0, 1.4fr) minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(0, 1.4fr)';
}

/**
 * Which cards of a chart row take the whole width when the row has two columns (a narrower page): a wide card, and a
 * card left alone on its line — so no line of two columns has a hole.
 */
export function twoColumnFull(spans: readonly number[]): boolean[] {
  const full = spans.map((s) => s >= 2);
  let i = 0;
  while (i < spans.length) {
    if (full[i]) {
      i++;
      continue;
    }
    if (i + 1 < spans.length && !full[i + 1]) i += 2;
    else {
      full[i] = true;
      i++;
    }
  }
  return full;
}
