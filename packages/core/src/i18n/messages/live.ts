import { splitPairs } from './pairs.js';

/** Schedules, Live Activities, work, desk glance, places, watches and automation step words. */
export const LIVE_MESSAGES = splitPairs({
  /* An agent's own schedules (`domain/schedules.ts`). */
  'schedules.status.active': ['Active', 'Actief'],
  'schedules.status.paused': ['Paused', 'Gepauzeerd'],
  'schedules.status.ended': ['Ended', 'Afgelopen'],
  'schedules.end.done': ['Done', 'Klaar'],
  'schedules.end.cancelled': ['Cancelled', 'Geannuleerd'],
  'schedules.end.expired': ['Ran its 90 days', 'Na 90 dagen gestopt'],
  'schedules.copy.tab': ['Schedules', 'Planningen'],
  'schedules.copy.title': ['SCHEDULES', 'PLANNINGEN'],
  'schedules.copy.intro': [
    'Reminders and checks {agent} set for itself.',
    'Herinneringen en controles die {agent} voor zichzelf heeft ingepland.',
  ],
  'schedules.copy.empty': ['{agent} hasn’t scheduled anything.', '{agent} heeft nog niets ingepland.'],
  'schedules.copy.next': ['Next', 'Volgende'],
  'schedules.copy.ends': ['Stops', 'Stopt'],
  'schedules.copy.runs': ['Times run', 'Keer uitgevoerd'],
  'schedules.copy.pause': ['Pause', 'Pauzeren'],
  'schedules.copy.resume': ['Resume', 'Hervatten'],
  'schedules.copy.remove': ['Remove', 'Verwijderen'],
  'schedules.copy.removeConfirm': [
    'Remove this schedule? {agent} won’t run it again.',
    'Deze planning verwijderen? {agent} voert hem daarna niet meer uit.',
  ],
  'schedules.copy.cancel': ['Cancel', 'Annuleren'],
  'schedules.copy.cancelled': [
    'Cancelled. {agent} won’t run it again.',
    'Geannuleerd. {agent} voert hem niet meer uit.',
  ],
  'schedules.once': ['Once, {day} at {time}', 'Eenmalig, {day} om {time}'],
  'schedules.otherZone': ['{when} ({zone} time)', '{when} (tijd in {zone})'],
  'schedules.cardTitle': ['{agent} scheduled: {prompt}', '{agent} heeft ingepland: {prompt}'],
  'schedules.cardTitleNone': ['{agent} scheduled a task', '{agent} heeft een taak ingepland'],

  /* Live Activities and Live Updates (`contracts/live-activity.ts`). */
  'liveActivity.now': ['Now: {step}', 'Nu: {step}'],
  'liveActivity.working': ['Working', 'Bezig'],
  'liveActivity.pausedAt': ['Paused: {step}', 'Gepauzeerd: {step}'],
  'liveActivity.paused': ['Paused', 'Gepauzeerd'],
  'liveActivity.done': ['Done', 'Klaar'],
  'liveActivity.failed': ['Stopped after an error', 'Gestopt na een fout'],
  'liveActivity.takenOver': ['Taken over', 'Overgenomen'],
  'liveActivity.conditions': [
    '{requester} · {met} of {total} conditions met',
    '{requester} · {met} van {total} voorwaarden voldaan',
  ],
  'liveActivity.runTitle': ['{agent} · Run #{number}', '{agent} · Uitvoering #{number}'],
  'liveActivity.approvalTitle': ['Approval #{number}', 'Goedkeuring #{number}'],
  'liveActivity.of': ['{met} of {total}', '{met} van {total}'],

  /* The Work view (`domain/work.ts`). */
  'work.section.needs_you': ['NEEDS YOU', 'ACTIE NODIG'],
  'work.section.running': ['RUNNING', 'BEZIG'],
  'work.section.queued': ['QUEUED', 'IN DE WACHTRIJ'],
  'work.section.blocked': ['BLOCKED', 'GEBLOKKEERD'],
  'work.section.failed': ['FAILED', 'MISLUKT'],
  'work.section.done': ['RECENTLY DONE', 'NET KLAAR'],
  'work.health.waitingApproval': ['Waiting for approval', 'Wacht op goedkeuring'],
  'work.health.waitingAnswer': ['Waiting for an answer', 'Wacht op een antwoord'],
  'work.health.noWordYet': ['No word from the runner yet', 'Nog niets van de runner gehoord'],
  'work.health.noWordFor': ['No word from the runner for {time}', 'Al {time} niets van de runner gehoord'],
  'work.health.working': ['Working · last step {ago}', 'Bezig · laatste stap {ago}'],
  'work.health.quietNone': [
    'Working quietly · no steps reported yet',
    'Stil aan het werk · nog geen stappen gemeld',
  ],
  'work.health.quiet': ['Working quietly · last step {ago}', 'Stil aan het werk · laatste stap {ago}'],
  'work.health.justNow': ['just now', 'zojuist'],
  'work.health.minAgo': ['{minutes} min ago', '{minutes} min geleden'],
  'work.health.minutes': ['{minutes} min', '{minutes} min'],

  /* Mail accounts by IMAP (`domain/connectors.ts`). */
  'imap.servers': ['{imap} and {smtp}', '{imap} en {smtp}'],
  'connectorSetup.newClientNeedsSecret': [
    'A new Client ID needs its client secret too.',
    'Een nieuwe Client ID heeft ook zijn client secret nodig.',
  ],
  'imap.failure.hostPort': ['{host} on port {port}', '{host} op poort {port}'],
  'imap.failure.theMailServer': ['the mail server', 'de mailserver'],
  'imap.failure.thatServer': ['that server', 'die server'],
  'imap.failure.theMailServerStart': ['The mail server', 'De mailserver'],
  'imap.failure.imap_refused': [
    'The mail server refused the password. If your provider uses app passwords, make one and use that.',
    'De mailserver weigerde het wachtwoord. Werkt je provider met app-wachtwoorden? Maak er dan een en gebruik dat.',
  ],
  'imap.failure.smtp_refused': [
    'The server for sending mail refused the password. If your provider uses app passwords, make one and use that.',
    'De server voor het versturen van mail weigerde het wachtwoord. Werkt je provider met app-wachtwoorden? Maak er dan een en gebruik dat.',
  ],
  'imap.failure.unreachable': ['Whombat couldn’t reach {where}.', 'Whombat kon {where} niet bereiken.'],
  'imap.failure.not_allowed': [
    'Whombat isn’t allowed to reach {host}. A server on your network needs to be on the home network list first.',
    'Whombat mag {host} niet bereiken. Een server in je eigen netwerk moet eerst op de lijst van het thuisnetwerk staan.',
  ],
  'imap.failure.certificate': [
    '{host} didn’t show a valid certificate, so Whombat didn’t send the password.',
    '{host} liet geen geldig certificaat zien, dus Whombat heeft het wachtwoord niet verstuurd.',
  ],
  // The providers' own menu names stay as they are: we can't check each one's Dutch wording.
  'imap.hint.google': [
    'Use the Google connection instead: it can also do your calendar and files. Or, for mail only, turn on 2-Step Verification and make an app password at myaccount.google.com/apppasswords.',
    'Gebruik liever de Google-koppeling: die kan ook je agenda en bestanden. Of, alleen voor mail: zet verificatie in twee stappen aan en maak een app-wachtwoord op myaccount.google.com/apppasswords.',
  ],
  'imap.hint.microsoft': [
    'Outlook and Microsoft 365 no longer let mail apps sign in with a password, not even an app password. Connect Microsoft 365 instead.',
    'Outlook en Microsoft 365 laten mail-apps niet meer inloggen met een wachtwoord, ook niet met een app-wachtwoord. Koppel in plaats daarvan Microsoft 365.',
  ],
  'imap.hint.icloud': [
    'iCloud needs an app-specific password: make one at account.apple.com → Sign-In and Security → App-Specific Passwords. With your own domain on iCloud, use your @icloud.com address as the username (Change → Username).',
    'iCloud heeft een appspecifiek wachtwoord nodig: maak er een op account.apple.com → Sign-In and Security → App-Specific Passwords. Gebruik je een eigen domein bij iCloud? Vul dan je @icloud.com-adres in als gebruikersnaam (Wijzigen → Gebruikersnaam).',
  ],
  'imap.hint.fastmail': [
    'Fastmail needs an app password: Settings → Privacy & Security → Connected apps & API tokens → Manage app passwords and access → New app password. The Basic plan has no IMAP.',
    'Fastmail heeft een app-wachtwoord nodig: Settings → Privacy & Security → Connected apps & API tokens → Manage app passwords and access → New app password. Het Basic-abonnement heeft geen IMAP.',
  ],
  'imap.hint.yahoo': [
    'Yahoo needs an app password: your Yahoo account → Account security → External connections → Create app password. If Yahoo doesn’t offer it, sign in on the web in the same browser for a few days first.',
    'Yahoo heeft een app-wachtwoord nodig: je Yahoo-account → Account security → External connections → Create app password. Biedt Yahoo dat niet aan? Log dan eerst een paar dagen in op de website, in dezelfde browser.',
  ],
  'imap.hint.aol': [
    'AOL needs an app password: your AOL account → Account security → Generate and manage app passwords.',
    'AOL heeft een app-wachtwoord nodig: je AOL-account → Account security → Generate and manage app passwords.',
  ],
  'imap.hint.zoho': [
    'Turn on IMAP in Zoho Mail first (Settings → Mail Accounts → IMAP). With two-step sign-in, make an app password in Zoho Accounts → Security → App Passwords.',
    'Zet eerst IMAP aan in Zoho Mail (Settings → Mail Accounts → IMAP). Log je in met twee stappen? Maak dan een app-wachtwoord in Zoho Accounts → Security → App Passwords.',
  ],
  'imap.hint.gmx': [
    'Turn on IMAP in GMX first: Settings → POP3 & IMAP. With two-step sign-in, use an app-specific password. GMX turns IMAP off again after a long time unused.',
    'Zet eerst IMAP aan in GMX: Settings → POP3 & IMAP. Log je in met twee stappen? Gebruik dan een appspecifiek wachtwoord. GMX zet IMAP weer uit als je het lang niet gebruikt.',
  ],
  'imap.hint.proton': [
    'Proton Mail can’t be connected yet: its Bridge only answers on the computer it runs on.',
    'Proton Mail kan nog niet gekoppeld worden: de Bridge antwoordt alleen op de computer waarop hij draait.',
  ],

  /* A one-time Find My watch (`domain/findmy-watch.ts`). */
  'findMyWatch.at': ['at {place}', 'bij {place}'],
  'findMyWatch.in': ['in {place}', 'in {place}'],
  'findMyWatch.start.leaves': [
    'I’ll tell you when {name} leaves {place}.',
    'Ik laat het je weten zodra {name} {place} verlaat.',
  ],
  'findMyWatch.start.arrives': [
    'I’ll tell you when {name} arrives {where}.',
    'Ik laat het je weten zodra {name} {where} aankomt.',
  ],
  'findMyWatch.end.arrived': ['{name} has arrived {where}.', '{name} is {where} aangekomen.'],
  'findMyWatch.end.leftTo': [
    '{name} has left {place} and is now {where}.',
    '{name} heeft {place} verlaten en is nu {where}.',
  ],
  'findMyWatch.end.left': ['{name} has left {place}.', '{name} heeft {place} verlaten.'],
  'findMyWatch.end.expiredLeaves': [
    '{name} is still at {place} after {hours} hours, so I’ve stopped watching.',
    '{name} is na {hours} uur nog steeds bij {place}, dus ik houd het niet meer in de gaten.',
  ],
  'findMyWatch.end.expiredArrives': [
    '{name} didn’t arrive {where} within {hours} hours, so I’ve stopped watching.',
    '{name} is niet binnen {hours} uur {where} aangekomen, dus ik houd het niet meer in de gaten.',
  ],
  'findMyWatch.end.stopped': [
    'I’ve stopped watching {name} because Find My isn’t connected any more.',
    'Ik houd {name} niet meer in de gaten, omdat Find My niet meer gekoppeld is.',
  ],
  'findMyWatch.card.watchingLeaves': [
    'Watching for {name} to leave {place}',
    'Wacht tot {name} {place} verlaat',
  ],
  'findMyWatch.card.watchingArrives': [
    'Watching for {name} to arrive {where}',
    'Wacht tot {name} {where} aankomt',
  ],
  'findMyWatch.card.until': ['Until {when}', 'Tot {when}'],
  'findMyWatch.card.tomorrow': ['tomorrow at {time}', 'morgen om {time}'],
  'findMyWatch.card.left': ['{name} left {place} · {time}', '{name} heeft {place} verlaten · {time}'],
  'findMyWatch.card.arrived': ['{name} arrived {where} · {time}', '{name} is {where} aangekomen · {time}'],
  'findMyWatch.card.cancelled': ['Stopped watching {name}', 'Gestopt met het volgen van {name}'],
  'findMyWatch.card.expired': [
    'Stopped watching {name} after {hours} hours',
    'Na {hours} uur gestopt met het volgen van {name}',
  ],
  'findMyWatch.card.stopped': [
    'Stopped watching {name}: Find My isn’t connected',
    'Gestopt met het volgen van {name}: Find My is niet gekoppeld',
  ],

  /* A one-time watch on a thing going down or coming back (`domain/thing-watch.ts`). */
  'thingWatch.start.cause': [
    '{name} is down while {cause} is down. I’ll tell you when {again} answers again.',
    '{name} ligt eruit terwijl {cause} eruit ligt. Ik laat het je weten zodra {again} weer reageert.',
  ],
  'thingWatch.start.down': ['I’ll tell you if {name} goes down.', 'Ik laat het je weten als {name} uitvalt.'],
  'thingWatch.start.back': [
    'I’ll tell you when {name} is back.',
    'Ik laat het je weten zodra {name} weer bereikbaar is.',
  ],
  'thingWatch.lessThanMinute': ['less than a minute', 'minder dan een minuut'],
  'thingWatch.minutes': [
    { one: '{count} minute', other: '{count} minutes' },
    { one: '{count} minuut', other: '{count} minuten' },
  ],
  'thingWatch.result.down': ['{name} is down.', '{name} ligt eruit.'],
  'thingWatch.result.back': ['{name} is back.', '{name} is weer bereikbaar.'],
  'thingWatch.result.backFor': [
    '{name} is back. It was down for {duration}.',
    '{name} is weer bereikbaar. Het lag er {duration} uit.',
  ],
  'thingWatch.removed': [
    '{name} was removed, so I stopped watching it.',
    '{name} is verwijderd, dus ik houd het niet meer in de gaten.',
  ],
  'thingWatch.expired.down': [
    'I didn’t see {name} go down before the watch ended.',
    'Ik heb {name} niet zien uitvallen voordat het volgen stopte.',
  ],
  'thingWatch.expired.back': [
    'I didn’t see {name} come back before the watch ended.',
    'Ik heb {name} niet terug zien komen voordat het volgen stopte.',
  ],
  'thingWatch.card.watchingDown': ['Watching for {name} to go down', 'Let op of {name} uitvalt'],
  'thingWatch.card.watchingBack': ['Watching for {name} to come back', 'Wacht tot {name} weer bereikbaar is'],
  'thingWatch.card.until': ['Until {when}', 'Tot {when}'],
  'thingWatch.card.tomorrow': ['tomorrow at {time}', 'morgen om {time}'],
  'thingWatch.card.dayAt': ['{day} at {time}', '{day} om {time}'],
  'thingWatch.card.wentDown': ['{name} went down · {time}', '{name} viel uit · {time}'],
  'thingWatch.card.isBack': ['{name} is back · {time}', '{name} is weer bereikbaar · {time}'],
  'thingWatch.card.expired': ['Watch for {name} ended', 'Volgen van {name} is afgelopen'],
  'thingWatch.card.cancelled': ['Stopped watching {name}', 'Gestopt met het volgen van {name}'],

  /* Automation steps (`domain/automation.ts`; the kinds' own labels are `plan.stepKind.*`). */
  'stepKind.earlier': ['An earlier step', 'Een eerdere stap'],

  /* Mail attachments that didn't come along with a run (`automations/mail.ts`). */
  'mailMissing.reason.too_large': ['too large', 'te groot'],
  'mailMissing.reason.unsupported_type': ['unknown file type', 'onbekend bestandstype'],
  'mailMissing.reason.download_failed': ['couldn’t be downloaded', 'kon niet worden gedownload'],
  'mailMissing.reason.too_many': ['attachment limit reached', 'maximum aantal bijlagen bereikt'],
  'mailMissing.omitted': [
    {
      one: '{count} more attachment didn’t come along (attachment limit reached).',
      other: '{count} more attachments didn’t come along (attachment limit reached).',
    },
    {
      one: 'Nog {count} bijlage is niet meegekomen (maximum aantal bijlagen bereikt).',
      other: 'Nog {count} bijlagen zijn niet meegekomen (maximum aantal bijlagen bereikt).',
    },
  ],
  'mailMissing.item': ['“{name}” ({reason})', '“{name}” ({reason})'],
  'mailMissing.one': ['Attachment didn’t come along: {item}.', 'Bijlage niet meegekomen: {item}.'],
  'mailMissing.many': [
    'These attachments didn’t come along: {items}.',
    'Deze bijlagen zijn niet meegekomen: {items}.',
  ],
  'mailMissing.manyMore': [
    'These attachments didn’t come along: {items} and {more} more.',
    'Deze bijlagen zijn niet meegekomen: {items} en nog {more}.',
  ],
});
