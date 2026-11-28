/**
 * Open to the internet (docs/decisions/internet-exposure.md): the page's rows, what guards each opening, what is worth
 * a look and the places Whombat looked. `phrase.exposure.*` are the line Something new is open to the internet, which
 * the health pass writes in English and the phrasebook says in the reader's language.
 */
import { splitPairs } from './pairs';

export const EXPOSURE = splitPairs({
  // A row: what is open and what it leads to.
  'exposure.port': ['Port {port}', 'Poort {port}'],
  'exposure.moreNames': [
    { one: '{address} and 1 more', other: '{address} and {count} more' },
    { one: '{address} en nog 1', other: '{address} en nog {count}' },
  ],
  'exposure.leadsTo': ['{address} → {what}', '{address} → {what}'],
  'exposure.on': ['{name} on {machine}', '{name} op {machine}'],

  // Where it comes from.
  'exposure.via.proxy': ['Through {source}', 'Via {source}'],
  'exposure.via.stream': ['A stream on {source} · {protocol}', 'Een stream op {source} · {protocol}'],
  'exposure.via.tunnel': ['Cloudflare tunnel ‘{tunnel}’', 'Cloudflare-tunnel ‘{tunnel}’'],
  'exposure.via.portForward': [
    'Port forward on {source} · {protocol}',
    'Port forward op {source} · {protocol}',
  ],
  'exposure.via.portForwardNamed': [
    'Port forward ‘{label}’ on {source} · {protocol}',
    'Port forward ‘{label}’ op {source} · {protocol}',
  ],
  'exposure.protocol.tcp': ['TCP', 'TCP'],
  'exposure.protocol.udp': ['UDP', 'UDP'],
  'exposure.protocol.both': ['TCP and UDP', 'TCP en UDP'],

  // What guards it.
  'exposure.https.yes': ['HTTPS', 'HTTPS'],
  'exposure.https.no': ['No HTTPS', 'Geen HTTPS'],
  'exposure.guard.accessList': ['access list ‘{name}’', 'toegangslijst ‘{name}’'],
  'exposure.guard.cloudflareAccess': ['Cloudflare Access', 'Cloudflare Access'],
  'exposure.guard.someAddresses': ['only from {addresses}', 'alleen vanaf {addresses}'],
  'exposure.guard.none': ['nothing in front of it', 'niets ervoor'],
  'exposure.guard.unknown': ['Whombat can’t tell what guards it', 'Whombat kan niet zien wat het beschermt'],

  // Worth a look.
  'exposure.risk.adminOpen': [
    '{what} can be reached from the internet with nothing in front of it.',
    '{what} is vanaf internet te bereiken zonder dat er iets voor staat.',
  ],
  'exposure.risk.noHttps': [
    'Without HTTPS, what people type there, passwords too, crosses the internet readable.',
    'Zonder HTTPS gaat wat mensen daar typen, ook wachtwoorden, leesbaar over internet.',
  ],
  'exposure.risk.certificateExpired': [
    'Its certificate ended {when}: browsers warn people away.',
    'Het certificaat is {when} verlopen: browsers waarschuwen mensen weg.',
  ],

  // Ask and change it.
  'exposure.ask': [
    'Is it safe that {address} is open to the internet ({via})?',
    'Is het veilig dat {address} vanaf internet bereikbaar is ({via})?',
  ],
  'exposure.manage': ['Change it in {source}', 'Wijzig het in {source}'],

  // The places Whombat looked.
  'exposure.source.openings': [
    { one: '1 opening', other: '{count} openings' },
    { one: '1 opening', other: '{count} openingen' },
  ],
  'exposure.source.nothing': ['Nothing open', 'Niets open'],
  'exposure.source.unread': ['Whombat couldn’t read it just now.', 'Whombat kon het nu niet lezen.'],
  'exposure.source.streamsUnread': [
    'Its streams couldn’t be read.',
    'De streams konden niet gelezen worden.',
  ],
  'exposure.source.tunnelsUnread': [
    'Whombat may not read its tunnels, so their public names are missing.',
    'Whombat mag de tunnels niet lezen, dus hun openbare namen ontbreken.',
  ],
  'exposure.source.tunnelLocal': [
    'Tunnel ‘{name}’ is set up on its own server: Whombat can’t see its public names.',
    'Tunnel ‘{name}’ is op de eigen server ingesteld: Whombat ziet de openbare namen niet.',
  ],
  'exposure.source.tunnelConfigUnread': [
    'The settings of tunnel ‘{name}’ couldn’t be read.',
    'De instellingen van tunnel ‘{name}’ konden niet gelezen worden.',
  ],
  'exposure.source.accessUnread': [
    'Whombat may not read Cloudflare Access, so it can’t tell which names it guards.',
    'Whombat mag Cloudflare Access niet lezen, dus kan niet zien welke namen het beschermt.',
  ],
  'exposure.source.upnpOn': [
    'UPnP is on: devices in the house can open ports by themselves, and Whombat can’t see which.',
    'UPnP staat aan: apparaten in huis kunnen zelf poorten openen, en Whombat ziet niet welke.',
  ],
  'exposure.source.upnpUnknown': [
    'Whombat can’t tell whether UPnP is on, which lets devices open ports by themselves.',
    'Whombat kan niet zien of UPnP aan staat, waarmee apparaten zelf poorten openen.',
  ],
  'exposure.source.funnelAllowed': [
    'Funnel is allowed for {who}: Whombat can’t see what those devices share with it.',
    'Funnel mag voor {who}: Whombat ziet niet wat die apparaten ermee delen.',
  ],
  'exposure.source.funnelOff': [
    'Funnel is off in your tailnet’s policy: nothing is shared through it.',
    'Funnel staat uit in het beleid van je tailnet: er wordt niets mee gedeeld.',
  ],
  'exposure.source.policyUnread': [
    'Whombat may not read your tailnet’s policy, so it can’t tell whether Funnel shares anything.',
    'Whombat mag het beleid van je tailnet niet lezen, dus ziet niet of Funnel iets deelt.',
  ],
  'exposure.source.router': ['Your router', 'Je router'],
  'exposure.source.routerMissing': [
    'Whombat can’t see your router’s port forwards. Connect it (OPNsense or UniFi) to include them.',
    'Whombat ziet de port forwards van je router niet. Koppel hem (OPNsense of UniFi) om ze mee te nemen.',
  ],
  'exposure.source.noUpnpRead': [
    'UPnP openings aren’t readable on {source}.',
    'UPnP-openingen zijn op {source} niet te lezen.',
  ],

  // The page's head.
  'exposure.summary.none': [
    'Nothing Whombat can see is open to the internet.',
    'Niets wat Whombat kan zien is vanaf internet bereikbaar.',
  ],
  'exposure.summary.openings': [
    { one: '1 opening', other: '{count} openings' },
    { one: '1 opening', other: '{count} openingen' },
  ],
  'exposure.summary.looks': [
    { one: '1 worth a look', other: '{count} worth a look' },
    { one: '1 om even naar te kijken', other: '{count} om even naar te kijken' },
  ],
  'exposure.summary.new': [
    { one: '1 new', other: '{count} new' },
    { one: '1 nieuw', other: '{count} nieuw' },
  ],
  'exposure.note': [
    'Whombat reads these from the settings of what it’s connected to. It never checks from outside your house, so something set up elsewhere can still be open.',
    'Whombat leest dit uit de instellingen van wat het gekoppeld heeft. Het kijkt nooit van buiten je huis, dus iets wat elders is ingesteld kan nog steeds open zijn.',
  ],

  // The line Something new is open to the internet (written in English by the health pass).
  'phrase.exposure.newTitle': [
    '{address} is open to the internet now',
    '{address} is nu vanaf internet bereikbaar',
  ],
  'phrase.exposure.newDetail': [
    'It leads to {what}. Is that meant?',
    'Het leidt naar {what}. Is dat de bedoeling?',
  ],
  'phrase.exposure.newBadge': ['New opening: {address}', 'Nieuwe opening: {address}'],
  'phrase.exposure.seeOpen': ['See what’s open', 'Bekijk wat open is'],
  'phrase.exposure.untilClosed': ['Until it’s closed.', 'Tot het dicht is.'],
  'phrase.exposure.check': [
    'Something new is open to the internet',
    'Iets nieuws is vanaf internet bereikbaar',
  ],
});
