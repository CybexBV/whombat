/**
 * A connection's own logo (Whombat docs/decisions/connection-looks.md): the service's SVG turned by Whombat's server into
 * path shapes, drawn by the apps exactly as the bundled marks are (`@whombat/brand`). Nothing of the original file
 * reaches an app: only a viewBox, path data and colours, so nothing in it can run or load anything. A logo in one dark
 * or light colour comes as `currentColor` and follows the text.
 */
import { z } from 'zod';

/** At most this many shapes in a logo. */
export const THING_LOGO_SHAPES_MAX = 64;
/** At most this many characters of path data in a whole logo. */
export const THING_LOGO_PATH_MAX = 60_000;

/** A colour as the apps draw it: `#rrggbb`, or the text colour. */
export const ThingLogoColour = z.union([z.literal('currentColor'), z.string().regex(/^#[0-9a-f]{6}$/)]);
export type ThingLogoColour = z.infer<typeof ThingLogoColour>;

/** One shape: a path, filled (or `none`) and maybe stroked. */
export const ThingLogoShape = z.object({
  /** Path data in absolute or relative commands, numbers only: nothing else may be in it. */
  d: z
    .string()
    .min(1)
    .max(THING_LOGO_PATH_MAX)
    .regex(/^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+\-\s]+$/),
  fill: z.union([ThingLogoColour, z.literal('none')]),
  stroke: ThingLogoColour.optional(),
  strokeWidth: z.number().positive().max(100_000).optional(),
  linecap: z.enum(['butt', 'round', 'square']).optional(),
  linejoin: z.enum(['miter', 'round', 'bevel']).optional(),
  fillRule: z.literal('evenodd').optional(),
  opacity: z.number().min(0).max(1).optional(),
});
export type ThingLogoShape = z.infer<typeof ThingLogoShape>;

const NUMBER = String.raw`-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?`;

export const ThingLogo = z
  .object({
    /** Four numbers: `0 0 24 24`. */
    viewBox: z
      .string()
      .max(80)
      .regex(new RegExp(`^${NUMBER} ${NUMBER} ${NUMBER} ${NUMBER}$`)),
    shapes: z.array(ThingLogoShape).min(1).max(THING_LOGO_SHAPES_MAX),
  })
  .refine((l) => l.shapes.reduce((n, s) => n + s.d.length, 0) <= THING_LOGO_PATH_MAX, {
    message: 'A logo has at most 60,000 characters of path.',
  });
export type ThingLogo = z.infer<typeof ThingLogo>;
