import { splitPairs } from './pairs';

/**
 * The welcome thread (`guides/welcome.ts`, `guides/copy.ts`): what the box found, its buttons and the mail step. Dutch
 * names finds with their own article (`de`/`het`, `een`), never an English article swapped in.
 */
export const GUIDES = splitPairs({
  'guides.canDo': [
    'I can look after your servers, your network and your home, and help with your email.',
    'Ik kan je servers, je netwerk en je huis in de gaten houden, en je helpen met je e-mail.',
  ],
  'guides.welcomeFound': [
    {
      one: 'Hi {person}, I’m {agent}. I found {found} on your network. Want me to look after it?',
      other: 'Hi {person}, I’m {agent}. I found {found} on your network. Want me to look after them?',
    },
    {
      one: 'Hoi {person}, ik ben {agent}. Ik heb {found} gevonden op je netwerk. Zal ik het in de gaten houden?',
      other:
        'Hoi {person}, ik ben {agent}. Ik heb {found} gevonden op je netwerk. Zal ik ze in de gaten houden?',
    },
  ],
  'guides.welcomeLooking': [
    'Hi {person}, I’m {agent}. {canDo} I’m looking around your network now and I’ll tell you what I find.',
    'Hoi {person}, ik ben {agent}. {canDo} Ik kijk nu rond op je netwerk en vertel je wat ik vind.',
  ],
  'guides.welcomeQuiet': [
    'Hi {person}, I’m {agent}. {canDo} Tell me what you’d like me to look after.',
    'Hoi {person}, ik ben {agent}. {canDo} Vertel me wat ik voor je in de gaten moet houden.',
  ],
  'guides.foundLater': [
    {
      one: 'I looked around your network and found {found}. Want me to look after it?',
      other: 'I looked around your network and found {found}. Want me to look after them?',
    },
    {
      one: 'Ik heb rondgekeken op je netwerk en {found} gevonden. Zal ik het in de gaten houden?',
      other: 'Ik heb rondgekeken op je netwerk en {found} gevonden. Zal ik ze in de gaten houden?',
    },
  ],
  'guides.foundTitle': ['Found on your network', 'Gevonden op je netwerk'],
  'guides.foundBodyOne': [
    'Connect it, and I’ll keep an eye on it.',
    'Koppel het, dan houd ik het in de gaten.',
  ],
  'guides.foundBodyMany': [
    'Connect the ones you want, and I’ll keep an eye on them.',
    'Koppel wat je wilt, dan houd ik het in de gaten.',
  ],
  'guides.seeAll': ['See all {n}', 'Alle {n} bekijken'],
  'guides.mailTitle': ['Your email', 'Je e-mail'],
  'guides.mailBody': [
    'I can read, sort and draft replies. I always ask before I send anything.',
    'Ik kan lezen, sorteren en antwoorden voorbereiden. Ik vraag het altijd voordat ik iets verstuur.',
  ],
  'guides.mailOther': ['Other email', 'Andere e-mail'],
  'guides.mailGoogle': ['Gmail or Google Workspace', 'Gmail of Google Workspace'],
  'guides.maybeLater': ['Maybe later', 'Misschien later'],
  'guides.things': ['{n} things, like {list}', '{n} dingen, zoals {list}'],
  'guides.find.connect': ['Connect {thing}', 'Koppel {thing}'],
  'guides.find.add': ['Add {thing}', 'Voeg {thing} toe'],
  'guides.find.at': ['{words} at {host}', '{words} ({host})'],

  /* How people say a find: one (with “a”/“een”), several, and the one (with “the”/“de”/“het”). */
  'guides.spoken.unifi_network.one': ['a UniFi gateway', 'een UniFi-gateway'],
  'guides.spoken.unifi_network.many': ['UniFi gateways', 'UniFi-gateways'],
  'guides.spoken.unifi_network.the': ['the UniFi gateway', 'de UniFi-gateway'],
  'guides.spoken.synology.one': ['a Synology NAS', 'een Synology-NAS'],
  'guides.spoken.synology.many': ['Synology NAS boxes', 'Synology-NAS’en'],
  'guides.spoken.synology.the': ['the Synology NAS', 'de Synology-NAS'],
  'guides.spoken.qnap.one': ['a QNAP NAS', 'een QNAP-NAS'],
  'guides.spoken.qnap.many': ['QNAP NAS boxes', 'QNAP-NAS’en'],
  'guides.spoken.qnap.the': ['the QNAP NAS', 'de QNAP-NAS'],
  'guides.spoken.truenas.one': ['a TrueNAS server', 'een TrueNAS-server'],
  'guides.spoken.truenas.many': ['TrueNAS servers', 'TrueNAS-servers'],
  'guides.spoken.truenas.the': ['the TrueNAS server', 'de TrueNAS-server'],
  'guides.spoken.unraid.one': ['an Unraid server', 'een Unraid-server'],
  'guides.spoken.unraid.many': ['Unraid servers', 'Unraid-servers'],
  'guides.spoken.unraid.the': ['the Unraid server', 'de Unraid-server'],
  'guides.spoken.proxmox.one': ['a Proxmox server', 'een Proxmox-server'],
  'guides.spoken.proxmox.many': ['Proxmox servers', 'Proxmox-servers'],
  'guides.spoken.proxmox.the': ['the Proxmox server', 'de Proxmox-server'],
  'guides.spoken.proxmox_backup.one': ['a Proxmox Backup Server', 'een Proxmox Backup Server'],
  'guides.spoken.proxmox_backup.many': ['Proxmox Backup Servers', 'Proxmox Backup Servers'],
  'guides.spoken.proxmox_backup.the': ['the Proxmox Backup Server', 'de Proxmox Backup Server'],
  'guides.spoken.opnsense.one': ['an OPNsense firewall', 'een OPNsense-firewall'],
  'guides.spoken.opnsense.many': ['OPNsense firewalls', 'OPNsense-firewalls'],
  'guides.spoken.opnsense.the': ['the OPNsense firewall', 'de OPNsense-firewall'],
  /* A server or device found by what it runs (“Debian server”): the name is filled in. A device's word is “het
     apparaat” in Dutch, a server's “de server”. */
  'guides.spoken.server.one': ['a {name}', 'een {name}'],
  'guides.spoken.server.many': ['{name}s', '{name}s'],
  'guides.spoken.server.the': ['the {name}', 'de {name}'],
  'guides.spoken.serverWord': ['server', 'server'],
  'guides.spoken.device.one': ['a {name}', 'een {name}'],
  'guides.spoken.device.many': ['{name}s', '{name}s'],
  'guides.spoken.device.the': ['the {name}', 'de {name}'],

  'guides.small.2': ['two', 'twee'],
  'guides.small.3': ['three', 'drie'],
  'guides.small.4': ['four', 'vier'],
  'guides.small.5': ['five', 'vijf'],
  'guides.small.6': ['six', 'zes'],
  'guides.small.7': ['seven', 'zeven'],
  'guides.small.8': ['eight', 'acht'],
  'guides.small.9': ['nine', 'negen'],
});
