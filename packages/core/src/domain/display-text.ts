/**
 * Text a screen may draw on one line: any script, no control, format or surrogate code points and no separator but
 * U+0020, with the length in code points. The desk, the hardware report and the screens' schemas share the one pattern,
 * so the console server's parsers take every such line as it is. Pure.
 */
import { z } from 'zod';

/** The pattern of a display line of `min`…`max` code points (`u` flag). */
export function displayTextRe(min: number, max: number): RegExp {
  return new RegExp(`^(?:[^\\p{Cc}\\p{Cf}\\p{Cs}\\p{Z}]| ){${min},${max}}$`, 'u');
}

/** A display line of `min`…`max` code points as a schema. */
export function displayLine(max: number, min = 1) {
  return z.string().regex(displayTextRe(min, max));
}
