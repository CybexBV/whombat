/**
 * Quiet hours (mockup 4, DK-09), the power cut (DK-10) and pairing the screen (DK-02). Nobody there by day is the
 * glance, dimmed (DK-97): `Desk`.
 */

import { useT } from '../i18n/react';
import { countdown } from '../lib/console';
import type { DeskGlance, DeskPaired, DeskPower } from '../lib/desk';
import { clockText, deskCopy, deskWordsCopy } from '../lib/deskCopy';
import { nightLine } from '../lib/deskScene';
import styles from './desk.module.css';
import { ClockText, PowerBanner, TopBar } from './parts';

/** The dim clock: the time, one line, and the banner when the power is out. Nothing wakes it but a touch. */
export function Night({
  paired,
  glance,
  power,
  now,
}: {
  paired: DeskPaired;
  glance: DeskGlance | null;
  power: DeskPower | null;
  now: number;
}) {
  const words = deskWordsCopy(useT());
  const line = nightLine(glance) === 'fine' ? words.status.allFine : words.status.somethingNeedsYou;
  return (
    <div className={styles.night}>
      <div className={styles.nightClock}>
        <ClockText text={clockText(now, paired.timeZone)} />
      </div>
      <p className={styles.nightLine}>{line}</p>
      {power?.source === 'battery' && (
        <PowerBanner power={power} assistant={paired.assistant.name} timeZone={paired.timeZone} />
      )}
    </div>
  );
}

/** While an owner pairs the screen in Settings: the four letters, big, for ten minutes (DK-02). */
export function Pairing({
  code,
  expiresAt,
  burrow,
  power,
  now,
}: {
  code: string;
  expiresAt: string;
  burrow: string | null;
  power: DeskPower | null;
  now: number;
}) {
  const t = useT();
  const DESK_WORDS = deskWordsCopy(t);
  const DESK = deskCopy(t);

  return (
    <div className={styles.pairing}>
      <TopBar burrow={burrow} power={power} />
      <main className={styles.pairMain}>
        <h1 className={styles.pairTitle}>{DESK_WORDS.pairThisScreen}</h1>
        <p className={styles.pairHow}>{DESK_WORDS.pairHint}</p>
        <div className={styles.pairCode}>
          <span className="visually-hidden">{[...code].join(' ')}</span>
          <span className={styles.pairLetters} aria-hidden="true">
            {code}
          </span>
        </div>
        <p className={styles.pairFor}>
          {DESK.pairFor} <b>{countdown(expiresAt, now)}</b>.
        </p>
      </main>
    </div>
  );
}
