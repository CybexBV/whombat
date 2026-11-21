import { WhombatAvatar } from '@whombat/avatars/react';
import { WhombatLogo } from '@whombat/brand/react';
import type { ReactNode } from 'react';
import styles from './AuthLayout.module.css';

export interface AuthLayoutProps {
  /** Mono kicker above the title (`SIGN IN`), like the onboarding's `STEP 1 OF 4`. */
  kicker: string;
  title: ReactNode;
  sub?: ReactNode;
  /** Hazel's tip in the bubble at the bottom of the aside. */
  tip: ReactNode;
  children?: ReactNode;
}

/**
 * Frame for the pages outside a burrow (sign-in, magic-link landing, mobile info). Not mocked: it
 * follows the onboarding screen — side aside with the logo and Hazel's tip, a centred column with a
 * mono kicker, a 44px title and a 17px sub.
 */
export function AuthLayout({ kicker, title, sub, tip, children }: AuthLayoutProps) {
  return (
    <div className={styles.page}>
      <aside className={styles.aside}>
        <WhombatLogo variant="lockup" height={23} label="Whombat" />
        <div className={styles.tip}>
          <span className={styles.tipAvatar}>
            <WhombatAvatar face="hazel" size={64} eager />
          </span>
          <p className={styles.bubble}>{tip}</p>
        </div>
      </aside>
      <main className={styles.main}>
        <div className={styles.column}>
          <div className={styles.intro}>
            <span className={styles.kicker}>{kicker}</span>
            <h1 className={styles.title}>{title}</h1>
            {sub && <p className={styles.sub}>{sub}</p>}
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
