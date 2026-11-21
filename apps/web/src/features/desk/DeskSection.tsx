/**
 * The screen's unlock request as This Whombat's NEEDS YOU row (`DeskUnlockRow`): a tap on the unlock push opens This
 * Whombat. The screen's settings have their own tab (Settings → Screen).
 */
import { DESK_TEXT, type DeskUnlockRequest } from '@whombat/client/desk';
import { Button } from '../../components/Button';
import { StatusDot } from '../../components/StatusDot';
import styles from '../settings/SettingsScreen.module.css';
import { useDeskUnlockAnswer } from './DeskUnlock';
import type { DeskHere } from './useDeskHere';

const T = DESK_TEXT;

/** The unlock request as This Whombat's first NEEDS YOU row: its Unlock is the card's primary button. */
export function DeskUnlockRow({ here, request }: { here: DeskHere; request: DeskUnlockRequest }) {
  const { busy, answer } = useDeskUnlockAnswer(here, request);
  return (
    <div className={styles.row} data-desk-unlock="">
      <StatusDot tone="warn" size={8} label={null} />
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{T.unlock.title}</span>
        <span className={styles.rowMeta}>{T.unlock.meta(request.secondsLeft)}</span>
      </span>
      <Button variant="primary" size="sm" disabled={busy} onClick={() => void answer(true)}>
        {T.unlock.unlock}
      </Button>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void answer(false)}>
        {T.unlock.no}
      </Button>
    </div>
  );
}
