/**
 * The paper copy under Backups' Details (Whombat backup-passkey.md BPK-07; app backup-v2.md): optional, only what opens
 * the backups (`paperCopyText`, never the recovery key), so it can be printed or saved whenever the person likes and
 * asks for nothing old; once printed or saved the Whombat is told (`confirmPaperCopy`), and it counts as a way back. The
 * print is the kit's print sheet with the paper copy's words, which only paper shows.
 */
import { confirmPaperCopy, longDate, paperCopyText } from '@whombat/client/managed';
import { sessionOps } from '@whombat/client/session';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { useAppServices } from '../../app/providers';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { useWebI18n } from '../../i18n/provider';
import { saveBlob } from '../../lib/saveBlob';
import { KitPrintSheet } from '../../managed/KitScreen';
import styles from './BackupOverview.module.css';

/** The paper copy's row: what it is, when one was saved, Print it and Save as a file. A Whombat's only. */
export function PaperCopyRow({ paperAt, onSaved }: { paperAt: string | null; onSaved: () => void }) {
  const { session, managed } = useAppServices();
  const [sheet, setSheet] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useWebI18n();
  if (!managed) return null;
  const name = managed.applianceName ?? managed.applianceId;
  const make = async (way: 'print' | 'file') => {
    setBusy(true);
    setError(null);
    try {
      const material = await sessionOps.backupRecoveryMaterial(session);
      const text = paperCopyText({ applianceName: name, appliancePeerId: managed.appliancePeerId, material });
      if (way === 'print') {
        // The sheet must be in the page before the print dialog takes it.
        flushSync(() => setSheet(text));
        window.print();
      } else
        saveBlob(
          new Blob([text], { type: 'text/plain' }),
          `whombat-backup-details-${managed.applianceId}.txt`,
        );
      await confirmPaperCopy(session, material);
      onSaved();
    } catch {
      setError(t('paper.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.paperRow} data-paper-copy="">
      <span className={styles.needsIcon} aria-hidden="true">
        <Icon icon={FileText} size={18} />
      </span>
      <div className={styles.needsMain}>
        <span className={styles.needsTitle}>{t('paper.title')}</span>
        <span className={styles.needsMeta}>
          {paperAt ? t('paper.saved', { date: longDate(paperAt) }) : t('paper.meta')}
        </span>
        {error ? (
          <span className={styles.needsError} role="alert">
            {error}
          </span>
        ) : null}
      </div>
      <div className={styles.needsActions}>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void make('print')}>
          {busy ? t('paper.making') : t('paper.print')}
        </Button>
        <Button variant="link" size="sm" disabled={busy} onClick={() => void make('file')}>
          {t('paper.file')}
        </Button>
      </div>
      {sheet ? <KitPrintSheet name={name} kitText={sheet} kind="paper" /> : null}
    </div>
  );
}
