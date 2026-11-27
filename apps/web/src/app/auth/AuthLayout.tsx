import { WhombatAvatar } from '@whombat/avatars/react';
import { WhombatLogo } from '@whombat/brand/react';
import type { ReactNode } from 'react';
import ob from '../../features/onboarding/OnboardingScreen.module.css';
import { LanguageSwitch } from '../../i18n/LanguageSwitch';
import styles from './AuthLayout.module.css';

/** A step of a setup this page is part of, in the aside, as onboarding shows them. */
export interface AuthStep {
  t: string;
  d: string;
  state: 'done' | 'current' | 'todo';
}

export interface AuthLayoutProps {
  /** Mono kicker above the title (`SIGN IN`), like the onboarding's `STEP 1 OF 4`. */
  kicker: string;
  title: ReactNode;
  sub?: ReactNode;
  /** Hazel's tip in the bubble at the bottom of the aside. */
  tip: ReactNode;
  /** The setup's steps in the aside, when this page is one of them. */
  steps?: readonly AuthStep[];
  children?: ReactNode;
}

/**
 * Frame for the pages outside a burrow (sign-in, magic-link landing, mobile info). Not mocked: it
 * follows the onboarding screen — side aside with the logo and Hazel's tip, a centred column with a
 * mono kicker, a 44px title and a 17px sub.
 */
export function AuthLayout({ kicker, title, sub, tip, steps, children }: AuthLayoutProps) {
  return (
    <div className={styles.page}>
      <aside className={styles.aside}>
        <WhombatLogo variant="lockup" height={23} label="Whombat" />
        {steps?.length ? (
          <ol className={`${ob.steps} ${styles.stepList}`} aria-label="Steps" data-testid="auth-steps">
            {steps.map((s, i) => (
              <li
                key={s.t}
                className={ob.step}
                data-static="true"
                data-current={s.state === 'current' || undefined}
                aria-current={s.state === 'current' ? 'step' : undefined}
              >
                <span
                  className={ob.stepDot}
                  data-done={s.state === 'done' || undefined}
                  data-current={s.state === 'current' || undefined}
                >
                  {s.state === 'done' ? '✓' : i + 1}
                </span>
                <span className={ob.stepText}>
                  <span className={ob.stepTitle}>{s.t}</span>
                  <span className={ob.stepDesc}>{s.d}</span>
                </span>
              </li>
            ))}
          </ol>
        ) : null}
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
          <LanguageSwitch onlyWhenAsked />
        </div>
      </main>
    </div>
  );
}
