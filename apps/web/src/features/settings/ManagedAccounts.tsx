/**
 * Backup set-up on a managed Whombat (AP-30, AP-260; contracts 0.5 CT-30, 0.22 CT-142). Backup credentials
 * travel only inside the encrypted session, in `secret` operations whose receipts keep no digest of them, and are
 * never shown again. The person's own AI sign-ins moved to Settings → AI (`features/ai`, the same on
 * self-hosted and managed Whombats, docs/decisions/subscriptions.md).
 */

import { BACKUP_KINDS } from '@whombat/client/managed';
import { sessionOps } from '@whombat/client/session';
import { useState } from 'react';
import { useAppServices } from '../../app/providers';
import { Button } from '../../components/Button';
import { ACCOUNTS_TEXT } from '../../i18n/clientWords';
import { BackupDestinationForm, backupErrorText, savedNotes } from './BackupDestination';
import styles from './SettingsScreen.module.css';

export { ACCOUNTS_TEXT };

/**
 * Choose where backups go (every kind the Whombat takes, AP-260), or run a backup now. `open`/`onOpenChange`
 * let This Whombat open the form from elsewhere (an update that waits for a backup).
 */
export function BackupActions({
  unprotected,
  onKit,
  open: openProp,
  onOpenChange,
}: {
  unprotected: boolean;
  /** A Whombat from before the passkey: a new place needs a new recovery kit. Absent: nothing to save. */
  onKit?: (() => void) | undefined;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { session } = useAppServices();
  const kinds = BACKUP_KINDS;
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = (v: boolean) => {
    setOwnOpen(v);
    onOpenChange?.(v);
  };
  const [notes, setNotes] = useState<string[]>([]);
  const [kitNeeded, setKitNeeded] = useState(false);
  const [busy, setBusy] = useState(false);

  const runNow = async () => {
    setBusy(true);
    setNotes([]);
    try {
      await sessionOps.backupRunNow(session);
      setNotes([ACCOUNTS_TEXT.backedUp]);
    } catch (error) {
      setNotes([backupErrorText(error)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        {open ? (
          <BackupDestinationForm
            session={session}
            kinds={kinds}
            onSaved={(result) => {
              setOpen(false);
              setNotes(savedNotes(result));
              setKitNeeded(!!onKit);
            }}
            extraActions={
              <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
                {ACCOUNTS_TEXT.cancel}
              </Button>
            }
          />
        ) : (
          notes.map((note) => (
            <span key={note} className={styles.rowMeta} role="status">
              {note}
            </span>
          ))
        )}
        {kitNeeded && onKit && (
          <span className={styles.rowMeta}>
            {ACCOUNTS_TEXT.newKit}{' '}
            <Button variant="link" size="xs" onClick={onKit}>
              {ACCOUNTS_TEXT.saveKit}
            </Button>
          </span>
        )}
      </div>
      {!open && (
        <>
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            {ACCOUNTS_TEXT.setUp}
          </Button>
          {!unprotected && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void runNow()}>
              {ACCOUNTS_TEXT.runNow}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
