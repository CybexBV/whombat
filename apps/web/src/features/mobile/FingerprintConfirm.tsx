import { Monitor, Smartphone } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { SectionLabel } from '../../components/SectionLabel';
import { MOBILE_TEXT } from './copy';
import styles from './mobile.module.css';

export interface FingerprintConfirmProps {
  /** The warning-coloured label over the card (“YOUR PHONE IS ASKING TO COME IN”). */
  label: string;
  /** “Let Pixel 9 in?” */
  title: string;
  /** What kind of device it is and what letting it in gives it. */
  meta: ReactNode;
  /** The words before the fingerprint (“Check that your phone shows”). */
  fingerprintLine: string;
  fingerprint: string;
  /** What to do when the two don't match. */
  hint: string;
  /** Why the last answer didn't go through, if it didn't. */
  note: string | null;
  busy: boolean;
  approveLabel: string;
  declineLabel: string;
  onApprove: () => void;
  onDecline: () => void;
  /** A third, quieter way out (Devices' “Use another code”). */
  more?: ReactNode;
  /** A phone (the Mobile app page) or another device (Settings → Devices). */
  device?: 'phone' | 'other';
  /** Inside Settings' Devices card: smaller buttons and no fixed height. */
  compact?: boolean;
  testId: string;
  fingerprintTestId: string;
  platformTestId?: string;
  platform?: string;
}

/**
 * Letting a device in after comparing its fingerprint: the one design for this decision, on the Mobile app page and in
 * Settings → Devices. Focus moves to the question so a keyboard or screen reader lands on it; the heading isn't a
 * control, so it shows no focus ring.
 */
export function FingerprintConfirm({
  label,
  title,
  meta,
  fingerprintLine,
  fingerprint,
  hint,
  note,
  busy,
  approveLabel,
  declineLabel,
  onApprove,
  onDecline,
  more,
  device = 'phone',
  compact = false,
  testId,
  fingerprintTestId,
  platformTestId,
  platform,
}: FingerprintConfirmProps) {
  // In Settings the card opens under a form that may sit low on a phone's screen: bring it into view.
  const heading = useFocusOnMount<HTMLHeadingElement>(compact);
  const size = compact ? 'lg' : 'xl';
  return (
    <div
      className={cx(
        styles.card,
        styles.confirm,
        !compact && styles.signInArea,
        compact && styles.confirmCompact,
      )}
      data-testid={testId}
    >
      <SectionLabel tone="warn">{label}</SectionLabel>
      <div className={styles.confirmHead}>
        <span className={styles.appTile} aria-hidden="true">
          <Icon icon={device === 'phone' ? Smartphone : Monitor} size={22} />
        </span>
        <div className={styles.confirmText}>
          <h3 className={styles.confirmTitle} ref={heading} tabIndex={-1}>
            {title}
          </h3>
          <p className={styles.confirmMeta}>
            {platform !== undefined && (
              <>
                <span data-testid={platformTestId}>{platform}</span>
                <span aria-hidden="true"> · </span>
                <span className={styles.srOnly}>. </span>
              </>
            )}
            {meta}
          </p>
        </div>
      </div>
      <div className={styles.fingerprint}>
        <SectionLabel>{MOBILE_TEXT.signIn.fingerprintLabel}</SectionLabel>
        <p className={styles.fingerprintLine}>
          <span>{fingerprintLine} </span>
          <span className={styles.fingerprintValue} data-testid={fingerprintTestId}>
            {fingerprint}
          </span>
        </p>
        <span className={styles.fingerprintHint}>{hint}</span>
      </div>
      {note && (
        <p className={styles.confirmNote} role="status">
          {note}
        </p>
      )}
      <div className={cx(styles.actions, styles.confirmActions)}>
        <Button variant="primary" size={size} disabled={busy} onClick={onApprove}>
          {approveLabel}
        </Button>
        <Button variant="secondary" size={size} disabled={busy} onClick={onDecline}>
          {declineLabel}
        </Button>
        {more}
      </div>
    </div>
  );
}

/** Moves focus to a heading that replaces what had it (the confirmation, the success), for keyboards and readers. */
export function useFocusOnMount<T extends HTMLElement>(scroll = false) {
  const ref = useRef<T>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the heading appears
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    if (scroll) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  return ref;
}
