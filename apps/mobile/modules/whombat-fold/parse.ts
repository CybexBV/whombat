/** The fold module's payload, checked (pure: no native module, so the tests can read it). */

export interface FoldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Posture = 'flat' | 'half' | 'closed';

export interface FoldInfo {
  /** Where the system keeps its vertical bar, in reading direction; null where it has none. */
  barEdge: 'leading' | 'trailing' | null;
  /** The fold (a division region): what the app shouldn't draw a line of text across. */
  folds: FoldRect[];
  /** What the system draws over the app: the clock, the cameras. */
  occlusions: FoldRect[];
  posture: Posture | null;
}

/** The native payload, checked: anything malformed counts as absent. */
export function foldInfoOf(value: unknown): FoldInfo | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const barEdge = v.barEdge === 'leading' || v.barEdge === 'trailing' ? v.barEdge : null;
  const posture = v.posture === 'flat' || v.posture === 'half' || v.posture === 'closed' ? v.posture : null;
  return { barEdge, folds: rectsOf(v.folds), occlusions: rectsOf(v.occlusions), posture };
}

function rectsOf(value: unknown): FoldRect[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((r) => {
    if (!r || typeof r !== 'object') return [];
    const { x, y, width, height } = r as Record<string, unknown>;
    return [x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))
      ? [{ x: x as number, y: y as number, width: width as number, height: height as number }]
      : [];
  });
}
