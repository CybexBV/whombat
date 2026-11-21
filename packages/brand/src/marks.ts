/**
 * Other companies' marks, for guide cards' provider choices (docs/decisions/assistant-guides.md AG-16): the
 * Google “G”, the Microsoft four squares, Claude's mark, the OpenAI mark, GitHub's Invertocat and a generic mail
 * envelope. They are drawn as the owners publish them, never recoloured: an explicit exception to “colors only
 * through tokens” (like status dots and avatar tones). Marks their owners publish in one flat black or white
 * (OpenAI, GitHub) use `currentColor`, so they follow the text (ink on light, paper on dark), which is how their
 * guidelines ask for them on a light or dark background; the envelope is ours (Lucide's `mail`) and does the same.
 *
 * Sources (unchanged geometry): Google's Sign-In branding “G”; Microsoft's logo (four 10-unit squares, 1-unit gap,
 * #f25022 #7fba00 #00a4ef #ffb900); Claude (#d97757), OpenAI and GitHub from Simple Icons (CC0; trademarks stay
 * their owners'); the envelope from Lucide (ISC).
 */
import { CONNECTION_MARK_DEFINITIONS, CONNECTION_MARKS, ENVELOPE_MARK } from './connectionMarks.js';
import type { LogoNode } from './index.js';
import { OS_MARK_DEFINITIONS, OS_MARKS } from './osMarks.js';
import { PLATFORM_MARK_DEFINITIONS, PLATFORM_MARKS } from './platformMarks.js';

/**
 * The guide cards' marks, then the connections catalog's (`connectionMarks.ts`, AP-760), the guest platforms' (AP-1755)
 * and the operating systems' (`osMarks.ts`, marks.md MK-01). Each is also stored as a file in `assets/marks/`.
 */
export const BRAND_MARKS = [
  'google',
  'microsoft',
  'mail',
  'claude',
  'openai',
  'github',
  ...CONNECTION_MARKS,
  ...PLATFORM_MARKS,
  ...OS_MARKS,
] as const;
export type BrandMarkName = (typeof BRAND_MARKS)[number];

/** One shape of a mark: filled (hex, or `currentColor` for the text color) or stroked. */
export interface MarkShape {
  d: string;
  fill: string;
  stroke?: string;
  strokeWidth?: number;
  /** For a mark drawn with holes by the even-odd rule (Moneybird's). */
  fillRule?: 'evenodd';
  /** A connection's own logo only: how its strokes end and join (round when absent) and its opacity. */
  linecap?: 'butt' | 'round' | 'square';
  linejoin?: 'miter' | 'round' | 'bevel';
  opacity?: number;
}

export interface BrandMarkDefinition {
  /** The owner's name for the mark (tests, stories); the UI names the provider in text next to it. */
  name: string;
  viewBox: string;
  shapes: readonly MarkShape[];
}

/**
 * A mark's drawing without a name: a bundled mark's, or a connection's own logo that Whombat's server turned into
 * shapes (`ThingLogo` in `@whombat/core`).
 */
export type MarkDrawing = Pick<BrandMarkDefinition, 'viewBox' | 'shapes'>;
/** What the apps draw as a mark: a bundled one by its name, or a drawing. */
export type MarkLike = BrandMarkName | MarkDrawing;

/** A rect as a path (react-native-svg and the DOM draw paths the same). */
const rect = (x: number, y: number, w: number, h: number) => `M${x} ${y}h${w}v${h}h${-w}z`;

export const BRAND_MARK_DEFINITIONS: Record<BrandMarkName, BrandMarkDefinition> = {
  ...CONNECTION_MARK_DEFINITIONS,
  ...PLATFORM_MARK_DEFINITIONS,
  ...OS_MARK_DEFINITIONS,
  google: {
    name: 'Google',
    viewBox: '0 0 48 48',
    shapes: [
      {
        fill: '#EA4335',
        d: 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z',
      },
      {
        fill: '#4285F4',
        d: 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z',
      },
      {
        fill: '#FBBC05',
        d: 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z',
      },
      {
        fill: '#34A853',
        d: 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z',
      },
    ],
  },
  microsoft: {
    name: 'Microsoft',
    viewBox: '0 0 21 21',
    shapes: [
      { fill: '#F25022', d: rect(0, 0, 10, 10) },
      { fill: '#7FBA00', d: rect(11, 0, 10, 10) },
      { fill: '#00A4EF', d: rect(0, 11, 10, 10) },
      { fill: '#FFB900', d: rect(11, 11, 10, 10) },
    ],
  },
  mail: ENVELOPE_MARK,
  claude: {
    name: 'Claude',
    viewBox: '0 0 24 24',
    shapes: [
      {
        fill: '#D97757',
        d: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
      },
    ],
  },
  openai: {
    name: 'OpenAI',
    viewBox: '0 0 24 24',
    shapes: [
      {
        fill: 'currentColor',
        d: 'M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z',
      },
    ],
  },
  github: {
    name: 'GitHub',
    viewBox: '0 0 24 24',
    shapes: [
      {
        fill: 'currentColor',
        d: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
      },
    ],
  },
};

export function isBrandMark(name: string): name is BrandMarkName {
  return (BRAND_MARKS as readonly string[]).includes(name);
}

/** A mark as a node tree (the logo's renderer-agnostic `<svg>`), `size` px square. */
/** The name a mark is known by in tests and `data-mark`: a bundled mark's, or `logo` for a drawing. */
export const markKey = (mark: MarkLike): string => (typeof mark === 'string' ? mark : 'logo');

export function buildBrandMark(mark: MarkLike, size: number): LogoNode {
  const def = typeof mark === 'string' ? BRAND_MARK_DEFINITIONS[mark] : mark;
  return {
    tag: 'svg',
    attrs: { viewBox: def.viewBox, width: size, height: size },
    children: def.shapes.map((s) => ({
      tag: 'path',
      attrs: {
        d: s.d,
        fill: s.fill,
        ...(s.fillRule && { fillRule: s.fillRule }),
        ...(s.stroke && {
          stroke: s.stroke,
          strokeWidth: s.strokeWidth ?? 1,
          strokeLinecap: s.linecap ?? 'round',
          strokeLinejoin: s.linejoin ?? 'round',
        }),
        ...(s.opacity !== undefined && s.opacity < 1 && { opacity: s.opacity }),
      },
      children: [],
    })),
  };
}
