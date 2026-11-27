import { treeCatalogs } from '../tree';

/** One passkey for the account, every Whombat and the backups (`managed/one-passkey.ts`). */
export const ONE_PASSKEY_WORDS = treeCatalogs(
  'onePasskey',
  {
    action: 'Finish setup',
    intro:
      'Use the same passkey for your account, every Whombat and your backups. Each Whombat checks access and its saved backups.',
    checking: 'Checking your passkey…',
    cancelled:
      'The check stopped. Choose “Finish setup” to continue with the same passkey. Your existing access has been kept.',
    ready: 'Your passkey is ready on all your Whombats.',
    removed:
      'Retired: {names}. You can delete their old items from your password manager. Keep the shared passkey you just used.',
    kept: 'Keep your older passkeys for now. Some still protect saved backup details or open a Whombat that hasn’t been checked.',
    pending: 'Your passkey is saved. Still to check:',
    progress: '{name} · Whombat {index} of {total}. {step}',
    thisWhombat: 'This Whombat',
    steps: {
      create: 'Save your passkey in your password manager.',
      unlock: 'Touch your passkey to prepare access.',
      link: 'Touch your passkey to check access.',
      linkAndVerify: 'Touch your passkey to check access and saved backups.',
      verify: 'Touch your passkey to check the saved backup details.',
    },
    why: {
      setup: 'set up this device there first',
      backups: 'backup details are being saved; try again in a moment',
      offline: 'bring it online, then try again',
      other: 'the check didn’t finish; try again',
    },
    backupsUnlocked: 'Backups on the Whombats checked are unlocked by this passkey.',
    backupsChecked: 'Your backups have been checked with this passkey.',
  },
  {
    action: 'Instellen afronden',
    intro:
      'Gebruik dezelfde passkey voor je account, elke Whombat en je back-ups. Elke Whombat controleert de toegang en zijn bewaarde back-ups.',
    checking: 'Je passkey controleren…',
    cancelled:
      'De controle is gestopt. Kies “Instellen afronden” om verder te gaan met dezelfde passkey. Je bestaande toegang is behouden.',
    ready: 'Je passkey is klaar op al je Whombats.',
    removed:
      'Niet meer in gebruik: {names}. Je kunt de oude items ervan uit je wachtwoordbeheerder verwijderen. Houd de gedeelde passkey die je net gebruikte.',
    kept: 'Houd je oudere passkeys voorlopig. Sommige beschermen nog bewaarde back-upgegevens of openen een Whombat die nog niet is gecontroleerd.',
    pending: 'Je passkey is bewaard. Nog te controleren:',
    progress: '{name} · Whombat {index} van {total}. {step}',
    thisWhombat: 'Deze Whombat',
    steps: {
      create: 'Bewaar je passkey in je wachtwoordbeheerder.',
      unlock: 'Raak je passkey aan om de toegang voor te bereiden.',
      link: 'Raak je passkey aan om de toegang te controleren.',
      linkAndVerify: 'Raak je passkey aan om de toegang en bewaarde back-ups te controleren.',
      verify: 'Raak je passkey aan om de bewaarde back-upgegevens te controleren.',
    },
    why: {
      setup: 'stel dit apparaat daar eerst in',
      backups: 'de back-upgegevens worden bewaard; probeer het zo opnieuw',
      offline: 'zet hem online en probeer het dan opnieuw',
      other: 'de controle is niet afgerond; probeer het opnieuw',
    },
    backupsUnlocked: 'Back-ups op de gecontroleerde Whombats worden met deze passkey ontgrendeld.',
    backupsChecked: 'Je back-ups zijn met deze passkey gecontroleerd.',
  },
);
