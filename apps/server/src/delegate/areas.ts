/**
 * Which tasks of a delegation change the same thing (docs/decisions/delegate.md DLG-24): each task names the files,
 * folders or parts it changes, and one that shares a part with an earlier task starts after it. Pure.
 */

/** A part as compared: trimmed, lower case, forward slashes, no leading `./` or trailing slash. */
function normal(area: string): string {
  return area
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
}

/** Whether two parts overlap: the same, or one a folder the other is in. */
export function areaOverlaps(a: string, b: string): boolean {
  const x = normal(a);
  const y = normal(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** The parts two tasks both change (as the first names them). */
export function sharedAreas(a: readonly string[], b: readonly string[]): string[] {
  return a.filter((x) => b.some((y) => areaOverlaps(x, y)));
}

/**
 * For each task (in card order) that names no task to come after: the nearest earlier task it shares a part with, by
 * index, and the parts; null when none. Tasks the agent put after another keep theirs.
 */
export function overlapAfter(
  tasks: readonly { areas: readonly string[]; after: number | null }[],
): ({ index: number; shared: string[] } | null)[] {
  return tasks.map((t, i) => {
    if (t.after !== null || !t.areas.length) return null;
    for (let j = i - 1; j >= 0; j--) {
      const shared = sharedAreas(t.areas, tasks[j]?.areas ?? []);
      if (shared.length) return { index: j, shared };
    }
    return null;
  });
}
