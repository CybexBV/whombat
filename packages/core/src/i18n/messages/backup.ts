import { splitPairs } from './pairs.js';

/** Settings → Backups (`backup/copy.ts`, `backup/categories.ts`); the signed log line stays English. */
export const BACKUP = splitPairs({
  'backup.category.agents': ['The agent', 'De assistent'],
  'backup.category.memories': ['Memories', 'Herinneringen'],
  'backup.category.automations': ['Automations', 'Automatiseringen'],
  'backup.category.connections': ['Connections', 'Koppelingen'],
  'backup.category.skills': ['Skills', 'Vaardigheden'],
  'backup.category.settings': ['Settings', 'Instellingen'],
  'backup.category.vault': ['Your Vault', 'Je kluis'],
  'backup.category.messages': ['Messages', 'Berichten'],
  'backup.category.servers': ['Servers', 'Servers'],
  'backup.category.files': ['Files', 'Bestanden'],
  'backup.category.repositories': ['Repositories on this Whombat', 'Repository’s op deze Whombat'],

  'backup.copy.tab': ['Backups', 'Back-ups'],
  'backup.copy.breadcrumb': ['Settings · Backups', 'Instellingen · Back-ups'],
  'backup.copy.download.title': ['Download a backup', 'Een back-up downloaden'],
  'backup.copy.download.intro': [
    'Choose what goes in the file. You can restore it here or on another Whombat.',
    'Kies wat er in het bestand komt. Je kunt het hier of op een andere Whombat terugzetten.',
  ],
  'backup.copy.download.passwordLabel': ['Password for this file', 'Wachtwoord voor dit bestand'],
  'backup.copy.download.passwordHint': [
    'You need it to restore. Whombat can’t get it back for you.',
    'Je hebt het nodig om terug te zetten. Whombat kan het niet voor je terughalen.',
  ],
  'backup.copy.download.passwordShort': ['Use at least {min} characters.', 'Gebruik minstens {min} tekens.'],
  'backup.copy.download.makeDefault': ['Make these the default', 'Maak dit de standaard'],
  'backup.copy.download.defaultSaved': ['These are the default now.', 'Dit is nu de standaard.'],
  'backup.copy.download.making': ['Making the file…', 'Het bestand wordt gemaakt…'],
  'backup.copy.download.ready': ['Your file is ready.', 'Je bestand is klaar.'],
  'backup.copy.download.kept': ['It’s kept here for {hours} hours.', 'Het wordt hier {hours} uur bewaard.'],
  'backup.copy.download.downloadAgain': ['Download again', 'Opnieuw downloaden'],
  'backup.copy.download.remove': ['Remove', 'Verwijderen'],
  'backup.copy.download.failed': ['The file couldn’t be made.', 'Het bestand kon niet worden gemaakt.'],
  'backup.copy.restore.title': ['Restore from a file', 'Terugzetten uit een bestand'],
  'backup.copy.restore.intro': [
    'Nothing here is deleted. You choose what to bring back.',
    'Hier wordt niets verwijderd. Jij kiest wat er terugkomt.',
  ],
  'backup.copy.restore.choose': ['Choose a file', 'Kies een bestand'],
  'backup.copy.restore.uploading': ['Uploading…', 'Uploaden…'],
  'backup.copy.restore.passwordLabel': ['Password for this file', 'Wachtwoord voor dit bestand'],
  'backup.copy.restore.open': ['Open', 'Openen'],
  'backup.copy.restore.opening': ['Opening the file…', 'Het bestand wordt geopend…'],
  'backup.copy.restore.whenDifferent': ['When something is different', 'Als iets anders is'],
  'backup.copy.restore.restore': ['Restore', 'Terugzetten'],
  'backup.copy.restore.cancel': ['Cancel', 'Annuleren'],
  'backup.copy.restore.restoring': ['Restoring…', 'Terugzetten…'],
  'backup.copy.restore.done': ['Restored', 'Teruggezet'],

  'backup.downloadLabel': ['Download · {size}', 'Downloaden · {size}'],
  'backup.making': ['Making the file{step} · {pct} %', 'Bestand maken{step} · {pct} %'],
  'backup.restoring': ['Restoring{step} · {pct} %', 'Terugzetten{step} · {pct} %'],
  'backup.notice.connections': ['connection sign-ins', 'inloggegevens van koppelingen'],
  'backup.notice.vault': ['your Vault', 'je kluis'],
  'backup.notice.servers': ['the keys to your servers', 'de sleutels van je servers'],
  'backup.notice': [
    'You made a backup file that includes {parts}. Keep it somewhere safe.',
    'Je hebt een back-upbestand gemaakt met {parts}. Bewaar het op een veilige plek.',
  ],
  'backup.and': ['{items} and {last}', '{items} en {last}'],

  'backup.meta.agents.none': ['Nothing set up yet', 'Nog niets ingesteld'],
  'backup.meta.agents': ['Its name, face, model and keys', 'Naam, gezicht, model en sleutels'],
  'backup.meta.memories.none': ['Nothing remembered yet', 'Nog niets onthouden'],
  'backup.meta.memories': [
    'What the agent remembers about you, and its notes',
    'Wat de assistent over je onthoudt, en zijn notities',
  ],
  'backup.meta.automations.none': ['No automations yet', 'Nog geen automatiseringen'],
  'backup.meta.automations': [
    { one: '1 automation · comes back switched off', other: '{count} automations · come back switched off' },
    {
      one: '1 automatisering · komt uitgeschakeld terug',
      other: '{count} automatiseringen · komen uitgeschakeld terug',
    },
  ],
  'backup.meta.connections.none': ['No connections yet', 'Nog geen koppelingen'],
  'backup.meta.connections': [
    { one: '1 connection, with its sign-in', other: '{count} connections, with their sign-ins' },
    { one: '1 koppeling, met de inloggegevens', other: '{count} koppelingen, met hun inloggegevens' },
  ],
  'backup.meta.skills.none': ['No skills yet', 'Nog geen vaardigheden'],
  'backup.meta.skills': [
    { one: '1 skill and whether it is on', other: '{count} skills and which are on' },
    { one: '1 vaardigheid en of die aan staat', other: '{count} vaardigheden en welke aan staan' },
  ],
  'backup.meta.settings': [
    'Your settings, repositories and pinned widgets',
    'Je instellingen, repository’s en vastgezette widgets',
  ],
  'backup.meta.vault.none': ['Nothing in it yet', 'Er staat nog niets in'],
  'backup.meta.vault': [
    { one: 'Your 1 entry', other: 'Your {count} entries' },
    { one: 'Je 1 item', other: 'Je {count} items' },
  ],
  'backup.meta.messages.none': ['No messages yet', 'Nog geen berichten'],
  'backup.meta.messages': [
    { one: '1 message', other: '{count} messages in chats and threads' },
    { one: '1 bericht', other: '{count} berichten in chats en threads' },
  ],
  'backup.meta.servers.none': ['No servers yet', 'Nog geen servers'],
  'backup.meta.servers': [
    {
      one: '1 server, what Whombat may do on it and its history',
      other: '{count} servers, what Whombat may do on them and their history',
    },
    {
      one: '1 server, wat Whombat erop mag doen en de geschiedenis',
      other: '{count} servers, wat Whombat erop mag doen en hun geschiedenis',
    },
  ],
  'backup.meta.files.none': ['No files yet', 'Nog geen bestanden'],
  'backup.meta.files': [
    { one: '1 file you or the agent saved', other: '{count} files you and the agent saved' },
    {
      one: '1 bestand dat jij of de assistent bewaarde',
      other: '{count} bestanden die jij en de assistent bewaarden',
    },
  ],
  'backup.meta.repositories.none': ['No repositories on this Whombat', 'Geen repository’s op deze Whombat'],
  'backup.meta.repositories': [
    { one: '1 repository, with all its history', other: '{count} repositories, with all their history' },
    {
      one: '1 repository, met de hele geschiedenis',
      other: '{count} repository’s, met hun hele geschiedenis',
    },
  ],
});
