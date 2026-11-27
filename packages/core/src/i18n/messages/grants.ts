import { splitPairs } from './pairs.js';

/** Approval, key-grant, council, catalog-field and host-install words. */
export const GRANTS_MESSAGES = splitPairs({
  // The lasting yes on a risk row's action: `verb` comes in the reader's language.
  'alwaysAllow.title': ['Let {agent} {verb} without asking?', '{agent} laten {verb} zonder te vragen?'],

  // Keys changes as people read them (the signed audit text stays English).
  'grantChange.scope': [
    'Changed where {agent}’s “{label}” key works',
    'Gewijzigd waar de sleutel “{label}” van {agent} werkt',
  ],
  'grantChange.markedNone': [
    'Marked “{label}” as a key {agent} doesn’t hold',
    '“{label}” gemarkeerd als sleutel die {agent} niet heeft',
  ],
  'grantChange.taken': ['Took {agent}’s “{label}” key away', 'Sleutel “{label}” van {agent} afgenomen'],
  'grantChange.noLongerAsks': [
    'Let {agent} use “{label}” without asking',
    '{agent} mag “{label}” nu gebruiken zonder te vragen',
  ],
  'grantChange.gave': ['Gave {agent} a new key: {label}', '{agent} een nieuwe sleutel gegeven: {label}'],
  'grantChange.toAsk': [
    'Moved {agent}’s “{label}” key to ask first',
    'Sleutel “{label}” van {agent} op eerst vragen gezet',
  ],
  'grantChange.gaveAsks': [
    'Gave {agent} a new key that asks first: {label}',
    '{agent} een nieuwe sleutel gegeven die eerst vraagt: {label}',
  ],
  'grantChange.summary': [
    { one: '{count} key · {askFirst} ask first', other: '{count} keys · {askFirst} ask first' },
    { one: '{count} sleutel · {askFirst} eerst vragen', other: '{count} sleutels · {askFirst} eerst vragen' },
  ],

  'councilSeats.tooFew': [
    'A council needs at least two seats.',
    'Een raad heeft minstens twee zetels nodig.',
  ],
  'councilSeats.tooMany': ['A council has at most {max} seats.', 'Een raad heeft hoogstens {max} zetels.'],
  'councilSeats.oneCompany': [
    'A council needs AIs from two different companies.',
    'Een raad heeft AI’s van twee verschillende bedrijven nodig.',
  ],
  'councilSeats.twice': ['The same model sits on it twice.', 'Hetzelfde model zit er twee keer in.'],

  // A connect form's field problems; the field's label comes from the catalog as it is.
  'catalogField.needed': ['{label} is needed.', '{label} is nodig.'],
  'catalogField.tooLong': ['{label} is too long.', '{label} is te lang.'],
  'catalogField.guideTooLong': ['Keep it under 1 500 characters.', 'Houd het onder de 1.500 tekens.'],
  'catalogField.pick': ['Pick one of the choices for {label}.', 'Kies een van de keuzes voor {label}.'],
  'catalogField.check': ['Check the value for {label}.', 'Controleer de waarde voor {label}.'],
  'catalogField.unknown': ['This connection has no such field.', 'Deze koppeling heeft zo’n veld niet.'],

  'hostInstall.not_allowed': ['Whombat doesn’t sign in to {address}.', 'Whombat logt niet in op {address}.'],
  'hostInstall.unreachable': [
    'Nothing answers at {address}. Is the address right, and is the server on?',
    'Er antwoordt niets op {address}. Klopt het adres, en staat de server aan?',
  ],
  'hostInstall.host_key_changed': [
    '{server} showed a different key than the one your Vault trusts, so Whombat sent nothing. If the server was reinstalled, trust its new key in the Vault first.',
    '{server} liet een andere sleutel zien dan die je Kluis vertrouwt, dus Whombat heeft niets gestuurd. Is de server opnieuw geïnstalleerd? Vertrouw dan eerst de nieuwe sleutel in de Kluis.',
  ],
  'hostInstall.sign_in_failed.password': [
    'Couldn’t sign in to {address}: the user name or password isn’t right.',
    'Inloggen op {address} lukte niet: de gebruikersnaam of het wachtwoord klopt niet.',
  ],
  'hostInstall.sign_in_failed.key': [
    'Couldn’t sign in to {address}: the user name or key isn’t right.',
    'Inloggen op {address} lukte niet: de gebruikersnaam of de sleutel klopt niet.',
  ],
  'hostInstall.sudo_password_needed': [
    'Signed in, but sudo on {address} asks for a password. Add it under “Password for sudo”.',
    'Ingelogd, maar sudo op {address} vraagt om een wachtwoord. Vul het in bij “Wachtwoord voor sudo”.',
  ],
  'hostInstall.sudo_refused.mac': [
    'Signed in, but this user may not use sudo on {address}. Sign in as an administrator of the Mac.',
    'Ingelogd, maar deze gebruiker mag sudo niet gebruiken op {address}. Log in als beheerder van de Mac.',
  ],
  'hostInstall.sudo_refused': [
    'Signed in, but this user may not use sudo on {address}. Use root or a user that may.',
    'Ingelogd, maar deze gebruiker mag sudo niet gebruiken op {address}. Gebruik root of een gebruiker die het wel mag.',
  ],
  'hostInstall.no_downloader': [
    '{address} has neither curl nor wget. Install one of them and try again.',
    '{address} heeft geen curl en geen wget. Installeer een van de twee en probeer het opnieuw.',
  ],
  'hostInstall.cant_reach_whombat.at': [
    '{server} can’t reach this Whombat at {whombat}. Is it on another network?',
    '{server} kan deze Whombat niet bereiken op {whombat}. Zit hij op een ander netwerk?',
  ],
  'hostInstall.cant_reach_whombat': [
    '{server} can’t reach this Whombat. Is it on another network?',
    '{server} kan deze Whombat niet bereiken. Zit hij op een ander netwerk?',
  ],
  'hostInstall.unsupported.macOld': [
    'Whombat’s helper needs macOS {min} or later, and {address} has macOS {version}. Update the Mac first.',
    'Whombats helper heeft macOS {min} of nieuwer nodig, en {address} heeft macOS {version}. Werk de Mac eerst bij.',
  ],
  'hostInstall.unsupported.macUnknown': [
    'Whombat’s helper needs macOS {min} or later, and Whombat couldn’t tell which macOS {address} has.',
    'Whombats helper heeft macOS {min} of nieuwer nodig, en Whombat kon niet zien welke macOS {address} heeft.',
  ],
  'hostInstall.unsupported': [
    'Whombat’s helper can’t run on {address}: it needs Linux or macOS {min} or later on a 64-bit Intel, AMD or ARM processor. “More detail” says what was missing.',
    'Whombats helper kan niet draaien op {address}: hij heeft Linux of macOS {min} of nieuwer nodig op een 64-bit Intel-, AMD- of ARM-processor. “Meer details” zegt wat er ontbrak.',
  ],
  'hostInstall.other_whombat': [
    'This server reports to another Whombat. Remove Whombat’s helper there first.',
    'Deze server meldt zich bij een andere Whombat. Haal Whombats helper daar eerst weg.',
  ],
  'hostInstall.timed_out.installed': [
    'It’s installed, but its first report hasn’t come in yet. It shows up once it does.',
    'Hij is geïnstalleerd, maar zijn eerste melding is nog niet binnen. Hij verschijnt zodra die er is.',
  ],
  'hostInstall.timed_out': [
    '{address} took too long to answer, so Whombat stopped.',
    '{address} deed er te lang over om te antwoorden, dus Whombat is gestopt.',
  ],
  'hostInstall.failed': [
    'Putting Whombat’s helper on {address} didn’t work. “More detail” shows what the installer said.',
    'Whombats helper op {address} zetten is niet gelukt. “Meer details” laat zien wat het installatieprogramma zei.',
  ],

  'hostAddressChange.one': ['{name} hasn’t found it yet', '{name} heeft het nog niet gevonden'],
  'hostAddressChange.many': ['{n} servers haven’t found it yet', '{n} servers hebben het nog niet gevonden'],
  'hostAddressChange.text': [
    'Your Whombat’s address changed from {from} to {to}, and {who}.',
    'Het adres van je Whombat is veranderd van {from} naar {to}, en {who}.',
  ],

  // Why a Mac's screen step didn't work; the Mac's own words (`said`) come through as it wrote them.
  'hostScreen.no_screen.off': ['Screen Sharing is off on {server}.', 'Scherm delen staat uit op {server}.'],
  'hostScreen.no_screen': [
    '{said} Switch it on in System Settings → General → Sharing.',
    '{said} Zet het aan in Systeeminstellingen → Algemeen → Delen.',
  ],
  'hostScreen.no_account': [
    'Whombat doesn’t have {server}’s password for the screen yet. Set it on the Mac’s page.',
    'Whombat heeft het schermwachtwoord van {server} nog niet. Stel het in op de pagina van de Mac.',
  ],
  'hostScreen.sign_in_failed': [
    '{server} didn’t take the password Whombat has for its screen. Set it again on the Mac’s page.',
    '{server} accepteerde het schermwachtwoord van Whombat niet. Stel het opnieuw in op de pagina van de Mac.',
  ],
  'hostScreen.no_helper': [
    'Whombat Helper isn’t running on {server}.',
    'Whombat Helper draait niet op {server}.',
  ],
  'hostScreen.no_access': [
    'Whombat Helper on {server} needs Accessibility. Switch it on in Privacy & Security → Accessibility.',
    'Whombat Helper op {server} heeft Toegankelijkheid nodig. Zet het aan in Privacy en beveiliging → Toegankelijkheid.',
  ],
  'hostScreen.not_admin': [
    'Whombat signs in to {server}’s screen as a user who isn’t an administrator, so it can’t answer this password prompt. Open the screen and switch on Whombat Helper in Privacy & Security → Accessibility yourself.',
    'Whombat logt op het scherm van {server} in als een gebruiker die geen beheerder is, dus kan het deze wachtwoordvraag niet beantwoorden. Open het scherm en zet Whombat Helper zelf aan in Privacy en beveiliging → Toegankelijkheid.',
  ],
  'hostScreen.not_found': [
    'Nothing on {server}’s screen has that name.',
    'Niets op het scherm van {server} heeft die naam.',
  ],
  'hostScreen.locked': ['{server}’s screen is locked.', 'Het scherm van {server} is vergrendeld.'],
  'hostScreen.no_prompt': [
    'Nothing on {server}’s screen is asking for its password right now.',
    'Niets op het scherm van {server} vraagt nu om het wachtwoord.',
  ],
  'hostScreen.busy': [
    '{server} is busy with another screen step. Try again in a moment.',
    '{server} is bezig met een andere schermstap. Probeer het zo opnieuw.',
  ],
  'hostScreen.timeout': [
    '{server}’s screen didn’t answer in time.',
    'Het scherm van {server} antwoordde niet op tijd.',
  ],
  'hostScreen.unsupported': [
    '{server} can’t do that: it isn’t a Mac, or its Whombat helper needs an update.',
    '{server} kan dat niet: het is geen Mac, of Whombats helper erop moet worden bijgewerkt.',
  ],
  'hostScreen.invalid_request': [
    '{server} couldn’t do that on its screen.',
    '{server} kon dat niet doen op zijn scherm.',
  ],
  'hostScreen.failed': [
    'That didn’t work on {server}’s screen.',
    'Dat lukte niet op het scherm van {server}.',
  ],

  'hostSelf.guestLabel': ['This Whombat', 'Deze Whombat'],
  'hostSelf.serverPower': ['This Whombat goes down too.', 'Deze Whombat gaat dan ook uit.'],
});
