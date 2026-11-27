import { splitPairs } from './pairs';

/**
 * Servers (`hosts/`): Home's server facts and ways out, quiet words, the helper's updates, and the hub's alerts, hints
 * and status notes by their code (`hosts/localize.ts`). English for the codes is the hub's own wording; on an English
 * box the hub's text is shown as it came.
 */
export const HOSTS = splitPairs({
  'hosts.fact.cpu': ['CPU', 'CPU'],
  'hosts.fact.memory': ['Memory', 'Geheugen'],
  'hosts.fact.hottest': ['Hottest', 'Warmste'],
  'hosts.fact.guests': ['Guests', 'Machines'],
  'hosts.fact.guestsRunning': ['of {total} running', 'van {total} actief'],

  'hosts.wayOut.backupPlanOne': ['Add it to a backup plan.', 'Zet hem in een back-upplan.'],
  'hosts.wayOut.backupPlanMany': ['Add them to a backup plan.', 'Zet ze in een back-upplan.'],
  'hosts.wayOut.backUpOne': ['Back it up now.', 'Maak er nu een back-up van.'],
  'hosts.wayOut.backUpMany': ['Back them up now.', 'Maak er nu een back-up van.'],
  'hosts.wayOut.restartOne': ['Restart it to apply them.', 'Start hem opnieuw om ze toe te passen.'],
  'hosts.wayOut.restartMany': [
    'Restart them to apply the changes.',
    'Start ze opnieuw om de wijzigingen toe te passen.',
  ],
  'hosts.wayOut.snapshotsOne': ['See its snapshots.', 'Bekijk de snapshots.'],
  'hosts.wayOut.snapshotsMany': ['See their snapshots.', 'Bekijk hun snapshots.'],
  'hosts.wayOut.agentOne': [
    'Check that Proxmox’s helper runs inside it.',
    'Controleer of de helper van Proxmox erin draait.',
  ],
  'hosts.wayOut.agentMany': [
    'Check that Proxmox’s helper runs inside them.',
    'Controleer of de helper van Proxmox erin draait.',
  ],
  'hosts.wayOut.restorePointsOne': [
    'Set up automatic restore points for it.',
    'Stel er automatische herstelpunten voor in.',
  ],
  'hosts.wayOut.restorePointsMany': [
    'Set up automatic restore points for them.',
    'Stel er automatische herstelpunten voor in.',
  ],
  'hosts.wayOut.updateOne': ['Update it.', 'Werk hem bij.'],
  'hosts.wayOut.updateMany': ['Update them.', 'Werk ze bij.'],
  'hosts.wayOut.installOne': ['Install it on the System tab.', 'Installeer hem op het tabblad Systeem.'],
  'hosts.wayOut.installMany': ['Install them on the System tab.', 'Installeer ze op het tabblad Systeem.'],
  'hosts.wayOut.freeOrAdd': ['Free up space or add more.', 'Maak ruimte vrij of voeg ruimte toe.'],
  'hosts.wayOut.seeSystem': ['See it on the System tab.', 'Bekijk het op het tabblad Systeem.'],
  'hosts.wayOut.startArray': ['Start the array.', 'Start de array.'],
  'hosts.wayOut.parityAgain': ['Run the parity check again.', 'Voer de pariteitscontrole opnieuw uit.'],
  'hosts.wayOut.parity': ['Run a parity check.', 'Voer een pariteitscontrole uit.'],
  'hosts.wayOut.seeDisk': ['See the disk on the Array tab.', 'Bekijk de schijf op het tabblad Array.'],
  'hosts.wayOut.freeOnIt': ['Free up space on it.', 'Maak er ruimte op vrij.'],
  'hosts.wayOut.plugins': ['Update them under Plugins.', 'Werk ze bij onder Plugins.'],
  'hosts.wayOut.clearNotification': [
    'Clear it in Unraid once it’s handled.',
    'Wis het in Unraid zodra het geregeld is.',
  ],
  'hosts.wayOut.updateInUnraid': ['Update it in Unraid.', 'Werk het bij in Unraid.'],
  'hosts.wayOut.beforeFull': ['Check it before it fills up.', 'Controleer het voordat het volloopt.'],

  'hosts.quiet.untilChanges': ['until it changes', 'tot het verandert'],
  'hosts.quiet.maintenance': ['while it’s in maintenance', 'zolang hij in onderhoud is'],
  'hosts.quiet.parentOffline': ['while {name} is offline', 'zolang {name} offline is'],
  'hosts.lineQuestion': [
    '{title} on {server}. Can you look into it?',
    '{title} op {server}. Kun je het uitzoeken?',
  ],

  'hosts.agent.updated': ['Updated Whombat’s helper on {server}', 'Whombats helper op {server} bijgewerkt'],
  'hosts.agent.asked': [
    'Asked Whombat’s helper on {server} to update',
    'Whombats helper op {server} gevraagd om bij te werken',
  ],
  'hosts.agent.installing': [
    'Started the last install of Whombat’s helper on {server}',
    'De laatste installatie van Whombats helper op {server} gestart',
  ],
  'hosts.agent.settingOn': [
    'Turned on Keep Whombat’s helper up to date',
    'Whombats helper bijgewerkt houden aangezet',
  ],
  'hosts.agent.settingOff': [
    'Turned off Keep Whombat’s helper up to date',
    'Whombats helper bijgewerkt houden uitgezet',
  ],
  'hosts.agent.failedTitle': ['Whombat’s helper didn’t update', 'Whombats helper is niet bijgewerkt'],
  'hosts.agent.failedWayOut': [
    'It’s still on the version it had. Try again on the System tab.',
    'Hij draait nog de versie die hij had. Probeer het opnieuw op het tabblad Systeem.',
  ],
  'hosts.agent.installTitle': [
    'Whombat’s helper needs one more install',
    'Whombats helper moet nog één keer geïnstalleerd worden',
  ],
  'hosts.agent.installWayOutButton': [
    'After that it updates itself. Update it on the System tab.',
    'Daarna werkt hij zichzelf bij. Werk hem bij op het tabblad Systeem.',
  ],
  'hosts.agent.installWayOutCommand': [
    'After that it updates itself. Run its install command on it once; the System tab has it.',
    'Daarna werkt hij zichzelf bij. Voer de installatieopdracht er één keer op uit; die staat op het tabblad Systeem.',
  ],
  'hosts.agent.updateRunning': [
    'Another update is already running. Try again in a few minutes.',
    'Er loopt al een andere update. Probeer het over een paar minuten opnieuw.',
  ],
  'hosts.agent.needsInstall': [
    'Whombat’s helper on {server} needs one more install, and Whombat can’t run commands there. Run its install command on it once; the System tab has it.',
    'Whombats helper op {server} moet nog één keer geïnstalleerd worden, en Whombat kan daar geen opdrachten uitvoeren. Voer de installatieopdracht er één keer op uit; die staat op het tabblad Systeem.',
  ],
  'hosts.agent.upToDate': [
    'Whombat’s helper on {server} is already up to date.',
    'Whombats helper op {server} is al bijgewerkt.',
  ],
  'hosts.agent.notConnected': [
    '{server} isn’t connected right now, so its helper can’t be updated.',
    '{server} is nu niet verbonden, dus de helper kan niet worden bijgewerkt.',
  ],
  'hosts.agent.turnedOff': [
    'Updates are turned off on {server} itself.',
    'Updates staan uit op {server} zelf.',
  ],
  'hosts.agent.noBuild': [
    'There’s no new version of Whombat’s helper yet.',
    'Er is nog geen nieuwe versie van Whombats helper.',
  ],
  'hosts.agent.newerRunning': [
    '{server} already runs a newer helper.',
    '{server} draait al een nieuwere helper.',
  ],
  'hosts.agent.cantNow': [
    'Whombat’s helper on {server} can’t be updated right now.',
    'Whombats helper op {server} kan nu niet worden bijgewerkt.',
  ],
  'hosts.agent.theServer': ['the server', 'de server'],

  'hosts.address.titleOne': [
    'Your Whombat’s address changed from {from} to {to}, and {name} hasn’t found it yet.',
    'Het adres van je Whombat is veranderd van {from} naar {to}, en {name} heeft het nog niet gevonden.',
  ],
  'hosts.address.titleMany': [
    'Your Whombat’s address changed from {from} to {to}, and {n} servers haven’t found it yet.',
    'Het adres van je Whombat is veranderd van {from} naar {to}, en {n} servers hebben het nog niet gevonden.',
  ],
  'hosts.address.bodyOne': [
    'Whombat can sign in to it with your Vault key and point it here.',
    'Whombat kan erop inloggen met je sleutel uit de Kluis en hem hierheen laten wijzen.',
  ],
  'hosts.address.bodyMany': [
    'Whombat can sign in to them with your Vault keys and point them here.',
    'Whombat kan erop inloggen met je sleutels uit de Kluis en ze hierheen laten wijzen.',
  ],

  /* Status notes by the hub's `status_note_code` -------------------------------------------------------------------- */
  'hosts.note.temperature': ['{sensor} temperature', 'Temperatuur {sensor}'],
  'hosts.note.backup_failed': ['backup failed', 'back-up mislukt'],
  'hosts.note.ceph': ['shared storage', 'gedeelde opslag'],
  'hosts.note.certificate': ['certificate', 'certificaat'],
  'hosts.note.check_down': ['check down', 'controle faalt'],
  'hosts.note.denied_requests': ['refused requests', 'geweigerde verzoeken'],
  'hosts.note.disk_errors': ['disk errors', 'schijffouten'],
  'hosts.note.disk_failing': ['disk failing', 'schijf gaat stuk'],
  'hosts.note.disk_full_soon': ['filling up', 'loopt vol'],
  'hosts.note.disk_space': ['disk space', 'schijfruimte'],
  'hosts.note.disk_wear': ['disk wear', 'schijfslijtage'],
  'hosts.note.fan_failed': ['fan stopped', 'ventilator gestopt'],
  'hosts.note.guest_stopped': ['machine stopped', 'machine gestopt'],
  'hosts.note.inodes_high': ['file slots', 'bestandsplekken'],
  'hosts.note.link_down': ['network link down', 'netwerkverbinding weg'],
  'hosts.note.memory_assigned': ['memory assigned', 'geheugen toegewezen'],
  'hosts.note.never_connected': ['never connected', 'nooit verbonden'],
  'hosts.note.not_checking_in': ['not checking in', 'meldt zich niet'],
  'hosts.note.oom': ['out of memory', 'geheugen vol'],
  'hosts.note.pool_degraded': ['storage degraded', 'opslag verminderd'],
  'hosts.note.pool_errors': ['storage errors', 'opslagfouten'],
  'hosts.note.quorum_lost': ['cluster quorum lost', 'clusterquorum kwijt'],
  'hosts.note.raid_degraded': ['disk array degraded', 'schijfarray verminderd'],
  'hosts.note.readonly_fs': ['read-only disk', 'schijf alleen-lezen'],
  'hosts.note.replication': ['replication failed', 'replicatie mislukt'],
  'hosts.note.restart_loop': ['restart loop', 'blijft herstarten'],
  'hosts.note.time_unsynced': ['clock off', 'klok loopt verkeerd'],
  'hosts.note.too_few_processors': ['too few processors', 'te weinig processors'],
  'hosts.note.ups_battery': ['on battery', 'op batterij'],

  /* Shared words of the codes --------------------------------------------------------------------------------------- */
  'hosts.word.customLimit': ['your limit is {limit}', 'je limiet is {limit}'],
  'hosts.word.limit': ['the warning limit is {limit}', 'de waarschuwingslimiet is {limit}'],
  'hosts.word.nothingHeard': ['Nothing heard from it yet', 'Nog niets van gehoord'],
  'hosts.word.ofVolume': ['{used} of {total} used', '{used} van {total} gebruikt'],

  'hosts.dur.s': ['{n} s', '{n} s'],
  'hosts.dur.min': ['{n} min', '{n} min'],
  'hosts.dur.hm': ['{h} h {m} m', '{h} u {m} min'],
  'hosts.dur.dh': ['{d} d {h} h', '{d} d {h} u'],
  'hosts.when.today': ['today', 'vandaag'],
  'hosts.when.tomorrow': ['tomorrow', 'morgen'],
  'hosts.when.inDays': [
    { one: 'in {n} day', other: 'in {n} days' },
    { one: 'over {n} dag', other: 'over {n} dagen' },
  ],

  /* Alerts by code -------------------------------------------------------------------------------------------------- */
  'hosts.code.agent.heartbeat_missing.title': [
    'Whombat’s helper isn’t checking in',
    'Whombats helper meldt zich niet',
  ],
  'hosts.code.agent.heartbeat_missing.never.detail': ['Nothing heard from it yet', 'Nog niets van gehoord'],
  'hosts.code.agent.heartbeat_missing.elapsed.detail': [
    'Not heard from for {held}',
    'Al {held} niets van gehoord',
  ],
  'hosts.code.sensor.temp_high.title': ['{label} at {temp}', '{label} op {temp}'],
  'hosts.code.sensor.temp_high.detail': ['Above {limit} for {held}', 'Boven {limit} sinds {held}'],
  'hosts.code.sensor.temp_high.custom.detail': [
    '{temp}, your limit is {limit}, for {held}',
    '{temp}, je limiet is {limit}, al {held}',
  ],
  'hosts.code.sensor.temp_high.advice': [
    'The warning limit is {limit}.',
    'De waarschuwingslimiet is {limit}.',
  ],
  'hosts.code.sensor.temp_critical.detail': [
    'At or above the {limit} limit for {held}',
    'Op of boven de limiet van {limit} sinds {held}',
  ],
  'hosts.code.sensor.temp_critical.advice': [
    'Check cooling and load.',
    'Controleer de koeling en de belasting.',
  ],
  'hosts.code.disk.wear.title': [
    'Disk {device} is {pct} worn out',
    'Schijf {device} is voor {pct} versleten',
  ],
  'hosts.code.disk.wear.written': ['{written} written', '{written} geschreven'],
  'hosts.code.disk.wear.tbw': ['{written} of {rated} written', '{written} van {rated} geschreven'],
  'hosts.code.disk.wear_high.advice': ['Plan to replace it.', 'Plan om hem te vervangen.'],
  'hosts.code.disk.wear_critical.advice': ['Replace the disk soon.', 'Vervang de schijf binnenkort.'],
  'hosts.code.disk.space_high.title': ['{volume} {pct} full', '{volume} voor {pct} vol'],
  'hosts.code.disk.space_high.bannerTitle': ['{volume} is {pct} full', '{volume} is voor {pct} vol'],
  'hosts.code.hypervisor.overcommit.title': [
    'Machines want more processors than the server has',
    'Machines vragen meer processors dan de server heeft',
  ],
  'hosts.code.hypervisor.overcommit.detail': [
    '{allocated} virtual processors share {threads} real ones ({ratio} : 1) while it’s busy, for {held}',
    '{allocated} virtuele processors delen {threads} echte ({ratio} : 1) terwijl het druk is, al {held}',
  ],
  'hosts.code.hypervisor.memory_assigned.title': [
    'Machines have {pct} of the memory',
    'Machines hebben {pct} van het geheugen',
  ],
  'hosts.code.hypervisor.memory_assigned.detail': [
    '{used} of {total} assigned to machines',
    '{used} van {total} toegewezen aan machines',
  ],
  'hosts.code.disk.smart_failing.title': ['Disk {device} is failing', 'Schijf {device} gaat stuk'],
  'hosts.code.disk.smart_failing.detail': [
    'Its own health check says it is failing',
    'De eigen gezondheidscontrole zegt dat hij stukgaat',
  ],
  'hosts.code.disk.smart_failing.advice': [
    'Back up what’s on it and replace it.',
    'Maak een back-up van wat erop staat en vervang hem.',
  ],
  'hosts.code.disk.smart_errors.title': ['Disk {device} has errors', 'Schijf {device} heeft fouten'],
  'hosts.code.disk.smart_errors.pending': [
    { one: '{n} spot waiting to be moved', other: '{n} spots waiting to be moved' },
    { one: '{n} plek wacht om verplaatst te worden', other: '{n} plekken wachten om verplaatst te worden' },
  ],
  'hosts.code.disk.smart_errors.uncorrectable': [
    { one: '{n} error it couldn’t fix', other: '{n} errors it couldn’t fix' },
    { one: '{n} fout die hij niet kon herstellen', other: '{n} fouten die hij niet kon herstellen' },
  ],
  'hosts.code.disk.smart_errors.media': [
    { one: '{n} media error', other: '{n} media errors' },
    { one: '{n} mediafout', other: '{n} mediafouten' },
  ],
  'hosts.code.disk.smart_errors.selfTest': ['its {type} self-test failed', 'de {type}-zelftest is mislukt'],
  'hosts.code.disk.smart_errors.advice': [
    'Keep a backup of what’s on it.',
    'Houd een back-up van wat erop staat.',
  ],
  'hosts.code.pool.degraded.title': ['Storage “{name}” is {health}', 'Opslag “{name}” is {health}'],
  'hosts.code.pool.degraded.missing': [
    'Storage “{name}” is missing a disk',
    'Opslag “{name}” mist een schijf',
  ],
  'hosts.code.pool.degraded.detail': ['Not working: {disks}', 'Werkt niet: {disks}'],
  'hosts.code.pool.errors.title': ['Storage “{name}” has errors', 'Opslag “{name}” heeft fouten'],
  'hosts.code.pool.errors.detail': [
    '{io} read or write errors · {scrub} found by the last check',
    '{io} lees- of schrijffouten · {scrub} gevonden bij de laatste controle',
  ],
  'hosts.code.raid.degraded.title': [
    'One of {name}’s disks has stopped working',
    'Een van de schijven van {name} werkt niet meer',
  ],
  'hosts.code.raid.degraded.detail': [
    '{active} of {total} disks working',
    '{active} van {total} schijven werken',
  ],
  'hosts.code.fs.read_only.title': ['{volume} can only be read', '{volume} kan alleen gelezen worden'],
  'hosts.code.fs.read_only.detail': [
    'Nothing can be written to it until it’s fixed',
    'Er kan niets op geschreven worden tot het is opgelost',
  ],
  'hosts.code.fs.inodes_high.title': [
    '{volume} is running out of file slots',
    '{volume} heeft bijna geen plek meer voor bestanden',
  ],
  'hosts.code.fs.inodes_high.detail': [
    '{used} of {total} used ({pct})',
    '{used} van {total} gebruikt ({pct})',
  ],
  'hosts.code.pve.quorum_lost.title': [
    'Cluster {name} lost its quorum',
    'Cluster {name} is het quorum kwijt',
  ],
  'hosts.code.pve.quorum_lost.detail': [
    '{connected} of {total} servers can see each other',
    '{connected} van {total} servers zien elkaar',
  ],
  'hosts.code.backup.failed.title': ['Last backup failed', 'Laatste back-up mislukt'],
  'hosts.code.backup.failed.bannerTitle': ['The last backup failed', 'De laatste back-up is mislukt'],
  'hosts.code.backup.failed.detail': [
    '{ok} of {total} machines backed up',
    '{ok} van {total} machines geback-upt',
  ],
  'hosts.code.backup.failed.advice': [
    'Proxmox’s backup log says why.',
    'Het back-uplog van Proxmox zegt waarom.',
  ],
  'hosts.code.pve.replication_failed.title': [
    'Copying {id} to {target} failed',
    'Kopiëren van {id} naar {target} is mislukt',
  ],
  'hosts.code.ceph.health.warn': [
    'Shared storage (Ceph) has a warning',
    'Gedeelde opslag (Ceph) geeft een waarschuwing',
  ],
  'hosts.code.ceph.health.err': [
    'Shared storage (Ceph) has a problem',
    'Gedeelde opslag (Ceph) heeft een probleem',
  ],
  'hosts.code.time.unsynced.title': ['The clock is off', 'De klok loopt verkeerd'],
  'hosts.code.time.unsynced.detail': ['It isn’t in step with {source}', 'Hij loopt niet gelijk met {source}'],
  'hosts.code.ups.on_battery.title': ['{name} is running on battery', '{name} draait op de batterij'],
  'hosts.code.ups.on_battery.runtime': ['about {left} left', 'nog ongeveer {left}'],
  'hosts.code.net.link_down.title': ['Network link {name} is down', 'Netwerkverbinding {name} is weg'],
  'hosts.code.sensor.fan_failed.title': ['Fan {label} stopped', 'Ventilator {label} is gestopt'],
  'hosts.code.host.oom.title': ['The server ran out of memory', 'De server had te weinig geheugen'],
  'hosts.code.host.oom.detail': [
    { one: 'It stopped a program {ago} ago', other: 'It stopped programs {n} times, last {ago} ago' },
    {
      one: 'Hij stopte {ago} geleden een programma',
      other: 'Hij stopte {n} keer programma’s, het laatst {ago} geleden',
    },
  ],
  'hosts.code.guest.restart_loop.title': ['{name} keeps restarting', '{name} blijft herstarten'],
  'hosts.code.guest.restart_loop.detail': ['{n} restarts in {window}', '{n} keer herstart in {window}'],
  'hosts.code.guest.restart_loop.advice': ['Its logs say why.', 'De logs zeggen waarom.'],
  'hosts.code.guest.stopped.title': ['{name} stopped on its own', '{name} is vanzelf gestopt'],
  'hosts.code.guest.stopped.oom': ['It ran out of memory', 'Het geheugen was op'],
  'hosts.code.guest.stopped.crash': ['It crashed', 'Het is gecrasht'],
  'hosts.code.disk.full_soon.title': ['{volume} full {when}', '{volume} vol {when}'],
  'hosts.code.disk.full_soon.bannerTitle': ['{volume} will be full {when}', '{volume} is vol {when}'],
  'hosts.code.disk.full_soon.detail': ['At the rate it filled last week', 'In het tempo van vorige week'],
  'hosts.code.security.denied_requests.title': [
    'Requests from {user} were refused',
    'Verzoeken van {user} zijn geweigerd',
  ],
  'hosts.code.security.denied_requests.detail': [
    { one: '{n} refused request', other: '{n} refused requests' },
    { one: '{n} geweigerd verzoek', other: '{n} geweigerde verzoeken' },
  ],
  'hosts.code.check.down.title': ['{name} is down', '{name} werkt niet'],
  'hosts.code.check.down.heartbeat_never': ['No ping yet', 'Nog geen ping'],
  'hosts.code.check.down.heartbeat_failed': ['The job said it failed', 'De taak meldde dat hij mislukte'],
  'hosts.code.check.down.heartbeat_elapsed': ['No ping for {held}', 'Al {held} geen ping'],
  'hosts.code.check.down.heartbeat_exit': [
    'The job ended with code {code}',
    'De taak stopte met code {code}',
  ],
  'hosts.code.check.cert_expiring.title': [
    { one: '{name}’s certificate ends in {n} day', other: '{name}’s certificate ends in {n} days' },
    {
      one: 'Het certificaat van {name} verloopt over {n} dag',
      other: 'Het certificaat van {name} verloopt over {n} dagen',
    },
  ],
  'hosts.code.check.cert_expiring.detail': ['Valid until {date}', 'Geldig tot {date}'],

  /* Hints by code --------------------------------------------------------------------------------------------------- */
  'hosts.hint.sensor.near_limit.title': ['{label} at {temp}', '{label} op {temp}'],
  'hosts.hint.sensor.near_limit.detail': ['Close to its limit of {limit}', 'Dicht bij de limiet van {limit}'],
  'hosts.hint.swap.high.title': ['Swap almost full', 'Swap bijna vol'],
  'hosts.hint.swap.high.detail': ['{used} of {total} used', '{used} van {total} gebruikt'],
  'hosts.hint.memory.low.title': ['Memory almost full', 'Geheugen bijna vol'],
  'hosts.hint.memory.low.detail': ['{available} of {total} free', '{available} van {total} vrij'],
  'hosts.hint.disk.space.title': ['{volume} {pct} full', '{volume} voor {pct} vol'],
  'hosts.hint.disk.wear.title': ['Disk {device} is {pct} worn', 'Schijf {device} is voor {pct} versleten'],
  'hosts.hint.collector.error.title': [
    'Whombat can’t read part of this server',
    'Whombat kan een deel van deze server niet lezen',
  ],
  'hosts.hint.guests.unhealthy.title': [
    { one: '{n} app isn’t working properly', other: '{n} apps aren’t working properly' },
    { one: '{n} app werkt niet goed', other: '{n} apps werken niet goed' },
  ],
  'hosts.hint.system.failed_units.title': [
    { one: '{n} service failed', other: '{n} services failed' },
    { one: '{n} dienst mislukt', other: '{n} diensten mislukt' },
  ],
  'hosts.hint.docker.image_updates.title': [
    { one: '{n} app has an update', other: '{n} apps have updates' },
    { one: '{n} app heeft een update', other: '{n} apps hebben updates' },
  ],
  'hosts.hint.docker.update_available.title': [
    { one: '{n} app has an update', other: '{n} apps have updates' },
    { one: '{n} app heeft een update', other: '{n} apps hebben updates' },
  ],
  'hosts.hint.unraid.plugin_updates.title': [
    { one: '{n} plugin has an update', other: '{n} plugins have updates' },
    { one: '{n} plugin heeft een update', other: '{n} plugins hebben updates' },
  ],
  'hosts.hint.guest.no_backup_job.title': [
    { one: '{n} machine isn’t in a backup plan', other: '{n} machines aren’t in a backup plan' },
    { one: '{n} machine staat in geen back-upplan', other: '{n} machines staan in geen back-upplan' },
  ],
  'hosts.hint.guest.agent_down.title': [
    {
      one: 'Proxmox’s helper isn’t running in {n} machine',
      other: 'Proxmox’s helper isn’t running in {n} machines',
    },
    {
      one: 'De helper van Proxmox draait niet in {n} machine',
      other: 'De helper van Proxmox draait niet in {n} machines',
    },
  ],
  'hosts.hint.agent.outdated.title': [
    'Whombat’s helper on this server is out of date',
    'Whombats helper op deze server is verouderd',
  ],
  'hosts.hint.agent.outdated.detail': [
    'It runs {agent}, Whombat {hub}.',
    'Hij draait {agent}, Whombat {hub}.',
  ],
  'hosts.hint.system.updates.title': [
    { one: '{n} update waiting', other: '{n} updates waiting' },
    { one: '{n} update wacht', other: '{n} updates wachten' },
  ],
  'hosts.hint.system.updates.security': [
    { one: '{n} for security', other: '{n} for security' },
    { one: '{n} voor beveiliging', other: '{n} voor beveiliging' },
  ],
  'hosts.hint.system.reboot.title': ['Restart needed', 'Herstart nodig'],
  'hosts.hint.system.reboot.detail': [
    'To finish installing updates',
    'Om het installeren van updates af te ronden',
  ],
  'hosts.hint.cpu.steal.title': [
    'This server is slowed down by its host',
    'Deze server wordt afgeremd door zijn host',
  ],
  'hosts.hint.cpu.steal.detail': [
    'The computer it runs on gives it {pct} less processing time than it asks for',
    'De computer waarop hij draait geeft hem {pct} minder rekentijd dan hij vraagt',
  ],
  'hosts.hint.disk.counters.title': [
    'Disk {device} has had a few errors',
    'Schijf {device} had een paar fouten',
  ],
  'hosts.hint.pool.scrub.never.title': [
    'Storage “{name}” has never been checked for damage',
    'Opslag “{name}” is nog nooit op schade gecontroleerd',
  ],
  'hosts.hint.pool.scrub.never.detail': [
    'A monthly data check finds hidden damage early',
    'Een maandelijkse controle vindt verborgen schade op tijd',
  ],
  'hosts.hint.pool.scrub.title': [
    'Storage “{name}” hasn’t been checked for damage lately',
    'Opslag “{name}” is een tijd niet op schade gecontroleerd',
  ],
  'hosts.hint.pool.scrub.detail': ['Last checked {date}', 'Laatst gecontroleerd op {date}'],
  'hosts.hint.raid.sync.title': ['{name}’s disks are syncing', 'De schijven van {name} worden gelijkgezet'],
  'hosts.hint.raid.sync.detail': ['It’s slower until it’s done', 'Tot het klaar is, is hij trager'],
  'hosts.hint.backup.warning.title': ['The last backup had a problem', 'De laatste back-up had een probleem'],
  'hosts.hint.backup.warning.detail': [
    '{ok} of {total} machines backed up · {warnings}',
    '{ok} van {total} machines geback-upt · {warnings}',
  ],
  'hosts.hint.backup.warning.warnings': [
    { one: '{n} warning', other: '{n} warnings' },
    { one: '{n} waarschuwing', other: '{n} waarschuwingen' },
  ],
  'hosts.hint.platform.warnings.title': [
    { one: '{platform} has {n} warning', other: '{platform} has {n} warnings' },
    { one: '{platform} heeft {n} waarschuwing', other: '{platform} heeft {n} waarschuwingen' },
  ],
  'hosts.hint.memory.limit.title': [
    { one: '{name} ran out of its memory', other: '{name} ran out of its memory {n} times' },
    { one: '{name} had te weinig geheugen', other: '{name} had {n} keer te weinig geheugen' },
  ],
  'hosts.hint.memory.limit.detail': [
    'The server itself has memory to spare.',
    'De server zelf heeft geheugen genoeg.',
  ],
  'hosts.hint.disk.forecast.title': ['{volume} full {when}', '{volume} vol {when}'],
  'hosts.hint.disk.forecast.detail': ['At the rate it filled last week', 'In het tempo van vorige week'],
  'hosts.hint.incus.no_snapshots.title': [
    { one: '{n} machine has no restore points', other: '{n} machines have no restore points' },
    { one: '{n} machine heeft geen herstelpunten', other: '{n} machines hebben geen herstelpunten' },
  ],
  'hosts.hint.incus.pool_full.title': ['Storage “{name}” is {pct} full', 'Opslag “{name}” is voor {pct} vol'],
  'hosts.hint.incus.warning.title': [
    { one: 'Incus has {n} warning', other: 'Incus has {n} warnings' },
    { one: 'Incus heeft {n} waarschuwing', other: 'Incus heeft {n} waarschuwingen' },
  ],
  'hosts.hint.unraid.parity_errors.title': [
    { one: 'The parity check found {n} error', other: 'The parity check found {n} errors' },
    { one: 'De pariteitscontrole vond {n} fout', other: 'De pariteitscontrole vond {n} fouten' },
  ],
  'hosts.hint.unraid.parity_old.title': [
    'The parity check hasn’t run lately',
    'De pariteitscontrole heeft een tijd niet gedraaid',
  ],
  'hosts.hint.unraid.parity_old.never.title': [
    'The parity check has never run',
    'De pariteitscontrole heeft nog nooit gedraaid',
  ],
  'hosts.hint.unraid.parity_old.detail': ['Last run {date}', 'Laatst gedraaid op {date}'],
  'hosts.hint.unraid.disk_errors.title': [
    { one: '{n} disk has errors', other: '{n} disks have errors' },
    { one: '{n} schijf heeft fouten', other: '{n} schijven hebben fouten' },
  ],
  'hosts.hint.pool_full.title': ['{name} is {pct} full', '{name} is voor {pct} vol'],
  'hosts.hint.pool_full.detail': ['{free} free', '{free} vrij'],
  'hosts.hint.unraid.os_update.title': ['Unraid {version} is out', 'Unraid {version} is uit'],
  'hosts.hint.unraid.array_stopped.title': ['The array is stopped', 'De array is gestopt'],
  'hosts.hint.unraid.array_stopped.invalid.title': [
    'The array is stopped: a disk is missing or wrong',
    'De array is gestopt: er ontbreekt een schijf of er zit een verkeerde in',
  ],
  'hosts.hint.libvirt.no_backup.title': [
    { one: '{n} machine has no backup', other: '{n} machines have no backup' },
    { one: '{n} machine heeft geen back-up', other: '{n} machines hebben geen back-up' },
  ],
  'hosts.hint.guest.backup_old.title': [
    { one: '{n} machine’s backup is old', other: '{n} machines’ backups are old' },
    { one: 'De back-up van {n} machine is oud', other: 'De back-ups van {n} machines zijn oud' },
  ],
  'hosts.hint.guest.pending_changes.title': [
    {
      one: '{n} machine needs a restart for its changes',
      other: '{n} machines need a restart for their changes',
    },
    {
      one: '{n} machine moet herstarten voor de wijzigingen',
      other: '{n} machines moeten herstarten voor de wijzigingen',
    },
  ],
  'hosts.hint.guest.snapshot_old.title': [
    { one: '{n} machine has an old snapshot', other: '{n} machines have old snapshots' },
    { one: '{n} machine heeft een oude snapshot', other: '{n} machines hebben oude snapshots' },
  ],
  'hosts.hint.storage.overcommit.title': [
    'Storage “{name}” promises more than it has',
    'Opslag “{name}” belooft meer dan het heeft',
  ],
  'hosts.hint.storage.overcommit.detail': [
    '{provisioned} handed out on {total} ({pct})',
    '{provisioned} uitgedeeld op {total} ({pct})',
  ],
  'hosts.hint.macos.screen_sharing_off.title': ['Screen Sharing is off', 'Scherm delen staat uit'],
  'hosts.hint.macos.screen_sign_in.title': [
    'Whombat needs to sign in to the screen',
    'Whombat moet inloggen op het scherm',
  ],
  'hosts.hint.macos.agent_folder.title': [
    'Whombat’s helper is in the wrong folder',
    'Whombats helper staat in de verkeerde map',
  ],
  'hosts.hint.macos.agent_folder.detail': ['It is in {folder}', 'Hij staat in {folder}'],
  'hosts.hint.macos.helper_no_access.title': [
    'Whombat Helper can’t control the screen',
    'Whombat Helper kan het scherm niet bedienen',
  ],
  'hosts.hint.macos.helper_off.title': ['Whombat Helper isn’t running', 'Whombat Helper draait niet'],
  'hosts.hint.macos.helper_off.detail': ['{user} needs to open it', '{user} moet hem openen'],
});
