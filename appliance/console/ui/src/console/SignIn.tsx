/**
 * A device waiting to sign in at this screen (Whombat BX-06, CG-150…CG-153): one panel over whatever the claimed box
 * shows — the claimed screen, the desk's glance locked or unlocked, the clock, quiet hours, black, a dimmed screen, the
 * PIN pad, Talk, the Wi-Fi sheet. `SignInLayer` wraps the console once, so every scene gets it without knowing about
 * it: behind the panel the screen is only a picture, and keys and touches go no further than waking it. The one thing
 * the scenes see of it is `WakeContext` (`ui/hooks.ts`): while the code shows, `useLastInput` says the screen is in use.
 */

import { type ReactNode, useEffect, useRef } from 'react';
import { useT } from '../i18n/react';
import type { ClaimState } from '../lib/api';
import { minutesLeft } from '../lib/console';
import { wordCopy } from '../lib/copy';

import { groupLetters, liveSignIn, type SignIn, signInTitleSize } from '../lib/signIn';
import { useNow, WakeContext } from '../ui/hooks';
import styles from './signin.module.css';

export function SignInLayer({
  claim,
  offset,
  children,
}: {
  claim: ClaimState | null;
  /** Server clock minus page clock. */
  offset: number;
  children: ReactNode;
}) {
  const now = useNow(1000);
  const signIn = liveSignIn(claim, now + offset);
  const shown = signIn !== null;
  const last = useRef(0);
  if (shown) last.current = now;

  // Keys and touches reach no scene while the panel shows: no PIN typed, no Talk, no sheet behind it. The scenes'
  // own listeners on the window's capture phase still see them first (the dims, the desk's touch), as using the screen.
  useEffect(() => {
    if (!shown) return;
    const stop = (e: Event) => e.stopPropagation();
    document.addEventListener('keydown', stop, true);
    document.addEventListener('click', stop, true);
    return () => {
      document.removeEventListener('keydown', stop, true);
      document.removeEventListener('click', stop, true);
    };
  }, [shown]);

  return (
    <WakeContext.Provider value={last.current}>
      <div className={styles.behind} inert={shown}>
        {children}
      </div>
      {signIn && <SignInPanel signIn={signIn} now={now + offset} />}
    </WakeContext.Provider>
  );
}

/** NEW DEVICE, whose device it is, the letters large, what to do and how long they last (BX-06, verbatim). */
export function SignInPanel({ signIn, now }: { signIn: SignIn; now: number }) {
  const t = useT();
  const WORD = wordCopy(t);

  const title = WORD.signInTitle(signIn.name);
  return (
    <div className={styles.layer}>
      <div className={styles.scrim} />
      <section
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="signin-title"
        aria-describedby="signin-type"
      >
        <p className={styles.kicker}>{WORD.signInKicker}</p>
        <h1 id="signin-title" className={styles.title} style={{ fontSize: signInTitleSize(signIn.name) }}>
          {title}
        </h1>
        <p className={styles.device}>{signIn.device}</p>
        <div className={styles.code}>
          <span className="visually-hidden">{[...signIn.code].join(' ')}</span>
          <span className={styles.letters} aria-hidden="true">
            {groupLetters(signIn.code)}
          </span>
        </div>
        <p id="signin-type" className={styles.type}>
          {WORD.signInType}
        </p>
        <p className={styles.ignore}>{WORD.signInIgnore(minutesLeft(signIn.expiresAt, now))}</p>
      </section>
    </div>
  );
}
