/**
 * “Backups kept here” on a server's or a NAS connection's Summary on the phone (Whombat backup-places.md BPL-10; app
 * backup-places.md AP-6721), the web's card: when the place keeps this Whombat's backups, which Whombat with the space
 * they use and the free space, then the weekly cleanup and how it last went. From `backup.places` over the managed
 * session; without one, on a box from before, or where it keeps nothing, it shows nothing.
 */
import { keptHere } from '@whombat/client/managed';
import { useBackupPlaces } from '@whombat/client/react';
import { backupPlaceText } from '@whombat/core/domain';
import { useNow } from '../../data/BurrowProvider';
import { useI18n } from '../../i18n';
import { useManaged } from '../../managed/context';
import { OneCard, OneRow } from '../../ui/assistant';

/** `thing`: the page's thing id, `server:<id>` or `connection:<id>`. */
export function BackupsKeptHere({ thing }: { thing: string }) {
  const { rawLocale } = useI18n();
  const managed = useManaged();
  const places = useBackupPlaces(managed?.session);
  const now = useNow().getTime();
  const rows = keptHere(places.data, thing, { locale: rawLocale, whombat: managed?.applianceName, now });
  if (!rows) return null;
  return (
    <OneCard label={backupPlaceText(rawLocale).keptHere}>
      {rows.map((row) => (
        <OneRow
          key={row.title}
          title={row.title}
          line={row.meta}
          label={[row.title, row.meta].filter(Boolean).join('. ')}
        />
      ))}
    </OneCard>
  );
}
