import { splitPairs } from './pairs.js';

/**
 * Vault keys, SSH, network and ask words (`vault/copy.ts`, `vault/ssh.ts`, `vault/network.ts`, `vault/ask.ts`). What
 * is stored or signed (check summaries, a use's `what`, audit lines) and what the agent reads stay English in code.
 */
export const VAULT_MORE_MESSAGES = splitPairs({
  /* How an entry reaches the agent's commands. */
  'vaultKeys.copy.envName': ['ENVIRONMENT VARIABLE', 'OMGEVINGSVARIABELE'],
  'vaultKeys.copy.envNameHint': [
    'Set in every command of your chats. Basic auth gets _USERNAME and _PASSWORD.',
    'Ingesteld in elk commando van je chats. Basic auth krijgt _USERNAME en _PASSWORD.',
  ],
  'vaultKeys.copy.sshHint': [
    'The agent’s commands on your Whombat get the key and an SSH configuration with your servers’ names during your chats.',
    'De commando’s van de assistent op je Whombat krijgen tijdens je chats de sleutel en een SSH-configuratie met de namen van je servers.',
  ],
  'vaultKeys.copy.loginHint': [
    'It signs in for you in its browser. It never sees the password.',
    'Hij logt voor je in in zijn browser. Het wachtwoord ziet hij nooit.',
  ],
  'vaultKeys.copy.mcpHint': [
    'Its tools that are on can be used in your chats.',
    'De tools die aanstaan, kunnen in je chats worden gebruikt.',
  ],

  /* Taking a key back. */
  'vaultKeys.rotate.had': [
    '{agent} had “{entry}” in its commands and may have kept a copy.',
    '{agent} had “{entry}” in zijn commando’s en heeft misschien een kopie bewaard.',
  ],
  'vaultKeys.rotate.ssh': [
    '{had} Generate a new key and put its public key on the servers below to be sure.',
    '{had} Maak voor de zekerheid een nieuwe sleutel en zet de openbare sleutel op de servers hieronder.',
  ],
  'vaultKeys.rotate.login': [
    '{had} Change the password on the website to be sure.',
    '{had} Wijzig voor de zekerheid het wachtwoord op de website.',
  ],
  'vaultKeys.rotate.other': [
    '{had} Change the secret where it was made to be sure.',
    '{had} Wijzig voor de zekerheid het geheim waar het is gemaakt.',
  ],

  /* The `ssh` entry's form and detail. */
  'vaultSsh.copy.key': ['Key', 'Sleutel'],
  'vaultSsh.copy.generate': ['Generate a new key', 'Nieuwe sleutel maken'],
  'vaultSsh.copy.useOwn': ['Use my own key', 'Mijn eigen sleutel gebruiken'],
  'vaultSsh.copy.privateKey': ['Private key', 'Privésleutel'],
  'vaultSsh.copy.passphrase': ['Passphrase (if it has one)', 'Wachtwoordzin (als hij er een heeft)'],
  'vaultSsh.copy.generateHint': [
    'Whombat makes the key. Its private half never leaves this Whombat.',
    'Whombat maakt de sleutel. De privéhelft verlaat deze Whombat nooit.',
  ],
  'vaultSsh.copy.passphraseHint': [
    'Used once to open the key. Whombat doesn’t keep it.',
    'Eén keer gebruikt om de sleutel te openen. Whombat bewaart hem niet.',
  ],
  'vaultSsh.copy.publicKey': ['PUBLIC KEY', 'OPENBARE SLEUTEL'],
  'vaultSsh.copy.authorizedKeysHint': [
    'Add this line to ~/.ssh/authorized_keys for the user the agent signs in as, on every server below.',
    'Zet deze regel in ~/.ssh/authorized_keys van de gebruiker waarmee de assistent inlogt, op elke server hieronder.',
  ],
  'vaultSsh.copy.copy': ['Copy', 'Kopiëren'],
  'vaultSsh.copy.copied': ['Copied', 'Gekopieerd'],
  'vaultSsh.copy.generateNew': ['Generate a new key', 'Nieuwe sleutel maken'],
  'vaultSsh.copy.replaceOwn': ['Replace with my own key', 'Vervangen door mijn eigen sleutel'],
  'vaultSsh.copy.replaceWarning': [
    'The old key stops working on every server at once. The servers and their host keys stay.',
    'De oude sleutel werkt meteen op geen enkele server meer. De servers en hun hostsleutels blijven.',
  ],
  'vaultSsh.copy.servers': ['SERVERS', 'SERVERS'],
  'vaultSsh.copy.noServers': [
    'No servers yet. Add the servers this key signs in to.',
    'Nog geen servers. Voeg de servers toe waarop deze sleutel inlogt.',
  ],
  'vaultSsh.copy.addServer': ['Add server', 'Server toevoegen'],
  'vaultSsh.copy.editServer': ['Edit server', 'Server bewerken'],
  'vaultSsh.copy.serverName': ['Name', 'Naam'],
  'vaultSsh.copy.serverNameHint': [
    'The agent uses this name, like web-1.',
    'De assistent gebruikt deze naam, zoals web-1.',
  ],
  'vaultSsh.copy.host': ['Host', 'Host'],
  'vaultSsh.copy.port': ['Port', 'Poort'],
  'vaultSsh.copy.username': ['Username', 'Gebruikersnaam'],
  'vaultSsh.copy.check': ['Check', 'Controleren'],
  'vaultSsh.copy.edit': ['Edit', 'Bewerken'],
  'vaultSsh.copy.remove': ['Remove', 'Verwijderen'],
  'vaultSsh.copy.removeServer': [
    'Remove this server? The agent can’t reach it with this key any more.',
    'Deze server verwijderen? De assistent kan hem dan niet meer bereiken met deze sleutel.',
  ],
  'vaultSsh.copy.hostChangeNote': [
    'Changing the host or port forgets its trusted host key.',
    'Als je de host of poort wijzigt, vergeet Whombat de vertrouwde hostsleutel.',
  ],
  'vaultSsh.copy.trustQuestion': ['Is this your server?', 'Is dit jouw server?'],
  'vaultSsh.copy.trust': ['Yes, trust it', 'Ja, vertrouwen'],
  'vaultSsh.copy.hostKeyUnconfirmed': ['Not trusted yet', 'Nog niet vertrouwd'],
  'vaultSsh.copy.hostKeyChanged': [
    'It doesn’t look like the same server any more. Check it before the agent uses it again.',
    'Hij lijkt niet meer dezelfde server te zijn. Controleer hem voordat de assistent hem weer gebruikt.',
  ],
  'vaultSsh.copy.serversChooser': ['Servers', 'Servers'],
  'vaultSsh.copy.allServers': ['All servers', 'Alle servers'],
  'vaultSsh.copy.sshOnWeb': [
    'SSH keys and servers are set up on the web, in the Vault.',
    'SSH-sleutels en servers stel je in op het web, in de kluis.',
  ],
  'vaultSsh.keyServers.none': ['No servers', 'Geen servers'],

  /* How a key type is written (as `ssh-keygen -l` does, the same in every language). */
  'vaultSsh.keyType.ed25519': ['ED25519', 'ED25519'],
  'vaultSsh.keyType.rsa': ['RSA', 'RSA'],
  'vaultSsh.keyType.ecdsa': ['ECDSA', 'ECDSA'],

  /* The Production switch of an SSH server. */
  'vaultSsh.production.label': ['Production', 'Productie'],
  'vaultSsh.production.hint': [
    'The agent’s commands can’t reach this server until you say yes to one.',
    'De assistent kan met zijn commando’s pas bij deze server als je een commando goedkeurt.',
  ],
  'vaultSsh.production.badge': ['PRODUCTION', 'PRODUCTIE'],

  /* A server's check, in words (English is what a check stores). */
  'vaultSsh.check.signedInAs': ['Signed in as {username}', 'Ingelogd als {username}'],
  'vaultSsh.check.signedIn': ['Signed in', 'Ingelogd'],
  'vaultSsh.check.rejected': ['The server refused the key.', 'De server weigerde de sleutel.'],
  'vaultSsh.check.unreachable': ['Couldn’t reach it.', 'Kon hem niet bereiken.'],
  'vaultSsh.check.timeout': [
    'It didn’t answer within {seconds} seconds.',
    'Hij antwoordde niet binnen {seconds} seconden.',
  ],
  'vaultSsh.check.notAllowed': ['Not allowed: {reason}', 'Niet toegestaan: {reason}'],
  'vaultSsh.check.notAllowedReason': ['this address isn’t allowed.', 'dit adres is niet toegestaan.'],
  'vaultSsh.check.badAnswer': [
    'It answered, but not as an SSH server.',
    'Hij antwoordde, maar niet als een SSH-server.',
  ],

  /* The trust card. */
  'vaultSsh.trust.ask': ['Is {name} the server at {where}?', 'Is {name} de server op {where}?'],
  'vaultSsh.trust.changed': [
    '{name} at {where} doesn’t look like the server Whombat knew. Did you set it up again or replace it?',
    '{name} op {where} lijkt niet op de server die Whombat kende. Heb je hem opnieuw ingesteld of vervangen?',
  ],
  'vaultSsh.trust.compare': ['Compare it with', 'Vergelijk hem met'],
  'vaultSsh.trust.after': ['on the server.', 'op de server.'],

  /* A server form's fields. */
  'vaultSsh.field.name': [
    'Use 1–{max} letters, digits, dots, dashes and underscores, starting with a letter or digit.',
    'Gebruik 1–{max} letters, cijfers, punten, streepjes en underscores, te beginnen met een letter of cijfer.',
  ],
  'vaultSsh.field.nameTaken': [
    'This key already has a server with that name.',
    'Deze sleutel heeft al een server met die naam.',
  ],
  'vaultSsh.field.username': [
    'Use 1–{max} letters, digits, dots, dashes and underscores, starting with a letter or underscore.',
    'Gebruik 1–{max} letters, cijfers, punten, streepjes en underscores, te beginnen met een letter of underscore.',
  ],
  'vaultSsh.field.host': [
    'That isn’t a host name or IP address. Write it like web1.example.com or 192.168.1.10.',
    'Dat is geen hostnaam of IP-adres. Schrijf het als web1.example.com of 192.168.1.10.',
  ],
  'vaultSsh.field.port': ['Use a port between 1 and 65535.', 'Gebruik een poort tussen 1 en 65535.'],
  'vaultSsh.field.address': [
    'That isn’t a host name or IP address with an optional port. Write it like web1.example.com, 192.168.1.10 or 192.168.1.10:2222.',
    'Dat is geen hostnaam of IP-adres met eventueel een poort. Schrijf het als web1.example.com, 192.168.1.10 of 192.168.1.10:2222.',
  ],
  'vaultSsh.field.addressUser': [
    'Put the user in username: the address is only the host and its port.',
    'Zet de gebruiker in username: het adres is alleen de host en de poort.',
  ],

  /* Why a pasted private key can't be imported. */
  'vaultSsh.keyProblem.empty': ['Paste the private key.', 'Plak de privésleutel.'],
  'vaultSsh.keyProblem.too_long': [
    'That’s longer than any SSH key Whombat accepts.',
    'Dat is langer dan elke SSH-sleutel die Whombat accepteert.',
  ],
  'vaultSsh.keyProblem.not_a_key': [
    'That isn’t a private key. Paste the whole file, from -----BEGIN to the -----END line, like ~/.ssh/id_ed25519.',
    'Dat is geen privésleutel. Plak het hele bestand, van -----BEGIN tot en met de regel -----END, zoals ~/.ssh/id_ed25519.',
  ],
  'vaultSsh.keyProblem.public_key': [
    'That’s the public key. Paste the private key: the file without .pub.',
    'Dat is de openbare sleutel. Plak de privésleutel: het bestand zonder .pub.',
  ],
  'vaultSsh.keyProblem.putty': [
    'That’s a PuTTY key. Export it in OpenSSH format first (PuTTYgen → Conversions → Export OpenSSH key).',
    'Dat is een PuTTY-sleutel. Exporteer hem eerst in OpenSSH-formaat (PuTTYgen → Conversions → Export OpenSSH key).',
  ],
  'vaultSsh.keyProblem.certificate': [
    'SSH certificates aren’t supported. Paste the private key itself.',
    'SSH-certificaten worden niet ondersteund. Plak de privésleutel zelf.',
  ],
  'vaultSsh.keyProblem.several_keys': ['Paste one private key at a time.', 'Plak één privésleutel tegelijk.'],
  'vaultSsh.keyProblem.fido': [
    'Security-key (FIDO) SSH keys can’t be used: they need the key plugged in.',
    'SSH-sleutels op een beveiligingssleutel (FIDO) kun je niet gebruiken: daarvoor moet de sleutel ingeplugd zijn.',
  ],
  'vaultSsh.keyProblem.unsupported_type': [
    'Use an Ed25519, ECDSA or RSA key. DSA and other kinds aren’t accepted.',
    'Gebruik een Ed25519-, ECDSA- of RSA-sleutel. DSA en andere soorten worden niet geaccepteerd.',
  ],
  'vaultSsh.keyProblem.rsa_too_short': [
    'That RSA key is shorter than 2048 bits. Use a longer one or generate a new key.',
    'Die RSA-sleutel is korter dan 2048 bits. Gebruik een langere of maak een nieuwe sleutel.',
  ],
  'vaultSsh.keyProblem.passphrase_needed': [
    'That key is protected by a passphrase. Enter it below: it is used once and not kept.',
    'Die sleutel is beveiligd met een wachtwoordzin. Vul hem hieronder in: hij wordt één keer gebruikt en niet bewaard.',
  ],
  'vaultSsh.keyProblem.wrong_passphrase': [
    'That passphrase doesn’t open the key.',
    'Die wachtwoordzin opent de sleutel niet.',
  ],
  'vaultSsh.keyProblem.unreadable': [
    'Whombat couldn’t read that key. Paste it again, or generate a new key.',
    'Whombat kon die sleutel niet lezen. Plak hem opnieuw of maak een nieuwe sleutel.',
  ],

  /* The home network list. */
  'vaultNet.problem.invalid': [
    'That isn’t a network. Write it like 192.168.1.0/24.',
    'Dat is geen netwerk. Schrijf het als 192.168.1.0/24.',
  ],
  'vaultNet.problem.mapped': [
    'Write an IPv4 network as IPv4, like 192.168.1.0/24.',
    'Schrijf een IPv4-netwerk als IPv4, zoals 192.168.1.0/24.',
  ],
  'vaultNet.problem.too_wide': [
    'That network is too wide. Use a /16 or narrower (a /48 or narrower for IPv6).',
    'Dat netwerk is te breed. Gebruik een /16 of smaller (een /48 of smaller voor IPv6).',
  ],
  'vaultNet.problem.public': [
    'That’s a public network. Entries reach public addresses over https without being on this list.',
    'Dat is een openbaar netwerk. Items bereiken openbare adressen via https zonder op deze lijst te staan.',
  ],
  'vaultNet.problem.loopback': [
    'Loopback addresses can’t be on this list.',
    'Loopback-adressen kunnen niet op deze lijst.',
  ],
  'vaultNet.problem.link_local': [
    'Link-local addresses can’t be on this list.',
    'Link-local-adressen kunnen niet op deze lijst.',
  ],
  'vaultNet.problem.metadata': [
    'That network holds a cloud metadata address, so it can’t be on this list.',
    'Dat netwerk bevat een cloud-metadata-adres, dus het kan niet op deze lijst.',
  ],
  'vaultNet.problem.multicast': [
    'Multicast addresses can’t be on this list.',
    'Multicast-adressen kunnen niet op deze lijst.',
  ],
  'vaultNet.problem.unspecified': [
    'That address can’t be on this list.',
    'Dat adres kan niet op deze lijst.',
  ],
  'vaultNet.problem.reserved': [
    'Reserved addresses can’t be on this list.',
    'Gereserveerde adressen kunnen niet op deze lijst.',
  ],
  'vaultNet.problem.documentation': [
    'Documentation addresses can’t be on this list.',
    'Documentatieadressen kunnen niet op deze lijst.',
  ],
  'vaultNet.problem.ports': [
    'List 1–{max} different ports between 1 and 65535.',
    'Geef 1–{max} verschillende poorten tussen 1 en 65535 op.',
  ],

  /* An entry's web address. */
  'vaultNet.url.invalid': [
    'That isn’t a web address. Write it like https://api.example.com.',
    'Dat is geen webadres. Schrijf het als https://api.example.com.',
  ],
  'vaultNet.url.scheme': [
    'Use an address that starts with https:// (or http:// on your home network).',
    'Gebruik een adres dat begint met https:// (of http:// op je thuisnetwerk).',
  ],
  'vaultNet.url.credentials': [
    'Leave the username and password out of the address; the Vault keeps them.',
    'Laat de gebruikersnaam en het wachtwoord weg uit het adres; de kluis bewaart ze.',
  ],
  'vaultNet.url.query': ['Leave ?… and #… out of the address.', 'Laat ?… en #… weg uit het adres.'],
  'vaultNet.url.host': ['That address has no valid host name.', 'Dat adres heeft geen geldige hostnaam.'],
  'vaultNet.url.port': ['That address has no valid port.', 'Dat adres heeft geen geldige poort.'],
  'vaultNet.url.path': [
    'That address has a path Whombat can’t use (no “..”, “//” or encoded slashes).',
    'Dat adres heeft een pad dat Whombat niet kan gebruiken (geen “..”, “//” of gecodeerde slashes).',
  ],

  /* The card `vault_ask` posts. */
  'vaultAsk.text.under': [
    'It goes straight to your Vault. {assistant} never sees it.',
    'Het gaat direct naar je kluis. {assistant} ziet het nooit.',
  ],
  'vaultAsk.text.underCode': ['Used once, not kept.', 'Eén keer gebruikt, niet bewaard.'],
  'vaultAsk.text.replaces': [
    'It replaces the one saved as “{name}”.',
    'Het vervangt het item dat is opgeslagen als “{name}”.',
  ],
  'vaultAsk.text.save': ['Save', 'Opslaan'],
  'vaultAsk.text.signIn': ['Sign in', 'Inloggen'],
  'vaultAsk.text.send': ['Send', 'Versturen'],
  'vaultAsk.text.notNow': ['Not now', 'Niet nu'],
  'vaultAsk.text.desk': ['Answer on your phone or computer', 'Antwoord op je telefoon of computer'],
  'vaultAsk.text.fields.username': ['Username', 'Gebruikersnaam'],
  'vaultAsk.text.fields.password': ['Password', 'Wachtwoord'],
  'vaultAsk.text.fields.token': ['Sign-in key', 'Inlogsleutel'],
  'vaultAsk.text.fields.totp': ['Authenticator key', 'Authenticatorsleutel'],
  'vaultAsk.text.fields.privateKey': ['Private key', 'Privésleutel'],
  'vaultAsk.text.fields.passphrase': ['Passphrase', 'Wachtwoordzin'],
  'vaultAsk.text.fields.code': ['Code', 'Code'],
  'vaultAsk.text.placeholders.totp': [
    'Optional: the setup key or otpauth:// link',
    'Optioneel: de instelsleutel of otpauth://-link',
  ],
  'vaultAsk.text.placeholders.privateKey': ['Paste it or pick the file', 'Plak hem of kies het bestand'],
  'vaultAsk.text.placeholders.passphrase': ['Only if the key has one', 'Alleen als de sleutel er een heeft'],
  'vaultAsk.text.ways.key_once': [
    'Use the password once to put {assistant}’s key on it',
    'Gebruik het wachtwoord één keer om de sleutel van {assistant} erop te zetten',
  ],
  'vaultAsk.text.ways.keep_password': ['Keep the password', 'Het wachtwoord bewaren'],
  'vaultAsk.text.ways.own_key': ['Use my own private key', 'Mijn eigen privésleutel gebruiken'],
  'vaultAsk.text.wayDetails.key_once': [
    'Whombat signs in once, adds {assistant}’s key and forgets the password.',
    'Whombat logt één keer in, voegt de sleutel van {assistant} toe en vergeet het wachtwoord.',
  ],
  'vaultAsk.text.wayDetails.keep_password': [
    'For servers that don’t take keys. Kept in your Vault with this server.',
    'Voor servers die geen sleutels accepteren. Bewaard in je kluis bij deze server.',
  ],
  'vaultAsk.text.wayDetails.own_key': [
    'Paste it or pick the file. A passphrase is used once and not kept.',
    'Plak hem of kies het bestand. Een wachtwoordzin wordt één keer gebruikt en niet bewaard.',
  ],
  'vaultAsk.text.tooManyTries': [
    'That didn’t work {count} times, so this card is closed.',
    'Dat lukte {count} keer niet, dus deze kaart is gesloten.',
  ],
  'vaultAsk.text.empty.username': ['Type the username.', 'Typ de gebruikersnaam.'],
  'vaultAsk.text.empty.secret': ['Type the password.', 'Typ het wachtwoord.'],
  'vaultAsk.text.empty.token': ['Type the sign-in key.', 'Typ de inlogsleutel.'],
  'vaultAsk.text.empty.password': ['Type the password.', 'Typ het wachtwoord.'],
  'vaultAsk.text.empty.privateKey': [
    'Paste the private key or pick its file.',
    'Plak de privésleutel of kies het bestand.',
  ],
  'vaultAsk.text.empty.code': ['Type the code.', 'Typ de code.'],
  'vaultAsk.title.token': [
    '{assistant} needs a sign-in key for {name}',
    '{assistant} heeft een inlogsleutel nodig voor {name}',
  ],
  'vaultAsk.title.keyRefused': [
    '{assistant} couldn’t sign in to {name} with its key',
    '{assistant} kon met zijn sleutel niet inloggen op {name}',
  ],
  'vaultAsk.title.server': ['{assistant} needs to sign in to {name}', '{assistant} moet inloggen op {name}'],
  'vaultAsk.title.code': ['Type the code {name} sent you', 'Typ de code die {name} je stuurde'],
  'vaultAsk.title.password': [
    '{assistant} needs the password for {name}',
    '{assistant} heeft het wachtwoord voor {name} nodig',
  ],
  'vaultAsk.error.password_wrong': [
    'That password didn’t work. Try again.',
    'Dat wachtwoord werkte niet. Probeer het opnieuw.',
  ],
  'vaultAsk.error.password_login_off': [
    '{server} doesn’t take passwords. Use your own private key instead.',
    '{server} accepteert geen wachtwoorden. Gebruik in plaats daarvan je eigen privésleutel.',
  ],
  'vaultAsk.error.key_refused': ['{server} refused that key.', '{server} weigerde die sleutel.'],
  'vaultAsk.error.passphrase_wrong': [
    'That passphrase doesn’t open the key.',
    'Die wachtwoordzin opent de sleutel niet.',
  ],
  'vaultAsk.error.key_invalid': [
    'That isn’t a private key Whombat can use.',
    'Dat is geen privésleutel die Whombat kan gebruiken.',
  ],
  'vaultAsk.error.host_key_changed': [
    'Something else answers at {server}’s address now, so Whombat sent nothing. Check the server in the Vault.',
    'Op het adres van {server} antwoordt nu iets anders, dus Whombat heeft niets verstuurd. Controleer de server in de kluis.',
  ],
  'vaultAsk.error.unreachable': [
    'Couldn’t reach {server}. Check it’s on and try again.',
    'Kon {server} niet bereiken. Controleer of hij aanstaat en probeer het opnieuw.',
  ],
  'vaultAsk.error.not_allowed': [
    'Whombat can’t reach {server}’s address.',
    'Whombat kan het adres van {server} niet bereiken.',
  ],
  'vaultAsk.locked.saved': ['Saved to your Vault · {name}', 'Opgeslagen in je kluis · {name}'],
  'vaultAsk.locked.signed_in': ['Signed in to {server}', 'Ingelogd op {server}'],
  'vaultAsk.locked.key_added': [
    'Signed in to {server} · key added',
    'Ingelogd op {server} · sleutel toegevoegd',
  ],
  'vaultAsk.locked.password_saved': [
    'Signed in to {server} · password saved',
    'Ingelogd op {server} · wachtwoord opgeslagen',
  ],
  'vaultAsk.locked.key_imported': [
    'Signed in to {server} · your key saved',
    'Ingelogd op {server} · je sleutel opgeslagen',
  ],
  'vaultAsk.locked.code_given': ['Code used once · not kept', 'Code één keer gebruikt · niet bewaard'],
  'vaultAsk.locked.refused': ['Couldn’t sign in to {server}', 'Kon niet inloggen op {server}'],
  'vaultAsk.locked.too_late': [
    'Too late for that sign-in · not used',
    'Te laat voor die inlog · niet gebruikt',
  ],

  /* Where a use put the entry (stored in English by `vaultTurnUseWhat`, shown in the person's language). */
  'vaultUse.what.browser': [
    'in {agent}’s browser for this turn',
    'in de browser van {agent} voor deze beurt',
  ],
  'vaultUse.what.tools': ['in {agent}’s tools for this turn', 'in de tools van {agent} voor deze beurt'],
  'vaultUse.what.commands': [
    'in {agent}’s commands for this turn',
    'in de commando’s van {agent} voor deze beurt',
  ],
});
