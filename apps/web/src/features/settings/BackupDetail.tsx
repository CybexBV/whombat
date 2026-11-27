/**
 * One backup (app backup-options.md AP-6804, backup-v2.md; mock 2-options-and-detail, right), as a dialog over the list:
 * when it was made and why, what it added, its last restore check, what's in it from its own coverage (what comes back,
 * what it left out, what a new Whombat sets up again), “Check this backup now” (`backup.check`; the result lands on the
 * backup) and, below it, “Bring things back from this backup”.
 */
import {
  BACKUP_LOOK_TEXT,
  BACKUP_OPTIONS_TEXT,
  type BackupRow,
  backupContents,
  relativeDay,
} from '@whombat/client/managed';
import { useCheckBackup } from '@whombat/client/react';
import { formatBytes } from '@whombat/core/text';
import type { BackupCheckpoint } from '@whombat/protocol/session';
import { Check, CircleAlert, Minus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Modal, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { currentLocale } from '../../i18n/provider';
import { backupErrorText } from './BackupDestination';
import styles from './BackupOverview.module.css';
import { BringBack } from './BringBack';
import { backupWhen } from './backupOptionsModel';
import tw from './ThisWhombat.module.css';

const D = BACKUP_OPTIONS_TEXT.detail;

export function BackupDetail({
  row,
  checkpoint,
  placeName,
  onClose,
}: {
  row: BackupRow | null;
  checkpoint: BackupCheckpoint | null;
  placeName: string | null;
  onClose: () => void;
}) {
  const { session } = useAppServices();
  const check = useCheckBackup(session);
  const [note, setNote] = useState<string | null>(null);
  // Getting one thing back from this backup (backup-look.md): its own flow, over this page.
  const [bringBack, setBringBack] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new backup starts with nothing said
  useEffect(() => {
    setNote(null);
  }, [row?.id]);
  const cp = checkpoint;
  return (
    <Modal open={row !== null && cp !== null} onOpenChange={(o) => !o && onClose()}>
      {row && cp ? (
        <div className={tw.dialog} data-backup-detail={cp.id}>
          <div className={tw.dialogHead}>
            <ModalTitle className={styles.detailTitle}>{backupWhen(cp.createdAt)}</ModalTitle>
            <p className={tw.dialogLead}>
              {D.meta(
                row.label,
                cp.bytesAdded === null ? null : formatBytes(cp.bytesAdded, currentLocale()),
                placeName,
              )}
            </p>
          </div>
          {cp.check ? (
            <span className={styles.badge} data-tone={cp.check.ok ? 'ok' : 'bad'}>
              {cp.check.ok
                ? `✓ ${D.checked(relativeDay(cp.check.at))}`
                : D.checkFailed(relativeDay(cp.check.at))}
            </span>
          ) : null}
          <div className={styles.field}>
            <SectionLabel as="h3">{D.inIt}</SectionLabel>
            <ul className={styles.inIt}>
              {backupContents(cp).map((item) => (
                <li
                  key={item.key}
                  className={styles.inItRow}
                  data-covered={item.covered || undefined}
                  data-gap={item.gap || undefined}
                  data-line={item.key}
                >
                  <span className={styles.inItMark} aria-hidden="true">
                    <Icon icon={item.gap ? CircleAlert : item.covered ? Check : Minus} size={16} />
                  </span>
                  <span
                    className={tw.srOnly}
                  >{`${item.covered ? D.lines.included : D.lines.notIncluded}: `}</span>
                  <span className={styles.choiceMain}>
                    <span className={styles.inItText}>{item.text}</span>
                    {item.note ? <span className={styles.choiceMeta}>{item.note}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className={styles.detailActions}>
            <Button
              variant="secondary"
              size="lg"
              block
              disabled={check.isPending}
              onClick={() =>
                check.mutate(cp.id, {
                  onSuccess: () => setNote(D.checkQueued),
                  onError: (e) => setNote(backupErrorText(e)),
                })
              }
            >
              {check.isPending ? D.checking : D.checkNow}
            </Button>
            {note ? (
              <p className={styles.hint} role="status">
                {note}
              </p>
            ) : null}
            <Button variant="primary" size="lg" block onClick={() => setBringBack(true)}>
              {BACKUP_LOOK_TEXT.entry}
            </Button>
            <BringBack checkpoint={cp} open={bringBack} onClose={() => setBringBack(false)} />
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
