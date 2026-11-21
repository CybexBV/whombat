/**
 * The council's three elders as small round faces side by side: beside “What the council decided”, in a point's advice
 * when the council gave it, and on T3 Code's line while the council reviews. Whombat's own drawing (`elderSvg`), each
 * seat's robe, cut to the head; decoration only, the words beside it say who.
 */
import { elderSvg } from '@whombat/avatars';
import { cx } from '../../components/cx';
import styles from './CouncilFaces.module.css';

/** The three heads, drawn once: the drawing depends on its seat and pose only. */
let faces: string[] | null = null;
function faceSources(): string[] {
  faces ??= [0, 1, 2].map(
    (seat) =>
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
        elderSvg({ seat, pose: 'agrees', idPrefix: `council-face-${seat}` }),
      )}`,
  );
  return faces;
}

export function CouncilFaces({ size = 22, className }: { size?: 20 | 22 | 26; className?: string }) {
  return (
    <span
      className={cx(styles.faces, size === 20 && styles.small, size === 26 && styles.large, className)}
      aria-hidden="true"
      data-council-faces=""
    >
      {faceSources().map((src) => (
        <img key={src} src={src} alt="" className={styles.face} />
      ))}
    </span>
  );
}
