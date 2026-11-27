import { LegalBlocks } from '../../legal/LegalPage';
import legal from '../../legal/LegalPage.module.css';
import { WHATS_NEW_MARKDOWN } from './changelog';
import styles from './WhatsNew.module.css';

/**
 * What's new (`/settings/whats-new`): what changed in Whombat lately, in plain words, newest first. Opened from This Whombat →
 * About and from the notice after an update. The hosted app also serves it without signing in (ManagedRoot), which is
 * where the phone opens it.
 */
export function WhatsNewScreen() {
  return (
    <section className={styles.scroll} data-screen="whats-new" aria-label="What’s new">
      <div className={legal.column}>
        <LegalBlocks text={WHATS_NEW_MARKDOWN} />
      </div>
    </section>
  );
}
