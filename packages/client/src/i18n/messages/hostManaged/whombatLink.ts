import { treeCatalogs } from '../../tree';

/**
 * Reach in This Whombat (Whombat Link, its address, Tailscale), Easy or Expert, the update channel, the Link-ended
 * banner, the setup on the box's page and the boxes this device knows (`managed/whombat-link.ts`). The offer sentence
 * with the price is the contracts' (`linkOfferText`).
 */
export const WHOMBAT_LINK_WORDS = treeCatalogs(
  'hostManaged.whombatLink',
  {
    choice: {
      title: 'How will you reach this Whombat?',
      sub: 'You can change this later in Settings.',
      easy: {
        kind: 'Easy',
        name: 'Whombat Link',
        label: 'Easy · Whombat Link',
        tag: 'Recommended',
        more: 'What you get',
        points: {
          one: 'Open your Whombat from anywhere, without port forwarding',
          two: 'Its own secure web address',
          three: 'Notifications on your iPhone and Android phone',
          four: 'The Whombat apps away from home',
          five: 'Sign-ins like Google work',
          six: 'Supports Whombat’s open-source work',
        },
      },
      expert: {
        kind: 'Expert',
        name: 'Tailscale or Headscale',
        label: 'Expert · Tailscale or Headscale',
        tag: 'Free',
        line: 'You set up Tailscale on each of your devices.',
        more: 'What to know',
        points: {
          one: 'No notifications on your phone while the app is closed',
          two: 'Some sign-ins, like Google, aren’t available',
        },
      },
    },
    reach: {
      section: 'REACH',
      link: {
        name: 'Whombat Link',
        off: 'Whombat Link is off',
        offMetaPlain: 'This Whombat works at home and on Tailscale.',
        turnOn: 'Turn on',
        turningOn: 'Turning on…',
        starting: 'Waiting for you to confirm',
        enter: 'Open {where} and enter {code}.',
        left: 'The code works for {time} more.',
        codeOver: 'The code ran out.',
        newCode: 'New code',
        startingPlain: 'Whombat Link is starting',
        startingPlainMeta: 'Finish it where you turned it on.',
        gettingCode: 'Getting a code…',
        waitingAddress: 'Waiting for an address',
        waitingAddressMeta: 'Your address usually comes within a few minutes. It arrives by itself.',
        on: 'Whombat Link is on',
        onMeta: 'Open this Whombat from anywhere, with notifications on your phones.',
        trial: 'Free month until {date}.',
        account: 'Linked to {email}.',
        turnOff: 'Turn off',
        turningOff: 'Turning off…',
        cancel: 'Cancel',
        grace: 'Whombat Link ends on {date}',
        graceMeta:
          'After that, this Whombat works at home and on Tailscale. Turn on Tailscale now as a second way in.',
        graceKeep: 'To keep it, subscribe at app.whombat.com.',
        ended: 'Whombat Link ended',
        endedMeta:
          'This Whombat works at home and on Tailscale. Your data, agents, automations, backups and updates are all still here.',
        endedBack: 'To turn it on again, subscribe at app.whombat.com.',
        offConfirm: 'Turn off Whombat Link?',
        offConfirmMeta:
          'Your Whombat’s address and notifications on your phones stop. It keeps working at home and on Tailscale.',
        errors: {
          unavailable: 'Whombat Link isn’t available on this Whombat.',
          busy: 'Whombat Link is changing. Try again in a moment.',
          rateLimited: 'Too many tries. Wait a few minutes, then try again.',
          unreachable: 'Whombat’s service didn’t answer. Try again in a moment.',
          failed: 'That didn’t work. Try again.',
        },
      },
      address: {
        title: 'Its address',
        none: 'No address yet',
        noneMeta: 'It gets one when Whombat Link is on.',
        coming: 'Getting its address…',
        comingMeta: 'Its own web address shows here once it’s ready.',
      },
      tailscale: {
        title: 'Tailscale',
        on: 'On as {name}',
        off: 'Off',
        signIn: 'Waiting for you to sign in',
        turnOn: 'Turn on Tailscale',
        keyExpiry:
          'In Tailscale’s admin console, turn off key expiry for this Whombat. Otherwise Tailscale signs it out after a few months and you can’t reach it away from home.',
      },
      banner: {
        grace:
          'Whombat Link ends on {date}. Turn on Tailscale so you can still reach this Whombat away from home.',
        graceTailscale:
          'Whombat Link ends on {date}. You can still reach this Whombat at home and on Tailscale.',
        ended:
          'Whombat Link ended. This Whombat still works at home. Turn on Tailscale to reach it away from home.',
        endedTailscale: 'Whombat Link ended. This Whombat still works at home and on Tailscale.',
      },
      offer: {
        turnOn: 'Turn on Whombat Link',
        notNow: 'Not now',
      },
    },
    channel: {
      title: 'Updates from',
      label: 'Update channel',
      production: 'Production',
      development: 'Beta',
      productionMeta: 'Tested versions. This is right for almost everyone.',
      developmentMeta: 'New versions first, before they’re fully tested. Something may break.',
      staysOn: 'This Whombat keeps {release} until Production has a newer version, then moves on by itself.',
      switchedProduction: 'This Whombat takes Production updates.',
      switchedDevelopment: 'This Whombat takes Beta updates.',
      unavailable: 'This Whombat can’t choose where its updates come from.',
      failed: 'That didn’t work. Try again.',
    },
    boxSetup: {
      steps: {
        link: { t: 'Add your Whombat', d: 'To your account' },
        claim: { t: 'Claim your Whombat', d: 'The letters on its screen' },
        account: { t: 'Who are you?', d: 'It stays on this Whombat' },
        passkey: { t: 'Make its passkey', d: 'For this Whombat only' },
        reach: { t: 'Reach it from anywhere', d: 'Tailscale or Whombat Link' },
        ai: { t: 'Set up your AI', d: 'Pick and sign in' },
      },
      stepLabel: 'STEP {n} OF {of}',
      account: {
        title: 'Who are you?',
        sub: 'This Whombat is yours alone. Your name is how your agent greets you.',
        tip: 'Your name and email stay on this Whombat.',
      },
      name: {
        hint: 'How your agent greets you.',
      },
      reach: {
        title: 'Reach it from anywhere',
        sub: 'Use this Whombat away from home with Tailscale, or with Whombat Link.',
        tip: 'You can change this later in Settings → This Whombat.',
        onTailscale: 'This Whombat is {name} on your tailnet.',
      },
      named: 'Your Whombat is called {whombat} and your agent is {agent}. You can change both in Settings.',
      next: 'Continue',
    },
    defaultName: {
      named: '{first}’s Whombat',
      plain: 'My Whombat',
    },
    knownBoxes: {
      here: 'This Whombat',
      unnamed: 'Your Whombat',
      notIn: 'Set up this device',
      noAddress: 'On this device',
    },
  },
  {
    choice: {
      title: 'Hoe wil je deze Whombat bereiken?',
      sub: 'Je kunt dit later wijzigen in Instellingen.',
      easy: {
        kind: 'Eenvoudig',
        name: 'Whombat Link',
        label: 'Eenvoudig · Whombat Link',
        tag: 'Aanbevolen',
        more: 'Wat je krijgt',
        points: {
          one: 'Open je Whombat overal, zonder port forwarding',
          two: 'Een eigen beveiligd webadres',
          three: 'Meldingen op je iPhone en Android-telefoon',
          four: 'De Whombat-apps buiten de deur',
          five: 'Inloggen met bijvoorbeeld Google werkt',
          six: 'Steunt het opensourcewerk van Whombat',
        },
      },
      expert: {
        kind: 'Expert',
        name: 'Tailscale of Headscale',
        label: 'Expert · Tailscale of Headscale',
        tag: 'Gratis',
        line: 'Je stelt Tailscale in op elk van je apparaten.',
        more: 'Goed om te weten',
        points: {
          one: 'Geen meldingen op je telefoon zolang de app dicht is',
          two: 'Sommige manieren van inloggen, zoals Google, zijn niet beschikbaar',
        },
      },
    },
    reach: {
      section: 'BEREIKBAARHEID',
      link: {
        name: 'Whombat Link',
        off: 'Whombat Link staat uit',
        offMetaPlain: 'Deze Whombat werkt thuis en via Tailscale.',
        turnOn: 'Aanzetten',
        turningOn: 'Aanzetten…',
        starting: 'Wacht op je bevestiging',
        enter: 'Open {where} en vul {code} in.',
        left: 'De code werkt nog {time}.',
        codeOver: 'De code is verlopen.',
        newCode: 'Nieuwe code',
        startingPlain: 'Whombat Link start',
        startingPlainMeta: 'Rond het af waar je het hebt aangezet.',
        gettingCode: 'Code ophalen…',
        waitingAddress: 'Wacht op een adres',
        waitingAddressMeta: 'Je adres komt meestal binnen een paar minuten. Het komt vanzelf.',
        on: 'Whombat Link staat aan',
        onMeta: 'Open deze Whombat overal, met meldingen op je telefoons.',
        trial: 'Gratis maand tot {date}.',
        account: 'Gekoppeld aan {email}.',
        turnOff: 'Uitzetten',
        turningOff: 'Uitzetten…',
        cancel: 'Annuleren',
        grace: 'Whombat Link stopt op {date}',
        graceMeta:
          'Daarna werkt deze Whombat thuis en via Tailscale. Zet Tailscale nu aan als tweede manier om binnen te komen.',
        graceKeep: 'Wil je het houden, neem dan een abonnement op app.whombat.com.',
        ended: 'Whombat Link is gestopt',
        endedMeta:
          'Deze Whombat werkt thuis en via Tailscale. Je gegevens, assistenten, automatiseringen, back-ups en updates zijn er allemaal nog.',
        endedBack: 'Wil je het weer aanzetten, neem dan een abonnement op app.whombat.com.',
        offConfirm: 'Whombat Link uitzetten?',
        offConfirmMeta:
          'Het adres van je Whombat en de meldingen op je telefoons stoppen. Hij blijft thuis en via Tailscale werken.',
        errors: {
          unavailable: 'Whombat Link is niet beschikbaar op deze Whombat.',
          busy: 'Whombat Link is aan het veranderen. Probeer het zo opnieuw.',
          rateLimited: 'Te veel pogingen. Wacht een paar minuten en probeer het dan opnieuw.',
          unreachable: 'De dienst van Whombat antwoordde niet. Probeer het zo opnieuw.',
          failed: 'Dat lukte niet. Probeer het opnieuw.',
        },
      },
      address: {
        title: 'Het adres',
        none: 'Nog geen adres',
        noneMeta: 'Hij krijgt er een als Whombat Link aan staat.',
        coming: 'Adres ophalen…',
        comingMeta: 'Zijn eigen webadres staat hier zodra het klaar is.',
      },
      tailscale: {
        title: 'Tailscale',
        on: 'Aan als {name}',
        off: 'Uit',
        signIn: 'Wacht tot je inlogt',
        turnOn: 'Tailscale aanzetten',
        keyExpiry:
          'Zet in de beheerconsole van Tailscale het verlopen van de sleutel uit voor deze Whombat. Anders logt Tailscale hem na een paar maanden uit en kun je hem buiten de deur niet bereiken.',
      },
      banner: {
        grace:
          'Whombat Link stopt op {date}. Zet Tailscale aan, zodat je deze Whombat buiten de deur kunt blijven bereiken.',
        graceTailscale:
          'Whombat Link stopt op {date}. Je kunt deze Whombat thuis en via Tailscale blijven bereiken.',
        ended:
          'Whombat Link is gestopt. Deze Whombat werkt thuis nog. Zet Tailscale aan om hem buiten de deur te bereiken.',
        endedTailscale: 'Whombat Link is gestopt. Deze Whombat werkt nog thuis en via Tailscale.',
      },
      offer: {
        turnOn: 'Whombat Link aanzetten',
        notNow: 'Niet nu',
      },
    },
    channel: {
      title: 'Updates van',
      label: 'Updatekanaal',
      production: 'Productie',
      development: 'Bèta',
      productionMeta: 'Geteste versies. Dit is goed voor bijna iedereen.',
      developmentMeta: 'Nieuwe versies eerst, voordat ze helemaal getest zijn. Er kan iets stukgaan.',
      staysOn:
        'Deze Whombat houdt {release} tot Productie een nieuwere versie heeft, en gaat dan vanzelf mee.',
      switchedProduction: 'Deze Whombat krijgt updates van Productie.',
      switchedDevelopment: 'Deze Whombat krijgt Bèta-updates.',
      unavailable: 'Deze Whombat kan niet kiezen waar zijn updates vandaan komen.',
      failed: 'Dat lukte niet. Probeer het opnieuw.',
    },
    boxSetup: {
      steps: {
        link: { t: 'Voeg je Whombat toe', d: 'Aan je account' },
        claim: { t: 'Koppel je Whombat', d: 'De letters op het scherm' },
        account: { t: 'Wie ben jij?', d: 'Het blijft op deze Whombat' },
        passkey: { t: 'Maak een passkey', d: 'Alleen voor deze Whombat' },
        reach: { t: 'Overal bereikbaar', d: 'Tailscale of Whombat Link' },
        ai: { t: 'Stel je AI in', d: 'Kies en log in' },
      },
      stepLabel: 'STAP {n} VAN {of}',
      account: {
        title: 'Wie ben jij?',
        sub: 'Deze Whombat is alleen van jou. Met je naam begroet je assistent je.',
        tip: 'Je naam en e-mailadres blijven op deze Whombat.',
      },
      name: {
        hint: 'Hoe je assistent je begroet.',
      },
      reach: {
        title: 'Overal bereikbaar',
        sub: 'Gebruik deze Whombat buiten de deur met Tailscale, of met Whombat Link.',
        tip: 'Je kunt dit later wijzigen in Instellingen → Deze Whombat.',
        onTailscale: 'Deze Whombat heet {name} in je tailnet.',
      },
      named:
        'Je Whombat heet {whombat} en je assistent {agent}. Je kunt ze allebei wijzigen in Instellingen.',
      next: 'Doorgaan',
    },
    defaultName: {
      named: 'Whombat van {first}',
      plain: 'Mijn Whombat',
    },
    knownBoxes: {
      here: 'Deze Whombat',
      unnamed: 'Jouw Whombat',
      notIn: 'Stel dit apparaat in',
      noAddress: 'Op dit apparaat',
    },
  },
);
