import { useState } from 'react';
import { Button } from '../../../components/Button';
import styles from './AgentTab.module.css';

/**
 * “Unsaved changes · Discard · Save” (AP-384): sticky at the bottom of the page while the tab has changes. A save that
 * didn't go through (blocked, waiting for approval) leaves its notice above it and keeps the changes.
 */
export function SaveBar({
  dirty,
  saving,
  notice,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  notice: string | null;
  /** Resolves when the step is done; a failure the tab didn't handle says “That didn’t save. Try again.” */
  onSave: () => Promise<unknown>;
  onDiscard: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const shown = notice ?? (failed ? 'That didn’t save. Try again.' : null);
  return (
    <>
      {shown ? (
        <p className={styles.notice} aria-live="polite">
          {shown}
        </p>
      ) : null}
      {dirty ? (
        <section className={styles.saveBar} aria-label="Unsaved changes">
          <span className={styles.saveText}>Unsaved changes</span>
          <Button
            variant="secondary"
            size="md"
            onClick={() => {
              setFailed(false);
              onDiscard();
            }}
            disabled={saving}
          >
            Discard
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              setFailed(false);
              onSave().catch(() => setFailed(true));
            }}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </section>
      ) : null}
    </>
  );
}
