import { splitPairs } from './pairs.js';

/** A 1Password vault kept in step with the Vault (`vault/onepassword-view.ts`). */
export const ONEPASSWORD = splitPairs({
  'onePassword.word.tag': ['1Password', '1Password'],
  'onePassword.word.syncNow': ['Sync now', 'Nu synchroniseren'],
  'onePassword.word.notInVault': ['Not in your Vault', 'Niet in je kluis'],
  'onePassword.word.notChecked': ['Not checked yet', 'Nog niet gecontroleerd'],
  'onePassword.word.readOnly': [
    'This token can only read. Make one that can read and write the vault.',
    'Deze token kan alleen lezen. Maak er een die de 1Password-kluis kan lezen en schrijven.',
  ],
  'onePassword.word.stopped': [
    '1Password sync stopped unexpectedly',
    '1Password-synchronisatie is onverwacht gestopt',
  ],
  'onePassword.word.unreachable': ['Whombat can’t reach 1Password.', 'Whombat kan 1Password niet bereiken.'],
  'onePassword.word.pending': ['Waiting to go to 1Password', 'Wacht om naar 1Password te gaan'],
  'onePassword.word.removeHere': ['Remove them here too', 'Hier ook verwijderen'],
  'onePassword.word.keepHere': ['Keep them here', 'Hier houden'],
  'onePassword.word.disconnectKeep': ['Keep the entries in your Vault', 'De items in je kluis houden'],
  'onePassword.word.disconnectRemove': ['Remove them too', 'Ze ook verwijderen'],
  'onePassword.word.removeArchives': [
    'Its item in 1Password goes to 1Password’s archive.',
    'Het item in 1Password gaat naar het archief van 1Password.',
  ],

  'onePassword.skip.no_website': ['No website', 'Geen website'],
  'onePassword.skip.no_hostname': ['No hostname', 'Geen hostnaam'],
  'onePassword.skip.no_username': ['No username', 'Geen gebruikersnaam'],
  'onePassword.skip.no_password': ['No password', 'Geen wachtwoord'],
  'onePassword.skip.no_credential': ['No credential', 'Geen inloggegeven'],
  'onePassword.skip.bad_address': ['Whombat can’t use this address', 'Whombat kan dit adres niet gebruiken'],
  'onePassword.skip.unreachable': [
    'Whombat may not reach this address',
    'Whombat mag dit adres misschien niet bereiken',
  ],
  'onePassword.skip.bad_totp': [
    'Whombat can’t read its one-time password',
    'Whombat kan het eenmalige wachtwoord niet lezen',
  ],
  'onePassword.skip.too_long': ['Too long for your Vault', 'Te lang voor je kluis'],
  'onePassword.skip.bad_value': [
    'It holds characters Whombat can’t use',
    'Het bevat tekens die Whombat niet kan gebruiken',
  ],
  'onePassword.skip.vault_full': ['Your Vault is full', 'Je kluis is vol'],
  'onePassword.skip.ssh_key': ['SSH keys stay in 1Password', 'SSH-sleutels blijven in 1Password'],
  'onePassword.skip.other_kind': [
    'Only logins and API credentials come in',
    'Alleen logins en API-inloggegevens komen binnen',
  ],
  'onePassword.skip.unreadable': ['Whombat couldn’t read this item', 'Whombat kon dit item niet lezen'],

  'onePassword.keptNone': [
    'No logins or API tokens kept in step yet',
    'Nog geen logins of API-tokens gelijk gehouden',
  ],
  'onePassword.kept': [
    { one: '1 login or API token kept in step', other: '{count} logins and API tokens kept in step' },
    { one: '1 login of API-token gelijk gehouden', other: '{count} logins en API-tokens gelijk gehouden' },
  ],
  'onePassword.checked': ['Last checked {ago}', 'Laatst gecontroleerd {ago}'],
  'onePassword.gone': [
    { one: '1Password says 1 item is gone', other: '1Password says {count} items are gone' },
    { one: '1Password zegt dat 1 item weg is', other: '1Password zegt dat {count} items weg zijn' },
  ],
  'onePassword.heldMore': ['{names} and {n} more', '{names} en nog {n}'],
  'onePassword.removals': [
    {
      one: 'Whombat kept {names} in your Vault for now. Remove it here too, or keep it only in Whombat.',
      other:
        'Whombat kept {names} in your Vault for now. Remove them here too, or keep them only in Whombat.',
    },
    {
      one: 'Whombat heeft {names} voorlopig in je kluis gehouden. Verwijder het hier ook, of houd het alleen in Whombat.',
      other:
        'Whombat heeft {names} voorlopig in je kluis gehouden. Verwijder ze hier ook, of houd ze alleen in Whombat.',
    },
  ],
  'onePassword.waiting': [
    'Waiting for 1Password’s limit. Next try at {clock}.',
    'Wachten op de limiet van 1Password. Volgende poging om {clock}.',
  ],
  'onePassword.entry': ['Kept in step with 1Password', 'Gelijk gehouden met 1Password'],
  'onePassword.entryAgo': ['Kept in step with 1Password · {ago}', 'Gelijk gehouden met 1Password · {ago}'],
});
