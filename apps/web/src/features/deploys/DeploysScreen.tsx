import styles from './Deploys.module.css';
import { DeploysView } from './DeploysView';
import { DEPLOYS_TEXT } from './deploysModel';

/**
 * Deploys (`/deploys`, docs/decisions/work-removal.md AP-850; was the Work view's Deploys tab, web-efficiency.md WE-17):
 * a page of its own in the Inbox's language (1040px page, 36px title, the muted line under it), then the environments
 * board and the history.
 */
export function DeploysScreen({ burrow }: { burrow: string }) {
  return (
    <section className={styles.scroll} data-screen="deploys" aria-labelledby="deploys-title">
      <div className={styles.page}>
        <div className={styles.header}>
          <h1 id="deploys-title" className={styles.title}>
            {DEPLOYS_TEXT.title}
          </h1>
          <p className={styles.subtitle}>{DEPLOYS_TEXT.subtitle}</p>
        </div>
        <DeploysView burrow={burrow} />
      </div>
    </section>
  );
}
