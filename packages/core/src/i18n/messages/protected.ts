import { splitPairs } from './pairs.js';

/** What's protected and restore tests of Proxmox machines (`domain/protected.ts`). */
export const PROTECTED_MESSAGES = splitPairs({
  'protected.title': ['What’s protected', 'Wat is beschermd'],
  'protected.intro': [
    'Everything that holds data, and where a copy of it is kept.',
    'Alles wat gegevens bevat, en waar er een kopie van is.',
  ],
  'protected.link': ['What’s protected', 'Wat is beschermd'],
  'protected.linkHint': [
    'If a machine breaks, what would you lose?',
    'Als een machine kapotgaat, wat raak je dan kwijt?',
  ],
  'protected.empty': ['Nothing to show yet.', 'Nog niets te zien.'],
  'protected.loading': ['Reading what’s protected', 'Lezen wat beschermd is'],
  'protected.loadFailed': [
    'This page couldn’t load. Try again.',
    'Deze pagina kon niet laden. Probeer het opnieuw.',
  ],
  'protected.failed': ['That didn’t work. Try again.', 'Dat lukte niet. Probeer het opnieuw.'],
  'protected.unread': ['Whombat couldn’t read {names} just now.', 'Whombat kon {names} nu niet lezen.'],
  'protected.askButton': ['Ask {assistant} to set up backups', 'Vraag {assistant} om back-ups in te stellen'],

  'protected.group.copied': ['Copied to another machine', 'Gekopieerd naar een andere machine'],
  'protected.group.local': ['Only on the same machine', 'Alleen op dezelfde machine'],
  'protected.group.none': ['Not backed up that Whombat can see', 'Geen back-up die Whombat kan zien'],
  'protected.groupNote.copied': [
    'If one of these breaks, a copy is safe somewhere else.',
    'Als een hiervan kapotgaat, staat er ergens anders een kopie.',
  ],
  'protected.groupNote.local': [
    'The copy is on the same machine: if that machine breaks, the copy goes with it.',
    'De kopie staat op dezelfde machine: gaat die kapot, dan is de kopie ook weg.',
  ],
  'protected.groupNote.none': [
    'If one of these breaks, what’s on it is gone, unless it’s backed up somewhere Whombat can’t see.',
    'Als een hiervan kapotgaat, is wat erop staat weg, tenzij er een back-up is die Whombat niet kan zien.',
  ],

  'protected.count.copied': [
    { one: '{count} copied', other: '{count} copied' },
    { one: '{count} gekopieerd', other: '{count} gekopieerd' },
  ],
  'protected.count.local': [
    { one: '{count} only on its machine', other: '{count} only on their machine' },
    { one: '{count} alleen op de eigen machine', other: '{count} alleen op de eigen machine' },
  ],
  'protected.count.none': [
    { one: '{count} not backed up', other: '{count} not backed up' },
    { one: '{count} zonder back-up', other: '{count} zonder back-up' },
  ],

  'protected.line.via': ['With {machine}', 'Met {machine}'],
  'protected.line.copy': ['Last copy {ago}', 'Laatste kopie {ago}'],
  'protected.line.backup': ['Last backup {ago}', 'Laatste back-up {ago}'],
  'protected.line.planned': [
    'In a backup plan, no copy seen yet',
    'In een back-upplan, nog geen kopie gezien',
  ],
  'protected.line.where': ['on {where}', 'op {where}'],
  'protected.line.ownDisks': ['on its own disks', 'op de eigen schijven'],
  'protected.line.failed': ['Last backup failed {ago}', 'Laatste back-up mislukt {ago}'],
  'protected.line.before': ['the one before is from {ago}', 'de vorige is van {ago}'],
  'protected.line.noneWorked': ['none has worked yet', 'er is er nog geen gelukt'],
  'protected.line.nothing': ['Nothing backs it up', 'Er wordt geen back-up van gemaakt'],
  'protected.line.unseen': ['Whombat can’t see its backups', 'Whombat kan de back-ups niet zien'],
  'protected.line.unseenServer': [
    'Whombat can’t see a backup of the server itself',
    'Whombat kan geen back-up van de server zelf zien',
  ],
  'protected.line.offsite': ['Off-site ({name}) · last copy {ago}', 'Elders ({name}) · laatste kopie {ago}'],
  'protected.line.offsiteNone': ['Off-site ({name}) · no copy yet', 'Elders ({name}) · nog geen kopie'],

  'protected.when.on': ['on {day}', 'op {day}'],
  'protected.test.label': ['Restore test', 'Hersteltest'],
  'protected.test.line': ['Restore test: {verdict}', 'Hersteltest: {verdict}'],
  'protected.test.worked': [
    { one: 'worked {when} (took {count} min)', other: 'worked {when} (took {count} min)' },
    { one: 'gelukt {when} (duurde {count} min)', other: 'gelukt {when} (duurde {count} min)' },
  ],
  'protected.test.started': [
    { one: 'started {when} (took {count} min)', other: 'started {when} (took {count} min)' },
    { one: 'gestart {when} (duurde {count} min)', other: 'gestart {when} (duurde {count} min)' },
  ],
  'protected.test.failed': ['didn’t work {when}: {why}', 'werkte niet {when}: {why}'],
  'protected.test.skipped': ['couldn’t run {when}: {why}', 'kon niet {when}: {why}'],

  'protected.reason.restore_failed': [
    'Proxmox couldn’t restore the backup',
    'Proxmox kon de back-up niet terugzetten',
  ],
  'protected.reason.start_failed': ['the copy didn’t start', 'de kopie startte niet'],
  'protected.reason.stopped_by_itself': ['the copy stopped by itself', 'de kopie stopte vanzelf'],
  'protected.reason.no_boot': [
    'the copy started but never finished starting up',
    'de kopie startte maar kwam nooit helemaal op',
  ],
  'protected.reason.too_long': ['it took over an hour', 'het duurde meer dan een uur'],
  'protected.reason.no_backup': ['there’s no backup of it to test', 'er is geen back-up om te testen'],
  'protected.reason.no_space': ['there wasn’t enough free space', 'er was niet genoeg vrije ruimte'],
  'protected.reason.no_memory': [
    'the server didn’t have enough free memory',
    'de server had niet genoeg vrij geheugen',
  ],
  'protected.reason.host_parts': [
    'it uses parts of the server itself, so testing it could touch the real machine',
    'hij gebruikt onderdelen van de server zelf, dus testen kan de echte machine raken',
  ],
  'protected.reason.network_kept': [
    'Proxmox wouldn’t disconnect the copy’s network',
    'Proxmox wilde het netwerk van de kopie niet loskoppelen',
  ],
  'protected.reason.manage_off': ['Manage is off for this server', 'Beheren staat uit voor deze server'],
  'protected.reason.unreachable': [
    'Whombat couldn’t reach the server',
    'Whombat kon de server niet bereiken',
  ],
  'protected.reason.other_node': [
    'it runs on another server of the cluster',
    'hij draait op een andere server van het cluster',
  ],
  'protected.reason.no_id': ['no free number for the copy', 'geen vrij nummer voor de kopie'],
  'protected.reason.refused': ['Proxmox refused it', 'Proxmox weigerde het'],

  'protected.problem.startTitle': [
    'The backup of {name} didn’t start when Whombat tried it',
    'De back-up van {name} startte niet toen Whombat hem probeerde',
  ],
  'protected.problem.restoreTitle': [
    'The backup of {name} couldn’t be restored when Whombat tried it',
    'De back-up van {name} kon niet worden teruggezet toen Whombat hem probeerde',
  ],
  'protected.problem.detail': [
    'Whombat restored a copy with its network off to check it: {why}. The real machine wasn’t touched.',
    'Whombat zette een kopie terug zonder netwerk om hem te controleren: {why}. De echte machine is niet aangeraakt.',
  ],

  'protected.ask.on': ['{name} on {on}', '{name} op {on}'],
  'protected.ask.local': [
    'The only backup of {name} is on the same machine. Can you help me keep a copy somewhere else?',
    'De enige back-up van {name} staat op dezelfde machine. Kun je me helpen ergens anders een kopie te bewaren?',
  ],
  'protected.ask.none': [
    'Whombat doesn’t see a backup of {name}. Can you help me set one up?',
    'Whombat ziet geen back-up van {name}. Kun je me helpen er een in te stellen?',
  ],

  'protected.tests.title': ['Restore tests', 'Hersteltests'],
  'protected.tests.intro': [
    'Once a week in the quiet hours, Whombat restores one machine’s newest backup as a copy with its network off, checks that it starts, then deletes the copy.',
    'Eens per week in de stille uren zet Whombat de nieuwste back-up van één machine terug als kopie zonder netwerk, kijkt of die start en verwijdert de kopie weer.',
  ],
  'protected.tests.switch': ['Test my backups', 'Test mijn back-ups'],
  'protected.tests.all': ['All machines', 'Alle machines'],
  'protected.tests.some': [
    { one: '{count} machine', other: '{count} machines' },
    { one: '{count} machine', other: '{count} machines' },
  ],
  'protected.tests.choose': ['Which machines', 'Welke machines'],
  'protected.tests.run': ['Test one now', 'Test er nu een'],
  'protected.tests.running': ['Testing {name} now', 'Test nu {name}'],
  'protected.tests.next': ['Next test {when}', 'Volgende test {when}'],
  'protected.tests.none': ['No test yet', 'Nog geen test'],
  'protected.tests.blocked.manage_off': [
    'Turn on Manage for this server first.',
    'Zet eerst Beheren aan voor deze server.',
  ],
  'protected.tests.blocked.offline': ['The server isn’t reachable now.', 'De server is nu niet bereikbaar.'],
  'protected.tests.blocked.no_guests': ['No machines to test here.', 'Hier zijn geen machines om te testen.'],
});
