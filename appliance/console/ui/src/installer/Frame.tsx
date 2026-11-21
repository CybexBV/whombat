import type { AvatarFace } from '@whombat/avatars';
import { WhombatLogo } from '@whombat/brand/react';
import type { ReactNode } from 'react';
import { GUIDE_LABEL } from '../lib/copy';
import { Bubble } from '../ui/Bubble';
import { Burrow } from '../ui/Wombat';
import styles from './installer.module.css';

export interface GuideScene {
  say: ReactNode;
  digging?: boolean;
  pile?: number;
  /** A friend peeks out of a second burrow (the Done screen). */
  friend?: AvatarFace;
}

export interface FrameProps {
  kicker: string;
  title: ReactNode;
  sub?: ReactNode;
  guide: GuideScene;
  /** Mono meta line at the bottom of the aside (release · platform · environment). */
  meta?: string;
  children?: ReactNode;
  /** The row of buttons at the bottom of the column. */
  actions?: ReactNode;
}

/**
 * The installer's frame: the app's onboarding layout (an aside with the logo and the guide's tip, a column with
 * a mono kicker, a large title and a sub), with Hazel in a burrow instead of a small tip avatar (CG-35).
 */
export function Frame({ kicker, title, sub, guide, meta, children, actions }: FrameProps) {
  return (
    <div className={styles.page}>
      <aside className={styles.aside}>
        <WhombatLogo variant="lockup" height={26} label="Whombat" />
        <div className={styles.scene}>
          <Bubble className={styles.say} tail="bottom-left">
            {guide.say}
          </Bubble>
          <div className={styles.burrows}>
            <Burrow face="hazel" size={176} digging={guide.digging} pile={guide.pile} label={GUIDE_LABEL} />
            {guide.friend && <Burrow face={guide.friend} size={112} className={styles.friend} />}
          </div>
        </div>
        {meta && <p className={styles.meta}>{meta}</p>}
      </aside>
      <main className={styles.main}>
        <div className={styles.column}>
          <div className={styles.intro}>
            <span className={styles.kicker}>{kicker}</span>
            <h1 className={styles.title}>{title}</h1>
            {sub && <p className={styles.sub}>{sub}</p>}
          </div>
          <div className={styles.body}>{children}</div>
          {actions && <div className={styles.actions}>{actions}</div>}
        </div>
      </main>
    </div>
  );
}
