/**
 * @whombat/avatars — the agent's five faces (Whombat one-agent.md OA-08; five-agents.md FA-06…FA-09 for the files) and
 * people's initials.
 *
 * The agent wears one of five faces, each three finished SVG files in `svg/` (`<stem>-bust.svg`, `<stem>-head.svg`,
 * `<stem>-head-small.svg`), copied unchanged from the design handoff (`docs/design-handoff/whombat-crew/svg`): no
 * renderer, no animation. This module is pure
 * (no asset imports) so web, Android and tests share the file choice. React DOM: `@whombat/avatars/react`; the web's
 * hashed file URLs: `@whombat/avatars/urls`; Android imports the files themselves (`@whombat/avatars/svg/*`).
 *
 * Self-contained (no `@whombat/core`), so the appliance console can vendor `src/` and `svg/` as they are: the faces
 * below are the contracts' (`AGENT_FACES`), pinned by `index.test.ts`.
 */

export {
  HUMAN_INITIALS_COLOR,
  HUMAN_TONES,
  type HumanTone,
  initialsFontSize,
  initialsFor,
  normalizeInitials,
  toneFor,
} from './human';

/**
 * The five faces the agent may wear (Whombat one-agent.md OA-08; contracts `AGENT_FACES`), in the contracts' order. A
 * Whombat has one agent; its face is one of these drawings, chosen in setup and in Settings → Agent.
 */
export const AVATAR_FACES = ['dusty', 'banjo', 'neo', 'skipper', 'hazel'] as const;
export type AvatarFace = (typeof AVATAR_FACES)[number];

/** The face a Whombat's agent wears until someone picks another (contracts `DEFAULT_AGENT_FACE`). */
export const DEFAULT_AVATAR_FACE: AvatarFace = 'dusty';

/**
 * The drawing's file stem per face: the handoff's files keep the names they were drawn under (`associate-bust.svg` is
 * Dusty), so the console and the phone, which vendor or import `svg/`, need no change.
 */
export const AVATAR_FILE_STEMS = {
  dusty: 'associate',
  banjo: 'developer',
  neo: 'operator',
  skipper: 'lead',
  hazel: 'assistant',
} as const satisfies Record<AvatarFace, string>;

/** `auto` picks the file from the size (FA-07). */
export type AvatarCrop = 'auto' | 'bust' | 'head';
/** The three files per face. */
export const AVATAR_VARIANTS = ['bust', 'head', 'head-small'] as const;
export type AvatarVariant = (typeof AVATAR_VARIANTS)[number];

/** The smallest size that shows the bust (`auto`). */
export const BUST_MIN_SIZE = 40;
/** The largest size that shows the small head, whatever the crop: thicker strokes, no chest details. */
export const HEAD_SMALL_MAX_SIZE = 24;
/** The default rendered size, px. */
export const DEFAULT_AVATAR_SIZE = 40;

/** FA-07: ≥ 40 → bust; 25–39 → head; ≤ 24 → head-small. A forced crop still takes the small head at 24px and below. */
export function avatarVariant(size: number, crop: AvatarCrop = 'auto'): AvatarVariant {
  if (size <= HEAD_SMALL_MAX_SIZE) return 'head-small';
  if (crop === 'auto') return size >= BUST_MIN_SIZE ? 'bust' : 'head';
  return crop;
}

/** The file a face shows at `size`, e.g. `lead-head-small.svg` for Skipper at 16px. */
export function avatarFile(face: AvatarFace, size: number, crop: AvatarCrop = 'auto'): string {
  return `${AVATAR_FILE_STEMS[face]}-${avatarVariant(size, crop)}.svg`;
}

export function isAvatarFace(value: unknown): value is AvatarFace {
  return typeof value === 'string' && (AVATAR_FACES as readonly string[]).includes(value);
}

export { ELDER_POSES, ELDER_VIEWBOX, type ElderOptions, type ElderPose, elderSvg } from './elders';
