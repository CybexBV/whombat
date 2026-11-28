/**
 * Notices about the box itself: security pushes, push previews, the update, Whombat Link, the own address and backups.
 * English is what these said before languages existed.
 */
import { splitPairs } from './pairs';

export const MANAGED = splitPairs({
  // Security pushes: fixed sentences, nothing from the person's data.
  'managed.security.passkeyEnrolled.title': ['A new device signed in', 'Er is een nieuw apparaat ingelogd'],
  'managed.security.passkeyEnrolled.body': [
    'A device signed in to your Whombat with your passkey. If it wasn’t you, remove it in Settings.',
    'Een apparaat is met je passkey ingelogd op je Whombat. Was jij het niet? Verwijder het dan in Instellingen.',
  ],
  'managed.security.screenEnrolled.title': [
    'A device signed in at the screen',
    'Een apparaat is ingelogd via het scherm',
  ],
  'managed.security.screenEnrolled.body': [
    'Someone typed the letters from your Whombat’s screen and a device is in. If it wasn’t you, remove it in Settings.',
    'Iemand heeft de letters van het scherm van je Whombat getypt en een apparaat is binnen. Was jij het niet? Verwijder het dan in Instellingen.',
  ],
  'managed.security.screenBackoff.title': ['Wrong letters at the screen', 'Verkeerde letters bij het scherm'],
  'managed.security.screenBackoff.body': [
    'Someone typed the wrong sign-in letters on your Whombat a few times. It now makes them wait between tries.',
    'Iemand heeft een paar keer de verkeerde inlogletters getypt op je Whombat. Hij laat nu wachten tussen pogingen.',
  ],
  'managed.security.recoveryStarted.title': ['Recovery kit being made', 'Herstelpakket wordt gemaakt'],
  'managed.security.recoveryStarted.body': [
    'Someone started making a recovery kit for your Whombat. If it wasn’t you, look in Settings.',
    'Iemand is begonnen met een herstelpakket voor je Whombat. Was jij het niet? Kijk dan in Instellingen.',
  ],
  'managed.security.recoveryRotating.title': ['Recovery kit being replaced', 'Herstelpakket wordt vervangen'],
  'managed.security.recoveryRotating.body': [
    'Someone started replacing your Whombat’s recovery kit. If it wasn’t you, look in Settings.',
    'Iemand is begonnen het herstelpakket van je Whombat te vervangen. Was jij het niet? Kijk dan in Instellingen.',
  ],
  'managed.security.recoveryRegistered.title': ['Recovery kit saved', 'Herstelpakket bewaard'],
  'managed.security.recoveryRegistered.body': [
    'Your Whombat has a recovery kit now. Keep it somewhere safe.',
    'Je Whombat heeft nu een herstelpakket. Bewaar het op een veilige plek.',
  ],
  'managed.security.recoveryRotated.title': ['New recovery kit', 'Nieuw herstelpakket'],
  'managed.security.recoveryRotated.body': [
    'Your Whombat has a new recovery kit. The old one doesn’t work any more.',
    'Je Whombat heeft een nieuw herstelpakket. Het oude werkt niet meer.',
  ],
  'managed.security.ownAddressForeign.title': [
    'A certificate you didn’t ask for',
    'Een certificaat waar je niet om vroeg',
  ],
  'managed.security.ownAddressForeign.body': [
    'Someone got a certificate for your Whombat’s address that it didn’t ask for. Until you know why, use the phone app or your home network.',
    'Iemand kreeg een certificaat voor het adres van je Whombat waar die niet om vroeg. Gebruik tot je weet waarom de app op je telefoon of je thuisnetwerk.',
  ],
  'managed.security.remoteHelpLockedOut.title': ['Remote help turned off', 'Hulp op afstand staat uit'],
  'managed.security.remoteHelpLockedOut.body': [
    'Remote help turned itself off after 5 wrong help codes.',
    'Hulp op afstand is uitgegaan na 5 verkeerde hulpcodes.',
  ],
  'managed.security.restoreDone.title': ['Your Whombat is back', 'Je Whombat is terug'],
  'managed.security.restoreDone.body': ['Open it to finish.', 'Open hem om af te ronden.'],
  'managed.security.remoteHelpVisit.title': [
    'Support is looking at your Whombat',
    'Support kijkt mee op je Whombat',
  ],

  // What a push says without a preview, per kind (the phone's generic lines).
  'managed.push.generic.message': ['An agent has an update for you', 'Een agent heeft nieuws voor je'],
  'managed.push.generic.mention': ['Someone mentioned you', 'Iemand noemde je'],
  'managed.push.generic.approval': [
    'Something is waiting for your approval',
    'Er wacht iets op je goedkeuring',
  ],
  'managed.push.generic.run': ['A run has news', 'Een uitvoering heeft nieuws'],
  'managed.push.generic.update': ['Your Whombat has an update', 'Er is een update voor je Whombat'],
  'managed.push.generic.backup': [
    'Your Whombat’s backups need a look',
    'De back-ups van je Whombat hebben aandacht nodig',
  ],
  'managed.push.generic.security': [
    'A security change on your Whombat',
    'Een beveiligingswijziging op je Whombat',
  ],
  'managed.push.generic.generic': ['Whombat needs you', 'Whombat heeft je nodig'],
  'managed.push.needsYou': ['Needs you · {where}', 'Actie nodig · {where}'],
  'managed.push.mention': ['{actor} mentioned you in {where}', '{actor} noemde je in {where}'],
  'managed.push.reply': ['{actor} replied in {where}', '{actor} reageerde in {where}'],
  'managed.push.direct': ['Direct', 'Privé'],

  // An update waiting for the owner's yes.
  'managed.update.title': ['An update is ready', 'Er staat een update klaar'],
  'managed.update.body': [
    'Your Whombat installs it when you say so.',
    'Je Whombat installeert hem als jij het zegt.',
  ],
  'managed.update.open': ['See the update', 'Bekijk de update'],

  // Whombat Link.
  'managed.link.graceTitle': ['Whombat Link is ending', 'Whombat Link stopt'],
  'managed.link.graceBody': [
    'Whombat Link stops on {date}. Turn on Tailscale so you can still reach your Whombat from away, and check you have the paper copy of your backup details.',
    'Whombat Link stopt op {date}. Zet Tailscale aan zodat je je Whombat onderweg nog bereikt, en check of je de papieren kopie van je back-upgegevens hebt.',
  ],
  'managed.link.graceTailscale': ['Turn on Tailscale', 'Zet Tailscale aan'],
  'managed.link.graceBackup': ['Backup details', 'Back-upgegevens'],
  'managed.link.endedTitle': ['Whombat Link has ended', 'Whombat Link is gestopt'],
  'managed.link.endedBody': [
    'Your Whombat still works at home, and your data, agents, automations and backups are all still here. To reach it from away, turn on Tailscale.',
    'Je Whombat werkt thuis nog gewoon, en je gegevens, agents, automatiseringen en back-ups zijn er allemaal nog. Zet Tailscale aan om hem onderweg te bereiken.',
  ],
  'managed.link.endedOpen': ['Turn on Tailscale', 'Zet Tailscale aan'],
  'managed.link.pushTitle': ['Whombat Link is ending', 'Whombat Link stopt'],
  'managed.link.pushBody': [
    'It stops on {date}. Turn on Tailscale and check the paper copy of your backup details.',
    'Hij stopt op {date}. Zet Tailscale aan en check de papieren kopie van je back-upgegevens.',
  ],

  // The box's own address.
  'managed.ownAddress.open': ['Open', 'Openen'],
  'managed.ownAddress.foreignTitle': [
    'A certificate you didn’t ask for',
    'Een certificaat waar je niet om vroeg',
  ],
  'managed.ownAddress.foreignBody': [
    'Someone got a security certificate for your Whombat’s address that your Whombat didn’t ask for. Until you know why, don’t use {address}. Use the app on your phone or your home network.',
    'Iemand heeft een beveiligingscertificaat gekregen voor het adres van je Whombat, zonder dat je Whombat erom vroeg. Gebruik {address} niet tot je weet waarom. Gebruik de app op je telefoon of je thuisnetwerk.',
  ],
  'managed.ownAddress.uncheckedTitle': ['Certificates not checked', 'Certificaten niet gecontroleerd'],
  'managed.ownAddress.uncheckedBody': [
    'Whombat couldn’t check certificates for its address since {since}. It keeps trying.',
    'Whombat kan sinds {since} de certificaten voor zijn adres niet controleren. Hij blijft het proberen.',
  ],
  'managed.ownAddress.expiringTitle': [
    'Your Whombat’s address ends soon',
    'Het adres van je Whombat verloopt binnenkort',
  ],
  'managed.ownAddress.expiringBody': [
    'The certificate for your Whombat’s address ends on {date} and no new one came yet. Keep your Whombat on so it can renew it.',
    'Het certificaat voor het adres van je Whombat verloopt op {date} en er is nog geen nieuw. Laat je Whombat aan staan zodat hij het kan vernieuwen.',
  ],
  'managed.ownAddress.failingTitle': [
    'Your Whombat’s address isn’t working',
    'Het adres van je Whombat werkt niet',
  ],
  'managed.ownAddress.failingBody': [
    'Your Whombat couldn’t get a certificate for its address for a day. It keeps trying, but it can’t while it keeps restarting.',
    'Je Whombat kreeg al een dag geen certificaat voor zijn adres. Hij blijft het proberen, maar dat lukt niet zolang hij steeds opnieuw opstart.',
  ],
  'managed.ownAddress.missed': [
    'Whombat couldn’t check certificates from {from} to {to}.',
    'Whombat kon van {from} tot {to} de certificaten niet controleren.',
  ],
  'managed.ownAddress.movedTitle': ['Your Whombat has a new address', 'Je Whombat heeft een nieuw adres'],
  'managed.ownAddress.movedBody': [
    'Your Whombat’s address is now {host}. The old one works until {until}.',
    'Het adres van je Whombat is nu {host}. Het oude werkt tot {until}.',
  ],
  'managed.ownAddress.leavingTitle': [
    'Your Whombat’s old address stops soon',
    'Het oude adres van je Whombat stopt binnenkort',
  ],
  'managed.ownAddress.leavingBody': [
    '{old} stops working on {until}. Open {host} on each browser or phone that signs in with a passkey, and add one there.',
    '{old} werkt niet meer vanaf {until}. Open {host} in elke browser of op elke telefoon die met een passkey inlogt, en maak daar een nieuwe aan.',
  ],

  // Backups.
  'managed.backup.down': [
    'Your Whombat’s backup service isn’t answering right now. It usually comes back by itself; try again in a minute.',
    'De back-updienst van je Whombat reageert nu niet. Meestal komt hij vanzelf terug; probeer het over een minuut nog eens.',
  ],
  'managed.backup.restartFailed': [
    'Your Whombat is back, but it couldn’t restart to finish. Try again in a moment.',
    'Je Whombat is terug, maar kon niet opnieuw opstarten om af te ronden. Probeer het zo nog eens.',
  ],
  'managed.backup.restored': [
    'Your Whombat is back from its backup. Anything after that backup isn’t here; tell me if something’s missing and I’ll look for it.',
    'Je Whombat is terug uit zijn back-up. Wat na die back-up kwam, is er niet; zeg het als je iets mist, dan zoek ik het op.',
  ],
  'managed.backup.restoredAt': [
    'Your Whombat is back as it was on {when}. Anything after that isn’t here: tell me if something’s missing and I’ll look in GitHub and your accounts.',
    'Je Whombat is terug zoals hij was op {when}. Wat daarna kwam, is er niet: zeg het als je iets mist, dan kijk ik in GitHub en je accounts.',
  ],
  // Why bringing a backup back failed, by the backup service's reason code (the service's English stays in English).
  'managed.backup.reason.no_place': [
    'Whombat doesn’t know where the backups are. Choose the place, then try again.',
    'Whombat weet niet waar de back-ups staan. Kies de plek en probeer het opnieuw.',
  ],
  'managed.backup.reason.unreachable': [
    'Whombat can’t reach the place where the backups are. Check that it is on, then try again.',
    'Whombat kan de plek met de back-ups niet bereiken. Check of die aan staat en probeer het opnieuw.',
  ],
  'managed.backup.reason.not_found': [
    'That backup isn’t there any more. Choose another one.',
    'Die back-up is er niet meer. Kies een andere.',
  ],
  'managed.backup.reason.newer': [
    'This backup was made by a newer Whombat. Update this Whombat first, then try again.',
    'Deze back-up is gemaakt door een nieuwere Whombat. Werk deze Whombat eerst bij en probeer het dan opnieuw.',
  ],
  'managed.backup.reason.no_space': [
    'This Whombat doesn’t have enough room to bring the backup back.',
    'Deze Whombat heeft niet genoeg ruimte om de back-up terug te zetten.',
  ],
  'managed.backup.reason.busy': [
    'Another restore is running on this Whombat.',
    'Er loopt al een andere herstelactie op deze Whombat.',
  ],
  'managed.backup.reason.interrupted': [
    'It restarted before it finished, so it was put back as it was. Your backups are fine. Try again when you like.',
    'Hij startte opnieuw op voordat het klaar was, dus hij is teruggezet zoals hij was. Je back-ups zijn in orde. Probeer het opnieuw wanneer je wilt.',
  ],
  'managed.backup.reason.migration': [
    'The backup came back, but this Whombat couldn’t check it, so it was put back as it was. Try again.',
    'De back-up kwam terug, maar deze Whombat kon hem niet controleren, dus hij is teruggezet zoals hij was. Probeer het opnieuw.',
  ],
  'managed.backup.reason.failed': [
    'Bringing the backup back didn’t work. It tries again at its next start; ask for help if that doesn’t fix it.',
    'De back-up terugzetten is niet gelukt. Bij de volgende start probeert hij het opnieuw; vraag om hulp als dat niet helpt.',
  ],
  // The copy somewhere else (offsite-copy.md): what failed, setting the bucket up or copying to it, by the step.
  'managed.offsite.step.reach': [
    'Whombat couldn’t reach the storage at that address. Check the address.',
    'Whombat kon de opslag op dat adres niet bereiken. Controleer het adres.',
  ],
  'managed.offsite.step.bucket': [
    'There’s no bucket with that name there. Check its name, or make the bucket first.',
    'Daar is geen bucket met die naam. Controleer de naam, of maak de bucket eerst aan.',
  ],
  'managed.offsite.step.keys': [
    'The storage didn’t accept the key. Check the key ID and its secret.',
    'De opslag accepteerde de sleutel niet. Controleer de sleutel-ID en het geheim.',
  ],
  'managed.offsite.step.region': [
    'The storage says the bucket is in another region. Check the region.',
    'De opslag zegt dat de bucket in een andere regio staat. Controleer de regio.',
  ],
  'managed.offsite.step.write': [
    'The key can’t save files in that bucket. Give it permission to write.',
    'Met deze sleutel kun je geen bestanden in die bucket opslaan. Geef hem schrijfrechten.',
  ],
  'managed.offsite.step.read': [
    'The key can’t read files back from that bucket. Give it permission to read.',
    'Met deze sleutel kun je geen bestanden uit die bucket lezen. Geef hem leesrechten.',
  ],
  'managed.offsite.step.delete': [
    'The key can’t delete files in that bucket. Whombat needs that to clear old copies, so give it permission to delete.',
    'Met deze sleutel kun je geen bestanden in die bucket verwijderen. Whombat heeft dat nodig om oude kopieën op te ruimen, dus geef hem verwijderrechten.',
  ],
  'managed.offsite.step.repository': [
    'That folder already holds backups this Whombat can’t open. Choose another folder.',
    'In die map staan al back-ups die deze Whombat niet kan openen. Kies een andere map.',
  ],
  'managed.offsite.step.same': [
    'That’s where your backups go already. Choose another place for the copy.',
    'Daar gaan je back-ups al naartoe. Kies een andere plek voor de kopie.',
  ],
  'managed.offsite.step.pair': [
    'Your backups already go to a bucket with another key. A copy in a second bucket needs the same key.',
    'Je back-ups gaan al naar een bucket met een andere sleutel. Een kopie in een tweede bucket heeft dezelfde sleutel nodig.',
  ],
  'managed.offsite.step.main': [
    'Whombat couldn’t read the backups at their main place, so nothing was copied.',
    'Whombat kon de back-ups op hun vaste plek niet lezen, dus er is niets gekopieerd.',
  ],
  'managed.offsite.step.copy': [
    'Copying the backups there stopped before it finished.',
    'Het kopiëren van de back-ups daarheen stopte voordat het klaar was.',
  ],
  'managed.offsite.notYet': [
    'This Whombat can’t keep a copy somewhere else yet. Update it first.',
    'Deze Whombat kan nog geen kopie op een andere plek bewaren. Werk hem eerst bij.',
  ],
  'managed.offsite.badAddress': [
    'That isn’t a storage address Whombat can use. Type it like s3.eu-central-003.backblazeb2.com, without the bucket.',
    'Dat is geen opslagadres dat Whombat kan gebruiken. Typ het zoals s3.eu-central-003.backblazeb2.com, zonder de bucket.',
  ],
  'managed.offsite.badPlace': [
    'Whombat can’t use that place. Check the address, the bucket and the folder.',
    'Whombat kan die plek niet gebruiken. Controleer het adres, de bucket en de map.',
  ],
  'managed.offsite.none': [
    'There’s no copy somewhere else set up yet.',
    'Er is nog geen kopie op een andere plek ingesteld.',
  ],
});
