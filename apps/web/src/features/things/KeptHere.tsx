/**
 * “Backups kept here” on a server's or a NAS connection's Summary (Whombat backup-places.md BPL-10; app backup-places.md
 * AP-6710): when the place keeps this Whombat's backups, which Whombat with the space they use and the free space, then
 * the weekly cleanup and how it last went. From `backup.places`; a box from before, or one that keeps nothing here,
 * shows nothing.
 */
import { keptHere } from '@whombat/client/managed';
import { useBackupPlaces } from '@whombat/client/react';
import { BACKUP_PLACE_TEXT } from '@whombat/core/domain';
import { useAppServices } from '../../app/providers';
import { currentLocale } from '../../i18n/provider';
import { useNow } from '../messaging/useRoom';
import { Card, StateCell } from './parts';
import styles from './Things.module.css';

/** `thing`: the page's thing id, `server:<id>` or `connection:<id>`. */
export function BackupsKeptHere({ thing }: { thing: string }) {
  const { session, managed } = useAppServices();
  const places = useBackupPlaces(session);
  const now = useNow(60_000);
  const rows = keptHere(places.data, thing, {
    whombat: managed?.applianceName,
    now,
    locale: currentLocale(),
  });
  if (!rows) return null;
  return (
    <Card title={BACKUP_PLACE_TEXT.keptHere} id="backups-kept-here">
      {rows.map((row) => (
        <div key={row.title} className={styles.row}>
          <div className={styles.rowMain}>
            <b>{row.title}</b>
            {row.meta ? (
              // How the cleanup last went leads with its dot, as a server's other states do.
              <small>{row.dot ? <StateCell tone={row.dot} text={row.meta} /> : row.meta}</small>
            ) : null}
          </div>
        </div>
      ))}
    </Card>
  );
}
