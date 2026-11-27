import { treeCatalogs } from '../../tree';

/** One passkey for every Whombat: signing in with it, Settings → Devices → PASSKEYS, its notices and its failures (`managed/passkeys.ts`). */
export const PASSKEY_WORDS = treeCatalogs(
  'hostManaged.passkeys',
  {
    signIn: 'Sign in with a passkey',
    signInHint: 'Your passkey signs you in, opens your Whombats and unlocks your backups.',
    or: 'or',
    opening: 'Opening {name}…',
    openingYours: 'Opening your Whombat…',
    openingText: 'Your Whombat is checking your passkey. This takes a moment.',
    setupWay: 'Your passkey, if you’ve already set it up.',
    setupUse: 'Use a passkey',
    otherWay: 'Set up this device another way',
    notInOrg:
      'This passkey is for a Whombat that isn’t in your organization. You’re signed in; pick a Whombat.',
    retired:
      'That passkey was for {name}, which was retired, so it can’t open anything. Pick your Whombat; once it opens, you can add a new passkey.',
    retiredSome:
      'That passkey was for a Whombat, which was retired, so it can’t open anything. Pick your Whombat; once it opens, you can add a new passkey.',
    section: 'PASSKEYS',
    intro: 'One passkey to sign in, open all your Whombats and unlock your backups.',
    none: 'Set up your passkey',
    add: 'Set up my passkey',
    remove: 'Remove',
    removed: 'Passkey removed.',
    removeConfirm:
      'Remove the passkey “{name}”? It won’t open this Whombat any more. Devices it already set up stay until you remove them.',
    synced: 'Synced',
    syncedLabel: 'Synced: it can open this Whombat on your other devices too',
    thisDevice: 'On one device',
    thisDeviceLabel: 'Stays on the device it was made on',
    created: 'Added {date}',
    lastUsed: 'Last used {ago}',
    neverUsed: 'Not used yet',
    current: 'Set up this device',
    policy: 'Only passkeys that stay on one device',
    policyMeta:
      'Synced passkeys (Google Password Manager, iCloud Keychain) can’t be added or open this Whombat on a new device.',
    policyOn: 'Only passkeys that stay on one device are accepted now.',
    policyOff: 'Synced passkeys are accepted again.',
    unavailable: 'This browser can’t make passkeys.',
    unavailablePhone: 'This phone can’t make passkeys.',
    loadError: 'Couldn’t load your passkeys. Try again.',
    newDevice: 'New device signed in with a passkey: {label}',
    newDeviceMeta: 'Signed in with a passkey',
    review: 'Review',
    seen: 'OK',
    nudge: 'One passkey to sign in, open all your Whombats and unlock your backups.',
    nudgeAdd: 'Set up my passkey',
    nudgeLater: 'Not now',
    errors: {
      challengeMismatch:
        'Whombat’s servers sent a sign-in request this device didn’t expect, so nothing was signed. Try again.',
      optionsMismatch:
        'Whombat’s servers sent a passkey request that doesn’t match your Whombat, so no passkey was made. Try again.',
      invalid:
        'That passkey didn’t open your Whombat. It may have been removed. Sign in with your email instead.',
      gone: 'That passkey was for a Whombat that’s gone, so it can’t open anything. Sign in with your email; once your Whombat opens, you can add a new passkey.',
      kept: 'That passkey was for a Whombat that’s gone. It’s kept only to open that Whombat’s recovery kit. Sign in with your email.',
      notAllowed:
        'This Whombat only accepts passkeys that stay on one device, and this one syncs. Use another way in.',
      limit: 'You already have 20 passkeys for this Whombat. Remove one in Settings → Devices first.',
      exists: 'This device already has a passkey for this Whombat.',
      unsupported: 'Passkeys don’t work here. Sign in with your email instead.',
      none: 'There’s no passkey for your Whombat on this device. Sign in another way, then add one in Devices.',
      controlFailed:
        'Your Whombat saved the passkey but Whombat’s servers didn’t, so it was removed again. Try again in a moment.',
      rateLimited: 'Too many tries. Wait a few minutes, then try again.',
      unreachable: 'Couldn’t reach Whombat. Check your connection and try again.',
      failed: 'That didn’t work. Try again.',
    },
  },
  {
    signIn: 'Inloggen met een passkey',
    signInHint: 'Met je passkey log je in, open je je Whombats en ontgrendel je je back-ups.',
    or: 'of',
    opening: '{name} openen…',
    openingYours: 'Je Whombat openen…',
    openingText: 'Je Whombat controleert je passkey. Dit duurt even.',
    setupWay: 'Je passkey, als je die al hebt ingesteld.',
    setupUse: 'Passkey gebruiken',
    otherWay: 'Dit apparaat op een andere manier instellen',
    notInOrg:
      'Deze passkey is voor een Whombat die niet in je organisatie zit. Je bent ingelogd; kies een Whombat.',
    retired:
      'Die passkey was voor {name}, die is buiten gebruik gesteld, dus hij kan niets openen. Kies je Whombat; zodra die opent, kun je een nieuwe passkey toevoegen.',
    retiredSome:
      'Die passkey was voor een Whombat die buiten gebruik is gesteld, dus hij kan niets openen. Kies je Whombat; zodra die opent, kun je een nieuwe passkey toevoegen.',
    section: 'PASSKEYS',
    intro: 'Eén passkey om in te loggen, al je Whombats te openen en je back-ups te ontgrendelen.',
    none: 'Stel je passkey in',
    add: 'Mijn passkey instellen',
    remove: 'Verwijderen',
    removed: 'Passkey verwijderd.',
    removeConfirm:
      'De passkey “{name}” verwijderen? Hij opent deze Whombat dan niet meer. Apparaten die hij al heeft ingesteld blijven tot je ze verwijdert.',
    synced: 'Gesynchroniseerd',
    syncedLabel: 'Gesynchroniseerd: hij kan deze Whombat ook op je andere apparaten openen',
    thisDevice: 'Op één apparaat',
    thisDeviceLabel: 'Blijft op het apparaat waarop hij is gemaakt',
    created: 'Toegevoegd {date}',
    lastUsed: 'Laatst gebruikt {ago}',
    neverUsed: 'Nog niet gebruikt',
    current: 'Heeft dit apparaat ingesteld',
    policy: 'Alleen passkeys die op één apparaat blijven',
    policyMeta:
      'Gesynchroniseerde passkeys (Google Wachtwoordmanager, iCloud-sleutelhanger) kunnen niet worden toegevoegd en openen deze Whombat niet op een nieuw apparaat.',
    policyOn: 'Alleen passkeys die op één apparaat blijven worden nu geaccepteerd.',
    policyOff: 'Gesynchroniseerde passkeys worden weer geaccepteerd.',
    unavailable: 'Deze browser kan geen passkeys maken.',
    unavailablePhone: 'Deze telefoon kan geen passkeys maken.',
    loadError: 'Je passkeys konden niet worden geladen. Probeer het opnieuw.',
    newDevice: 'Nieuw apparaat ingelogd met een passkey: {label}',
    newDeviceMeta: 'Ingelogd met een passkey',
    review: 'Bekijken',
    seen: 'OK',
    nudge: 'Eén passkey om in te loggen, al je Whombats te openen en je back-ups te ontgrendelen.',
    nudgeAdd: 'Mijn passkey instellen',
    nudgeLater: 'Niet nu',
    errors: {
      challengeMismatch:
        'De servers van Whombat stuurden een inlogverzoek dat dit apparaat niet verwachtte, dus er is niets ondertekend. Probeer het opnieuw.',
      optionsMismatch:
        'De servers van Whombat stuurden een passkeyverzoek dat niet bij je Whombat past, dus er is geen passkey gemaakt. Probeer het opnieuw.',
      invalid:
        'Die passkey opende je Whombat niet. Misschien is hij verwijderd. Log in plaats daarvan in met je e-mailadres.',
      gone: 'Die passkey was voor een Whombat die er niet meer is, dus hij kan niets openen. Log in met je e-mailadres; zodra je Whombat opent, kun je een nieuwe passkey toevoegen.',
      kept: 'Die passkey was voor een Whombat die er niet meer is. Hij is alleen bewaard om het herstelpakket van die Whombat te openen. Log in met je e-mailadres.',
      notAllowed:
        'Deze Whombat accepteert alleen passkeys die op één apparaat blijven, en deze synchroniseert. Probeer een andere manier.',
      limit: 'Je hebt al 20 passkeys voor deze Whombat. Verwijder er eerst een in Instellingen → Apparaten.',
      exists: 'Dit apparaat heeft al een passkey voor deze Whombat.',
      unsupported: 'Passkeys werken hier niet. Log in plaats daarvan in met je e-mailadres.',
      none: 'Er staat geen passkey voor je Whombat op dit apparaat. Log op een andere manier in en voeg er dan een toe bij Apparaten.',
      controlFailed:
        'Je Whombat heeft de passkey bewaard, maar de servers van Whombat niet, dus hij is weer verwijderd. Probeer het zo opnieuw.',
      rateLimited: 'Te veel pogingen. Wacht een paar minuten en probeer het dan opnieuw.',
      unreachable: 'Whombat is niet bereikbaar. Controleer je verbinding en probeer het opnieuw.',
      failed: 'Dat lukte niet. Probeer het opnieuw.',
    },
  },
);
