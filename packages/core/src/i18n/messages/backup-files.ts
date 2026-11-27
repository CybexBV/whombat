import { splitPairs } from './pairs.js';

/** A backup file's problems and notes (`backup/errors.ts`, `backup/notes.ts`) and backup places (`domain/backup-places.ts`). */
export const BACKUP_FILES = splitPairs({
  'backupFile.error.password_too_short': [
    'Use a password of at least 10 characters.',
    'Gebruik een wachtwoord van minstens 10 tekens.',
  ],
  'backupFile.error.wrong_password': [
    'That password doesn’t open this file.',
    'Met dat wachtwoord gaat dit bestand niet open.',
  ],
  'backupFile.error.damaged': [
    'This file is damaged or incomplete.',
    'Dit bestand is beschadigd of onvolledig.',
  ],
  'backupFile.error.newer_format': [
    'This file was made by a newer Whombat. Update this one first.',
    'Dit bestand is gemaakt door een nieuwere Whombat. Werk deze eerst bij.',
  ],
  'backupFile.error.not_backup_file': [
    'This isn’t a Whombat backup file.',
    'Dit is geen back-upbestand van Whombat.',
  ],
  'backupFile.error.too_large': [
    'This file is too large for a backup file.',
    'Dit bestand is te groot voor een back-upbestand.',
  ],
  'backupFile.error.no_room': [
    'There isn’t enough room on this Whombat for that. Free up some space and try again.',
    'Daar is niet genoeg ruimte voor op deze Whombat. Maak wat ruimte vrij en probeer het opnieuw.',
  ],
  'backupFile.error.expired': [
    'This backup file isn’t here any more. Files are kept for 24 hours, so make a new one.',
    'Dit back-upbestand is er niet meer. Bestanden blijven 24 uur bewaard, dus maak een nieuw.',
  ],
  'backupFile.error.upload_expired': [
    'That upload isn’t here any more. Upload the file again.',
    'Die upload is er niet meer. Upload het bestand opnieuw.',
  ],
  'backupFile.error.upload_incomplete': [
    'The file hasn’t finished uploading yet.',
    'Het bestand is nog niet klaar met uploaden.',
  ],
  'backupFile.error.upload_mismatch': [
    'The upload doesn’t match the file. Upload it again.',
    'De upload past niet bij het bestand. Upload het opnieuw.',
  ],
  'backupFile.error.nothing_chosen': ['Choose at least one thing.', 'Kies minstens één ding.'],
  'backupFile.error.not_in_file': ['That isn’t in this file.', 'Dat zit niet in dit bestand.'],
  'backupFile.error.busy': [
    'A backup file is being made already. Wait for it to finish.',
    'Er wordt al een back-upbestand gemaakt. Wacht tot het klaar is.',
  ],
  'backupFile.error.restore_running': [
    'A restore is running already. Wait for it to finish.',
    'Er wordt al iets teruggezet. Wacht tot het klaar is.',
  ],
  'backupFile.error.too_many': [
    'There are already too many backup files here. Remove one first.',
    'Er staan hier al te veel back-upbestanden. Verwijder er eerst een.',
  ],
  'backupFile.error.people_only': [
    'Only you can make or restore backup files, not the agent.',
    'Alleen jij kunt back-upbestanden maken of terugzetten, niet de assistent.',
  ],
  'backupFile.error.failed': [
    'Something went wrong while making the file. Try again.',
    'Er ging iets mis bij het maken van het bestand. Probeer het opnieuw.',
  ],
  'backupFile.error.restore_failed': [
    'The restore stopped part-way. What came back stays, and trying again brings back the rest.',
    'Het terugzetten stopte halverwege. Wat terugkwam blijft, en opnieuw proberen haalt de rest terug.',
  ],

  'backupNote.unreadable': [
    {
      one: '1 thing in the file couldn’t be read, so it’s left out.',
      other: '{count} things in the file couldn’t be read, so they’re left out.',
    },
    {
      one: '1 ding in het bestand kon niet worden gelezen, dus dat wordt weggelaten.',
      other: '{count} dingen in het bestand konden niet worden gelezen, dus die worden weggelaten.',
    },
  ],
  'backupNote.missing_reference': [
    {
      one: '1 thing points to something that isn’t here, so that part is left out.',
      other: '{count} things point to something that isn’t here, so that part is left out.',
    },
    {
      one: '1 ding verwijst naar iets wat hier niet is, dus dat deel wordt weggelaten.',
      other: '{count} dingen verwijzen naar iets wat hier niet is, dus dat deel wordt weggelaten.',
    },
  ],
  'backupNote.drafts': [
    {
      one: '1 automation no longer fits this Whombat, so it comes back as a draft.',
      other: '{count} automations no longer fit this Whombat, so they come back as drafts.',
    },
    {
      one: '1 automatisering past niet meer bij deze Whombat, dus die komt terug als concept.',
      other: '{count} automatiseringen passen niet meer bij deze Whombat, dus die komen terug als concept.',
    },
  ],
  'backupNote.schedules_paused': [
    { one: '1 schedule comes back paused.', other: '{count} schedules come back paused.' },
    { one: '1 schema komt gepauzeerd terug.', other: '{count} schema’s komen gepauzeerd terug.' },
  ],
  'backupNote.bundled_missing': [
    {
      one: '1 skill comes with another version of Whombat, so it’s left out.',
      other: '{count} skills come with another version of Whombat, so they’re left out.',
    },
    {
      one: '1 vaardigheid hoort bij een andere versie van Whombat, dus die wordt weggelaten.',
      other: '{count} vaardigheden horen bij een andere versie van Whombat, dus die worden weggelaten.',
    },
  ],
  'backupNote.unknown_authors': [
    {
      one: 'Messages from 1 person who isn’t here keep their name.',
      other: 'Messages from {count} people who aren’t here keep their names.',
    },
    {
      one: 'Berichten van 1 persoon die hier niet is, houden hun naam.',
      other: 'Berichten van {count} mensen die hier niet zijn, houden hun naam.',
    },
  ],
  'backupNote.too_large': [
    {
      one: '1 thing is too large to restore here, so it’s left out.',
      other: '{count} things are too large to restore here, so they’re left out.',
    },
    {
      one: '1 ding is te groot om hier terug te zetten, dus dat wordt weggelaten.',
      other: '{count} dingen zijn te groot om hier terug te zetten, dus die worden weggelaten.',
    },
  ],
  'backupNote.model_unavailable': [
    'The agent’s model isn’t offered here, so it uses this Whombat’s default.',
    'Het model van de assistent wordt hier niet aangeboden, dus gebruikt hij de standaard van deze Whombat.',
  ],
  'backupNote.sign_in_left_out': [
    {
      one: '1 sign-in couldn’t go in the file, so it needs you to sign in again.',
      other: '{count} sign-ins couldn’t go in the file, so they need you to sign in again.',
    },
    {
      one: '1 inlog kon niet in het bestand, dus daar moet je opnieuw inloggen.',
      other: '{count} inlogs konden niet in het bestand, dus daar moet je opnieuw inloggen.',
    },
  ],
  'backupNote.files_left_out': [
    {
      one: '1 message comes back without its files, because Files wasn’t in the backup.',
      other: '{count} messages come back without their files, because Files wasn’t in the backup.',
    },
    {
      one: '1 bericht komt terug zonder bestanden, omdat Bestanden niet in de back-up zat.',
      other: '{count} berichten komen terug zonder bestanden, omdat Bestanden niet in de back-up zat.',
    },
  ],

  'backupPlace.heading': ['On your network', 'Op je netwerk'],
  'backupPlace.kind.unraid': ['Unraid', 'Unraid'],
  'backupPlace.kind.linux': ['Server', 'Server'],
  'backupPlace.kind.truenas': ['TrueNAS', 'TrueNAS'],
  'backupPlace.kind.synology': ['Synology', 'Synology'],
  'backupPlace.kind.qnap': ['QNAP', 'QNAP'],
  'backupPlace.state.in_use': ['Keeps your backups', 'Bewaart je back-ups'],
  'backupPlace.state.ready': ['Ready', 'Klaar'],
  'backupPlace.state.connect_first': ['Connect it first', 'Koppel het eerst'],
  'backupPlace.state.manage_first': ['Turn on Manage first', 'Zet eerst Beheren aan'],
  'backupPlace.state.unsupported': ['Can’t keep backups', 'Kan geen back-ups bewaren'],
  'backupPlace.use': ['Back up here', 'Hier back-uppen'],
  'backupPlace.byHand': ['Set it up by hand', 'Zelf instellen'],
  'backupPlace.check': ['Check it', 'Controleren'],
  'backupPlace.moveTitle': ['Back up to {name} instead?', 'Voortaan back-uppen naar {name}?'],
  'backupPlace.moveBody': [
    'Backups made so far stay on {from}. New backups go here from now on.',
    'Back-ups die al gemaakt zijn, blijven op {from}. Nieuwe back-ups komen vanaf nu hier.',
  ],
  'backupPlace.appendOnly': ['Deleting is blocked', 'Verwijderen is geblokkeerd'],
  'backupPlace.cleanup': [
    'Backups older than {days} days are cleared',
    'Back-ups ouder dan {days} dagen worden opgeruimd',
  ],
  'backupPlace.noCleanup': [
    'Old backups aren’t cleared on their own here',
    'Oude back-ups worden hier niet vanzelf opgeruimd',
  ],
  'backupPlace.keptHere': ['Backups kept here', 'Back-ups die hier staan'],
  'backupPlace.reasons.connect': [
    'Connect {said} with Manage, then Whombat can keep its backups there.',
    'Koppel {said} met Beheren, dan kan Whombat er zijn back-ups bewaren.',
  ],
  'backupPlace.reasons.manage': [
    'Whombat can only look at it now. Turn on Manage so it can set up a place for backups.',
    'Whombat kan er nu alleen naar kijken. Zet Beheren aan, dan kan het er een plek voor back-ups maken.',
  ],
  'backupPlace.reasons.noDocker': [
    'It needs Docker to keep backups, and Docker isn’t running there.',
    'Het heeft Docker nodig om back-ups te bewaren, en Docker draait daar niet.',
  ],
  'backupPlace.reasons.arrayStopped': [
    'Its array is stopped. Start it, then try again.',
    'De array is gestopt. Start hem en probeer het opnieuw.',
  ],
  'backupPlace.reasons.self': [
    'This Whombat runs on it, so its backups would be lost with it.',
    'Deze Whombat draait erop, dus de back-ups zouden er samen mee verloren gaan.',
  ],
  'backupPlace.reasons.synologyOld': [
    'It needs DSM 7.2 or later with Container Manager. Update DSM, then try again.',
    'Het heeft DSM 7.2 of nieuwer met Container Manager nodig. Werk DSM bij en probeer het opnieuw.',
  ],
  'backupPlace.reasons.synologyNoContainerManager': [
    'Container Manager isn’t installed on it. Install it from Package Center, then try again.',
    'Container Manager is er niet op geïnstalleerd. Installeer het via Package Center en probeer het opnieuw.',
  ],
  'backupPlace.reasons.trueNasOld': [
    'It needs TrueNAS 24.10 or later. Update TrueNAS, then try again.',
    'Het heeft TrueNAS 24.10 of nieuwer nodig. Werk TrueNAS bij en probeer het opnieuw.',
  ],
  'backupPlace.reasons.trueNasNoPool': [
    'Apps aren’t set up on it yet. Choose a pool for apps in TrueNAS, then try again.',
    'Apps zijn er nog niet ingesteld. Kies in TrueNAS een pool voor apps en probeer het opnieuw.',
  ],
  'backupPlace.reasons.trueNasAppsStopped': [
    'Apps aren’t running on it. Start them in TrueNAS, then try again.',
    'Apps draaien er niet. Start ze in TrueNAS en probeer het opnieuw.',
  ],
  'backupPlace.reasons.qnapNoContainerStation': [
    'It needs Container Station 3. Install or update it from the App Center and open it once, then try again.',
    'Het heeft Container Station 3 nodig. Installeer of werk het bij via het App Center, open het één keer en probeer het opnieuw.',
  ],
  'backupPlace.reasons.dockerDown': [
    'Docker is stopped there. Start it, then try again.',
    'Docker is daar gestopt. Start het en probeer het opnieuw.',
  ],
  'backupPlace.reasons.nfsOff': [
    'NFS is off on it. Turn it on in its settings, then try again.',
    'NFS staat er uit. Zet het aan in de instellingen en probeer het opnieuw.',
  ],
  'backupPlace.reasons.helperOld': [
    'Whombat’s helper on it needs an update first.',
    'Whombats helper daarop moet eerst worden bijgewerkt.',
  ],
  'backupPlace.reasons.notYet': [
    'Whombat can’t set it up on its own yet. You can set it up by hand.',
    'Whombat kan het nog niet zelf instellen. Je kunt het zelf instellen.',
  ],
  'backupPlace.reasons.other': ['It can’t keep backups right now.', 'Het kan nu geen back-ups bewaren.'],
  'backupPlace.reasons.noAddress': [
    '{place} has no address on your home network that Whombat can use.',
    '{place} heeft geen adres op je thuisnetwerk dat Whombat kan gebruiken.',
  ],
  'backupPlace.refused.gone': [
    'That place isn’t on your network any more.',
    'Die plek staat niet meer op je netwerk.',
  ],
  'backupPlace.refused.move': [
    'Backups go to {from} now. Moving them is yours to decide, in Settings → This Whombat → Backups.',
    'Back-ups gaan nu naar {from}. Of ze verhuizen, beslis jij in Instellingen → Deze Whombat → Back-ups.',
  ],
  'backupPlace.refused.inUse': [
    '{place} keeps your backups now, so Whombat leaves it as it is.',
    '{place} bewaart nu je back-ups, dus Whombat laat het zoals het is.',
  ],
  'backupPlace.refused.byHandOnly': [
    'Whombat can only set this place up by hand.',
    'Whombat kan deze plek alleen met de hand instellen.',
  ],
  'backupPlace.refused.checkExpired': [
    'That setup is more than a day old. Set it up by hand again to get a new one.',
    'Die instelling is meer dan een dag oud. Stel het opnieuw zelf in om een nieuwe te krijgen.',
  ],
  'backupPlace.refused.unknown': [
    'Whombat can’t tell where your backups go right now, so it leaves them as they are. Try again in a minute.',
    'Whombat kan nu niet zien waar je back-ups heen gaan, dus het laat ze zoals ze zijn. Probeer het over een minuut opnieuw.',
  ],
  'backupPlace.ownDisk': [
    'Your backups are on this Whombat’s own disk. Keep them on {place} instead?',
    'Je back-ups staan op de eigen schijf van deze Whombat. Voortaan op {place} bewaren?',
  ],
  'backupPlace.failed.install': [
    'Whombat couldn’t set up the backup app on {place}.',
    'Whombat kon de back-up-app op {place} niet instellen.',
  ],
  'backupPlace.failed.destination': [
    'The backup app on {place} runs, but this Whombat couldn’t start backing up to it.',
    'De back-up-app op {place} draait, maar deze Whombat kon er niet mee beginnen te back-uppen.',
  ],
  'backupPlace.failed.cleanup': [
    'Backups go to {place} now, but clearing old ones there isn’t set up yet.',
    'Back-ups gaan nu naar {place}, maar het opruimen van oude is daar nog niet ingesteld.',
  ],
  'backupPlace.location.pool': ['the pool {name}', 'de pool {name}'],
  'backupPlace.location.sharedFolder': ['the shared folder {name}', 'de gedeelde map {name}'],
  'backupPlace.location.share': ['the share {name}', 'de share {name}'],
  'backupPlace.location.shared': [
    'Shared on your network: anyone who can open it could delete the backups.',
    'Gedeeld op je netwerk: iedereen die het kan openen, kan de back-ups verwijderen.',
  ],
  'backupPlace.location.holdsOther': [
    'Unraid keeps other things in it (apps, virtual machines or disk images).',
    'Unraid bewaart er ook andere dingen in (apps, virtuele machines of schijfkopieën).',
  ],
  'backupPlace.location.onPool': [
    'Kept on the {pool} pool, not on the array.',
    'Bewaard op de pool {pool}, niet op de array.',
  ],
  'backupPlace.location.gone': [
    'That place on it isn’t there any more. Choose another.',
    'Die plek bestaat daar niet meer. Kies een andere.',
  ],
  'backupPlace.location.newBackups': [
    'Backups made so far stay in {from}; new ones start in the new place.',
    'Back-ups die al gemaakt zijn, blijven in {from}; nieuwe beginnen op de nieuwe plek.',
  ],
  'backupPlace.setSay': [
    'This Whombat now backs up to {place}{where}. {first}',
    'Deze Whombat maakt nu back-ups op {place}{where}. {first}',
  ],
  'backupPlace.setSay.where': [', in {where}', ', in {where}'],
  'backupPlace.setSay.running': ['The first backup is running now.', 'De eerste back-up loopt nu.'],
  'backupPlace.setSay.soon': [
    'The first backup starts within the next 15 minutes.',
    'De eerste back-up begint binnen 15 minuten.',
  ],
  'backupPlace.watch.cleanupName': ['Old backups not being cleared', 'Oude back-ups worden niet opgeruimd'],
  'backupPlace.watch.cleanupTitle': [
    'Old backups aren’t being cleared on {place}',
    'Oude back-ups worden niet opgeruimd op {place}',
  ],
  'backupPlace.watch.cleanupDetail': [
    'Whombat can set the clearing up again.',
    'Whombat kan het opruimen opnieuw instellen.',
  ],
  'backupPlace.watch.spaceName': ['Room for backups running low', 'Weinig ruimte voor back-ups'],
  'backupPlace.watch.spaceTitle': [
    '{place} is running out of space for backups',
    '{place} heeft bijna geen ruimte meer voor back-ups',
  ],
  'backupPlace.watch.spaceDetail': ['{freeGb} GB left.', 'Nog {freeGb} GB over.'],
});
