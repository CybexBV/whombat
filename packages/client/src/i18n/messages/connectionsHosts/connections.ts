import { treeCatalogs } from '../../tree';

/** WHAT {ASSISTANT} MAY DO on a Google or Microsoft 365 account's page (`connections/accountKeys.ts`). */
export const CONN_ACCOUNT_KEYS_WORDS = treeCatalogs(
  'connAccountKeys',
  {
    title: 'WHAT {NAME} MAY DO',
    line: 'What {Name} may do with your {account} account: Allowed runs at once, Asks waits for you, Off never runs.',
    tiersLabel: '{key}: what {Name} may do',
    alwaysAsks: 'Always asks you first.',
    saved: 'Saved.',
    failed: 'That didn’t save. Try again in a moment.',
    groups: { mail: 'Mail', calendar: 'Calendar', files: 'Files', contacts: 'Contacts' },
  },
  {
    title: 'WAT {NAME} MAG DOEN',
    line: 'Wat {Name} mag doen met je {account}-account: Toegestaan gebeurt meteen, Vraagt wacht op jou, Uit gebeurt nooit.',
    tiersLabel: '{key}: wat {Name} mag doen',
    alwaysAsks: 'Vraagt het je altijd eerst.',
    saved: 'Opgeslagen.',
    failed: 'Dat is niet opgeslagen. Probeer het zo nog eens.',
    groups: { mail: 'Mail', calendar: 'Agenda', files: 'Bestanden', contacts: 'Contacten' },
  },
);

/** Google's, Microsoft 365's and the other builtin connections' words (`connections/accounts.ts`). */
export const CONN_ACCOUNTS_WORDS = treeCatalogs(
  'connAccounts',
  {
    reauth: {
      revoked: 'Google signed Whombat out of this account. Sign in again to keep using it.',
      testing_expired:
        'Google signed you out after 7 days because this Whombat’s Google app is still in Testing. Sign in again, and publish the app in Google Cloud.',
      app_removed: 'This Whombat’s Google app was removed or replaced. Sign in again.',
      scope_missing:
        'Google didn’t allow everything Whombat needs. Sign in again and keep the services ticked.',
      password_refused: 'The mail server no longer accepts the password. Enter it again to keep using it.',
    },
    connectError: {
      access_denied: 'Google didn’t connect: access wasn’t allowed. Try again and choose Allow.',
      invalid_state: 'That sign-in expired or was already used. Try signing in again.',
      exchange_failed:
        'Google didn’t finish the sign-in. Try again; if it keeps failing, check the Client ID and secret.',
      no_app: 'Google isn’t set up on this Whombat. Set it up in Settings → Connections first.',
    },
    check: {
      ok: 'Working',
      api_disabled: 'API turned off in your Google project',
      no_scope: 'Not allowed when you connected · Reconnect and tick it',
      failedWhy: 'Couldn’t check: {message}',
      failed: 'Couldn’t check',
    },
    list: '{items} and {last}',
    account: {
      yourAccount: 'YOUR ACCOUNT',
      notConnected: 'Not connected',
      connected: 'Connected',
      needsConnecting: 'Needs you to sign in again',
      pickServices:
        'Your agent works with the services you tick, as you, when you ask. You can add more later.',
      keepServices: 'Services you connected stay connected. Disconnect removes them all.',
      tickOne: 'Tick at least one service.',
      off: 'Connecting accounts is turned off on this Whombat.',
      setUpFirst: 'Set up {name} first, in Settings → Connections.',
      connect: 'Connect {name}',
      reconnect: 'Reconnect',
      continueTo: 'Continue to {name}',
      disconnect: 'Disconnect',
      disconnectNamed: 'Disconnect {name}',
      disconnectGoogle:
        'Disconnect Google? Your agent can’t use your mail, calendar and files until you connect again.',
      disconnectMicrosoft:
        'Disconnecting removes access from this Whombat. To revoke consent at Microsoft too, remove Whombat in your Microsoft account’s application permissions. Word and Excel files can be downloaded; native editing is not available.',
      disconnected: '{name} disconnected.',
      connectedAs: '{name} connected: {email}.',
      cancel: 'Cancel',
      checkAgain: 'Check again',
      checking: 'Checking…',
      notChecked: 'Not checked yet',
      microsoftUpdate: 'Update this Whombat to connect Microsoft 365.',
      couldNotStart: 'Couldn’t start connecting {name}. Try again in a moment.',
    },
  },
  {
    reauth: {
      revoked: 'Google heeft Whombat uit dit account uitgelogd. Log opnieuw in om het te blijven gebruiken.',
      testing_expired:
        'Google heeft je na 7 dagen uitgelogd, omdat de Google-app van deze Whombat nog in Testing staat. Log opnieuw in en publiceer de app in Google Cloud.',
      app_removed: 'De Google-app van deze Whombat is verwijderd of vervangen. Log opnieuw in.',
      scope_missing:
        'Google stond niet alles toe wat Whombat nodig heeft. Log opnieuw in en laat de diensten aangevinkt.',
      password_refused:
        'De mailserver accepteert het wachtwoord niet meer. Vul het opnieuw in om het te blijven gebruiken.',
    },
    connectError: {
      access_denied:
        'Google is niet gekoppeld: toegang werd niet toegestaan. Probeer het opnieuw en kies Toestaan.',
      invalid_state: 'Die aanmelding is verlopen of al gebruikt. Probeer opnieuw in te loggen.',
      exchange_failed:
        'Google heeft de aanmelding niet afgerond. Probeer het opnieuw; lukt het steeds niet, controleer dan de Client ID en het secret.',
      no_app: 'Google is niet ingesteld op deze Whombat. Stel het eerst in bij Instellingen → Koppelingen.',
    },
    check: {
      ok: 'Werkt',
      api_disabled: 'API staat uit in je Google-project',
      no_scope: 'Niet toegestaan bij het koppelen · Koppel opnieuw en vink het aan',
      failedWhy: 'Kon niet controleren: {message}',
      failed: 'Kon niet controleren',
    },
    list: '{items} en {last}',
    account: {
      yourAccount: 'JE ACCOUNT',
      notConnected: 'Niet gekoppeld',
      connected: 'Verbonden',
      needsConnecting: 'Je moet opnieuw inloggen',
      pickServices:
        'Je assistent werkt met de diensten die je aanvinkt, als jou, wanneer je erom vraagt. Je kunt er later meer toevoegen.',
      keepServices: 'Diensten die je hebt gekoppeld blijven gekoppeld. Ontkoppelen haalt ze allemaal weg.',
      tickOne: 'Vink minstens één dienst aan.',
      off: 'Accounts koppelen staat uit op deze Whombat.',
      setUpFirst: 'Stel eerst {name} in, bij Instellingen → Koppelingen.',
      connect: '{name} koppelen',
      reconnect: 'Opnieuw koppelen',
      continueTo: 'Verder naar {name}',
      disconnect: 'Ontkoppelen',
      disconnectNamed: '{name} ontkoppelen',
      disconnectGoogle:
        'Google ontkoppelen? Je assistent kan je mail, agenda en bestanden dan niet gebruiken tot je opnieuw koppelt.',
      disconnectMicrosoft:
        'Ontkoppelen haalt de toegang van deze Whombat weg. Wil je de toestemming ook bij Microsoft intrekken, verwijder Whombat dan bij de app-machtigingen van je Microsoft-account. Word- en Excel-bestanden kun je downloaden; ze direct bewerken kan niet.',
      disconnected: '{name} ontkoppeld.',
      connectedAs: '{name} gekoppeld: {email}.',
      cancel: 'Annuleren',
      checkAgain: 'Opnieuw controleren',
      checking: 'Controleren…',
      notChecked: 'Nog niet gecontroleerd',
      microsoftUpdate: 'Werk deze Whombat bij om Microsoft 365 te koppelen.',
      couldNotStart: 'Kon het koppelen van {name} niet starten. Probeer het zo nog eens.',
    },
  },
);

/** An `app_oauth` entry's app and its setup (`connections/app.ts`). */
export const CONN_APP_WORDS = treeCatalogs(
  'connApp',
  {
    dropbox: { id: 'App key', secret: 'App secret', console: 'the Dropbox App Console' },
    other: { id: 'Client ID', secret: 'Client secret', console: '{name}’s developer console' },
    summary: {
      config: 'Set in this Whombat’s config · {id} {hint}',
      configured: 'Set up · {id} {hint}',
      todo: 'Set up {name} once, then you can connect. Four steps, about five minutes.',
    },
    savedLine: 'Saved · {id} {hint}',
    secretSaved: ' · {secret} saved',
    problem: {
      pasteId: 'Paste the {id} from {console}.',
      pasteSecret: 'Paste the {secret} too.',
    },
    setup: {
      section: '{NAME} APP',
      forThisWhombat: 'For this Whombat',
      setUp: 'Set up',
      notSetUp: 'Not set up',
      showSteps: 'Show setup steps',
      hideSteps: 'Hide setup steps',
      stepCreate: 'Create the app',
      createDropbox:
        'In {console}, create an app with Scoped access and Full Dropbox (or App folder, to keep your agent to one folder). Name it after this Whombat.',
      createOther: 'In {console}, create an OAuth app for this Whombat. Name it after this Whombat.',
      openConsole: 'Open {console}',
      stepPermissions: 'Give it permissions',
      permissions: 'On the app’s Permissions tab, tick these and click Submit before you sign in:',
      stepRedirect: 'Add the redirect URI',
      redirect: 'On the Settings tab, under OAuth 2 → Redirect URIs, add this URI exactly:',
      dropboxPublicClients: 'Leave Allow public clients (Implicit Grant & PKCE) on Allow.',
      dropboxMoreUsers:
        'Under Development users, click Enable additional users, so people other than you can connect.',
      redirectLabel: 'Redirect URI',
      redirectCopied: 'Redirect URI copied.',
      stepPaste: 'Paste the {id}',
      copyThem: 'Copy them from the app’s Settings tab.',
      optionalSecret: ' The {secret} is optional: Whombat signs in with PKCE without it.',
      optional: ' · OPTIONAL',
      keepId: 'Leave empty to keep the saved one',
      keepSecret: 'Leave empty to keep the saved secret',
      save: 'Save',
      cancel: 'Cancel',
      replace: 'Replace',
      remove: 'Remove',
      removeApp: 'Remove the app',
      saved: '{name} app saved. Connect below to test it.',
      removed: '{name} app removed. Your {name} connections need you to sign in again.',
      confirmRemove: 'Remove the {name} app? Your {name} connections stop working until it’s set up again.',
    },
  },
  {
    dropbox: { id: 'App key', secret: 'App secret', console: 'de Dropbox App Console' },
    other: { id: 'Client ID', secret: 'Client secret', console: 'de ontwikkelaarsconsole van {name}' },
    summary: {
      config: 'Ingesteld in de configuratie van deze Whombat · {id} {hint}',
      configured: 'Ingesteld · {id} {hint}',
      todo: 'Stel {name} één keer in, daarna kun je koppelen. Vier stappen, ongeveer vijf minuten.',
    },
    savedLine: 'Opgeslagen · {id} {hint}',
    secretSaved: ' · {secret} opgeslagen',
    problem: {
      pasteId: 'Plak de {id} uit {console}.',
      pasteSecret: 'Plak ook de {secret}.',
    },
    setup: {
      section: '{NAME}-APP',
      forThisWhombat: 'Voor deze Whombat',
      setUp: 'Ingesteld',
      notSetUp: 'Niet ingesteld',
      showSteps: 'Stappen tonen',
      hideSteps: 'Stappen verbergen',
      stepCreate: 'Maak de app',
      createDropbox:
        'Maak in {console} een app met Scoped access en Full Dropbox (of App folder, om je assistent bij één map te houden). Noem hem naar deze Whombat.',
      createOther: 'Maak in {console} een OAuth-app voor deze Whombat. Noem hem naar deze Whombat.',
      openConsole: '{console} openen',
      stepPermissions: 'Geef hem rechten',
      permissions: 'Vink op het tabblad Permissions van de app deze aan en klik op Submit voordat je inlogt:',
      stepRedirect: 'Voeg de redirect-URI toe',
      redirect: 'Voeg op het tabblad Settings, onder OAuth 2 → Redirect URIs, precies deze URI toe:',
      dropboxPublicClients: 'Laat Allow public clients (Implicit Grant & PKCE) op Allow staan.',
      dropboxMoreUsers:
        'Klik onder Development users op Enable additional users, zodat ook anderen dan jij kunnen koppelen.',
      redirectLabel: 'Redirect-URI',
      redirectCopied: 'Redirect-URI gekopieerd.',
      stepPaste: 'Plak de {id}',
      copyThem: 'Kopieer ze van het tabblad Settings van de app.',
      optionalSecret: ' Het {secret} is niet verplicht: Whombat logt zonder in met PKCE.',
      optional: ' · NIET VERPLICHT',
      keepId: 'Laat leeg om de opgeslagen te houden',
      keepSecret: 'Laat leeg om het opgeslagen secret te houden',
      save: 'Opslaan',
      cancel: 'Annuleren',
      replace: 'Vervangen',
      remove: 'Verwijderen',
      removeApp: 'De app verwijderen',
      saved: '{name}-app opgeslagen. Koppel hieronder om hem te testen.',
      removed: '{name}-app verwijderd. Voor je {name}-koppelingen moet je opnieuw inloggen.',
      confirmRemove:
        'De {name}-app verwijderen? Je {name}-koppelingen werken niet meer tot hij opnieuw is ingesteld.',
    },
  },
);

/** Why a catalog entry can't be connected on this Whombat (`connections/catalogReason.ts`). */
export const CONN_REASON_WORDS = treeCatalogs(
  'connReason',
  {
    needsSecureAddress:
      'This sign-in needs a secure address for your Whombat to come back to. Turn on Whombat Link, or Tailscale with HTTPS, first.',
    needsSecureAddressTailscale:
      'This sign-in needs a secure address for your Whombat to come back to. Turn on Tailscale with HTTPS first.',
    hostedOnly:
      'This sign-in comes back to Whombat on the web, which this Whombat doesn’t use. Set up your own app for it in Settings → Connections.',
    needsSecureAddressAction: 'Get a secure address',
    needsSecureAddressNote: 'Needs a secure address',
    hostedOnlyNote: 'Needs your own app',
    needsMacNote: 'Add a Mac first',
    needsMac: 'This works through one of your Macs. Add your Mac as a server first, then connect.',
    needsMacAction: 'Add a server',
  },
  {
    needsSecureAddress:
      'Voor deze aanmelding heeft je Whombat een veilig adres nodig om naar terug te komen. Zet eerst Whombat Link aan, of Tailscale met HTTPS.',
    needsSecureAddressTailscale:
      'Voor deze aanmelding heeft je Whombat een veilig adres nodig om naar terug te komen. Zet eerst Tailscale met HTTPS aan.',
    hostedOnly:
      'Deze aanmelding komt terug bij Whombat op het web, en dat gebruikt deze Whombat niet. Stel er je eigen app voor in bij Instellingen → Koppelingen.',
    needsSecureAddressAction: 'Een veilig adres regelen',
    needsSecureAddressNote: 'Heeft een veilig adres nodig',
    hostedOnlyNote: 'Heeft je eigen app nodig',
    needsMacNote: 'Voeg eerst een Mac toe',
    needsMac: 'Dit werkt via een van je Macs. Voeg je Mac eerst toe als server en koppel daarna.',
    needsMacAction: 'Een server toevoegen',
  },
);

/** The lines both connect forms share: the probe, the waits (`connections/parts.ts`). */
export const CONN_PARTS_WORDS = treeCatalogs(
  'connParts',
  {
    probe: {
      theServer: 'The server ',
      open: '{name}answers without a sign-in.',
      oauth: '{name}asks you to sign in. Continue to sign in there.',
      oauthAt: '{name}asks you to sign in at {issuer}. Continue to sign in there.',
      token: '{name}wants a token. Paste the one its documentation tells you to send.',
      unreachable: 'Whombat couldn’t reach the server.',
      unreachableWhy: 'Whombat couldn’t reach the server: {message}',
    },
    nextcloud: {
      title: 'Waiting for Nextcloud…',
      web: 'Log in and choose Grant access in the tab that opened. This page carries on by itself',
      phone: 'Log in and choose Grant access in the browser that opened. This screen carries on by itself',
      open: 'Open the Nextcloud login',
      cancel: 'Cancel',
      tooLong: 'The sign-in took too long. Start again.',
      failed: 'Nextcloud didn’t finish the sign-in.',
    },
    minutesLeft: { one: '1 minute left', other: '{count} minutes left' },
    service: {
      title: 'Waiting for {name}…',
      web: 'Sign in and allow Whombat in the tab that opened. This page carries on by itself',
      phone: 'Sign in and allow Whombat in the browser that opened. This screen carries on by itself',
      open: 'Open the {name} sign-in',
      userCode: 'Enter this code when {name} asks for it.',
      codeLabel: 'Code',
      codeCopied: 'Code copied.',
      cancel: 'Cancel',
      failed: '{name} didn’t finish the sign-in.',
    },
  },
  {
    probe: {
      theServer: 'De server ',
      open: '{name}antwoordt zonder aanmelding.',
      oauth: '{name}vraagt je om in te loggen. Ga verder om daar in te loggen.',
      oauthAt: '{name}vraagt je om in te loggen bij {issuer}. Ga verder om daar in te loggen.',
      token: '{name}wil een token. Plak het token dat volgens de documentatie nodig is.',
      unreachable: 'Whombat kon de server niet bereiken.',
      unreachableWhy: 'Whombat kon de server niet bereiken: {message}',
    },
    nextcloud: {
      title: 'Wachten op Nextcloud…',
      web: 'Log in en kies Grant access in het tabblad dat openging. Deze pagina gaat vanzelf verder',
      phone: 'Log in en kies Grant access in de browser die openging. Dit scherm gaat vanzelf verder',
      open: 'De Nextcloud-login openen',
      cancel: 'Annuleren',
      tooLong: 'Het inloggen duurde te lang. Begin opnieuw.',
      failed: 'Nextcloud heeft het inloggen niet afgerond.',
    },
    minutesLeft: { one: 'Nog 1 minuut', other: 'Nog {count} minuten' },
    service: {
      title: 'Wachten op {name}…',
      web: 'Log in en sta Whombat toe in het tabblad dat openging. Deze pagina gaat vanzelf verder',
      phone: 'Log in en sta Whombat toe in de browser die openging. Dit scherm gaat vanzelf verder',
      open: 'De aanmelding van {name} openen',
      userCode: 'Vul deze code in als {name} erom vraagt.',
      codeLabel: 'Code',
      codeCopied: 'Code gekopieerd.',
      cancel: 'Annuleren',
      failed: '{name} heeft het inloggen niet afgerond.',
    },
  },
);

/** Settings → Connections (`connections/settingsList.ts`). */
export const CONN_SETTINGS_WORDS = treeCatalogs(
  'connSettings',
  {
    intro: 'What this Whombat is signed in to, and how.',
    needsYou: 'NEEDS YOU',
    accounts: 'ACCOUNTS',
    apps: 'APPS AND SERVICES',
    sameName: 'Same name as another connection. Rename one to tell them apart.',
  },
  {
    intro: 'Waar deze Whombat bij is ingelogd, en hoe.',
    needsYou: 'ACTIE NODIG',
    accounts: 'ACCOUNTS',
    apps: 'APPS EN DIENSTEN',
    sameName: 'Zelfde naam als een andere koppeling. Geef er een een andere naam om ze uit elkaar te houden.',
  },
);

/** Signing in again with a new code (`connections/signInAgain.ts`). */
export const CONN_SIGN_IN_AGAIN_WORDS = treeCatalogs(
  'connSignInAgain',
  {
    button: 'Sign in again',
    submit: 'Sign in',
    kept: 'Whombat’s own sign-in is kept sealed on this Whombat. When it ends, sign in again with a new {secret}.',
    needs: '{name} needs a new {secret} before Whombat can use it again.',
    signingIn: 'Signing in to {name}…',
    done: 'Signed in to {name} again.',
    codeNeeded: '{label} is needed.',
  },
  {
    button: 'Opnieuw inloggen',
    submit: 'Inloggen',
    kept: 'Whombats eigen aanmelding blijft verzegeld op deze Whombat. Als die afloopt, log je opnieuw in met een nieuwe {secret}.',
    needs: '{name} heeft een nieuwe {secret} nodig voordat Whombat het weer kan gebruiken.',
    signingIn: 'Inloggen bij {name}…',
    done: 'Weer ingelogd bij {name}.',
    codeNeeded: '{label} is nodig.',
  },
);

/** Guide cards in the assistant's chat (`guides.ts`). */
export const GUIDES_WORDS = treeCatalogs(
  'guides',
  {
    sending: 'Sending…',
    network: 'Couldn’t reach Whombat. Nothing changed, try again.',
    checkFields: 'Check the fields and try again.',
  },
  {
    sending: 'Versturen…',
    network: 'Kon Whombat niet bereiken. Er is niets veranderd, probeer het opnieuw.',
    checkFields: 'Controleer de velden en probeer het opnieuw.',
  },
);
