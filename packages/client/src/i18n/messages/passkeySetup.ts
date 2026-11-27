import { treeCatalogs } from '../tree';

/** Setting up the one passkey (`managed/passkey-setup.ts`). */
export const PASSKEY_SETUP_WORDS = treeCatalogs(
  'passkeySetup',
  {
    empty: 'Set up your passkey',
    incomplete: 'Finish setting up your passkey',
    ready: 'Passkey ready',
    intro: 'One passkey to sign in, open all your Whombats and unlock your backups.',
    setup: 'Set up my passkey',
    finish: 'Finish setup',
    check: 'Check my passkey',
    checking: 'Checking your passkey…',
    settingUp: 'Setting up your passkey',
    loading: 'Loading your passkey…',
    loadError: 'Couldn’t check your passkey. Try again.',
    unsupported:
      'Your browser or passkey provider couldn’t finish setting up backup access. Update both, then finish setup with the same passkey.',
    details: 'Passkey details',
    detailsMetaNone: 'Which passkeys this Whombat accepts',
    detailsMeta: {
      one: 'Your passkey and which ones this Whombat accepts',
      other: 'Your {count} passkeys and which ones this Whombat accepts',
    },
    saving: 'Your backup details are being saved. Finish setup in a moment.',
    readyMeta: 'Your passkey signs you in, opens your Whombats and unlocks your backups.',
    noBackups:
      'Your passkey signs you in and opens your Whombats. It will protect your backups when you set them up.',
  },
  {
    empty: 'Stel je passkey in',
    incomplete: 'Maak je passkey af',
    ready: 'Passkey klaar',
    intro: 'Eén passkey om in te loggen, al je Whombats te openen en je back-ups te ontgrendelen.',
    setup: 'Mijn passkey instellen',
    finish: 'Instellen afmaken',
    check: 'Mijn passkey controleren',
    checking: 'Je passkey controleren…',
    settingUp: 'Je passkey instellen',
    loading: 'Je passkey laden…',
    loadError: 'Kon je passkey niet controleren. Probeer het opnieuw.',
    unsupported:
      'Je browser of passkeyprovider kon de toegang tot je back-ups niet afmaken. Werk ze allebei bij en maak het instellen daarna af met dezelfde passkey.',
    details: 'Passkeygegevens',
    detailsMetaNone: 'Welke passkeys deze Whombat accepteert',
    detailsMeta: {
      one: 'Je passkey en welke deze Whombat accepteert',
      other: 'Je {count} passkeys en welke deze Whombat accepteert',
    },
    saving: 'De gegevens van je back-ups worden opgeslagen. Maak het instellen zo meteen af.',
    readyMeta: 'Met je passkey log je in, open je je Whombats en ontgrendel je je back-ups.',
    noBackups:
      'Met je passkey log je in en open je je Whombats. Hij beschermt je back-ups zodra je die instelt.',
  },
);
