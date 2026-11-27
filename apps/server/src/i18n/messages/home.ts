import { splitPairs } from './pairs';

/** Home, Needs you, Watch and the Inbox: what the overview and its sources write (`home/`). */
export const HOME = splitPairs({
  'home.assistant.start': ['Your assistant', 'Je assistent'],
  'home.assistant.mid': ['your assistant', 'je assistent'],
  'home.action.ask': ['Ask {assistant}', 'Vraag {assistant}'],
  'home.action.lookIntoIt': ['Look into it', 'Uitzoeken'],
  'home.action.remindTomorrow': ['Remind me tomorrow', 'Herinner me morgen'],
  'home.action.review': ['Review', 'Bekijken'],
  'home.action.answer': ['Answer', 'Antwoorden'],
  'home.action.signInAgain': ['Sign in again', 'Opnieuw inloggen'],
  'home.action.goAhead': ['Go ahead', 'Ga je gang'],
  'home.action.yesDoIt': ['Yes, do it', 'Ja, doe maar'],
  'home.action.seeOtherPlaces': ['See other places', 'Andere plekken bekijken'],
  'home.action.seeBackups': ['See backups', 'Back-ups bekijken'],
  'home.action.openBackups': ['Open Backups', 'Back-ups openen'],
  'home.action.finish': ['Finish', 'Afronden'],
  'home.action.tryAgain': ['Try again', 'Opnieuw proberen'],

  'home.question.asked': ['{assistant} asked you something.', '{assistant} vroeg je iets.'],
  'home.question.inFeedback': ['In Feedback', 'In Feedback'],
  'home.question.inChat': ['In “{chat}”', 'In “{chat}”'],
  'home.question.inYourChat': ['In your chat with {assistant}', 'In je chat met {assistant}'],

  'home.connection.signInTitle': ['{name} needs you to sign in again', '{name} wil dat je opnieuw inlogt'],
  'home.connection.gatewayUntil': [
    'Whombat can’t read its limits until then.',
    'Tot dan kan Whombat de limieten niet lezen.',
  ],
  'home.connection.assistantUntil': [
    '{assistant} can’t use it until then.',
    'Tot dan kan {assistant} het niet gebruiken.',
  ],
  'home.connection.signInLine': ['Needs you to sign in again', 'Je moet opnieuw inloggen'],
  'home.connection.lastChecked': ['Last checked {time}', 'Laatst gecontroleerd om {time}'],
  'home.connection.notChecked': ['Not checked yet', 'Nog niet gecontroleerd'],
  'home.connection.said': ['{name}: {said}', '{name}: {said}'],
  'home.connection.notAnswering': ['{name} isn’t answering', '{name} reageert niet'],
  'home.connection.pageSaysLeft': [
    'Its page says what is left and when it comes back.',
    'Op de pagina zie je wat er over is en wanneer het terugkomt.',
  ],
  'home.connection.pageSaysMore': ['Its page says more.', 'Op de pagina staat meer.'],
  'home.connection.noAnswer': ['The last check got no answer.', 'De laatste controle kreeg geen antwoord.'],

  'home.run.didntFinish': ['“{name}” didn’t finish', '“{name}” is niet afgerond'],
  'home.run.stopped': ['Its run stopped before the end.', 'De run stopte voor het einde.'],

  'home.chat.new': ['New chat', 'Nieuwe chat'],

  'home.backup.onlyHere': [
    'Right now everything on it is only here: your chats, settings and connections.',
    'Op dit moment staat alles alleen hier: je chats, instellingen en koppelingen.',
  ],
  'home.backup.ownDisk': [
    'A broken disk or a reinstall would take them with it. Backups made so far stay where they are.',
    'Een kapotte schijf of een herinstallatie neemt ze mee. Back-ups die al gemaakt zijn blijven waar ze zijn.',
  ],
  'home.backup.ownDiskTitle': [
    'Your backups are on this Whombat’s own disk. Keep them on {place} instead?',
    'Je back-ups staan op de eigen schijf van deze Whombat. Wil je ze liever op {place} bewaren?',
  ],
  'home.backup.toTitle': ['Back up this Whombat to {place}?', 'Deze Whombat naar {place} back-uppen?'],
  'home.backup.setUpOn': [
    '{intro} Say yes and I’ll set it up on {place}, start the first backup right away and tell you when it’s done.',
    '{intro} Zeg ja en ik stel het in op {place}, start meteen de eerste back-up en laat je weten wanneer die klaar is.',
  ],
  'home.backup.setUpThere': [
    '{intro} Say yes and I’ll set it up there; I may need you to connect it first.',
    '{intro} Zeg ja en ik stel het daar in; misschien moet je het eerst koppelen.',
  ],
  'home.backup.usbBody': [
    '{intro} Name a USB disk WHOMBAT-BACKUP, plug it into your Whombat and say yes.',
    '{intro} Noem een USB-schijf WHOMBAT-BACKUP, steek hem in je Whombat en zeg ja.',
  ],
  'home.backup.yesTo': ['Yes, back up this Whombat to {place}.', 'Ja, back-up deze Whombat naar {place}.'],
  'home.backup.yesUsb': [
    'Yes, back up this Whombat to the disk named WHOMBAT-BACKUP I plugged in.',
    'Ja, back-up deze Whombat naar de schijf met de naam WHOMBAT-BACKUP die ik heb ingestoken.',
  ],
  'home.backup.usbDisk': ['a USB disk', 'een USB-schijf'],
  'home.backup.foundAt': ['the {name} at {address}', 'de {name} op {address}'],
  'home.backup.found': ['the {name}', 'de {name}'],
  'home.backup.failingTitle': [
    'This Whombat’s backups aren’t working',
    'De back-ups van deze Whombat werken niet',
  ],
  'home.backup.failingNone': ['The last backups didn’t finish.', 'De laatste back-ups zijn niet afgerond.'],
  'home.backup.madeBefore': [
    'The backups made before are still there.',
    'De back-ups van eerder zijn er nog.',
  ],
  'home.backup.lateTitle': [
    'This Whombat hasn’t backed up for a while',
    'Deze Whombat heeft al een tijd geen back-up gemaakt',
  ],
  'home.backup.lateBody': [
    'No backup has finished for longer than it should. The backups made before are still there.',
    'Er is al langer dan zou moeten geen back-up afgerond. De back-ups van eerder zijn er nog.',
  ],
  'home.restore.waitingTitle': [
    'Finish bringing your Whombat back',
    'Maak het terugzetten van je Whombat af',
  ],
  'home.restore.waitingBody': [
    'One question is left: is the old Whombat gone, or was it lost or stolen? Until you answer, nothing runs on its own.',
    'Er is nog één vraag: is de oude Whombat weg, of is hij kwijt of gestolen? Tot je antwoordt, gebeurt er niets vanzelf.',
  ],
  'home.restore.stoppedTitle': [
    'Bringing your Whombat back stopped',
    'Het terugzetten van je Whombat is gestopt',
  ],
  'home.restore.stoppedBody': [
    'It restarted before it finished, so it was put back as it was. Your backups are fine. Try again when you like.',
    'Hij startte opnieuw voor het klaar was, dus alles is teruggezet zoals het was. Je back-ups zijn in orde. Probeer het opnieuw wanneer je wilt.',
  ],
  'home.password.title': ['Change the backup password on {place}', 'Wijzig het back-upwachtwoord op {place}'],
  'home.password.placeUnknown': ['the place your backups are on', 'de plek waar je back-ups staan'],
  'home.password.byHand': [
    'Your old Whombat still has the password, so it could keep adding backups there. In Backups, set {place} up by hand again: that gives it a new one.',
    'Je oude Whombat heeft het wachtwoord nog, dus hij kan daar back-ups blijven toevoegen. Stel {place} in Back-ups opnieuw met de hand in: dan krijgt het een nieuw wachtwoord.',
  ],
  'home.password.byHandIt': ['it', 'het'],
  'home.password.typed': [
    'Your old Whombat still has the password, so it could keep adding backups there. Change it on {place}, then give Whombat the new one in Backups.',
    'Je oude Whombat heeft het wachtwoord nog, dus hij kan daar back-ups blijven toevoegen. Wijzig het op {place} en geef Whombat daarna het nieuwe in Back-ups.',
  ],
  'home.password.typedPlace': ['that place', 'die plek'],

  'home.mail.newPassword': ['Email needs a new password', 'E-mail heeft een nieuw wachtwoord nodig'],
  'home.mail.newPasswordBadge': ['Needs a new password', 'Nieuw wachtwoord nodig'],
  'home.mail.countFailed': [
    'Whombat couldn’t count the unread mail just now',
    'Whombat kon de ongelezen mail net niet tellen',
  ],
  'home.mail.unread': ['Unread', 'Ongelezen'],

  'home.hosts.onServer': ['{title} on {server}', '{title} op {server}'],
  'home.hosts.wantsToBeAdded': ['{name} wants to be added', '{name} wil worden toegevoegd'],
  'home.hosts.aServer': ['A server', 'Een server'],
  'home.hosts.askedFrom': ['It asked from {address}.', 'Het vroeg het vanaf {address}.'],
  'home.hosts.letItIn': [
    'Let it in to start watching it, or turn it away.',
    'Laat hem toe om hem in de gaten te houden, of wijs hem af.',
  ],
  'home.hosts.worthALook': ['Worth a look', 'Even naar kijken'],
  'home.hosts.alert': ['Alert', 'Melding'],
});
