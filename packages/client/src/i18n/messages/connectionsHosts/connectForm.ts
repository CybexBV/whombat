import { treeCatalogs } from '../../tree';

/** The connect form's own words and its draft's refusals (`connections/draft.ts`). */
export const CONN_DRAFT_WORDS = treeCatalogs(
  'connDraft',
  {
    identifying: 'Looking at the address…',
    checkAddress: 'Check the address',
    continue: 'Continue',
    moreOptions: 'More options',
    howSignsIn: 'How Whombat signs in',
    recommended: 'Recommended',
    chooseOne: 'Choose one',
    name: 'Name',
    password: 'Password',
    passwordHelp: 'Used once to make Whombat’s own key, then forgotten.',
    code: 'Two-step code',
    codeOptional: 'Two-step code (optional)',
    codeHelp: 'Only if this account signs in with a code too.',
    codePlaceholder: '123456',
    ownCertificate: 'It uses a certificate of its own. Its fingerprint:',
    unverifiable:
      'Its certificate can’t be verified (self-signed, expired or for another name). Its fingerprint:',
    trust: 'Trust this certificate',
    trusted: 'Whombat trusts this certificate and only this one.',
    undo: 'Undo',
    addNetwork: 'Add this network',
    useFingerprint: 'Use this fingerprint',
    nextcloud:
      'Nextcloud opens in a new tab: log in there and choose Grant access. This page carries on by itself.',
    nextcloudPhone:
      'Nextcloud opens in your browser: log in there and choose Grant access. This screen carries on by itself.',
    serviceLogin:
      '{name} opens in a new tab: sign in there and allow Whombat. This page carries on by itself.',
    serviceLoginPhone:
      '{name} opens in your browser: sign in there and allow Whombat. This screen carries on by itself.',
    homeAssistant: 'Your browser needs to reach Home Assistant at this address.',
    notThrough: 'That didn’t go through. Try again.',
    cantStart: 'Couldn’t start the sign-in in this tab. Try again in a moment.',
    pasteNothing: 'Whombat couldn’t find a key in that. Paste only the key, or fill in the fields below.',
    fileTooBig: 'That file is too big to be a key.',
    chooseFile: 'Choose a file',
    copy: 'Copy',
    parameterName: 'Parameter name',
    headerName: 'Header name',
    parameterHelp: 'The query parameter the token goes in.',
    headerHelp: 'The header the token goes in.',
    signingIn: 'Signing in to {name} and making Whombat’s key…',
    signingInWith: 'Signing in to {name} with the {secret}…',
    connected: '{label} connected.',
    networkAdded: '{cidr} port {port} added to the home network list.',
    copied: '{label} copied.',
    moreSummary: 'Named “{label}”',
    making: 'Making the {secret}',
    problems: {
      needed: '{label} is needed.',
      nameParameter: 'Name the parameter.',
      nameHeader: 'Name the header.',
      enterCode: 'Enter the code.',
      wholeCode: 'Enter the whole code.',
    },
  },
  {
    identifying: 'Het adres bekijken…',
    checkAddress: 'Het adres controleren',
    continue: 'Verder',
    moreOptions: 'Meer opties',
    howSignsIn: 'Hoe Whombat inlogt',
    recommended: 'Aanbevolen',
    chooseOne: 'Kies er een',
    name: 'Naam',
    password: 'Wachtwoord',
    passwordHelp: 'Eén keer gebruikt om Whombats eigen sleutel te maken, daarna vergeten.',
    code: 'Tweestapscode',
    codeOptional: 'Tweestapscode (niet verplicht)',
    codeHelp: 'Alleen als dit account ook met een code inlogt.',
    codePlaceholder: '123456',
    ownCertificate: 'Het gebruikt een eigen certificaat. De vingerafdruk:',
    unverifiable:
      'Het certificaat kan niet worden gecontroleerd (zelf ondertekend, verlopen of voor een andere naam). De vingerafdruk:',
    trust: 'Dit certificaat vertrouwen',
    trusted: 'Whombat vertrouwt dit certificaat en alleen dit.',
    undo: 'Ongedaan maken',
    addNetwork: 'Dit netwerk toevoegen',
    useFingerprint: 'Deze vingerafdruk gebruiken',
    nextcloud:
      'Nextcloud opent in een nieuw tabblad: log daar in en kies Grant access. Deze pagina gaat vanzelf verder.',
    nextcloudPhone:
      'Nextcloud opent in je browser: log daar in en kies Grant access. Dit scherm gaat vanzelf verder.',
    serviceLogin:
      '{name} opent in een nieuw tabblad: log daar in en sta Whombat toe. Deze pagina gaat vanzelf verder.',
    serviceLoginPhone:
      '{name} opent in je browser: log daar in en sta Whombat toe. Dit scherm gaat vanzelf verder.',
    homeAssistant: 'Je browser moet Home Assistant op dit adres kunnen bereiken.',
    notThrough: 'Dat ging niet door. Probeer het opnieuw.',
    cantStart: 'Kon het inloggen niet starten in dit tabblad. Probeer het zo nog eens.',
    pasteNothing: 'Whombat vond daar geen sleutel in. Plak alleen de sleutel, of vul de velden hieronder in.',
    fileTooBig: 'Dat bestand is te groot om een sleutel te zijn.',
    chooseFile: 'Kies een bestand',
    copy: 'Kopiëren',
    parameterName: 'Naam van de parameter',
    headerName: 'Naam van de header',
    parameterHelp: 'De queryparameter waar het token in gaat.',
    headerHelp: 'De header waar het token in gaat.',
    signingIn: 'Inloggen bij {name} en Whombats sleutel maken…',
    signingInWith: 'Inloggen bij {name} met de {secret}…',
    connected: '{label} gekoppeld.',
    networkAdded: '{cidr} poort {port} toegevoegd aan de lijst met thuisnetwerken.',
    copied: '{label} gekopieerd.',
    moreSummary: 'Genaamd “{label}”',
    making: 'De {secret} maken',
    problems: {
      needed: '{label} is nodig.',
      nameParameter: 'Geef de parameter een naam.',
      nameHeader: 'Geef de header een naam.',
      enterCode: 'Vul de code in.',
      wholeCode: 'Vul de hele code in.',
    },
  },
);

/** A connection's state, buttons, warnings and refusals (`connections/form.ts`). */
export const CONN_FORM_WORDS = treeCatalogs(
  'connForm',
  {
    state: {
      active: 'Connected',
      needs_reauth: 'Needs you to sign in again',
      error: 'Needs attention',
      newToken: 'Needs a new token',
      newSecret: 'Needs a new {secret}',
    },
    reauth: {
      revoked: '{name} signed Whombat out. Sign in again to keep using it.',
      app_removed: 'This Whombat’s {name} app was removed. Sign in again once it’s set up.',
      expired: 'The sign-in to {name} expired. Sign in again to keep using it.',
      secret: '{name} no longer accepts the {secret}. Replace it to keep using it.',
      signIn: '{name} no longer accepts the sign-in. Sign in again to keep using it.',
      token: 'token',
    },
    button: {
      connect: 'Connect',
      password: 'Sign in and connect',
      nextcloud: 'Sign in with Nextcloud',
      continueTo: 'Continue to {name}',
    },
    http: {
      secret: 'This address uses http: the {secret} and Whombat’s key cross your network unencrypted.',
      password: 'This address uses http: your password and Whombat’s key cross your network unencrypted.',
      session: 'This address uses http: the {secret} crosses your network unencrypted.',
      token: 'This address uses http: the token crosses your network unencrypted.',
    },
    fallback: 'That didn’t work. Try again in a moment.',
    refused: {
      secret: 'That {secret} didn’t work. Make a new one and try again.',
      password: 'Wrong username or password.',
      code: 'That code didn’t work. Enter the newest one.',
      rights: 'This account may not make keys. Sign in with an admin account.',
      locked: 'The service paused sign-ins after too many tries. Wait a few minutes, then try again.',
      single_sign_on: 'This account signs in somewhere else. Make a token by hand instead.',
      unsupported: 'This version or setting can’t make keys this way. Make a token by hand instead.',
      second_factor: 'This account uses two-step sign-in, which this way can’t do.',
    },
    switch: {
      nextcloud: 'Sign in with Nextcloud instead',
      token: 'Make a token by hand instead',
      named: 'Sign in with {name} instead',
      other: 'Use another way',
    },
    tokenRefused:
      'The service didn’t accept that token. Check that you copied all of it and that it may read.',
    sessionCheckFailed:
      'Whombat couldn’t sign in with that. Check the address, the account and the password.',
    connectError: {
      access_denied: 'The service didn’t connect: access wasn’t allowed. Try again and choose Allow.',
      invalid_state: 'That sign-in expired or was already used. Try signing in again.',
      exchange_failed: 'The service didn’t finish the sign-in. Try again in a moment.',
      no_app: 'This service isn’t set up on this Whombat. Set it up in Settings → Connections first.',
      issuer_mismatch: 'The sign-in came back from a different server than it started at. Try again.',
      check_failed:
        'Signed in, but Whombat couldn’t reach the service with it. Check the address and try again.',
      destination_refused:
        'That address isn’t allowed. Check the address, or add it to the home network list.',
      limit_reached: 'That’s as many connections as there can be. Remove one first.',
    },
    errors: {
      destination_refused: 'That address isn’t allowed.',
      limit_reached: 'That’s as many connections as there can be. Remove one first.',
      not_supported: 'This connection can’t be set up that way.',
      app_not_configured: 'Set up its app first, in Settings → Connections.',
      check_failed: 'Whombat couldn’t sign in with that. Check the address and the token.',
      field_choice_needed: 'Choose one to go on.',
      app_in_config: 'This app is set in this Whombat’s config.',
      login_expired: 'The sign-in took too long. Start again.',
      unknown_tool: 'That tool isn’t one of this connection’s.',
      second_factor_needed: 'Enter the code from your authenticator app.',
      sign_in_refused: 'The service didn’t let Whombat sign in with that.',
      gateway_exists: 'This Whombat already sends its AI through a gateway. Remove that connection first.',
      gateway_too_old:
        'This Fusebox is too old to add a client key for Whombat. Update Fusebox and connect again.',
      destinationOnNetwork:
        'That address is on your network. Add {cidr} port {port} to the home network list to connect.',
    },
  },
  {
    state: {
      active: 'Verbonden',
      needs_reauth: 'Je moet opnieuw inloggen',
      error: 'Even naar kijken',
      newToken: 'Heeft een nieuw token nodig',
      newSecret: 'Heeft een nieuw {secret} nodig',
    },
    reauth: {
      revoked: '{name} heeft Whombat uitgelogd. Log opnieuw in om het te blijven gebruiken.',
      app_removed: 'De {name}-app van deze Whombat is verwijderd. Log opnieuw in zodra hij is ingesteld.',
      expired: 'De aanmelding bij {name} is verlopen. Log opnieuw in om het te blijven gebruiken.',
      secret: '{name} accepteert het {secret} niet meer. Vervang het om het te blijven gebruiken.',
      signIn: '{name} accepteert de aanmelding niet meer. Log opnieuw in om het te blijven gebruiken.',
      token: 'token',
    },
    button: {
      connect: 'Koppelen',
      password: 'Inloggen en koppelen',
      nextcloud: 'Inloggen met Nextcloud',
      continueTo: 'Verder naar {name}',
    },
    http: {
      secret: 'Dit adres gebruikt http: het {secret} en Whombats sleutel gaan onversleuteld over je netwerk.',
      password:
        'Dit adres gebruikt http: je wachtwoord en Whombats sleutel gaan onversleuteld over je netwerk.',
      session: 'Dit adres gebruikt http: het {secret} gaat onversleuteld over je netwerk.',
      token: 'Dit adres gebruikt http: het token gaat onversleuteld over je netwerk.',
    },
    fallback: 'Dat werkte niet. Probeer het zo nog eens.',
    refused: {
      secret: 'Die {secret} werkte niet. Maak een nieuwe en probeer het opnieuw.',
      password: 'Verkeerde gebruikersnaam of wachtwoord.',
      code: 'Die code werkte niet. Vul de nieuwste in.',
      rights: 'Dit account mag geen sleutels maken. Log in met een beheerdersaccount.',
      locked:
        'De dienst heeft inloggen gepauzeerd na te veel pogingen. Wacht een paar minuten en probeer het dan opnieuw.',
      single_sign_on: 'Dit account logt ergens anders in. Maak in plaats daarvan zelf een token.',
      unsupported:
        'Deze versie of instelling kan op deze manier geen sleutels maken. Maak in plaats daarvan zelf een token.',
      second_factor: 'Dit account gebruikt inloggen in twee stappen, en dat kan op deze manier niet.',
    },
    switch: {
      nextcloud: 'Liever inloggen met Nextcloud',
      token: 'Liever zelf een token maken',
      named: 'Liever inloggen met {name}',
      other: 'Een andere manier gebruiken',
    },
    tokenRefused:
      'De dienst accepteerde dat token niet. Controleer of je het helemaal hebt gekopieerd en of het mag lezen.',
    sessionCheckFailed:
      'Whombat kon daarmee niet inloggen. Controleer het adres, het account en het wachtwoord.',
    connectError: {
      access_denied:
        'De dienst is niet gekoppeld: toegang werd niet toegestaan. Probeer het opnieuw en kies Toestaan.',
      invalid_state: 'Die aanmelding is verlopen of al gebruikt. Probeer opnieuw in te loggen.',
      exchange_failed: 'De dienst heeft het inloggen niet afgerond. Probeer het zo nog eens.',
      no_app:
        'Deze dienst is niet ingesteld op deze Whombat. Stel hem eerst in bij Instellingen → Koppelingen.',
      issuer_mismatch:
        'De aanmelding kwam terug van een andere server dan waar ze begon. Probeer het opnieuw.',
      check_failed:
        'Ingelogd, maar Whombat kon de dienst er niet mee bereiken. Controleer het adres en probeer het opnieuw.',
      destination_refused:
        'Dat adres is niet toegestaan. Controleer het adres, of voeg het toe aan de lijst met thuisnetwerken.',
      limit_reached: 'Meer koppelingen kunnen er niet zijn. Verwijder er eerst een.',
    },
    errors: {
      destination_refused: 'Dat adres is niet toegestaan.',
      limit_reached: 'Meer koppelingen kunnen er niet zijn. Verwijder er eerst een.',
      not_supported: 'Deze koppeling kan niet op die manier worden ingesteld.',
      app_not_configured: 'Stel eerst de app in, bij Instellingen → Koppelingen.',
      check_failed: 'Whombat kon daarmee niet inloggen. Controleer het adres en het token.',
      field_choice_needed: 'Kies er een om verder te gaan.',
      app_in_config: 'Deze app is ingesteld in de configuratie van deze Whombat.',
      login_expired: 'Het inloggen duurde te lang. Begin opnieuw.',
      unknown_tool: 'Die tool hoort niet bij deze koppeling.',
      second_factor_needed: 'Vul de code uit je authenticator-app in.',
      sign_in_refused: 'De dienst liet Whombat daarmee niet inloggen.',
      gateway_exists: 'Deze Whombat stuurt zijn AI al via een gateway. Verwijder die koppeling eerst.',
      gateway_too_old:
        'Deze Fusebox is te oud om een clientsleutel voor Whombat toe te voegen. Werk Fusebox bij en koppel opnieuw.',
      destinationOnNetwork:
        'Dat adres staat op je netwerk. Voeg {cidr} poort {port} toe aan de lijst met thuisnetwerken om te koppelen.',
    },
  },
);

/** Setting up a connection: the steps, the identified address, the guide, Found on your network (`connections/setup.ts`). */
export const CONN_SETUP_WORDS = treeCatalogs(
  'connSetup',
  {
    steps: {
      where: 'Where is it?',
      signIn: 'How should Whombat sign in?',
      access: 'What may your agent do?',
      readThroughMac: 'How should Whombat read it?',
      whatToCheck: 'What should Whombat check?',
    },
    nameHelp: {
      gateway: 'How it’s listed here, in its switches and in Usage. You can change it later.',
      vault: 'How it’s listed here. You can change it later.',
      automations: 'How it’s listed here and in automations. You can change it later.',
    },
    identify: {
      nothing: 'Nothing answered',
      unreachable: 'Whombat couldn’t reach {url}.',
      unreachableHint: ' Check the address and that it’s switched on.',
      foundAt: 'Found at {url}.',
      looksLike: 'This looks like {other}',
      answersLike: '{url} answers like {other}, not {name}. Check the address and the port.',
      answers: 'It answers',
      reaches: 'Whombat reaches {url}.',
      somethingElse: 'Something else answers here',
      notLike: '{url} doesn’t look like {name}.',
      notLikeHint: ' Check the address and the port, or go on if you’re sure.',
    },
    trust: 'Compare it with what {name} shows, then trust it.',
    trustWhere: 'Compare it with what {name} shows ({where}), then trust it.',
    elsewhere: {
      nextcloud: 'Whombat sets it to Look only as soon as Nextcloud lets it in.',
      other: 'Signing in at {name} connects it to manage: set it to Look only on its page afterwards.',
    },
    signInNote: {
      tokenSteps: 'Make it in {name} with the steps below, then paste it here.',
      nextcloud: 'Log in to Nextcloud in a new tab and grant access.',
      none: 'The server needs no sign-in.',
      other: 'Sign in at {name} and allow access.',
    },
    filled: 'Filled in {list}.',
    and: '{items} and {last}',
    paste: 'Paste what {name} shows, or drop the file',
    makingUser: 'Making a user for Whombat',
    raise: {
      code: 'If Whombat signed in at Look only, {name} itself keeps it to looking. Sign in again below with a new {secret} to manage.',
      key: 'If this key was made by signing in once at Look only, {name} itself keeps it to looking. Sign in again to make one that can manage.',
    },
    discovery: {
      around: 'Looking around your network…',
      progress: {
        one: 'Looking at {done} of {total} address…',
        other: 'Looking at {done} of {total} addresses…',
      },
    },
    empty: {
      hidden: 'Everything Whombat found on your network is connected or hidden.',
      connected: 'Everything Whombat found on your network is connected already.',
      nothing: 'Nothing Whombat knows how to connect turned up on your network.',
    },
    hiddenToggle: { show: 'Show {count} hidden', hide: 'Hide {count} hidden' },
    hideTrouble: {
      hide: 'Couldn’t hide that just now. Try again in a moment.',
      show: 'Couldn’t show that again just now. Try again in a moment.',
    },
    networks: {
      looked: 'Looked in {list}',
      more: '{first} and {count} more networks',
    },
    cidr: {
      shape: 'Write it like 192.168.2.0/24.',
      tooBig: 'Look in at most {max} addresses at a time: a /22 or smaller.',
      private: 'Only home network addresses: 10.…, 172.16–31.… or 192.168.….',
    },
    asServer: {
      title: 'Add it as a server instead',
      text: 'Whombat looks after {name} best as a server: its helper there sees everything, with no sign-in key to keep.',
      label: 'Add as a server',
    },
  },
  {
    steps: {
      where: 'Waar staat het?',
      signIn: 'Hoe moet Whombat inloggen?',
      access: 'Wat mag je assistent doen?',
      readThroughMac: 'Hoe moet Whombat het lezen?',
      whatToCheck: 'Wat moet Whombat controleren?',
    },
    nameHelp: {
      gateway: 'Zo staat het hier, bij de schakelaars en in Verbruik. Je kunt het later aanpassen.',
      vault: 'Zo staat het hier. Je kunt het later aanpassen.',
      automations: 'Zo staat het hier en in automatiseringen. Je kunt het later aanpassen.',
    },
    identify: {
      nothing: 'Niets antwoordde',
      unreachable: 'Whombat kon {url} niet bereiken.',
      unreachableHint: ' Controleer het adres en of het aanstaat.',
      foundAt: 'Gevonden op {url}.',
      looksLike: 'Dit lijkt op {other}',
      answersLike: '{url} antwoordt als {other}, niet als {name}. Controleer het adres en de poort.',
      answers: 'Het antwoordt',
      reaches: 'Whombat bereikt {url}.',
      somethingElse: 'Hier antwoordt iets anders',
      notLike: '{url} lijkt niet op {name}.',
      notLikeHint: ' Controleer het adres en de poort, of ga verder als je het zeker weet.',
    },
    trust: 'Vergelijk het met wat {name} laat zien en vertrouw het dan.',
    trustWhere: 'Vergelijk het met wat {name} laat zien ({where}) en vertrouw het dan.',
    elsewhere: {
      nextcloud: 'Whombat zet het op Alleen kijken zodra Nextcloud het binnenlaat.',
      other: 'Inloggen bij {name} koppelt het met beheren: zet het daarna op de pagina op Alleen kijken.',
    },
    signInNote: {
      tokenSteps: 'Maak het in {name} met de stappen hieronder en plak het dan hier.',
      nextcloud: 'Log in een nieuw tabblad in bij Nextcloud en geef toegang.',
      none: 'De server heeft geen aanmelding nodig.',
      other: 'Log in bij {name} en geef toegang.',
    },
    filled: '{list} ingevuld.',
    and: '{items} en {last}',
    paste: 'Plak wat {name} laat zien, of sleep het bestand hierheen',
    makingUser: 'Een gebruiker voor Whombat maken',
    raise: {
      code: 'Als Whombat inlogde met Alleen kijken, houdt {name} het zelf bij kijken. Log hieronder opnieuw in met een nieuwe {secret} om te beheren.',
      key: 'Als deze sleutel is gemaakt door één keer in te loggen met Alleen kijken, houdt {name} het zelf bij kijken. Log opnieuw in om er een te maken die kan beheren.',
    },
    discovery: {
      around: 'Rondkijken op je netwerk…',
      progress: { one: '{done} van {total} adres bekijken…', other: '{done} van {total} adressen bekijken…' },
    },
    empty: {
      hidden: 'Alles wat Whombat op je netwerk vond is gekoppeld of verborgen.',
      connected: 'Alles wat Whombat op je netwerk vond is al gekoppeld.',
      nothing: 'Er dook niets op je netwerk op dat Whombat kan koppelen.',
    },
    hiddenToggle: { show: '{count} verborgen tonen', hide: '{count} verborgen verbergen' },
    hideTrouble: {
      hide: 'Kon dat nu niet verbergen. Probeer het zo nog eens.',
      show: 'Kon dat nu niet weer tonen. Probeer het zo nog eens.',
    },
    networks: {
      looked: 'Gekeken in {list}',
      more: '{first} en {count} netwerken meer',
    },
    cidr: {
      shape: 'Schrijf het als 192.168.2.0/24.',
      tooBig: 'Kijk in hoogstens {max} adressen tegelijk: een /22 of kleiner.',
      private: 'Alleen adressen van een thuisnetwerk: 10.…, 172.16–31.… of 192.168.….',
    },
    asServer: {
      title: 'Voeg het liever toe als server',
      text: 'Whombat zorgt het best voor {name} als server: Whombats helper ziet daar alles, zonder inlogsleutel om te bewaren.',
      label: 'Toevoegen als server',
    },
  },
);
