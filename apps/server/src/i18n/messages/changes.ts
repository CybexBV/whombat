/**
 * What changed on a thing (docs/decisions/outside-changes.md), said from its facts when it is read (`changes/words.ts`),
 * and a service's settings copy on its page.
 */
import { splitPairs } from './pairs';

export const CHANGES = splitPairs({
  'changes.version': ['{name} went from {from} to {to}', '{name} ging van {from} naar {to}'],
  'changes.image': ['{name} now runs {to} (was {from})', '{name} draait nu {to} (was {from})'],
  'changes.imageSameTag': ['{name} got a new image of {to}', '{name} kreeg een nieuwe image van {to}'],
  'changes.images': [
    {
      one: '{count} container got a new image: {names}',
      other: '{count} containers got new images: {names}',
    },
    {
      one: '{count} container kreeg een nieuwe image: {names}',
      other: '{count} containers kregen een nieuwe image: {names}',
    },
  ],
  'changes.restart': ['The server restarted', 'De server is opnieuw opgestart'],
  'changes.restartKernel': [
    'Kernel updated to {kernel} and the server restarted',
    'Kernel bijgewerkt naar {kernel} en de server is opnieuw opgestart',
  ],
  'changes.kernel': ['The kernel is now {to}', 'De kernel is nu {to}'],
  'changes.os': ['The system went from {from} to {to}', 'Het systeem ging van {from} naar {to}'],
  'changes.packages': [
    { one: '{count} update was installed', other: '{count} updates were installed' },
    { one: '{count} update is geïnstalleerd', other: '{count} updates zijn geïnstalleerd' },
  ],
  'changes.firmware': [
    '{device}’s firmware went from {from} to {to}',
    'De firmware van {device} ging van {from} naar {to}',
  ],
  'changes.firmwares': [
    { one: '{count} device got new firmware: {names}', other: '{count} devices got new firmware: {names}' },
    {
      one: '{count} apparaat kreeg nieuwe firmware: {names}',
      other: '{count} apparaten kregen nieuwe firmware: {names}',
    },
  ],
  'changes.firmwaresTo': [
    {
      one: '{count} device got firmware {to}: {names}',
      other: '{count} devices got firmware {to}: {names}',
    },
    {
      one: '{count} apparaat kreeg firmware {to}: {names}',
      other: '{count} apparaten kregen firmware {to}: {names}',
    },
  ],
  'changes.proxy': ['Proxy host', 'Proxyhost'],
  'changes.tunnel': ['Tunnel route', 'Tunnelroute'],
  'changes.routeAdded': [
    '{what} {host} was added and points to {to}',
    '{what} {host} is toegevoegd en wijst naar {to}',
  ],
  'changes.routeRemoved': ['{what} {host} was removed', '{what} {host} is verwijderd'],
  'changes.routeTo': ['{what} {host} now points to {to}', '{what} {host} wijst nu naar {to}'],
  'changes.routeOff': ['{what} {host} was switched off', '{what} {host} is uitgezet'],
  'changes.routeOn': ['{what} {host} was switched on again', '{what} {host} staat weer aan'],
  'changes.proxies': [
    {
      one: '{count} proxy host changed: {names}',
      other: '{count} proxy hosts changed: {names}',
    },
    {
      one: '{count} proxyhost veranderd: {names}',
      other: '{count} proxyhosts veranderd: {names}',
    },
  ],
  'changes.tunnels': [
    {
      one: '{count} tunnel route changed: {names}',
      other: '{count} tunnel routes changed: {names}',
    },
    {
      one: '{count} tunnelroute veranderd: {names}',
      other: '{count} tunnelroutes veranderd: {names}',
    },
  ],
  'changes.settings': [
    '{service}’s settings changed: {parts}',
    'De instellingen van {service} veranderden: {parts}',
  ],
  'changes.settingsSome': ['{service}’s settings changed', 'De instellingen van {service} veranderden'],
  'changes.andMore': ['{names} and {count} more', '{names} en nog {count}'],
  'changes.added': [
    { one: '{count} added', other: '{count} added' },
    { one: '{count} toegevoegd', other: '{count} toegevoegd' },
  ],
  'changes.removed': [
    { one: '{count} removed', other: '{count} removed' },
    { one: '{count} verwijderd', other: '{count} verwijderd' },
  ],
  'changes.changed': [
    { one: '{count} changed', other: '{count} changed' },
    { one: '{count} gewijzigd', other: '{count} gewijzigd' },
  ],

  // The parts of a service's settings a settings copy compares.
  'changes.part.filter': ['firewall rules', 'firewallregels'],
  'changes.part.nat': ['port forwards', 'port forwards'],
  'changes.part.aliases': ['aliases', 'aliassen'],
  'changes.part.interfaces': ['interfaces', 'interfaces'],
  'changes.part.dhcp': ['DHCP', 'DHCP'],
  'changes.part.dns': ['DNS', 'DNS'],
  'changes.part.vpn': ['VPN', 'VPN'],
  'changes.part.routes': ['gateways and routes', 'gateways en routes'],
  'changes.part.users': ['users', 'gebruikers'],
  'changes.part.system': ['system settings', 'systeeminstellingen'],
  'changes.part.lists': ['block lists', 'blokkeerlijsten'],
  'changes.part.domains': ['allowed and blocked sites', 'toegestane en geblokkeerde sites'],
  'changes.part.groups': ['groups', 'groepen'],
  'changes.part.clients': ['devices', 'apparaten'],
  'changes.part.records': ['local DNS records', 'lokale DNS-records'],
  'changes.part.proxyHosts': ['proxy hosts', 'proxyhosts'],
  'changes.part.redirects': ['redirects', 'doorverwijzingen'],
  'changes.part.streams': ['streams', 'streams'],
  'changes.part.deadHosts': ['404 hosts', '404-hosts'],
  'changes.part.accessLists': ['access lists', 'toegangslijsten'],
  'changes.part.other': ['other settings', 'andere instellingen'],

  // A service's settings copy on its page.
  'changes.copy.title': ['Settings copy · {when}', 'Kopie van instellingen · {when}'],
  'changes.copy.none': ['No settings copy yet', 'Nog geen kopie van instellingen'],
  'changes.copy.lastNight': ['last night', 'afgelopen nacht'],
  'changes.copy.today': ['today {time}', 'vandaag {time}'],
  'changes.copy.holds': [
    'Whombat keeps a copy of {service}’s settings every night. Restore one in {service} itself.',
    'Whombat bewaart elke nacht een kopie van de instellingen van {service}. Zet er een terug in {service} zelf.',
  ],
  'changes.copy.first': [
    'Whombat makes the first copy of {service}’s settings within the hour.',
    'Whombat maakt binnen een uur de eerste kopie van de instellingen van {service}.',
  ],
  'changes.copy.failed': ['The last copy didn’t work: {problem}', 'De laatste kopie lukte niet: {problem}'],
  'changes.copy.lineTitle': [
    'Whombat can’t copy {service}’s settings any more',
    'Whombat kan de instellingen van {service} niet meer kopiëren',
  ],
  'changes.copy.lineDetail': [
    'The last copy that worked is from {when}. {problem}',
    'De laatste kopie die lukte is van {when}. {problem}',
  ],
  'changes.copy.ignore': ['Until a copy works again.', 'Tot een kopie weer lukt.'],
  'changes.copy.problem.signin': [
    '{service} refused Whombat’s sign-in.',
    '{service} weigerde de aanmelding van Whombat.',
  ],
  'changes.copy.problem.notAllowed': [
    '{service} doesn’t let Whombat’s sign-in download its settings. Allow that in {service}.',
    '{service} laat de aanmelding van Whombat de instellingen niet downloaden. Sta dat toe in {service}.',
  ],
  'changes.copy.problem.missing': [
    'This {service} doesn’t offer its settings for download. An update of {service} may help.',
    'Deze {service} biedt de instellingen niet als download aan. Een update van {service} kan helpen.',
  ],
  'changes.copy.problem.error': ['{service} answered with an error.', '{service} antwoordde met een fout.'],
  'changes.copy.problem.tooLarge': [
    'The settings are larger than Whombat keeps (20 MB).',
    'De instellingen zijn groter dan Whombat bewaart (20 MB).',
  ],
  'changes.copy.problem.unreachable': [
    'Whombat couldn’t reach {service}.',
    'Whombat kon {service} niet bereiken.',
  ],
  'changes.copy.problem.unreadable': [
    '{service} answered with something that isn’t its settings.',
    '{service} antwoordde met iets anders dan de instellingen.',
  ],
});
