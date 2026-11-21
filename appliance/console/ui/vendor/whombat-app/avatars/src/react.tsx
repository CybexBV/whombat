/**
 * React DOM renderers: `<WhombatAvatar>` (an agent, one static `<img>`) and `<HumanAvatar>` (a person's photo, or their
 * initials).
 */
import { type CSSProperties, type ReactElement, useState } from 'react';
import { HUMAN_INITIALS_COLOR, initialsFontSize, normalizeInitials, toneFor } from './human';
import { type AvatarCrop, type AvatarFace, avatarVariant, DEFAULT_AVATAR_SIZE } from './index';
import { AVATAR_URLS } from './urls';

export interface WhombatAvatarProps {
  /** The agent's face (OA-08): one of the five drawings. */
  face: AvatarFace;
  /** Rendered width and height, px. Default 40. */
  size?: number;
  /** `auto` (default): bust from 40px, head from 25px, the small head at 24px and below (FA-07). */
  crop?: AvatarCrop;
  /** Alt text: the agent's name (“Dusty”). Without it the avatar is decorative (`alt=""`). */
  label?: string;
  /** `alt=""` even with a label: the name is printed right next to it. */
  decorative?: boolean;
  /** Above the fold (Settings → Agent, Meet your agent): load now. Otherwise the browser loads it lazily. */
  eager?: boolean;
  /** Loading or unknown agent: an empty box of the same size, no request. */
  silhouette?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * The agent's avatar (FA-06, OA-08): its face's static SVG as an `<img>` — never inlined (the files share gradient ids),
 * no background, border or circular crop (a parent that wants a chip tints itself with the face's colour at 14%), explicit
 * `width`/`height` so nothing shifts when it loads.
 */
export function WhombatAvatar({
  face,
  size = DEFAULT_AVATAR_SIZE,
  crop = 'auto',
  label,
  decorative = false,
  eager = false,
  silhouette = false,
  className,
  style,
}: WhombatAvatarProps): ReactElement {
  const box: CSSProperties = { display: 'block', flex: 'none', width: size, height: size, ...style };
  if (silhouette) {
    return (
      <span aria-hidden="true" className={className} style={box} data-avatar={face} data-silhouette="" />
    );
  }
  const variant = avatarVariant(size, crop);
  return (
    <img
      src={AVATAR_URLS[face][variant]}
      alt={decorative || !label ? '' : label}
      width={size}
      height={size}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      className={className}
      style={box}
      // Lets tests and the visual suite find agent avatars and the file they show.
      data-avatar={face}
      data-variant={variant}
    />
  );
}

export interface HumanAvatarProps {
  /** Two letters, e.g. "MO". Longer input is cut to two characters. */
  initials: string;
  /** Background tone, one of `HUMAN_TONES` (any CSS color works). Defaults to a stable tone for the initials. */
  tone?: string;
  /** Diameter in px. Default 40. */
  size?: number;
  /** Accessible name, e.g. "Mara Okafor". Omit when the name is shown next to the avatar. */
  label?: string;
  /**
   * Their photo (contracts CT-265 `Person.avatarUrl`, already loadable: a URL or an object URL). Drawn round over the
   * initials disc, `object-fit: cover`; the initials show while it loads and stay when it fails. Null: the initials.
   */
  src?: string | null;
  className?: string;
  style?: CSSProperties;
}

export function HumanAvatar({
  initials,
  tone,
  size = 40,
  label,
  src = null,
  className,
  style,
}: HumanAvatarProps): ReactElement {
  const text = normalizeInitials(initials);
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  // Which `src` loaded or failed: a new photo starts over (its URL changes with it, CT-265).
  const [shown, setShown] = useState<{ src: string; ok: boolean } | null>(null);
  const loaded = src !== null && shown?.src === src && shown.ok;
  const failed = src !== null && shown?.src === src && !shown.ok;
  return (
    <span
      {...a11y}
      className={className}
      style={{
        position: 'relative',
        width: size,
        height: size,
        borderRadius: '50%',
        background: tone ?? toneFor(text),
        color: HUMAN_INITIALS_COLOR,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        fontWeight: 600,
        fontSize: initialsFontSize(size),
        // The mock's initials use the default line box; `1` moves the glyphs up 1px (Bricolage metrics).
        lineHeight: 'normal',
        userSelect: 'none',
        ...style,
      }}
      data-photo={src && !failed ? '' : undefined}
    >
      {/* Hidden once the photo is in (a photo with transparency must not show the letters through it). */}
      <span style={loaded ? { visibility: 'hidden' } : undefined}>{text}</span>
      {src && !failed ? (
        <img
          src={src}
          alt=""
          draggable={false}
          decoding="async"
          onLoad={() => setShown({ src, ok: true })}
          onError={() => setShown({ src, ok: false })}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            borderRadius: '50%',
            objectFit: 'cover',
            display: 'block',
          }}
        />
      ) : null}
    </span>
  );
}
