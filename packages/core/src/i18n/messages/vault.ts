import { splitPairs } from './pairs.js';

/** The person's Vault (`vault/copy.ts`, `vault/schemas.ts`); the signed Vault audit lines stay English. */
export const VAULT = splitPairs({
  'vault.copy.title': ['Vault', 'Kluis'],
  'vault.copy.intro': [
    'What the agent can sign in to when it works for you. Only you can see these, and only your own chats use them.',
    'Waar de assistent op kan inloggen als hij voor je werkt. Alleen jij ziet deze, en alleen je eigen chats gebruiken ze.',
  ],
  'vault.copy.entries': ['YOUR ENTRIES', 'JE ITEMS'],
  'vault.copy.noEntries': ['Nothing in your Vault yet.', 'Nog niets in je kluis.'],
  'vault.copy.add': ['Add to Vault', 'Toevoegen aan kluis'],
  'vault.copy.homeNetwork': ['HOME NETWORK', 'THUISNETWERK'],
  'vault.copy.homeNetworkIntro': [
    'When the agent may not reach your whole local network, it reaches only these networks and ports.',
    'Als de assistent niet je hele lokale netwerk mag bereiken, bereikt hij alleen deze netwerken en poorten.',
  ],
  'vault.copy.noNetworks': ['No home networks listed.', 'Geen thuisnetwerken opgegeven.'],
  'vault.copy.descriptionLabel': ['What should the agent know?', 'Wat moet de assistent weten?'],
  'vault.copy.secret': ['SECRET', 'GEHEIM'],
  'vault.copy.connection': ['CONNECTION', 'VERBINDING'],
  'vault.copy.tools': ['TOOLS', 'TOOLS'],
  'vault.copy.keys': ['AGENT', 'ASSISTENT'],
  'vault.copy.recentUse': ['RECENT USE', 'RECENT GEBRUIK'],
  'vault.copy.manage': ['Manage in your Vault →', 'Beheren in je kluis →'],
  'vault.copy.keysNote': [
    '{agent} uses it only when it works for you.',
    '{agent} gebruikt het alleen als hij voor je werkt.',
  ],
  'vault.copy.replace': ['Replace', 'Vervangen'],
  'vault.copy.checkAgain': ['Check again', 'Opnieuw controleren'],
  'vault.copy.newBadge': ['New', 'Nieuw'],
  'vault.copy.remove': ['Remove from Vault', 'Uit kluis verwijderen'],
  'vault.copy.notSet': ['Not set', 'Niet ingesteld'],
  'vault.copy.notChecked': ['Not checked yet', 'Nog niet gecontroleerd'],
  'vault.copy.queryWarning': [
    'Query strings end up in server logs. Use a header if the service allows it.',
    'Querystrings komen in serverlogs terecht. Gebruik een header als de dienst dat toestaat.',
  ],
  'vault.copy.httpWarning': [
    'This address uses http: the secret crosses your network unencrypted.',
    'Dit adres gebruikt http: het geheim gaat onversleuteld over je netwerk.',
  ],
  'vault.copy.secretsOnWeb': [
    'Secrets are set on the web, in the Vault.',
    'Geheimen stel je in op het web, in de kluis.',
  ],
  'vault.copy.toolsIgnored': [
    {
      one: '{count} more tool was ignored: an entry keeps at most 64.',
      other: '{count} more tools were ignored: an entry keeps at most 64.',
    },
    {
      one: 'Nog {count} tool is genegeerd: een item houdt er hooguit 64.',
      other: 'Nog {count} tools zijn genegeerd: een item houdt er hooguit 64.',
    },
  ],
  'vault.copy.setBy': ['Set by {name}', 'Ingesteld door {name}'],

  'vault.template.mcp.label': ['Connection', 'Verbinding'],
  'vault.template.mcp.description': [
    'A service whose tools the agent can use, like Home Assistant.',
    'Een dienst waarvan de assistent de tools kan gebruiken, zoals Home Assistant.',
  ],
  'vault.template.token.label': ['Sign-in key', 'Inlogsleutel'],
  'vault.template.token.description': [
    'A key a service gave you, for the agent to use in your chats.',
    'Een sleutel die je van een dienst kreeg, voor de assistent om in je chats te gebruiken.',
  ],
  'vault.template.basic.label': ['Password', 'Wachtwoord'],
  'vault.template.basic.description': [
    'A username and password for an app or device the agent talks to.',
    'Een gebruikersnaam en wachtwoord voor een app of apparaat waar de assistent mee praat.',
  ],
  'vault.template.login.label': ['Website login', 'Website-login'],
  'vault.template.login.description': [
    'A website the agent signs in to in its browser. It never sees the password.',
    'Een website waar de assistent in zijn browser op inlogt. Het wachtwoord ziet hij nooit.',
  ],
  'vault.template.ssh.label': ['Server key', 'Serversleutel'],
  'vault.template.ssh.description': [
    'A key the agent uses to sign in to your servers, in your chats.',
    'Een sleutel waarmee de assistent in je chats op je servers inlogt.',
  ],
  'vault.template.secret.label': ['Secret', 'Geheim'],
  'vault.template.secret.description': [
    'A single value kept for an older Whombat feature. Nothing uses it now.',
    'Eén waarde, bewaard voor een oudere functie van Whombat. Niets gebruikt hem nu.',
  ],

  'vault.outcome.done': ['done', 'klaar'],
  'vault.outcome.failed': ['failed', 'mislukt'],
  'vault.outcome.refused': ['refused', 'geweigerd'],
  'vault.outcome.timed_out': ['timed out', 'verlopen'],

  'vault.meta.on': ['on for {agent}', 'aan voor {agent}'],
  'vault.meta.off': ['off for {agent}', 'uit voor {agent}'],
  'vault.meta.unused': ['{label} · nothing uses it', '{label} · niets gebruikt het'],
  'vault.servers': [
    { one: '{count} server', other: '{count} servers' },
    { one: '{count} server', other: '{count} servers' },
  ],
  'vault.noServers': ['no servers', 'geen servers'],

  'vault.problem.password': ['The password stopped working.', 'Het wachtwoord werkt niet meer.'],
  'vault.problem.key': ['The sign-in key stopped working.', 'De inlogsleutel werkt niet meer.'],
  'vault.problem.unreachable': ['Whombat can’t reach it right now.', 'Whombat kan het nu niet bereiken.'],
  'vault.problem.timeout': ['It didn’t answer in time.', 'Het antwoordde niet op tijd.'],
  'vault.problem.notAllowed': [
    'Whombat isn’t allowed to reach its address.',
    'Whombat mag het adres niet bereiken.',
  ],
  'vault.problem.badAnswer': [
    'It answered, but not the way Whombat expected.',
    'Het antwoordde, maar niet zoals Whombat verwachtte.',
  ],
  'vault.problem.servers': [
    { one: 'One of its servers isn’t working.', other: '{count} of its servers aren’t working.' },
    { one: 'Een van de servers werkt niet.', other: '{count} van de servers werken niet.' },
  ],
  'vault.problem.sshRejected': ['The server didn’t take the key.', 'De server accepteerde de sleutel niet.'],
  'vault.problem.hostChanged': [
    'The server doesn’t look like the same server any more.',
    'De server lijkt niet meer dezelfde server te zijn.',
  ],
  'vault.problem.other': ['Its last check failed.', 'De laatste controle is mislukt.'],

  'vault.checkLine': ['Checked {ago} · {summary}', 'Gecontroleerd {ago} · {summary}'],
  'vault.secretLine.replaced': ['Set · replaced {ago}', 'Ingesteld · vervangen {ago}'],
  'vault.secretLine.added': ['Set · added {ago}', 'Ingesteld · toegevoegd {ago}'],
  'vault.theAgent': ['The agent', 'De assistent'],
  'vault.lastUsed': ['Used {when}', 'Gebruikt {when}'],
  'vault.access.title': ['{agent} can use this', '{agent} mag dit gebruiken'],
  'vault.access.on': ['On', 'Aan'],
  'vault.access.off': ['Off', 'Uit'],
  'vault.access.hintOn': [
    '{agent} uses it when it works for you, never for anyone else.',
    '{agent} gebruikt het als hij voor je werkt, nooit voor iemand anders.',
  ],
  'vault.access.hintOff': ['{agent} can’t use it.', '{agent} kan het niet gebruiken.'],
  'vault.savedIntro': [
    'When you send {agent} a password in your chat, it keeps it here and hides it in your message. The AI service it runs on has still seen that one message.',
    'Als je {agent} een wachtwoord stuurt in je chat, bewaart hij het hier en verbergt hij het in je bericht. De AI-dienst waarop hij draait heeft dat ene bericht wel gezien.',
  ],
  'vault.saved.usedOnce': [
    'Used once to put “{name}” on {server}, not kept',
    'Eén keer gebruikt om “{name}” op {server} te zetten, niet bewaard',
  ],
  'vault.saved.aServer': ['a server', 'een server'],
  'vault.saved.kept': ['Saved to your Vault · {name}', 'Opgeslagen in je kluis · {name}'],
});
