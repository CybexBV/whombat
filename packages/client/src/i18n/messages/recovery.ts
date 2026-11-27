import { treeCatalogs } from '../tree';

/**
 * Why the recovery kit leaves its backup section out (`managed/recovery.ts`). The kit itself always carries the
 * English words; the Dutch ones are for the screen that says so.
 */
export const KIT_BACKUP_WORDS = treeCatalogs(
  'kitBackup',
  {
    newer_app:
      'This version of the app can’t write all of your Whombat’s backup details into the kit, so the kit leaves them out. Update the app, then save a new kit.',
    incomplete:
      'Your Whombat didn’t hand over everything its backups need, so the kit leaves them out. Save a new kit later.',
    unreachable:
      'Couldn’t get your Whombat’s backup details, so the kit leaves them out. Save a new kit later.',
  },
  {
    newer_app:
      'Deze versie van de app kan niet alle back-upgegevens van je Whombat in het pakket zetten, dus laat het pakket ze weg. Werk de app bij en sla daarna een nieuw pakket op.',
    incomplete:
      'Je Whombat gaf niet alles wat zijn back-ups nodig hebben, dus laat het pakket ze weg. Sla later een nieuw pakket op.',
    unreachable:
      'Kon de back-upgegevens van je Whombat niet ophalen, dus laat het pakket ze weg. Sla later een nieuw pakket op.',
  },
);
