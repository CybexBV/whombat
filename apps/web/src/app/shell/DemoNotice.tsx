/**
 * The hosted app's demo (docs/app/decisions/look-around.md): every screen says it is a demo, in the shell's notice slot
 * above the screen, with Leave the demo, which goes back to the sign-in page. Nothing outside the demo.
 */

import { COPY } from '../../i18n/managed';
import { useAppServices } from '../providers';
import styles from './ShellLayout.module.css';

export function DemoNotice() {
  const { demo } = useAppServices();
  if (!demo) return null;
  return (
    <div className={styles.notice} role="status" data-testid="demo-notice">
      <span className={styles.noticeText}>{COPY.lookAround.notice}</span>
      <button type="button" className={`${styles.noticeLink} ${styles.noticeButton}`} onClick={demo.leave}>
        {COPY.lookAround.leave}
      </button>
    </div>
  );
}
